from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable

BATTERY_PUBLIC_SERIES_FIELDS = (
    "timestamp",
    "durationHours",
    "solarKwh",
    "baselineHouseKwh",
    "netKwh",
    "chargedKwh",
    "dischargedKwh",
    "remainingEnergyKwh",
    "socPct",
    "importedFromGridKwh",
    "exportedToGridKwh",
    "hitMinSoc",
    "hitMaxSoc",
    "limitedByChargePower",
    "limitedByDischargePower",
    "baselineRemainingEnergyKwh",
    "baselineSocPct",
)

GRID_FLOW_EFFECTIVE_SERIES_FIELDS = (
    "timestamp",
    "durationHours",
    "importedFromGridKwh",
    "exportedToGridKwh",
    "availableSurplusKwh",
)

GRID_FLOW_BASELINE_SERIES_FIELDS = (
    "timestamp",
    "durationHours",
    "importedFromGridKwh",
    "exportedToGridKwh",
)


def project_series_fields(
    raw_series: Any,
    allowed_fields: Iterable[str],
) -> list[dict[str, Any]]:
    if not isinstance(raw_series, list):
        return []

    field_names = tuple(allowed_fields)
    return [
        {
            key: deepcopy(raw_entry[key])
            for key in field_names
            if key in raw_entry
        }
        for raw_entry in raw_series
        if isinstance(raw_entry, dict)
    ]
