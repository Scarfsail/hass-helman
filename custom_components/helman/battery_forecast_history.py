from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import storage

from .const import (
    BATTERY_FORECAST_HISTORY_RETENTION_DAYS,
    BATTERY_FORECAST_HISTORY_STORAGE_KEY,
    BATTERY_FORECAST_HISTORY_STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

_SAVE_DELAY_SECONDS = 30
_SLOT_MINUTES = 15


class BatteryForecastHistoryStore:
    """Rolling per-slot archive of forecast battery SoC, net grid and net battery energy.

    The battery forecast snapshot only spans from the current 15-minute slot
    forward, and nothing else writes those series to the recorder. Once a
    slot has elapsed there is no other record of what was predicted for it, so
    every rebuild upserts the snapshot's slots for the current day. The value
    that survives for a slot is the last one written while that slot had not
    yet elapsed, which matches the semantics of the house forecast's
    ``sensor.helman_house_consumption_forecast_current`` history.

    Persisted shape:
      {"days": {"YYYY-MM-DD": {"HH:MM": {"socPct": float, "gridNetWh": float,
                                         "batteryNetWh": float}}}}

    ``batteryNetWh`` was added after the first release, so days archived before
    then simply lack the key; readers treat a missing key as "no value for that
    slot" rather than zero.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = storage.Store(
            hass,
            BATTERY_FORECAST_HISTORY_STORAGE_VERSION,
            BATTERY_FORECAST_HISTORY_STORAGE_KEY,
        )
        self._days: dict[str, dict[str, dict[str, float]]] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        days = stored.get("days") if isinstance(stored, dict) else None
        self._days = days if isinstance(days, dict) else {}

    def slots_for_day(self, target_date: date) -> dict[str, dict[str, float]]:
        """Return the recorded {slot: {socPct, gridNetWh, batteryNetWh}} map for a day."""
        slots = self._days.get(target_date.isoformat())
        return slots if isinstance(slots, dict) else {}

    @callback
    def record_snapshot(
        self,
        snapshot: dict[str, Any] | None,
        *,
        local_now: datetime,
        timezone: ZoneInfo,
    ) -> None:
        """Upsert the snapshot's slots for the day that local_now falls in."""
        if not isinstance(snapshot, dict):
            return
        today = local_now.date()
        recorded = {
            slot: values
            for slot, values in self.slots_for_day(today).items()
            if _is_slot_label(slot)
        }
        for ts_local, entry in _iter_snapshot_entries(snapshot, timezone):
            if ts_local.date() != today:
                continue
            # The snapshot's first entry is stamped at build time, covering only
            # the remainder of the slot in progress. It is not a slot forecast,
            # so archiving it would leave one stray key per rebuild.
            if ts_local.minute % _SLOT_MINUTES or ts_local.second:
                continue
            slot_values = _slot_values(entry)
            if slot_values is None:
                continue
            recorded[f"{ts_local.hour:02d}:{ts_local.minute:02d}"] = slot_values
        if not recorded:
            return
        self._days[today.isoformat()] = recorded
        self._prune(today)
        self._store.async_delay_save(self._data_to_save, _SAVE_DELAY_SECONDS)

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {"days": self._days}

    def _prune(self, today: date) -> None:
        cutoff = today - timedelta(days=BATTERY_FORECAST_HISTORY_RETENTION_DAYS)
        for day in list(self._days):
            try:
                if date.fromisoformat(day) < cutoff:
                    del self._days[day]
            except ValueError:
                del self._days[day]


def _is_slot_label(slot: str) -> bool:
    """True for an "HH:MM" label that lands on a 15-minute slot boundary."""
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


def _iter_snapshot_entries(snapshot: dict[str, Any], timezone: ZoneInfo):
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        yield (ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)), entry


def _slot_values(entry: dict[str, Any]) -> dict[str, float] | None:
    """Pull SoC, net grid and net battery energy out of one snapshot slot.

    Net grid is positive when exporting, matching gridNetKwh elsewhere. Net
    battery follows the same "positive means energy leaving the house's demand"
    rule, so it is positive when charging.
    """
    values: dict[str, float] = {}
    pct = entry.get("socPct")
    if pct is not None:
        try:
            values["socPct"] = float(pct)
        except (TypeError, ValueError):
            pass
    imported = entry.get("importedFromGridKwh")
    exported = entry.get("exportedToGridKwh")
    if imported is not None or exported is not None:
        try:
            values["gridNetWh"] = (float(exported or 0.0) - float(imported or 0.0)) * 1000.0
        except (TypeError, ValueError):
            pass
    charged = entry.get("chargedKwh")
    discharged = entry.get("dischargedKwh")
    if charged is not None or discharged is not None:
        try:
            values["batteryNetWh"] = (
                float(charged or 0.0) - float(discharged or 0.0)
            ) * 1000.0
        except (TypeError, ValueError):
            pass
    return values or None
