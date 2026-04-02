from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")

_STUBBED_MODULES = (
    "custom_components",
    "custom_components.helman",
    "custom_components.helman.battery_capacity_forecast_builder",
    "custom_components.helman.battery_state",
    "custom_components.helman.consumption_forecast_builder",
    "custom_components.helman.forecast_builder",
    "custom_components.helman.grid_flow_forecast_builder",
    "custom_components.helman.grid_flow_forecast_response",
    "custom_components.helman.grid_price_forecast_response",
    "custom_components.helman.recorder_hourly_series",
    "custom_components.helman.scheduling",
    "custom_components.helman.scheduling.action_resolution",
    "custom_components.helman.scheduling.runtime_status",
    "custom_components.helman.scheduling.schedule",
    "custom_components.helman.scheduling.schedule_executor",
    "custom_components.helman.storage",
    "custom_components.helman.tree_builder",
    "homeassistant",
    "homeassistant.components",
    "homeassistant.components.energy",
    "homeassistant.components.energy.data",
    "homeassistant.core",
    "homeassistant.helpers",
    "homeassistant.helpers.entity_registry",
    "homeassistant.helpers.event",
    "homeassistant.util",
    "homeassistant.util.dt",
)


def _install_import_stubs() -> dict[str, types.ModuleType | None]:
    previous_modules = {
        module_name: sys.modules.get(module_name) for module_name in _STUBBED_MODULES
    }
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
    scheduling_pkg.__path__ = [str(ROOT / "custom_components" / "helman" / "scheduling")]

    battery_builder_mod = types.ModuleType(
        "custom_components.helman.battery_capacity_forecast_builder"
    )
    battery_builder_mod.BatteryCapacityForecastBuilder = type(
        "BatteryCapacityForecastBuilder",
        (),
        {},
    )
    sys.modules[battery_builder_mod.__name__] = battery_builder_mod

    consumption_builder_mod = types.ModuleType(
        "custom_components.helman.consumption_forecast_builder"
    )
    consumption_builder_mod.ConsumptionForecastBuilder = type(
        "ConsumptionForecastBuilder",
        (),
        {
            "_MAX_ALIGNMENT_PADDING_SLOTS": 3,
            "_make_payload": staticmethod(lambda **kwargs: kwargs),
        },
    )
    sys.modules[consumption_builder_mod.__name__] = consumption_builder_mod

    forecast_builder_mod = types.ModuleType("custom_components.helman.forecast_builder")
    forecast_builder_mod.HelmanForecastBuilder = type(
        "HelmanForecastBuilder",
        (),
        {},
    )
    sys.modules[forecast_builder_mod.__name__] = forecast_builder_mod

    grid_builder_mod = types.ModuleType(
        "custom_components.helman.grid_flow_forecast_builder"
    )
    grid_builder_mod.build_grid_flow_forecast_snapshot = lambda snapshot: snapshot
    sys.modules[grid_builder_mod.__name__] = grid_builder_mod

    grid_response_mod = types.ModuleType(
        "custom_components.helman.grid_flow_forecast_response"
    )
    grid_response_mod.build_grid_flow_forecast_response = lambda *args, **kwargs: {}
    sys.modules[grid_response_mod.__name__] = grid_response_mod

    grid_price_response_mod = types.ModuleType(
        "custom_components.helman.grid_price_forecast_response"
    )
    grid_price_response_mod.build_grid_price_forecast_response = (
        lambda *args, **kwargs: {}
    )
    sys.modules[grid_price_response_mod.__name__] = grid_price_response_mod

    tree_builder_mod = types.ModuleType("custom_components.helman.tree_builder")
    tree_builder_mod.HelmanTreeBuilder = type("HelmanTreeBuilder", (), {})
    sys.modules[tree_builder_mod.__name__] = tree_builder_mod

    battery_state_mod = types.ModuleType("custom_components.helman.battery_state")
    battery_state_mod.describe_battery_entity_config_issue = lambda config: None
    battery_state_mod.describe_battery_live_state_issue = lambda hass, config=None: None
    battery_state_mod.read_battery_entity_config = lambda config: None
    battery_state_mod.read_battery_live_state = lambda hass, config=None: None
    battery_state_mod.read_battery_soc_bounds = lambda hass, config=None: None
    battery_state_mod.read_battery_soc_bounds_config = lambda config: None
    sys.modules[battery_state_mod.__name__] = battery_state_mod

    recorder_slots_mod = types.ModuleType("custom_components.helman.recorder_hourly_series")
    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    schedule_mod = types.ModuleType("custom_components.helman.scheduling.schedule")
    schedule_mod.ScheduleControlConfig = type("ScheduleControlConfig", (), {})
    schedule_mod.ScheduleDocument = type(
        "ScheduleDocument",
        (),
        {"__init__": lambda self, execution_enabled=False, slots=None: None},
    )
    schedule_mod.ScheduleError = type("ScheduleError", (Exception,), {})
    schedule_mod.ScheduleResponseDict = dict
    schedule_mod.ScheduleSlot = dict
    schedule_mod.SCHEDULE_SLOT_DURATION = timedelta(minutes=30)
    schedule_mod.apply_slot_patches = lambda stored_slots, slot_patches: []
    schedule_mod.build_horizon_start = lambda reference_time: reference_time
    schedule_mod.describe_schedule_control_config_issue = lambda config: None
    schedule_mod.format_slot_id = lambda slot: ""
    schedule_mod.parse_slot_id = datetime.fromisoformat
    schedule_mod.materialize_schedule_slots = lambda stored_slots, reference_time: []
    schedule_mod.normalize_schedule_document_for_registry = (
        lambda schedule_document, runtime_registry: schedule_document
    )
    schedule_mod.normalize_slot_patch_request = (
        lambda slot_patch, reference_time: slot_patch
    )
    schedule_mod.prune_expired_slots = (
        lambda stored_slots, reference_time: stored_slots
    )
    schedule_mod.read_schedule_control_config = lambda config: None
    schedule_mod.schedule_document_from_dict = lambda raw_document: raw_document
    schedule_mod.schedule_document_to_dict = lambda doc: {}
    schedule_mod.slot_to_dict = lambda slot, runtime=None: {}
    schedule_mod.validate_slot_patch_request = (
        lambda slots, reference_time, battery_soc_bounds: None
    )
    sys.modules[schedule_mod.__name__] = schedule_mod

    runtime_status_mod = types.ModuleType(
        "custom_components.helman.scheduling.runtime_status"
    )
    runtime_status_mod.ScheduleExecutionStatus = type(
        "ScheduleExecutionStatus",
        (),
        {"active_slot_id": None, "active_slot_runtime": None},
    )
    runtime_status_mod.schedule_execution_status_to_dict = lambda status: {}
    sys.modules[runtime_status_mod.__name__] = runtime_status_mod

    action_resolution_mod = types.ModuleType(
        "custom_components.helman.scheduling.action_resolution"
    )
    action_resolution_mod.resolve_executed_schedule_action = (
        lambda action, current_soc: None
    )
    sys.modules[action_resolution_mod.__name__] = action_resolution_mod

    schedule_executor_mod = types.ModuleType(
        "custom_components.helman.scheduling.schedule_executor"
    )
    schedule_executor_mod.ScheduleExecutor = type(
        "ScheduleExecutor",
        (),
        {"__init__": lambda self, hass, deps: None},
    )
    schedule_executor_mod.ScheduleExecutorDependencies = type(
        "ScheduleExecutorDependencies",
        (),
        {"__init__": lambda self, **kwargs: None},
    )
    sys.modules[schedule_executor_mod.__name__] = schedule_executor_mod

    storage_mod = types.ModuleType("custom_components.helman.storage")
    storage_mod.HelmanStorage = type("HelmanStorage", (), {})
    sys.modules[storage_mod.__name__] = storage_mod

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    energy_pkg = sys.modules.get("homeassistant.components.energy")
    if energy_pkg is None:
        energy_pkg = types.ModuleType("homeassistant.components.energy")
        sys.modules["homeassistant.components.energy"] = energy_pkg

    energy_data_mod = sys.modules.get("homeassistant.components.energy.data")
    if energy_data_mod is None:
        energy_data_mod = types.ModuleType("homeassistant.components.energy.data")
        sys.modules["homeassistant.components.energy.data"] = energy_data_mod

    async def async_get_manager(hass):
        return SimpleNamespace(async_listen_updates=lambda callback: lambda: None)

    energy_data_mod.async_get_manager = async_get_manager

    helpers_pkg = sys.modules.get("homeassistant.helpers")
    if helpers_pkg is None:
        helpers_pkg = types.ModuleType("homeassistant.helpers")
        sys.modules["homeassistant.helpers"] = helpers_pkg

    event_mod = sys.modules.get("homeassistant.helpers.event")
    if event_mod is None:
        event_mod = types.ModuleType("homeassistant.helpers.event")
        sys.modules["homeassistant.helpers.event"] = event_mod
    event_mod.async_track_time_change = (
        lambda hass, callback, **kwargs: lambda: None
    )
    event_mod.async_track_time_interval = (
        lambda hass, callback, interval: lambda: None
    )

    entity_registry_mod = sys.modules.get("homeassistant.helpers.entity_registry")
    if entity_registry_mod is None:
        entity_registry_mod = types.ModuleType("homeassistant.helpers.entity_registry")
        sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.now = lambda: REFERENCE_TIME
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod
    return previous_modules


