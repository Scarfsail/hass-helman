from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import storage

from .const import (
    SOLAR_FORECAST_HISTORY_RETENTION_DAYS,
    SOLAR_FORECAST_HISTORY_STORAGE_KEY,
    SOLAR_FORECAST_HISTORY_STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

_SAVE_DELAY_SECONDS = 30
_SLOT_MINUTES = 15


class SolarForecastHistoryStore:
    """Rolling per-slot archive of the solar forecast at its own horizon.

    The source integration republishes the whole day's curve every few hours,
    revising slots that have already elapsed. Reading that curve back out of
    the recorder therefore says what the provider believed *after* the fact,
    which is a mix of local bias and weather the provider re-read -- and at a
    horizon that slides from near zero in the morning to half a day by evening.

    This archive keeps, for each slot, the value from the last rebuild that
    happened while the slot had not yet begun. The canonical rebuild is
    slot-aligned (``minute=[0, 15, 30, 45]``), so every slot is recorded at a
    horizon of 0-15 minutes and no slot is scored against a later revision of
    itself.

    That "not yet begun" test is the whole point and the one thing that must
    not be relaxed. ``BatteryForecastHistoryStore`` upserts every slot the
    snapshot carries because its snapshot only spans forward from the current
    slot; the solar curve spans the entire day, so an unguarded upsert would
    overwrite an elapsed slot with exactly the revision being avoided.

    Persisted shape:
      {"days": {"YYYY-MM-DD": {"HH:MM": wh}}}
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = storage.Store(
            hass,
            SOLAR_FORECAST_HISTORY_STORAGE_VERSION,
            SOLAR_FORECAST_HISTORY_STORAGE_KEY,
        )
        self._days: dict[str, dict[str, float]] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        days = stored.get("days") if isinstance(stored, dict) else None
        self._days = days if isinstance(days, dict) else {}

    def slots_for_day(self, target_date: date) -> dict[str, float]:
        """The archived ``HH:MM`` -> Wh map for a day, empty when nothing was recorded."""
        slots = self._days.get(target_date.isoformat())
        if not isinstance(slots, dict):
            return {}
        result: dict[str, float] = {}
        for slot, value in slots.items():
            if not _is_slot_label(slot):
                continue
            try:
                result[slot] = float(value)
            except (TypeError, ValueError):
                continue
        return result

    @callback
    def record_points(
        self,
        points: list[dict[str, Any]] | None,
        *,
        local_now: datetime,
        timezone: ZoneInfo,
    ) -> None:
        """Archive today's not-yet-started slots from a fresh forecast rebuild.

        ``points`` is the canonical ``rawPoints`` series -- pre-correction Wh on
        the 15-minute grid. Only points landing on today are considered, and
        only those whose slot has not started; everything already archived for
        the day survives untouched.
        """
        if not isinstance(points, list):
            return
        today = local_now.date()
        # The rebuild fires *at* the slot boundary, so its ``now`` is a few
        # milliseconds past it. Comparing at whole-minute resolution keeps the
        # slot that is just starting recordable at a horizon of zero, without
        # admitting a mid-slot rebuild -- one at 11:07 still floors to 11:07 and
        # leaves the 11:00 slot alone.
        cutoff = local_now.replace(second=0, microsecond=0)
        recorded = self.slots_for_day(today)
        changed = False
        for slot_start, value in _iter_points(points, timezone):
            if slot_start.date() != today:
                continue
            if slot_start.minute % _SLOT_MINUTES or slot_start.second:
                continue
            if slot_start < cutoff:
                continue
            slot = f"{slot_start.hour:02d}:{slot_start.minute:02d}"
            if recorded.get(slot) == value:
                continue
            recorded[slot] = value
            changed = True
        if not changed:
            return
        self._days[today.isoformat()] = recorded
        self._prune(today)
        self._store.async_delay_save(self._data_to_save, _SAVE_DELAY_SECONDS)

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {"days": self._days}

    def _prune(self, today: date) -> None:
        cutoff = today - timedelta(days=SOLAR_FORECAST_HISTORY_RETENTION_DAYS)
        for day in list(self._days):
            try:
                if date.fromisoformat(day) < cutoff:
                    del self._days[day]
            except ValueError:
                del self._days[day]


def _is_slot_label(slot: str) -> bool:
    """True for an "HH:MM" label that lands on a 15-minute slot boundary."""
    if not isinstance(slot, str):
        return False
    hour, _, minute = slot.partition(":")
    try:
        hour_value = int(hour)
        minute_value = int(minute)
    except ValueError:
        return False
    return (
        0 <= hour_value < 24
        and 0 <= minute_value < 60
        and minute_value % _SLOT_MINUTES == 0
    )


def _iter_points(points: list[dict[str, Any]], timezone: ZoneInfo):
    for point in points:
        if not isinstance(point, dict):
            continue
        ts_raw = point.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        value = point.get("value")
        try:
            value_wh = float(value)
        except (TypeError, ValueError):
            continue
        yield (
            ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
        ), value_wh
