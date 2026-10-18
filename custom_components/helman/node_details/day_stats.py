"""A day of a measurement, in five-minute buckets: mean, min, max and coverage;
and the recorded states of a few entities, the one recorder read of state history.

The node details' history answers (today's inverter temperature now; grid
voltages, string powers and base load in later phases) all ask the same thing
of the recorder: how did this reading move over a local day, and how much of
that day is actually known.

**Sources.** A sensor with mean statistics is read from the recorder's
five-minute short-term statistics: their ``min``/``max`` are the statistics'
own bucket extrema. A sensor without them falls back to its recorded states
over the same bounded window, aggregated here into five-minute buckets: its
``min``/``max`` are the raw recorded extrema, each state held until the next.

**Honesty.** A bucket without a reading is a gap, never a zero. A partly known
bucket keeps its ``coverage`` (the known share of its elapsed time), and every
mean is weighted by known duration, so a gap is never integrated. Buckets run in
UTC between the local day's boundaries, so a DST day is its actual 23 or 25
hours. The window stops at ``now``: nothing after it is a bucket.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..recorder_states import read_states
from ..slot_grid import slot_starts

BUCKET = timedelta(minutes=5)

#: A recorded stretch up to this long (an HA restart, a Modbus blip, a mode
#: written register by register) is not a state of its own: the charging
#: segment and today's inverter modes both read through it.
SEGMENT_MAX_GAP = timedelta(minutes=10)

#: What a bucket's ``min``/``max`` are, by source.
EXTREMA_KIND = {"statistics": "bucket_statistics", "history": "recorded"}


@dataclass
class _Bucket:
    start: datetime
    weighted_sum: float = 0.0
    covered_seconds: float = 0.0
    minimum: float | None = None
    maximum: float | None = None

    def add(self, value: float, seconds: float, *, extreme: tuple[float, float] | None = None) -> None:
        self.weighted_sum += value * seconds
        self.covered_seconds += seconds
        low, high = extreme if extreme is not None else (value, value)
        self.minimum = low if self.minimum is None else min(self.minimum, low)
        self.maximum = high if self.maximum is None else max(self.maximum, high)


def day_window(local_day_start: datetime) -> tuple[datetime, datetime]:
    """The local day starting at ``local_day_start``, as its UTC bounds."""
    start = dt_util.start_of_local_day(local_day_start)
    end = dt_util.start_of_local_day(start + timedelta(days=1, hours=2))
    return dt_util.as_utc(start), dt_util.as_utc(end)


def _bucket_starts(start: datetime, stop: datetime) -> list[datetime]:
    return slot_starts(start, stop, interval_minutes=5, utc=True)


def buckets_from_statistics(
    rows: Iterable[Mapping[str, Any]], start: datetime, stop: datetime
) -> list[_Bucket]:
    """Short-term statistics rows as buckets; a row is a fully known bucket.

    Rows outside ``[start, stop)`` and rows without a finite mean are dropped.
    """
    buckets: list[_Bucket] = []
    for row in rows:
        row_start = _as_datetime(row.get("start"))
        mean = _finite(row.get("mean"))
        if row_start is None or mean is None or not start <= row_start < stop:
            continue
        seconds = (min(row_start + BUCKET, stop) - row_start).total_seconds()
        low = _finite(row.get("min"))
        high = _finite(row.get("max"))
        bucket = _Bucket(start=row_start)
        bucket.add(
            mean,
            seconds,
            extreme=(mean if low is None else low, mean if high is None else high),
        )
        buckets.append(bucket)
    return sorted(buckets, key=lambda bucket: bucket.start)


def buckets_from_states(
    states: Sequence[Any], start: datetime, stop: datetime
) -> list[_Bucket]:
    """Recorded states as duration-weighted buckets over ``[start, stop)``.

    Each state holds from its ``last_changed`` until the next one, the last
    until ``stop``; a non-numeric state (``unavailable``, ``unknown``) is a gap.
    """
    spans: list[tuple[datetime, datetime, float]] = []
    ordered = sorted(states, key=lambda state: state.last_changed)
    for index, state in enumerate(ordered):
        value = _finite(state.state)
        if value is None:
            continue
        held_from = max(dt_util.as_utc(state.last_changed), start)
        held_until = (
            dt_util.as_utc(ordered[index + 1].last_changed)
            if index + 1 < len(ordered)
            else stop
        )
        held_until = min(held_until, stop)
        if held_until > held_from:
            spans.append((held_from, held_until, value))

    buckets: list[_Bucket] = []
    span_index = 0
    for bucket_start in _bucket_starts(start, stop):
        bucket_end = min(bucket_start + BUCKET, stop)
        bucket = _Bucket(start=bucket_start)
        # Spans are ordered and disjoint: skip the ones that ended already.
        while span_index < len(spans) and spans[span_index][1] <= bucket_start:
            span_index += 1
        cursor = span_index
        while cursor < len(spans) and spans[cursor][0] < bucket_end:
            span_start, span_end, value = spans[cursor]
            overlap = (min(span_end, bucket_end) - max(span_start, bucket_start)).total_seconds()
            if overlap > 0:
                bucket.add(value, overlap)
            cursor += 1
        if bucket.covered_seconds > 0:
            buckets.append(bucket)
    return buckets


def summarize(
    buckets: Sequence[_Bucket],
    *,
    start: datetime,
    stop: datetime,
    source: str,
    unit: str | None,
    entity_id: str,
) -> dict[str, Any]:
    """The payload for one entity: its buckets and the day's summary.

    ``coverage`` is the known share of the elapsed window; ``minAt``/``maxAt``
    are the start of the bucket holding the extreme.
    """
    elapsed = max((stop - start).total_seconds(), 0.0)
    covered = sum(bucket.covered_seconds for bucket in buckets)
    points = []
    for bucket in buckets:
        bucket_seconds = (min(bucket.start + BUCKET, stop) - bucket.start).total_seconds()
        points.append(
            {
                "start": dt_util.as_local(bucket.start).isoformat(),
                "mean": bucket.weighted_sum / bucket.covered_seconds,
                "min": bucket.minimum,
                "max": bucket.maximum,
                "coverage": min(1.0, bucket.covered_seconds / bucket_seconds)
                if bucket_seconds > 0
                else 0.0,
            }
        )
    lowest = min(buckets, key=lambda bucket: bucket.minimum, default=None)
    highest = max(buckets, key=lambda bucket: bucket.maximum, default=None)
    return {
        "entityId": entity_id,
        "unit": unit,
        "source": source,
        "extrema": EXTREMA_KIND[source],
        "bucketMinutes": int(BUCKET.total_seconds() // 60),
        "points": points,
        "mean": (
            sum(bucket.weighted_sum for bucket in buckets) / covered if covered > 0 else None
        ),
        "min": None if lowest is None else lowest.minimum,
        "minAt": None if lowest is None else dt_util.as_local(lowest.start).isoformat(),
        "max": None if highest is None else highest.maximum,
        "maxAt": None if highest is None else dt_util.as_local(highest.start).isoformat(),
        "coverage": min(1.0, covered / elapsed) if elapsed > 0 else 0.0,
    }


async def async_day_stats(
    hass: Any,
    entity_ids: Iterable[str | None],
    *,
    start: datetime,
    end: datetime,
    now: datetime,
) -> dict[str, dict[str, Any]]:
    """Each entity's day over ``[start, min(end, now))``, read in one recorder job.

    ``None`` and duplicate ids are dropped. The statistics metadata decides
    each entity's source; both reads run on the recorder's executor, never on
    the event loop.
    """
    from homeassistant.components.recorder import get_instance

    ids = list(dict.fromkeys(entity_id for entity_id in entity_ids if entity_id))
    utc_start = dt_util.as_utc(start)
    stop = min(dt_util.as_utc(end), dt_util.as_utc(now))
    if not ids or stop <= utc_start:
        return {
            entity_id: summarize(
                [], start=utc_start, stop=utc_start, source="history",
                unit=_live_unit(hass, entity_id), entity_id=entity_id,
            )
            for entity_id in ids
        }

    def _read_statistics() -> tuple[set[str], dict[str, list[dict[str, Any]]], dict[str, str | None]]:
        from homeassistant.components.recorder.statistics import (
            get_metadata,
            statistics_during_period,
        )

        # The recorder rejects ``statistic_type`` alongside ``statistic_ids``,
        # so filter for mean-carrying statistics here.
        metadata = {
            entity_id: meta
            for entity_id, (_meta_id, meta) in get_metadata(
                hass, statistic_ids=set(ids)
            ).items()
            if meta.get("mean_type")
        }
        with_statistics = {entity_id for entity_id in ids if entity_id in metadata}
        statistic_units = {
            entity_id: meta.get("unit_of_measurement")
            for entity_id, meta in metadata.items()
        }
        statistics = (
            statistics_during_period(
                hass,
                utc_start,
                stop,
                with_statistics,
                "5minute",
                None,
                {"mean", "min", "max"},
            )
            if with_statistics
            else {}
        )
        return with_statistics, statistics or {}, statistic_units

    with_statistics, statistics, statistic_units = await get_instance(
        hass
    ).async_add_executor_job(_read_statistics)

    without = [entity_id for entity_id in ids if entity_id not in with_statistics]
    history = (
        await read_states(
            hass, without, utc_start, stop, include_start_state=True, no_attributes=True
        )
        if without
        else {}
    )

    result = {}
    for entity_id in ids:
        # Statistics come back in their stored unit, which can differ from
        # the entity's display unit; recorded states carry the live one.
        unit = _live_unit(hass, entity_id)
        if entity_id in with_statistics:
            buckets = buckets_from_statistics(statistics.get(entity_id, []), utc_start, stop)
            source = "statistics"
            unit = statistic_units.get(entity_id) or unit
        else:
            buckets = buckets_from_states(history[entity_id], utc_start, stop)
            source = "history"
        result[entity_id] = summarize(
            buckets, start=utc_start, stop=stop, source=source, unit=unit, entity_id=entity_id
        )
    return result


async def async_state_history(
    hass: Any, entity_ids: Iterable[str], start: datetime, end: datetime
) -> dict[str, list[Any]]:
    """Each entity's recorded states over ``[start, end]``, the one before ``start`` included.

    Every id is a key, with an empty list when nothing is recorded. One read
    on the recorder's executor, never on the event loop; the newest state may
    not be committed yet, which :func:`with_live_state` adds.
    """
    return await read_states(
        hass, entity_ids, start, end, include_start_state=True, no_attributes=True
    )


def with_live_state(hass: Any, entity_id: str, states: Sequence[Any]) -> list[Any]:
    """``states`` with the live state appended when it is newer than the last recorded one.

    The recorder commits in batches: the live state may not be in it yet.
    """
    states = list(states)
    live = hass.states.get(entity_id)
    if live is not None and (not states or live.last_changed > states[-1].last_changed):
        states.append(live)
    return states


def _live_unit(hass: Any, entity_id: str) -> str | None:
    state = hass.states.get(entity_id)
    return None if state is None else state.attributes.get("unit_of_measurement")


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return dt_util.as_utc(value)
    if isinstance(value, (int, float)):
        return dt_util.utc_from_timestamp(value)
    return None


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None
