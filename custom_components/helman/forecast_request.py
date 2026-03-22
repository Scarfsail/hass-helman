from __future__ import annotations

from .const import (
    DEFAULT_FORECAST_DAYS,
    DEFAULT_FORECAST_GRANULARITY_MINUTES,
)


class ForecastRequestNotSupportedError(ValueError):
    """Raised when a validated forecast request cannot be served yet."""


def ensure_supported_forecast_request(
    *,
    granularity: int,
    forecast_days: int,
) -> None:
    if (
        granularity == DEFAULT_FORECAST_GRANULARITY_MINUTES
        and forecast_days == DEFAULT_FORECAST_DAYS
    ):
        return
    raise ForecastRequestNotSupportedError(
        "Only granularity=60 and forecast_days=7 are supported until later "
        "15-minute forecast increments land"
    )
