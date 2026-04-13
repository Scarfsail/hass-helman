from __future__ import annotations

import asyncio
import importlib
import sys
import types
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:30:00+01:00"
_STUBBED_MODULES = (
    "custom_components",
    "custom_components.helman",
    "custom_components.helman.battery_capacity_forecast_builder",
    "custom_components.helman.consumption_forecast_builder",
    "custom_components.helman.forecast_builder",
    "custom_components.helman.recorder_hourly_series",
    "custom_components.helman.scheduling",
    "custom_components.helman.tree_builder",
    "homeassistant",
    "homeassistant.components",
    "homeassistant.components.energy",
    "homeassistant.components.energy.data",
    "homeassistant.components.recorder",
    "homeassistant.components.recorder.history",
    "homeassistant.core",
    "homeassistant.helpers",
    "homeassistant.helpers.entity_registry",
    "homeassistant.helpers.event",
    "homeassistant.helpers.storage",
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
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

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
        {"_make_payload": staticmethod(lambda **kwargs: kwargs)},
    )
    sys.modules[consumption_builder_mod.__name__] = consumption_builder_mod

    forecast_builder_mod = types.ModuleType("custom_components.helman.forecast_builder")
    forecast_builder_mod.HelmanForecastBuilder = type(
        "HelmanForecastBuilder",
        (),
        {},
    )
    sys.modules[forecast_builder_mod.__name__] = forecast_builder_mod

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
    recorder_slots_mod.get_today_completed_local_hours = lambda *args, **kwargs: []
    recorder_slots_mod.get_today_completed_local_slots = lambda *args, **kwargs: []
    recorder_slots_mod.query_slot_boundary_state_values = (
        lambda *args, **kwargs: {}
    )
    recorder_slots_mod.query_cumulative_hourly_energy_changes = (
        lambda *args, **kwargs: []
    )
    recorder_slots_mod.query_slot_energy_changes = lambda *args, **kwargs: []
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    tree_builder_mod = types.ModuleType("custom_components.helman.tree_builder")
    tree_builder_mod.HelmanTreeBuilder = type("HelmanTreeBuilder", (), {})
    sys.modules[tree_builder_mod.__name__] = tree_builder_mod

    try:
        import homeassistant.components.energy.data  # type: ignore  # noqa: F401
        import homeassistant.core  # type: ignore  # noqa: F401
        import homeassistant.helpers.event  # type: ignore  # noqa: F401
        import homeassistant.helpers.storage  # type: ignore  # noqa: F401
        import homeassistant.util.dt  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        homeassistant_pkg = sys.modules.get("homeassistant")
        if homeassistant_pkg is None:
            homeassistant_pkg = types.ModuleType("homeassistant")
            sys.modules["homeassistant"] = homeassistant_pkg
        homeassistant_pkg.__path__ = []

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
        components_pkg.__path__ = []

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
        energy_pkg.__path__ = []

        energy_data_mod = sys.modules.get("homeassistant.components.energy.data")
        if energy_data_mod is None:
            energy_data_mod = types.ModuleType("homeassistant.components.energy.data")
            sys.modules["homeassistant.components.energy.data"] = energy_data_mod

        async def async_get_manager(hass):
            return types.SimpleNamespace(
                async_listen_updates=lambda callback: lambda: None
            )

        energy_data_mod.async_get_manager = async_get_manager

        helpers_pkg = sys.modules.get("homeassistant.helpers")
        if helpers_pkg is None:
            helpers_pkg = types.ModuleType("homeassistant.helpers")
            sys.modules["homeassistant.helpers"] = helpers_pkg
        helpers_pkg.__path__ = []

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

        storage_mod = sys.modules.get("homeassistant.helpers.storage")
        if storage_mod is None:
            storage_mod = types.ModuleType("homeassistant.helpers.storage")
            sys.modules["homeassistant.helpers.storage"] = storage_mod

        class DummyStore:
            def __init__(self, hass, version, key) -> None:
                self._data = None

            async def async_load(self):
                return self._data

            async def async_save(self, data) -> None:
                self._data = data

        storage_mod.Store = DummyStore

        entity_registry_mod = sys.modules.get("homeassistant.helpers.entity_registry")
        if entity_registry_mod is None:
            entity_registry_mod = types.ModuleType(
                "homeassistant.helpers.entity_registry"
            )
            sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod

        util_pkg = sys.modules.get("homeassistant.util")
        if util_pkg is None:
            util_pkg = types.ModuleType("homeassistant.util")
            sys.modules["homeassistant.util"] = util_pkg
        util_pkg.__path__ = []

        dt_mod = sys.modules.get("homeassistant.util.dt")
        if dt_mod is None:
            dt_mod = types.ModuleType("homeassistant.util.dt")
            sys.modules["homeassistant.util.dt"] = dt_mod
        dt_mod.parse_datetime = datetime.fromisoformat
        dt_mod.as_local = lambda value: value
        dt_mod.as_utc = lambda value: value
        dt_mod.now = lambda: REFERENCE_TIME
        util_pkg.dt = dt_mod

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
    pipeline_module = importlib.import_module("custom_components.helman.automation.pipeline")
    triggers_module = importlib.import_module("custom_components.helman.automation.triggers")
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
    const_module = importlib.import_module("custom_components.helman.const")
    runtime_status_module = importlib.import_module(
        "custom_components.helman.scheduling.runtime_status"
    )
    schedule_module = importlib.import_module(
        "custom_components.helman.scheduling.schedule"
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

AutomationRunResult = pipeline_module.AutomationRunResult
AutomationTriggerCoordinator = triggers_module.AutomationTriggerCoordinator
HelmanCoordinator = coordinator_module.HelmanCoordinator
SCHEDULE_ACTION_STOP_CHARGING = const_module.SCHEDULE_ACTION_STOP_CHARGING
SCHEDULE_SLOT_MINUTES = const_module.SCHEDULE_SLOT_MINUTES
ScheduleExecutionStatus = runtime_status_module.ScheduleExecutionStatus
ScheduleAction = schedule_module.ScheduleAction
ScheduleDocument = schedule_module.ScheduleDocument
ScheduleError = schedule_module.ScheduleError
ScheduleSlot = schedule_module.ScheduleSlot


def _domains_payload(
    kind: str,
    *,
    set_by: str | None = None,
) -> dict:
    inverter = {"kind": kind}
    if set_by is not None:
        inverter["setBy"] = set_by
    return {
        "inverter": inverter,
        "appliances": {},
    }


class FakeState:
    def __init__(self, state: str, *, attributes: dict | None = None) -> None:
        self.state = state
        self.attributes = attributes or {}


class FakeStates:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states

    def get(self, entity_id: str) -> FakeState | None:
        return self._states.get(entity_id)


class FakeHass:
    def __init__(self, states: dict[str, FakeState] | None = None) -> None:
        self.states = FakeStates(states or {})
        self._tasks: set[asyncio.Task[None]] = set()

    def async_create_task(self, coro):
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task


class FakeStorage:
    def __init__(
        self,
        *,
        schedule_document: dict,
        config: dict | None = None,
        forecast_snapshot: dict | None = None,
    ) -> None:
        self.config = config or {}
        self.schedule_document = schedule_document
        self.forecast_snapshot = forecast_snapshot
        self.saved_schedule_documents: list[dict] = []

    async def async_save_schedule_document(self, schedule_document: dict) -> None:
        self.schedule_document = schedule_document
        self.saved_schedule_documents.append(schedule_document)

    async def async_save_snapshot(self, snapshot: dict) -> None:
        self.forecast_snapshot = snapshot


class FakeExecutor:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.reconcile_error: Exception | None = None
        self.restore_error: Exception | None = None
        self.execution_status = ScheduleExecutionStatus()

    async def async_start(self) -> None:
        self.events.append("start")

    async def async_stop(self) -> None:
        self.events.append("stop")

    async def async_unload(self) -> None:
        self.events.append("unload")

    async def async_reconcile(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        self.events.append(f"reconcile:{reason}")
        if self.reconcile_error is not None:
            raise self.reconcile_error

    async def async_reconcile_safely(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        self.events.append(f"safe_reconcile:{reason}")

    async def async_restore_normal(self, *, reason: str) -> None:
        self.events.append(f"restore:{reason}")
        if self.restore_error is not None:
            raise self.restore_error

    def get_execution_status(self) -> ScheduleExecutionStatus:
        return self.execution_status

    def reset_runtime(self) -> None:
        self.events.append("reset_runtime")

    def clear_appliance_memories(self) -> None:
        self.events.append("clear_appliance_memories")


class AutomationTriggerCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self) -> None:
        controller = getattr(self, "_controller", None)
        if controller is not None:
            await controller.async_shutdown()

    async def test_debounced_requests_collapse_to_one_run(self) -> None:
        calls: list[str] = []

        async def _run(request) -> None:
            calls.append(request.reason)

        self._controller = AutomationTriggerCoordinator(
            create_task=asyncio.create_task,
            run_callback=_run,
            debounce_seconds=0.01,
        )

        await self._controller.request_debounced(reason="slot_refresh")
        await self._controller.request_debounced(reason="slot_refresh")
        await self._controller.request_debounced(reason="startup")
        await asyncio.sleep(0.05)

        self.assertEqual(calls, ["startup"])

    async def test_immediate_request_cancels_pending_debounce(self) -> None:
        calls: list[str] = []

        async def _run(request) -> None:
            calls.append(request.reason)

        self._controller = AutomationTriggerCoordinator(
            create_task=asyncio.create_task,
            run_callback=_run,
            debounce_seconds=0.05,
        )

        await self._controller.request_debounced(reason="slot_refresh")
        await self._controller.request_immediate(reason="user_edit")
        await asyncio.sleep(0.08)

        self.assertEqual(calls, ["user_edit"])

    async def test_trigger_during_active_run_queues_exactly_one_follow_up(self) -> None:
        calls: list[str] = []
        first_run_started = asyncio.Event()
        release_first_run = asyncio.Event()

        async def _run(request) -> None:
            calls.append(request.reason)
            if len(calls) == 1:
                first_run_started.set()
                await release_first_run.wait()

        self._controller = AutomationTriggerCoordinator(
            create_task=asyncio.create_task,
            run_callback=_run,
            debounce_seconds=0.01,
        )

        await self._controller.request_immediate(reason="execution_enabled")
        await first_run_started.wait()
        await self._controller.request_debounced(reason="slot_refresh")
        await self._controller.request_debounced(reason="startup")
        release_first_run.set()
        await asyncio.sleep(0.05)

        self.assertEqual(calls, ["execution_enabled", "startup"])

    async def test_shutdown_ignores_late_requests(self) -> None:
        calls: list[str] = []

        async def _run(request) -> None:
            calls.append(request.reason)

        self._controller = AutomationTriggerCoordinator(
            create_task=asyncio.create_task,
            run_callback=_run,
            debounce_seconds=0.01,
        )

        await self._controller.async_shutdown()
        await self._controller.request_immediate(reason="user_edit")
        await self._controller.request_debounced(reason="slot_refresh")
        await asyncio.sleep(0.05)

        self.assertEqual(calls, [])


class CoordinatorAutomationTriggerTests(unittest.IsolatedAsyncioTestCase):
    def _build_coordinator(
        self,
        *,
        schedule_document: dict,
        config: dict | None = None,
    ) -> tuple[HelmanCoordinator, FakeStorage, FakeExecutor]:
        persisted_schedule_document = dict(schedule_document)
        if "slotMinutes" not in persisted_schedule_document:
            persisted_schedule_document["slotMinutes"] = SCHEDULE_SLOT_MINUTES
        storage = FakeStorage(
            schedule_document=persisted_schedule_document,
            config=config,
        )
        coordinator = HelmanCoordinator(FakeHass(), storage)
        executor = FakeExecutor()
        coordinator._schedule_executor = executor
        coordinator._automation_triggers = SimpleNamespace(
            request_immediate=AsyncMock(),
            request_debounced=AsyncMock(),
            async_shutdown=AsyncMock(),
        )
        return coordinator, storage, executor

    async def test_refresh_wrapper_schedules_debounced_run_after_successful_refresh(
        self,
    ) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}},
            config={
                "automation": {
                    "enabled": True,
                    "optimizers": [{"id": "opt1", "kind": "export_price"}],
                }
            },
        )
        coordinator._async_refresh_forecast = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=True,
            )
        )

        await coordinator._async_refresh_forecast_and_request_automation(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

        coordinator._automation_triggers.request_debounced.assert_awaited_once_with(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

    async def test_refresh_wrapper_skips_enabled_automation_without_bundle(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}},
            config={
                "automation": {
                    "enabled": True,
                    "optimizers": [{"id": "opt1", "kind": "export_price"}],
                }
            },
        )
        coordinator._async_refresh_forecast = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator._async_refresh_forecast_and_request_automation(
            reason="slot_refresh",
            reference_time=REFERENCE_TIME,
        )

        coordinator._automation_triggers.request_debounced.assert_not_awaited()

    async def test_startup_refresh_does_not_cleanup_when_execution_disabled(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(
                        SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="automation",
                    )
                },
            }
        )
        coordinator._async_refresh_forecast = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator._async_refresh_forecast_and_request_automation(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

        coordinator._automation_triggers.request_debounced.assert_not_awaited()

    async def test_startup_refresh_schedules_cleanup_when_automation_disabled(
        self,
    ) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(
                        SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="automation",
                    )
                },
            },
        )
        coordinator._async_refresh_forecast = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator._async_refresh_forecast_and_request_automation(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

        coordinator._automation_triggers.request_debounced.assert_awaited_once_with(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

    async def test_enable_transition_triggers_immediate_run(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )

        enabled = await coordinator.set_schedule_execution(
            enabled=True,
            reference_time=REFERENCE_TIME,
        )

        self.assertTrue(enabled)
        coordinator._automation_triggers.request_immediate.assert_awaited_once_with(
            reason="execution_enabled",
            reference_time=REFERENCE_TIME,
        )

    async def test_already_enabled_does_not_trigger_extra_immediate_run(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )

        enabled = await coordinator.set_schedule_execution(
            enabled=True,
            reference_time=REFERENCE_TIME,
        )

        self.assertTrue(enabled)
        coordinator._automation_triggers.request_immediate.assert_not_awaited()

    async def test_disable_transition_strips_automation_owned_actions_once(self) -> None:
        coordinator, storage, _executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(
                        SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="automation",
                    ),
                    NEXT_SLOT_ID: _domains_payload(
                        SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="user",
                    ),
                },
            }
        )

        enabled = await coordinator.set_schedule_execution(
            enabled=False,
            reference_time=REFERENCE_TIME,
        )

        self.assertFalse(enabled)
        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    NEXT_SLOT_ID: _domains_payload(
                        SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="user",
                    )
                },
            },
        )

    async def test_user_authored_set_schedule_triggers_immediate_run(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )
        coordinator._async_run_post_schedule_write_side_effects = AsyncMock()

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                )
            ],
            reference_time=REFERENCE_TIME,
            set_by="user",
        )

        coordinator._async_run_post_schedule_write_side_effects.assert_awaited_once_with(
            reason="schedule_updated",
            reference_time=REFERENCE_TIME,
        )
        coordinator._automation_triggers.request_immediate.assert_awaited_once_with(
            reason="user_edit",
            reference_time=REFERENCE_TIME,
        )

    async def test_automation_authored_set_schedule_does_not_trigger_immediate_run(
        self,
    ) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )
        coordinator._async_run_post_schedule_write_side_effects = AsyncMock()

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                )
            ],
            reference_time=REFERENCE_TIME,
            set_by="automation",
        )

        coordinator._automation_triggers.request_immediate.assert_not_awaited()

    async def test_automation_persistence_write_does_not_self_trigger(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )

        async with coordinator._schedule_lock:
            changed = await coordinator._persist_automation_result_locked(
                automation_result=ScheduleDocument(
                    execution_enabled=True,
                    slots={
                        CURRENT_SLOT_ID: {
                            "inverter": {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                            "appliances": {},
                        }
                    },
                ),
                reference_time=REFERENCE_TIME,
            )

        self.assertTrue(changed)
        coordinator._automation_triggers.request_immediate.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
