"""Shared core for statistics back-fills.

Solar forecast and grid export price back-fills walk backward through the
recorder's states in pacing chunks, writing time-weighted hourly means and
persisting their cursor so an interrupted walk resumes across restarts.
Battery forecast back-fill reuses the metadata, compiler probe, constants,
and import-and-forget step against its static history file.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.recorder.models import (
    StatisticData,
    StatisticMeanType,
    StatisticMetaData,
)
from homeassistant.components.recorder.statistics import async_import_statistics
from homeassistant.core import HomeAssistant
from homeassistant.helpers import storage
from homeassistant.util import dt as dt_util

from . import recorder_statistics_span as span_mod

_LOGGER = logging.getLogger(__name__)

#: The recorder's own domain, required by async_import_statistics for entity series.
_RECORDER_DOMAIN = "recorder"

#: How much history one pass reads and writes before yielding.
_CHUNK = timedelta(days=7)

#: How far back the walk may reach before stopping regardless of history.
_MAX_SPAN = timedelta(days=1100)

#: Breathing room between chunks.
_CHUNK_PAUSE_SECONDS = 1.0

#: Persisted store version.
_STORAGE_VERSION = 1


class BackfillCursorStore:
    """Where a backward statistics walk got to, across restarts.

    Persisted payload shape (v1)::

        {"version": 1, "source": "sensor.x", "oldest_hour": "...", "done": bool}

    ``source`` is what the cursor was walked from, ensuring a finished walk
    does not latch across a change of source entity.
    """

    def __init__(self, hass: HomeAssistant, key: str) -> None:
        self._store = storage.Store(hass, _STORAGE_VERSION, key)
        self._document: dict[str, Any] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if not isinstance(stored, dict) or stored.get("version") != _STORAGE_VERSION:
            self._document = {}
            return
        self._document = stored

    def done_for(self, source_entity_id: str) -> bool:
        if self._document.get("source") != source_entity_id:
            return False
        return bool(self._document.get("done"))

    def oldest_hour_for(self, source_entity_id: str) -> datetime | None:
        if self._document.get("source") != source_entity_id:
            return None
        return self.oldest_hour

    @property
    def oldest_hour(self) -> datetime | None:
        raw = self._document.get("oldest_hour")
        if not isinstance(raw, str):
            return None
        try:
            return dt_util.as_utc(datetime.fromisoformat(raw))
        except ValueError:
            return None

    async def async_record(
        self, *, source_entity_id: str, oldest_hour: datetime, done: bool
    ) -> None:
        self._document = {
            "version": _STORAGE_VERSION,
            "source": source_entity_id,
            "oldest_hour": oldest_hour.isoformat(),
            "done": done,
        }
        await self._store.async_save(self._document)


async def first_compiled_hour(
    hass: HomeAssistant, target_entity_id: str
) -> datetime:
    """The oldest hour the statistics compiler has written for the entity.

    The back-fill must stop strictly before this, so that the compiler's rows and
    the imported ones never describe the same hour by two different routes.

    Narrowed in three bounded steps (month -> day -> hour) from (now - _MAX_SPAN)
    to now, clamped to the current hour, and falling back to the current hour on error.
    """
    now = dt_util.as_utc(dt_util.now())
    current_hour = now.replace(minute=0, second=0, microsecond=0)
    try:
        recorder = span_mod.get_instance(hass)

        def _query() -> datetime | None:
            # Step 1: Probe month
            months = span_mod.statistics_during_period(
                hass,
                now - _MAX_SPAN,
                now,
                {target_entity_id},
                "month",
                None,
                {"mean"},
            )
            month_rows = months.get(target_entity_id) or []
            if not month_rows:
                return None
            oldest_month_ts = min(r["start"] for r in month_rows if "start" in r)
            oldest_month_dt = dt_util.utc_from_timestamp(oldest_month_ts)

            # Step 2: Probe day within that month
            day_start = oldest_month_dt
            day_end = min(oldest_month_dt + timedelta(days=33), now)
            days = span_mod.statistics_during_period(
                hass,
                day_start,
                day_end,
                {target_entity_id},
                "day",
                None,
                {"mean"},
            )
            day_rows = days.get(target_entity_id) or []
            if not day_rows:
                return oldest_month_dt
            oldest_day_ts = min(r["start"] for r in day_rows if "start" in r)
            oldest_day_dt = dt_util.utc_from_timestamp(oldest_day_ts)

            # Step 3: Probe hour within that day
            hour_start = oldest_day_dt
            hour_end = min(oldest_day_dt + timedelta(days=2), now)
            hours = span_mod.statistics_during_period(
                hass,
                hour_start,
                hour_end,
                {target_entity_id},
                "hour",
                None,
                {"mean"},
            )
            hour_rows = hours.get(target_entity_id) or []
            if not hour_rows:
                return oldest_day_dt
            oldest_hour_ts = min(r["start"] for r in hour_rows if "start" in r)
            return dt_util.utc_from_timestamp(oldest_hour_ts)

        oldest = await recorder.async_add_executor_job(_query)
        if oldest is None:
            return current_hour
        return min(oldest, current_hour)
    except Exception:
        _LOGGER.exception(
            "Failed to read existing statistics for %s; back-filling from the current hour",
            target_entity_id,
        )
        return current_hour


async def _first_hour_home_assistant_owns(
    hass: HomeAssistant, target_entity_id: str
) -> datetime:
    """The oldest hour the statistics compiler has written for the entity."""
    return await first_compiled_hour(hass, target_entity_id)


def _time_weighted_mean(
    window: list[tuple[datetime, float]],
    *,
    start: datetime,
    end: datetime,
) -> float:
    """The mean value in force across [start, end), weighted by duration.

    A deliberate re-implementation of the recorder's
    _time_weighted_arithmetic_mean: when the first reading arrives after the
    period began, the period is shortened to start there rather than the reading
    being stretched backward over time it did not apply to.
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


