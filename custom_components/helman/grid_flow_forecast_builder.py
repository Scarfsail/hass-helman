from __future__ import annotations

from copy import deepcopy
from typing import Any

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES

_METADATA_FIELDS = (
    "status",
    "generatedAt",
    "startedAt",
    "unit",
    "partialReason",
    "coverageUntil",
    "scheduleAdjusted",
    "scheduleAdjustmentCoverageUntil",
)
_SERIES_FIELDS = (
    "timestamp",
    "durationHours",
    "importedFromGridKwh",
    "exportedToGridKwh",
)


def build_grid_flow_forecast_snapshot(
    battery_snapshot: dict[str, Any],
) -> dict[str, Any]:
    snapshot = {
        key: deepcopy(battery_snapshot[key])
        for key in _METADATA_FIELDS
        if key in battery_snapshot
    }
    snapshot["unit"] = "kWh"
    snapshot["sourceGranularityMinutes"] = battery_snapshot.get(
        "sourceGranularityMinutes",
        FORECAST_CANONICAL_GRANULARITY_MINUTES,
    )
    snapshot["series"] = _project_series(battery_snapshot.get("series"))

    baseline_series = battery_snapshot.get("baselineSeries")
    if isinstance(baseline_series, list):
        snapshot["baselineSeries"] = _project_series(baseline_series)

    return snapshot


def _project_series(raw_series: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_series, list):
        return []

    projected: list[dict[str, Any]] = []
    for raw_entry in raw_series:
        if not isinstance(raw_entry, dict):
            continue
        projected.append(
            {
                key: deepcopy(raw_entry[key])
                for key in _SERIES_FIELDS
                if key in raw_entry
            }
        )
    return projected
