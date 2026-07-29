from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TZ = timezone(timedelta(hours=2))
REFERENCE_TIME = datetime(2026, 7, 10, 5, 0, tzinfo=TZ)
DAY = date(2026, 7, 10)

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

    recorder_slots_mod = sys.modules.get(
        "custom_components.helman.recorder_hourly_series"
    )
    if recorder_slots_mod is None:
        recorder_slots_mod = types.ModuleType(
            "custom_components.helman.recorder_hourly_series"
        )
        sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    async def _noop(*args, **kwargs):
        return None

    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    recorder_slots_mod.estimate_average_hourly_energy_when_switch_on = _noop
    recorder_slots_mod.estimate_average_hourly_energy_when_climate_active = _noop

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
    util_pkg.dt = dt_mod
    recorder_slots_mod.dt_util = dt_mod


_install_import_stubs()

from custom_components.helman.appliances.climate_appliance import ClimateApplianceRuntime  # noqa: E402
from custom_components.helman.appliances.generic_appliance import GenericApplianceRuntime  # noqa: E402
from custom_components.helman.appliances.state import AppliancesRuntimeRegistry  # noqa: E402
from custom_components.helman.automation.config import (  # noqa: E402
    AutomationConfigError,
    OptimizerInstanceConfig,
)
from custom_components.helman.automation.day_context import DayContext  # noqa: E402
from custom_components.helman.automation.optimizers.appliance_runtime import (  # noqa: E402
    build_appliance_runtime_optimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import ScheduleDocument  # noqa: E402
from automation_config_builders import make_optimizer_config  # noqa: E402
from automation_trace_contract import (  # noqa: E402
    assert_trace_contract,
    run_optimizer_with_trace,
)


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 10, hour, minute, tzinfo=TZ)


def _slot_id(hour: int, minute: int = 0) -> str:
    return _at(hour, minute).isoformat(timespec="seconds")


def _generic(appliance_id: str = "pool-pump"):
    return GenericApplianceRuntime(
        id=appliance_id,
        name=appliance_id.title(),
        switch_entity_id=f"switch.{appliance_id}",
        projection_strategy="fixed",
        hourly_energy_kwh=0.4,
        history_energy_entity_id=None,
    )


def _climate(appliance_id: str = "living-room-hvac"):
    return ClimateApplianceRuntime(
        id=appliance_id,
        name=appliance_id.title(),
        climate_entity_id=f"climate.{appliance_id}",
        projection_strategy="fixed",
        hourly_energy_kwh=0.4,
        history_energy_entity_id=None,
    )


def _export_points(cheap_slots: set[str]) -> list[dict[str, object]]:
    points = []
    cursor = _at(8)
    end = _at(18)
    while cursor < end:
        slot_id = cursor.isoformat(timespec="seconds")
        points.append(
            {"timestamp": slot_id, "value": 1.0 if slot_id in cheap_slots else 5.0}
        )
        cursor += timedelta(minutes=30)
    return points


