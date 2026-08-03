"""The backend half of automatic UI refresh.

An open card only learns that its data has been replaced if the integration
says so. These tests pin the emit contract: every schedule write announces
itself, an automation run announces itself even when it wrote nothing, and a
no-op write stays silent so a client is never woken for nothing.

The coordinator fixtures live in ``test_coordinator_schedule_execution`` --
importing that module installs the same ``sys.modules`` stubs this one needs,
which is safe precisely because the suite runs one process per file.
"""

from __future__ import annotations

import unittest

from test_coordinator_schedule_execution import (  # noqa: E402
    CURRENT_SLOT_ID,
    REFERENCE_TIME,
    FakeExecutor,
    FakeHass,
    FakeStorage,
    _domains_payload,
)

from custom_components.helman.const import (  # noqa: E402
    DATA_CHANGED_KIND_PLAN,
    DATA_CHANGED_KIND_SCHEDULE,
    EVENT_DATA_CHANGED,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_SLOT_MINUTES,
)
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleSlot,
)


class _StubRunResult:
    """The two attributes ``_set_last_automation_run_result`` reads.

    ``ran_automation=False`` is the interesting case: the run happened, the
    merged plan matched what was stored, nothing was written -- and the cards
    still have to reload, because the explanation book and the derived
    forecasts moved underneath them.
    """

    ran_automation = False
    snapshot = None


class DataChangedEventTests(unittest.IsolatedAsyncioTestCase):
    def _build_coordinator(
        self,
        *,
        schedule_document: dict,
    ) -> tuple[HelmanCoordinator, FakeStorage, FakeHass]:
        persisted = dict(schedule_document)
        persisted.setdefault("slotMinutes", SCHEDULE_SLOT_MINUTES)
        storage = FakeStorage(schedule_document=persisted)
        hass = FakeHass()
        coordinator = HelmanCoordinator(hass, storage)
        coordinator._schedule_executor = FakeExecutor()
        return coordinator, storage, hass

    @staticmethod
    def _data_changed_kinds(hass: FakeHass) -> list[str]:
        return [
            data.get("kind")
            for event_type, data in hass.bus.fired
            if event_type == EVENT_DATA_CHANGED
        ]

    async def test_user_edit_announces_the_schedule(self) -> None:
        coordinator, _storage, hass = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )

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

        self.assertEqual(
            self._data_changed_kinds(hass),
            [DATA_CHANGED_KIND_SCHEDULE],
        )

    async def test_execution_toggle_announces_the_schedule(self) -> None:
        coordinator, _storage, hass = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )

        await coordinator.set_schedule_execution(
            enabled=True,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            self._data_changed_kinds(hass),
            [DATA_CHANGED_KIND_SCHEDULE],
        )

    async def test_run_that_wrote_nothing_still_announces_the_plan(self) -> None:
        coordinator, _storage, hass = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )

        coordinator._set_last_automation_run_result(_StubRunResult())

        self.assertEqual(
            self._data_changed_kinds(hass),
            [DATA_CHANGED_KIND_PLAN],
        )

    async def test_write_that_changes_nothing_stays_silent(self) -> None:
        # Re-applying the slot the document already holds, unstamped:
        # ``set_schedule`` compares before saving, so no write happens and no
        # client should be woken to re-fetch what it is already showing. Passing
        # ``set_by="user"`` here would *not* be a no-op -- the stamp itself is a
        # document change, and it correctly does announce.
        coordinator, _storage, hass = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                )
            ],
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(self._data_changed_kinds(hass), [])


if __name__ == "__main__":
    unittest.main()
