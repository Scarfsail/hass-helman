from __future__ import annotations

import importlib
import sys
import types
import unittest
import unittest.mock
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")

_STUBBED_MODULES = (
    "custom_components",
    "custom_components.helman",
    "custom_components.helman.battery_capacity_forecast_builder",
    "custom_components.helman.battery_state",
    "custom_components.helman.consumption_forecast_builder",
    "custom_components.helman.forecast_builder",
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
    "homeassistant.helpers.storage",
    "homeassistant.helpers.debounce",
    "homeassistant.helpers.entity_registry",
    "homeassistant.helpers.event",
    "homeassistant.util",
    "homeassistant.util.dt",
)

_original_helman_modules = {
    module_name
    for module_name in sys.modules
    if module_name == "custom_components.helman"
    or module_name.startswith("custom_components.helman.")
}


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

    schedule_mod = types.ModuleType("custom_components.helman.scheduling.schedule")
    schedule_mod.ScheduleControlConfig = type("ScheduleControlConfig", (), {})
    schedule_mod.strip_candidate_actions = lambda doc: doc
    schedule_mod.ScheduleDocument = type(
        "ScheduleDocument",
        (),
        {"__init__": lambda self, execution_enabled=False, slots=None: None},
    )
    schedule_mod.ScheduleError = type("ScheduleError", (Exception,), {})
    schedule_mod.ScheduleResponseDict = dict
    schedule_mod.ScheduleSlot = dict
    schedule_mod.SCHEDULE_SLOT_DURATION = timedelta(minutes=30)
    schedule_mod.ScheduleAction = type("ScheduleAction", (), {})
    schedule_mod.ScheduleDomains = type("ScheduleDomains", (), {})
    schedule_mod.EMPTY_SCHEDULE_ACTION = None
    schedule_mod.apply_slot_patches = lambda stored_slots, slot_patches: []
    schedule_mod.build_horizon_end = lambda reference_time: reference_time
    schedule_mod.build_horizon_start = lambda reference_time: reference_time
    schedule_mod.describe_schedule_control_config_issue = lambda config: None
    schedule_mod.format_slot_id = lambda slot: ""
    schedule_mod.is_default_domains = lambda domains: True
    schedule_mod.iter_horizon_slot_ids = lambda reference_time: iter([])
    schedule_mod.parse_slot_id = datetime.fromisoformat
    schedule_mod.materialize_schedule_slots = lambda stored_slots, reference_time: []
    schedule_mod.normalize_schedule_document_for_registry = (
        lambda schedule_document, runtime_registry=None: schedule_document
    )
    schedule_mod.normalize_slot_patch_request = (
        lambda slot_patch, runtime_registry=None: slot_patch
    )
    schedule_mod.prune_expired_slots = (
        lambda stored_slots, reference_time: stored_slots
    )
    schedule_mod.read_schedule_control_config = lambda config: None
    schedule_mod.schedule_document_from_dict = lambda raw_document: raw_document
    schedule_mod.schedule_document_to_dict = lambda doc: {}
    schedule_mod.slot_to_dict = lambda slot, runtime=None: {}
    schedule_mod.slot_from_dict = lambda raw_slot: raw_slot
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
    runtime_status_mod.schedule_execution_status_to_dict = (
        lambda execution_status: None
    )
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
    return previous_modules


def _restore_modules(previous_modules: dict[str, types.ModuleType | None]) -> None:
    for module_name, previous_module in previous_modules.items():
        if previous_module is None:
            sys.modules.pop(module_name, None)
            continue
        sys.modules[module_name] = previous_module


_previous_modules = _install_import_stubs()
try:
    const_module = importlib.import_module("custom_components.helman.const")
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
finally:
    _restore_modules(_previous_modules)
    sys.modules.pop("custom_components.helman.coordinator", None)
    for module_name in list(sys.modules):
        if (
            module_name not in _original_helman_modules
            and (
                module_name == "custom_components.helman"
                or module_name.startswith("custom_components.helman.")
            )
        ):
            sys.modules.pop(module_name, None)

