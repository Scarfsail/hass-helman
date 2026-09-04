from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")


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
    # Coordinator reads (min_history_days, training_window_days) via this
    # shared helper since the v14 training-section relocation.
    consumption_builder_mod.read_house_training_window_config = (
        lambda config: (14, 56)
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
    battery_state_mod.describe_battery_entity_config_issue = lambda config: None
    battery_state_mod.describe_battery_live_state_issue = (
        lambda hass, config=None: None
    )
    battery_state_mod.read_battery_entity_config = lambda config: None
    battery_state_mod.read_battery_live_state = lambda hass, config=None: None
    battery_state_mod.read_battery_soc_bounds = lambda hass, config=None: None
    battery_state_mod.read_battery_soc_bounds_config = lambda config: None
    battery_state_mod.read_battery_forecast_settings = lambda config: None
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
    recorder_slots_mod.query_active_hours_by_local_date = lambda *args, **kwargs: {}

    class _TodaySlotEnergyReader:
        def __init__(self, hass):
            self.hass = hass

        async def async_query_slot_energy_changes(self, *args, **kwargs):
            return {}

    recorder_slots_mod.TodaySlotEnergyReader = _TodaySlotEnergyReader
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    battery_history_mod = types.ModuleType(
        "custom_components.helman.battery_actual_history_builder"
    )

    async def _build_battery_actual_history(*args, **kwargs):
        return []

    battery_history_mod.build_battery_actual_history = _build_battery_actual_history
    sys.modules[battery_history_mod.__name__] = battery_history_mod

    schedule_mod = types.ModuleType("custom_components.helman.scheduling.schedule")
    schedule_mod.ScheduleControlConfig = type("ScheduleControlConfig", (), {})

    class ScheduleDocument:
        def __init__(self, execution_enabled=False, slots=None) -> None:
            self.execution_enabled = execution_enabled
            self.slots = {} if slots is None else dict(slots)

        def __eq__(self, other) -> bool:
            return (
                isinstance(other, ScheduleDocument)
                and self.execution_enabled == other.execution_enabled
                and self.slots == other.slots
            )

    schedule_mod.ScheduleDocument = ScheduleDocument
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
    schedule_mod.build_horizon_start = lambda reference_time: reference_time.replace(
        minute=(reference_time.minute // 30) * 30,
        second=0,
        microsecond=0,
    )
    schedule_mod.describe_schedule_control_config_issue = lambda config: None
    schedule_mod.format_slot_id = lambda slot: slot.isoformat(timespec="seconds")
    schedule_mod.parse_slot_id = datetime.fromisoformat
    schedule_mod.materialize_schedule_slots = lambda stored_slots, reference_time: []
    schedule_mod.normalize_schedule_document_for_registry = (
        lambda document, appliances_registry=None: document
    )
    schedule_mod.normalize_slot_patch_request = (
        lambda slot_patches, appliances_registry=None: slot_patches
    )
    schedule_mod.prune_expired_slots = (
        lambda stored_slots, reference_time: stored_slots
    )
    schedule_mod.strip_candidate_actions = lambda doc: doc
    schedule_mod.read_schedule_control_config = lambda config: None
    schedule_mod.schedule_document_from_dict = (
        lambda raw_document: raw_document if raw_document is not None else ScheduleDocument()
    )
    schedule_mod.schedule_document_to_dict = lambda doc: {
        "executionEnabled": doc.execution_enabled,
        "slots": dict(doc.slots),
    }
    schedule_mod.slot_to_dict = lambda slot, runtime=None: {}
    schedule_mod.with_slot_set_by = lambda slot, set_by=None: slot
    schedule_mod.validate_slot_patch_request = (
        lambda slots, reference_time, battery_soc_bounds: None
    )
    schedule_mod.ScheduleAction = type("ScheduleAction", (), {})
    schedule_mod.EMPTY_SCHEDULE_ACTION = None
    schedule_mod.iter_horizon_slot_ids = lambda reference_time: iter([])
    schedule_mod.build_horizon_end = lambda reference_time: reference_time
    sys.modules[schedule_mod.__name__] = schedule_mod

    runtime_status_mod = types.ModuleType(
        "custom_components.helman.scheduling.runtime_status"
    )
    runtime_status_mod.ScheduleExecutionStatus = type(
        "ScheduleExecutionStatus",
        (),
        {"active_slot_id": None, "active_slot_runtime": None},
    )
    runtime_status_mod.schedule_execution_status_to_dict = lambda execution_status: None
    sys.modules[runtime_status_mod.__name__] = runtime_status_mod

    action_resolution_mod = types.ModuleType(
        "custom_components.helman.scheduling.action_resolution"
    )

    def resolve_executed_schedule_action(*, action, current_soc):
        if (
            getattr(action, "kind", None) == "charge_to_target_soc"
            and current_soc is not None
            and getattr(action, "target_soc", None) is not None
            and current_soc >= action.target_soc
        ):
            return SimpleNamespace(
                executed_action=SimpleNamespace(
                    kind="stop_discharging",
                    target_soc=None,
                ),
                reason="target_soc_reached",
            )
        if (
            getattr(action, "kind", None) == "discharge_to_target_soc"
            and current_soc is not None
            and getattr(action, "target_soc", None) is not None
            and current_soc <= action.target_soc
        ):
            return SimpleNamespace(
                executed_action=SimpleNamespace(
                    kind="stop_charging",
                    target_soc=None,
                ),
                reason="target_soc_reached",
            )
        return SimpleNamespace(
            executed_action=SimpleNamespace(
                kind=getattr(action, "kind", None),
                target_soc=getattr(action, "target_soc", None),
            ),
            reason="scheduled",
        )

    action_resolution_mod.resolve_executed_schedule_action = (
        resolve_executed_schedule_action
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
    history_mod.get_significant_states = lambda *args, **kwargs: {}

    # The house consumption trainer splices its window's tail out of hourly
    # long-term statistics, so importing the coordinator now reaches this
    # module too. Nothing here exercises that read; it answers with nothing.
    statistics_mod = sys.modules.get("homeassistant.components.recorder.statistics")
    if statistics_mod is None:
        statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
        sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod
    statistics_mod.statistics_during_period = lambda *args, **kwargs: {}

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
    helpers_pkg.__path__ = []  # mark as package so sub-imports work

    debounce_mod = sys.modules.get("homeassistant.helpers.debounce")
    if debounce_mod is None:
        debounce_mod = types.ModuleType("homeassistant.helpers.debounce")
        sys.modules["homeassistant.helpers.debounce"] = debounce_mod
    debounce_mod.Debouncer = type("Debouncer", (), {"async_call": lambda self: None})

    # ``automation.day_context_store`` does ``from homeassistant.helpers import
    # storage`` and builds a ``storage.Store``; provide a lightweight stub so a
    # ``FakeHass`` without real ``data``/``config`` can back it.
    storage_helper_mod = types.ModuleType("homeassistant.helpers.storage")

    class _HelperStore:
        def __init__(self, hass, version, key) -> None:
            self._data = None

        async def async_load(self):
            return self._data

        async def async_save(self, data) -> None:
            self._data = data

    storage_helper_mod.Store = _HelperStore
    sys.modules["homeassistant.helpers.storage"] = storage_helper_mod
    helpers_pkg.storage = storage_helper_mod

    event_mod = sys.modules.get("homeassistant.helpers.event")
    if event_mod is None:
        event_mod = types.ModuleType("homeassistant.helpers.event")
        sys.modules["homeassistant.helpers.event"] = event_mod
    event_mod.async_track_state_change_event = (
        lambda hass, entity_ids, action: lambda: None
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


_install_import_stubs()

import custom_components.helman.coordinator as coordinator_module  # noqa: E402
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman.scheduling.schedule import ScheduleDocument  # noqa: E402


def _cleanup_stubbed_modules() -> None:
    for module_name in (
        "custom_components",
        "custom_components.helman",
        "custom_components.helman.scheduling",
        "custom_components.helman.coordinator",
        "custom_components.helman.battery_capacity_forecast_builder",
        "custom_components.helman.consumption_forecast_builder",
        "custom_components.helman.forecast_builder",
        "custom_components.helman.tree_builder",
        "custom_components.helman.battery_state",
        "custom_components.helman.recorder_hourly_series",
        "custom_components.helman.scheduling.schedule",
        "custom_components.helman.scheduling.runtime_status",
        "custom_components.helman.scheduling.action_resolution",
        "custom_components.helman.scheduling.schedule_executor",
        "custom_components.helman.storage",
        "homeassistant",
        "homeassistant.core",
        "homeassistant.components",
        "homeassistant.components.energy",
        "homeassistant.components.energy.data",
    "homeassistant.components.recorder",
    "homeassistant.components.recorder.history",
    "homeassistant.components.recorder.statistics",
        "homeassistant.helpers",
        "homeassistant.helpers.event",
        "homeassistant.helpers.entity_registry",
        "homeassistant.util",
        "homeassistant.util.dt",
    ):
        sys.modules.pop(module_name, None)


_cleanup_stubbed_modules()


def _make_solar_forecast() -> dict:
    return {
        "status": "available",
        "points": [
            {
                "timestamp": "2026-03-20T21:00:00+01:00",
                "value": 100.0,
            },
            {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "value": 125.0,
            },
        ],
    }


def _make_house_forecast(*, generated_at: str = "2026-03-20T21:05:00+01:00") -> dict:
    return {
        "status": "available",
        "generatedAt": generated_at,
    }


def _make_battery_forecast(
    *,
    started_at: str = "2026-03-20T21:07:00+01:00",
    current_soc: float = 50.0,
    current_remaining_energy_kwh: float = 5.0,
) -> dict:
    return {
        "status": "available",
        "startedAt": started_at,
        "currentSoc": current_soc,
        "currentRemainingEnergyKwh": current_remaining_energy_kwh,
        "series": [],
        "actualHistory": [],
    }


def _make_projection_plan() -> SimpleNamespace:
    return SimpleNamespace(
        generated_at=REFERENCE_TIME.isoformat(),
        appliances_by_id={},
        demand_points=(),
    )


def _make_schedule_action(kind: str, target_soc: int | None = None) -> dict:
    """One slot's flat, id-keyed action map holding just the inverter's."""
    return {"inverter": SimpleNamespace(kind=kind, target_soc=target_soc)}


def _make_schedule_document(
    *,
    execution_enabled: bool = False,
    slots: dict[str, SimpleNamespace] | None = None,
) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={} if slots is None else dict(slots),
    )


def _make_control_config(
    *,
    charge_to_target_soc_option: str | None = "charge_target",
    discharge_to_target_soc_option: str | None = "discharge_target",
    stop_export_option: str | None = "stop_export",
) -> SimpleNamespace:
    return SimpleNamespace(
        charge_to_target_soc_option=charge_to_target_soc_option,
        discharge_to_target_soc_option=discharge_to_target_soc_option,
        stop_export_option=stop_export_option,
    )


class CoordinatorBatteryForecastCacheTests(unittest.IsolatedAsyncioTestCase):
    def _make_coordinator(self) -> HelmanCoordinator:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = object()
        coordinator._storage = SimpleNamespace(
            config={},
            schedule_document=_make_schedule_document(),
            async_save_schedule_document=AsyncMock(),
        )
        coordinator._active_config = {}
        coordinator._appliances_registry = coordinator_module.AppliancesRuntimeRegistry()
        coordinator._cached_battery_forecast = None
        coordinator._cached_battery_forecast_expires_at = None
        coordinator._cached_battery_forecast_house_generated_at = None
        coordinator._cached_battery_forecast_solar_signature = None
        coordinator._cached_battery_forecast_schedule_signature = None
        coordinator._cached_battery_forecast_schedule_effective_signature = None
        coordinator._cached_appliance_projection_schedule_signature = None
        coordinator._schedule_lock = asyncio.Lock()
        coordinator._build_battery_forecast_schedule_overlay = Mock(return_value=None)
        return coordinator

    def test_build_battery_forecast_schedule_document_filters_unconfigured_target_actions(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    60,
                ),
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config(charge_to_target_soc_option=None)
        )

        forecast_schedule_document = (
            coordinator._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            )
        )

        self.assertTrue(forecast_schedule_document.execution_enabled)
        self.assertEqual(
            forecast_schedule_document.slots,
            {
                "2026-03-20T21:30:00+01:00": schedule_document.slots[
                    "2026-03-20T21:30:00+01:00"
                ],
            },
        )

    def test_build_battery_forecast_schedule_document_keeps_unconfigured_stop_export(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_export"),
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config(stop_export_option=None)
        )

        forecast_schedule_document = (
            coordinator._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            )
        )

        self.assertTrue(forecast_schedule_document.execution_enabled)
        self.assertEqual(
            forecast_schedule_document.slots,
            {
                "2026-03-20T21:00:00+01:00": schedule_document.slots[
                    "2026-03-20T21:00:00+01:00"
                ],
                "2026-03-20T21:30:00+01:00": schedule_document.slots[
                    "2026-03-20T21:30:00+01:00"
                ],
            },
        )

    def test_build_battery_forecast_schedule_document_keeps_slots_without_control_config(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_export"),
                "2026-03-20T21:30:00+01:00": _make_schedule_action(
                    "discharge_to_target_soc",
                    20,
                ),
            },
        )
        coordinator._read_schedule_control_config = Mock(return_value=None)

        forecast_schedule_document = (
            coordinator._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            )
        )

        self.assertEqual(forecast_schedule_document, schedule_document)

    async def test_async_get_battery_forecast_reuses_cache_within_ttl(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast_sync = build_mock

        first = await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        second = await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(first, second)
        build_mock.assert_called_once()

    async def test_async_get_battery_forecast_rebuilds_after_ttl_expiry(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast_sync = build_mock

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:13:00+01:00"),
        )

        self.assertEqual(build_mock.call_count, 2)

    async def test_async_get_battery_forecast_rebuilds_when_cached_started_at_is_missing(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        expected_forecast = _make_battery_forecast()
        build_mock = Mock(return_value=expected_forecast)
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._cached_battery_forecast = _make_battery_forecast(started_at=None)
        coordinator._cached_battery_forecast_expires_at = datetime.fromisoformat(
            "2026-03-20T21:12:00+01:00"
        )
        coordinator._cached_battery_forecast_house_generated_at = _make_house_forecast()[
            "generatedAt"
        ]
        coordinator._cached_battery_forecast_solar_signature = (
            coordinator._build_battery_forecast_solar_signature(_make_solar_forecast())
        )
        coordinator._cached_battery_forecast_schedule_signature = ()
        coordinator._cached_battery_forecast_schedule_effective_signature = None

        forecast = await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )

        self.assertEqual(forecast, expected_forecast)
        build_mock.assert_called_once()

    async def test_async_get_battery_forecast_rebuilds_when_house_snapshot_changes(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast_sync = build_mock

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(generated_at="2026-03-20T21:05:00+01:00"),
            started_at=REFERENCE_TIME,
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(generated_at="2026-03-20T21:10:00+01:00"),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.call_count, 2)

    async def test_invalidate_battery_forecast_cache_forces_rebuild(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast_sync = build_mock

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._invalidate_battery_forecast_cache()
        self.assertIsNone(coordinator._cached_battery_forecast_schedule_signature)
        self.assertIsNone(coordinator._cached_battery_forecast_schedule_effective_signature)
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.call_count, 2)

    async def test_invalidate_battery_forecast_cache_also_clears_projection_cache(self) -> None:
        coordinator = self._make_coordinator()
        coordinator._cached_appliance_projection_schedule_signature = ()

        coordinator._invalidate_battery_forecast_cache()

        self.assertIsNone(coordinator._cached_appliance_projection_schedule_signature)

    async def test_async_get_appliance_projection_plan_reuses_cache_for_same_started_at(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        plan = _make_projection_plan()
        battery_forecast = _make_battery_forecast()
        coordinator._build_battery_forecast_sync = Mock(return_value=battery_forecast)

        with (
            patch.object(
                coordinator_module,
                "build_projection_input_bundle",
                return_value=object(),
            ) as build_input_bundle,
            patch.object(
                coordinator_module,
                "build_appliance_projection_plan",
                return_value=plan,
            ) as build_plan,
        ):
            first = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            second = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )

        self.assertIs(first, plan)
        self.assertIs(second, plan)
        build_input_bundle.assert_called_once()
        build_plan.assert_called_once_with(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=coordinator._appliances_registry,
            schedule_document=_make_schedule_document(),
            inputs=build_input_bundle.return_value,
            hass=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={},
            vehicle_remaining_capacity_kwh_by_vehicle_id={},
        )
        coordinator._build_battery_forecast_sync.assert_called_once()

    async def test_async_get_appliance_projection_plan_reuses_shared_pipeline_within_slot(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        first_plan = _make_projection_plan()
        coordinator._build_battery_forecast_sync = Mock(return_value=_make_battery_forecast())

        with (
            patch.object(
                coordinator_module,
                "build_projection_input_bundle",
                return_value=object(),
            ) as build_input_bundle,
            patch.object(
                coordinator_module,
                "build_appliance_projection_plan",
                return_value=first_plan,
            ) as build_plan,
        ):
            first = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            second = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:08:00+01:00"),
            )

        self.assertIs(first, first_plan)
        self.assertIs(second, first_plan)
        self.assertEqual(build_input_bundle.call_count, 1)
        self.assertEqual(build_plan.call_count, 1)
        coordinator._build_battery_forecast_sync.assert_called_once()

    async def test_async_get_battery_forecast_rebuilds_when_schedule_slots_change(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        overlay = object()
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            }
        )

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            }
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.call_count, 2)

    def test_forecast_schedule_documents_empty_both_domains_when_execution_disabled(
        self,
    ) -> None:
        # With execution off Helman actuates nothing, so the forecast projects
        # the unmanaged house: no inverter action *and* no appliance run. Both
        # documents have to be emptied together — emptying only the inverter
        # side would forecast a battery that ignores appliance runs the same
        # forecast still believes in.
        coordinator = self._make_coordinator()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        slot = _make_schedule_action("stop_charging")
        slot["boiler"] = {"kind": "run"}
        schedule_document = _make_schedule_document(
            execution_enabled=False,
            slots={"2026-03-20T21:00:00+01:00": slot},
        )

        documents = coordinator._build_forecast_schedule_documents(
            schedule_document=schedule_document
        )

        self.assertEqual(documents.forecast_schedule_document.slots, {})
        self.assertEqual(documents.projection_schedule_document.slots, {})

    def test_forecast_schedule_documents_follow_the_plan_when_execution_enabled(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        slot = _make_schedule_action("stop_charging")
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={"2026-03-20T21:00:00+01:00": slot},
        )

        documents = coordinator._build_forecast_schedule_documents(
            schedule_document=schedule_document
        )

        self.assertEqual(
            documents.forecast_schedule_document.slots,
            {"2026-03-20T21:00:00+01:00": slot},
        )
        self.assertEqual(
            documents.projection_schedule_document.slots,
            {"2026-03-20T21:00:00+01:00": slot},
        )

    def test_schedule_signatures_ignore_slot_changes_while_execution_disabled(
        self,
    ) -> None:
        # Both signatures are derived from the gated documents, which are empty
        # while execution is off. Editing the plan then cannot change the
        # forecast, so it must not invalidate the cache either.
        coordinator = self._make_coordinator()
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        first = coordinator._build_forecast_schedule_documents(
            schedule_document=_make_schedule_document(
                execution_enabled=False,
                slots={
                    "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
                },
            )
        )
        second = coordinator._build_forecast_schedule_documents(
            schedule_document=_make_schedule_document(
                execution_enabled=False,
                slots={
                    "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
                },
            )
        )

        self.assertEqual(
            coordinator._build_battery_forecast_schedule_signature(
                first.forecast_schedule_document
            ),
            coordinator._build_battery_forecast_schedule_signature(
                second.forecast_schedule_document
            ),
        )
        self.assertEqual(
            coordinator._build_appliance_projection_schedule_signature(
                first.projection_schedule_document
            ),
            coordinator._build_appliance_projection_schedule_signature(
                second.projection_schedule_document
            ),
        )

    async def test_async_get_battery_forecast_rebuilds_when_only_execution_flag_changes(
        self,
    ) -> None:
        # Toggling execution swaps the forecast between the unmanaged
        # trajectory and the plan's effect, and nothing invalidates the cache on
        # the toggle any more. The signature notices on its own because it is
        # built from the gated document, which empties with the flag.
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        overlay = object()
        first_schedule_document = _make_schedule_document(
            execution_enabled=False,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        second_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = first_schedule_document

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = second_schedule_document
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.call_count, 2)
        self.assertEqual(
            coordinator._build_battery_forecast_schedule_signature(
                coordinator._build_forecast_schedule_documents(
                    schedule_document=first_schedule_document
                ).forecast_schedule_document
            ),
            (),
        )
        self.assertNotEqual(
            coordinator._build_battery_forecast_schedule_signature(
                coordinator._build_forecast_schedule_documents(
                    schedule_document=second_schedule_document
                ).forecast_schedule_document
            ),
            (),
        )
        # The disabled build gets an overlay built from the emptied document.
        self.assertEqual(
            coordinator._build_battery_forecast_schedule_overlay.call_args_list[
                0
            ].kwargs["schedule_document"].slots,
            {},
        )

    async def test_async_get_battery_forecast_reuses_cache_with_matching_schedule_state(
        self,
    ) -> None:
        # A schedule write that leaves the horizon actions alone — the executor
        # re-persisting a pruned document, an automation run landing on the same
        # plan — costs nothing: the read side sees the same signature and serves
        # the cached pipeline.
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast())
        overlay = object()
        first_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        second_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = first_schedule_document

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = second_schedule_document
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.call_count, 1)
        coordinator._build_battery_forecast_schedule_overlay.assert_called_once_with(
            schedule_document=first_schedule_document,
            reference_time=REFERENCE_TIME,
        )

    async def test_async_get_battery_forecast_rebuilds_when_active_target_effective_action_flips(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(
            side_effect=[
                _make_battery_forecast(
                    current_soc=49.4,
                    current_remaining_energy_kwh=5.0,
                ),
                _make_battery_forecast(
                    started_at="2026-03-20T21:11:00+01:00",
                    current_soc=50.2,
                    current_remaining_energy_kwh=5.05,
                ),
            ]
        )
        overlay = object()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=SimpleNamespace(capacity_entity_id="sensor.battery_capacity"),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=[
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=50.2,
                        current_remaining_energy_kwh=5.05,
                    ),
                ],
            ),
        ):
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertEqual(build_mock.call_count, 2)

    async def test_async_get_battery_forecast_rebuilds_when_active_target_slot_remains_target(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = Mock(
            side_effect=[
                _make_battery_forecast(
                    current_soc=49.4,
                    current_remaining_energy_kwh=5.0,
                ),
                _make_battery_forecast(
                    started_at="2026-03-20T21:11:00+01:00",
                    current_soc=50.6,
                    current_remaining_energy_kwh=5.2,
                ),
            ]
        )
        overlay = object()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=SimpleNamespace(capacity_entity_id="sensor.battery_capacity"),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=[
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=50.6,
                        current_remaining_energy_kwh=5.2,
                    ),
                ],
            ),
        ):
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertEqual(build_mock.call_count, 2)

    async def test_async_get_battery_forecast_reuses_cache_when_active_target_signature_matches(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        forecast = _make_battery_forecast(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        )
        build_mock = Mock(return_value=forecast)
        overlay = object()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=SimpleNamespace(capacity_entity_id="sensor.battery_capacity"),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=[
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                ],
            ),
        ):
            first = await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            second = await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertIs(first, forecast)
        self.assertIs(second, forecast)
        self.assertEqual(build_mock.call_count, 1)

    async def test_async_get_battery_forecast_rebuilds_when_live_soc_drifts(
        self,
    ) -> None:
        # The projected curve starts from the live SoC, so a battery that has
        # moved beyond the tolerance must not be drawn from a cached curve
        # anchored to where it used to be. The slot action is a plain one, so
        # the effective signature is None and only the live-state check can
        # decide — which is the point of the guard.
        coordinator = self._make_coordinator()
        build_mock = Mock(return_value=_make_battery_forecast(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        ))
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._build_battery_forecast_sync = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=object()
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document
        live_state = SimpleNamespace(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        )

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=SimpleNamespace(capacity_entity_id="sensor.battery_capacity"),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=lambda *args, **kwargs: live_state,
            ),
        ):
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            # A couple of minutes of charging: past the 0.1 kWh bound.
            live_state = SimpleNamespace(
                current_soc=51.0,
                current_remaining_energy_kwh=5.2,
            )
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertEqual(build_mock.call_count, 2)


