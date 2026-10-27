from __future__ import annotations

from copy import deepcopy
from typing import Any

from .forecast_response import envelope, parse_ts, read_entries, slice_to_horizon
from .forecast_series_fields import GRID_FLOW_EFFECTIVE_SERIES_FIELDS

#: Always present on a public entry.
_REQUIRED_FIELDS = (
    "timestamp",
    "durationHours",
    "importedFromGridKwh",
    "exportedToGridKwh",
)

#: Copied onto a public entry only when the snapshot entry carries them.
_OPTIONAL_FIELDS = tuple(
    field
    for field in GRID_FLOW_EFFECTIVE_SERIES_FIELDS
    if field not in _REQUIRED_FIELDS
)

_DROP_FIELDS = {
    "sourceGranularityMinutes",
    "series",
}


def build_grid_flow_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
) -> dict[str, Any]:
    response = envelope(snapshot, drop=_DROP_FIELDS)
    response["series"] = []

    if snapshot.get("status") not in {"available", "partial"}:
        return response

    started_at = parse_ts(snapshot.get("startedAt"))
    if started_at is None:
        return response

    response["series"] = [
        _build_public_entry(entry)
        for entry in slice_to_horizon(
            read_entries(snapshot.get("series")),
            forecast_days=forecast_days,
        )
    ]
    return response


def _build_public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    public_entry = {key: deepcopy(entry.get(key)) for key in _REQUIRED_FIELDS}
    for key in _OPTIONAL_FIELDS:
        if key in entry:
            public_entry[key] = deepcopy(entry[key])
    return public_entry
