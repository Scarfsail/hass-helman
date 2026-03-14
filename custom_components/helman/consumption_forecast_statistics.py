from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .const import (
    HOUSE_FORECAST_LOWER_PERCENTILE,
    HOUSE_FORECAST_UPPER_PERCENTILE,
)


@dataclass(frozen=True)
class ForecastBand:
    value: float
    lower: float
    upper: float

    def to_dict(self) -> dict[str, float]:
        return {
            "value": self.value,
            "lower": self.lower,
            "upper": self.upper,
        }


def percentile(sorted_values: Sequence[float], percentile_value: float) -> float:
    """Compute a percentile from pre-sorted values using linear interpolation."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return float(sorted_values[0])

    bounded_percentile = max(0.0, min(1.0, percentile_value))
    position = bounded_percentile * (len(sorted_values) - 1)
    lower_index = int(position)
    upper_index = min(len(sorted_values) - 1, lower_index + 1)
    fraction = position - lower_index
    lower_value = float(sorted_values[lower_index])
    upper_value = float(sorted_values[upper_index])
    return lower_value + fraction * (upper_value - lower_value)


def winsorized_mean(values: Sequence[float], lower: float, upper: float) -> float:
    """Compute the mean after clipping values to the provided bounds."""
    if not values:
        return 0.0

    clipped_total = sum(min(max(value, lower), upper) for value in values)
    return clipped_total / len(values)


def summarize_winsorized_values(
    values: Sequence[float],
    *,
    lower_percentile: float = HOUSE_FORECAST_LOWER_PERCENTILE,
    upper_percentile: float = HOUSE_FORECAST_UPPER_PERCENTILE,
) -> ForecastBand:
    """Summarize values with a winsorized center and raw percentile spread."""
    if not values:
        return ForecastBand(0.0, 0.0, 0.0)

    sorted_values = sorted(float(value) for value in values)
    lower = percentile(sorted_values, lower_percentile)
    upper = percentile(sorted_values, upper_percentile)
    center = winsorized_mean(sorted_values, lower, upper)

    return ForecastBand(
        value=round(center, 4),
        lower=round(lower, 4),
        upper=round(upper, 4),
    )
