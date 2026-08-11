from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

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
    "homeassistant.components.recorder",
    "homeassistant.components.recorder.history",
    "homeassistant.core",
    "homeassistant.helpers",
    "homeassistant.helpers.debounce",
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
    battery_state_mod.read_battery_forecast_settings = lambda config: types.SimpleNamespace(
        charge_efficiency=0.95,
        discharge_efficiency=0.95,
        max_charge_power_w=None,
        max_discharge_power_w=None,
    )
    sys.modules[battery_state_mod.__name__] = battery_state_mod

    recorder_slots_mod = types.ModuleType("custom_components.helman.recorder_hourly_series")
    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    recorder_slots_mod.get_today_completed_local_slots = lambda *args, **kwargs: []

    async def _query_cumulative_hourly_energy_changes(*args, **kwargs):
        return {}

    recorder_slots_mod.query_cumulative_hourly_energy_changes = (
        _query_cumulative_hourly_energy_changes
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

    async def _query_active_hours_by_local_date(*args, **kwargs):
        return {}

    recorder_slots_mod.query_active_hours_by_local_date = (
        _query_active_hours_by_local_date
    )

    class _TodaySlotEnergyReader:
        def __init__(self, hass):
            self.hass = hass

        async def async_query_slot_energy_changes(self, *args, **kwargs):
            return {}

    recorder_slots_mod.TodaySlotEnergyReader = _TodaySlotEnergyReader
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    schedule_mod = types.ModuleType("custom_components.helman.scheduling.schedule")
    schedule_mod.ScheduleControlConfig = type("ScheduleControlConfig", (), {})
    schedule_mod.strip_candidate_actions = lambda doc: doc
    schedule_mod.ScheduleAction = type("ScheduleAction", (), {})
    schedule_mod.ScheduleDocument = type(
        "ScheduleDocument",
        (),
        {"__init__": lambda self, execution_enabled=False, slots=None: None},
    )
    schedule_mod.ScheduleError = type("ScheduleError", (Exception,), {})
    schedule_mod.ScheduleResponseDict = dict
    schedule_mod.ScheduleSlot = dict
    schedule_mod.SCHEDULE_SLOT_DURATION = timedelta(minutes=30)
    schedule_mod.appliance_actions = lambda actions: {
        controllable_id: action
        for controllable_id, action in actions.items()
        if controllable_id != "inverter"
    }
    schedule_mod.inverter_action = lambda actions: actions.get("inverter")
    schedule_mod.apply_slot_patches = lambda stored_slots, slot_patches: []
    schedule_mod.build_horizon_start = lambda reference_time: reference_time
    schedule_mod.build_horizon_end = lambda reference_time: reference_time
    schedule_mod.describe_schedule_control_config_issue = lambda config: None
    schedule_mod.format_slot_id = lambda slot: ""
    schedule_mod.is_default_domains = lambda domains: False
    schedule_mod.iter_horizon_slot_ids = lambda reference_time: []
    schedule_mod.parse_slot_id = datetime.fromisoformat
    schedule_mod.materialize_schedule_slots = lambda stored_slots, reference_time: []
    schedule_mod.normalize_schedule_document_for_registry = (
        lambda schedule_document, appliances_registry: schedule_document
    )
    schedule_mod.normalize_slot_patch_request = (
        lambda slot_patch, reference_time, battery_soc_bounds, appliances_registry: (
            slot_patch
        )
    )
    schedule_mod.prune_expired_slots = (
        lambda stored_slots, reference_time: stored_slots
    )
    schedule_mod.read_schedule_control_config = lambda config: None
    schedule_mod.schedule_document_from_dict = (
        lambda raw_document: (
            raw_document
            if raw_document is not None
            else schedule_mod.ScheduleDocument()
        )
    )
    schedule_mod.schedule_document_to_dict = lambda doc: {}
    schedule_mod.slot_to_dict = lambda slot, runtime=None: {}
    schedule_mod.with_slot_set_by = lambda slot, set_by=None: slot
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
    storage_mod.TrainingArtifactsStore = type("TrainingArtifactsStore", (), {})
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
    components_pkg.__path__ = []  # mark as package so sub-imports work

    # ``scheduling.actual_history`` reads what really happened from the
    # recorder; the coordinator imports it at module level.
    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    recorder_mod.get_instance = lambda hass: None
    recorder_mod.__path__ = []

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}

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

    debounce_mod = sys.modules.get("homeassistant.helpers.debounce")
    if debounce_mod is None:
        debounce_mod = types.ModuleType("homeassistant.helpers.debounce")
        sys.modules["homeassistant.helpers.debounce"] = debounce_mod

    class Debouncer:
        def __init__(self, hass, logger, *, cooldown, immediate, function):
            self.function = function

        async def async_call(self):
            await self.function()

    debounce_mod.Debouncer = Debouncer

    storage_helper_mod = sys.modules.get("homeassistant.helpers.storage")
    if storage_helper_mod is None:
        storage_helper_mod = types.ModuleType("homeassistant.helpers.storage")
        sys.modules["homeassistant.helpers.storage"] = storage_helper_mod

    class _Store:
        def __init__(self, *args, **kwargs) -> None:
            self._data = None

        async def async_load(self):
            return self._data

        async def async_save(self, data) -> None:
            self._data = data

    storage_helper_mod.Store = _Store
    helpers_pkg.storage = storage_helper_mod

    event_mod = sys.modules.get("homeassistant.helpers.event")
    if event_mod is None:
        event_mod = types.ModuleType("homeassistant.helpers.event")
        sys.modules["homeassistant.helpers.event"] = event_mod
    event_mod.async_track_state_change_event = (
        lambda hass, entity_ids, callback: lambda: None
    )
    event_mod.async_track_time_change = (
        lambda hass, callback, **kwargs: lambda: None
    )
    event_mod.async_track_time_interval = (
        lambda hass, callback, interval: lambda: None
    )

    # Mirrors the real helper: fires at once when HA is already running, which
    # is the state a test's fake hass is always in.
    start_mod = sys.modules.get("homeassistant.helpers.start")
    if start_mod is None:
        start_mod = types.ModuleType("homeassistant.helpers.start")
        sys.modules["homeassistant.helpers.start"] = start_mod

    def _async_at_started(hass, at_start_cb):
        at_start_cb(hass)
        return lambda: None

    start_mod.async_at_started = _async_at_started
    helpers_pkg.start = start_mod

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