def time_weighted_hourly_rows(
    samples: list[tuple[datetime, float]],
    utc_start: datetime,
    utc_end: datetime,
    *,
    carry_in: bool = False,
) -> list[StatisticData]:
    """One StatisticData per hour with samples in [utc_start, utc_end).

    When carry_in is True (e.g. grid export price), the standing reading in force
    when the hour opens is carried across hours. When False (e.g. solar forecast),
    only samples occurring within the hour are used.
    """
    rows: list[StatisticData] = []
    hour = utc_start.replace(minute=0, second=0, microsecond=0)
    if hour < utc_start:
        hour += timedelta(hours=1)

    index = 0
    standing: tuple[datetime, float] | None = None
    if carry_in:
        while index < len(samples) and samples[index][0] <= hour:
            standing = samples[index]
            index += 1
    else:
        while index < len(samples) and samples[index][0] < hour:
            index += 1

    while hour < utc_end:
        hour_end = hour + timedelta(hours=1)
        inside: list[tuple[datetime, float]] = []
        while index < len(samples) and samples[index][0] < hour_end:
            inside.append(samples[index])
            index += 1
        if carry_in:
            window = ([standing] if standing is not None else []) + inside
            if inside:
                standing = inside[-1]
        else:
            window = inside
        if window:
            values = [value for _, value in window]
            rows.append(
                StatisticData(
                    start=hour,
                    mean=_time_weighted_mean(window, start=hour, end=hour_end),
                    min=min(values),
                    max=max(values),
                )
            )
        hour = hour_end
    return rows


def mean_metadata(
    statistic_id: str,
    *,
    unit: str | None,
    unit_class: str | None,
) -> StatisticMetaData:
    """What the imported rows describe, in the shape the recorder validates."""
    return StatisticMetaData(
        mean_type=StatisticMeanType.ARITHMETIC,
        has_sum=False,
        name=None,
        source=_RECORDER_DOMAIN,
        statistic_id=statistic_id,
        unit_class=unit_class,
        unit_of_measurement=unit,
    )


async def async_import_and_forget(
    hass: HomeAssistant,
    metadata: StatisticMetaData,
    rows: list[StatisticData],
    *,
    import_fn: Callable[[HomeAssistant, StatisticMetaData, list[StatisticData]], None] = async_import_statistics,
) -> None:
    """Import statistics rows into the recorder and forget cached months."""
    import_fn(hass, metadata, rows)
    await span_mod.async_forget_imported_statistics(hass, metadata["statistic_id"])



async def async_walk_backward(
    hass: HomeAssistant,
    *,
    store: BackfillCursorStore,
    source_entity_id: str,
    target_entity_id: str,
    metadata: StatisticMetaData,
    read_chunk: Callable[[datetime, datetime], Awaitable[list[StatisticData] | None]],
    log_name: str,
    pause_seconds: float = _CHUNK_PAUSE_SECONDS,
    import_fn: Callable[[HomeAssistant, StatisticMetaData, list[StatisticData]], None] = async_import_statistics,
) -> None:
    """Walk backward in chunks from the compiler ownership boundary to history floor.

    Never raises unless cancelled. D6 done rule: latch done only when history
    is exhausted AND found_any is True.
    """
    try:
        await store.async_load()
        if store.done_for(source_entity_id):
            return

        cursor = store.oldest_hour_for(source_entity_id) or await first_compiled_hour(
            hass, target_entity_id
        )
        floor = dt_util.as_utc(dt_util.now()) - _MAX_SPAN
        written = 0
        found_any = False

        while cursor > floor:
            chunk_start = max(cursor - _CHUNK, floor)
            rows = await read_chunk(chunk_start, cursor)
            exhausted = rows is None
            if rows:
                found_any = True
                await async_import_and_forget(
                    hass, metadata, rows, import_fn=import_fn
                )
                written += len(rows)
            cursor = chunk_start
            await store.async_record(
                source_entity_id=source_entity_id,
                oldest_hour=cursor,
                done=exhausted and found_any,
            )
            if exhausted:
                break
            await asyncio.sleep(pause_seconds)

        _LOGGER.info(
            "Back-filled %d hourly %s statistics for %s from %s, back to %s",
            written,
            log_name,
            target_entity_id,
            source_entity_id,
            cursor.isoformat(),
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        _LOGGER.exception(
            "Failed to back-fill %s statistics for %s", log_name, target_entity_id
        )
