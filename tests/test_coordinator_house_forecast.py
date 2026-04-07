from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")


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

    tree_builder_mod = types.ModuleType("custom_components.helman.tree_builder")
    tree_builder_mod.HelmanTreeBuilder = type("HelmanTreeBuilder", (), {})
    sys.modules[tree_builder_mod.__name__] = tree_builder_mod

    battery_state_mod = types.ModuleType("custom_components.helman.battery_state")
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

    recorder_slots_mod.estimate_average_hourly_energy_when_switch_on = (
        _estimate_average_hourly_energy_when_switch_on
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
    schedule_mod.apply_slot_patches = lambda stored_slots, slot_patches: []
    schedule_mod.build_horizon_start = lambda reference_time: reference_time
    schedule_mod.format_slot_id = lambda slot: ""
    schedule_mod.materialize_schedule_slots = lambda stored_slots, reference_time: []
    schedule_mod.prune_expired_slots = (
        lambda stored_slots, reference_time: stored_slots
    )
    schedule_mod.read_schedule_control_config = lambda config: None
    schedule_mod.schedule_document_from_dict = lambda raw_document: raw_document
    schedule_mod.schedule_document_to_dict = lambda doc: {}
    schedule_mod.slot_to_dict = lambda slot, runtime=None: {}
    schedule_mod.slot_from_dict = lambda raw_slot: raw_slot
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
    sys.modules[runtime_status_mod.__name__] = runtime_status_mod

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
        return types.SimpleNamespace(async_listen_updates=lambda callback: lambda: None)

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
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.const import (  # noqa: E402
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
)
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402


def _cleanup_stubbed_modules() -> None:
    for module_name in (
        "custom_components.helman.coordinator",
        "custom_components.helman.battery_capacity_forecast_builder",
        "custom_components.helman.consumption_forecast_builder",
        "custom_components.helman.forecast_builder",
        "custom_components.helman.tree_builder",
        "custom_components.helman.battery_state",
        "custom_components.helman.recorder_hourly_series",
        "custom_components.helman.scheduling.schedule",
        "custom_components.helman.scheduling.runtime_status",
        "custom_components.helman.scheduling.schedule_executor",
        "custom_components.helman.storage",
    ):
        sys.modules.pop(module_name, None)


_cleanup_stubbed_modules()


class CoordinatorHouseForecastTests(unittest.TestCase):
    def test_has_matching_forecast_snapshot_rejects_legacy_hourly_shape(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._cached_forecast = {
            "status": "available",
            "actualHistory": [],
            "trainingWindowDays": 56,
            "requiredHistoryDays": 14,
            "configFingerprint": "abc123",
            "model": HOUSE_FORECAST_MODEL_ID,
            "resolution": "hour",
            "currentHour": {
                "timestamp": "2026-03-20T21:00:00+01:00",
            },
        }

        self.assertFalse(
            coordinator._has_matching_forecast_snapshot(
                total_energy_entity_id="sensor.house_total",
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="abc123",
            )
        )

    def test_has_matching_forecast_snapshot_accepts_canonical_slot_shape(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._cached_forecast = {
            "status": "available",
            "actualHistory": [],
            "trainingWindowDays": 56,
            "requiredHistoryDays": 14,
            "configFingerprint": "abc123",
            "model": HOUSE_FORECAST_MODEL_ID,
            "sourceGranularityMinutes": FORECAST_CANONICAL_GRANULARITY_MINUTES,
            "forecastDaysAvailable": MAX_FORECAST_DAYS,
            "alignmentPaddingSlots": 3,
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
            },
        }

        self.assertTrue(
            coordinator._has_matching_forecast_snapshot(
                total_energy_entity_id="sensor.house_total",
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="abc123",
            )
        )

    def test_has_matching_forecast_snapshot_rejects_missing_alignment_padding(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._cached_forecast = {
            "status": "available",
            "actualHistory": [],
            "trainingWindowDays": 56,
            "requiredHistoryDays": 14,
            "configFingerprint": "abc123",
            "model": HOUSE_FORECAST_MODEL_ID,
            "sourceGranularityMinutes": FORECAST_CANONICAL_GRANULARITY_MINUTES,
            "forecastDaysAvailable": MAX_FORECAST_DAYS,
            "alignmentPaddingSlots": 0,
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
            },
        }

        self.assertFalse(
            coordinator._has_matching_forecast_snapshot(
                total_energy_entity_id="sensor.house_total",
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="abc123",
            )
        )

    def test_has_current_slot_forecast_uses_quarter_hour_freshness(self) -> None:
        snapshot = {
            "currentSlot": {
                "timestamp": "2026-03-20T21:00:00+01:00",
            }
        }

        self.assertTrue(
            HelmanCoordinator._has_current_slot_forecast(
                snapshot,
                reference_time=datetime.fromisoformat("2026-03-20T21:14:00+01:00"),
            )
        )
        self.assertFalse(
            HelmanCoordinator._has_current_slot_forecast(
                snapshot,
                reference_time=datetime.fromisoformat("2026-03-20T21:16:00+01:00"),
            )
        )


if __name__ == "__main__":
    unittest.main()
