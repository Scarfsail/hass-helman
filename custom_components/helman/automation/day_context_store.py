"""Per-calendar-day classification hysteresis store for day-scoped rules (A4).

A tiny JSON store holding the band (surplus / tight / deficit) each calendar day
last resolved to, keyed by local date **and** the optimizer instance whose house
view produced it. Everything else in a ``DayContext`` is recomputed live each
run, and so is the band itself — this store only carries the previous answer
into the deadband in ``day_context._classify`` so a ratio hovering at a
threshold does not flip the band every 15 minutes.

It replaces the freeze store this file used to be (#264). That one pinned a day
the first time it was seen, which is roughly 35 hours before the day ends, so a
forecast revised down overnight could never downgrade the day.

The optimizer key matters: the classification is computed per optimizer over the
house view that optimizer actually plans against, so two optimizers legitimately
hold different bands for the same calendar day at the same moment.

This is the one deliberate, narrowly scoped exception to the stateless-optimizer
model; it is framework-owned and invisible to the optimizer contract.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from datetime import date
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import storage

from ..const import DAY_CONTEXT_STORAGE_KEY, DAY_CONTEXT_STORAGE_VERSION


class _DayBandStore(storage.Store):
    """Store that discards anything written by an older schema.

    v1 held frozen classifications keyed by date alone. They carry no optimizer
    key, so there is nothing to migrate them onto, and losing them costs exactly
    one damping cycle: the next run classifies without a previous band and the
    run after that has one again.
    """

    async def _async_migrate_func(
        self,
        old_major_version: int,
        old_minor_version: int,
        old_data: dict[str, Any],
    ) -> dict[str, Any]:
        return {"records": {}}


class DayContextStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store = _DayBandStore(
            hass, DAY_CONTEXT_STORAGE_VERSION, DAY_CONTEXT_STORAGE_KEY
        )
        self._bands: dict[tuple[date, str], str] | None = None

    async def async_load(self) -> dict[tuple[date, str], str]:
        """The band each (day, optimizer) pair emitted on the previous run."""
        stored = await self._store.async_load()
        self._bands = _deserialize_bands(stored)
        return dict(self._bands)

    async def async_save_and_prune(
        self,
        *,
        emitted: Mapping[tuple[date, str], str],
        today: date,
        optimizer_ids: Collection[str],
    ) -> None:
        """Record this run's bands, then drop what can no longer be read.

        Merged rather than replaced: an optimizer that was skipped this run
        (unavailable condition rails, say) should keep the band it last emitted
        instead of losing its damping. Records for a past day, or for an
        optimizer instance no longer configured, can never be read again and are
        pruned.
        """
        if self._bands is None:
            self._bands = {}

        before = dict(self._bands)
        self._bands.update(emitted)
        for key in list(self._bands):
            local_date, optimizer_id = key
            if local_date < today or optimizer_id not in optimizer_ids:
                del self._bands[key]

        if self._bands != before:
            await self._store.async_save(_serialize_bands(self._bands))


def _serialize_bands(bands: Mapping[tuple[date, str], str]) -> dict[str, Any]:
    records: dict[str, dict[str, str]] = {}
    for (local_date, optimizer_id), band in bands.items():
        records.setdefault(local_date.isoformat(), {})[optimizer_id] = band
    return {"records": records}


def _deserialize_bands(stored: Any) -> dict[tuple[date, str], str]:
    bands: dict[tuple[date, str], str] = {}
    if not isinstance(stored, dict):
        return bands
    raw_records = stored.get("records")
    if not isinstance(raw_records, dict):
        return bands
    for raw_date, by_optimizer in raw_records.items():
        if not isinstance(by_optimizer, dict):
            continue
        try:
            local_date = date.fromisoformat(str(raw_date))
        except ValueError:
            continue
        for optimizer_id, band in by_optimizer.items():
            if isinstance(band, str) and band:
                bands[(local_date, str(optimizer_id))] = band
    return bands
