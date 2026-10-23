from __future__ import annotations

from _fakes import FakeState, FakeHass as BaseFakeHass, make_coordinator

import asyncio
import importlib
import types
import unittest
import pytest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:30:00+01:00"
pipeline_module = importlib.import_module("custom_components.helman.automation.pipeline")
triggers_module = importlib.import_module("custom_components.helman.automation.triggers")
coordinator_module = importlib.import_module("custom_components.helman.coordinator")
forecast_module = importlib.import_module("custom_components.helman.forecast.service")
const_module = importlib.import_module("custom_components.helman.const")
runtime_status_module = importlib.import_module("custom_components.helman.scheduling.runtime_status")
schedule_module = importlib.import_module("custom_components.helman.scheduling.schedule")


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    from homeassistant.util import dt as dt_util
    from custom_components.helman.automation import day_context_store
    from _fakes import DummyStore
    monkeypatch.setattr(dt_util, "now", lambda: REFERENCE_TIME)
    monkeypatch.setattr(day_context_store, "_DayBandStore", DummyStore)


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


class FakeHass(BaseFakeHass):
    def __init__(self, states: dict[str, FakeState] | None = None) -> None:
        super().__init__(states)
        self._tasks: set[asyncio.Task[None]] = set()

    def async_create_task(self, coro):
        task = super().async_create_task(coro)
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

    async def async_save_snapshots(
        self, *, house_snapshot: dict, solar_snapshot: dict | None
    ) -> None:
        self.forecast_snapshot = house_snapshot


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
        coordinator = make_coordinator(_hass=FakeHass(), _storage=storage)
        executor = FakeExecutor()
        coordinator.schedule.executor = executor
        coordinator._automation_triggers = SimpleNamespace(
            request_immediate=AsyncMock(),
            request_debounced=AsyncMock(),
            async_shutdown=AsyncMock(),
        )
        coordinator.forecast._request_replan = (
            coordinator._automation_triggers.request_debounced
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
        coordinator.forecast._async_build_forecast_snapshots = AsyncMock(
            return_value=forecast_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=True,
            )
        )

        await coordinator.forecast._async_run_forecast_refresh(
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
        coordinator.forecast._async_build_forecast_snapshots = AsyncMock(
            return_value=forecast_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator.forecast._async_run_forecast_refresh(
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
        coordinator.forecast._async_build_forecast_snapshots = AsyncMock(
            return_value=forecast_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator.forecast._async_run_forecast_refresh(
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
        coordinator.forecast._async_build_forecast_snapshots = AsyncMock(
            return_value=forecast_module._ForecastRefreshResult(
                forecast_refreshed=True,
                bundle_ready=False,
            )
        )

        await coordinator.forecast._async_run_forecast_refresh(
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

        self.assertTrue(enabled["executionEnabled"])
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

        self.assertTrue(enabled["executionEnabled"])
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
        self.assertFalse(enabled["executionEnabled"])
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

        async with coordinator.schedule.locked(REFERENCE_TIME):
            changed = await coordinator.schedule.persist_automation_result(
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
