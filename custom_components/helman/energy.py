"""Home Assistant Energy platform for Helman."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from .const import DOMAIN, MAX_FORECAST_DAYS


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

    forecast = await coordinator.get_forecast(
        granularity=60,
        forecast_days=MAX_FORECAST_DAYS,
    )
    return {"wh_hours": _build_wh_hours(forecast.get("solar", {}).get("points"))}


def _build_wh_hours(points: Any) -> dict[str, float | int]:
    if not isinstance(points, list):
        return {}

    wh_hours: dict[str, float | int] = {}
    for point in points:
        if not isinstance(point, dict):
            continue

        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str) or isinstance(value, bool) or not isinstance(
            value, (int, float)
        ):
            continue

        wh_hours[timestamp] = value
    return wh_hours
