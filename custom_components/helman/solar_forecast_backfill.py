"""Back-fill the solar forecast sensor's statistics from the source's own states.

``sensor.helman_solar_forecast_current`` gives the per-slot forecast a recorded
history from the moment it first publishes. That fixes the future and nothing
else. The past is recoverable exactly once, and only from one place: the source
entity's *recorded states*, whose ``wh_period_15m`` attribute carries the whole
day's curve as it stood at each publication.

**Which publication matters.** The source republishes the entire day every few
hours and revises slots that have already elapsed, so the same slot reads
differently in every copy. On 2026-08-27 the recorder holds four publications
and the 11:00 slot reads 1244 / 1091 / **1301** / 1593 Wh across them. Reading
the entity today gives the last of those; the retired trainer took the first.
Neither is the measurement. This module takes, for each slot, the value held by
the **last publication before that slot began** -- 1301 -- which is the same
rule the live sensor writes by, so the back-filled rows and the recorded ones
describe one measurement rather than two.

**Nothing reads these rows yet.** The trainer uses raw states, which reach back
only as far as ``purge_keep_days``. This exists because the source's states are
perishable and hourly statistics are not: #173 teaches the trainer to splice a
states window with a statistics tail, and when it lands these rows are already
there instead of long since purged. That is also why this runs unprompted at
startup rather than waiting to be asked -- by the time anyone wants the data,
the states it comes from are gone.

The four traps ``grid_export_price_backfill`` records apply here unchanged, and
this module follows it on each: the hourly mean is time weighted rather than an
average of the samples; an hour Home Assistant has already compiled is never
written, the walk stopping strictly before
:func:`_first_hour_home_assistant_owns`; ``async_import_statistics`` validates
strictly, so ``mean_type``, ``unit_class`` and a recorder-domain ``source`` are
all passed explicitly; and the walk is a paced background task on the
recorder's own executor rather than a thread.

One thing is this module's own. The source's states are read *with* their
attributes, which the price back-fill deliberately avoids -- there the
attributes are a large and irrelevant forward forecast, and here they are the
entire point.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.components.recorder.models import (
    StatisticData,
    StatisticMeanType,
    StatisticMetaData,
)
from homeassistant.components.recorder.statistics import async_import_statistics
from homeassistant.core import HomeAssistant
from homeassistant.helpers import storage
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .solar_bias_correction.forecast_slot_history import (
    SOLAR_FORECAST_CURRENT_ENTITY,
)

_LOGGER = logging.getLogger(__name__)

_RECORDER_DOMAIN = "recorder"
#: The slot grid the source publishes on, and the sensor's own.
_SLOT_MINUTES = 15
_SLOT_FRACTION_OF_HOUR = _SLOT_MINUTES / 60
#: How much history one pass reads and writes before yielding. The source
#: publishes a handful of times a day, so a week is tens of state rows -- but
#: each carries a 96-entry attribute map, which is why the chunk is not larger.
_CHUNK = timedelta(days=7)
#: The walk's real stopping condition is the source's history running out. This
#: is the guard for the case where it somehow never does.
_MAX_SPAN = timedelta(days=1100)
_CHUNK_PAUSE_SECONDS = 1.0

_STORAGE_KEY = f"{DOMAIN}.solar_forecast_backfill"
_STORAGE_VERSION = 1


class SolarForecastBackfillStore:
    """Where the backward walk got to, across restarts.

    Persisted payload shape (v1)::

        {"version": 1, "source": "sensor.x", "oldest_hour": "...", "done": bool}

    ``source`` is what the cursor was walked from, and it is why ``done`` can be
    trusted: point the config at a different forecast provider and the new
    entity's history would otherwise never be read, a ``done`` set against the
    old id latching forever.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, _STORAGE_VERSION, _STORAGE_KEY)
        self._data: dict[str, Any] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._data = stored if isinstance(stored, dict) else {}

    def done_for(self, source_entity_id: str) -> bool:
        return bool(self._data.get("done")) and self._data.get("source") == source_entity_id

    def oldest_hour_for(self, source_entity_id: str) -> datetime | None:
        if self._data.get("source") != source_entity_id:
            return None
        raw = self._data.get("oldest_hour")
        if not isinstance(raw, str):
            return None
        try:
            return dt_util.as_utc(datetime.fromisoformat(raw))
        except ValueError:
            return None

    async def async_record(
        self, *, source_entity_id: str, oldest_hour: datetime, done: bool
    ) -> None:
        self._data = {
            "version": _STORAGE_VERSION,
            "source": source_entity_id,
            "oldest_hour": oldest_hour.isoformat(),
            "done": done,
        }
        await self._store.async_save(self._data)