def _soc_series(
    *,
    low_slots: set[str],
    low: float = 50.0,
    high: float = 90.0,
) -> list[dict[str, object]]:
    """A 15-minute SoC series over the window, dipping on ``low_slots``.

    ``_min_soc_mask`` fails closed on a missing bucket, so every bucket of every
    window slot has to be present or the dip is indistinguishable from a gap.
    """
    series: list[dict[str, object]] = []
    cursor = _at(8)
    while cursor < _at(18):
        slot_id = _slot_id(cursor.hour, (cursor.minute // 30) * 30)
        series.append(
            {
                "timestamp": cursor.isoformat(timespec="seconds"),
                "socPct": low if slot_id in low_slots else high,
            }
        )
        cursor += timedelta(minutes=15)
    return series


def _day_context(classification: str = "tight") -> DayContext:
    return DayContext(
        local_date=DAY,
        classification=classification,
        predicted_solar_kwh=5.0,
        predicted_consumption_kwh=5.0,
        export_price_min=1.0,
        export_price_max=5.0,
        day_min_window=None,
        import_bands=(),
    )


def _make_snapshot(
    *,
    appliance,
    when_active: dict[str, float] | None = None,
    export_points: list[dict[str, object]] | None = None,
    grid_series: list[dict[str, object]] | None = None,
    battery_series: list[dict[str, object]] | None = None,
    runtime_by_date: dict[str, dict[date, float]] | None = None,
    schedule_document: ScheduleDocument | None = None,
    classification: str = "tight",
    condition_met_by_optimizer_id: dict[str, tuple[bool, ...]] | None = None,
    now: datetime | None = None,
    appliance_active_by_id: dict[str, bool] | None = None,
) -> OptimizationSnapshot:
    registry = AppliancesRuntimeRegistry.from_appliances((appliance,))
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={
            "status": "available",
            "series": [] if battery_series is None else deepcopy(battery_series),
        },
        grid_forecast={
            "status": "available",
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        context=OptimizationContext(
            now=REFERENCE_TIME if now is None else now,
            battery_state=None,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={"unit": "CZK/kWh", "currentPrice": 3.0, "points": []},
            export_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 2.0,
                "points": export_points or [],
            },
            appliance_registry=registry,
            when_active_hourly_energy_kwh_by_appliance_id=when_active or {},
            runtime_hours_by_appliance_id_by_local_date=runtime_by_date or {},
            day_contexts={DAY: _day_context(classification)},
            condition_met_by_optimizer_id=condition_met_by_optimizer_id or {},
            appliance_active_by_id=appliance_active_by_id or {},
        ),
    )


def _config(
    *,
    appliance_id: str,
    min_hours_per_day: int = 1,
    climate_mode: str | None = None,
    run_when=None,
    max_consecutive_skips: int = 0,
    groups: list[dict] | None = None,
) -> OptimizerInstanceConfig:
    target: dict[str, object] = {"appliance_id": appliance_id}
    if climate_mode is not None:
        target["climate_mode"] = climate_mode
    group: dict[str, object] = {}
    if run_when is not None:
        group["run_when"] = list(run_when)
    return make_optimizer_config(
        id="daily",
        kind="appliance_runtime",
        target=target,
        params={
            "daily_minimum": {
                "min_hours_per_day": min_hours_per_day,
                "max_consecutive_skips": max_consecutive_skips,
            },
            "window": {"start": "08:00", "end": "18:00"},
        },
        conditions=groups or [group],
    )


def _runtime(appliance_id: str, cfg: OptimizerInstanceConfig):
    return build_appliance_runtime_optimizer(
        cfg,
        appliance_registry=AppliancesRuntimeRegistry.from_appliances(
            (_generic(appliance_id),)
        ),
    )


def _placed_slots(result: ScheduleDocument, appliance_id: str) -> dict[str, dict]:
    return {
        slot_id: domains.appliances[appliance_id]
        for slot_id, domains in result.slots.items()
        if appliance_id in domains.appliances
        and domains.appliances[appliance_id].get("setBy") == "automation"
    }


class ApplianceRuntimeOptimizerTests(unittest.TestCase):
    def test_places_cheapest_export_slots(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(appliance=appliance, export_points=_export_points(cheap)),
            cfg,
        )
        placed = _placed_slots(result, appliance.id)
        self.assertEqual(set(placed), cheap)
        for action in placed.values():
            self.assertEqual(action, {"on": True, "setBy": "automation"})

    def test_places_candidate_actions_when_condition_not_met(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points(cheap),
                condition_met_by_optimizer_id={cfg.id: (False,)},
            ),
            cfg,
        )
        placed = _placed_slots(result, appliance.id)
        # Still placed (for display/promotion), but marked candidate.
        self.assertEqual(set(placed), cheap)
        for action in placed.values():
            self.assertEqual(
                action,
                {"on": True, "setBy": "automation", "conditionMet": False},
            )

    def test_manual_runtime_reduces_remaining_budget(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points(cheap),
                runtime_by_date={appliance.id: {DAY: 0.5}},
            ),
            cfg,
        )
        # remaining 0.5h -> 1 slot only, the cheapest.
        self.assertEqual(len(_placed_slots(result, appliance.id)), 1)

    # --- in-flight run commitment -------------------------------------------
    #
    # Shared setup: it is 12:20, the appliance has been running in the 12:00
    # slot, and 12:00 is the *most expensive* slot of the window. Ranking alone
    # therefore drops it and the appliance is switched off mid-run.

    def _in_flight_snapshot(self, appliance, *, active: bool, now=None, done=0.5):
        # Enough cheap slots that ranking never has to reach back to 12:00 on
        # the chronological tie-break — the only thing that may place it is the
        # promotion under test.
        cheap = {_slot_id(14, 0), _slot_id(14, 30), _slot_id(15, 0), _slot_id(15, 30)}
        return _make_snapshot(
            appliance=appliance,
            export_points=_export_points(cheap),
            runtime_by_date={appliance.id: {DAY: done}},
            now=_at(12, 20) if now is None else now,
            appliance_active_by_id={appliance.id: active},
        )

    def test_idle_appliance_loses_its_expensive_current_slot(self) -> None:
        # The control: without a run to protect, ranking decides alone.
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        result = _runtime(appliance.id, cfg).optimize(
            self._in_flight_snapshot(appliance, active=False), cfg
        )
        self.assertNotIn(_slot_id(12, 0), _placed_slots(result, appliance.id))

    def test_running_appliance_keeps_its_current_slot(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        result = _runtime(appliance.id, cfg).optimize(
            self._in_flight_snapshot(appliance, active=True), cfg
        )
        self.assertIn(_slot_id(12, 0), _placed_slots(result, appliance.id))

    def test_promotion_displaces_the_marginal_slot_not_the_budget(self) -> None:
        # Promotion must not inflate the placement: the same number of slots is
        # placed, the last one above the cut simply loses its seat.
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=2)
        idle = _placed_slots(
            _runtime(appliance.id, cfg).optimize(
                self._in_flight_snapshot(appliance, active=False), cfg
            ),
            appliance.id,
        )
        running = _placed_slots(
            _runtime(appliance.id, cfg).optimize(
                self._in_flight_snapshot(appliance, active=True), cfg
            ),
            appliance.id,
        )
        # remaining 1.5h -> 3 slots either way; the running slot takes the seat
        # of the priciest one the idle plan had chosen.
        self.assertEqual(len(idle), 3)
        self.assertEqual(len(running), 3)
        self.assertEqual(set(running) - set(idle), {_slot_id(12, 0)})
        self.assertEqual(len(set(idle) - set(running)), 1)

    def test_running_appliance_does_not_keep_an_ineligible_slot(self) -> None:
        # 07:20 is outside the 08:00-18:00 window, so the running slot never
        # reaches ranking. A condition that stops holding still stops the run.
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        result = _runtime(appliance.id, cfg).optimize(
            self._in_flight_snapshot(appliance, active=True, now=_at(7, 20)), cfg
        )
        self.assertNotIn(_slot_id(7, 0), _placed_slots(result, appliance.id))

    def test_running_appliance_still_stops_once_the_minimum_is_met(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        result = _runtime(appliance.id, cfg).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points({_slot_id(14, 0)}),
                runtime_by_date={appliance.id: {DAY: 1.0}},
                now=_at(12, 20),
                appliance_active_by_id={appliance.id: True},
            ),
            cfg,
        )
        self.assertEqual(_placed_slots(result, appliance.id), {})

    def test_running_appliance_slot_is_still_stamped_a_candidate(self) -> None:
        # Promotion is about ranking, not about condition_met: a custom
        # condition going false still stops the run, via candidate stripping.
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        snapshot = self._in_flight_snapshot(appliance, active=True)
        snapshot.context.condition_met_by_optimizer_id[cfg.id] = (False,)
        result = _runtime(appliance.id, cfg).optimize(snapshot, cfg)
        self.assertEqual(
            _placed_slots(result, appliance.id)[_slot_id(12, 0)].get("conditionMet"),
            False,
        )

    def test_already_satisfied_places_nothing(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points(set()),
                runtime_by_date={appliance.id: {DAY: 2.0}},
            ),
            cfg,
        )
        self.assertEqual(_placed_slots(result, appliance.id), {})

    def test_skips_on_deficit_day_when_guard_allows(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            run_when=["surplus", "tight"],
            max_consecutive_skips=1,
        )
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points(set()),
                classification="deficit",
            ),
            cfg,
        )
        self.assertEqual(_placed_slots(result, appliance.id), {})

    def test_consecutive_skip_guard_forces_run(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            run_when=["surplus", "tight"],
            max_consecutive_skips=1,
        )
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points(cheap),
                classification="deficit",
                runtime_by_date={appliance.id: {DAY - timedelta(days=1): 0.0}},
            ),
            cfg,
        )
        # yesterday already a skip -> skipping today would exceed max=1 -> run.
        self.assertEqual(set(_placed_slots(result, appliance.id)), cheap)

    def test_cheaper_uncovered_slot_beats_pricier_covered(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        # slot 10:00 covered by solar (buckets 10:00, 10:15) but pricey export;
        # slots 12:00/12:30 cheaper export but uncovered. Price is primary, so the
        # cheaper uncovered slots win; coverage is only a tiebreak.
        grid_series = [
            {"timestamp": _at(10, 0).isoformat(timespec="seconds"), "availableSurplusKwh": 5.0},
            {"timestamp": _at(10, 15).isoformat(timespec="seconds"), "availableSurplusKwh": 5.0},
        ]
        export_points = _export_points({_slot_id(12, 0), _slot_id(12, 30)})
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=export_points,
                grid_series=grid_series,
                when_active={appliance.id: 0.4},
            ),
            cfg,
        )
        # min_hours 1 -> 2 slots; both cheapest slots, not the covered 10:00.
        placed = _placed_slots(result, appliance.id)
        self.assertEqual(set(placed), {_slot_id(12, 0), _slot_id(12, 30)})

    def test_coverage_breaks_ties_between_equal_priced_slots(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=0.5)
        # slots 11:00 and 13:00 share the cheapest export price; only 13:00 is
        # solar-covered. With one slot needed, coverage breaks the tie in favour
        # of 13:00 even though 11:00 is earlier.
        grid_series = [
            {"timestamp": _at(13, 0).isoformat(timespec="seconds"), "availableSurplusKwh": 5.0},
            {"timestamp": _at(13, 15).isoformat(timespec="seconds"), "availableSurplusKwh": 5.0},
        ]
        export_points = _export_points({_slot_id(11, 0), _slot_id(13, 0)})
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=export_points,
                grid_series=grid_series,
                when_active={appliance.id: 0.4},
            ),
            cfg,
        )
        placed = _placed_slots(result, appliance.id)
        self.assertEqual(set(placed), {_slot_id(13, 0)})

    def test_the_slot_in_progress_can_win_the_coverage_tie_break(self) -> None:
        # Regression: the grid series' first point is stamped with the raw run
        # instant, not a bucket start. Keyed verbatim it produced a key no
        # caller could construct, so the bucket covering *now* always missed and
        # the slot being executed could never be found solar-covered. Every
        # other test here uses an aligned reference time, which hides it.
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=0.5)
        now = _at(12, 20).replace(microsecond=183921)
        # 12:00 (in progress) and 14:00 share the cheapest price; both are
        # covered, so the chronological tie-break must hand it to 12:00.
        grid_series = [{"timestamp": now.isoformat(), "availableSurplusKwh": 5.0}]
        grid_series += [
            {
                "timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                "availableSurplusKwh": 5.0,
            }
            for hour, minute in ((12, 30), (14, 0), (14, 15))
        ]
        result = _runtime(appliance.id, cfg).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points({_slot_id(12, 0), _slot_id(14, 0)}),
                grid_series=grid_series,
                when_active={appliance.id: 0.4},
                now=now,
            ),
            cfg,
        )
        self.assertEqual(set(_placed_slots(result, appliance.id)), {_slot_id(12, 0)})

    def test_leaves_user_owned_appliance_slot_untouched(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                _slot_id(12, 0): {
                    "inverter": {"kind": "empty"},
                    "appliances": {appliance.id: {"on": False, "setBy": "user"}},
                }
            },
        )
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(
                appliance=appliance,
                export_points=_export_points(cheap),
                schedule_document=schedule_document,
            ),
            cfg,
        )
        placed = _placed_slots(result, appliance.id)
        self.assertNotIn(_slot_id(12, 0), placed)
        self.assertEqual(len(placed), 2)

    def test_climate_appliance_writes_mode_action(self) -> None:
        appliance = _climate()
        cfg = _config(
            appliance_id=appliance.id, min_hours_per_day=1, climate_mode="heat"
        )
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(appliance=appliance, export_points=_export_points(cheap)),
            cfg,
        )
        placed = _placed_slots(result, appliance.id)
        self.assertEqual(set(placed), cheap)
        for action in placed.values():
            self.assertEqual(action, {"mode": "heat", "setBy": "automation"})

    def test_does_not_mutate_snapshot_schedule(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points({_slot_id(12, 0), _slot_id(12, 30)}),
        )
        before = deepcopy(snapshot.schedule.slots)
        build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(snapshot, cfg)
        self.assertEqual(snapshot.schedule.slots, before)


