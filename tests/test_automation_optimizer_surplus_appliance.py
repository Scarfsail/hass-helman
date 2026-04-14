from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:00:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:30:00+01:00"
THIRD_SLOT_ID = "2026-03-20T22:00:00+01:00"


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

    recorder_slots_mod = sys.modules.get("custom_components.helman.recorder_hourly_series")
    if recorder_slots_mod is None:
        recorder_slots_mod = types.ModuleType(
            "custom_components.helman.recorder_hourly_series"
        )
        sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod
    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    recorder_slots_mod.get_local_current_hour_start = (
        lambda reference_time: reference_time.replace(minute=0, second=0, microsecond=0)
    )

    async def _estimate_average_hourly_energy_when_switch_on(*args, **kwargs):
        return None

    async def _estimate_average_hourly_energy_when_climate_active(*args, **kwargs):
        return None

    async def _query_slot_boundary_state_values(*args, **kwargs):
        return {}

    async def _query_cumulative_hourly_energy_changes(*args, **kwargs):
        return []

    async def _query_slot_energy_changes(*args, **kwargs):
        return []

    recorder_slots_mod.estimate_average_hourly_energy_when_switch_on = (
        _estimate_average_hourly_energy_when_switch_on
    )
    recorder_slots_mod.estimate_average_hourly_energy_when_climate_active = (
        _estimate_average_hourly_energy_when_climate_active
    )
    recorder_slots_mod.get_today_completed_local_hours = lambda *args, **kwargs: []
    recorder_slots_mod.get_today_completed_local_slots = lambda *args, **kwargs: []
    recorder_slots_mod.query_slot_boundary_state_values = _query_slot_boundary_state_values
    recorder_slots_mod.query_cumulative_hourly_energy_changes = (
        _query_cumulative_hourly_energy_changes
    )
    recorder_slots_mod.query_slot_energy_changes = _query_slot_energy_changes

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
from custom_components.helman.automation.optimizers.surplus_appliance import (  # noqa: E402
    build_surplus_appliance_optimizer,
    SurplusApplianceSkip,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleDocument,
    build_horizon_end,
    schedule_document_to_dict,
)


def _make_generic_runtime(*, appliance_id: str = "boiler", hourly_energy_kwh: float = 1.0):
    return GenericApplianceRuntime(
        id=appliance_id,
        name=appliance_id.title(),
        switch_entity_id=f"switch.{appliance_id}",
        projection_strategy="fixed",
        hourly_energy_kwh=hourly_energy_kwh,
        history_energy_entity_id=None,
    )


def _make_climate_runtime(
    *,
    appliance_id: str = "living-room-hvac",
    hourly_energy_kwh: float = 1.0,
):
    return ClimateApplianceRuntime(
        id=appliance_id,
        name=appliance_id.title(),
        climate_entity_id=f"climate.{appliance_id}",
        projection_strategy="fixed",
        hourly_energy_kwh=hourly_energy_kwh,
        history_energy_entity_id=None,
    )


def _make_optimizer_config(
    *,
    appliance_id: str,
    climate_mode: str | None = None,
    min_surplus_buffer_pct: int = 5,
) -> OptimizerInstanceConfig:
    params: dict[str, object] = {
        "appliance_id": appliance_id,
        "action": "on",
        "min_surplus_buffer_pct": min_surplus_buffer_pct,
    }
    if climate_mode is not None:
        params["climate_mode"] = climate_mode
    return OptimizerInstanceConfig(
        id="run-on-surplus",
        kind="surplus_appliance",
        params=params,
    )


def _grid_series(
    values: list[float],
    *,
    exported_values: list[float] | None = None,
) -> list[dict[str, object]]:
    return [
        {
            "timestamp": (REFERENCE_TIME + timedelta(minutes=15 * index)).isoformat(),
            "exportedToGridKwh": (
                value if exported_values is None else exported_values[index]
            ),
            "availableSurplusKwh": value,
        }
        for index, value in enumerate(values)
    ]