FORECAST_CANONICAL_GRANULARITY_MINUTES = (
    const_module.FORECAST_CANONICAL_GRANULARITY_MINUTES
)
HOUSE_FORECAST_MODEL_ID = const_module.HOUSE_FORECAST_MODEL_ID
MAX_FORECAST_DAYS = const_module.MAX_FORECAST_DAYS
HelmanCoordinator = coordinator_module.HelmanCoordinator


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

    def test_current_w_uses_adjusted_nondeferrable_not_deferrable_band(self) -> None:
        # The current slot covers 21:16 (the stubbed now); its adjusted
        # nonDeferrable already carries scheduled appliance demand (0.6 kWh).
        # The deferrableConsumers band and the unadjusted cache must be ignored.
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._cached_forecast = {
            "status": "available",
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "nonDeferrable": {"value": 0.2},
                "deferrableConsumers": [{"value": 0.3}],
            },
            "series": [],
        }
        coordinator._cached_appliance_forecast_pipeline = types.SimpleNamespace(
            adjusted_house_forecast={
                "status": "available",
                "currentSlot": {
                    "timestamp": "2026-03-20T21:15:00+01:00",
                    "nonDeferrable": {"value": 0.6},
                    "deferrableConsumers": [{"value": 0.9}],
                },
                "series": [],
            }
        )

        # 0.6 kWh over a 15-min slot -> 0.6 * 1000 / 0.25 = 2400 W.
        self.assertEqual(
            coordinator.get_house_consumption_forecast_current_w(),
            2400.0,
        )

    def test_current_w_falls_back_to_base_load_when_pipeline_cold(self) -> None:
        # With no pipeline, the sensor reports the unadjusted base load only,
        # never base + deferrableConsumers.
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._cached_appliance_forecast_pipeline = None
        coordinator._cached_forecast = {
            "status": "available",
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "nonDeferrable": {"value": 0.2},
                "deferrableConsumers": [{"value": 0.3}],
            },
            "series": [],
        }

        # 0.2 kWh base load only -> 0.2 * 1000 / 0.25 = 800 W (not 2000 W).
        self.assertEqual(
            coordinator.get_house_consumption_forecast_current_w(),
            800.0,
        )


def _make_profile_data() -> dict:
    return {
        "schema_version": 1,
        "history_days": 30,
        "non_deferrable": [[1.0, 0.5, 1.5]] * 168,
        "consumers": {},
    }


def _make_section(
    *,
    fingerprint: str = "fp-1",
    trained_at: str = "2026-03-20T03:00:00+01:00",
    last_outcome: str = "profile_trained",
    data: dict | None = -1,  # type: ignore[assignment]
) -> dict:
    return {
        "data": _make_profile_data() if data == -1 else data,
        "fingerprint": fingerprint,
        "trained_at": trained_at,
        "last_outcome": last_outcome,
        "error_reason": None,
    }


class CoordinatorHouseProfileAdoptionTests(unittest.TestCase):
    """Which of the three cases a stored profile falls into on startup.

    A config save is a restart, so this one decision covers startup and config
    save both; the setup path refits exactly when this returns a reason.
    """

    def _make_coordinator(self, section: dict | None) -> HelmanCoordinator:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._training_artifacts_store = types.SimpleNamespace(
            house_consumption=section
        )
        return coordinator

    def test_a_fresh_matching_profile_triggers_nothing(self) -> None:
        coordinator = self._make_coordinator(_make_section())

        reason = coordinator._adopt_stored_house_profile(config_fingerprint="fp-1")

        self.assertIsNone(reason)
        self.assertIsNotNone(coordinator._house_profile)
        self.assertEqual(coordinator._house_profile.history_days, 30)
        self.assertEqual(coordinator._house_profile_last_outcome, "profile_trained")

    def test_a_missing_profile_serves_nothing_and_refits(self) -> None:
        coordinator = self._make_coordinator(None)

        reason = coordinator._adopt_stored_house_profile(config_fingerprint="fp-1")

        self.assertEqual(reason, "no_stored_profile")
        self.assertIsNone(coordinator._house_profile)

    def test_a_fingerprint_stale_profile_is_blanked_and_refitted(self) -> None:
        """G3: the config change has to be visible, so the old answer to a
        question the user has since changed must not be served."""
        coordinator = self._make_coordinator(_make_section(fingerprint="fp-old"))

        reason = coordinator._adopt_stored_house_profile(config_fingerprint="fp-new")

        self.assertEqual(reason, "config_changed")
        self.assertIsNone(coordinator._house_profile)

    def test_a_profile_older_than_48h_keeps_serving_while_it_refits(self) -> None:
        coordinator = self._make_coordinator(
            _make_section(trained_at="2026-03-17T03:00:00+01:00")
        )

        reason = coordinator._adopt_stored_house_profile(config_fingerprint="fp-1")

        self.assertEqual(reason, "profile_expired")
        self.assertIsNotNone(coordinator._house_profile)

    def test_an_unreadable_profile_is_treated_as_missing(self) -> None:
        coordinator = self._make_coordinator(
            _make_section(data={"schema_version": 99})
        )

        reason = coordinator._adopt_stored_house_profile(config_fingerprint="fp-1")

        self.assertEqual(reason, "unreadable_profile")
        self.assertIsNone(coordinator._house_profile)

    def test_a_failed_refit_keeps_serving_and_carries_its_outcome(self) -> None:
        """The store preserved the previous fit; the coordinator adopts it and
        reports the failure so the banner can name it."""
        coordinator = self._make_coordinator(
            _make_section(last_outcome="training_failed")
        )

        reason = coordinator._adopt_stored_house_profile(config_fingerprint="fp-1")

        self.assertIsNone(reason)
        self.assertIsNotNone(coordinator._house_profile)
        self.assertEqual(coordinator._house_profile_last_outcome, "training_failed")


