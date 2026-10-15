"""Shared websocket runtime lookup, coded errors and ISO calendar dates."""

from __future__ import annotations

from datetime import date
import re
from typing import TYPE_CHECKING, Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

if TYPE_CHECKING:
    from .coordinator import HelmanCoordinator

from .const import DOMAIN


def get_coordinator(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> HelmanCoordinator | None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if coordinator is None:
        connection.send_error(
            msg["id"], "not_loaded", "Helman coordinator not available"
        )
    return coordinator


def map_errors(
    connection: websocket_api.ActiveConnection, msg: dict, error: Any
) -> None:
    """Send an exception whose public ``code`` defines its websocket error."""
    connection.send_error(msg["id"], error.code, str(error))


def validate_dates(
    connection: websocket_api.ActiveConnection, msg: dict, *values: object
) -> bool:
    """Accept only dashed ISO calendar dates, including valid month/day bounds."""
    try:
        for value in values:
            if (
                not isinstance(value, str)
                or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None
            ):
                raise ValueError
            date.fromisoformat(value)
    except ValueError:
        subject = "Date" if len(values) == 1 else "Dates"
        connection.send_error(
            msg["id"], "invalid_date", f"{subject} must use YYYY-MM-DD format"
        )
        return False
    return True