_original_helman_modules = {
    module_name
    for module_name in sys.modules
    if module_name == "custom_components.helman"
    or module_name.startswith("custom_components.helman.")
}
_previous_modules = _install_import_stubs()
try:
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
    input_bundle_module = importlib.import_module(
        "custom_components.helman.automation.input_bundle"
    )
    config_module = importlib.import_module("custom_components.helman.appliances.config")
    automation_config_module = importlib.import_module(
        "custom_components.helman.automation.config"
    )
finally:
    _restore_modules(_previous_modules)
    for module_name in list(sys.modules):
        if (
            module_name not in _original_helman_modules
            and (
                module_name == "custom_components.helman"
                or module_name.startswith("custom_components.helman.")
            )
        ):
            sys.modules.pop(module_name, None)

HelmanCoordinator = coordinator_module.HelmanCoordinator
OptimizerInstanceConfig = automation_config_module.OptimizerInstanceConfig
AutomationInputBundle = input_bundle_module.AutomationInputBundle
build_appliances_runtime_registry = config_module.build_appliances_runtime_registry


def _make_house_forecast() -> dict:
    return {
        "status": "available",
        "generatedAt": "2026-03-20T21:16:00+01:00",
        "currentSlot": {
            "timestamp": "2026-03-20T21:15:00+01:00",
            "nonDeferrable": {"value": 0.5},
        },
        "series": [],
    }


