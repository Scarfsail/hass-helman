"""Back-fill the export price mirror's statistics from the source entity's states.

:class:`~.sensor.HelmanGridExportPriceSensor` gives the export rate a long-term
statistics series from the moment it first publishes. That fixes the future and
nothing else: the month and year views price every hour of history off those
statistics, so every hour older than the mirror reports no gain at all.

The past is recoverable exactly once, and only from one place. The configured
sell-price entity has no statistics -- that is the whole reason the mirror
exists -- but it does have *raw states*, as far back as the recorder keeps them:
around three weeks on a default ``purge_keep_days``, years on an instance with
retention turned off. This module reads those states and writes the hourly means
they imply into the mirror's own series with ``async_import_statistics``, which
is the recorder's supported door for exactly this.

Four things about that are easy to get wrong, and each of them produces
plausible numbers rather than an error:

* **The hourly mean is time weighted, not the average of the samples.** A price
  holds until it changes, and a spot-price entity writes far more often than its
  value moves -- ~440 writes a day against an hourly step, on the instance this
  was measured on. Averaging the samples happens to be nearly right for an hour
  the rate sat still through, and is wrong by the full step at every hour the
  rate moves, which are precisely the hours a reader would question.
  :func:`_time_weighted_mean` therefore weights each reading by how long it
  stood, mirroring the recorder's own
  ``homeassistant.components.sensor.recorder._time_weighted_arithmetic_mean``
  down to how it treats an hour whose first reading arrives after the hour began.
* **An hour Home Assistant has already compiled must not be written.** The
  compiler owns every hour from the mirror's first publication onward. The
  back-fill walks *backward* and stops strictly before
  :func:`_first_hour_home_assistant_owns`, so the two never touch the same row.
* **``async_import_statistics`` validates strictly.** ``statistic_id`` has to be
  a valid entity id and ``source`` has to be the *recorder's* domain -- not
  ``helman`` -- because an entity-id-shaped series belongs to the recorder's own
  table. ``mean_type`` and ``unit_class`` are passed explicitly; inferring them
  is deprecated and reports usage against this integration.
* **This is a background task, not a thread.** The recorder owns its own
  executor and its own queue. Each chunk's read goes through that executor, and
  the loop awaits between chunks so neither the event loop nor the recorder's
  queue is monopolised by a job whose results nobody is waiting for.

The cursor is persisted so an interrupted run resumes rather than restarting.
It is an optimisation and not a correctness requirement: ``async_import_statistics``
upserts on ``(metadata_id, start)``, so re-writing a chunk changes nothing but
the time it costs.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

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

from .const import DOMAIN, GRID_EXPORT_PRICE_ENTITY_ID

_LOGGER = logging.getLogger(__name__)

#: The recorder's own domain, which ``async_import_statistics`` insists the
#: metadata's ``source`` equals. Spelled out rather than imported from
#: ``homeassistant.components.recorder.const`` so this module keeps to the
#: recorder's public surface.
_RECORDER_DOMAIN = "recorder"

#: How much history one pass reads and writes before yielding.
#:
#: A week of a fast-writing price entity is a few thousand state rows -- a read
#: the recorder's executor finishes in well under a second -- and 168 statistics
#: rows, which is a comfortable single import job. Smaller chunks would multiply
#: round-trips through the recorder's single DB thread for no gain; larger ones
#: would hold that thread while the rest of the integration waits behind it.
_CHUNK = timedelta(days=7)

#: How far back the walk may reach before giving up regardless of what it finds.
#:
#: The walk's real stopping condition is the source entity's history running
#: out, and that is what ends it on every real instance. This is the guard
#: against the case where it somehow never does -- three years is past any
#: retention setting a user is likely to have, and comfortably past the two the
#: reference instance keeps.
_MAX_SPAN = timedelta(days=1100)

#: Breathing room between chunks.
#:
#: Zero would be enough to let the loop run, but not enough to keep the recorder's
#: queue short: the import job is queued rather than awaited, so an unpaced walk
#: could enqueue a year of imports before the first one is written.
_CHUNK_PAUSE_SECONDS = 1.0

_STORAGE_KEY = f"{DOMAIN}.grid_export_price_backfill"
_STORAGE_VERSION = 1


class GridExportPriceBackfillStore:
    """Where the backward walk got to, across restarts.

    Persisted payload shape (v1)::

        {"version": 1, "source": "sensor.x", "oldest_hour": "...", "done": bool}

    ``source`` is what the cursor was walked *from*, and it is why ``done`` can
    be trusted. A finished walk means "that entity's history is exhausted", not
    "there is nothing left to import": point the config at a different
    sell-price entity -- a provider switch, or an integration that renames its
    entities -- and the new one's years of history would otherwise never be
    read, because a `done` set against the old id latches forever with no way
    back short of deleting this file by hand.

    Its own store rather than a key in an existing one: this is written a handful
    of times in a back-fill's life and then never again, while the stores it
    would otherwise join are rewritten every fifteen minutes behind a hash guard.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, _STORAGE_VERSION, _STORAGE_KEY)
        self._document: dict[str, Any] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if not isinstance(stored, dict) or stored.get("version") != _STORAGE_VERSION:
            self._document = {}
            return
        self._document = stored

    def done_for(self, source_entity_id: str) -> bool:
        """Whether a previous run exhausted *this* source's history.

        A cursor recorded against another entity says nothing about this one, so
        it reads as unfinished and the walk starts again from the top.
        """
        if self._document.get("source") != source_entity_id:
            return False
        return bool(self._document.get("done"))

    def oldest_hour_for(self, source_entity_id: str) -> datetime | None:
        """Where the walk got to for this source, or None to start afresh."""
        if self._document.get("source") != source_entity_id:
            return None
        return self.oldest_hour

    @property
    def oldest_hour(self) -> datetime | None:
        """The oldest hour written so far, or None when nothing has been."""
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