async def async_backfill_solar_forecast_statistics(
    hass: HomeAssistant,
    *,
    source_entity_id: str,
    target_entity_id: str = SOLAR_FORECAST_CURRENT_ENTITY,
) -> None:
    """Walk the source's history backward, writing the sensor's hourly means.

    Never raises. Nothing reads these rows today, so a failure here costs
    nothing that is currently working and is logged rather than taken out on
    whatever started the task.
    """
    try:
        store = SolarForecastBackfillStore(hass)
        await store.async_load()
        if store.done_for(source_entity_id):
            return

        timezone = ZoneInfo(str(hass.config.time_zone))
        cursor = store.oldest_hour_for(source_entity_id) or await _first_hour_home_assistant_owns(
            hass, target_entity_id
        )
        floor = dt_util.as_utc(dt_util.now()) - _MAX_SPAN
        written = 0

        while cursor > floor:
            chunk_start = max(cursor - _CHUNK, floor)
            rows = await _chunk_statistics(
                hass,
                source_entity_id,
                utc_start=chunk_start,
                utc_end=cursor,
                timezone=timezone,
            )
            exhausted = rows is None
            if rows:
                async_import_statistics(hass, _metadata(target_entity_id), rows)
                written += len(rows)
            cursor = chunk_start
            await store.async_record(
                source_entity_id=source_entity_id, oldest_hour=cursor, done=exhausted
            )
            if exhausted:
                break
            await asyncio.sleep(_CHUNK_PAUSE_SECONDS)

        _LOGGER.info(
            "Back-filled %d hourly solar forecast statistics for %s from %s, back to %s",
            written,
            target_entity_id,
            source_entity_id,
            cursor.isoformat(),
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        _LOGGER.exception(
            "Failed to back-fill solar forecast statistics for %s", target_entity_id
        )


async def _first_hour_home_assistant_owns(
    hass: HomeAssistant, target_entity_id: str
) -> datetime:
    """The oldest hour the statistics compiler has written for the sensor.

    The back-fill must stop strictly before this so the compiler's rows and the
    imported ones never describe the same hour by two different routes. Usually
    there are none, the sensor being new, and the walk starts from now.
    """
    from homeassistant.components.recorder.statistics import (
        list_statistic_ids,
        statistics_during_period,
    )

    recorder = get_instance(hass)

    def _query() -> datetime | None:
        ids = list_statistic_ids(hass, statistic_ids={target_entity_id})
        if not ids:
            return None
        rows = statistics_during_period(
            hass,
            dt_util.utc_from_timestamp(0),
            None,
            {target_entity_id},
            "hour",
            None,
            {"mean"},
        )
        series = rows.get(target_entity_id) or []
        if not series:
            return None
        return dt_util.utc_from_timestamp(series[0]["start"])

    oldest = await recorder.async_add_executor_job(_query)
    now_hour = dt_util.as_utc(dt_util.now()).replace(
        minute=0, second=0, microsecond=0
    )
    return oldest or now_hour


async def _chunk_statistics(
    hass: HomeAssistant,
    source_entity_id: str,
    *,
    utc_start: datetime,
    utc_end: datetime,
    timezone: ZoneInfo,
) -> list[StatisticData] | None:
    """One chunk's hourly rows, or ``None`` where the source has no history.

    ``None`` is the walk's stopping condition and means the recorder holds no
    state for this entity inside the chunk *and* none before it either --
    ``include_start_time_state`` would have carried one in otherwise. An empty
    list is different: states that carried no usable forecast map, which is odd
    but not evidence the history has ended.
    """
    recorder = get_instance(hass)

    def _query() -> list[Any]:
        history = state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            source_entity_id,
            # The forecast map *is* the data here, which is the one place this
            # walk parts company with the export-price one.
            no_attributes=False,
            descending=False,
            limit=None,
            include_start_time_state=True,
        )
        return (
            history.get(source_entity_id)
            or history.get(source_entity_id.lower())
            or []
        )

    states = await recorder.async_add_executor_job(_query)
    if not states:
        return None
    publications = _publications(states, timezone)
    if not publications:
        return []
    samples = _slot_samples(publications, utc_start=utc_start, utc_end=utc_end)
    if not samples:
        return []
    return _hourly_rows(samples, utc_start=utc_start, utc_end=utc_end)


def _publications(
    states: list[Any], timezone: ZoneInfo
) -> list[tuple[datetime, dict[datetime, float]]]:
    """``(published_at, {slot_start: wh})`` for every state carrying a curve.

    Consecutive states repeating the same curve are kept: choosing between them
    is :func:`_slot_samples`'s job, and it wants the *latest* publication that
    still predates a slot.
    """
    publications: list[tuple[datetime, dict[datetime, float]]] = []
    for state in states:
        attributes = getattr(state, "attributes", None)
        if not isinstance(attributes, dict):
            continue
        raw_map = attributes.get("wh_period_15m")
        if not isinstance(raw_map, dict) or not raw_map:
            continue
        curve: dict[datetime, float] = {}
        for raw_key, raw_value in raw_map.items():
            slot = _parse_slot(raw_key, timezone)
            if slot is None:
                continue
            try:
                curve[slot] = float(raw_value)
            except (TypeError, ValueError):
                continue
        if not curve:
            continue
        stamp = getattr(state, "last_changed", None) or getattr(
            state, "last_updated", None
        )
        if stamp is None:
            continue
        publications.append((dt_util.as_utc(stamp), curve))
    publications.sort(key=lambda item: item[0])
    return publications


