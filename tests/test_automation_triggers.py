from __future__ import annotations

import asyncio
import importlib
import sys
import types
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

from _ha_stubs import (
    install_helman_packages,
    restore_modules,
    snapshot_modules,
    stub_module,
)


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
    previous_modules = snapshot_modules(_STUBBED_MODULES)

    install_helman_packages("scheduling")

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

    recorder_slots_mod = types.ModuleType("custom_components.helman.recorder_hourly_series")

    recorder_slots_mod.own_energy_changes = lambda meter, children, *, slot: dict(meter)
    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    recorder_slots_mod.SWITCH_ACTIVE_STATES = ("on",)
    recorder_slots_mod.CLIMATE_ACTIVE_STATES = ("heat", "cool")
    recorder_slots_mod.get_today_completed_local_hours = lambda *args, **kwargs: []
    recorder_slots_mod.get_today_completed_local_slots = lambda *args, **kwargs: []

    async def _query_cumulative_hourly_energy_changes(*args, **kwargs):
        return {}

    recorder_slots_mod.query_cumulative_hourly_energy_changes = (
        _query_cumulative_hourly_energy_changes
    )
    recorder_slots_mod.query_cumulative_hourly_energy_changes = (
        lambda *args, **kwargs: []
    )
    recorder_slots_mod.query_slot_energy_changes = lambda *args, **kwargs: []
    class _ApplianceRuntimeHistoryReader:
        def __init__(self, hass):
            self.hass = hass

        async def async_query_active_hours_by_local_date(self, requests, **kwargs):
            return {request.key: {} for request in requests}

    recorder_slots_mod.ApplianceRuntimeHistoryReader = _ApplianceRuntimeHistoryReader
    recorder_slots_mod.ApplianceRuntimeRequest = type(
        "ApplianceRuntimeRequest",
        (SimpleNamespace,),
        {},
    )

    class _TodaySlotEnergyReader:
        def __init__(self, hass):
            self.hass = hass

        async def async_query_slot_energy_changes(self, *args, **kwargs):
            return {}

    recorder_slots_mod.TodaySlotEnergyReader = _TodaySlotEnergyReader

    class _TodaySlotBoundaryStateReader:
        def __init__(self, hass):
            self.hass = hass

        async def async_query_slot_boundary_state_values(self, *args, **kwargs):
            return {}

    recorder_slots_mod.TodaySlotBoundaryStateReader = _TodaySlotBoundaryStateReader
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    tree_builder_mod = types.ModuleType("custom_components.helman.tree_builder")
    tree_builder_mod.HelmanTreeBuilder = type("HelmanTreeBuilder", (), {})
    sys.modules[tree_builder_mod.__name__] = tree_builder_mod

    import homeassistant.components.energy.data  # type: ignore  # noqa: F401
    import homeassistant.core  # type: ignore  # noqa: F401
    import homeassistant.helpers.event  # type: ignore  # noqa: F401
    import homeassistant.helpers.storage  # type: ignore  # noqa: F401
    import homeassistant.util.dt  # type: ignore  # noqa: F401

    recorder_mod = stub_module("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: None
    recorder_mod.__path__ = []

    history_mod = stub_module("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}

    # ``automation.day_context_store`` builds a ``storage.Store``; force a
    # lightweight stub over the real ``homeassistant`` one, so a ``FakeHass``
    # without a real ``data``/``config`` can still back the store.
    helpers_pkg = stub_module("homeassistant.helpers")
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

    return previous_modules


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
    restore_modules(_previous_modules)
    for module_name in list(sys.modules):
        if (
            module_name not in _original_helman_modules
            and (
                module_name == "custom_components.helman"
                or module_name.startswith("custom_components.helman.")
            )
        ):
            sys.modules.pop(module_name, None)

# The imported modules bound the real ``dt_util`` while the restore above drops
# it from ``sys.modules`` (so the conftest reaches a different object); pin the
# actually-bound module's default zone to Europe/Prague so ``as_local`` slot ids
# match the ``+01:00`` fixtures. A stubbed ``dt_util`` has no setter.
for _bound_module in (
    pipeline_module,
    triggers_module,
    coordinator_module,
    schedule_module,
):
    _bound_dt = getattr(_bound_module, "dt_util", None)
    if _bound_dt is not None and hasattr(_bound_dt, "set_default_time_zone"):
        _bound_dt.set_default_time_zone(_bound_dt.get_time_zone("Europe/Prague"))

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


class FakeBus:
    def __init__(self) -> None:
        self.fired: list[tuple[str, dict]] = []

    def async_fire(self, event_type: str, event_data: dict | None = None) -> None:
        self.fired.append((event_type, dict(event_data or {})))


class FakeHass:
    def __init__(self, states: dict[str, FakeState] | None = None) -> None:
        self.states = FakeStates(states or {})
        self.bus = FakeBus()
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
        self.is_running = True
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

    async def async_reconcile_and_wait(self, *, reason: str) -> None:
        self.events.append(f"reconcile:{reason}")
        if self.reconcile_error is not None:
            raise self.reconcile_error

    def request_reconcile(self, *, reason: str) -> None:
        self.events.append(f"request_reconcile:{reason}")

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
                    "system_optimizers": [
                        {
                            "id": "opt1",
                            "kind": "export_price",
                            "conditions": [{"when_price_below": 0.0}],
                        }
                    ],
                }
            },
        )
        coordinator._async_build_forecast_snapshots = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=True,
            )
        )

        await coordinator._async_run_forecast_refresh(
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
                    "system_optimizers": [
                        {
                            "id": "opt1",
                            "kind": "export_price",
                            "conditions": [{"when_price_below": 0.0}],
                        }
                    ],
                }
            },
        )
        coordinator._async_build_forecast_snapshots = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator._async_run_forecast_refresh(
            reason="slot_refresh",
            reference_time=REFERENCE_TIME,
        )

        coordinator._automation_triggers.request_debounced.assert_not_awaited()

    async def test_startup_refresh_still_runs_automation_when_execution_disabled(
        self,
    ) -> None:
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
        coordinator._async_build_forecast_snapshots = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator._async_run_forecast_refresh(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

        # Execution being off no longer suppresses the automation run.
        coordinator._automation_triggers.request_debounced.assert_awaited_once_with(
            reason="startup",
            reference_time=REFERENCE_TIME,
        )

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
        coordinator._async_build_forecast_snapshots = AsyncMock(
            return_value=coordinator_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator._async_run_forecast_refresh(
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

    async def test_disable_transition_keeps_automation_owned_actions(self) -> None:
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

        # Automation keeps planning while execution is off, so its actions stay
        # in the document for the card and the inspectors to display.
        self.assertFalse(enabled)
        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
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
                        }
                    },
                ),
                reference_time=REFERENCE_TIME,
            )

        self.assertTrue(changed)
        coordinator._automation_triggers.request_immediate.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
