"""Canonical quarter-hour grid, stepped in UTC across local DST boundaries."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from datetime import tzinfo as TzInfo
from itertools import pairwise

from homeassistant.util import dt as dt_util

SLOT_MINUTES = 15
SLOT = timedelta(minutes=SLOT_MINUTES)
SLOTS_PER_HOUR = 60 // SLOT_MINUTES
SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR
SUB_SLOT_OFFSETS_MIN = tuple(range(0, 60, SLOT_MINUTES))
SLOT_LABELS = tuple(
    f"{minutes // 60:02d}:{minutes % 60:02d}"
    for minutes in range(0, 24 * 60, SLOT_MINUTES)
)


def floor_to_slot(
    reference_time: datetime,
    *,
    interval_minutes: int = SLOT_MINUTES,
) -> datetime:
    validated_interval_minutes = _validate_interval_minutes(interval_minutes)
    local_day_start = _get_local_day_start(reference_time)
    local_reference = dt_util.as_local(reference_time)
    slot_duration_seconds = validated_interval_minutes * 60
    # Floor from local midnight in UTC so DST gaps/repeated hours normalize to
    # real local slot boundaries instead of synthetic wall-clock timestamps.
    elapsed_seconds = max(
        0.0,
        (
            dt_util.as_utc(local_reference) - dt_util.as_utc(local_day_start)
        ).total_seconds(),
    )
    slot_index = int(elapsed_seconds // slot_duration_seconds)
    slot_start_utc = dt_util.as_utc(local_day_start) + timedelta(
        seconds=slot_index * slot_duration_seconds
    )
    return dt_util.as_local(slot_start_utc)


get_local_current_slot_start = floor_to_slot


def _get_local_day_start(reference_time: datetime) -> datetime:
    local_reference = dt_util.as_local(reference_time)
    tzinfo = local_reference.tzinfo
    if tzinfo is None:
        return local_reference.replace(hour=0, minute=0, second=0, microsecond=0)

    return datetime.combine(
        local_reference.date(),
        time.min,
        tzinfo=tzinfo,
    )


get_local_day_start = _get_local_day_start


def _validate_interval_minutes(interval_minutes: int) -> int:
    if (
        isinstance(interval_minutes, bool)
        or not isinstance(interval_minutes, int)
        or interval_minutes <= 0
    ):
        raise ValueError("interval_minutes must be a positive integer")
    return interval_minutes


def advance(
    value: datetime, *, slot_count: int = 1, interval_minutes: int = SLOT_MINUTES
) -> datetime:
    """Advance by real intervals and return a local datetime."""
    return dt_util.as_local(
        dt_util.as_utc(value) + timedelta(minutes=interval_minutes * slot_count)
    )


def slot_starts(
    start: datetime,
    end: datetime,
    *,
    interval_minutes: int = SLOT_MINUTES,
    utc: bool = False,
) -> list[datetime]:
    """Slot starts in [start, end), returned locally or as UTC instants."""
    interval_minutes = _validate_interval_minutes(interval_minutes)
    cursor = dt_util.as_utc(start)
    end_utc = dt_util.as_utc(end)
    result = []
    while cursor < end_utc:
        result.append(cursor if utc else dt_util.as_local(cursor))
        cursor += timedelta(minutes=interval_minutes)
    return result


_build_local_slot_starts_until = slot_starts


def day_slots(
    day: date, *, tzinfo: TzInfo | None = None, wall_clock: bool = False
) -> list[datetime]:
    """Real slots in a day, or 96 wall labels for label-indexed histories."""
    start = datetime.combine(day, time.min, tzinfo=tzinfo or dt_util.DEFAULT_TIME_ZONE)
    if wall_clock:
        return [start + index * SLOT for index in range(SLOTS_PER_DAY)]
    return slot_starts(start, start + timedelta(days=1))


def slot_to_minutes(slot: str) -> int:
    """Parse a valid HH:MM label, raising ValueError for invalid labels."""
    hour_text, minute_text = slot.split(":")
    hour, minute = int(hour_text), int(minute_text)
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise ValueError("slot must contain a valid hour and minute")
    return hour * 60 + minute


def expand_points_to_grid(
    points: list[tuple[datetime, float]], *, expansion_mode: str
) -> list[dict]:
    """Split energy or repeat values from a regular coarser point series."""
    intervals = [
        round((dt_util.as_utc(right[0]) - dt_util.as_utc(left[0])).total_seconds() / 60)
        for left, right in pairwise(points)
        if dt_util.as_utc(right[0]) > dt_util.as_utc(left[0])
    ]
    interval = min(intervals) if intervals else SLOT_MINUTES
    factor = (
        interval // SLOT_MINUTES
        if interval >= SLOT_MINUTES and interval % SLOT_MINUTES == 0
        else 1
    )
    result = []
    for start, value in points:
        slot_value = value / factor if expansion_mode == "split" else value
        for index in range(factor):
            result.append(
                {
                    "timestamp": advance(start, slot_count=index).isoformat(),
                    "value": round(slot_value, 4),
                }
            )
    return result


def split_hour_by_weights(hour_wh: float, sub_weights: list[float]) -> list[float]:
    """Split one hour's Wh across its sub-slots, weighted by ``sub_weights``.

    The weights are the upstream instantaneous-power samples, so the split
    follows the real intra-hour shape of the curve rather than flattening it.

    Falls back to an even split when the weights carry no signal — they sum to
    zero or less — which is what a night-time hour looks like.
    """
    if not sub_weights:
        return []

    total_weight = sum(sub_weights)
    if total_weight <= 0.0:
        share = hour_wh / len(sub_weights)
        return [share] * len(sub_weights)

    return [hour_wh * weight / total_weight for weight in sub_weights]