async def async_backfill_grid_export_price_statistics(
    hass: HomeAssistant,
    *,
    source_entity_id: str,
    unit_of_measurement: str | None,
    target_entity_id: str = GRID_EXPORT_PRICE_ENTITY_ID,
) -> None:
    """Walk the source entity's history backward, writing the mirror's hourly means.

    Returns as soon as a previous run reported the history exhausted; there is
    nothing older to find, and the recorder purges from the far end, so a second
    walk would only re-read rows that have since been deleted.

    Never raises. The back-fill improves a view that already renders honestly
    without it, so a failure here is logged and dropped rather than taken out on
    whatever started the task.
    """
    try:
        store = GridExportPriceBackfillStore(hass)
        await store.async_load()
        if store.done_for(source_entity_id):
            return

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
            )
            # ``None`` means the recorder holds no state for this entity in the
            # chunk and none before it either, which is the walk's stopping
            # condition. An empty list is a chunk whose states were all
            # non-numeric -- unusual, but not evidence that history has ended.
            exhausted = rows is None
            if rows:
                async_import_statistics(
                    hass,
                    _metadata(target_entity_id, unit_of_measurement),
                    rows,
                )
                written += len(rows)
            cursor = chunk_start
            await store.async_record(
                source_entity_id=source_entity_id, oldest_hour=cursor, done=exhausted
            )
            if exhausted:
                break
            await asyncio.sleep(_CHUNK_PAUSE_SECONDS)

        # Info rather than debug: this runs a handful of times in an
        # installation's life, and how far back it reached is the one thing that
        # explains why a month view prices some buckets and not others.
        _LOGGER.info(
            "Back-filled %d hourly export price statistics for %s from %s, back to %s",
            written,
            target_entity_id,
            source_entity_id,
            cursor.isoformat(),
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        _LOGGER.exception(
            "Failed to back-fill export price statistics for %s", target_entity_id
        )


async def _first_hour_home_assistant_owns(
    hass: HomeAssistant, target_entity_id: str
) -> datetime:
    """The oldest hour the statistics compiler has written for the mirror.

    The back-fill must stop strictly before this, so that the compiler's rows and
    the imported ones never describe the same hour by two different routes.

    Usually there are none -- the mirror is new, and the first run of this
    back-fill happens within minutes of its first state -- and then the answer is
    the *current* hour: the compiler will write that one when it ends, and has
    never written an earlier one because the entity did not exist. Reading the
    series anyway costs one query on a path that runs once per installation, and
    is what makes the walk correct on an instance whose store was wiped while its
    statistics survived.
    """
    from .recorder_statistics_span import query_hourly_statistics

    now = dt_util.as_utc(dt_util.now())
    current_hour = now.replace(minute=0, second=0, microsecond=0)
    try:
        span = await query_hourly_statistics(
            hass,
            [target_entity_id],
            local_start=now - _MAX_SPAN,
            local_end=now,
        )
    except Exception:
        _LOGGER.exception(
            "Failed to read existing statistics for %s; "
            "back-filling from the current hour",
            target_entity_id,
        )
        return current_hour

    compiled = span.rows_for(target_entity_id)
    if not compiled:
        return current_hour
    return min(min(compiled), current_hour)


async def _chunk_statistics(
    hass: HomeAssistant,
    source_entity_id: str,
    *,
    utc_start: datetime,
    utc_end: datetime,
) -> list[StatisticData] | None:
    """One chunk's hourly rows, or ``None`` where the source has no history at all.

    ``None`` is the walk's stopping condition, and it means what it says: the
    recorder holds no state for this entity inside the chunk *and* none before it
    either -- ``include_start_time_state`` would otherwise have carried one in.
    Since the walk only ever moves further back, nothing older can exist. It is
    kept distinct from an empty list, which says the chunk had states but none
    that parsed as a number: an odd chunk is not a reason to conclude the
    history has ended.
    """
    recorder = get_instance(hass)

    def _query() -> list[Any]:
        history = state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            source_entity_id,
            # A rate's value is its state; the attributes on a spot-price entity
            # are its forward forecast, which is both large and irrelevant here.
            no_attributes=True,
            descending=False,
            limit=None,
            # The reading in force when the chunk opens. Without it every chunk
            # would lose the hours before its first write, and a quiet night
            # would read as no data rather than as an unchanged price.
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
    samples = _numeric_samples(states)
    if not samples:
        return []
    return _hourly_rows(samples, utc_start=utc_start, utc_end=utc_end)


def _numeric_samples(states: list[Any]) -> list[tuple[datetime, float]]:
    """``(instant, value)`` for every state that is a number, in time order.

    ``unavailable`` and ``unknown`` are dropped rather than treated as a gap,
    which is what the recorder's own compiler does with them: the previous
    reading keeps standing across the outage. That is also the truthful reading
    of a price -- a tariff does not stop applying because the integration
    reporting it lost its connection.
    """
    samples: list[tuple[datetime, float]] = []
    for state in states:
        try:
            value = float(state.state)
        except (AttributeError, TypeError, ValueError):
            continue
        instant = getattr(state, "last_updated", None)
        if not isinstance(instant, datetime):
            continue
        samples.append((dt_util.as_utc(instant), value))
    samples.sort(key=lambda sample: sample[0])
    return samples


def _hourly_rows(
    samples: list[tuple[datetime, float]],
    *,
    utc_start: datetime,
    utc_end: datetime,
) -> list[StatisticData]:
    """One :class:`StatisticData` per hour of the chunk that has any reading.

    Hours with nothing standing in them -- before the entity's first ever state,
    or through a stretch the recorder has purged -- are omitted rather than
    carried, so a hole in the source's history stays a hole in the mirror's
    statistics instead of being papered over with a rate that was never
    published.
    """
    rows: list[StatisticData] = []
    hour = utc_start.replace(minute=0, second=0, microsecond=0)
    if hour < utc_start:
        hour += timedelta(hours=1)

    # One forward sweep rather than a scan per hour: ``standing`` is the reading
    # in force as the hour opens, and ``index`` never walks backward, so a week
    # of a fast-writing entity costs one pass over its states and not 168.
    index = 0
    standing: tuple[datetime, float] | None = None
    while index < len(samples) and samples[index][0] <= hour:
        standing = samples[index]
        index += 1

    while hour < utc_end:
        hour_end = hour + timedelta(hours=1)
        inside: list[tuple[datetime, float]] = []
        while index < len(samples) and samples[index][0] < hour_end:
            inside.append(samples[index])
            index += 1
        window = ([standing] if standing is not None else []) + inside
        if inside:
            standing = inside[-1]
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


def _time_weighted_mean(
    window: list[tuple[datetime, float]],
    *,
    start: datetime,
    end: datetime,
) -> float:
    """The mean value *in force* across ``[start, end)``, weighted by duration.

    A deliberate re-implementation of the recorder's
    ``_time_weighted_arithmetic_mean``, including the part that looks like an
    edge case and is not: when the first reading arrives *after* the period
    began, the period is shortened to start there rather than the reading being
    stretched backward over time it did not apply to. An hour whose only reading
    lands at :50 therefore reports that reading, not a tenth of it.

    ``window`` must be in time order and must not be empty; the reading in force
    at ``start`` may carry a ``last_updated`` from before it, which is clamped
    the way the recorder clamps it.
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


def _metadata(target_entity_id: str, unit: str | None) -> StatisticMetaData:
    """What the imported rows describe, in the shape the recorder validates.

    ``source`` is the recorder's own domain and not ``helman``: the series being
    written is an entity's, which lives in the recorder's table, and
    ``async_import_statistics`` rejects anything else. ``unit_class`` is None
    because a currency per kilowatt-hour converts into nothing -- naming a class
    the unit does not belong to is an outright error, not a warning.
    """
    return StatisticMetaData(
        mean_type=StatisticMeanType.ARITHMETIC,
        has_sum=False,
        name=None,
        source=_RECORDER_DOMAIN,
        statistic_id=target_entity_id,
        unit_class=None,
        unit_of_measurement=unit,
    )
