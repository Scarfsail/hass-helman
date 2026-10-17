"""Slot ids, the slot length and the schedule errors — the leaf of scheduling.

:mod:`.schedule` builds the document on top of the appliance normalizers, while
the appliance drivers and the projection builder only need these few names. Kept
here, below both, they no longer import each other; :mod:`.schedule` re-exports
them for every existing importer.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.util import dt as dt_util

from ..const import SCHEDULE_SLOT_MINUTES

SCHEDULE_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)


class ScheduleError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ScheduleSlotsError(ScheduleError):
    def __init__(self, message: str) -> None:
        super().__init__("invalid_slots", message)


class ScheduleExecutionUnavailableError(ScheduleError):
    def __init__(self, message: str) -> None:
        super().__init__("execution_unavailable", message)


def parse_slot_id(slot_id: str) -> datetime:
    parsed = dt_util.parse_datetime(slot_id)
    if parsed is None or parsed.tzinfo is None:
        raise ScheduleSlotsError(
            "Schedule slot ids must be timezone-aware ISO timestamps"
        )
    return dt_util.as_local(parsed)


def format_slot_id(slot_start: datetime) -> str:
    return dt_util.as_local(slot_start).isoformat(timespec="seconds")
