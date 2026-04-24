from __future__ import annotations

import importlib
import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")


_BASIC_STUBBED_MODULES = (
    "custom_components",
    "custom_components.helman",
    "homeassistant",
    "homeassistant.util",
    "homeassistant.util.dt",
)

_COORDINATOR_STUBBED_MODULES = (
    *_BASIC_STUBBED_MODULES,
    "custom_components.helman.appliances",
    "custom_components.helman.appliances.climate_appliance",
    "custom_components.helman.appliances.generic_appliance",
    "custom_components.helman.automation.config",
    "custom_components.helman.automation.input_bundle",
    "custom_components.helman.automation.ownership",
    "custom_components.helman.automation.snapshot",
    "custom_components.helman.automation.triggers",
    "custom_components.helman.battery_capacity_forecast_builder",
    "custom_components.helman.battery_forecast_response",
    "custom_components.helman.battery_state",
    "custom_components.helman.consumption_forecast_builder",
    "custom_components.helman.forecast_builder",
    "custom_components.helman.grid_flow_forecast_builder",
    "custom_components.helman.grid_flow_forecast_response",
    "custom_components.helman.grid_price_forecast_response",
    "custom_components.helman.house_forecast_response",
    "custom_components.helman.recorder_hourly_series",
    "custom_components.helman.scheduling",
    "custom_components.helman.scheduling.action_resolution",
    "custom_components.helman.scheduling.runtime_status",
    "custom_components.helman.scheduling.schedule",
    "custom_components.helman.scheduling.schedule_executor",
    "custom_components.helman.storage",
    "custom_components.helman.tree_builder",
    "homeassistant.components",
    "homeassistant.components.energy",
    "homeassistant.components.energy.data",
    "homeassistant.core",
    "homeassistant.helpers",
    "homeassistant.helpers.entity_registry",
    "homeassistant.helpers.event",
)


_defused_modules: set[str] = set()


def _install_basic_import_stubs() -> None:
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



