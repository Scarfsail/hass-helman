"""Home Assistant Energy platform for Helman."""

from __future__ import annotations

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
    """Sum the canonical points into whole hours, dropping a partial tail.

    A trailing group short of a full hour would report an hour's production
    from part of one, so it is left out rather than understated. Malformed
    points are skipped rather than raised on, which is what the aggregation
    this replaced did when it read its input.
    """
    if not isinstance(points, list):
        return []
    usable = [
        (timestamp, float(value))
        for point in points
        if isinstance(point, dict)
        and isinstance(timestamp := point.get("timestamp"), str)
        and not isinstance(value := point.get("value"), bool)
        and isinstance(value, (int, float))
    ]
    complete_length = len(usable) - (len(usable) % _CANONICAL_SLOTS_PER_HOUR)
    return [
        (
            usable[start][0],
            round(
                sum(
                    value
                    for _, value in usable[start : start + _CANONICAL_SLOTS_PER_HOUR]
                ),
                4,
            ),
        )
        for start in range(0, complete_length, _CANONICAL_SLOTS_PER_HOUR)
    ]
