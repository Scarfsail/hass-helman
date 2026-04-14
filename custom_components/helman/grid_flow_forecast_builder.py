from __future__ import annotations

from copy import deepcopy
from typing import Any

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from .forecast_series_fields import (
    GRID_FLOW_BASELINE_SERIES_FIELDS,
    GRID_FLOW_EFFECTIVE_SERIES_FIELDS,
    project_series_fields,
)

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
    snapshot["series"] = project_series_fields(
        battery_snapshot.get("series"),
        GRID_FLOW_EFFECTIVE_SERIES_FIELDS,
    )

    baseline_series = battery_snapshot.get("baselineSeries")
    if isinstance(baseline_series, list):
        snapshot["baselineSeries"] = project_series_fields(
            baseline_series,
            GRID_FLOW_BASELINE_SERIES_FIELDS,
        )

    return snapshot
