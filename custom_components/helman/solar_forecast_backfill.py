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
from homeassistant.components.recorder.history import get_significant_states
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
from .slot_grid import SLOT_MINUTES, slot_starts
from .solar_bias_correction.forecast_slot_history import (
    SOLAR_FORECAST_CURRENT_ENTITY,
)
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

_STORAGE_KEY = f"{DOMAIN}.solar_forecast_backfill"
_STORAGE_VERSION = 1


class SolarForecastBackfillStore(BackfillCursorStore):
    """Where the backward walk got to, across restarts.

    Persisted payload shape (v1)::

        {"version": 1, "source": "sensor.x", "oldest_hour": "...", "done": bool}

    ``source`` is what the cursor was walked from, and it is why ``done`` can be
    trusted: point the config at a different forecast provider and the new
    entity's history would otherwise never be read, a ``done`` set against the
    old id latching forever.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(hass, _STORAGE_KEY)


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
    store = SolarForecastBackfillStore(hass)
    timezone = ZoneInfo(str(hass.config.time_zone))

    async def _read(
        chunk_start: datetime, cursor: datetime
    ) -> list[StatisticData] | None:
        return await _chunk_statistics(
            hass,
            source_entity_id,
            utc_start=chunk_start,
            utc_end=cursor,
            timezone=timezone,
        )

    await async_walk_backward(
        hass,
        store=store,
        source_entity_id=source_entity_id,
        target_entity_id=target_entity_id,
        metadata=_metadata(target_entity_id),
        read_chunk=_read,
        log_name="solar forecast",
        pause_seconds=_CHUNK_PAUSE_SECONDS,
        import_fn=async_import_statistics,
    )



async def _chunk_statistics(
    hass: HomeAssistant,
    source_entity_id: str,
    *,
    utc_start: datetime,
    utc_end: datetime,
    timezone: ZoneInfo,
) -> list[StatisticData] | None:
    """One chunk's hourly rows, or ``None`` where the source has no history.

    ``None`` is the walk's stopping condition, and there are two ways to reach
    it. The recorder holds no state for this entity inside the chunk and none
    before it either -- ``include_start_time_state`` would have carried one in
    otherwise. Or it holds states that carry no ``wh_period_15m`` at all, which
    is what the history looks like before the upstream integration began
    publishing that attribute: real rows, no recoverable curve, and nothing
    older that could have one.
    """
    recorder = get_instance(hass)

    def _query() -> list[Any]:
        # ``get_significant_states`` with ``significant_changes_only=False``,
        # not ``state_changes_during_period``, and the difference is the whole
        # module. The latter filters to
        # ``last_changed_ts == last_updated_ts``, which keeps only rows whose
        # *state value* moved -- and the value here is a rounded day total that
        # frequently does not, while the curve underneath it is republished
        # anyway. Every such republication would be dropped, and the slots it
        # covers would silently fall back to an older publication, so a
        # back-filled hour would disagree with the row the live sensor recorded
        # for the same slot. ``forecast_slot_history`` reads its own entity the
        # same way for the same reason.
        history = get_significant_states(
            hass,
            utc_start,
            utc_end,
            [source_entity_id],
            # The forecast map *is* the data here, which is the one place this
            # walk parts company with the export-price one.
            no_attributes=False,
            significant_changes_only=False,
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
        # States, but none carrying a curve. The upstream integration only began
        # publishing ``wh_period_15m`` on 2026-08-19, and the hourly ``wh_period``
        # it published before that cannot be split into slots without inventing
        # the shape -- which is the one thing this measurement must not do. So
        # this is the walk's other ending, not a chunk to step over: continuing
        # would read every remaining week to the 1100-day guard, with attributes,
        # importing nothing.
        return None
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
        # ``last_updated``, never ``last_changed``: an attribute-only
        # republication leaves ``last_changed`` at the earlier value, which
        # would date the revision before it was published and let a
        # *post*-slot curve win the "last publication before this slot" test.
        stamp = getattr(state, "last_updated", None) or getattr(
            state, "last_changed", None
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
    """``(slot_start, wh)`` for each slot, at the horizon the sensor records.

    A slot takes the value held by the last publication that predates it, which
    is what was knowable when the slot began. A slot no such publication covers
    is omitted rather than carried: the source had not yet published that day,
    so nothing was believed about it, and the live sensor would have recorded
    nothing either.

    The value is the slot's Wh as published, which is what the target entity
    carries too -- so a back-filled row and a recorded one are the same number
    for the same slot, not two encodings of it.
    """
    if not publications:
        return []
    samples: list[tuple[datetime, float]] = []
    slot = utc_start.replace(second=0, microsecond=0)
    slot -= timedelta(minutes=slot.minute % SLOT_MINUTES)
    if slot < utc_start:
        slot += timedelta(minutes=SLOT_MINUTES)

    index = 0
    latest: dict[datetime, float] | None = None
    for slot in slot_starts(slot, utc_end, utc=True):
        while index < len(publications) and publications[index][0] <= slot:
            latest = publications[index][1]
            index += 1
        if latest is not None and slot in latest:
            samples.append((slot, latest[slot]))
    return samples


def _hourly_rows(
    samples: list[tuple[datetime, float]],
    *,
    utc_start: datetime,
    utc_end: datetime,
) -> list[StatisticData]:
    """One row per hour that has any slot, time weighted across the hour."""
    return time_weighted_hourly_rows(samples, utc_start, utc_end, carry_in=False)


def _metadata(target_entity_id: str) -> StatisticMetaData:
    """What the imported rows describe, in the shape the recorder validates."""
    return mean_metadata(target_entity_id, unit="Wh", unit_class="energy")

