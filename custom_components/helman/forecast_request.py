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
    return
