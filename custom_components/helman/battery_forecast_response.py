from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
)
from .forecast_response import envelope, parse_ts, read_entries, slice_to_horizon
from .forecast_series_fields import (
    BATTERY_PUBLIC_SERIES_FIELDS,
    project_series_fields,
)
from .slot_grid import get_local_current_slot_start

_DROP_FIELDS = {
    "sourceGranularityMinutes",
    "baselineSeries",
    "series",
    "actualHistory",
    "forecastHistory",
}


def build_battery_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
) -> dict[str, Any]:
    response = envelope(snapshot, drop=_DROP_FIELDS)
    response["actualHistory"] = []
    response["forecastHistory"] = []
    response["series"] = []

    if snapshot.get("status") not in {"available", "partial"}:
        return response

    started_at = parse_ts(snapshot.get("startedAt"))
    if started_at is None:
        return response

    response["series"] = slice_to_horizon(
        project_series_fields(
            read_entries(snapshot.get("series")),
            BATTERY_PUBLIC_SERIES_FIELDS,
        ),
        forecast_days=forecast_days,
    )
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
        for entry in read_entries(snapshot.get("actualHistory"))
        if (
            (timestamp := parse_ts(entry.get("timestamp"))) is not None
            and dt_util.as_utc(timestamp) < current_slot_start_utc
        )
    ]
