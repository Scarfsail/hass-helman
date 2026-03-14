from __future__ import annotations

from .const import (
    HOUSE_FORECAST_DEFAULT_MIN_SLOT_POINTS,
    HOUSE_FORECAST_LOWER_PERCENTILE,
    HOUSE_FORECAST_UPPER_PERCENTILE,
)
from .consumption_forecast_statistics import ForecastBand, summarize_winsorized_values


class HourOfWeekWinsorizedMeanProfile:
    """168-slot hour-of-week profile with same-hour-any-day sparse fallback."""

    SLOTS = 168  # 7 days x 24 hours

    def __init__(
        self,
        *,
        min_slot_points: int = HOUSE_FORECAST_DEFAULT_MIN_SLOT_POINTS,
        lower_percentile: float = HOUSE_FORECAST_LOWER_PERCENTILE,
        upper_percentile: float = HOUSE_FORECAST_UPPER_PERCENTILE,
    ) -> None:
        self._min_slot_points = min_slot_points
        self._lower_percentile = lower_percentile
        self._upper_percentile = upper_percentile
        self._values: list[list[float]] = [[] for _ in range(self.SLOTS)]

    @staticmethod
    def slot_index(weekday: int, hour: int) -> int:
        """Convert (weekday 0=Mon, hour 0-23) to slot index 0-167."""
        return weekday * 24 + hour

    def add(self, weekday: int, hour: int, value: float) -> None:
        idx = self.slot_index(weekday, hour)
        self._values[idx].append(value)

    def forecast(self, weekday: int, hour: int) -> ForecastBand:
        """Return the center and spread for the given slot."""
        idx = self.slot_index(weekday, hour)
        values = self._values[idx]

        if len(values) >= self._min_slot_points:
            return self._summarize(values)

        same_hour_values: list[float] = []
        for day in range(7):
            same_hour_values.extend(self._values[self.slot_index(day, hour)])

        if not same_hour_values:
            return ForecastBand(0.0, 0.0, 0.0)

        return self._summarize(same_hour_values)

    def _summarize(self, values: list[float]) -> ForecastBand:
        return summarize_winsorized_values(
            values,
            lower_percentile=self._lower_percentile,
            upper_percentile=self._upper_percentile,
        )