class SlotAlignedRefreshBeatTests(unittest.TestCase):
    """The quarter-hour beat snaps back to the boundary before rebuilding.

    Home Assistant's ``async_track_time_change`` draws a microsecond offset in
    [50ms, 500ms] once, when the listener is attached, schedules every firing at
    boundary + that offset, then hands the callback the real clock. Passing that
    straight through as the rebuild's reference time stamped the snapshot's
    first slot short by the offset for the whole session -- #204.
    """

    def _fire(self, fired_at):
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._unsub_forecast_refresh = None
        forwarded = []
        coordinator._create_tracked_refresh_task = lambda coro: coro
        coordinator._async_refresh_forecast = (
            lambda *, reason, reference_time: forwarded.append(
                (reason, reference_time)
            )
        )

        registered = []
        original = coordinator_module.async_track_time_change
        coordinator_module.async_track_time_change = (
            lambda hass, action, **kwargs: registered.append((action, kwargs))
            or (lambda: None)
        )
        try:
            coordinator._start_forecast_refresh()
        finally:
            coordinator_module.async_track_time_change = original

        (on_interval, kwargs) = registered[0]
        self.assertEqual(kwargs, {"minute": [0, 15, 30, 45], "second": 0})
        on_interval(fired_at)
        return forwarded[0]

    def test_a_late_firing_is_snapped_back_to_the_slot_boundary(self):
        for offset_text in ("0.050000", "0.183000", "0.499999"):
            with self.subTest(offset=offset_text):
                reason, reference_time = self._fire(
                    datetime.fromisoformat(f"2026-03-20T21:15:00.{offset_text[2:]}+01:00")
                )
                self.assertEqual(reason, coordinator_module._SLOT_ALIGNED_REFRESH_REASON)
                self.assertEqual(
                    reference_time,
                    datetime.fromisoformat("2026-03-20T21:15:00+01:00"),
                )

    def test_a_firing_that_slips_past_the_next_boundary_keeps_its_own_slot(self):
        # An event loop stalled past :30 must not be snapped back to :15 -- the
        # slot it is actually in is the one the rebuild has to stamp.
        _, reference_time = self._fire(
            datetime.fromisoformat("2026-03-20T21:30:02.400000+01:00")
        )
        self.assertEqual(
            reference_time, datetime.fromisoformat("2026-03-20T21:30:00+01:00")
        )