class DailyRuntimePriceConditionTests(unittest.TestCase):
    """`when_price_below` narrows *which slots* a matched day may run on."""

    def _optimize(self, cfg, snapshot, appliance):
        return build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        ).optimize(snapshot, cfg)

    def test_only_slots_below_the_threshold_are_placeable(self) -> None:
        appliance = _generic()
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        # 3h of deficit wants 6 slots, but only 2 clear the threshold. Without
        # the filter the ranking would happily take four 5.0 slots as well.
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=3,
            max_consecutive_skips=1,
            groups=[{"run_when": ["tight"], "when_price_below": 2.0}],
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(cheap)
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), cheap)

    def test_an_absent_threshold_leaves_the_whole_window_placeable(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=3,
            groups=[{"run_when": ["tight"]}],
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points({_slot_id(12, 0), _slot_id(12, 30)}),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(len(placed), 6)

    def test_a_day_short_on_eligible_slots_still_places_what_it_can(self) -> None:
        appliance = _generic()
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=3,
            max_consecutive_skips=1,
            groups=[{"run_when": ["tight"], "when_price_below": 2.0}],
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(cheap)
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        # 1h delivered against a 3h minimum: short, but not yet due a forced run.
        self.assertEqual(set(placed), cheap)

    def test_too_few_eligible_slots_eventually_forces_a_full_run(self) -> None:
        """The escape hatch fires for a priced-out day, not only an unmatched one.

        Without this, a group that matches every day but whose threshold no slot
        ever clears would under-run forever — `max_consecutive_skips` would
        never see a "skip" to count.
        """
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=3,
            max_consecutive_skips=1,
            groups=[{"run_when": ["tight"], "when_price_below": 2.0}],
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points({_slot_id(12, 0), _slot_id(12, 30)}),
            # Yesterday also fell short, so today is one skip past the limit.
            runtime_by_date={appliance.id: {DAY - timedelta(days=1): 0.0}},
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        # Forced: the full 3h, over the whole window, past the threshold.
        self.assertEqual(len(placed), 6)

    def test_the_day_resolves_to_the_first_group_in_config_order(self) -> None:
        """Two groups can own different slots of one day; params come from one.

        The tie goes to config order, not to whichever group happens to own the
        earliest slot — and placement is confined to that group's own slots.
        """
        appliance = _generic()
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        cfg = _config(
            appliance_id=appliance.id,
            groups=[
                {
                    "run_when": ["tight"],
                    "when_price_below": 2.0,
                    "params": {"daily_minimum": {"min_hours_per_day": 1}},
                },
                {
                    "run_when": ["tight"],
                    "when_price_below": 6.0,
                    "params": {"daily_minimum": {"min_hours_per_day": 5}},
                },
            ],
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(cheap)
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), cheap)