def _restore_modules(previous_modules: dict[str, types.ModuleType | None]) -> None:
    for module_name, previous_module in previous_modules.items():
        if previous_module is None:
            sys.modules.pop(module_name, None)
            continue
        sys.modules[module_name] = previous_module


_previous_modules = _install_import_stubs()
try:
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
finally:
    _restore_modules(_previous_modules)
    sys.modules.pop("custom_components.helman.coordinator", None)


class CoordinatorGridForecastTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_forecast_derives_top_level_grid_from_battery_forecast(self):
        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._storage = SimpleNamespace(config={})
        coordinator._active_config = {}
        coordinator._cached_forecast = {"status": "available"}
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )
        coordinator._has_compatible_forecast_snapshot = Mock(return_value=True)

        adjusted_house_forecast = {"status": "available", "generatedAt": "2026-03-20T21:16:00+01:00"}
        canonical_battery_forecast = {
            "status": "available",
            "startedAt": "2026-03-20T21:16:00+01:00",
            "sourceGranularityMinutes": 15,
            "series": [
                {
                    "timestamp": "2026-03-20T21:16:00+01:00",
                    "durationHours": 14 / 60,
                    "importedFromGridKwh": 0.1,
                    "exportedToGridKwh": 0.0,
                }
            ],
        }
        coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                adjusted_house_forecast=adjusted_house_forecast,
                battery_forecast=canonical_battery_forecast,
            )
        )

        builder_instance = SimpleNamespace(
            build=AsyncMock(
                return_value={
                    "solar": {"status": "available"},
                    "grid": {
                        "export": {"status": "available", "currentPrice": 2.5},
                        "import": {"status": "available", "currentPrice": 7.0},
                    },
                }
            )
        )
        canonical_solar = {"canonical": "solar"}
        solar_response = {"kind": "solar"}
        house_response = {"kind": "house"}
        battery_response = {"kind": "battery"}
        canonical_grid_response = {"canonical": "grid"}
        grid_flow_response = {
            "kind": "grid-flow",
            "unit": "kWh",
            "series": [],
        }
        grid_price_response = {
            "exportPriceUnit": "CZK/kWh",
            "currentExportPrice": 2.5,
            "exportPricePoints": [
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "value": 100.0,
                }
            ],
            "importPriceUnit": "CZK/kWh",
            "currentImportPrice": 7.0,
            "importPricePoints": [
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "value": 200.0,
                }
            ],
        }

        with (
            patch.object(
                coordinator_module,
                "HelmanForecastBuilder",
                return_value=builder_instance,
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                side_effect=[canonical_solar, solar_response],
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value=grid_price_response,
            ) as build_grid_price_response,
            patch.object(
                coordinator_module,
                "build_house_forecast_response",
                return_value=house_response,
            ),
            patch.object(
                coordinator_module,
                "build_battery_forecast_response",
                return_value=battery_response,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_snapshot",
                return_value=canonical_grid_response,
            ) as build_grid_snapshot,
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_response",
                return_value=grid_flow_response,
            ) as build_grid_response,
        ):
            result = await coordinator.get_forecast(granularity=60, forecast_days=1)

        build_grid_price_response.assert_called_once_with(
            {
                "export": {"status": "available", "currentPrice": 2.5},
                "import": {"status": "available", "currentPrice": 7.0},
            },
            granularity=60,
            forecast_days=1,
        )
        build_grid_snapshot.assert_called_once_with(canonical_battery_forecast)
        build_grid_response.assert_called_once_with(
            canonical_grid_response,
            granularity=60,
            forecast_days=1,
        )
        coordinator._async_get_appliance_forecast_pipeline.assert_awaited_once_with(
            solar_forecast=canonical_solar,
            house_forecast=coordinator._cached_forecast,
            started_at=REFERENCE_TIME,
        )
        self.assertEqual(result["solar"], solar_response)
        self.assertEqual(result["house_consumption"], house_response)
        self.assertEqual(result["battery_capacity"], battery_response)
        self.assertEqual(result["grid"]["kind"], "grid-flow")
        self.assertEqual(result["grid"]["unit"], "kWh")
        self.assertEqual(result["grid"]["currentExportPrice"], 2.5)
        self.assertEqual(result["grid"]["exportPriceUnit"], "CZK/kWh")
        self.assertEqual(
            result["grid"]["exportPricePoints"],
            grid_price_response["exportPricePoints"],
        )
        self.assertEqual(result["grid"]["currentImportPrice"], 7.0)
        self.assertEqual(result["grid"]["importPriceUnit"], "CZK/kWh")
        self.assertEqual(
            result["grid"]["importPricePoints"],
            grid_price_response["importPricePoints"],
        )
        self.assertNotIn("currentPrice", result["grid"])


if __name__ == "__main__":
    unittest.main()
