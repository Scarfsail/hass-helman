"""Tests for the #274 (P0 of #270) reserve-floor breach classifier.

Three layers:
1. Direct unit tests of ``classify_reserve_floor_observation`` — the decision
   table's totality/mutual-exclusivity, exercised against fabricated inputs
   (no pipeline needed).
2. A deterministic scenario suite run through the real
   ``run_optimizer_loop_pure`` (the actual, unrestructured pipeline), using a
   real ``ChargeFromGridOptimizer`` plus small test-double "later optimizer"
   steps that mutate the working document the way a real appliance/inverter
   optimizer would. SoC trajectories are produced by a deliberately simple,
   documented toy physics model (``_project_soc``) rather than the real
   forecast rebuild (which needs a live coordinator/hass) -- good enough to
   exercise capture/join/classification mechanics deterministically, not a
   claim of physical accuracy.
3. The golden file: the scenario suite's results, keyed by
   ``(optimizer_id, group_index, window)``, committed at
   ``tests/fixtures/reserve_floor_classifier_golden.json`` and asserted
   byte-stable.
"""

from __future__ import annotations

import json
import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TZ = timezone(timedelta(hours=2))
REFERENCE_TIME = datetime(2026, 7, 10, 5, 0, tzinfo=TZ)
DAY = REFERENCE_TIME.date()
GOLDEN_PATH = Path(__file__).with_name("fixtures") / "reserve_floor_classifier_golden.json"


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg
    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg
    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    dt_mod.now = lambda: REFERENCE_TIME
    util_pkg.dt = dt_mod


_install_import_stubs()

import custom_components.helman.automation.pipeline as pipeline_module  # noqa: E402
from custom_components.helman.automation.config import (  # noqa: E402
    OptimizerInstanceConfig,
)
from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
    ImportBand,
)
from custom_components.helman.automation.optimizers.charge_from_grid import (  # noqa: E402
    build_charge_from_grid_optimizer,
)
from custom_components.helman.automation.pipeline import run_optimizer_loop_pure  # noqa: E402
from custom_components.helman.automation.reserve_floor_classifier import (  # noqa: E402
    CLASS_DOWNSTREAM_INTRODUCED,
    CLASS_KNOWN_UNREPAIRABLE,
    CLASS_NONE,
    CLASS_PRE_EXISTING_PHYSICAL,
    CLASS_UNMEASURABLE,
    CLASS_UNRESOLVED_AT_BOUNDARY,
    LANE_EXCLUSIVE_APPLIANCE,
    LANE_EXCLUSIVE_INVERTER,
    REASON_CAP,
    REASON_CAPACITY,
    REASON_UNRESOLVED,
    STATUS_FAILED,
    STATUS_MEASURED,
    STATUS_UNAVAILABLE,
    ReserveFloorBoundary,
    classify_reserve_floor_observation,
    classify_reserve_floor_observations,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.automation.trace import ReserveFloorObservation  # noqa: E402
from custom_components.helman.appliances import AppliancesRuntimeRegistry  # noqa: E402
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleDocument,
    parse_slot_id,
)
from automation_config_builders import make_optimizer_config  # noqa: E402


# =============================================================================
# Layer 1: direct decision-table tests
# =============================================================================


class _FakeSnapshot:
    """The only thing the classifier reads off a snapshot: its SoC series."""

    def __init__(
        self,
        series: list[dict[str, object]],
        *,
        status: str = "available",
        coverage_until: str | None = None,
    ) -> None:
        self.battery_forecast = {"status": status, "series": series}
        if coverage_until is not None:
            self.battery_forecast["coverageUntil"] = coverage_until


def _series(soc_by_hour: dict[int, float]) -> list[dict[str, object]]:
    return [
        {"timestamp": f"2026-07-10T{hour:02d}:00:00+02:00", "socPct": soc}
        for hour, soc in soc_by_hour.items()
    ]


_WINDOW = ("2026-07-10T08:00:00+02:00", "2026-07-10T10:00:00+02:00")


def _observation(
    *,
    optimizer_id="grid-bridge",
    floor=40.0,
    limit=None,
    conditions_active=True,
) -> ReserveFloorObservation:
    return ReserveFloorObservation(
        optimizer_id=optimizer_id,
        group_index=0,
        window=_WINDOW,
        reserve_floor_soc=floor,
        conditions_active=conditions_active,
        projected_min_soc=20.0,
        bridge_written=True,
        limit=limit,
    )


def _boundary(min_soc: float, *, demand=None, final=None) -> ReserveFloorBoundary:
    return ReserveFloorBoundary(
        snapshot=_FakeSnapshot(_series({8: min_soc, 9: min_soc})),
        demand_document=ScheduleDocument() if demand is None else demand,
    )


def _classify(*, final_min, boundary_min=None, control_min=None, limit=None, boundary=None):
    if boundary is None and boundary_min is not None:
        boundary = _boundary(boundary_min)
    return classify_reserve_floor_observation(
        _observation(limit=limit),
        control_snapshot=(
            None if control_min is None else _FakeSnapshot(_series({8: control_min}))
        ),
        boundary=boundary,
        final_snapshot=_FakeSnapshot(_series({8: final_min, 9: final_min})),
        final_document=ScheduleDocument(),
    )


