from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from .forecast_aggregation import (
    aggregate_house_entries,
    get_aggregation_group_size,
    get_forecast_resolution,
)
from .recorder_hourly_series import get_local_current_slot_start

_INTERNAL_SNAPSHOT_FIELDS = {
    "sourceGranularityMinutes",
    "forecastDaysAvailable",
    "alignmentPaddingSlots",
}


def build_house_forecast_response(
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
        and key not in {"currentHour", "currentSlot", "series", "actualHistory", "resolution", "horizonHours"}
    }
    response["resolution"] = get_forecast_resolution(granularity)
    response["horizonHours"] = forecast_days * 24
    response["actualHistory"] = []
    response["series"] = []

    if snapshot.get("status") != "available":
        return response

    current_slot = snapshot.get("currentSlot")
    current_slot_start = _parse_timestamp(
        current_slot.get("timestamp") if isinstance(current_slot, dict) else None
    )
    if current_slot_start is None:
        return response

    canonical_map = _build_entry_map(snapshot)
    current_bucket_start = get_local_current_slot_start(
        current_slot_start,
        interval_minutes=granularity,
    )
    current_entry = _build_current_entry(
        current_slot=_require_dict(current_slot),
        canonical_map=canonical_map,
        current_slot_start=current_slot_start,
        current_bucket_start=current_bucket_start,
        group_size=group_size,
    )
    if current_entry is not None:
        response["currentSlot"] = current_entry

    response["series"] = _build_future_series(
        canonical_map=canonical_map,
        current_bucket_start=current_bucket_start,
        group_size=group_size,
        granularity=granularity,
        forecast_days=forecast_days,
    )
    response["actualHistory"] = _build_actual_history(
        snapshot=snapshot,
        current_bucket_start=current_bucket_start,
        group_size=group_size,
    )
    return response


def _build_current_entry(
    *,
    current_slot: dict[str, Any],
    canonical_map: dict[datetime, dict[str, Any]],
    current_slot_start: datetime,
    current_bucket_start: datetime,
    group_size: int,
) -> dict[str, Any] | None:
    if group_size == 1:
        return deepcopy(current_slot)

    current_slot_start_utc = dt_util.as_utc(current_slot_start)
    entries: list[dict[str, Any]] = []
    for slot_start in _iter_bucket_slot_starts(current_bucket_start, group_size=group_size):
        slot_start_utc = dt_util.as_utc(slot_start)
        if slot_start_utc < current_slot_start_utc:
            entries.append(_clone_entry_with_timestamp(current_slot, slot_start))
            continue
        entry = canonical_map.get(slot_start)
        if entry is None:
            return None
        entries.append(entry)
    return aggregate_house_entries(entries, group_size=group_size)[0]


def _build_future_series(
    *,
    canonical_map: dict[datetime, dict[str, Any]],
    current_bucket_start: datetime,
    group_size: int,
    granularity: int,
    forecast_days: int,
) -> list[dict[str, Any]]:
    target_count = forecast_days * 24 * 60 // granularity
    if target_count <= 0:
        return []

    canonical_entries: list[dict[str, Any]] = []
    first_bucket_start_utc = dt_util.as_utc(current_bucket_start) + timedelta(
        minutes=granularity
    )
    for index in range(target_count * group_size):
        slot_start = dt_util.as_local(
            first_bucket_start_utc
            + timedelta(
                minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * index
            )
        )
        entry = canonical_map.get(slot_start)
        if entry is None:
            break
        canonical_entries.append(entry)

    if group_size == 1:
        return canonical_entries[:target_count]

    complete_length = len(canonical_entries) - (len(canonical_entries) % group_size)
    if complete_length <= 0:
        return []
    return aggregate_house_entries(
        canonical_entries[:complete_length],
        group_size=group_size,
    )[:target_count]


def _build_actual_history(
    *,
    snapshot: dict[str, Any],
    current_bucket_start: datetime,
    group_size: int,
) -> list[dict[str, Any]]:
    raw_history = snapshot.get("actualHistory")
    if not isinstance(raw_history, list):
        return []

    filtered_entries: list[dict[str, Any]] = []
    current_bucket_start_utc = dt_util.as_utc(current_bucket_start)
    for entry in raw_history:
        if not isinstance(entry, dict):
            continue
        timestamp = _parse_timestamp(entry.get("timestamp"))
        if timestamp is None or dt_util.as_utc(timestamp) >= current_bucket_start_utc:
            continue
        filtered_entries.append(deepcopy(entry))

    if group_size == 1:
        return filtered_entries

    complete_length = len(filtered_entries) - (len(filtered_entries) % group_size)
    if complete_length <= 0:
        return []
    return aggregate_house_entries(
        filtered_entries[:complete_length],
        group_size=group_size,
    )


def _build_entry_map(snapshot: dict[str, Any]) -> dict[datetime, dict[str, Any]]:
    result: dict[datetime, dict[str, Any]] = {}
    current_slot = snapshot.get("currentSlot")
    if isinstance(current_slot, dict):
        current_slot_start = _parse_timestamp(current_slot.get("timestamp"))
        if current_slot_start is not None:
            result[current_slot_start] = deepcopy(current_slot)

    series = snapshot.get("series")
    if not isinstance(series, list):
        return result

    for entry in series:
        if not isinstance(entry, dict):
            continue
        slot_start = _parse_timestamp(entry.get("timestamp"))
        if slot_start is None:
            continue
        result[slot_start] = deepcopy(entry)
    return result


def _iter_bucket_slot_starts(
    bucket_start: datetime,
    *,
    group_size: int,
) -> list[datetime]:
    bucket_start_utc = dt_util.as_utc(bucket_start)
    return [
        dt_util.as_local(
            bucket_start_utc
            + timedelta(
                minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * index
            )
        )
        for index in range(group_size)
    ]


def _clone_entry_with_timestamp(entry: dict[str, Any], slot_start: datetime) -> dict[str, Any]:
    cloned_entry = deepcopy(entry)
    cloned_entry["timestamp"] = slot_start.isoformat()
    return cloned_entry


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)


def _require_dict(raw_value: Any) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        raise ValueError("Expected forecast entry to be a dict")
    return raw_value
