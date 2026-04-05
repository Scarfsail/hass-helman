from __future__ import annotations
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.websocket_api import async_register_command
from .const import (
    DEFAULT_FORECAST_DAYS,
    DEFAULT_FORECAST_GRANULARITY_MINUTES,
    DOMAIN,
    FORECAST_GRANULARITY_OPTIONS,
    MAX_FORECAST_DAYS,
    SCHEDULE_ACTION_KINDS,
)
from .forecast_request import (
    ForecastRequestNotSupportedError,
    ensure_supported_forecast_request,
)
from .scheduling.schedule import ScheduleError, slot_from_dict
from .storage import HelmanStorage

ACTION_KIND_SCHEMA = vol.In(SCHEDULE_ACTION_KINDS)
SCHEDULE_ACTION_SCHEMA = vol.Schema(
    {
        vol.Required("kind"): ACTION_KIND_SCHEMA,
        vol.Optional("targetSoc"): vol.Coerce(int),
    },
    extra=vol.PREVENT_EXTRA,
)
SET_SCHEDULE_REQUEST_FIELDS = {
    vol.Required("type"): "helman/set_schedule",
    vol.Required("slots"): [dict],
}
SET_SCHEDULE_REQUEST_SCHEMA = vol.Schema(
    SET_SCHEDULE_REQUEST_FIELDS,
    extra=vol.PREVENT_EXTRA,
)
GET_FORECAST_REQUEST_FIELDS = {
    vol.Required("type"): "helman/get_forecast",
    vol.Optional("granularity", default=DEFAULT_FORECAST_GRANULARITY_MINUTES): (
        lambda value: _validate_forecast_granularity(value)
    ),
    vol.Optional("forecast_days", default=DEFAULT_FORECAST_DAYS): (
        lambda value: _validate_forecast_days(value)
    ),
}
GET_FORECAST_REQUEST_SCHEMA = vol.Schema(
    GET_FORECAST_REQUEST_FIELDS,
    extra=vol.PREVENT_EXTRA,
)


def _validate_forecast_granularity(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise vol.Invalid("granularity must be an integer")
    if value not in FORECAST_GRANULARITY_OPTIONS:
        raise vol.Invalid(
            "granularity must be one of "
            + ", ".join(str(option) for option in FORECAST_GRANULARITY_OPTIONS)
        )
    return value


def _validate_forecast_days(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise vol.Invalid("forecast_days must be an integer")
    if value < 1 or value > MAX_FORECAST_DAYS:
        raise vol.Invalid(
            f"forecast_days must be between 1 and {MAX_FORECAST_DAYS}"
        )
    return value


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    async_register_command(hass, ws_get_config)
    async_register_command(hass, ws_save_config)
    async_register_command(hass, ws_get_schedule)
    async_register_command(hass, ws_set_schedule)
    async_register_command(hass, ws_set_schedule_execution)
    async_register_command(hass, ws_get_appliances)
    async_register_command(hass, ws_get_appliance_projections)
    async_register_command(hass, ws_get_device_tree)
    async_register_command(hass, ws_get_forecast)
    async_register_command(hass, ws_get_history)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_config",
})
@callback
def ws_get_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    stor: HelmanStorage | None = hass.data.get(DOMAIN, {}).get("storage")
    if not stor:
        connection.send_error(msg["id"], "not_loaded", "Helman storage not available")
        return
    connection.send_result(msg["id"], stor.config)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/save_config",
    vol.Required("config"): dict,
})
@websocket_api.async_response
async def ws_save_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    domain_data = hass.data.get(DOMAIN, {})
    stor: HelmanStorage | None = domain_data.get("storage")
    if not stor:
        connection.send_error(msg["id"], "not_loaded", "Helman storage not available")
        return

    await stor.async_save(msg["config"])

    entry = hass.config_entries.async_entries(DOMAIN)[0]
    connection.send_result(msg["id"], {"success": True})
    await hass.config_entries.async_reload(entry.entry_id)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_schedule",
})
@websocket_api.async_response
async def ws_get_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    try:
        schedule = await coordinator.get_schedule()
    except ScheduleError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return

    connection.send_result(msg["id"], schedule)


@websocket_api.websocket_command(SET_SCHEDULE_REQUEST_FIELDS)
@websocket_api.async_response
async def ws_set_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    try:
        await coordinator.set_schedule(
            slots=[slot_from_dict(slot) for slot in msg["slots"]]
        )
    except ScheduleError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return

    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_appliances",
})
@websocket_api.async_response
async def ws_get_appliances(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    connection.send_result(msg["id"], await coordinator.get_appliances())


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_appliance_projections",
})
@websocket_api.async_response
async def ws_get_appliance_projections(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    connection.send_result(msg["id"], await coordinator.get_appliance_projections())


@websocket_api.websocket_command({
    vol.Required("type"): "helman/set_schedule_execution",
    vol.Required("enabled"): bool,
})
@websocket_api.async_response
async def ws_set_schedule_execution(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    try:
        enabled = await coordinator.set_schedule_execution(enabled=msg["enabled"])
    except ScheduleError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return

    connection.send_result(msg["id"], {"success": True, "executionEnabled": enabled})


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_device_tree",
})
@websocket_api.async_response
async def ws_get_device_tree(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    tree = await coordinator.get_device_tree()
    connection.send_result(msg["id"], tree)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_history",
})
@callback
def ws_get_history(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    connection.send_result(msg["id"], coordinator.get_history())


@websocket_api.websocket_command(GET_FORECAST_REQUEST_FIELDS)
@websocket_api.async_response
async def ws_get_forecast(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    try:
        ensure_supported_forecast_request(
            granularity=msg["granularity"],
            forecast_days=msg["forecast_days"],
        )
        forecast = await coordinator.get_forecast(
            granularity=msg["granularity"],
            forecast_days=msg["forecast_days"],
        )
    except ForecastRequestNotSupportedError as err:
        connection.send_error(msg["id"], "not_supported", str(err))
        return
    connection.send_result(msg["id"], forecast)
