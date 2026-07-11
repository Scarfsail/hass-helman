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
from custom_components.helman.automation.config import OptimizerInstanceConfig  # noqa: E402
from custom_components.helman.automation.day_context import DayContext  # noqa: E402
from custom_components.helman.automation.optimizers.daily_runtime import (  # noqa: E402
    build_daily_runtime_optimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import ScheduleDocument  # noqa: E402


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
    runtime_by_date: dict[str, dict[date, float]] | None = None,
    schedule_document: ScheduleDocument | None = None,
    classification: str = "tight",
) -> OptimizationSnapshot:
    registry = AppliancesRuntimeRegistry.from_appliances((appliance,))
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={"status": "available", "series": []},
        grid_forecast={
            "status": "available",
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        context=OptimizationContext(
            now=REFERENCE_TIME,
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
        ),
    )


def _config(
    *,
    appliance_id: str,
    min_hours_per_day: int = 1,
    climate_mode: str | None = None,
    skip_on_days=None,
    max_consecutive_skips: int = 1,
) -> OptimizerInstanceConfig:
    params: dict[str, object] = {
        "appliance_id": appliance_id,
        "min_hours_per_day": min_hours_per_day,
        "window": {"start": "08:00", "end": "18:00"},
    }
    if climate_mode is not None:
        params["climate_mode"] = climate_mode
    if skip_on_days is not None:
        params["skip"] = {
            "on_days": skip_on_days,
            "max_consecutive_skips": max_consecutive_skips,
        }
    return OptimizerInstanceConfig(
        id="daily", kind="daily_runtime", params=params
    )


def _runtime(appliance_id: str, cfg: OptimizerInstanceConfig):
    return build_daily_runtime_optimizer(
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


class DailyRuntimeOptimizerTests(unittest.TestCase):
    def test_places_cheapest_export_slots(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_daily_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(
            _make_snapshot(appliance=appliance, export_points=_export_points(cheap)),
            cfg,
        )
        placed = _placed_slots(result, appliance.id)
        self.assertEqual(set(placed), cheap)
        for action in placed.values():
            self.assertEqual(action, {"on": True, "setBy": "automation"})

    def test_manual_runtime_reduces_remaining_budget(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_daily_runtime_optimizer(
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

    def test_already_satisfied_places_nothing(self) -> None:
        appliance = _generic()
        cfg = _config(appliance_id=appliance.id, min_hours_per_day=1)
        result = build_daily_runtime_optimizer(
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
            appliance_id=appliance.id, skip_on_days=["deficit"], max_consecutive_skips=1
        )
        result = build_daily_runtime_optimizer(
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
            appliance_id=appliance.id, skip_on_days=["deficit"], max_consecutive_skips=1
        )
        cheap = {_slot_id(12, 0), _slot_id(12, 30)}
        result = build_daily_runtime_optimizer(
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
        result = build_daily_runtime_optimizer(
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
        result = build_daily_runtime_optimizer(
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
        result = build_daily_runtime_optimizer(
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
        result = build_daily_runtime_optimizer(
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
        build_daily_runtime_optimizer(
            cfg, appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,))
        ).optimize(snapshot, cfg)
        self.assertEqual(snapshot.schedule.slots, before)


if __name__ == "__main__":
    unittest.main()