class DecisionTableTests(unittest.TestCase):
    def test_rule1_unmeasurable_when_final_coverage_partial(self) -> None:
        # A partial forecast can still contain usable points inside the window;
        # those points are only a prefix and must not be mistaken for complete
        # coverage merely because their observed minimum is above the floor.
        result = classify_reserve_floor_observation(
            _observation(),
            control_snapshot=None,
            boundary=_boundary(50.0),
            final_snapshot=_FakeSnapshot(
                _series({8: 45.0}),
                status="partial",
                coverage_until="2026-07-10T09:00:00+02:00",
            ),
            final_document=ScheduleDocument(),
        )
        self.assertEqual(result.status, STATUS_MEASURED)
        self.assertEqual(result.klass, CLASS_UNMEASURABLE)

    def test_batch_joins_each_optimizer_to_its_own_boundary(self) -> None:
        observations = (
            _observation(optimizer_id="bridge-a"),
            _observation(optimizer_id="bridge-b"),
        )
        results = classify_reserve_floor_observations(
            observations,
            control_snapshot=_FakeSnapshot(_series({8: 50.0, 9: 50.0})),
            boundaries={
                "bridge-a": _boundary(50.0),
                "bridge-b": _boundary(10.0),
            },
            final_snapshot=_FakeSnapshot(_series({8: 10.0, 9: 10.0})),
            final_document=ScheduleDocument(),
        )
        by_id = {result.optimizer_id: result for result in results}
        self.assertEqual(by_id["bridge-a"].klass, CLASS_DOWNSTREAM_INTRODUCED)
        self.assertEqual(by_id["bridge-b"].klass, CLASS_UNRESOLVED_AT_BOUNDARY)

    def test_rule2_none_when_final_at_or_above_floor(self) -> None:
        result = _classify(final_min=45.0, boundary_min=10.0, control_min=10.0, limit="cap")
        self.assertEqual(result.klass, CLASS_NONE)
        self.assertEqual(result.shortfall_pp, 0.0)

    def test_rule2_beats_rule4_repaired_pre_existing(self) -> None:
        result = _classify(final_min=45.0, boundary_min=45.0, control_min=10.0)
        self.assertEqual(result.klass, CLASS_NONE)

    def test_rule2_beats_rule5_repaired_after_cap(self) -> None:
        result = _classify(final_min=45.0, boundary_min=10.0, control_min=45.0, limit="cap")
        self.assertEqual(result.klass, CLASS_NONE)

    def test_rule3_downstream_introduced_with_lane_flags(self) -> None:
        demand = ScheduleDocument(
            slots={
                "2026-07-10T08:30:00+02:00": {"boiler": {"on": True, "setBy": "automation"}},
            }
        )
        final = ScheduleDocument(slots={})
        result = classify_reserve_floor_observation(
            _observation(),
            control_snapshot=None,
            boundary=ReserveFloorBoundary(
                snapshot=_FakeSnapshot(_series({8: 50.0, 9: 50.0})),
                demand_document=demand,
            ),
            final_snapshot=_FakeSnapshot(_series({8: 10.0, 9: 10.0})),
            final_document=final,
        )
        self.assertEqual(result.klass, CLASS_DOWNSTREAM_INTRODUCED)
        self.assertTrue(result.appliance_lane_changed)
        self.assertFalse(result.inverter_lane_changed)
        self.assertEqual(result.lane_summary, LANE_EXCLUSIVE_APPLIANCE)

    def test_rule3_inverter_lane_change_summary(self) -> None:
        demand = ScheduleDocument(
            slots={
                "2026-07-10T08:30:00+02:00": {
                    "inverter": ScheduleAction(kind="normal", set_by="automation")
                },
            }
        )
        final = ScheduleDocument(slots={})
        result = classify_reserve_floor_observation(
            _observation(),
            control_snapshot=None,
            boundary=ReserveFloorBoundary(
                snapshot=_FakeSnapshot(_series({8: 50.0, 9: 50.0})),
                demand_document=demand,
            ),
            final_snapshot=_FakeSnapshot(_series({8: 10.0, 9: 10.0})),
            final_document=final,
        )
        self.assertEqual(result.klass, CLASS_DOWNSTREAM_INTRODUCED)
        self.assertTrue(result.inverter_lane_changed)
        self.assertFalse(result.appliance_lane_changed)
        self.assertEqual(result.lane_summary, LANE_EXCLUSIVE_INVERTER)

    def test_rule4_pre_existing_physical(self) -> None:
        result = _classify(final_min=10.0, boundary_min=10.0, control_min=5.0)
        self.assertEqual(result.klass, CLASS_PRE_EXISTING_PHYSICAL)
        self.assertAlmostEqual(result.shortfall_pp, 30.0)

    def test_rule5_known_unrepairable_cap(self) -> None:
        result = _classify(final_min=10.0, boundary_min=10.0, control_min=50.0, limit=REASON_CAP)
        self.assertEqual(result.klass, CLASS_KNOWN_UNREPAIRABLE)
        self.assertEqual(result.reason, REASON_CAP)

    def test_rule5_known_unrepairable_capacity(self) -> None:
        result = _classify(
            final_min=10.0, boundary_min=10.0, control_min=50.0, limit=REASON_CAPACITY
        )
        self.assertEqual(result.klass, CLASS_KNOWN_UNREPAIRABLE)
        self.assertEqual(result.reason, REASON_CAPACITY)

    def test_rule6_unresolved_at_boundary_never_power(self) -> None:
        result = _classify(final_min=10.0, boundary_min=10.0, control_min=50.0, limit=None)
        self.assertEqual(result.klass, CLASS_UNRESOLVED_AT_BOUNDARY)
        self.assertEqual(result.reason, REASON_UNRESOLVED)
        self.assertNotEqual(result.reason, "power")

    def test_classifier_never_raises(self) -> None:
        # boundary >= floor and final < floor reaches the lane-diff branch,
        # which explodes on a `final_document` missing `.slots`.
        result = classify_reserve_floor_observation(
            _observation(),
            control_snapshot=None,
            boundary=_boundary(50.0),
            final_snapshot=_FakeSnapshot(_series({8: 10.0, 9: 10.0})),
            final_document=object(),  # deliberately wrong type
        )
        self.assertEqual(result.status, STATUS_FAILED)
        self.assertIsNone(result.klass)

    def test_totality_and_mutual_exclusivity_grid(self) -> None:
        floor = 40.0
        classes_seen: set[str] = set()
        for final_min in (10.0, 50.0):
            for boundary_min in (10.0, 50.0):
                for control_min in (10.0, 50.0, None):
                    for limit in (None, REASON_CAP, REASON_CAPACITY):
                        result = _classify(
                            final_min=final_min,
                            boundary_min=boundary_min,
                            control_min=control_min,
                            limit=limit,
                        )
                        # A missing control trajectory can't rule out
                        # `pre_existing_physical` (rule 4), so once final and
                        # boundary are both below the floor, a `None` control
                        # reading is reported `unavailable` rather than
                        # silently falling through to rules 5/6.
                        needs_control = (
                            final_min < floor
                            and boundary_min < floor
                            and control_min is None
                        )
                        if needs_control:
                            self.assertEqual(result.status, STATUS_UNAVAILABLE)
                            self.assertIsNone(result.klass)
                            continue
                        self.assertEqual(result.status, STATUS_MEASURED)
                        self.assertIsNotNone(result.klass)
                        self.assertIn(
                            result.klass,
                            {
                                CLASS_NONE,
                                CLASS_DOWNSTREAM_INTRODUCED,
                                CLASS_PRE_EXISTING_PHYSICAL,
                                CLASS_KNOWN_UNREPAIRABLE,
                                CLASS_UNRESOLVED_AT_BOUNDARY,
                            },
                        )
                        self.assertNotEqual(result.reason, "power")
                        classes_seen.add(result.klass)
                        if final_min >= floor:
                            self.assertEqual(result.klass, CLASS_NONE)
        # Every non-unmeasurable class is reachable somewhere in the grid.
        self.assertEqual(
            classes_seen,
            {
                CLASS_NONE,
                CLASS_DOWNSTREAM_INTRODUCED,
                CLASS_PRE_EXISTING_PHYSICAL,
                CLASS_KNOWN_UNREPAIRABLE,
                CLASS_UNRESOLVED_AT_BOUNDARY,
            },
        )