class HouseProfileRefitDeferralTests(unittest.TestCase):
    """The startup refit waits for Home Assistant to finish starting.

    Regression guard. Run during ``async_setup``, the fit can read the house
    energy entity before its own integration has registered it, record
    ``entity_missing``, and leave the house forecast unavailable until the next
    nightly run. Observed live: the entity turned up about eighty seconds after
    setup.
    """

    def _make_coordinator(self) -> tuple[HelmanCoordinator, list, list]:
        started_callbacks: list = []
        runs: list[str] = []

        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = types.SimpleNamespace()
        coordinator._unsub_listeners = []
        coordinator._training_batch = types.SimpleNamespace(
            async_run_house_consumption=lambda *, reason: runs.append(reason)
        )
        coordinator._create_tracked_refresh_task = lambda awaitable: awaitable
        return coordinator, started_callbacks, runs

    def test_the_refit_does_not_run_before_home_assistant_has_started(self) -> None:
        coordinator, started_callbacks, runs = self._make_coordinator()

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            side_effect=lambda hass, cb: (
                started_callbacks.append(cb) or (lambda: None)
            ),
        ):
            coordinator._schedule_house_profile_refit("no_stored_profile")

        self.assertEqual(runs, [])
        self.assertEqual(len(started_callbacks), 1)

        started_callbacks[0](coordinator._hass)

        self.assertEqual(runs, ["no_stored_profile"])

    def test_the_registration_is_unsubscribed_on_teardown(self) -> None:
        coordinator, _started_callbacks, _runs = self._make_coordinator()

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            return_value=lambda: None,
        ):
            coordinator._schedule_house_profile_refit("config_changed")

        self.assertEqual(len(coordinator._unsub_listeners), 1)

    def test_no_batch_means_no_registration(self) -> None:
        coordinator, _started_callbacks, _runs = self._make_coordinator()
        coordinator._training_batch = None

        with unittest.mock.patch.object(
            coordinator_module, "async_at_started"
        ) as at_started:
            coordinator._schedule_house_profile_refit("no_stored_profile")

        at_started.assert_not_called()
        self.assertEqual(coordinator._unsub_listeners, [])


class ForecastStalenessTests(unittest.TestCase):
    def test_a_healthy_outcome_leaves_the_age_rule_alone(self) -> None:
        self.assertIsNone(
            coordinator_module._build_house_profile_health(
                {"lastOutcome": "profile_trained"}
            )
        )

    def test_each_failing_outcome_has_its_own_localizable_reason(self) -> None:
        for last_outcome, expected_reason in (
            ("insufficient_history", "house_profile_insufficient_history"),
            ("entity_missing", "house_profile_entity_missing"),
            ("training_failed", "house_profile_training_failed"),
        ):
            with self.subTest(last_outcome=last_outcome):
                health = coordinator_module._build_house_profile_health(
                    {
                        "lastOutcome": last_outcome,
                        "historyDaysAvailable": 3,
                        "requiredHistoryDays": 14,
                    }
                )
                self.assertIsNotNone(health)
                self.assertEqual(health[0], expected_reason)
                # The numeric detail lives in the hint, because `localize`
                # takes no interpolation parameters.
                self.assertTrue(health[1])

    def test_the_override_wins_over_a_fresh_snapshot(self) -> None:
        staleness = coordinator_module._build_forecast_staleness(
            REFERENCE_TIME.isoformat(),
            reference_time=REFERENCE_TIME,
            override=("house_profile_training_failed", "check the log"),
        )

        self.assertTrue(staleness["isStale"])
        self.assertEqual(staleness["reason"], "house_profile_training_failed")
        self.assertEqual(staleness["hint"], "check the log")

    def test_without_an_override_age_still_decides(self) -> None:
        staleness = coordinator_module._build_forecast_staleness(
            REFERENCE_TIME.isoformat(),
            reference_time=REFERENCE_TIME,
        )

        self.assertFalse(staleness["isStale"])
        self.assertIsNone(staleness["reason"])


if __name__ == "__main__":
    unittest.main()
