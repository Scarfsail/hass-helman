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
from .statistics_backfill import (
    _CHUNK,
    _CHUNK_PAUSE_SECONDS,
    _MAX_SPAN,
    _RECORDER_DOMAIN,
    _first_hour_home_assistant_owns,
    _time_weighted_mean,
    async_walk_backward,
    first_compiled_hour,
    mean_metadata,
    time_weighted_hourly_rows,
    BackfillCursorStore,
)

_LOGGER = logging.getLogger(__name__)

_STORAGE_KEY = f"{DOMAIN}.grid_export_price_backfill"
_STORAGE_VERSION = 1


class GridExportPriceBackfillStore(BackfillCursorStore):
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
        super().__init__(hass, _STORAGE_KEY)


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
    store = GridExportPriceBackfillStore(hass)

    async def _read(
        chunk_start: datetime, cursor: datetime
    ) -> list[StatisticData] | None:
        return await _chunk_statistics(
            hass,
            source_entity_id,
            utc_start=chunk_start,
            utc_end=cursor,
        )

    await async_walk_backward(
        hass,
        store=store,
        source_entity_id=source_entity_id,
        target_entity_id=target_entity_id,
        metadata=_metadata(target_entity_id, unit_of_measurement),
        read_chunk=_read,
        log_name="export price",
        pause_seconds=_CHUNK_PAUSE_SECONDS,
        import_fn=async_import_statistics,
    )



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
    """One :class:`StatisticData` per hour of the chunk that has any reading."""
    return time_weighted_hourly_rows(samples, utc_start, utc_end, carry_in=True)


def _metadata(target_entity_id: str, unit: str | None) -> StatisticMetaData:
    """What the imported rows describe, in the shape the recorder validates."""
    return mean_metadata(target_entity_id, unit=unit, unit_class=None)

