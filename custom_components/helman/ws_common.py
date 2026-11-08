"""Shared websocket runtime lookup, coded errors and ISO calendar dates."""

from __future__ import annotations

from datetime import date, timedelta
import re
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

if TYPE_CHECKING:
    from .coordinator import HelmanCoordinator

from .const import DOMAIN
from .device_reports.reports import MAX_REPORT_DAYS


def loaded_coordinator(hass: HomeAssistant) -> HelmanCoordinator | None:
    """The config entry's coordinator, its ``runtime_data``; None while not loaded."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        coordinator = getattr(entry, "runtime_data", None)
        if coordinator is not None:
            return coordinator
    return None


def get_coordinator(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> HelmanCoordinator | None:
    coordinator = loaded_coordinator(hass)
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


def validate_report_dates(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
    *,
    optional: bool = False,
) -> tuple[date, date] | None:
    """Validate report / node-history start and end dates.

    End clamped to today, start after end or more than MAX_REPORT_DAYS is
    invalid_date. When optional, both or neither must be provided; neither
    defaults to today - 29 .. today.
    """
    raw_start = msg.get("start_date")
    raw_end = msg.get("end_date")
    today = dt_util.now().astimezone(ZoneInfo(str(hass.config.time_zone))).date()
    if optional and raw_start is None and raw_end is None:
        return today - timedelta(days=29), today
    if (raw_start is None) != (raw_end is None):
        connection.send_error(
            msg["id"], "invalid_date", "start_date and end_date must be provided together"
        )
        return None
    if not validate_dates(connection, msg, raw_start, raw_end):
        return None
    start_date = date.fromisoformat(raw_start)
    end_date = min(date.fromisoformat(raw_end), today)
    if start_date > end_date:
        connection.send_error(
            msg["id"], "invalid_date", "start_date must not be after end_date or today"
        )
        return None
    if (end_date - start_date).days + 1 > MAX_REPORT_DAYS:
        connection.send_error(
            msg["id"], "invalid_date", f"A report covers at most {MAX_REPORT_DAYS} days"
        )
        return None
    return start_date, end_date