# =============================================================================
# Layer 2 + 3: pipeline scenario suite + golden file
# =============================================================================

FLOOR = 40
_CHEAP_BAND = ImportBand(level="cheap", start=datetime(2026, 7, 10, 6, tzinfo=TZ), end=datetime(2026, 7, 10, 8, tzinfo=TZ))
_EXPENSIVE_BAND = ImportBand(level="expensive", start=datetime(2026, 7, 10, 8, tzinfo=TZ), end=datetime(2026, 7, 10, 10, tzinfo=TZ))
_BANDS = (_CHEAP_BAND, _EXPENSIVE_BAND)

# Natural (no-automation) trajectory: dips to 20 inside the expensive window,
# well under FLOOR=40 -- the physical hazard #274 exists to catch.
_BASE_SOC_BY_HOUR = {0: 45, 6: 45, 7: 45, 8: 35, 9: 20, 10: 60, 20: 45}
# Cheapest cheap slot is 07:00, so a bridge lands there.
_PRICE_BY_HOUR = {0: 3.0, 6: 3.0, 7: 1.0, 8: 6.0}


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 10, hour, minute, tzinfo=TZ)


def _slot_id(hour: int, minute: int = 0) -> str:
    return _at(hour, minute).isoformat(timespec="seconds")


def _step_series(by_hour: dict[int, float]) -> list[dict[str, object]]:
    series = []
    cursor = _at(0)
    end = _at(0) + timedelta(days=1)
    current = by_hour.get(0, 0.0)
    while cursor < end:
        if cursor.minute == 0 and cursor.hour in by_hour:
            current = by_hour[cursor.hour]
        series.append({"timestamp": cursor.isoformat(timespec="seconds"), "value": current})
        cursor += timedelta(minutes=30)
    return series


def _day_context(bands: tuple[ImportBand, ...] = _BANDS) -> DayContext:
    return DayContext(
        local_date=DAY,
        classification="tight",
        predicted_solar_kwh=5.0,
        predicted_consumption_kwh=5.0,
        export_price_min=1.0,
        export_price_max=5.0,
        import_bands=bands,
    )


