from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .schedule import (
    EMPTY_SCHEDULE_ACTION,
    ScheduleAction,
    ScheduleDocument,
    ScheduleSlot,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
    materialize_schedule_slots,
    prune_expired_slots,
)


@dataclass(frozen=True)
class ScheduleForecastOverlay:
    horizon_start: datetime
    horizon_end: datetime
    slots: tuple[ScheduleSlot, ...]

    def lookup_slot(self, slot_start: datetime) -> ScheduleSlot | None:
        slot_id = format_slot_id(slot_start)
        for slot in self.slots:
            if slot.id == slot_id:
                return slot
        return None

    def lookup_action(self, slot_start: datetime) -> ScheduleAction:
        slot = self.lookup_slot(slot_start)
        if slot is None:
            return EMPTY_SCHEDULE_ACTION
        return slot.action


def build_schedule_forecast_overlay(
    *,
    schedule_document: ScheduleDocument,
    reference_time: datetime,
) -> ScheduleForecastOverlay:
    # Materializes whatever document it is handed, without consulting
    # ``execution_enabled``. Deciding that an unexecuted plan should forecast as
    # an unmanaged house is the caller's call, and the caller has to make it for
    # the appliance projection too; see
    # ``HelmanCoordinator._build_forecast_schedule_documents``, which hands this
    # an empty document when execution is off.
    pruned_slots = prune_expired_slots(
        stored_slots=schedule_document.slots,
        reference_time=reference_time,
    )
    materialized_slots = materialize_schedule_slots(
        stored_slots=pruned_slots,
        reference_time=reference_time,
    )
    return ScheduleForecastOverlay(
        horizon_start=build_horizon_start(reference_time),
        horizon_end=build_horizon_end(reference_time),
        # Rebuilt rather than passed through: the overlay answers for the
        # inverter only, and rebuilding from ``action`` is what drops each
        # slot's appliance controllables.
        slots=tuple(
            ScheduleSlot(id=slot.id, action=slot.action)
            for slot in materialized_slots
        ),
    )
