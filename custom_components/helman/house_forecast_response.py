from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_CANONICAL_RESOLUTION,
)

_INTERNAL_SNAPSHOT_FIELDS = {
    "sourceGranularityMinutes",
    "forecastDaysAvailable",
}


def build_house_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
) -> dict[str, Any]:
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in _INTERNAL_SNAPSHOT_FIELDS
        and key not in {"currentHour", "currentSlot", "series", "actualHistory", "resolution", "horizonHours"}
    }
    response["resolution"] = FORECAST_CANONICAL_RESOLUTION
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

    # The canonical slot *is* the response bucket, so the snapshot's current
    # slot passes through as-is and the series simply starts after it.
    response["currentSlot"] = deepcopy(_require_dict(current_slot))
    response["series"] = _build_future_series(
        canonical_map=_build_entry_map(snapshot),
        current_slot_start=current_slot_start,
        forecast_days=forecast_days,
    )
    response["actualHistory"] = _build_actual_history(
        snapshot=snapshot,
        current_slot_start=current_slot_start,
    )
    return response


def _build_future_series(
    *,
    canonical_map: dict[datetime, dict[str, Any]],
    current_slot_start: datetime,
    forecast_days: int,
) -> list[dict[str, Any]]:
    target_count = (
        forecast_days * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES
    )
    if target_count <= 0:
        return []

    entries: list[dict[str, Any]] = []
    first_slot_start_utc = dt_util.as_utc(current_slot_start) + timedelta(
        minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES
    )
    for index in range(target_count):
        slot_start = dt_util.as_local(
            first_slot_start_utc
            + timedelta(
                minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * index
            )
        )
        entry = canonical_map.get(slot_start)
        if entry is None:
            break
        entries.append(entry)
    return entries


def _build_actual_history(
    *,
    snapshot: dict[str, Any],
    current_slot_start: datetime,
) -> list[dict[str, Any]]:
    raw_history = snapshot.get("actualHistory")
    if not isinstance(raw_history, list):
        return []

    filtered_entries: list[dict[str, Any]] = []
    current_slot_start_utc = dt_util.as_utc(current_slot_start)
    for entry in raw_history:
        if not isinstance(entry, dict):
            continue
        timestamp = _parse_timestamp(entry.get("timestamp"))
        if timestamp is None or dt_util.as_utc(timestamp) >= current_slot_start_utc:
            continue
        filtered_entries.append(deepcopy(entry))
    return filtered_entries


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


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)


def _require_dict(raw_value: Any) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        raise ValueError("Expected forecast entry to be a dict")
    return raw_value