def _parse_slot(raw_key: Any, timezone: ZoneInfo) -> datetime | None:
    if not isinstance(raw_key, str):
        return None
    try:
        stamp = datetime.fromisoformat(raw_key)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone)
    return dt_util.as_utc(stamp)


def _slot_samples(
    publications: list[tuple[datetime, dict[datetime, float]]],
    *,
    utc_start: datetime,
    utc_end: datetime,
) -> list[tuple[datetime, float]]:
    """``(slot_start, watts)`` for each slot, at the horizon the sensor records.

    A slot takes the value held by the last publication that predates it, which
    is what was knowable when the slot began. A slot no such publication covers
    is omitted rather than carried: the source had not yet published that day,
    so nothing was believed about it, and the live sensor would have recorded
    nothing either.

    Wh per slot becomes W, matching what the target entity publishes.
    """
    if not publications:
        return []
    samples: list[tuple[datetime, float]] = []
    slot = utc_start.replace(second=0, microsecond=0)
    slot -= timedelta(minutes=slot.minute % _SLOT_MINUTES)
    if slot < utc_start:
        slot += timedelta(minutes=_SLOT_MINUTES)

    index = 0
    latest: dict[datetime, float] | None = None
    while slot < utc_end:
        while index < len(publications) and publications[index][0] <= slot:
            latest = publications[index][1]
            index += 1
        if latest is not None and slot in latest:
            samples.append((slot, latest[slot] / _SLOT_FRACTION_OF_HOUR))
        slot += timedelta(minutes=_SLOT_MINUTES)
    return samples


def _hourly_rows(
    samples: list[tuple[datetime, float]],
    *,
    utc_start: datetime,
    utc_end: datetime,
) -> list[StatisticData]:
    """One row per hour that has any slot, time weighted across the hour.

    An hour with no slots at all -- before the source's first publication, or
    through a purged stretch -- is omitted rather than carried, so a hole in the
    source's history stays a hole here instead of being papered over with a
    forecast that was never published.
    """
    rows: list[StatisticData] = []
    hour = utc_start.replace(minute=0, second=0, microsecond=0)
    if hour < utc_start:
        hour += timedelta(hours=1)

    index = 0
    while index < len(samples) and samples[index][0] < hour:
        index += 1

    while hour < utc_end:
        hour_end = hour + timedelta(hours=1)
        inside: list[tuple[datetime, float]] = []
        while index < len(samples) and samples[index][0] < hour_end:
            inside.append(samples[index])
            index += 1
        if inside:
            values = [value for _, value in inside]
            rows.append(
                StatisticData(
                    start=hour,
                    mean=_time_weighted_mean(inside, start=hour, end=hour_end),
                    min=min(values),
                    max=max(values),
                )
            )
        hour = hour_end
    return rows


def _time_weighted_mean(
    window: list[tuple[datetime, float]],
    *,
    start: datetime,
    end: datetime,
) -> float:
    """The mean value in force across ``[start, end)``, weighted by duration.

    The same re-implementation of the recorder's
    ``_time_weighted_arithmetic_mean`` the export-price back-fill carries,
    including the part that looks like an edge case and is not: a window whose
    first reading arrives after the period began shortens the period rather than
    stretching that reading backward. An hour holding only its last slot
    therefore reports that slot, not a quarter of it.
    """
    accumulated = 0.0
    previous_value: float | None = None
    previous_instant: datetime | None = None
    for instant, value in window:
        instant = max(instant, start)
        if previous_instant is None:
            start = instant
        else:
            accumulated += previous_value * (instant - previous_instant).total_seconds()
        previous_value = value
        previous_instant = instant

    accumulated += previous_value * (end - previous_instant).total_seconds()
    return accumulated / (end - start).total_seconds()


def _metadata(target_entity_id: str) -> StatisticMetaData:
    """What the imported rows describe, in the shape the recorder validates.

    ``source`` is the recorder's own domain rather than ``helman``: the series
    belongs to an entity and lives in the recorder's table, and
    ``async_import_statistics`` rejects anything else. ``unit_class`` is
    ``power`` because that is what watts convert within -- naming none where one
    applies leaves the series unconvertible for a reader whose display unit
    differs.
    """
    return StatisticMetaData(
        mean_type=StatisticMeanType.ARITHMETIC,
        has_sum=False,
        name=None,
        source=_RECORDER_DOMAIN,
        statistic_id=target_entity_id,
        unit_class="power",
        unit_of_measurement="W",
    )
