from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
)

_INTERNAL_SNAPSHOT_FIELDS = {
    "sourceGranularityMinutes",
}


def build_grid_flow_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
) -> dict[str, Any]:
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in _INTERNAL_SNAPSHOT_FIELDS
        and key not in {"series"}
    }
    response["series"] = []

    if snapshot.get("status") not in {"available", "partial"}:
        return response

    started_at = _parse_timestamp(snapshot.get("startedAt"))
    if started_at is None:
        return response

    target_count = (
        forecast_days * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES
    )
    response["series"] = [
        _build_public_entry(entry)
        for entry in _read_entries(snapshot.get("series"))[:target_count]
    ]
    return response


def _build_public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    public_entry = {
        "timestamp": deepcopy(entry.get("timestamp")),
        "durationHours": deepcopy(entry.get("durationHours")),
        "importedFromGridKwh": deepcopy(entry.get("importedFromGridKwh")),
        "exportedToGridKwh": deepcopy(entry.get("exportedToGridKwh")),
    }
    if "availableSurplusKwh" in entry:
        public_entry["availableSurplusKwh"] = deepcopy(
            entry.get("availableSurplusKwh")
        )
    return public_entry


def _read_entries(raw_value: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_value, list):
        return []
    return [deepcopy(entry) for entry in raw_value if isinstance(entry, dict)]


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return datetime.fromisoformat(raw_value)
