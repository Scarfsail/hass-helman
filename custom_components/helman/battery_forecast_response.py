from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_CANONICAL_RESOLUTION,
)
from .forecast_series_fields import (
    BATTERY_PUBLIC_SERIES_FIELDS,
    project_series_fields,
)
from .recorder_hourly_series import get_local_current_slot_start

_INTERNAL_SNAPSHOT_FIELDS = {
    "sourceGranularityMinutes",
    "baselineSeries",
}


def build_battery_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
) -> dict[str, Any]:
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in _INTERNAL_SNAPSHOT_FIELDS
        and key not in {"series", "actualHistory", "resolution", "horizonHours"}
    }
    response["resolution"] = FORECAST_CANONICAL_RESOLUTION
    response["horizonHours"] = forecast_days * 24
    response["actualHistory"] = []
    response["series"] = []

    if snapshot.get("status") not in {"available", "partial"}:
        return response

    started_at = _parse_timestamp(snapshot.get("startedAt"))
    if started_at is None:
        return response

    target_count = (
        forecast_days * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES
    )
    response["series"] = project_series_fields(
        _read_entries(snapshot.get("series")),
        BATTERY_PUBLIC_SERIES_FIELDS,
    )[:target_count]
    response["actualHistory"] = _build_actual_history(
        snapshot=snapshot,
        started_at=started_at,
    )
    return response


def _build_actual_history(
    *,
    snapshot: dict[str, Any],
    started_at: datetime,
) -> list[dict[str, Any]]:
    """History strictly before the slot the run started in.

    Floored to the slot rather than cut at ``started_at`` itself: the slot in
    progress belongs to the series, so an entry stamped at its start must not
    also appear as history.
    """
    current_slot_start_utc = dt_util.as_utc(
        get_local_current_slot_start(
            started_at,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
    )
    return [
        entry
        for entry in _read_entries(snapshot.get("actualHistory"))
        if (
            (timestamp := _parse_timestamp(entry.get("timestamp"))) is not None
            and dt_util.as_utc(timestamp) < current_slot_start_utc
        )
    ]


def _read_entries(raw_value: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_value, list):
        return []
    return [deepcopy(entry) for entry in raw_value if isinstance(entry, dict)]


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)