def _project_soc(
    document: ScheduleDocument,
    *,
    base_soc_by_hour: dict[int, float] = _BASE_SOC_BY_HOUR,
    charge_bump_pp: float = 25.0,
    appliance_drain_pp: float = 30.0,
    bump_expires_at: datetime | None = None,
) -> list[dict[str, object]]:
    """Deliberately simple, documented toy physics.

    Not a real energy model: a written ``charge_to_target_soc`` inverter
    action raises every later slot's SoC by a flat ``charge_bump_pp``; a
    written appliance "on" action lowers every later slot's SoC by
    ``appliance_drain_pp``. ``bump_expires_at`` (used only by the
    "discharges before the window opens" scenario) zeroes the charge's
    running contribution from that timestamp on, modelling a bridge that gets
    spent before the expensive window it was meant to cover.

    Good enough to deterministically exercise capture/join/classification
    mechanics; not a claim of physical accuracy.
    """
    base = _step_series(base_soc_by_hour)
    charge_delta: dict[datetime, float] = {}
    drain_delta: dict[datetime, float] = {}
    for slot_id, actions in document.slots.items():
        ts = parse_slot_id(slot_id)
        inverter = actions.get("inverter")
        if (
            isinstance(inverter, ScheduleAction)
            and inverter.kind == "charge_to_target_soc"
            and inverter.set_by == "automation"
        ):
            charge_delta[ts] = charge_delta.get(ts, 0.0) + charge_bump_pp
        for controllable_id, action in actions.items():
            if controllable_id == "inverter":
                continue
            if isinstance(action, dict) and action.get("on") and action.get("setBy") == "automation":
                drain_delta[ts] = drain_delta.get(ts, 0.0) - appliance_drain_pp

    out: list[dict[str, object]] = []
    charge_cum = 0.0
    drain_cum = 0.0
    for entry in base:
        ts = datetime.fromisoformat(entry["timestamp"])
        charge_cum += charge_delta.get(ts, 0.0)
        if bump_expires_at is not None and ts >= bump_expires_at:
            charge_cum = 0.0
        drain_cum += drain_delta.get(ts, 0.0)
        soc = max(0.0, min(100.0, entry["value"] + charge_cum + drain_cum))
        out.append({"timestamp": entry["timestamp"], "socPct": soc})
    return out


def _make_build_snapshot(
    *,
    bands: tuple[ImportBand, ...] = _BANDS,
    bump_expires_at: datetime | None = None,
    truncate_before: datetime | None = None,
    base_soc_by_hour: dict[int, float] = _BASE_SOC_BY_HOUR,
    charge_bump_pp: float = 25.0,
    appliance_drain_pp: float = 30.0,
):
    def build(document: ScheduleDocument, *, demand_schedule_document=None):
        demand_document = document if demand_schedule_document is None else demand_schedule_document
        soc_series = _project_soc(
            demand_document,
            base_soc_by_hour=base_soc_by_hour,
            charge_bump_pp=charge_bump_pp,
            appliance_drain_pp=appliance_drain_pp,
            bump_expires_at=bump_expires_at,
        )
        if truncate_before is not None:
            soc_series = [
                point
                for point in soc_series
                if datetime.fromisoformat(point["timestamp"]) < truncate_before
            ]
        return OptimizationSnapshot(
            schedule=document,
            adjusted_house_forecast={"status": "available", "series": []},
            battery_forecast={"status": "available", "series": soc_series},
            grid_forecast={"status": "available", "series": []},
            context=OptimizationContext(
                now=REFERENCE_TIME,
                battery_state=types.SimpleNamespace(
                    current_soc=50.0, min_soc=10.0, max_soc=100.0
                ),
                solar_forecast={"status": "available", "points": []},
                import_price_forecast={
                    "unit": "CZK/kWh",
                    "currentPrice": 3.0,
                    "points": _step_series(_PRICE_BY_HOUR),
                },
                export_price_forecast={"unit": "CZK/kWh", "currentPrice": 2.0, "points": []},
                appliance_registry=AppliancesRuntimeRegistry(),
                when_active_hourly_energy_kwh_by_appliance_id={},
                battery_max_charge_power_kw=5.0,
                battery_usable_capacity_kwh=10.0,
                battery_charge_efficiency=1.0,
                runtime_hours_by_appliance_id_by_local_date={},
                day_contexts={DAY: _day_context(bands)},
                condition_met_by_optimizer_id={},
            ),
        )

    return build


class _MutatingOptimizer:
    """Test double for a "later optimizer" step: applies a fixed mutation to
    the incoming document, mimicking a real optimizer's write without
    exercising real optimizer internals."""

    def __init__(self, mutate) -> None:
        self._mutate = mutate

    def optimize(self, snapshot, config, trace):
        document = deepcopy(snapshot.schedule)
        self._mutate(document)
        return document


def _charge_from_grid_config(
    *, optimizer_id: str = "grid-bridge", floor: int = FLOOR, max_target_soc: int = 100
) -> OptimizerInstanceConfig:
    return make_optimizer_config(
        id=optimizer_id,
        kind="charge_from_grid",
        params={"margin_pct": 0, "max_target_soc": max_target_soc},
        conditions=[{"reserve_floor_soc": floor}],
    )


def _stub_config(*, optimizer_id: str, kind: str, controllable_id: str) -> OptimizerInstanceConfig:
    return OptimizerInstanceConfig(
        id=optimizer_id,
        kind=kind,
        target={"controllable_id": controllable_id},
    )


def _run(
    *,
    execution_optimizers,
    mutations_by_id: dict[str, object] | None = None,
    build_snapshot,
    schedule_document: ScheduleDocument | None = None,
    baseline_schedule_document: ScheduleDocument | None = None,
):
    document = ScheduleDocument(execution_enabled=True) if schedule_document is None else schedule_document
    baseline = document if baseline_schedule_document is None else baseline_schedule_document
    mutations_by_id = mutations_by_id or {}

    # Mirror AutomationRunner's real pre-loop snapshot: every still-pending
    # appliance lane is restored from the previous plan as projection demand,
    # while the snapshot's own schedule remains the stripped working document.
    pending_appliance_ids = tuple(
        config.controllable_id
        for config in execution_optimizers
        if config.kind == "appliance_runtime"
    )
    initial_demand_document = (
        pipeline_module.restore_automation_owned_appliance_actions(
            baseline=baseline,
            current=document,
            appliance_ids=pending_appliance_ids,
        )
    )

    def dispatch(config, **kwargs):
        if config.kind == "charge_from_grid":
            return build_charge_from_grid_optimizer(config)
        return _MutatingOptimizer(mutations_by_id[config.id])

    with patch.object(pipeline_module, "build_optimizer", side_effect=dispatch):
        return run_optimizer_loop_pure(
            execution_optimizers=execution_optimizers,
            baseline_schedule_document=baseline,
            schedule_document=document,
            initial_snapshot=build_snapshot(
                document,
                demand_schedule_document=initial_demand_document,
            ),
            reference_time=REFERENCE_TIME,
            control_config=None,
            appliance_registry=AppliancesRuntimeRegistry(),
            build_snapshot=build_snapshot,
            capture_reserve_floor_diagnostics=True,
        )