def _make_raw_forecast_result() -> dict:
    return {
        "solar": {
            "status": "available",
            "points": [{"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.4}],
        },
        "grid": {
            "export": {"status": "available", "unit": "CZK/kWh"},
            "import": {"status": "available", "unit": "CZK/kWh"},
        },
    }


class AutomationInputBundleTests(unittest.IsolatedAsyncioTestCase):
    def test_dataclass_stores_expected_fields(self) -> None:
        bundle = AutomationInputBundle(
            original_house_forecast={"status": "available"},
            solar_forecast={"points": []},
            grid_price_forecast={"importPricePoints": []},
            when_active_hourly_energy_kwh_by_appliance_id={"pool": 1.2},
        )

        self.assertEqual(bundle.original_house_forecast["status"], "available")
        self.assertEqual(bundle.solar_forecast["points"], [])
        self.assertEqual(bundle.grid_price_forecast["importPricePoints"], [])
        self.assertEqual(
            bundle.when_active_hourly_energy_kwh_by_appliance_id,
            {"pool": 1.2},
        )

    async def test_refresh_builds_bundle_from_canonical_inputs(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        coordinator._appliances_registry = build_appliances_runtime_registry(
            {"controllables": []}
        )
        coordinator._automation_input_bundle = None
        house_forecast = _make_house_forecast()
        canonical_solar = {
            "points": [{"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.1}],
            "correctedPoints": [
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.08}
            ],
        }
        corrected_solar = {
            "points": [
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.08}
            ],
            "correctedPoints": [
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.08}
            ],
            "adjustedPoints": [
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.08}
            ],
        }
        canonical_grid_price = {
            "importPricePoints": [
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 1.0}
            ]
        }

        with (
            patch.object(
                coordinator,
                "_resolve_when_active_hourly_energy_kwh_by_appliance_id",
                MagicMock(return_value={"pool-pump": 0.8}),
            ),
            patch.object(
                coordinator,
                "_async_get_canonical_solar_forecast",
                AsyncMock(return_value=canonical_solar),
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value=canonical_solar,
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value=canonical_grid_price,
            ),
        ):
            await coordinator._async_refresh_automation_input_bundle(
                reference_time=REFERENCE_TIME,
                house_forecast=house_forecast,
                raw_forecast=_make_raw_forecast_result(),
            )

        self.assertEqual(
            coordinator._automation_input_bundle,
            AutomationInputBundle(
                original_house_forecast=house_forecast,
                solar_forecast=corrected_solar,
                grid_price_forecast=canonical_grid_price,
                when_active_hourly_energy_kwh_by_appliance_id={"pool-pump": 0.8},
            ),
        )
        self.assertIsNot(
            coordinator._automation_input_bundle.original_house_forecast,
            house_forecast,
        )

    async def test_resolved_map_includes_unscheduled_generic_and_climate_candidates(
        self,
    ) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._appliances_registry = build_appliances_runtime_registry(
            {
                "controllables": [
                    {
                        "kind": "generic",
                        "id": "dishwasher",
                        "name": "Dishwasher",
                        "controls": {"switch": {"entity_id": "switch.dishwasher"}},
                        "consumption": {
                            "projection": {
                                "strategy": "fixed",
                                "hourly_energy_kwh": 1.2,
                            },
                        },
                    },
                    {
                        "kind": "climate",
                        "id": "living-room-hvac",
                        "name": "Living Room HVAC",
                        "controls": {
                            "climate": {"entity_id": "climate.living_room"}
                        },
                        "consumption": {
                            "energy_entity_id": (
                                "sensor.living_room_hvac_energy_total"
                            ),
                            "projection": {
                                "strategy": "history_average",
                                "hourly_energy_kwh": 1.5,
                                "lookback_days": 30,
                            },
                        },
                    },
                    {
                        "kind": "ev_charger",
                        "id": "garage-ev",
                        "name": "Garage EV",
                        "limits": {"max_charging_power_kw": 11.0},
                        "controls": {
                            "charge": {"entity_id": "switch.ev_nabijeni"},
                            "use_mode": {
                                "entity_id": (
                                    "select.solax_ev_charger_charger_use_mode"
                                ),
                                "values": {
                                    "Fast": {"behavior": "fixed_max_power"},
                                    "ECO": {"behavior": "surplus_aware"},
                                },
                            },
                            "eco_gear": {
                                "entity_id": "select.solax_ev_charger_eco_gear",
                                "values": {"6A": {"min_power_kw": 1.4}},
                            },
                        },
                        "vehicles": [
                            {
                                "id": "kona",
                                "name": "Kona",
                                "telemetry": {
                                    "soc_entity_id": "sensor.kona_ev_battery_level"
                                },
                                "limits": {
                                    "battery_capacity_kwh": 64.0,
                                    "max_charging_power_kw": 11.0,
                                },
                            }
                        ],
                    },
                ]
            }
        )
        coordinator._appliance_energy_estimates = {"living-room-hvac": 0.9}

        resolved = (
            coordinator._resolve_when_active_hourly_energy_kwh_by_appliance_id()
        )

        self.assertEqual(
            resolved,
            {
                "dishwasher": 1.2,
                "living-room-hvac": 0.9,
            },
        )

    async def test_history_average_resolution_preserves_fixed_history_and_fallback_values(
        self,
    ) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._appliances_registry = build_appliances_runtime_registry(
            {
                "controllables": [
                    {
                        "kind": "generic",
                        "id": "dishwasher",
                        "name": "Dishwasher",
                        "controls": {"switch": {"entity_id": "switch.dishwasher"}},
                        "consumption": {
                            "energy_entity_id": "sensor.dishwasher_energy_total",
                            "projection": {
                                "strategy": "history_average",
                                "hourly_energy_kwh": 1.2,
                                "lookback_days": 30,
                            },
                        },
                    },
                    {
                        "kind": "climate",
                        "id": "living-room-hvac",
                        "name": "Living Room HVAC",
                        "controls": {
                            "climate": {"entity_id": "climate.living_room"}
                        },
                        "consumption": {
                            "energy_entity_id": (
                                "sensor.living_room_hvac_energy_total"
                            ),
                            "projection": {
                                "strategy": "history_average",
                                "hourly_energy_kwh": 1.5,
                                "lookback_days": 30,
                            },
                        },
                    },
                    {
                        "kind": "generic",
                        "id": "pool-pump",
                        "name": "Pool Pump",
                        "controls": {"switch": {"entity_id": "switch.pool_pump"}},
                        "consumption": {
                            "projection": {
                                "strategy": "fixed",
                                "hourly_energy_kwh": 0.7,
                            },
                        },
                    },
                ]
            }
        )
        # living-room-hvac is absent from the stored estimates, which is what a
        # history window that never answered leaves behind.
        coordinator._appliance_energy_estimates = {"dishwasher": 0.8}

        resolved = (
            coordinator._resolve_when_active_hourly_energy_kwh_by_appliance_id()
        )

        self.assertEqual(
            resolved,
            {
                "dishwasher": 0.8,
                "living-room-hvac": 1.5,
                "pool-pump": 0.7,
            },
        )

    async def test_failed_bundle_refresh_keeps_previous_bundle(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        previous_bundle = AutomationInputBundle(
            original_house_forecast={"status": "available"},
            solar_forecast={"points": []},
            grid_price_forecast={"importPricePoints": []},
            when_active_hourly_energy_kwh_by_appliance_id={"dishwasher": 1.2},
        )
        coordinator._automation_input_bundle = previous_bundle

        with (
            patch.object(
                coordinator,
                "_resolve_when_active_hourly_energy_kwh_by_appliance_id",
                MagicMock(side_effect=RuntimeError()),
            ),
            patch.object(coordinator_module._LOGGER, "exception"),
        ):
            refreshed = await coordinator._async_refresh_automation_input_bundle(
                reference_time=REFERENCE_TIME,
                house_forecast=_make_house_forecast(),
                raw_forecast=_make_raw_forecast_result(),
            )

        self.assertFalse(refreshed)
        self.assertIs(coordinator._automation_input_bundle, previous_bundle)

    async def test_refresh_forecast_updates_bundle_after_house_refresh(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        coordinator._storage = SimpleNamespace(async_save_snapshots=AsyncMock())
        coordinator._invalidate_battery_forecast_cache = Mock()
        coordinator._async_refresh_automation_input_bundle = AsyncMock(return_value=True)
        coordinator._cached_forecast = None
        coordinator._house_profile = None
        coordinator._house_profile_trained_at = None
        coordinator._house_profile_last_outcome = "no_training_yet"
        coordinator._cached_solar_forecast = None
        coordinator._solar_forecast_sensors = []
        coordinator._slot_history = None

        snapshot = _make_house_forecast()
        solar_snapshot = {
            "status": "available",
            "resolution": "15m",
            "horizonHours": 336,
            "generatedAt": REFERENCE_TIME.isoformat(),
            "points": [],
            "rawPoints": [],
        }
        builder_instance = SimpleNamespace(build=AsyncMock(return_value=snapshot))
        coordinator._build_canonical_solar_forecast = Mock(return_value=solar_snapshot)
        raw_forecast = _make_raw_forecast_result()
        with (
            patch.object(
                coordinator_module,
                "ConsumptionForecastBuilder",
                return_value=builder_instance,
            ),
            patch.object(
                coordinator_module,
                "HelmanForecastBuilder",
                return_value=SimpleNamespace(
                    build=AsyncMock(return_value=raw_forecast)
                ),
            ),
        ):
            refresh_result = await coordinator._async_build_forecast_snapshots(
                reference_time=REFERENCE_TIME
            )

        self.assertEqual(coordinator._cached_forecast, snapshot)
        self.assertEqual(
            refresh_result,
            coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=True,
            ),
        )
        coordinator._invalidate_battery_forecast_cache.assert_called_once_with()
        coordinator._storage.async_save_snapshots.assert_awaited_once_with(
            house_snapshot=snapshot,
            solar_snapshot=solar_snapshot,
        )
        coordinator._async_refresh_automation_input_bundle.assert_awaited_once_with(
            reference_time=REFERENCE_TIME,
            house_forecast=snapshot,
            raw_forecast=raw_forecast,
        )


class RuntimeHistoryRequirementsTests(unittest.TestCase):
    """Which appliances the recorder is queried for, and how far back.

    The daily minimum and the consecutive-skip guard both run on what the
    appliance *actually* did, and both read it out of the map this decides. An
    empty map is not an error anywhere downstream: ``delivered_hours`` falls
    back to 0.0, so the day looks untouched however long the appliance ran, and
    every past day looks idle to the skip guard. Nothing raises, nothing warns,
    and the plan is quietly wrong -- which is why this needs pinning at the
    seam rather than only in the optimizers, whose tests hand the map in ready
    made.
    """

    @staticmethod
    def _coordinator():
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._active_config = {}
        return coordinator

    def test_the_appliance_is_read_from_target_not_params(self) -> None:
        # `target` is identity -- a condition group may never override it --
        # and every other reader takes the appliance from there.
        coordinator = self._coordinator()
        config = SimpleNamespace(
            enabled=True,
            execution_optimizers=[
                # The real config object, not a stand-in: the coordinator reads
                # the target through `controllable_id`, and a namespace that
                # answered `target` alone would pass while the property it
                # actually calls went untested.
                OptimizerInstanceConfig(
                    id="pool",
                    kind="appliance_runtime",
                    target={"controllable_id": "pool-filtration"},
                    params={"skip": {"max_consecutive_skips": 2}},
                ),
            ],
        )

        with patch.object(
            coordinator_module, "read_automation_config", return_value=config
        ):
            requirements = coordinator._resolve_runtime_history_requirements()

        # The skip window plus today, and the appliance that needs the history.
        self.assertEqual(requirements, (3, {"pool-filtration"}))

    def test_optimizers_of_other_kinds_need_no_history(self) -> None:
        coordinator = self._coordinator()
        config = SimpleNamespace(
            enabled=True,
            execution_optimizers=[
                OptimizerInstanceConfig(id="hold", kind="charge_hold"),
            ],
        )

        with patch.object(
            coordinator_module, "read_automation_config", return_value=config
        ):
            self.assertIsNone(coordinator._resolve_runtime_history_requirements())


class ApplianceEnergyAdoptionTests(unittest.TestCase):
    """Adopting the nightly estimates, and what the two readers do with them."""

    def _make_coordinator(self, *, section, appliances=None):
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._training_artifacts_store = SimpleNamespace(
            appliance_energy=section
        )
        coordinator._appliances_registry = build_appliances_runtime_registry(
            {"controllables": appliances if appliances is not None else [
                {
                    "kind": "generic",
                    "id": "dishwasher",
                    "name": "Dishwasher",
                    "controls": {"switch": {"entity_id": "switch.dishwasher"}},
                    "consumption": {
                        "energy_entity_id": "sensor.dishwasher_energy",
                        "projection": {
                            "strategy": "history_average",
                            "hourly_energy_kwh": 1.2,
                            "lookback_days": 30,
                        },
                    },
                },
            ]}
        )
        return coordinator

    def _fingerprint_for(self, coordinator):
        return coordinator._read_appliance_energy_training_request().fingerprint

    def test_matching_fingerprint_adopts_without_scheduling_a_refit(self) -> None:
        coordinator = self._make_coordinator(section=None)
        section = {
            "data": {"dishwasher": 0.83},
            "fingerprint": self._fingerprint_for(coordinator),
        }
        coordinator._training_artifacts_store = SimpleNamespace(
            appliance_energy=section
        )

        reason = coordinator._adopt_stored_appliance_energy()

        self.assertIsNone(reason)
        self.assertEqual(coordinator._appliance_energy_estimates, {"dishwasher": 0.83})

    def test_no_stored_section_asks_for_a_refit(self) -> None:
        coordinator = self._make_coordinator(section=None)

        reason = coordinator._adopt_stored_appliance_energy()

        self.assertEqual(reason, "no_stored_estimates")
        self.assertEqual(coordinator._appliance_energy_estimates, {})

    def test_stale_fingerprint_refits_but_keeps_serving_the_old_estimates(self) -> None:
        """Unlike the house profile, a stale fingerprint does not blank the map.

        The entries are per appliance, so the ones that did not change are still
        right; dropping them would push those appliances onto their fixed
        fallback for no reason until the refit lands.
        """
        coordinator = self._make_coordinator(
            section={"data": {"dishwasher": 0.83}, "fingerprint": "stale"}
        )

        reason = coordinator._adopt_stored_appliance_energy()

        self.assertEqual(reason, "config_changed")
        self.assertEqual(coordinator._appliance_energy_estimates, {"dishwasher": 0.83})

    def test_junk_values_in_the_stored_map_are_discarded(self) -> None:
        coordinator = self._make_coordinator(
            section={
                "data": {
                    "dishwasher": 0.83,
                    "negative": -1.0,
                    "zero": 0,
                    "text": "0.9",
                    "boolean": True,
                },
                "fingerprint": "stale",
            }
        )

        coordinator._adopt_stored_appliance_energy()

        self.assertEqual(coordinator._appliance_energy_estimates, {"dishwasher": 0.83})

    def test_only_history_average_appliances_are_trained(self) -> None:
        coordinator = self._make_coordinator(
            section=None,
            appliances=[
                {
                    "kind": "generic",
                    "id": "pool-pump",
                    "name": "Pool Pump",
                    "controls": {"switch": {"entity_id": "switch.pool_pump"}},
                    "consumption": {
                        "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.7},
                    },
                },
            ],
        )

        request = coordinator._read_appliance_energy_training_request()

        self.assertEqual(request.appliances, ())

    def test_projection_reader_returns_stored_values_and_none_for_the_rest(
        self,
    ) -> None:
        """``None`` is what the projection already reads as "use the fixed
        figure", so an untrained appliance degrades rather than disappearing."""
        coordinator = self._make_coordinator(section=None)
        coordinator._appliance_energy_estimates = {"dishwasher": 0.83}
        appliances = list(coordinator._appliances_registry.appliances)
        untrained = SimpleNamespace(id="never-trained")
        coordinator._iter_projected_history_appliances = (
            lambda **_kwargs: [*appliances, untrained]
        )

        resolved = coordinator._build_history_projection_hourly_energy_by_appliance_id(
            schedule_document=object()
        )

        self.assertEqual(resolved, {"dishwasher": 0.83, "never-trained": None})


if __name__ == "__main__":
    unittest.main()
