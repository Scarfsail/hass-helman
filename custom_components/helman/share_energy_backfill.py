"""Where a share-energy sensor's total starts, and its one-time statistics back-fill.

A meterless child's ``sensor.helman_share_energy_<slug>`` accumulates its live
share power from the moment it is created. On every start it continues from
the higher of its restored total and its last recorded state, so neither a lost
restore file nor one saved up to 15 minutes before an unclean shutdown can make
it step backward. Only a sensor with neither is new, and back-fills.

The back-fill writes the hours before the sensor existed into its long-term
statistics, from the share-power sensor's hourly ``mean`` W held for the hour
(:func:`share_hour_kwh`) -- the figure device reports read before they read the
energy sensor, so a past report does not change. An hour without a ``mean`` is
a gap, never 0 kWh.

**The seam.** Only hours strictly before the first hour the compiler owns are
imported, and both their ``state`` and ``sum`` climb from the first hour's kWh
to the back-fill total T: Home Assistant reads the ``sum`` before an entity's
first row as 0, so the first hour's change is its own kWh. The compiler,
though, continues a ``sum`` from the entity's latest short-term row and starts
from 0 without one, so a short-term row of ``state = sum = T`` is seeded before
the sensor publishes T as its first state. Neither ``state`` nor ``sum`` then
steps backward across the seam. Until T is known the sensor is
``unavailable``, so the compiler records no competing first state.

**Once, and resumable.** The store keeps the ownership boundary, recorded
before any import, and T, recorded after the import is committed. A run cut
short by a restart starts again from the recorded boundary -- a fresh probe
would find the run's own imported rows and stop there -- and re-imports the
same rows (imports upsert). Once T is recorded the back-fill never runs again
for the sensor, and later changes to weights or config never rewrite the hours
it wrote.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.recorder.db_schema import StatisticsShortTerm
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.components.recorder.models import StatisticData, StatisticMetaData
from homeassistant.components.recorder.statistics import async_import_statistics
from homeassistant.const import UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_conversion import EnergyConverter

from . import recorder_statistics_span as span_mod
from .const import DOMAIN
from .statistics_backfill import (
    _MAX_SPAN,
    VersionedBackfillStore,
    async_import_and_forget,
    mean_metadata,
    parse_utc,
    probe_first_compiled_hour,
)

_LOGGER = logging.getLogger(__name__)

def share_hour_kwh(row: Any) -> float | None:
    """A share sensor's hourly statistics row as kWh: its ``mean`` W held for the hour.

    ``None`` for a row without a usable ``mean``, which is a gap, not 0 kWh.
    """
    mean = row.get("mean") if isinstance(row, Mapping) else None
    if not isinstance(mean, (int, float)) or not math.isfinite(mean):
        return None
    return max(0.0, float(mean)) / 1000.0


#: How many of the newest recorded states are searched for a number: a removal
#: or an ``unavailable`` can sit on top of the last total.
_RECORDED_STATES = 10


class ShareEnergyBackfillStore(VersionedBackfillStore):
    """Where one share-energy sensor's back-fill got to, across restarts.

    Persisted payload shape (v1)::

        {"version": 1, "first_owned": "2026-11-01T10:00:00+00:00", "total": 12.5}

    ``total`` is the done flag: ``None`` until the import is committed. One
    file per sensor, keyed by its unique id so an entity-id rename keeps it,
    and so the sensors' back-fills, which run side by side, never write over
    each other's progress.
    """

    def __init__(self, hass: HomeAssistant, key: str) -> None:
        super().__init__(hass, f"{DOMAIN}.share_energy_backfill.{key}")

    @property
    def first_owned(self) -> datetime | None:
        return parse_utc(self._document.get("first_owned"))

    @property
    def total(self) -> float | None:
        total = self._document.get("total")
        return float(total) if isinstance(total, (int, float)) else None

    async def async_record(
        self, *, first_owned: datetime, total: float | None = None
    ) -> None:
        await self._async_save({"first_owned": first_owned.isoformat(), "total": total})


async def async_initial_share_energy_total(
    hass: HomeAssistant,
    *,
    restored: float | None,
    source_entity_id: str,
    target_entity_id: str,
    store_key: str,
    import_fn: Callable[
        [HomeAssistant, StatisticMetaData, list[StatisticData]], None
    ] = async_import_statistics,
) -> float | None:
    """The total the sensor starts publishing at.

    The higher of ``restored`` and the last recorded state; with neither, the
    back-fill total T. ``None`` when that could not be found: logged, for the
    sensor to retry, staying unavailable meanwhile.
    """
    try:
        recorder = span_mod.get_instance(hass)
        await recorder.async_recorder_ready.wait()
        recorded = await recorder.async_add_executor_job(
            _last_recorded_total, hass, target_entity_id
        )
        known = [total for total in (restored, recorded) if total is not None]
        if known:
            return max(known)
        return await _async_backfill(
            hass,
            source_entity_id=source_entity_id,
            target_entity_id=target_entity_id,
            store_key=store_key,
            import_fn=import_fn,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        _LOGGER.exception("Failed to find the starting total of %s", target_entity_id)
        return None


def _last_recorded_total(hass: HomeAssistant, entity_id: str) -> float | None:
    """The entity's newest numeric state in the recorder, in kWh, if any.

    Home Assistant records the state in the unit the user selected for the
    sensor, so it is converted back to the kWh the sensor accumulates in.
    """
    states = state_changes_during_period(
        hass,
        dt_util.utcnow() - _MAX_SPAN,
        entity_id=entity_id,
        no_attributes=False,
        descending=True,
        limit=_RECORDED_STATES,
        include_start_time_state=False,
    ).get(entity_id.lower(), [])
    for state in states:
        try:
            return EnergyConverter.convert(
                float(state.state),
                state.attributes.get("unit_of_measurement", UnitOfEnergy.KILO_WATT_HOUR),
                UnitOfEnergy.KILO_WATT_HOUR,
            )
        except (ValueError, HomeAssistantError):
            continue
    return None


async def _async_backfill(
    hass: HomeAssistant,
    *,
    source_entity_id: str,
    target_entity_id: str,
    store_key: str,
    import_fn: Callable[[HomeAssistant, StatisticMetaData, list[StatisticData]], None],
) -> float:
    """Import the target's hours before the compiler's, and return the total T."""
    store = ShareEnergyBackfillStore(hass, store_key)
    await store.async_load()
    if store.total is not None:
        return store.total

    first_owned = store.first_owned
    if first_owned is None:
        first_owned = await probe_first_compiled_hour(hass, target_entity_id)
        await store.async_record(first_owned=first_owned)

    # Let the start-up catch-up compile of missed periods land first, or the
    # source's hour just before first_owned may not exist yet and be lost.
    await span_mod.get_instance(hass).async_block_till_done()
    hourly_kwh = await _hourly_kwh(hass, source_entity_id, before=first_owned)
    rows = _cumulative_rows(hourly_kwh)
    total = rows[-1]["state"] if rows else 0.0
    metadata = mean_metadata(
        target_entity_id, unit="kWh", unit_class="energy", has_sum=True
    )
    if rows:
        await async_import_and_forget(hass, metadata, rows, import_fn=import_fn)
    await _async_seed_compiler(hass, metadata, first_owned, total)
    await store.async_record(first_owned=first_owned, total=total)
    _LOGGER.info(
        "Back-filled %d hourly energy statistics (%.3f kWh) for %s from %s",
        len(rows),
        total,
        target_entity_id,
        source_entity_id,
    )
    return total


async def _async_seed_compiler(
    hass: HomeAssistant,
    metadata: StatisticMetaData,
    first_owned: datetime,
    total: float,
) -> None:
    """Seed the short-term row the compiler continues the sensor's ``sum`` from.

    The row starts at ``first_owned``: an hour nothing was imported into, so
    its hourly summary never collides with an imported hour, and one the
    compiler holds no short-term rows of for the sensor, which has been
    unavailable. The compiler inserts rather than upserts, so the first period
    it compiles for the sensor -- the one the sensor publishes T in -- must
    start after the seed: publishing waits out the hour's first five minutes.
    The import is queued ahead of every later compile, which therefore sees it.
    """
    seed_after = first_owned + timedelta(minutes=5)
    if (wait := (seed_after - dt_util.utcnow()).total_seconds()) > 0:
        await asyncio.sleep(wait)
    recorder = span_mod.get_instance(hass)
    recorder.async_import_statistics(
        metadata,
        [StatisticData(start=first_owned, state=total, sum=total)],
        StatisticsShortTerm,
    )
    await recorder.async_block_till_done()


def _cumulative_rows(hourly_kwh: dict[datetime, float]) -> list[StatisticData]:
    """One row per hour in time order, ``state`` and ``sum`` both climbing to T."""
    rows: list[StatisticData] = []
    state = 0.0
    for hour in sorted(hourly_kwh):
        state += hourly_kwh[hour]
        rows.append(StatisticData(start=hour, state=state, sum=state))
    return rows


async def _hourly_kwh(
    hass: HomeAssistant, source_entity_id: str, *, before: datetime
) -> dict[datetime, float]:
    """The source's kWh per hour before ``before``, hours without a ``mean`` left out."""

    def _query() -> list[dict[str, Any]]:
        rows = span_mod.statistics_during_period(
            hass,
            before - _MAX_SPAN,
            before,
            {source_entity_id},
            "hour",
            {"power": UnitOfPower.WATT},
            {"mean"},
        )
        return rows.get(source_entity_id) or []

    rows = await span_mod.get_instance(hass).async_add_executor_job(_query)
    hourly: dict[datetime, float] = {}
    for row in rows:
        hour = dt_util.utc_from_timestamp(row["start"])
        kwh = share_hour_kwh(row)
        if kwh is not None and hour < before:
            hourly[hour] = kwh
    return hourly
