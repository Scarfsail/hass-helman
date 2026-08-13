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
    # `battery_state` — reached through the self-sustainability simulator —
    # imports `HomeAssistant` purely for a type annotation on its live readers.
    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})
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
from custom_components.helman.automation.conditions.types import (  # noqa: E402
    ConditionRailsUnavailable,
)
from custom_components.helman.automation.day_context import DayContext  # noqa: E402
from custom_components.helman.battery_state import BatteryLiveState  # noqa: E402
from custom_components.helman.automation.optimizers.appliance_runtime import (  # noqa: E402
    _SelfSustainabilityGate,
    build_appliance_runtime_optimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.forecast_overlay import (  # noqa: E402
    ScheduleForecastOverlay,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleDocument,
    ScheduleSlot,
    iter_horizon_slot_ids,
)
from custom_components.helman.automation.trace import OptimizerTrace  # noqa: E402
from custom_components.helman.automation.explain import (  # noqa: E402
    OptimizerExplanation,
)
from automation_config_builders import make_optimizer_config  # noqa: E402
from automation_trace_contract import (  # noqa: E402
    assert_trace_contract,
    run_optimizer_with_trace,
)


def _explanation(trace) -> OptimizerExplanation:
    payload = trace.to_dict()
    return OptimizerExplanation.from_dict(
        payload["steps"][0]["explanation"], payload["slotIds"]
    )


def _slots_by_id(trace) -> dict:
    return {slot.slot_id: slot for slot in _explanation(trace).slots}


def _gate(slot, key: str):
    return next((gate for gate in slot.gates if gate.key == key), None)


def _node(slot, key: str, group_index: int = 0):
    group = next(group for group in slot.groups if group.index == group_index)
    return next(node for node in group.conditions if node.key == key)


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


def _surplus_series(
    surplus_by_slot: dict[str, float],
    *,
    default: float = 0.0,
) -> list[dict[str, object]]:
    """A 15-minute surplus series over the window, keyed by *schedule* slot.

    ``_min_solar_coverage_mask`` fails closed on a missing bucket, so every
    bucket of every window slot has to be present or thin sun is
    indistinguishable from a gap in the rail.
    """
    series: list[dict[str, object]] = []
    cursor = _at(8)
    while cursor < _at(18):
        slot_id = _slot_id(cursor.hour, (cursor.minute // 30) * 30)
        series.append(
            {
                "timestamp": cursor.isoformat(timespec="seconds"),
                "availableSurplusKwh": surplus_by_slot.get(slot_id, default),
            }
        )
        cursor += timedelta(minutes=15)
    return series


#: The battery the self-sustainability tests reason about: 10 kWh nominal,
#: half full, an inverter reserve of 10 % and lossless conversion so every
#: figure in those tests is exact arithmetic rather than a simulated
#: approximation.
BATTERY = BatteryLiveState(
    current_remaining_energy_kwh=5.0,
    current_soc=50.0,
    min_soc=10.0,
    max_soc=100.0,
    nominal_capacity_kwh=10.0,
    min_energy_kwh=1.0,
    max_energy_kwh=10.0,
)
BATTERY_PARAMS = {
    "battery_max_charge_power_kw": 5.0,
    "battery_charge_efficiency": 1.0,
    "battery_max_discharge_power_kw": 5.0,
    "battery_discharge_efficiency": 1.0,
    "battery_usable_capacity_kwh": 10.0,
}
#: 48 h of 15-minute buckets, which is what the schedule horizon spans.
HORIZON_BUCKETS = 192


def _sim_series(net_by_bucket: dict[datetime, float]) -> list[dict[str, object]]:
    """A battery series the horizon simulator can actually replay.

    Buckets carry ``solarKwh`` / ``baselineHouseKwh`` / ``durationHours`` rather
    than the ``socPct`` the mask-based conditions read, because the simulator
    re-derives the trajectory rather than reading it. A bucket's *net* is all
    these tests care about, so it is expressed directly and split into a solar
    or a house value as the sign requires.
    """
    series: list[dict[str, object]] = []
    for index in range(HORIZON_BUCKETS):
        bucket_start = REFERENCE_TIME + timedelta(minutes=15 * index)
        net = net_by_bucket.get(bucket_start, 0.0)
        series.append(
            {
                "timestamp": bucket_start.isoformat(timespec="seconds"),
                "durationHours": 0.25,
                "solarKwh": max(0.0, net),
                "baselineHouseKwh": max(0.0, -net),
            }
        )
    return series


def _morning_dip_series(*, trough_kwh: float = 1.6) -> list[dict[str, object]]:
    """Drains to ``trough_kwh`` by 09:00, then refills to full by 13:15.

    The shape the whole soft-floor story rests on: a slot placed *before* the
    trough deepens it, while one placed after it cannot, so "would break the
    floor" discriminates by time rather than rejecting everything.
    """
    drain_kwh = BATTERY.current_remaining_energy_kwh - trough_kwh
    buckets = 17  # 05:00 .. 09:00 inclusive
    per_bucket = drain_kwh / buckets
    net: dict[datetime, float] = {}
    for index in range(buckets):
        net[REFERENCE_TIME + timedelta(minutes=15 * index)] = -per_bucket
    for index in range(buckets, buckets * 2):
        net[REFERENCE_TIME + timedelta(minutes=15 * index)] = per_bucket
    return _sim_series(net)


def _curtailed_solar_series() -> list[dict[str, object]]:
    """Flat, then far more sun than the battery can hold, then flat again.

    The only shape under which a day can genuinely *pay for itself*: the battery
    fills and the rest of the surplus is exported, so an earlier draw is
    absorbed by solar that was going to be given away. Without curtailment,
    every kWh the appliance takes is a kWh the battery ends the day short of.
    """
    charge_buckets = 13  # 09:00 .. 12:00, at 0.5 kWh each against 5 kWh of room
    return _sim_series(
        {
            REFERENCE_TIME + timedelta(minutes=15 * index): 0.5
            for index in range(16, 16 + charge_buckets)
        }
    )


def _grid_charge_overlay(*, first_bucket: datetime, buckets: int):
    """An overlay that force-charges the battery to 100 % from the grid.

    The row-7 trap: with a charger targeting a SoC, an earlier appliance draw
    is silently repaid *from the grid*, so end-of-day SoC is identical and only
    the import delta shows what happened.
    """
    return ScheduleForecastOverlay(
        horizon_start=REFERENCE_TIME,
        horizon_end=REFERENCE_TIME + timedelta(hours=48),
        canonical_slot_minutes=15,
        slots=tuple(
            ScheduleSlot(
                id=(first_bucket + timedelta(minutes=15 * index)).isoformat(
                    timespec="seconds"
                ),
                action=ScheduleAction(
                    kind="charge_to_target_soc", target_soc=100
                ),
            )
            for index in range(buckets)
        ),
    )


def _trailing_drain_series(*, trough_kwh: float) -> list[dict[str, object]]:
    """Flat until the last quarter of the horizon, then drains to ``trough_kwh``.

    Puts the horizon's only trough *after* both planned days, so a placement on
    either day eats into the same headroom — which is what makes the accepted
    set having to span days observable.
    """
    drain_kwh = BATTERY.current_remaining_energy_kwh - trough_kwh
    first = HORIZON_BUCKETS - 48
    per_bucket = drain_kwh / (HORIZON_BUCKETS - first)
    return _sim_series(
        {
            REFERENCE_TIME + timedelta(minutes=15 * index): -per_bucket
            for index in range(first, HORIZON_BUCKETS)
        }
    )


def _day_context_on(local_date: date, classification: str = "tight") -> DayContext:
    return DayContext(
        local_date=local_date,
        classification=classification,
        predicted_solar_kwh=5.0,
        predicted_consumption_kwh=5.0,
        export_price_min=1.0,
        export_price_max=5.0,
        import_bands=(),
    )


def _day_context(classification: str = "tight") -> DayContext:
    return DayContext(
        local_date=DAY,
        classification=classification,
        predicted_solar_kwh=5.0,
        predicted_consumption_kwh=5.0,
        export_price_min=1.0,
        export_price_max=5.0,
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
    grid_status: str = "available",
    grid_coverage_until: str | None = None,
    battery_state: object | None = None,
    battery_params: dict[str, float] | None = None,
    day_contexts: dict[date, DayContext] | None = None,
    schedule_overlay: object | None = None,
) -> OptimizationSnapshot:
    registry = AppliancesRuntimeRegistry.from_appliances((appliance,))
    return OptimizationSnapshot(
        schedule_overlay=schedule_overlay,
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={
            "status": "available",
            "series": [] if battery_series is None else deepcopy(battery_series),
        },
        grid_forecast={
            "status": grid_status,
            "coverageUntil": grid_coverage_until,
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        context=OptimizationContext(
            now=REFERENCE_TIME if now is None else now,
            battery_state=battery_state,
            **(battery_params or {}),
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
            day_contexts=(
                {DAY: _day_context(classification)}
                if day_contexts is None
                else day_contexts
            ),
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
    target: dict[str, object] = {"controllable_id": appliance_id}
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
        slot_id: actions[appliance_id]
        for slot_id, actions in result.slots.items()
        if appliance_id in actions
        and actions[appliance_id].get("setBy") == "automation"
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
                    appliance.id: {"on": False, "setBy": "user"},
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
    """`max_run_price` narrows *which slots* a matched day may run on."""

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
            groups=[{"run_when": ["tight"], "max_run_price": 2.0}],
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
            groups=[{"run_when": ["tight"], "max_run_price": 2.0}],
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
            groups=[{"run_when": ["tight"], "max_run_price": 2.0}],
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

    def test_a_wholly_priced_out_day_is_explained_not_crashed(self) -> None:
        """Regression: a slot condition can empty a whole day, not just a run_when.

        The unmatched-day branch formatted *whatever* condition excluded the day
        as ``run_when``, so a numeric threshold reached ``list(2.0)`` and took
        the run down with a ``TypeError``. Reachable today with
        ``max_run_price``, and routine once a coverage condition can write off
        an overcast day.
        """
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=1,
            # One short day is still within budget, so nothing forces a run and
            # the day genuinely resolves to no group at all.
            max_consecutive_skips=1,
            groups=[{"run_when": ["tight"], "max_run_price": 0.5}],
        )
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(set())
        )

        result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        self.assertEqual(_placed_slots(result, appliance.id), {})
        assert_trace_contract(self, trace)
        slots = _slots_by_id(trace)
        priced_out = slots[_slot_id(12, 0)]
        # The day has no params to run under, and the gate names which condition
        # emptied it — the price threshold, not the classification.
        matched = _gate(priced_out, "day_group_matched")
        self.assertEqual(matched.state, "false")
        self.assertEqual(
            matched.params["failingCondition"], "max_run_price"
        )
        self.assertEqual(matched.params["conditionValue"], 0.5)
        self.assertEqual(matched.params["classification"], "tight")
        # The condition matrix carries the per-slot verdict and the price the
        # slot actually presented; nothing here re-states it as prose.
        self.assertEqual(_node(priced_out, "max_run_price").state, "false")
        self.assertEqual(priced_out.verdict, "skip")

    def test_an_unmatched_day_still_reports_its_classification(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=1,
            max_consecutive_skips=1,
            run_when=["surplus"],
        )
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(appliance=appliance, classification="deficit")

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        matched = _gate(_slots_by_id(trace)[_slot_id(12, 0)], "day_group_matched")
        self.assertEqual(matched.state, "false")
        self.assertEqual(
            matched.params,
            {
                "classification": "deficit",
                "failingCondition": "run_when",
                "conditionValue": ["surplus"],
            },
        )

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
                    "max_run_price": 2.0,
                    "params": {"daily_minimum": {"min_hours_per_day": 1}},
                },
                {
                    "run_when": ["tight"],
                    "max_run_price": 6.0,
                    "params": {"daily_minimum": {"min_hours_per_day": 5}},
                },
            ],
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(cheap)
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), cheap)


