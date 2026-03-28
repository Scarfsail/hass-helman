from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from homeassistant.util import dt as dt_util

from ..const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    SCHEDULE_SLOT_MINUTES,
)
from .schedule import (
    NORMAL_SCHEDULE_ACTION,
    ScheduleAction,
    ScheduleDocument,
    ScheduleSlot,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
    materialize_schedule_slots,
    parse_slot_id,
    prune_expired_slots,
)

if (
    SCHEDULE_SLOT_MINUTES < FORECAST_CANONICAL_GRANULARITY_MINUTES
    or SCHEDULE_SLOT_MINUTES % FORECAST_CANONICAL_GRANULARITY_MINUTES != 0
):
    raise ValueError(
        "SCHEDULE_SLOT_MINUTES must be a whole multiple of "
        "FORECAST_CANONICAL_GRANULARITY_MINUTES"
    )

_CANONICAL_SLOT_DURATION = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
_CANONICAL_SLOTS_PER_SCHEDULE_SLOT = (
    SCHEDULE_SLOT_MINUTES // FORECAST_CANONICAL_GRANULARITY_MINUTES
)


@dataclass(frozen=True)
class ScheduleForecastOverlay:
    horizon_start: datetime
    horizon_end: datetime
    canonical_slot_minutes: int
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
            return NORMAL_SCHEDULE_ACTION
        return slot.action


def build_schedule_forecast_overlay(
    *,
    schedule_document: ScheduleDocument,
    reference_time: datetime,
) -> ScheduleForecastOverlay:
    pruned_slots = (
        prune_expired_slots(
            stored_slots=schedule_document.slots,
            reference_time=reference_time,
        )
        if schedule_document.execution_enabled
        else {}
    )
    materialized_slots = materialize_schedule_slots(
        stored_slots=pruned_slots,
        reference_time=reference_time,
    )
    horizon_start = build_horizon_start(reference_time)
    horizon_end = build_horizon_end(reference_time)
    canonical_slots: list[ScheduleSlot] = []

    for schedule_slot in materialized_slots:
        schedule_slot_start = parse_slot_id(schedule_slot.id)
        for offset in range(_CANONICAL_SLOTS_PER_SCHEDULE_SLOT):
            canonical_slot_start = _advance_canonical_slots(
                schedule_slot_start,
                slot_count=offset,
            )
            if canonical_slot_start >= horizon_end:
                break
            canonical_slots.append(
                ScheduleSlot(
                    id=format_slot_id(canonical_slot_start),
                    action=schedule_slot.action,
                )
            )

    return ScheduleForecastOverlay(
        horizon_start=horizon_start,
        horizon_end=horizon_end,
        canonical_slot_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        slots=tuple(canonical_slots),
    )


def _advance_canonical_slots(value: datetime, *, slot_count: int) -> datetime:
    return dt_util.as_local(
        dt_util.as_utc(value) + (_CANONICAL_SLOT_DURATION * slot_count)
    )
