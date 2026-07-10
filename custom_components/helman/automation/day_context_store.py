"""Per-calendar-day freeze store for day-scoped automation rules (A4).

A tiny JSON store keyed by local calendar date holding the stability-sensitive
fields of a ``DayContext`` — its classification and day-min window — plus when
they were frozen. Everything else in a ``DayContext`` is recomputed live each
run; only these fields are pinned so a rule's decision cannot flip mid-day.

This is the one deliberate, narrowly scoped exception to the stateless-optimizer
model; it is framework-owned and invisible to the optimizer contract.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import storage
from homeassistant.util import dt as dt_util

from ..const import DAY_CONTEXT_STORAGE_KEY, DAY_CONTEXT_STORAGE_VERSION
from .day_context import DayMinWindow, FrozenDayContext


class DayContextStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(
            hass, DAY_CONTEXT_STORAGE_VERSION, DAY_CONTEXT_STORAGE_KEY
        )
        self._records: dict[date, dict[str, Any]] | None = None

    async def async_load(self) -> dict[date, FrozenDayContext]:
        stored = await self._store.async_load()
        self._records = _deserialize_records(stored)
        return {
            local_date: _record_to_frozen(record)
            for local_date, record in self._records.items()
        }

    async def async_freeze_and_prune(
        self,
        *,
        computed: dict[date, FrozenDayContext],
        today: date,
    ) -> None:
        """Persist frozen fields for days not yet frozen; drop past days.

        Days already present keep their frozen record (they are the source of
        truth reused on the next run). New days in ``computed`` are added. Any
        record whose date is before ``today`` is pruned.
        """
        if self._records is None:
            self._records = {}

        changed = False
        for local_date in list(self._records):
            if local_date < today:
                del self._records[local_date]
                changed = True

        for local_date, frozen in computed.items():
            if local_date < today or local_date in self._records:
                continue
            self._records[local_date] = _frozen_to_record(frozen)
            changed = True

        if changed:
            await self._store.async_save(_serialize_records(self._records))


def _record_to_frozen(record: dict[str, Any]) -> FrozenDayContext:
    return FrozenDayContext(
        classification=record["classification"],
        day_min_window=_deserialize_window(record.get("dayMinWindow")),
    )


def _frozen_to_record(frozen: FrozenDayContext) -> dict[str, Any]:
    return {
        "classification": frozen.classification,
        "dayMinWindow": _serialize_window(frozen.day_min_window),
        "frozenAt": dt_util.now().isoformat(),
    }


def _serialize_records(
    records: dict[date, dict[str, Any]],
) -> dict[str, Any]:
    return {
        "records": {
            local_date.isoformat(): record
            for local_date, record in records.items()
        }
    }


def _deserialize_records(stored: Any) -> dict[date, dict[str, Any]]:
    records: dict[date, dict[str, Any]] = {}
    if not isinstance(stored, dict):
        return records
    raw_records = stored.get("records")
    if not isinstance(raw_records, dict):
        return records
    for raw_date, record in raw_records.items():
        if not isinstance(record, dict) or "classification" not in record:
            continue
        try:
            local_date = date.fromisoformat(str(raw_date))
        except ValueError:
            continue
        records[local_date] = record
    return records


def _serialize_window(window: DayMinWindow | None) -> dict[str, str] | None:
    if window is None:
        return None
    return {"start": window.start.isoformat(), "end": window.end.isoformat()}


def _deserialize_window(raw: Any) -> DayMinWindow | None:
    if not isinstance(raw, dict):
        return None
    start = _parse_datetime(raw.get("start"))
    end = _parse_datetime(raw.get("end"))
    if start is None or end is None:
        return None
    return DayMinWindow(start=start, end=end)


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = dt_util.parse_datetime(value)
    if parsed is None or parsed.tzinfo is None:
        return None
    return dt_util.as_local(parsed)