class DailyRuntimeTraceContractTests(unittest.TestCase):
    def test_placement_and_ranking_reasons_and_contract(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        optimizer = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        )
        snapshot = _make_snapshot(appliance=appliance, export_points=_export_points(cheap))

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        applied = [d for d in step["decisions"] if d["outcome"] == "applied"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0]["reason"]["code"], "runtime_deficit_placed")
        self.assertTrue(
            any(
                d["reason"]["code"] == "ranked_more_expensive"
                for d in step["decisions"]
            )
        )

    def test_priced_out_window_slots_get_their_own_rejection(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=1,
            groups=[{"run_when": ["tight"], "when_price_below": 2.0}],
        )
        optimizer = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points({_slot_id(12, 0), _slot_id(12, 30)}),
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        rejected = [
            d for d in step["decisions"] if d["reason"]["code"] == "price_above_run_threshold"
        ]
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["reason"]["params"], {"threshold": 2.0})
        # Every window slot except the two that cleared the threshold.
        self.assertNotIn(_slot_id(12, 0), rejected[0]["slotIds"])
        self.assertIn(_slot_id(9, 0), rejected[0]["slotIds"])

    def test_a_soc_rejected_slot_is_not_reported_as_priced_out(self) -> None:
        # The rejection used to be hardcoded to the price code for *every*
        # window slot the matched group did not own, so a slot dropped by
        # `min_soc_pct` was explained as "price too high to run" — with a null
        # threshold, since this config has no price condition at all.
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=1,
            groups=[{"run_when": ["tight"], "min_soc_pct": 70}],
        )
        optimizer = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            battery_series=_soc_series(low_slots={_slot_id(12, 0)}),
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        self.assertEqual(
            [
                decision
                for decision in step["decisions"]
                if decision["reason"]["code"] == "price_above_run_threshold"
            ],
            [],
            "a SoC rejection must not be reported as a price rejection",
        )
        # Left to the frontend's derivation, which explains it with the slot's
        # own projected SoC rather than a threshold this config never set.
        self.assertNotIn(
            _slot_id(12, 0),
            {
                slot_id
                for decision in step["decisions"]
                for slot_id in decision["slotIds"]
            },
        )

    def test_satisfied_day_emits_runtime_satisfied(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        optimizer = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points(set()),
            runtime_by_date={appliance.id: {DAY: 5.0}},
        )
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        self.assertTrue(
            any(d["reason"]["code"] == "runtime_satisfied" for d in step["decisions"])
        )


