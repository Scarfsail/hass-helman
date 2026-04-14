from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from .forecast_aggregation import (
    aggregate_grid_flow_series,
    get_aggregation_group_size,
    get_forecast_resolution,
)
from .slot_series_response import build_started_slot_series

_INTERNAL_SNAPSHOT_FIELDS = {
    "sourceGranularityMinutes",
    "baselineSeries",
}


def build_grid_flow_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    source_granularity_minutes = snapshot.get(
        "sourceGranularityMinutes",
        FORECAST_CANONICAL_GRANULARITY_MINUTES,
    )
    if not isinstance(source_granularity_minutes, int):
        source_granularity_minutes = FORECAST_CANONICAL_GRANULARITY_MINUTES

    group_size = get_aggregation_group_size(
        source_granularity_minutes=source_granularity_minutes,
        target_granularity_minutes=granularity,
    )
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in _INTERNAL_SNAPSHOT_FIELDS
        and key not in {"series", "resolution", "horizonHours"}
    }
    response["resolution"] = get_forecast_resolution(granularity)
    response["horizonHours"] = forecast_days * 24
    response["series"] = []

    if snapshot.get("status") not in {"available", "partial"}:
        return response

    started_at = _parse_timestamp(snapshot.get("startedAt"))
    if started_at is None:
        return response

    target_count = forecast_days * 24 * 60 // granularity
    response["series"] = [
        _build_public_entry(entry)
        for entry in build_started_slot_series(
            raw_entries=_merge_baseline_series(snapshot),
            started_at=started_at,
            granularity=granularity,
            group_size=group_size,
            aggregate_entries=aggregate_grid_flow_series,
        )[:target_count]
    ]
    return response


def _merge_baseline_series(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    series = _read_entries(snapshot.get("series"))
    baseline_series = _read_entries(snapshot.get("baselineSeries"))
    if not baseline_series:
        return series
    if len(series) != len(baseline_series):
        raise ValueError(
            "Grid flow baseline series must match effective series length"
        )

    merged: list[dict[str, Any]] = []
    for entry, baseline_entry in zip(series, baseline_series, strict=True):
        if entry.get("timestamp") != baseline_entry.get("timestamp"):
            raise ValueError(
                "Grid flow baseline series must align with effective series timestamps"
            )
        item = deepcopy(entry)
        item["baselineImportedFromGridKwh"] = deepcopy(
            baseline_entry.get("importedFromGridKwh")
        )
        item["baselineExportedToGridKwh"] = deepcopy(
            baseline_entry.get("exportedToGridKwh")
        )
        merged.append(item)
    return merged


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
    if (
        "baselineImportedFromGridKwh" in entry
        or "baselineExportedToGridKwh" in entry
    ):
        public_entry["baseline"] = {
            "importedFromGridKwh": deepcopy(
                entry.get("baselineImportedFromGridKwh")
            ),
            "exportedToGridKwh": deepcopy(
                entry.get("baselineExportedToGridKwh")
            ),
        }
    return public_entry


def _read_entries(raw_value: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_value, list):
        return []
    return [deepcopy(entry) for entry in raw_value if isinstance(entry, dict)]


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return datetime.fromisoformat(raw_value)
