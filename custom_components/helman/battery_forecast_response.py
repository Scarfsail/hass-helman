from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from .forecast_aggregation import (
    aggregate_battery_history_entries,
    aggregate_battery_series,
    get_aggregation_group_size,
    get_forecast_resolution,
)
from .recorder_hourly_series import get_local_current_slot_start

_INTERNAL_SNAPSHOT_FIELDS = {
    "sourceGranularityMinutes",
}


def build_battery_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    group_size = get_aggregation_group_size(
        source_granularity_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        target_granularity_minutes=granularity,
    )
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in _INTERNAL_SNAPSHOT_FIELDS
        and key not in {"series", "actualHistory", "resolution", "horizonHours"}
    }
    response["resolution"] = get_forecast_resolution(granularity)
    response["horizonHours"] = forecast_days * 24
    response["actualHistory"] = []
    response["series"] = []

    if snapshot.get("status") not in {"available", "partial"}:
        return response

    started_at = _parse_timestamp(snapshot.get("startedAt"))
    if started_at is None:
        return response

    target_count = forecast_days * 24 * 60 // granularity
    response["series"] = _build_series(
        snapshot=snapshot,
        started_at=started_at,
        granularity=granularity,
        group_size=group_size,
    )[:target_count]
    response["actualHistory"] = _build_actual_history(
        snapshot=snapshot,
        started_at=started_at,
        granularity=granularity,
        group_size=group_size,
    )
    return response


def _build_series(
    *,
    snapshot: dict[str, Any],
    started_at: datetime,
    granularity: int,
    group_size: int,
) -> list[dict[str, Any]]:
    canonical_entries = _read_entries(snapshot.get("series"))
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
            aggregate_battery_series(first_chunk, group_size=len(first_chunk))
        )

    remaining_entries = canonical_entries[entry_index:]
    complete_length = len(remaining_entries) - (len(remaining_entries) % group_size)
    if complete_length <= 0:
        return aggregated
    aggregated.extend(
        aggregate_battery_series(
            remaining_entries[:complete_length],
            group_size=group_size,
        )
    )
    return aggregated


def _build_actual_history(
    *,
    snapshot: dict[str, Any],
    started_at: datetime,
    granularity: int,
    group_size: int,
) -> list[dict[str, Any]]:
    raw_history = _read_entries(snapshot.get("actualHistory"))
    current_bucket_start = get_local_current_slot_start(
        started_at,
        interval_minutes=granularity,
    )
    current_bucket_start_utc = dt_util.as_utc(current_bucket_start)
    filtered_entries = [
        entry
        for entry in raw_history
        if (
            (timestamp := _parse_timestamp(entry.get("timestamp"))) is not None
            and dt_util.as_utc(timestamp) < current_bucket_start_utc
        )
    ]

    if group_size == 1:
        return filtered_entries

    complete_length = len(filtered_entries) - (len(filtered_entries) % group_size)
    if complete_length <= 0:
        return []
    return aggregate_battery_history_entries(
        filtered_entries[:complete_length],
        group_size=group_size,
    )


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