def _uncapped_config(
    *,
    appliance_id: str,
    window: dict | None = None,
    groups: list[dict] | None = None,
) -> OptimizerInstanceConfig:
    params: dict[str, object] = {}
    if window is not None:
        params["window"] = window
    return make_optimizer_config(
        id="soak",
        kind="appliance_runtime",
        target={"appliance_id": appliance_id},
        params=params,
        conditions=groups or [{"run_when": ["tight"]}],
    )


class UncappedModeTests(unittest.TestCase):
    """Without ``daily_minimum`` there is no deficit, so every eligible slot runs."""

    def _optimize(self, cfg, snapshot, appliance):
        return build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        ).optimize(snapshot, cfg)

    def test_every_eligible_slot_is_placed(self) -> None:
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, window={"start": "08:00", "end": "10:00"}
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(set())
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(
            set(placed),
            {_slot_id(8, 0), _slot_id(8, 30), _slot_id(9, 0), _slot_id(9, 30)},
        )

    def test_price_does_not_rank_when_there_is_no_cap(self) -> None:
        # The capped path would take only the two cheap slots; uncapped takes
        # the whole window, cheap or not.
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, window={"start": "12:00", "end": "13:00"}
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points({_slot_id(12, 0)})
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(12, 0), _slot_id(12, 30)})

    def test_delivered_runtime_does_not_shrink_the_placement(self) -> None:
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, window={"start": "08:00", "end": "09:00"}
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points(set()),
            runtime_by_date={appliance.id: {DAY: 12.0}},
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(8, 0), _slot_id(8, 30)})

    def test_a_day_no_group_matches_places_nothing(self) -> None:
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id,
            window={"start": "08:00", "end": "10:00"},
            groups=[{"run_when": ["surplus"]}],
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points(set()),
            classification="tight",
        )

        self.assertEqual(
            _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id), {}
        )

    def test_placement_is_traced_as_conditions_matched(self) -> None:
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, window={"start": "08:00", "end": "09:00"}
        )
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(set())
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        applied = [d for d in step["decisions"] if d["outcome"] == "applied"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0]["reason"]["code"], "conditions_matched")

    def test_a_window_is_optional(self) -> None:
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, groups=[{"when_price_below": 2.0}]
        )
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(cheap)
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), cheap)