def _make_snapshot(
    *,
    appliances: tuple[object, ...],
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float] | None = None,
    schedule_document: ScheduleDocument | None = None,
    grid_series: list[dict[str, object]] | None = None,
    battery_status: str = "available",
    battery_coverage_until: str | None = None,
    grid_status: str = "available",
    grid_coverage_until: str | None = None,
    reference_time: datetime | None = None,
) -> OptimizationSnapshot:
    registry = AppliancesRuntimeRegistry.from_appliances(appliances)
    current_time = REFERENCE_TIME if reference_time is None else reference_time
    return OptimizationSnapshot(
        schedule=ScheduleDocument(execution_enabled=True)
        if schedule_document is None
        else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={
            "status": battery_status,
            "coverageUntil": battery_coverage_until,
            "series": [],
        },
        grid_forecast={
            "status": grid_status,
            "coverageUntil": grid_coverage_until,
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        context=OptimizationContext(
            now=current_time,
            battery_state=None,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={"unit": "CZK/kWh", "currentPrice": 7.0, "points": []},
            export_price_forecast={"unit": "CZK/kWh", "currentPrice": 2.5, "points": []},
            appliance_registry=registry,
            when_active_hourly_energy_kwh_by_appliance_id=(
                {}
                if when_active_hourly_energy_kwh_by_appliance_id is None
                else deepcopy(when_active_hourly_energy_kwh_by_appliance_id)
            ),
        ),
    )


class _UnsupportedAppliance:
    def __init__(self, appliance_id: str) -> None:
        self.id = appliance_id
        self.kind = "ev_charger"


class SurplusApplianceOptimizerTests(unittest.TestCase):
    def test_generic_appliance_writes_on_actions_for_exact_surplus_slots(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertEqual(
            schedule_document_to_dict(result),
            {
                "executionEnabled": True,
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "empty"},
                        "appliances": {"boiler": {"on": True, "setBy": "automation"}},
                    },
                    NEXT_SLOT_ID: {
                        "inverter": {"kind": "empty"},
                        "appliances": {"boiler": {"on": True, "setBy": "automation"}},
                    },
                    THIRD_SLOT_ID: {
                        "inverter": {"kind": "empty"},
                        "appliances": {"boiler": {"on": True, "setBy": "automation"}},
                    },
                },
            },
        )

    def test_climate_appliance_writes_configured_mode_for_exact_surplus_slots(self) -> None:
        appliance = _make_climate_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(
                appliance_id=appliance.id,
                climate_mode="heat",
                min_surplus_buffer_pct=0,
            ),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.3, 0.3, 0.3, 0.3]),
            ),
            _make_optimizer_config(
                appliance_id=appliance.id,
                climate_mode="heat",
                min_surplus_buffer_pct=0,
            ),
        )

        self.assertEqual(
            schedule_document_to_dict(result),
            {
                "executionEnabled": True,
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "empty"},
                        "appliances": {
                            "living-room-hvac": {
                                "mode": "heat",
                                "setBy": "automation",
                            }
                        },
                    },
                    NEXT_SLOT_ID: {
                        "inverter": {"kind": "empty"},
                        "appliances": {
                            "living-room-hvac": {
                                "mode": "heat",
                                "setBy": "automation",
                            }
                        },
                    },
                },
            },
        )

    def test_insufficient_surplus_produces_no_writes(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.2, 0.2, 0.2, 0.2]),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertEqual(schedule_document_to_dict(result)["slots"], {})

    def test_zero_export_but_positive_available_surplus_still_writes(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series(
                    [0.3, 0.3, 0.3, 0.3],
                    exported_values=[0.0, 0.0, 0.0, 0.0],
                ),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertIn(CURRENT_SLOT_ID, schedule_document_to_dict(result)["slots"])

    def test_mid_slot_run_matches_current_bucket_surplus_by_canonical_start(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        reference_time = datetime.fromisoformat("2026-03-20T21:07:00+01:00")

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                reference_time=reference_time,
                grid_series=[
                    {
                        "timestamp": reference_time.isoformat(),
                        "availableSurplusKwh": 0.3,
                        "exportedToGridKwh": 0.0,
                    },
                    {
                        "timestamp": "2026-03-20T21:15:00+01:00",
                        "availableSurplusKwh": 0.3,
                        "exportedToGridKwh": 0.0,
                    },
                ],
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertIn(CURRENT_SLOT_ID, schedule_document_to_dict(result)["slots"])

    def test_user_owned_action_for_same_appliance_is_preserved(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "empty"},
                    "appliances": {"boiler": {"on": False, "setBy": "user"}},
                }
            },
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                schedule_document=schedule_document,
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.3, 0.3, 0.3, 0.3]),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertEqual(
            schedule_document_to_dict(result)["slots"][CURRENT_SLOT_ID]["appliances"],
            {"boiler": {"on": False, "setBy": "user"}},
        )
        self.assertEqual(
            schedule_document_to_dict(result)["slots"][NEXT_SLOT_ID]["appliances"],
            {"boiler": {"on": True, "setBy": "automation"}},
        )

    def test_other_user_owned_appliance_in_same_slot_is_preserved(self) -> None:
        appliance = _make_generic_runtime()
        other_appliance = _make_generic_runtime(appliance_id="pool")
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances(
                (appliance, other_appliance)
            ),
        )
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "empty"},
                    "appliances": {"pool": {"on": True, "setBy": "user"}},
                }
            },
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance, other_appliance),
                schedule_document=schedule_document,
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.3, 0.3]),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertEqual(
            schedule_document_to_dict(result)["slots"][CURRENT_SLOT_ID]["appliances"],
            {
                "boiler": {"on": True, "setBy": "automation"},
                "pool": {"on": True, "setBy": "user"},
            },
        )

    def test_buffer_zero_accepts_exact_match_while_default_five_rejects_it(self) -> None:
        appliance = _make_generic_runtime()
        zero_buffer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        default_buffer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )
        snapshot = _make_snapshot(
            appliances=(appliance,),
            when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
            grid_series=_grid_series([0.25, 0.25]),
        )

        zero_result = zero_buffer.optimize(
            snapshot,
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )
        default_result = default_buffer.optimize(
            snapshot,
            _make_optimizer_config(appliance_id=appliance.id),
        )

        self.assertIn(CURRENT_SLOT_ID, schedule_document_to_dict(zero_result)["slots"])
        self.assertEqual(schedule_document_to_dict(default_result)["slots"], {})

    def test_slot_is_skipped_when_one_covered_bucket_is_insufficient(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.3, 0.2]),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertEqual(schedule_document_to_dict(result)["slots"], {})

    def test_unknown_or_unsupported_appliance_raises_during_construction(self) -> None:
        appliance = _make_generic_runtime()
        with self.assertRaisesRegex(ValueError, "unknown appliance_id"):
            build_surplus_appliance_optimizer(
                _make_optimizer_config(appliance_id="missing"),
                appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
            )

        with self.assertRaisesRegex(ValueError, "must be generic or climate"):
            build_surplus_appliance_optimizer(
                _make_optimizer_config(appliance_id="car"),
                appliance_registry=AppliancesRuntimeRegistry.from_appliances(
                    (_UnsupportedAppliance("car"),)
                ),
            )

    def test_invalid_climate_mode_usage_raises_during_construction(self) -> None:
        generic = _make_generic_runtime()
        climate = _make_climate_runtime()

        with self.assertRaisesRegex(ValueError, "cannot set climate_mode"):
            build_surplus_appliance_optimizer(
                _make_optimizer_config(appliance_id=generic.id, climate_mode="heat"),
                appliance_registry=AppliancesRuntimeRegistry.from_appliances((generic,)),
            )

        with self.assertRaisesRegex(ValueError, "must set climate_mode"):
            build_surplus_appliance_optimizer(
                _make_optimizer_config(appliance_id=climate.id),
                appliance_registry=AppliancesRuntimeRegistry.from_appliances((climate,)),
            )

    def test_unavailable_forecast_or_demand_profile_skips_without_writes(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        with self.assertRaisesRegex(SurplusApplianceSkip, "when-active demand is unavailable") as no_demand_ctx:
            optimizer.optimize(
                _make_snapshot(
                    appliances=(appliance,),
                    when_active_hourly_energy_kwh_by_appliance_id={},
                    grid_series=_grid_series([0.3, 0.3]),
                ),
                _make_optimizer_config(
                    appliance_id=appliance.id,
                    min_surplus_buffer_pct=0,
                ),
            )
        self.assertEqual(no_demand_ctx.exception.appliance_id, appliance.id)

        with self.assertRaisesRegex(
            SurplusApplianceSkip,
            "forecast surplus inputs are unavailable",
        ) as no_forecast_ctx:
            optimizer.optimize(
                _make_snapshot(
                    appliances=(appliance,),
                    when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                    grid_series=_grid_series([0.3, 0.3]),
                    grid_status="unavailable",
                ),
                _make_optimizer_config(
                    appliance_id=appliance.id,
                    min_surplus_buffer_pct=0,
                ),
            )
        self.assertEqual(no_forecast_ctx.exception.appliance_id, appliance.id)

    def test_partial_forecasts_covering_schedule_horizon_are_accepted(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        result = optimizer.optimize(
            _make_snapshot(
                appliances=(appliance,),
                when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                grid_series=_grid_series([0.3] * 192),
                battery_status="partial",
                battery_coverage_until=build_horizon_end(REFERENCE_TIME).isoformat(),
                grid_status="partial",
                grid_coverage_until=build_horizon_end(REFERENCE_TIME).isoformat(),
            ),
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
        )

        self.assertEqual(
            schedule_document_to_dict(result)["slots"][CURRENT_SLOT_ID]["appliances"],
            {"boiler": {"on": True, "setBy": "automation"}},
        )

    def test_partial_forecasts_ending_before_schedule_horizon_still_skip(self) -> None:
        appliance = _make_generic_runtime()
        optimizer = build_surplus_appliance_optimizer(
            _make_optimizer_config(appliance_id=appliance.id, min_surplus_buffer_pct=0),
            appliance_registry=AppliancesRuntimeRegistry.from_appliances((appliance,)),
        )

        with self.assertRaisesRegex(
            SurplusApplianceSkip,
            "forecast surplus inputs are unavailable",
        ) as partial_ctx:
            optimizer.optimize(
                _make_snapshot(
                    appliances=(appliance,),
                    when_active_hourly_energy_kwh_by_appliance_id={appliance.id: 1.0},
                    grid_series=_grid_series([0.3] * 192),
                    battery_status="partial",
                    battery_coverage_until=(
                        build_horizon_end(REFERENCE_TIME) - timedelta(minutes=15)
                    ).isoformat(),
                    grid_status="partial",
                    grid_coverage_until=(
                        build_horizon_end(REFERENCE_TIME) - timedelta(minutes=15)
                    ).isoformat(),
                ),
                _make_optimizer_config(
                    appliance_id=appliance.id,
                    min_surplus_buffer_pct=0,
                ),
            )
        self.assertEqual(partial_ctx.exception.appliance_id, appliance.id)


if __name__ == "__main__":
    unittest.main()