class SolarCoverageConditionTests(unittest.TestCase):
    """``min_solar_coverage_pct`` — is this slot's energy free right now?

    The appliance draws 0.4 kWh/h, so each 15-minute bucket of a slot wants
    0.1 kWh: 0.081 kWh of surplus is 81 % coverage and 0.079 kWh is 79 %.
    """

    def _optimize(self, cfg, snapshot, appliance):
        return build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        ).optimize(snapshot, cfg)

    def _config_with(self, appliance, threshold: float, **kwargs):
        return _config(
            appliance_id=appliance.id,
            min_hours_per_day=0.5,
            max_consecutive_skips=1,
            groups=[{"run_when": ["tight"], "min_solar_coverage_pct": threshold}],
            **kwargs,
        )

    def test_a_slot_below_the_threshold_is_gated_out(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            grid_series=_surplus_series(
                {_slot_id(12, 0): 0.081, _slot_id(12, 30): 0.079}
            ),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        # 81 % clears an 80 % floor; 79 % does not.
        self.assertEqual(set(placed), {_slot_id(12, 0)})

    def test_every_bucket_of_the_slot_must_clear(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        # 13:00's first bucket is drenched and its second is thin. Sampling one
        # end would authorise the slot on a value that holds for half of it.
        series = _surplus_series({})
        by_timestamp = {entry["timestamp"]: entry for entry in series}
        by_timestamp[_at(13, 0).isoformat(timespec="seconds")][
            "availableSurplusKwh"
        ] = 0.2
        by_timestamp[_at(13, 15).isoformat(timespec="seconds")][
            "availableSurplusKwh"
        ] = 0.079
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            grid_series=series,
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(placed, {})

    def test_a_slot_clearing_in_every_bucket_is_taken(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            grid_series=_surplus_series({_slot_id(13, 0): 0.2}),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(13, 0)})

    def test_full_coverage_is_reachable_at_a_hundred(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 100)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            # Exactly the bucket demand: 100 % is "at least", not "more than".
            grid_series=_surplus_series({_slot_id(9, 0): 0.1, _slot_id(9, 30): 0.099}),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(9, 0)})

    # --- rails must raise, never fail closed --------------------------------
    #
    # The condition gates placement, so an empty mask is indistinguishable from
    # the condition correctly saying "no sun anywhere" — and would silently
    # clear the appliance instead of restoring its baseline actions.

    def test_a_missing_surplus_rail_raises(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        snapshot = _make_snapshot(
            appliance=appliance, when_active={appliance.id: 0.4}
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_a_surplus_rail_stopping_short_of_the_horizon_raises(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            grid_series=_surplus_series({_slot_id(13, 0): 0.2}),
            grid_status="partial",
            # A partial series truncates rather than pads, so without this guard
            # the back half of the horizon would look uncovered.
            grid_coverage_until=_at(18).isoformat(timespec="seconds"),
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_a_partial_rail_that_does_cover_the_horizon_is_used(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            grid_series=_surplus_series({_slot_id(13, 0): 0.2}),
            grid_status="partial",
            grid_coverage_until=(
                REFERENCE_TIME + timedelta(hours=48)
            ).isoformat(timespec="seconds"),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(13, 0)})

    def test_a_missing_demand_profile_raises(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        snapshot = _make_snapshot(
            appliance=appliance,
            grid_series=_surplus_series({_slot_id(13, 0): 0.2}),
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_an_absent_threshold_leaves_the_whole_window_placeable(self) -> None:
        # Absent means unconstrained, never "inherit a default" — a coverage
        # floor nobody authored would stop the appliance running after dark.
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=0.5,
            groups=[{"run_when": ["tight"]}],
        )
        snapshot = _make_snapshot(appliance=appliance)

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(len(placed), 1)

    def test_a_gated_slot_is_told_the_coverage_it_achieved(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, 80)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            grid_series=_surplus_series(
                {_slot_id(12, 0): 0.081, _slot_id(12, 30): 0.04}
            ),
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        slots = _slots_by_id(trace)
        # The condition node carries the coverage the slot actually achieved —
        # the optimizer no longer restates it as a reason code.
        gated = _node(slots[_slot_id(12, 30)], "min_solar_coverage_pct")
        self.assertEqual(gated.state, "false")
        self.assertEqual(gated.value, 80.0)
        self.assertEqual(gated.actual, 40.0)
        self.assertEqual(slots[_slot_id(12, 30)].verdict, "skip")
        # The slot that cleared the gate is placed, and says by how much: the
        # margin is what tells a coverage of 81 % apart from one of 100 %.
        cleared = _node(slots[_slot_id(12, 0)], "min_solar_coverage_pct")
        self.assertEqual(cleared.state, "true")
        self.assertEqual(cleared.actual, 81.0)
        self.assertEqual(slots[_slot_id(12, 0)].verdict, "execute")


class SoftSelfSustainabilityTests(unittest.TestCase):
    """``ensure_self_sustainability: soft`` — will running here cost me later?

    The battery drains to 16 % by 09:00 and refills by 13:15, and the floor is
    ``min_soc`` 10 % plus a 5 pp margin = 15 %. The appliance draws 0.4 kWh/h,
    so a 30-minute slot costs 0.2 kWh = 2 pp: enough to push the 09:00 trough
    through the floor if it runs before it, and harmless if it runs after.
    """

    def _snapshot(self, appliance, **kwargs):
        kwargs.setdefault("battery_series", _morning_dip_series())
        return _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            **kwargs,
        )

    def _config_with(
        self,
        appliance,
        *,
        tolerance_pct=100,
        margin_pct=5,
        window_start="06:00",
        **kwargs,
    ):
        params: dict[str, object] = {
            "daily_minimum": {
                "min_hours_per_day": kwargs.pop("min_hours_per_day", 0.5),
                "max_consecutive_skips": kwargs.pop("max_consecutive_skips", 1),
            },
            "window": {"start": window_start, "end": "18:00"},
        }
        group: dict[str, object] = {"run_when": ["tight"]}
        if margin_pct is not None:
            group["self_sustainability_margin_pct"] = margin_pct
        if tolerance_pct is not None:
            group["ensure_self_sustainability"] = tolerance_pct
        return make_optimizer_config(
            id="daily",
            kind="appliance_runtime",
            target={"controllable_id": appliance.id},
            params=params,
            conditions=kwargs.pop("groups", None) or [group],
        )

    def _optimize(self, cfg, snapshot, appliance):
        return build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        ).optimize(snapshot, cfg)

    def test_the_cheapest_slot_loses_to_a_safe_one_when_it_breaks_the_floor(
        self,
    ) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance)
        # 08:00 is the cheapest slot and sits before the trough; 14:00 is
        # dearer but after it.
        snapshot = self._snapshot(
            appliance,
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertNotIn(_slot_id(8, 0), placed)
        self.assertEqual(len(placed), 1)
        # Anything at or after the 09:00 trough leaves it untouched.
        self.assertGreaterEqual(min(placed), _slot_id(9, 0))

    def test_without_the_condition_the_cheapest_slot_wins_regardless(self) -> None:
        # The control: the same snapshot, the same ranking, no condition. The
        # gate must be the only thing that moved the placement.
        appliance = _generic()
        cfg = self._config_with(appliance, tolerance_pct=None)
        snapshot = self._snapshot(
            appliance,
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(8, 0)})

    def test_a_margin_of_zero_never_fires(self) -> None:
        """The floor is `min_soc + margin`, and at margin 0 it is provably inert.

        Every discharge path clamps the remaining energy to ``min_energy_kwh``,
        so the projected SoC can never *reach* ``min_soc``, let alone go below
        it. Only the margin gives the floor teeth — which is the whole reason
        the config carries percentage points rather than a bare SoC threshold.
        """
        appliance = _generic()
        cfg = self._config_with(appliance, margin_pct=0)
        snapshot = self._snapshot(
            appliance,
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(8, 0)})

    def test_acceptance_re_checks_the_whole_accepted_set(self) -> None:
        """Not just the candidate on its own.

        The trough sits 2 pp above the floor, so one 0.2 kWh slot fits before it
        and a second does not — even though, judged alone, the second is
        identical to the first. Only re-simulating everything already accepted
        makes that visible. The run then falls through to a slot after the
        trough, which costs nothing.
        """
        appliance = _generic()
        # 1 h of runtime = 2 slots; 08:00 and 08:30 are the cheapest and both
        # sit before the trough.
        cfg = self._config_with(appliance, min_hours_per_day=1)
        snapshot = self._snapshot(
            appliance,
            battery_series=_morning_dip_series(trough_kwh=1.7),
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if hour == 8 else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(len(placed), 2)
        self.assertIn(_slot_id(8, 0), placed)
        # The second-cheapest slot is the one the combined trajectory rejects.
        self.assertNotIn(_slot_id(8, 30), placed)
        self.assertTrue(
            all(slot_id >= _slot_id(9, 0) for slot_id in set(placed) - {_slot_id(8, 0)})
        )

    def test_a_breach_is_told_where_the_floor_would_break(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = self._snapshot(
            appliance,
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        # The self-gating node the rails leave `not_evaluated` is resolved by the
        # optimizer, and carries what the refusal was measured against.
        node = _node(_slots_by_id(trace)[_slot_id(8, 0)], "ensure_self_sustainability")
        self.assertEqual(node.state, "false")
        self.assertEqual(node.value, 100.0)
        self.assertEqual(node.actual["code"], "would_break_soc_floor")
        self.assertEqual(node.actual["floor"], 15.0)
        self.assertEqual(node.actual["projectedMinSoc"], 14.0)
        self.assertEqual(node.actual["atSlot"], _slot_id(9, 0))

    def test_a_trajectory_already_below_the_floor_blames_the_baseline(self) -> None:
        """And blames it for the *first* candidate, not just the later ones.

        Deriving the verdict from "the accepted set minus the candidate" would
        pass trivially for the first candidate — the set is empty — so the first
        slot considered would always be blamed for a dip it did not cause.
        """
        appliance = _generic()
        cfg = self._config_with(appliance)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = self._snapshot(
            appliance,
            # The battery runs down to 14 % with no appliance at all.
            battery_series=_morning_dip_series(trough_kwh=1.4),
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        self.assertEqual(_placed_slots(result, appliance.id), {})
        assert_trace_contract(self, trace)
        slots = _slots_by_id(trace)
        codes = {
            slot_id: _node(slot, "ensure_self_sustainability").actual["code"]
            for slot_id, slot in slots.items()
            if _node(slot, "ensure_self_sustainability").state == "false"
        }
        # The cheapest slot is considered first; it must not take the blame.
        self.assertEqual(codes[_slot_id(8, 0)], "soc_floor_already_breached")
        self.assertNotIn("would_break_soc_floor", set(codes.values()))
        self.assertEqual(
            _node(slots[_slot_id(8, 0)], "ensure_self_sustainability").actual,
            {
                "code": "soc_floor_already_breached",
                "floor": 15.0,
                "baselineMinSoc": 14.0,
            },
        )

    def test_a_forced_run_places_despite_the_floor_and_prefers_covered_slots(
        self,
    ) -> None:
        """The escape hatch defeats this condition as it defeats every other.

        It does not have to be gratuitous about it: a forced run ranks by solar
        coverage before price, so it takes the slots that move the battery
        least.
        """
        appliance = _generic()
        cfg = self._config_with(
            appliance,
            max_consecutive_skips=0,
            # No group matches a deficit day, so the run is forced.
            groups=[{"run_when": ["surplus"], "ensure_self_sustainability": 100}],
        )
        snapshot = self._snapshot(
            appliance,
            classification="deficit",
            battery_series=_morning_dip_series(trough_kwh=1.4),
            # 11:00 is solar-covered but dear; 08:00 is the cheapest slot.
            grid_series=_surplus_series({_slot_id(11, 0): 5.0}),
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        # Placed at all, despite a baseline already through the floor...
        self.assertEqual(len(placed), 1)
        # ...and on the covered slot rather than the cheapest one.
        self.assertEqual(set(placed), {_slot_id(11, 0)})

    def test_the_in_flight_slot_stops_the_appliance_when_it_breaks_the_floor(
        self,
    ) -> None:
        """Promotion, not exemption — the same rule every other condition gets.

        The appliance is running in the 05:00 slot and promotion puts it at the
        front of the ranking, so it is the *first* candidate. It still has to
        pass: it sits before the trough, so it does not, and the run moves on.
        """
        appliance = _generic()
        # Window widened so the slot in progress is inside it.
        cfg = self._config_with(appliance, window_start="05:00")
        snapshot = self._snapshot(
            appliance,
            appliance_active_by_id={appliance.id: True},
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertNotIn(_slot_id(5, 0), placed)
        self.assertEqual(len(placed), 1)

    def test_the_in_flight_slot_survives_when_it_passes(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance, window_start="05:00")
        snapshot = self._snapshot(
            appliance,
            # Ample headroom: the promoted slot costs 2 pp against 15.
            battery_series=_morning_dip_series(trough_kwh=3.0),
            appliance_active_by_id={appliance.id: True},
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), {_slot_id(5, 0)})

    def test_day_one_placements_lower_day_twos_trajectory(self) -> None:
        """The accepted set spans days, because the trajectory does.

        The horizon's only trough sits at its far end, 2 pp above the floor —
        room for exactly one 0.2 kWh slot across *both* days. Day 1 is planned
        first and takes it, so day 2 finds none left, however cheap its slots
        are.
        """
        appliance = _generic()
        cfg = self._config_with(appliance)
        snapshot = self._snapshot(
            appliance,
            battery_series=_trailing_drain_series(trough_kwh=1.7),
            day_contexts={
                DAY: _day_context_on(DAY),
                DAY + timedelta(days=1): _day_context_on(DAY + timedelta(days=1)),
            },
            # Day 2 is the cheap day; it still loses, because greedy runs the
            # days in order and day 1 has already spent the headroom.
            export_points=[
                {
                    "timestamp": (
                        _at(hour, minute) + timedelta(days=day)
                    ).isoformat(timespec="seconds"),
                    "value": 1.0 if day == 1 else 5.0,
                }
                for day in (0, 1)
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(len(placed), 1)
        self.assertTrue(
            all(slot_id.startswith(DAY.isoformat()) for slot_id in placed),
            f"day 1 must win the headroom, got {sorted(placed)}",
        )

    # --- rails must raise, never fail closed --------------------------------

    def test_a_missing_battery_state_raises(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_params=BATTERY_PARAMS,
            battery_series=_morning_dip_series(),
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_missing_battery_parameters_raise(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            # The discharge half used to be absent from every snapshot; without
            # it there is no simulation to run.
            battery_params={
                key: value
                for key, value in BATTERY_PARAMS.items()
                if key != "battery_max_discharge_power_kw"
            },
            battery_series=_morning_dip_series(),
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_a_battery_forecast_short_of_the_horizon_raises(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_morning_dip_series(),
        )
        snapshot.battery_forecast["status"] = "partial"
        snapshot.battery_forecast["coverageUntil"] = _at(18).isoformat(
            timespec="seconds"
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_a_missing_demand_profile_raises(self) -> None:
        appliance = _generic()
        cfg = self._config_with(appliance)
        snapshot = _make_snapshot(
            appliance=appliance,
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_morning_dip_series(),
        )

        with self.assertRaises(ConditionRailsUnavailable):
            self._optimize(cfg, snapshot, appliance)

    def test_capped_mode_leaves_unreached_slots_not_evaluated(self) -> None:
        """The subtlest claim in the whole record.

        Capped placement stops consulting the gate the moment ``slots_needed``
        is met, so every slot below the cut was *never tested*. Recording those
        as ``false`` would say the floor refused a slot the floor never saw —
        and a matrix that cannot tell "refused" from "never asked" is worse than
        no matrix.
        """
        appliance = _generic()
        cfg = self._config_with(appliance)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = self._snapshot(
            appliance,
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (8, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        slots = _slots_by_id(trace)
        states = {
            slot_id: _node(slot, "ensure_self_sustainability").state
            for slot_id, slot in slots.items()
            if _gate(slot, "cheapest_rank") is not None
        }
        # The cheapest slot was consulted and refused.
        self.assertEqual(states[_slot_id(8, 0)], "false")
        # Exactly one slot was accepted, which is what closed the cut.
        accepted = [slot_id for slot_id, state in states.items() if state == "true"]
        self.assertEqual(len(accepted), 1)
        # Everything after it is unreached — `not_evaluated`, never `false`.
        unreached = [
            slot_id
            for slot_id, state in states.items()
            if slot_id > accepted[0]
        ]
        self.assertTrue(unreached)
        self.assertEqual(
            {states[slot_id] for slot_id in unreached},
            {"not_evaluated"},
            "slots below the placement cut were never consulted and must not "
            "be recorded as refusals",
        )
        # The ranking says the same thing in its own vocabulary: the cut never
        # reached them. It is an ordinal, so the position is still recorded.
        beyond = slots[unreached[-1]]
        self.assertEqual(_gate(beyond, "cheapest_rank").state, "false")
        self.assertGreater(_gate(beyond, "cheapest_rank").params["rank"], 1)

    def test_unavailable_rails_report_a_skipped_step_with_a_reason(self) -> None:
        """Not "every slot false" — nothing was evaluated at all."""
        appliance = _generic()
        cfg = self._config_with(appliance)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_morning_dip_series(),
        )

        trace = OptimizerTrace(slot_ids=iter_horizon_slot_ids(REFERENCE_TIME))
        trace.begin_step(optimizer.id, optimizer.kind)
        with self.assertRaises(ConditionRailsUnavailable):
            optimizer.optimize(snapshot, cfg, trace)
        # What the pipeline does with it.
        trace.end_step(status="skipped")

        explanation = _explanation(trace)
        self.assertEqual(explanation.status, "skipped")
        self.assertEqual(explanation.status_reason, "condition_rails_unavailable")

    def test_nothing_is_simulated_when_no_group_asks_for_it(self) -> None:
        # The gate is inert without the condition, so a config that never
        # mentions it must not start raising on a snapshot with no battery.
        appliance = _generic()
        cfg = self._config_with(appliance, tolerance_pct=None)
        snapshot = _make_snapshot(appliance=appliance)

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(len(placed), 1)


class StrictSelfSustainabilityTests(unittest.TestCase):
    """A budget of ``0`` — did the day the slot belongs to pay for itself?

    The strictest setting the one knob takes, and what ``strict`` used to mean:
    over that day, to local midnight and against the no-appliance baseline, the
    battery must be restored *and* no extra grid energy bought. The battery may
    be drained in the morning provided the day's sun refills it, which is
    exactly what ``min_solar_coverage_pct`` cannot express.

    These tests are the behaviour-preservation guard for the migration: they are
    the old ``strict`` suite with ``0`` in place of the word.
    """

    def _config(self, appliance, *, groups=None):
        return make_optimizer_config(
            id="daily",
            kind="appliance_runtime",
            target={"controllable_id": appliance.id},
            params={
                "daily_minimum": {
                    "min_hours_per_day": 0.5,
                    "max_consecutive_skips": 1,
                },
                "window": {"start": "06:00", "end": "18:00"},
            },
            conditions=groups
            or [{"run_when": ["tight"], "ensure_self_sustainability": 0}],
        )

    def _optimize(self, cfg, snapshot, appliance):
        return build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        ).optimize(snapshot, cfg)

    def test_a_morning_draw_repaid_by_curtailed_midday_sun_passes(self) -> None:
        appliance = _generic()
        cfg = self._config(appliance)
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_curtailed_solar_series(),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        # 06:00 drains 0.2 kWh; the midday surplus was being exported anyway, so
        # the day ends on the same SoC and the same import as without it.
        self.assertEqual(set(placed), {_slot_id(6, 0)})

    def test_an_evening_slot_cannot_be_repaid_and_is_refused(self) -> None:
        """Intended consequence: a zero budget confines it to daylight."""
        appliance = _generic()
        cfg = self._config(appliance)

        placed = _placed_slots(
            self._optimize(cfg, self._evening_snapshot(appliance), appliance),
            appliance.id,
        )

        self.assertNotIn(_slot_id(17, 0), placed)
        self.assertEqual(set(placed), {_slot_id(6, 0)})

    def test_an_unbounded_budget_would_have_taken_the_evening_slot(self) -> None:
        # The control: the floor alone is happy with an evening run — the
        # battery is full and stays far above it. Only the day budget refuses
        # it, which is why a budget of 0 is the floor *plus* something.
        appliance = _generic()
        cfg = self._config(
            appliance,
            groups=[{"run_when": ["tight"], "ensure_self_sustainability": 100}],
        )

        placed = _placed_slots(
            self._optimize(cfg, self._evening_snapshot(appliance), appliance),
            appliance.id,
        )

        self.assertEqual(set(placed), {_slot_id(17, 0)})

    def _evening_snapshot(self, appliance):
        """The evening slot is cheapest, so ranking reaches it first."""
        return _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_curtailed_solar_series(),
            export_points=[
                {"timestamp": _at(hour, minute).isoformat(timespec="seconds"),
                 "value": 1.0 if (hour, minute) == (17, 0)
                 else 2.0 if (hour, minute) == (6, 0) else 5.0}
                for hour in range(6, 18)
                for minute in (0, 30)
            ],
        )

    def test_a_budget_between_the_ends_buys_exactly_what_it_pays_for(self) -> None:
        """The capability the two words could not express.

        The evening slot costs 0.2 kWh the day cannot repay — refused at ``0``,
        taken at ``100``. On a 10 kWh battery a budget of 3 % is 0.3 kWh, which
        covers it; 1 % is 0.1 kWh, which does not. So the same slot flips on the
        number alone, with nothing else in the config changing.
        """
        appliance = _generic()
        evening = _slot_id(17, 0)

        for tolerance_pct, expected in ((1, False), (3, True)):
            with self.subTest(tolerance_pct=tolerance_pct):
                cfg = self._config(
                    appliance,
                    groups=[
                        {
                            "run_when": ["tight"],
                            "ensure_self_sustainability": tolerance_pct,
                        }
                    ],
                )
                placed = _placed_slots(
                    self._optimize(cfg, self._evening_snapshot(appliance), appliance),
                    appliance.id,
                )

                self.assertEqual(evening in placed, expected)

    def test_a_restored_battery_paid_for_from_the_grid_still_fails(self) -> None:
        """The reason strict compares *both* deltas.

        A grid charger targeting a SoC simply imports one more kWh to still hit
        it, so the appliance's draw leaves end-of-day SoC untouched while the
        energy came off the grid. SoC alone would call that self-sustaining.
        """
        appliance = _generic()
        cfg = self._config(appliance)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            # No sun at all; the battery is filled from the grid at 14:00.
            battery_series=_sim_series({}),
            schedule_overlay=_grid_charge_overlay(
                first_bucket=_at(14, 0), buckets=5
            ),
        )

        result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        self.assertEqual(_placed_slots(result, appliance.id), {})
        assert_trace_contract(self, trace)
        actual = _node(
            _slots_by_id(trace)[_slot_id(6, 0)], "ensure_self_sustainability"
        ).actual
        self.assertEqual(actual["code"], "over_battery_budget")
        # The battery is restored exactly...
        self.assertEqual(actual["deltaSocPct"], 0.0)
        # ...and the whole 0.2 kWh came off the grid instead.
        self.assertEqual(actual["deltaImportKwh"], 0.2)

    def test_strict_still_inherits_the_floor(self) -> None:
        """A day can balance while still dipping through the floor at noon."""
        appliance = _generic()
        cfg = self._config(appliance)
        optimizer = build_appliance_runtime_optimizer(
            cfg,
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_morning_dip_series(trough_kwh=1.6),
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        node = _node(
            _slots_by_id(trace)[_slot_id(6, 0)], "ensure_self_sustainability"
        )
        self.assertEqual(node.state, "false")
        self.assertEqual(node.actual["code"], "would_break_soc_floor")


class SelfSustainabilityConfigTests(unittest.TestCase):
    """Both numbers are per-group conditions, and one of them is defaulted."""

    def _config(self, *, params=None, groups=None):
        return make_optimizer_config(
            id="daily",
            kind="appliance_runtime",
            target={"controllable_id": "pool-pump"},
            params={
                "daily_minimum": {
                    "min_hours_per_day": 1,
                    "max_consecutive_skips": 1,
                },
                **(params or {}),
            },
            conditions=groups or [{"run_when": ["tight"]}],
        )

    def test_a_group_that_omits_the_margin_resolves_the_default(self) -> None:
        cfg = self._config()

        self.assertEqual(
            cfg.conditions[0].condition_values["self_sustainability_margin_pct"],
            5.0,
        )

    def test_setting_the_margin_wins(self) -> None:
        cfg = self._config(
            groups=[{"run_when": ["tight"], "self_sustainability_margin_pct": 12}]
        )

        self.assertEqual(
            cfg.conditions[0].condition_values["self_sustainability_margin_pct"],
            12.0,
        )

    def test_two_groups_may_carry_different_margins(self) -> None:
        """What the move buys: the floor is a per-group policy now.

        As a param it was master-plus-override, so a group could still move it —
        but only by opening the params override form, which is where it was hard
        to find. Two groups disagreeing is the same capability, said directly.
        """
        cfg = self._config(
            groups=[
                {"run_when": ["tight"], "self_sustainability_margin_pct": 20},
                {"run_when": ["surplus"], "self_sustainability_margin_pct": 2},
            ]
        )

        self.assertEqual(
            [
                group.condition_values["self_sustainability_margin_pct"]
                for group in cfg.conditions
            ],
            [20.0, 2.0],
        )

    def test_the_params_object_is_gone(self) -> None:
        """It moved into the conditions; the old key must fail, not be ignored."""
        with self.assertRaises(AutomationConfigError):
            self._config(params={"self_sustainability": {"margin_pct": 5}})

    def test_the_budget_is_a_percentage_not_a_word(self) -> None:
        self._config(groups=[{"ensure_self_sustainability": 0}])
        self._config(groups=[{"ensure_self_sustainability": 100}])
        for bad in ("soft", "strict", 150, -1):
            with self.subTest(value=bad), self.assertRaises(AutomationConfigError):
                self._config(groups=[{"ensure_self_sustainability": bad}])

    def test_a_zero_budget_is_a_value_not_an_absence(self) -> None:
        """The falsy-zero trap: 0 is the *strictest* setting, not "unset".

        A reader testing truthiness would hand the strictest config a null gate
        and place every candidate unchecked, which is the exact opposite of what
        it asked for.
        """
        cfg = self._config(groups=[{"ensure_self_sustainability": 0}])

        self.assertEqual(
            cfg.conditions[0].condition_values["ensure_self_sustainability"], 0.0
        )
        gate = _SelfSustainabilityGate.for_run(
            snapshot=_make_snapshot(
                appliance=_generic(),
                when_active={_generic().id: 0.4},
                battery_state=BATTERY,
                battery_params=BATTERY_PARAMS,
                battery_series=_morning_dip_series(),
            ),
            config=cfg,
            appliance_id="pool-pump",
            demand_hourly_energy=0.4,
        )

        self.assertIsInstance(gate, _SelfSustainabilityGate)


class DailyRuntimeTraceContractTests(unittest.TestCase):
    def test_placement_and_ranking_gates_and_contract(self) -> None:
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

        slots = _slots_by_id(trace)
        placed = slots[_slot_id(12, 0)]
        self.assertEqual(placed.verdict, "execute")
        self.assertEqual(_gate(placed, "run_window").state, "true")
        self.assertEqual(_gate(placed, "day_group_matched").state, "true")
        self.assertEqual(_gate(placed, "slot_available").state, "true")
        # `slot_available` is the ownership node in capped mode; the writer's
        # veto would say the same thing a second time, so it stays out.
        self.assertIsNone(_gate(placed, "blocked_user_owned"))
        remaining = _gate(placed, "daily_minimum_remaining")
        self.assertEqual(remaining.state, "true")
        self.assertEqual(remaining.params["minHours"], 1)
        self.assertEqual(remaining.params["doneHours"], 0.0)
        self.assertEqual(remaining.params["slotsNeeded"], 2)
        self.assertEqual(_gate(placed, "placement_capacity").state, "true")
        # Forced runs are the exception, so the override gate is absent here.
        self.assertIsNone(_gate(placed, "consecutive_skip_override"))
        rank = _gate(placed, "cheapest_rank")
        self.assertEqual(rank.state, "true")
        self.assertEqual(rank.params["rank"], 1)
        self.assertEqual(rank.params["slotsNeeded"], 2)

        # The ranking is an ordinal: a slot that lost carries its position, not
        # a truth value dressed up as a reason code.
        loser = slots[_slot_id(9, 0)]
        loser_rank = _gate(loser, "cheapest_rank")
        self.assertEqual(loser_rank.state, "false")
        self.assertGreater(loser_rank.params["rank"], loser_rank.params["slotsNeeded"])
        self.assertEqual(loser_rank.params["rankOf"], 20)  # 08:00..17:30
        self.assertEqual(loser.verdict, "skip")
        # Outside the window it never reached the ranking at all.
        outside = slots[_slot_id(6, 0)]
        self.assertEqual(_gate(outside, "run_window").state, "false")
        self.assertEqual(
            _gate(outside, "run_window").params, {"start": "08:00", "end": "18:00"}
        )
        self.assertIsNone(_gate(outside, "cheapest_rank"))
        self.assertIsNone(_gate(outside, "daily_minimum_remaining"))

    def test_priced_out_window_slots_fail_their_condition_node(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            min_hours_per_day=1,
            groups=[{"run_when": ["tight"], "max_run_price": 2.0}],
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
        slots = _slots_by_id(trace)
        priced_out = _node(slots[_slot_id(9, 0)], "max_run_price")
        self.assertEqual(priced_out.state, "false")
        self.assertEqual(priced_out.value, 2.0)
        self.assertEqual(slots[_slot_id(9, 0)].verdict, "skip")
        # Never ranked: the group does not own it, so it is not a candidate.
        self.assertIsNone(_gate(slots[_slot_id(9, 0)], "cheapest_rank"))
        # The two that cleared the threshold did.
        self.assertEqual(_node(slots[_slot_id(12, 0)], "max_run_price").state, "true")
        self.assertEqual(slots[_slot_id(12, 0)].verdict, "execute")

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
        slot = _slots_by_id(trace)[_slot_id(12, 0)]
        # The failing column is the one that actually failed, and a condition
        # this config never set is `not_applicable` rather than a null-threshold
        # price rejection.
        self.assertEqual(_node(slot, "min_soc_pct").state, "false")
        self.assertEqual(
            [node.key for node in slot.groups[0].conditions if node.state == "false"],
            ["min_soc_pct"],
        )
        # Still left to the frontend's derivation, exactly as before: only price
        # and coverage rejections are claimed by a decision here.
        step = trace.to_dict()["steps"][0]
        self.assertNotIn(
            _slot_id(12, 0),
            {
                slot_id
                for decision in step["decisions"]
                for slot_id in decision["slotIds"]
            },
        )

    def test_a_forced_run_carries_its_override_gate(self) -> None:
        appliance = _generic()
        cfg = _config(
            appliance_id=appliance.id,
            run_when=["surplus", "tight"],
            max_consecutive_skips=1,
        )
        optimizer = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points({_slot_id(12, 0), _slot_id(12, 30)}),
            classification="deficit",
            runtime_by_date={appliance.id: {DAY - timedelta(days=1): 0.0}},
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        placed = _slots_by_id(trace)[_slot_id(12, 0)]
        # No group matched the day; the override is why it ran anyway.
        self.assertEqual(_gate(placed, "day_group_matched").state, "false")
        override = _gate(placed, "consecutive_skip_override")
        self.assertEqual(override.state, "true")
        self.assertEqual(override.params["consecutiveSkips"], 2)
        self.assertEqual(override.params["maxConsecutiveSkips"], 1)
        self.assertEqual(placed.verdict, "execute")

    def test_a_user_owned_slot_never_reaches_the_ranking(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        optimizer = build_appliance_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            export_points=_export_points(cheap),
            schedule_document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    _slot_id(12, 0): {
                        appliance.id: {"on": False, "setBy": "user"},
                    }
                },
            ),
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, cfg, reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        owned = _slots_by_id(trace)[_slot_id(12, 0)]
        self.assertEqual(_gate(owned, "slot_available").state, "false")
        # Dropped before the ranking, so it has no rank at all — the writer
        # never sees it and its veto cannot speak for the slot.
        self.assertIsNone(_gate(owned, "cheapest_rank"))
        self.assertEqual(owned.verdict, "skip")

    def test_a_satisfied_day_closes_the_daily_minimum_gate(self) -> None:
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
        slot = _slots_by_id(trace)[_slot_id(12, 0)]
        remaining = _gate(slot, "daily_minimum_remaining")
        self.assertEqual(remaining.state, "false")
        self.assertEqual(remaining.params["doneHours"], 5.0)
        self.assertEqual(remaining.params["minHours"], 1)
        self.assertEqual(remaining.params["remainingHours"], -4.0)
        # Nothing past the bookkeeping was consulted, so nothing past it reports.
        self.assertIsNone(_gate(slot, "cheapest_rank"))
        self.assertIsNone(_gate(slot, "placement_capacity"))
        self.assertEqual(slot.verdict, "skip")


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
        target={"controllable_id": appliance_id},
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

    def test_the_writer_veto_is_the_ownership_node_without_a_cap(self) -> None:
        # Uncapped mode never ranks, so there is no `slot_available` to state
        # ownership — the writer's veto keeps its say here.
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, window={"start": "08:00", "end": "09:00"}
        )
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(set())
        )

        _result, trace = run_optimizer_with_trace(
            build_appliance_runtime_optimizer(
                cfg,
                appliance_registry=AppliancesRuntimeRegistry.from_appliances(
                    (appliance,)
                ),
            ),
            snapshot,
            cfg,
            reference_time=REFERENCE_TIME,
        )

        assert_trace_contract(self, trace)
        placed = _slots_by_id(trace)[_slot_id(8, 0)]
        self.assertIsNone(_gate(placed, "slot_available"))
        self.assertEqual(_gate(placed, "blocked_user_owned").state, "true")

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

    def test_placement_is_traced_with_a_verdict_and_a_window_gate(self) -> None:
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

        slots = _slots_by_id(trace)
        inside = slots[_slot_id(8, 0)]
        self.assertEqual(inside.verdict, "execute")
        self.assertEqual(_gate(inside, "run_window").state, "true")
        self.assertEqual(
            _gate(inside, "run_window").params, {"start": "08:00", "end": "09:00"}
        )
        outside = slots[_slot_id(12, 0)]
        self.assertEqual(_gate(outside, "run_window").state, "false")
        self.assertEqual(outside.verdict, "skip")
        # Uncapped mode never ranks: there is no deficit to size a cut against.
        self.assertIsNone(_gate(inside, "cheapest_rank"))

    def test_a_window_is_optional(self) -> None:
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id, groups=[{"max_run_price": 2.0}]
        )
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        snapshot = _make_snapshot(
            appliance=appliance, export_points=_export_points(cheap)
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertEqual(set(placed), cheap)

    def test_self_sustainability_accepts_candidates_chronologically(self) -> None:
        """Uncapped has no ranking, so time is the only defensible order.

        The trough at 09:00 sits 2 pp above the floor: room for exactly one
        0.2 kWh slot before it. Taking them in horizon order means the earliest
        eligible slot wins that room and the ones behind it are refused, while
        everything past the trough is free.
        """
        appliance = _generic()
        cfg = _uncapped_config(
            appliance_id=appliance.id,
            window={"start": "06:00", "end": "18:00"},
            groups=[{"run_when": ["tight"], "ensure_self_sustainability": 100}],
        )
        snapshot = _make_snapshot(
            appliance=appliance,
            when_active={appliance.id: 0.4},
            battery_state=BATTERY,
            battery_params=BATTERY_PARAMS,
            battery_series=_morning_dip_series(trough_kwh=1.7),
        )

        placed = _placed_slots(self._optimize(cfg, snapshot, appliance), appliance.id)

        self.assertIn(_slot_id(6, 0), placed)
        self.assertNotIn(_slot_id(6, 30), placed)
        self.assertNotIn(_slot_id(8, 30), placed)
        # Past the trough a slot no longer deepens it, so the run resumes.
        self.assertIn(_slot_id(10, 0), placed)
        # But each acceptance drains the battery for good, and uncapped mode
        # keeps taking slots until the accumulated draw reaches the floor
        # itself — which is exactly why the check re-simulates the whole
        # accepted set rather than one slot at a time.
        self.assertNotIn(_slot_id(17, 30), placed)


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

    def test_self_sustainability_alone_does_not_narrow_the_horizon(self) -> None:
        # It is self-gating: its mask is all-true by construction, so it cannot
        # be what stops an uncapped optimizer running the appliance 24/7.
        with self.assertRaises(AutomationConfigError):
            _uncapped_config(
                appliance_id="pool-pump",
                groups=[{"ensure_self_sustainability": 100}],
            )

    def test_a_solar_coverage_floor_is_enough(self) -> None:
        # It gates slots, so it narrows the horizon like any other condition.
        _uncapped_config(
            appliance_id="pool-pump", groups=[{"min_solar_coverage_pct": 80}]
        )

    def test_a_solar_coverage_floor_is_bounded_to_a_percentage(self) -> None:
        for value in (-1, 101):
            with self.subTest(value=value), self.assertRaises(AutomationConfigError):
                _config(
                    appliance_id="pool-pump",
                    groups=[{"min_solar_coverage_pct": value}],
                )

    def test_a_capped_optimizer_needs_no_narrowing_condition(self) -> None:
        _config(appliance_id="pool-pump", groups=[{}])

    def test_skips_cannot_be_set_without_a_minimum(self) -> None:
        with self.assertRaises(AutomationConfigError):
            make_optimizer_config(
                id="soak",
                kind="appliance_runtime",
                target={"controllable_id": "pool-pump"},
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