class UncappedValidationTests(unittest.TestCase):
    def test_a_group_that_narrows_nothing_is_rejected(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            _uncapped_config(appliance_id="pool-pump", groups=[{}])

        self.assertEqual(ctx.exception.code, "invalid_value")

    def test_a_window_alone_is_enough(self) -> None:
        _uncapped_config(
            appliance_id="pool-pump",
            window={"start": "08:00", "end": "18:00"},
            groups=[{}],
        )

    def test_a_narrowed_run_when_is_enough(self) -> None:
        _uncapped_config(appliance_id="pool-pump", groups=[{"run_when": ["surplus"]}])

    def test_a_capped_optimizer_needs_no_narrowing_condition(self) -> None:
        _config(appliance_id="pool-pump", groups=[{}])

    def test_skips_cannot_be_set_without_a_minimum(self) -> None:
        with self.assertRaises(AutomationConfigError):
            make_optimizer_config(
                id="soak",
                kind="appliance_runtime",
                target={"appliance_id": "pool-pump"},
                params={"daily_minimum": {"max_consecutive_skips": 2}},
                conditions=[{"run_when": ["surplus"]}],
            )

    def test_a_group_cannot_introduce_the_daily_minimum(self) -> None:
        # `max_consecutive_skips` is required inside and not overridable, so a
        # partial object can never resolve on a master that has none.
        with self.assertRaises(AutomationConfigError):
            _uncapped_config(
                appliance_id="pool-pump",
                groups=[
                    {
                        "run_when": ["surplus"],
                        "params": {"daily_minimum": {"min_hours_per_day": 2}},
                    }
                ],
            )


if __name__ == "__main__":
    unittest.main()
