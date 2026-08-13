"""Home Assistant Energy platform for Helman."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    MAX_FORECAST_DAYS,
)

#: The Energy dashboard's ``wh_hours`` map is keyed by the hour, so this module
#: is the one place left that rolls the canonical forecast grid up into
#: something coarser. Everything else in Helman speaks 15 minutes.
_CANONICAL_SLOTS_PER_HOUR = 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES


async def async_get_solar_forecast(
    hass: HomeAssistant,
    config_entry_id: str,
) -> dict[str, dict[str, float | int]] | None:
    """Get Helman's corrected solar forecast for the Energy dashboard."""
    config_entry = hass.config_entries.async_get_entry(config_entry_id)
    if config_entry is None or config_entry.domain != DOMAIN:
        return None

    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if coordinator is None:
        return None

    forecast = await coordinator.get_forecast(forecast_days=MAX_FORECAST_DAYS)
    solar_forecast = forecast.get("solar", {})
    points = solar_forecast.get("adjustedPoints")
    if not isinstance(points, list):
        points = solar_forecast.get("points")
    return {"wh_hours": dict(_to_hourly(points))}


def _to_hourly(points: Any) -> list[tuple[str, float]]:
    """Sum the canonical points into whole hours, keyed by the hour they fall in.

    Grouped by each point's own hour rather than by position, so a series that
    starts off the hour or has a gap cannot produce a bucket that straddles two
    hours while being labelled as one. An hour missing any of its slots is left
    out rather than reported short.

    Malformed points are skipped rather than raised on: the pipeline this
    replaces dropped them in ``_read_points`` before it ever aggregated, and a
    single bad point should not take the Energy dashboard down with it.
    """
    if not isinstance(points, list):
        return []

    by_hour: dict[str, list[float]] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str) or isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            continue
        hour_start = _floor_to_hour(timestamp)
        if hour_start is None:
            continue
        by_hour.setdefault(hour_start, []).append(float(value))

    return [
        (hour_start, round(sum(values), 4))
        for hour_start, values in by_hour.items()
        if len(values) == _CANONICAL_SLOTS_PER_HOUR
    ]


def _floor_to_hour(timestamp: str) -> str | None:
    """``timestamp`` floored to its own hour, in the form the dashboard keys on."""
    try:
        parsed = datetime.fromisoformat(timestamp)
    except ValueError:
        return None
    return parsed.replace(minute=0, second=0, microsecond=0).isoformat()
