from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any, Callable

from homeassistant.util import dt as dt_util

from .recorder_hourly_series import get_local_current_slot_start

SeriesAggregator = Callable[..., list[dict[str, Any]]]


def build_started_slot_series(
    *,
    raw_entries: Any,
    started_at: datetime,
    granularity: int,
    group_size: int,
    aggregate_entries: SeriesAggregator,
) -> list[dict[str, Any]]:
    canonical_entries = _read_entries(raw_entries)
    if group_size == 1:
        return canonical_entries
    if not canonical_entries:
        return []

    current_bucket_start = get_local_current_slot_start(
        started_at,
        interval_minutes=granularity,
    )
    first_bucket_end = _advance_minutes(current_bucket_start, minutes=granularity)
    first_bucket_end_utc = dt_util.as_utc(first_bucket_end)

    first_chunk: list[dict[str, Any]] = []
    entry_index = 0
    while entry_index < len(canonical_entries):
        timestamp = _parse_timestamp(canonical_entries[entry_index].get("timestamp"))
        if timestamp is None or dt_util.as_utc(timestamp) >= first_bucket_end_utc:
            break
        first_chunk.append(canonical_entries[entry_index])
        entry_index += 1

    aggregated: list[dict[str, Any]] = []
    if first_chunk:
        aggregated.extend(
            aggregate_entries(first_chunk, group_size=len(first_chunk))
        )

    remaining_entries = canonical_entries[entry_index:]
    complete_length = len(remaining_entries) - (len(remaining_entries) % group_size)
    if complete_length <= 0:
        return aggregated

    aggregated.extend(
        aggregate_entries(
            remaining_entries[:complete_length],
            group_size=group_size,
        )
    )
    return aggregated


def _read_entries(raw_value: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_value, list):
        return []
    return [deepcopy(entry) for entry in raw_value if isinstance(entry, dict)]


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)


def _advance_minutes(value: datetime, *, minutes: int) -> datetime:
    return dt_util.as_local(dt_util.as_utc(value) + timedelta(minutes=minutes))
