from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ..ws_common import get_coordinator, validate_dates

_LOGGER = logging.getLogger(__name__)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/solar_bias/inspector",
        vol.Required("date"): str,
    }
)
@websocket_api.async_response
async def ws_get_solar_bias_inspector(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    raw_date = msg.get("date")
    if not validate_dates(connection, msg, raw_date):
        return

    service = _get_solar_inspector(hass, connection, msg)
    if service is None:
        return

    try:
        payload = await service.async_get_inspector_day(raw_date)
    except Exception:
        _LOGGER.exception("Unexpected solar bias inspector failure")
        connection.send_error(
            msg["id"],
            "internal_error",
            "Unexpected solar bias inspector failure",
        )
        return

    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/solar_bias/day_aggregates",
        vol.Required("start_date"): str,
        vol.Required("end_date"): str,
        vol.Optional("bucket", default="day"): vol.In(("day", "month")),
        vol.Optional("house_breakdown", default=False): bool,
        vol.Optional("house_forecast", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_get_solar_bias_day_aggregates(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Measured figures for a span, bucketed into local days or months.

    ``bucket`` defaults to ``"day"`` -- the shape the inspector's day pills have
    always asked for, and the reason this command keeps its name. ``"month"``
    snaps the requested dates outward to whole local months and returns one row
    per month; the dates themselves stay plain ISO dates either way.

    ``house_breakdown`` asks for each bucket's consumer roster as well, which
    widens the one statistics read by a meter per configured consumer. Off by
    default because the two callers want different things from the same
    endpoint: the aggregate views draw the composition, the day pills read six
    scalars a day and would pay for a field they never look at.

    ``house_forecast`` asks for each bucket's predicted house energy
    (``houseForecastWh``), read from the house forecast sensor's hourly means in
    the same statistics read. Off by default for the same reason: only the
    house-focused inspector's pills look at it.
    """
    raw_start = msg.get("start_date")
    raw_end = msg.get("end_date")
    if not validate_dates(connection, msg, raw_start, raw_end):
        return

    service = _get_solar_inspector(hass, connection, msg)
    if service is None:
        return

    try:
        payload = await service.async_get_span_aggregates(
            raw_start,
            raw_end,
            msg.get("bucket", "day"),
            house_breakdown=bool(msg.get("house_breakdown", False)),
            house_forecast=bool(msg.get("house_forecast", False)),
        )
    except Exception:
        _LOGGER.exception("Unexpected solar bias day aggregates failure")
        connection.send_error(
            msg["id"],
            "internal_error",
            "Unexpected solar bias day aggregates failure",
        )
        return

    connection.send_result(msg["id"], payload)


def _get_solar_inspector(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
):
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return None

    inspector = getattr(coordinator, "solar_inspector", None)
    if inspector is None:
        connection.send_error(
            msg["id"],
            "not_loaded",
            "Helman solar bias correction service not available",
        )
        return None

    return inspector


_get_solar_bias_service = _get_solar_inspector