class BatteryForecastCurrentAccessorTests(unittest.TestCase):
    """The accessor the five retired-store entities read, and the derivation it
    now owns (moved verbatim from ``BatteryForecastHistoryStore._slot_values``)."""

    def _coordinator(self, snapshot):
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague")
        )
        coordinator._cached_appliance_forecast_pipeline = (
            None
            if snapshot is None
            else SimpleNamespace(battery_forecast=snapshot)
        )
        return coordinator

    def test_derives_the_five_figures_with_their_sign_conventions(self):
        # Reference clock is 21:07+01:00, so the current slot starts at 21:00.
        coordinator = self._coordinator(
            {
                "series": [
                    # The slot-aligned first entry: stamped microseconds into
                    # the slot, a full slot's ``durationHours``.
                    {
                        "timestamp": "2026-03-20T21:00:00.010000+01:00",
                        "durationHours": 0.25,
                        "socPct": 62.5,
                        "importedFromGridKwh": 0.4,
                        "exportedToGridKwh": 0.1,
                        "chargedKwh": 0.6,
                        "dischargedKwh": 0.25,
                    },
                    {"timestamp": "2026-03-20T21:15:00+01:00", "socPct": 99.0},
                ]
            }
        )
        values = coordinator.get_battery_forecast_current()
        self.assertEqual(values["socPct"], 62.5)
        # Positive when exporting: 0.1 kWh out minus 0.4 kWh in, in Wh.
        self.assertEqual(values["gridNetWh"], -300.0)
        self.assertEqual(values["gridImportWh"], 400.0)
        self.assertEqual(values["gridExportWh"], 100.0)
        # Positive when charging: 0.6 kWh in minus 0.25 kWh out.
        self.assertEqual(values["batteryNetWh"], 350.0)

    def test_a_slot_without_the_later_fields_omits_those_keys(self):
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T21:00:00+01:00", "socPct": 40.0}]}
        )
        self.assertEqual(coordinator.get_battery_forecast_current(), {"socPct": 40.0})

    def test_a_partial_first_entry_is_refused(self):
        # Off the slot-aligned beat the first entry covers only the slot's
        # remainder -- ``durationHours`` short of 0.25, energies scaled down.
        # The accessor refuses it whole, SoC included, so no state-write path
        # can publish a partial value.
        coordinator = self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:07:00+01:00",
                        "durationHours": 0.1333,
                        "socPct": 62.5,
                        "importedFromGridKwh": 0.05,
                        "exportedToGridKwh": 0.0,
                        "chargedKwh": 0.08,
                        "dischargedKwh": 0.0,
                    }
                ]
            }
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())

    _FULL_SLOT_SNAPSHOT = {
        "series": [
            {
                "timestamp": "2026-03-20T21:00:00+01:00",
                "durationHours": 0.25,
                "socPct": 62.5,
                "importedFromGridKwh": 0.4,
                "exportedToGridKwh": 0.1,
                "chargedKwh": 0.6,
                "dischargedKwh": 0.25,
            }
        ]
    }

    _PARTIAL_SNAPSHOT = {
        "series": [
            {
                "timestamp": "2026-03-20T21:07:00+01:00",
                "durationHours": 0.1333,
                "socPct": 58.0,
                "importedFromGridKwh": 0.05,
                "exportedToGridKwh": 0.0,
                "chargedKwh": 0.08,
                "dischargedKwh": 0.0,
            }
        ]
    }

    def test_a_partial_after_a_full_slot_serves_the_full_slot_again(self):
        # #204: the beat fills the 21:00 slot, then an off-beat rebuild replaces
        # the snapshot's entry for that same slot with a partial. The slot's
        # answer was already known and does not become unknown -- the five must
        # not drop out for the remaining eight minutes.
        whole_slot = {
            "socPct": 62.5,
            "gridNetWh": -300.0,
            "gridImportWh": 400.0,
            "gridExportWh": 100.0,
            "batteryNetWh": 350.0,
        }
        coordinator = self._coordinator(self._FULL_SLOT_SNAPSHOT)
        served = coordinator.get_battery_forecast_current()
        self.assertEqual(served, whole_slot)
        coordinator._cached_appliance_forecast_pipeline = SimpleNamespace(
            battery_forecast=self._PARTIAL_SNAPSHOT
        )
        # The whole-slot figures spelled out, not the object the first read
        # returned: the partial's rescaled 58.0 and its eighth of a slot's
        # energies must not appear.
        self.assertEqual(coordinator.get_battery_forecast_current(), whole_slot)

    def test_the_memo_survives_a_caller_mutating_what_it_was_handed(self):
        # The accessor runs on every state read of the five entities. Handing
        # out the memo's own map would let one caller's mutation stand as the
        # slot's answer for the rest of the quarter hour.
        coordinator = self._coordinator(self._FULL_SLOT_SNAPSHOT)
        coordinator.get_battery_forecast_current().clear()
        coordinator._cached_appliance_forecast_pipeline = SimpleNamespace(
            battery_forecast=self._PARTIAL_SNAPSHOT
        )
        served = coordinator.get_battery_forecast_current()
        self.assertEqual(served["socPct"], 62.5)
        served["socPct"] = 0.0
        self.assertEqual(
            coordinator.get_battery_forecast_current()["socPct"], 62.5
        )

    def test_a_memo_from_an_earlier_slot_is_not_served(self):
        # The slot key is the memo's entire expiry: 20:45's figures can never
        # answer a read taken in the 21:00 slot.
        coordinator = self._coordinator(self._PARTIAL_SNAPSHOT)
        coordinator._battery_forecast_current_slot = (
            "2026-03-20T20:45:00+01:00",
            {"socPct": 91.0},
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())

    def test_the_memo_answers_the_partial_branch_only(self):
        # A cold pipeline or a snapshot with no series means the system has
        # nothing for this slot, which is a different failure and must stay
        # visible -- the memo does not paper over it.
        coordinator = self._coordinator(self._FULL_SLOT_SNAPSHOT)
        self.assertIsNotNone(coordinator.get_battery_forecast_current())
        coordinator._cached_appliance_forecast_pipeline = SimpleNamespace(
            battery_forecast={"status": "unavailable"}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())
        coordinator._cached_appliance_forecast_pipeline = None
        self.assertIsNone(coordinator.get_battery_forecast_current())

    def test_an_entry_with_none_of_the_five_is_not_memoed(self):
        # "No slot" is not an answer worth remembering; memoing it would hand a
        # later partial the same ``None`` while suppressing its reason.
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T21:00:00+01:00"}]}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())
        self.assertIsNone(coordinator._battery_forecast_current_slot)

    def _first_entry(self, duration_hours):
        return self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "durationHours": duration_hours,
                        "socPct": 62.5,
                    }
                ]
            }
        )

    def test_the_duration_the_slot_aligned_beat_really_produces_is_accepted(self):
        # #204: the guard used to demand a full slot to within 3.6us, which the
        # slot-aligned rebuild never once met -- Home Assistant fires the beat
        # 50-500ms late, by a per-session offset it draws when the listener is
        # attached, so the first entry came out short by that offset. Sessions
        # that drew over ~180ms published ``unavailable`` on every slot for
        # their whole life; the rest survived only because ``simulate_slot``
        # rounds ``durationHours`` to four places. The beat is snapped to the
        # boundary now, and the tolerance is a second rather than microseconds.
        for duration_hours in (
            0.25,  # snapped: what the beat produces now
            0.2499,  # rounded, from a 190ms-500ms offset
            (900 - 0.5) / 3600,  # unrounded, from the largest offset HA draws
            0.25 - 1 / 3600,  # a full second short, the edge of the tolerance
        ):
            with self.subTest(duration_hours=duration_hours):
                values = self._first_entry(duration_hours).get_battery_forecast_current()
                self.assertEqual(values, {"socPct": 62.5})

    def test_an_entry_short_by_more_than_the_tolerance_is_still_refused(self):
        # 36 seconds short: an off-beat rebuild, not scheduler slop.
        self.assertIsNone(self._first_entry(0.249).get_battery_forecast_current())

    def test_an_entry_with_none_of_the_five_is_none_not_empty(self):
        # ``_battery_forecast_slot_values`` ends on ``values or None`` again, so
        # the accessor never hands back a truthy-but-empty ``{}``.
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T21:00:00+01:00"}]}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())

    def test_none_without_a_pipeline_or_a_slot_for_the_current_quarter_hour(self):
        self.assertIsNone(self._coordinator(None).get_battery_forecast_current())
        # Only future slots: nothing for the 21:00 quarter hour.
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T22:00:00+01:00", "socPct": 40.0}]}
        )
        self.assertIsNone(coordinator.get_battery_forecast_current())


