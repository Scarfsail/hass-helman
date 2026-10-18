from __future__ import annotations

from copy import deepcopy
from typing import Any

from .forecast_response import envelope, parse_ts, read_entries, slice_to_horizon

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