def _by_key(results):
    return {result.key: result for result in results}


class ScenarioSuiteTests(unittest.TestCase):
    """The #274 deterministic scenario suite. Each test also contributes its
    results to the committed golden file (see ``GoldenFileTests``)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.golden: dict[str, dict] = {}

    def _record(self, name: str, results) -> None:
        ScenarioSuiteTests.golden[name] = sorted(
            (result.to_dict() for result in results),
            key=lambda entry: (entry["optimizerId"], entry["groupIndex"], entry["window"]),
        )

    def test_cold_start_no_prior_plan(self) -> None:
        build_snapshot = _make_build_snapshot()
        result = _run(
            execution_optimizers=[
                _charge_from_grid_config(),
                _stub_config(
                    optimizer_id="boiler",
                    kind="appliance_runtime",
                    controllable_id="boiler",
                ),
            ],
            mutations_by_id={"boiler": self._add_draining_appliance},
            build_snapshot=build_snapshot,
        )
        self._record("cold_start_no_prior_plan", result.reserve_floor_results)
        outcome = result.reserve_floor_results[0]
        # With no previous appliance plan to restore, charge_from_grid sees the
        # bare house.  The later appliance placement introduces the breach —
        # the cold-start form of the #116 look-ahead gap this baseline must pin.
        self.assertEqual(outcome.klass, CLASS_DOWNSTREAM_INTRODUCED)
        self.assertEqual(outcome.lane_summary, LANE_EXCLUSIVE_APPLIANCE)

    def test_appliance_moves_into_expensive_window_is_exclusive_appliance(self) -> None:
        build_snapshot = _make_build_snapshot()
        baseline = ScheduleDocument(
            execution_enabled=True,
            slots={
                _slot_id(11): {
                    "boiler": {"on": True, "setBy": "automation"}
                }
            },
        )

        def add_appliance(document: ScheduleDocument) -> None:
            document.slots.setdefault(_slot_id(9), {})["boiler"] = {
                "on": True,
                "setBy": "automation",
            }

        result = _run(
            execution_optimizers=[
                _charge_from_grid_config(),
                _stub_config(optimizer_id="boiler", kind="appliance_runtime", controllable_id="boiler"),
            ],
            mutations_by_id={"boiler": add_appliance},
            build_snapshot=build_snapshot,
            baseline_schedule_document=baseline,
        )
        self._record("appliance_moves_into_expensive_window", result.reserve_floor_results)
        self.assertEqual(len(result.reserve_floor_results), 1)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_DOWNSTREAM_INTRODUCED)
        self.assertEqual(outcome.lane_summary, LANE_EXCLUSIVE_APPLIANCE)
        self.assertTrue(outcome.appliance_lane_changed)
        self.assertFalse(outcome.inverter_lane_changed)

    def test_later_system_optimizer_overwrites_bridge_is_exclusive_inverter(self) -> None:
        build_snapshot = _make_build_snapshot()

        def clear_bridge(document: ScheduleDocument) -> None:
            for slot_id, actions in list(document.slots.items()):
                inverter = actions.get("inverter")
                if isinstance(inverter, ScheduleAction) and inverter.kind == "charge_to_target_soc":
                    document.slots[slot_id]["inverter"] = ScheduleAction(
                        kind="normal", set_by="automation"
                    )

        result = _run(
            execution_optimizers=[
                _charge_from_grid_config(),
                _stub_config(optimizer_id="later-inverter", kind="charge_hold", controllable_id="inverter"),
            ],
            mutations_by_id={"later-inverter": clear_bridge},
            build_snapshot=build_snapshot,
        )
        self._record("later_optimizer_overwrites_bridge", result.reserve_floor_results)
        self.assertEqual(len(result.reserve_floor_results), 1)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_DOWNSTREAM_INTRODUCED)
        self.assertEqual(outcome.lane_summary, LANE_EXCLUSIVE_INVERTER)
        self.assertNotEqual(outcome.klass, CLASS_UNRESOLVED_AT_BOUNDARY)

    # For rule 5 (known_unrepairable) and rule 6 (unresolved_at_boundary) to be
    # reachable at all, the *control* trajectory (zero automation) must stay
    # at/above the floor -- otherwise rule 4 (pre_existing_physical) always
    # wins first, per the table's own ordering. A flat, un-breached base
    # trajectory plus an EARLIER automation step that introduces the deficit
    # (an appliance moving demand into the window) gives exactly that: control
    # sees none of it, but charge_from_grid's own input does.
    _FLAT_SOC_BY_HOUR = {0: 45, 6: 45, 7: 45, 8: 45, 9: 45, 10: 45, 20: 45}

    @staticmethod
    def _add_draining_appliance(document: ScheduleDocument) -> None:
        document.slots.setdefault(_slot_id(8, 30), {})["boiler"] = {
            "on": True,
            "setBy": "automation",
        }

    def test_cheap_window_too_few_rankable_slots_is_capacity(self) -> None:
        # Every cheap slot but one is user-owned, so only one slot is
        # rankable while two are needed to close the deficit an earlier
        # appliance step introduces.
        document = ScheduleDocument(execution_enabled=True)
        for hour, minute in ((6, 0), (6, 15), (6, 30), (6, 45), (7, 15), (7, 30), (7, 45)):
            document.slots[_slot_id(hour, minute)] = {
                "inverter": ScheduleAction(kind="normal", set_by="user")
            }
        # Only 07:00 is left rankable.
        build_snapshot = _make_build_snapshot(
            base_soc_by_hour=self._FLAT_SOC_BY_HOUR,
            charge_bump_pp=15.0,
            appliance_drain_pp=40.0,
        )
        result = _run(
            execution_optimizers=[
                _stub_config(optimizer_id="boiler", kind="appliance_runtime", controllable_id="boiler"),
                _charge_from_grid_config(),
            ],
            mutations_by_id={"boiler": self._add_draining_appliance},
            build_snapshot=build_snapshot,
            schedule_document=document,
        )
        self._record("cheap_window_capacity_short", result.reserve_floor_results)
        self.assertEqual(len(result.reserve_floor_results), 1)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_KNOWN_UNREPAIRABLE)
        self.assertEqual(outcome.reason, REASON_CAPACITY)

    def test_floor_needs_more_than_max_target_soc_is_cap(self) -> None:
        # The cheap-window starting SoC is already above the clamped target.
        # The cap therefore suppresses the write altogether even though the
        # uncapped target would require one; it must still be recorded as the
        # binding limit.
        high_start_soc = {0: 60, 6: 60, 7: 60, 8: 60, 9: 60, 10: 60, 20: 60}
        build_snapshot = _make_build_snapshot(
            base_soc_by_hour=high_start_soc,
            charge_bump_pp=15.0,
        )
        result = _run(
            execution_optimizers=[
                _stub_config(optimizer_id="boiler", kind="appliance_runtime", controllable_id="boiler"),
                _charge_from_grid_config(max_target_soc=50),
            ],
            mutations_by_id={"boiler": self._add_draining_appliance},
            build_snapshot=build_snapshot,
        )
        self._record("floor_needs_more_than_max_target_soc", result.reserve_floor_results)
        self.assertEqual(len(result.reserve_floor_results), 1)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_KNOWN_UNREPAIRABLE)
        self.assertEqual(outcome.reason, REASON_CAP)
        observation = result.trace.reserve_floor_observations[0]
        self.assertFalse(observation.bridge_written)
        self.assertEqual(observation.limit, REASON_CAP)

    def test_bridge_lands_early_discharges_before_window_is_unresolved(self) -> None:
        # charge_from_grid computes and writes a bridge that (per its own,
        # necessarily simplified, arithmetic) should cover the window. This
        # toy model's ``bump_expires_at`` deliberately disagrees: the bridge's
        # benefit is spent by the time the expensive window opens. Boundary
        # still breached, nothing later touches either lane, and the
        # pre-automation baseline (control) was fine on its own.
        build_snapshot = _make_build_snapshot(
            base_soc_by_hour=self._FLAT_SOC_BY_HOUR,
            charge_bump_pp=60.0,
            bump_expires_at=_at(8),
        )
        result = _run(
            execution_optimizers=[
                _stub_config(optimizer_id="boiler", kind="appliance_runtime", controllable_id="boiler"),
                _charge_from_grid_config(),
            ],
            mutations_by_id={"boiler": self._add_draining_appliance},
            build_snapshot=build_snapshot,
        )
        self._record("bridge_lands_early_discharges_before_window", result.reserve_floor_results)
        self.assertEqual(len(result.reserve_floor_results), 1)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_UNRESOLVED_AT_BOUNDARY)
        self.assertEqual(outcome.reason, REASON_UNRESOLVED)

    def test_two_charge_from_grid_instances_join_their_own_boundary(self) -> None:
        # Record each boundary object in build order, then inspect the mapping
        # handed to the batch classifier.  The outcome classes alone are not a
        # sufficient assertion here: rule 2 makes bridge-a clean before its
        # boundary is read, while rule 4 makes bridge-b pre-existing under
        # either of these particular trajectories.
        build_snapshot = _make_build_snapshot()
        built_boundaries: list[ReserveFloorBoundary] = []
        classified_boundaries: dict[str, ReserveFloorBoundary] = {}
        real_build_boundary = pipeline_module._safe_build_reserve_floor_boundary

        def recording_build_boundary(**kwargs):
            boundary = real_build_boundary(**kwargs)
            if boundary is not None:
                built_boundaries.append(boundary)
            return boundary

        def recording_classify(observations, **kwargs):
            classified_boundaries.update(kwargs["boundaries"])
            return classify_reserve_floor_observations(observations, **kwargs)

        with patch.object(
            pipeline_module,
            "_safe_build_reserve_floor_boundary",
            side_effect=recording_build_boundary,
        ), patch.object(
            pipeline_module,
            "classify_reserve_floor_observations",
            side_effect=recording_classify,
        ):
            result = _run(
                execution_optimizers=[
                    _charge_from_grid_config(
                        optimizer_id="bridge-b",
                        floor=95,
                        max_target_soc=41,
                    ),
                    _charge_from_grid_config(
                        optimizer_id="bridge-a",
                        floor=FLOOR,
                    ),
                ],
                build_snapshot=build_snapshot,
            )
        self._record("two_charge_from_grid_instances", result.reserve_floor_results)
        by_id: dict[str, object] = {r.optimizer_id: r for r in result.reserve_floor_results}
        self.assertIn("bridge-a", by_id)
        self.assertIn("bridge-b", by_id)
        self.assertEqual(len(built_boundaries), 2)
        self.assertIs(classified_boundaries["bridge-b"], built_boundaries[0])
        self.assertIs(classified_boundaries["bridge-a"], built_boundaries[1])
        # bridge-a runs last, closes the ordinary 40% gap, ships sound.
        self.assertEqual(by_id["bridge-a"].klass, CLASS_NONE)
        # bridge-b's 95% floor is never realistically reachable -- its own
        # boundary (captured right after ITS OWN step, before bridge-a even
        # ran) is still short, and nothing repairs a 95% floor later either.
        self.assertNotEqual(by_id["bridge-b"].klass, CLASS_NONE)

    def test_control_below_floor_bridge_repairs_it_is_none(self) -> None:
        build_snapshot = _make_build_snapshot()
        result = _run(
            execution_optimizers=[_charge_from_grid_config()],
            build_snapshot=build_snapshot,
        )
        self._record("control_below_floor_repaired", result.reserve_floor_results)
        outcome = result.reserve_floor_results[0]
        # The un-automated baseline (_BASE_SOC_BY_HOUR) already dips under
        # FLOOR -- control is breached too -- but the bridge repairs it.
        self.assertEqual(outcome.klass, CLASS_NONE)

    def test_control_below_floor_never_restored_is_pre_existing(self) -> None:
        # Same breached baseline as the "repaired" scenario above, but the
        # bridge this time is far too small to close the gap -- the shipped
        # plan (== boundary, single-step run) never reaches the floor either.
        build_snapshot = _make_build_snapshot(charge_bump_pp=2.0)
        result = _run(
            execution_optimizers=[_charge_from_grid_config()],
            build_snapshot=build_snapshot,
        )
        self._record("control_below_floor_never_restored", result.reserve_floor_results)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_PRE_EXISTING_PHYSICAL)

    def test_overlapping_expensive_windows_yield_per_window_classes(self) -> None:
        early_expensive = ImportBand(
            level="expensive", start=_at(8), end=_at(9, 30)
        )
        late_expensive = ImportBand(level="expensive", start=_at(9), end=_at(10, 30))
        bands = (_CHEAP_BAND, early_expensive, late_expensive)
        # The early window retains the bridge, while it has bled off halfway
        # through the late window.  Distinct expected classes make this a real
        # guard against applying one scenario-level verdict to both windows.
        build_snapshot = _make_build_snapshot(
            bands=bands,
            bump_expires_at=_at(9, 30),
        )
        result = _run(
            execution_optimizers=[_charge_from_grid_config()],
            build_snapshot=build_snapshot,
        )
        self._record("overlapping_expensive_windows", result.reserve_floor_results)
        by_window = {r.window: r.klass for r in result.reserve_floor_results}
        self.assertEqual(
            by_window,
            {
                (_slot_id(8), _slot_id(9, 30)): CLASS_NONE,
                (_slot_id(9), _slot_id(10, 30)): CLASS_PRE_EXISTING_PHYSICAL,
            },
        )

    def test_truncated_soc_series_is_unmeasurable(self) -> None:
        build_snapshot = _make_build_snapshot(truncate_before=_at(7))
        result = _run(
            execution_optimizers=[_charge_from_grid_config()],
            build_snapshot=build_snapshot,
        )
        self._record("truncated_soc_series", result.reserve_floor_results)
        outcome = result.reserve_floor_results[0]
        self.assertEqual(outcome.klass, CLASS_UNMEASURABLE)

    def test_run_with_no_charge_from_grid_captures_nothing(self) -> None:
        build_snapshot = _make_build_snapshot()
        captured_calls: list[object] = []
        real_build = build_snapshot

        def counting_build(document, **kwargs):
            captured_calls.append(document)
            return real_build(document, **kwargs)

        result = _run(
            execution_optimizers=[
                _stub_config(optimizer_id="only-appliance", kind="appliance_runtime", controllable_id="boiler")
            ],
            mutations_by_id={"only-appliance": lambda document: None},
            build_snapshot=counting_build,
        )
        self.assertEqual(result.reserve_floor_results, ())
        # Exactly the calls the ordinary loop always makes -- the initial
        # snapshot plus one post-step rebuild. No extra control/boundary
        # capture calls, because there is no `charge_from_grid` in this run.
        self.assertEqual(len(captured_calls), 2)


class TransportAndSafetyTests(unittest.TestCase):
    """Acceptance-criteria assertions that don't fit the scenario table."""

    def test_observations_excluded_from_to_dict_and_explanations(self) -> None:
        from custom_components.helman.automation.trace import OptimizerTrace

        trace = OptimizerTrace(slot_ids=(_slot_id(8),))
        trace.begin_step("grid-bridge", "charge_from_grid", controllable_id="inverter")
        trace.record_reserve_floor_observation(
            ReserveFloorObservation(
                optimizer_id="grid-bridge",
                group_index=0,
                window=_WINDOW,
                reserve_floor_soc=40.0,
                conditions_active=True,
                projected_min_soc=20.0,
                bridge_written=True,
            )
        )
        trace.end_step(status="ok")
        self.assertEqual(len(trace.reserve_floor_observations), 1)
        payload = trace.to_dict()
        self.assertNotIn("reserveFloorObservations", payload)
        self.assertNotIn("reserveFloorObservation", json.dumps(payload))
        for optimizer_explanation in trace.optimizer_explanations():
            self.assertNotIn("reserveFloor", json.dumps(optimizer_explanation.to_dict(trace.slot_ids)))

    def test_boundary_uses_next_index_equal_to_index_not_index_plus_one(self) -> None:
        """A regression to `next_index=index + 1` must be caught here.

        Put an appliance step right after `charge_from_grid`. With the
        correct `next_index=index` the boundary still treats that appliance's
        lane as pending (restored from baseline) -- exactly the demand basis
        `charge_from_grid`'s own input used. With the (wrong) `index + 1` the
        boundary would drop that pending lane, changing what the boundary
        snapshot's demand document contains.
        """
        build_snapshot = _make_build_snapshot()
        captured_demand_documents: list[ScheduleDocument] = []
        real_build = build_snapshot

        def spying_build(document, **kwargs):
            snapshot = real_build(document, **kwargs)
            demand = kwargs.get("demand_schedule_document")
            if demand is not None:
                captured_demand_documents.append(demand)
            return snapshot

        def add_baseline_appliance(document: ScheduleDocument) -> None:
            document.slots.setdefault(_slot_id(9), {})["boiler"] = {
                "on": True,
                "setBy": "automation",
            }

        baseline = ScheduleDocument(execution_enabled=True)
        add_baseline_appliance(baseline)
        result = _run(
            execution_optimizers=[
                _charge_from_grid_config(),
                _stub_config(optimizer_id="boiler", kind="appliance_runtime", controllable_id="boiler"),
            ],
            mutations_by_id={"boiler": add_baseline_appliance},
            build_snapshot=spying_build,
            schedule_document=baseline,
        )
        self.assertTrue(result.reserve_floor_results)
        # At least one demand document built during the run restored the
        # still-pending "boiler" lane -- proof the boundary rebuild (like
        # `charge_from_grid`'s own input) used `next_index=index`, which still
        # counts "boiler" as pending, not `index + 1`, which would not.
        self.assertTrue(
            any(
                "boiler" in document.slots.get(_slot_id(9), {})
                for document in captured_demand_documents
            )
        )

    def test_control_snapshot_carries_user_owned_actions_only(self) -> None:
        document = ScheduleDocument(
            execution_enabled=True,
            slots={_slot_id(7): {"inverter": ScheduleAction(kind="normal", set_by="user")}},
        )
        build_snapshot = _make_build_snapshot()
        captured: list[ScheduleDocument] = []
        real_build = build_snapshot

        def spying_build(doc, **kwargs):
            if "demand_schedule_document" not in kwargs:
                captured.append(doc)
            return real_build(doc, **kwargs)

        _run(
            execution_optimizers=[_charge_from_grid_config()],
            build_snapshot=spying_build,
            schedule_document=document,
        )
        # The very first no-override call is the control snapshot: built over
        # `schedule_document` as-is, i.e. the user-owned action and nothing
        # automation wrote (nothing has run yet at that point).
        control_document = captured[0]
        for actions in control_document.slots.values():
            inverter = actions.get("inverter")
            if inverter is not None:
                self.assertEqual(inverter.set_by, "user")
            for controllable_id, action in actions.items():
                if controllable_id == "inverter":
                    continue
                self.assertNotEqual(
                    (action or {}).get("setBy"), "automation"
                )

    def test_never_records_power_as_a_limit(self) -> None:
        committed = json.loads(GOLDEN_PATH.read_text())
        self.assertTrue(committed)
        for scenario_results in committed.values():
            for entry in scenario_results:
                self.assertNotEqual(entry.get("reason"), "power")

    def test_byte_equality_with_and_without_diagnostics(self) -> None:
        """Pure add-on: the shipped schedule must not depend on the flag."""
        build_snapshot = _make_build_snapshot()
        document = ScheduleDocument(execution_enabled=True)

        def dispatch(config, **kwargs):
            return build_charge_from_grid_optimizer(config)

        optimizers = [_charge_from_grid_config()]
        with patch.object(pipeline_module, "build_optimizer", side_effect=dispatch):
            with_diagnostics = run_optimizer_loop_pure(
                execution_optimizers=optimizers,
                baseline_schedule_document=document,
                schedule_document=document,
                initial_snapshot=build_snapshot(document),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
                capture_reserve_floor_diagnostics=True,
            )
            without_diagnostics = run_optimizer_loop_pure(
                execution_optimizers=optimizers,
                baseline_schedule_document=document,
                schedule_document=document,
                initial_snapshot=build_snapshot(document),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
                capture_reserve_floor_diagnostics=False,
            )
        self.assertEqual(
            with_diagnostics.working_schedule_document.slots,
            without_diagnostics.working_schedule_document.slots,
        )
        self.assertEqual(without_diagnostics.reserve_floor_results, ())
        self.assertTrue(with_diagnostics.reserve_floor_results)


class GoldenFileTests(unittest.TestCase):
    """Regenerable-identically golden file, keyed by observation identity."""

    def test_golden_file_matches_committed_fixture(self) -> None:
        loader = unittest.TestLoader()
        suite = loader.loadTestsFromTestCase(ScenarioSuiteTests)
        result = unittest.TestResult()
        suite.run(result)
        self.assertFalse(result.errors, result.errors)
        self.assertFalse(result.failures, result.failures)

        golden = ScenarioSuiteTests.golden
        self.assertTrue(golden)
        committed = json.loads(GOLDEN_PATH.read_text())
        self.assertEqual(golden, committed)


if __name__ == "__main__":
    unittest.main()
