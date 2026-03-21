from __future__ import annotations
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.websocket_api import async_register_command
from .const import DOMAIN, SCHEDULE_ACTION_KINDS
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
SCHEDULE_SLOT_SCHEMA = vol.Schema(
    {
        vol.Required("id"): str,
        vol.Required("action"): SCHEDULE_ACTION_SCHEMA,
    },
    extra=vol.PREVENT_EXTRA,
)


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    async_register_command(hass, ws_get_config)
    async_register_command(hass, ws_save_config)
    async_register_command(hass, ws_get_schedule)
    async_register_command(hass, ws_set_schedule)
    async_register_command(hass, ws_set_schedule_execution)
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
    coordinator = domain_data.get("coordinator")
    if coordinator:
        await coordinator.async_handle_config_saved()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_schedule",
})
@websocket_api.async_response
async def ws_get_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data[DOMAIN].get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    try:
        schedule = await coordinator.get_schedule()
    except ScheduleError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return

    connection.send_result(msg["id"], schedule)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/set_schedule",
    vol.Required("slots"): [SCHEDULE_SLOT_SCHEMA],
})
@websocket_api.async_response
async def ws_set_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data[DOMAIN].get("coordinator")
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
    vol.Required("type"): "helman/set_schedule_execution",
    vol.Required("enabled"): bool,
})
@websocket_api.async_response
async def ws_set_schedule_execution(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data[DOMAIN].get("coordinator")
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
    coordinator = hass.data[DOMAIN].get("coordinator")
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
    coordinator = hass.data[DOMAIN].get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    connection.send_result(msg["id"], coordinator.get_history())


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_forecast",
})
@websocket_api.async_response
async def ws_get_forecast(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = hass.data[DOMAIN].get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    forecast = await coordinator.get_forecast()
    connection.send_result(msg["id"], forecast)