class BatteryForecastCurrentRefusalLoggingTests(unittest.TestCase):
    """Every route to the five current-slot entities reporting unavailable says
    why, and says it once.

    #204 spent two rounds of investigation on dead stretches that left nothing
    in the log: the builder logged its own refusals, but this accessor -- which
    is what the entities actually read -- returned ``None`` in silence down
    every branch. The reproduction that finally pinned it was a 13-minute hole
    whose only trace was the recorder.
    """

    LOGGER = "custom_components.helman.coordinator"

    def _coordinator(self, snapshot):
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague")
        )
        coordinator._cached_appliance_forecast_pipeline = (
            None
            if snapshot is None
            else SimpleNamespace(battery_forecast=snapshot)
        )
        return coordinator

    def _partial_first_entry(self):
        # The off-beat rebuild: stamped 21:07 into the 21:00 slot, so
        # ``durationHours`` covers only the remainder.
        return self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:07:00+01:00",
                        "durationHours": 0.1333,
                        "socPct": 62.5,
                    }
                ]
            }
        )

    def test_a_refused_partial_names_the_off_beat_rebuild(self):
        coordinator = self._partial_first_entry()
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        (line,) = captured.output
        self.assertIn("reason=partial_slot", line)
        # The slot the entities are down *for*, not the stamp on the entry.
        self.assertIn("slot=2026-03-20T21:00:00+01:00", line)
        self.assertIn("0.1333", line)

    def test_the_reason_is_logged_once_per_slot_not_once_per_read(self):
        # The five entities call this accessor on every state read; without the
        # dedupe a single dead slot would bury the log in identical lines.
        coordinator = self._partial_first_entry()
        with self.assertLogs(self.LOGGER, level="INFO"):
            coordinator.get_battery_forecast_current()
        with self.assertNoLogs(self.LOGGER, level="INFO"):
            for _ in range(5):
                coordinator.get_battery_forecast_current()

    def test_a_new_reason_in_the_same_slot_is_not_swallowed(self):
        # Dedupe keys on (reason, slot), so a stretch that changes cause
        # mid-slot still reports the change.
        coordinator = self._partial_first_entry()
        with self.assertLogs(self.LOGGER, level="INFO"):
            coordinator.get_battery_forecast_current()
        coordinator._cached_appliance_forecast_pipeline = None
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            coordinator.get_battery_forecast_current()
        self.assertIn("reason=pipeline_cold", captured.output[0])

    def test_a_partial_served_from_the_memo_is_not_a_refusal(self):
        # Serving the slot's own full-slot figures is a success, so it logs
        # nothing -- and, crucially, does not consume the (reason, slot) dedupe
        # token, so a genuine refusal later in the same slot is still reported.
        coordinator = self._coordinator(
            {
                "series": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "durationHours": 0.25,
                        "socPct": 62.5,
                    }
                ]
            }
        )
        coordinator.get_battery_forecast_current()
        coordinator._cached_appliance_forecast_pipeline = (
            self._partial_first_entry()._cached_appliance_forecast_pipeline
        )
        with self.assertNoLogs(self.LOGGER, level="INFO"):
            self.assertEqual(
                coordinator.get_battery_forecast_current(), {"socPct": 62.5}
            )
        coordinator._battery_forecast_current_slot = None
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        self.assertIn("reason=partial_slot", captured.output[0])

    def test_a_slot_missing_from_the_series_names_the_range_it_covered(self):
        coordinator = self._coordinator(
            {"series": [{"timestamp": "2026-03-20T22:00:00+01:00", "socPct": 40.0}]}
        )
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        (line,) = captured.output
        self.assertIn("reason=slot_not_in_series", line)
        self.assertIn("2026-03-20T22:00:00+01:00", line)

    def test_a_forecast_without_a_series_reports_its_status(self):
        coordinator = self._coordinator({"status": "unavailable"})
        with self.assertLogs(self.LOGGER, level="INFO") as captured:
            self.assertIsNone(coordinator.get_battery_forecast_current())
        (line,) = captured.output
        self.assertIn("reason=no_series", line)
        self.assertIn("'unavailable'", line)


if __name__ == "__main__":
    unittest.main()
