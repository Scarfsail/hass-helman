"""The schedule service: one prune for every reader, and its lock discipline."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import Mock

from _fakes import (
    CURRENT_SLOT_ID,
    REFERENCE_TIME,
    FakeHass,
    FakeStorage,
    make_coordinator,
)

from custom_components.helman.const import SCHEDULE_SLOT_MINUTES
from custom_components.helman.scheduling.schedule import (
    ScheduleDocument,
    schedule_document_to_dict,
)

PREVIOUS_SLOT_ID = "2026-03-20T20:45:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:15:00+01:00"
_REMOVED_APPLIANCE_ACTION = {
    "charge": True,
    "vehicleId": "ghost",
    "useMode": "Fast",
}


def _stored_document() -> dict:
    """An ended slot, and actions for an appliance no longer configured."""
    return {
        "executionEnabled": True,
        "slotMinutes": SCHEDULE_SLOT_MINUTES,
        "slots": {
            PREVIOUS_SLOT_ID: {"inverter": {"kind": "stop_charging"}},
            CURRENT_SLOT_ID: {
                "inverter": {"kind": "stop_charging"},
                "removed-ev": dict(_REMOVED_APPLIANCE_ACTION),
            },
            NEXT_SLOT_ID: {"removed-ev": dict(_REMOVED_APPLIANCE_ACTION)},
        },
    }


#: What every reader works from: the ended slot is gone, the removed
#: appliance's actions are gone, and the slot holding nothing else goes too.
_EXPECTED_DOCUMENT = {
    "executionEnabled": True,
    "slotMinutes": SCHEDULE_SLOT_MINUTES,
    "slots": {CURRENT_SLOT_ID: {"inverter": {"kind": "stop_charging"}}},
}


def _build(stored_document: dict | None = None):
    hass = FakeHass()
    storage = FakeStorage(
        schedule_document=(
            _stored_document() if stored_document is None else stored_document
        )
    )
    coordinator = make_coordinator(_hass=hass, _storage=storage)
    return coordinator.schedule, storage, hass


class OnePruneTests(unittest.IsolatedAsyncioTestCase):
    async def test_executor_and_service_readers_see_the_same_pruned_document(
        self,
    ) -> None:
        # The executor used to prune ended slots only, so a removed appliance's
        # actions survived its reads while the coordinator's readers dropped
        # them: the same document was "changed" for one and not the other.
        service_side, service_storage, _ = _build()
        executor_side, executor_storage, _ = _build()
        executed = []

        async def capture(*, schedule_document, request_now):
            executed.append(schedule_document)

        executor_side.executor._async_execute_snapshot = capture

        read = await service_side.read(REFERENCE_TIME)
        await executor_side.executor.async_reconcile(
            reason="test", reference_time=REFERENCE_TIME
        )

        self.assertEqual(executed, [read])
        self.assertEqual(
            {**schedule_document_to_dict(read), "slotMinutes": SCHEDULE_SLOT_MINUTES},
            _EXPECTED_DOCUMENT,
        )
        self.assertEqual(service_storage.schedule_document, _EXPECTED_DOCUMENT)
        self.assertEqual(executor_storage.schedule_document, _EXPECTED_DOCUMENT)

    async def test_the_prune_is_persisted_quietly(self) -> None:
        schedule, storage, hass = _build()

        await schedule.read(REFERENCE_TIME)

        self.assertEqual(storage.schedule_document, _EXPECTED_DOCUMENT)
        self.assertEqual(hass.bus.fired, [])

    async def test_a_pruned_document_is_not_rewritten(self) -> None:
        schedule, storage, _ = _build()
        await schedule.read(REFERENCE_TIME)

        await schedule.read(REFERENCE_TIME)

        self.assertEqual(len(storage.saved_schedule_documents), 1)


class LockDisciplineTests(unittest.IsolatedAsyncioTestCase):
    async def test_persist_runs_under_the_lock_without_taking_it_again(self) -> None:
        schedule, storage, _ = _build(
            {"executionEnabled": True, "slotMinutes": SCHEDULE_SLOT_MINUTES, "slots": {}}
        )

        async with asyncio.timeout(1):
            async with schedule.locked(REFERENCE_TIME) as document:
                self.assertTrue(schedule._lock.locked())
                changed = await schedule.persist_automation_result(
                    automation_result=ScheduleDocument(
                        execution_enabled=document.execution_enabled,
                        slots={
                            NEXT_SLOT_ID: {"inverter": {"kind": "stop_discharging"}},
                        },
                    ),
                    reference_time=REFERENCE_TIME,
                )

        self.assertTrue(changed)
        self.assertFalse(schedule._lock.locked())
        self.assertEqual(
            storage.schedule_document["slots"][NEXT_SLOT_ID]["inverter"]["setBy"],
            "automation",
        )

    async def test_a_write_requests_execution_only_through_the_caller(self) -> None:
        # The service's own writes never call back out -- not into the
        # forecast, and not into the executor: requesting a reconcile is the
        # caller's decision, made after the lock is released.
        schedule, _, _ = _build()
        schedule.executor.request_reconcile = Mock()

        await schedule.cleanup_automation_owned_actions(reference_time=REFERENCE_TIME)
        async with schedule.locked(REFERENCE_TIME):
            await schedule.save(ScheduleDocument(execution_enabled=False))

        schedule.executor.request_reconcile.assert_not_called()


if __name__ == "__main__":
    unittest.main()