def _install_coordinator_import_stubs() -> dict[str, types.ModuleType | None]:
    previous_modules = {
        module_name: sys.modules.get(module_name)
        for module_name in _COORDINATOR_STUBBED_MODULES
    }
    _install_basic_import_stubs()

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [str(ROOT / "custom_components" / "helman" / "scheduling")]

    appliances_mod = types.ModuleType("custom_components.helman.appliances")
    appliances_mod.ApplianceProjectionPlan = type("ApplianceProjectionPlan", (), {})
    appliances_mod.ApplianceMetadataResponseDict = dict
    appliances_mod.ApplianceProjectionsResponseDict = dict
    appliances_mod.AppliancesRuntimeRegistry = type(
        "AppliancesRuntimeRegistry",
        (),
        {"__init__": lambda self, *args, **kwargs: None},
    )
    appliances_mod.build_adjusted_house_forecast = lambda *args, **kwargs: {}
    appliances_mod.build_appliance_projection_plan = lambda *args, **kwargs: {}
    appliances_mod.build_appliance_projections_response = lambda *args, **kwargs: {}
    appliances_mod.build_appliances_response = lambda *args, **kwargs: {}
    appliances_mod.build_appliances_runtime_registry = lambda *args, **kwargs: SimpleNamespace()
    appliances_mod.build_projection_input_bundle = lambda *args, **kwargs: {}
    appliances_mod.build_empty_appliance_projections_response = (
        lambda *args, **kwargs: {}
    )
    sys.modules[appliances_mod.__name__] = appliances_mod

    climate_mod = types.ModuleType(
        "custom_components.helman.appliances.climate_appliance"
    )
    climate_mod.ClimateApplianceRuntime = type("ClimateApplianceRuntime", (), {})
    climate_mod.resolve_supported_climate_modes = lambda *args, **kwargs: []
    sys.modules[climate_mod.__name__] = climate_mod

    generic_mod = types.ModuleType(
        "custom_components.helman.appliances.generic_appliance"
    )
    generic_mod.GenericApplianceRuntime = type("GenericApplianceRuntime", (), {})
    sys.modules[generic_mod.__name__] = generic_mod

    automation_config_mod = types.ModuleType(
        "custom_components.helman.automation.config"
    )
    automation_config_mod.AutomationConfig = type("AutomationConfig", (), {})
    automation_config_mod.read_automation_config = lambda config: None
    sys.modules[automation_config_mod.__name__] = automation_config_mod

    automation_input_mod = types.ModuleType(
        "custom_components.helman.automation.input_bundle"
    )
    automation_input_mod.AutomationInputBundle = type(
        "AutomationInputBundle",
        (),
        {"__init__": lambda self, **kwargs: None},
    )
    sys.modules[automation_input_mod.__name__] = automation_input_mod

    automation_ownership_mod = types.ModuleType(
        "custom_components.helman.automation.ownership"
    )
    automation_ownership_mod.has_automation_owned_actions = (
        lambda *args, **kwargs: False
    )
    automation_ownership_mod.merge_automation_result = (
        lambda *args, **kwargs: kwargs.get("result")
    )
    automation_ownership_mod.strip_automation_owned_actions = (
        lambda *args, **kwargs: kwargs.get("schedule")
    )
    sys.modules[automation_ownership_mod.__name__] = automation_ownership_mod

    automation_snapshot_mod = types.ModuleType(
        "custom_components.helman.automation.snapshot"
    )
    automation_snapshot_mod.OptimizationContext = type("OptimizationContext", (), {})
    automation_snapshot_mod.OptimizationSnapshot = type("OptimizationSnapshot", (), {})
    sys.modules[automation_snapshot_mod.__name__] = automation_snapshot_mod

    automation_triggers_mod = types.ModuleType(
        "custom_components.helman.automation.triggers"
    )
    automation_triggers_mod.AutomationTriggerCoordinator = type(
        "AutomationTriggerCoordinator",
        (),
        {"__init__": lambda self, **kwargs: None},
    )
    sys.modules[automation_triggers_mod.__name__] = automation_triggers_mod

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

    battery_response_mod = types.ModuleType(
        "custom_components.helman.battery_forecast_response"
    )
    battery_response_mod.build_battery_forecast_response = (
        lambda *args, **kwargs: {}
    )
    sys.modules[battery_response_mod.__name__] = battery_response_mod

    house_response_mod = types.ModuleType(
        "custom_components.helman.house_forecast_response"
    )
    house_response_mod.build_house_forecast_response = lambda *args, **kwargs: {}
    sys.modules[house_response_mod.__name__] = house_response_mod

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

    async def _estimate_average_hourly_energy_when_switch_on(*args, **kwargs):
        return None

    async def _estimate_average_hourly_energy_when_climate_active(*args, **kwargs):
        return None

    recorder_slots_mod.estimate_average_hourly_energy_when_switch_on = (
        _estimate_average_hourly_energy_when_switch_on
    )
    recorder_slots_mod.estimate_average_hourly_energy_when_climate_active = (
        _estimate_average_hourly_energy_when_climate_active
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
    schedule_mod.with_slot_set_by = lambda slot, set_by=None: slot
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

    return previous_modules



def _restore_modules(previous_modules: dict[str, types.ModuleType | None]) -> None:
    for module_name, previous_module in previous_modules.items():
        if previous_module is None:
            sys.modules.pop(module_name, None)
            continue
        sys.modules[module_name] = previous_module


class SolarBiasResponseTests(unittest.TestCase):
    @staticmethod
    def _import_response_module():
        _install_basic_import_stubs()
        try:
            return importlib.import_module(
                "custom_components.helman.solar_bias_correction.response"
            )
        except ModuleNotFoundError as err:
            raise AssertionError(f"response module missing: {err}") from err

    @staticmethod
    def _import_models_module():
        _install_basic_import_stubs()
        return importlib.import_module(
            "custom_components.helman.solar_bias_correction.models"
        )

    def test_compose_response_keeps_raw_points_and_adds_adjusted_points(self) -> None:
        response_module = self._import_response_module()
        models = self._import_models_module()
        raw_snapshot = {
            "status": "available",
            "unit": "Wh",
            "remainingTodayEnergyEntityId": "sensor.remaining_today_energy",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 400.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 800.0},
            ],
            "actualHistory": [
                {"timestamp": "2026-03-20T20:00:00+01:00", "value": 200.0},
            ],
        }
        adjustment_result = models.SolarBiasAdjustmentResult(
            status="profile_trained",
            effective_variant="adjusted",
            adjusted_points=[
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 600.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 200.0},
            ],
            explainability=models.SolarBiasExplainability(
                fallback_reason=None,
                trained_at="2026-03-20T03:00:00+01:00",
                usable_days=5,
                dropped_days=1,
                omitted_slot_count=2,
                factor_min=0.5,
                factor_max=1.5,
                factor_median=1.0,
                error=None,
            ),
        )

        response = response_module.compose_solar_bias_response(
            raw_snapshot,
            adjustment_result,
            granularity=30,
            forecast_days=1,
        )

        self.assertEqual(
            response["points"],
            [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 200.0},
                {"timestamp": "2026-03-20T21:30:00+01:00", "value": 200.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 400.0},
                {"timestamp": "2026-03-20T22:30:00+01:00", "value": 400.0},
            ],
        )
        self.assertEqual(
            response["adjustedPoints"],
            [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 300.0},
                {"timestamp": "2026-03-20T21:30:00+01:00", "value": 300.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 100.0},
                {"timestamp": "2026-03-20T22:30:00+01:00", "value": 100.0},
            ],
        )
        self.assertEqual(
            response["biasCorrection"],
            {
                "status": "profile_trained",
                "effectiveVariant": "adjusted",
                "explainability": {
                    "fallbackReason": None,
                    "trainedAt": "2026-03-20T03:00:00+01:00",
                    "usableDays": 5,
                    "droppedDays": 1,
                    "omittedSlotCount": 2,
                    "factorSummary": {
                        "min": 0.5,
                        "max": 1.5,
                        "median": 1.0,
                    },
                },
            },
        )
    def test_compose_response_mirrors_raw_points_for_raw_variant_and_surfaces_fallback_reason(self) -> None:
        response_module = self._import_response_module()
        models = self._import_models_module()
        raw_snapshot = {
            "status": "available",
            "unit": "Wh",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 400.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 800.0},
            ],
            "actualHistory": [],
        }
        adjustment_result = models.SolarBiasAdjustmentResult(
            status="training_failed",
            effective_variant="raw",
            adjusted_points=deepcopy(raw_snapshot["points"]),
            explainability=models.SolarBiasExplainability(
                fallback_reason="profile_unavailable",
                trained_at="2026-03-20T03:00:00+01:00",
                usable_days=0,
                dropped_days=3,
                omitted_slot_count=0,
                factor_min=None,
                factor_max=None,
                factor_median=None,
                error="boom",
            ),
        )

        response = response_module.compose_solar_bias_response(
            raw_snapshot,
            adjustment_result,
            granularity=30,
            forecast_days=1,
        )

        self.assertEqual(response["adjustedPoints"], response["points"])
        self.assertEqual(response["biasCorrection"]["status"], "training_failed")
        self.assertEqual(response["biasCorrection"]["effectiveVariant"], "raw")
        self.assertEqual(
            response["biasCorrection"]["explainability"]["fallbackReason"],
            "profile_unavailable",
        )
        self.assertEqual(
            response["biasCorrection"]["explainability"]["error"],
            "boom",
        )


class CoordinatorSolarBiasResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_forecast_uses_composed_public_solar_response_when_bias_result_exists(self) -> None:
        previous_modules = _install_coordinator_import_stubs()
        try:
            sys.modules.pop("custom_components.helman.coordinator", None)
            coordinator_module = importlib.import_module(
                "custom_components.helman.coordinator"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._storage = SimpleNamespace(config={})
        coordinator._active_config = {}
        coordinator._cached_forecast = {"status": "available"}
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )
        coordinator._has_compatible_forecast_snapshot = Mock(return_value=True)

        adjusted_house_forecast = {
            "status": "available",
            "generatedAt": "2026-03-20T21:16:00+01:00",
        }
        canonical_battery_forecast = {
            "status": "available",
            "startedAt": "2026-03-20T21:16:00+01:00",
            "sourceGranularityMinutes": 15,
            "series": [],
        }
        coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                adjusted_house_forecast=adjusted_house_forecast,
                battery_forecast=canonical_battery_forecast,
            )
        )

        raw_solar_snapshot = {
            "status": "available",
            "unit": "Wh",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
            "actualHistory": [],
        }
        builder_instance = SimpleNamespace(
            build=AsyncMock(
                return_value={
                    "solar": raw_solar_snapshot,
                    "grid": {
                        "export": {"status": "available", "currentPrice": 2.5},
                        "import": {"status": "available", "currentPrice": 7.0},
                    },
                }
            )
        )
        canonical_solar = {
            "status": "available",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
        }
        bias_result = SimpleNamespace(
            status="profile_trained",
            effective_variant="adjusted",
            adjusted_points=[
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 20.0},
            ],
            explainability=SimpleNamespace(),
        )
        solar_response = {"kind": "solar-with-bias"}
        house_response = {"kind": "house"}
        battery_response = {"kind": "battery"}
        grid_flow_response = {"kind": "grid-flow"}
        grid_price_response = {
            "exportPriceUnit": "CZK/kWh",
            "currentExportPrice": 2.5,
            "exportPricePoints": [],
            "importPriceUnit": "CZK/kWh",
            "currentImportPrice": 7.0,
            "importPricePoints": [],
        }
        coordinator._solar_bias_service = SimpleNamespace(
            build_adjustment_result=Mock(return_value=bias_result)
        )

        with (
            patch.object(
                coordinator_module,
                "HelmanForecastBuilder",
                return_value=builder_instance,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value=canonical_solar,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "compose_solar_bias_response",
                return_value=solar_response,
                create=True,
            ) as compose_response,
            patch.object(
                coordinator_module,
                "build_house_forecast_response",
                return_value=house_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_battery_forecast_response",
                return_value=battery_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_snapshot",
                return_value={"canonical": "grid"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_response",
                return_value=grid_flow_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value=grid_price_response,
                create=True,
            ),
        ):
            result = await coordinator.get_forecast(granularity=60, forecast_days=1)

        compose_response.assert_called_once_with(
            raw_solar_snapshot,
            bias_result,
            granularity=60,
            forecast_days=1,
        )
        coordinator._async_get_appliance_forecast_pipeline.assert_awaited_once_with(
            solar_forecast={
                "status": "available",
                "points": [
                    {"timestamp": "2026-03-20T21:00:00+01:00", "value": 20.0},
                ],
            },
            house_forecast=coordinator._cached_forecast,
            started_at=REFERENCE_TIME,
        )
        self.assertEqual(result["solar"], solar_response)
        self.assertEqual(result["house_consumption"], house_response)
        self.assertEqual(result["battery_capacity"], battery_response)

    async def test_get_forecast_keeps_raw_public_solar_response_without_bias_service(self) -> None:
        previous_modules = _install_coordinator_import_stubs()
        try:
            sys.modules.pop("custom_components.helman.coordinator", None)
            coordinator_module = importlib.import_module(
                "custom_components.helman.coordinator"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._storage = SimpleNamespace(config={})
        coordinator._active_config = {}
        coordinator._cached_forecast = {"status": "available"}
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )
        coordinator._has_compatible_forecast_snapshot = Mock(return_value=True)
        coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                adjusted_house_forecast={"status": "available"},
                battery_forecast={"status": "available", "series": []},
            )
        )

        raw_solar_snapshot = {
            "status": "available",
            "unit": "Wh",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
            "actualHistory": [],
        }
        builder_instance = SimpleNamespace(
            build=AsyncMock(
                return_value={
                    "solar": raw_solar_snapshot,
                    "grid": {
                        "export": {"status": "available", "currentPrice": 2.5},
                        "import": {"status": "available", "currentPrice": 7.0},
                    },
                }
            )
        )
        canonical_solar = {
            "status": "available",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
        }
        solar_response = {"kind": "raw-solar"}

        with (
            patch.object(
                coordinator_module,
                "HelmanForecastBuilder",
                return_value=builder_instance,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                side_effect=[canonical_solar, solar_response],
                create=True,
            ),
            patch.object(
                coordinator_module,
                "compose_solar_bias_response",
                create=True,
            ) as compose_response,
            patch.object(
                coordinator_module,
                "build_house_forecast_response",
                return_value={"kind": "house"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_battery_forecast_response",
                return_value={"kind": "battery"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_snapshot",
                return_value={"canonical": "grid"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_response",
                return_value={"kind": "grid-flow"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value={
                    "exportPriceUnit": "CZK/kWh",
                    "currentExportPrice": 2.5,
                    "exportPricePoints": [],
                    "importPriceUnit": "CZK/kWh",
                    "currentImportPrice": 7.0,
                    "importPricePoints": [],
                },
                create=True,
            ),
        ):
            result = await coordinator.get_forecast(granularity=60, forecast_days=1)

        compose_response.assert_not_called()
        coordinator._async_get_appliance_forecast_pipeline.assert_awaited_once_with(
            solar_forecast=canonical_solar,
            house_forecast=coordinator._cached_forecast,
            started_at=REFERENCE_TIME,
        )
        self.assertEqual(result["solar"], solar_response)


if __name__ == "__main__":
    unittest.main()
