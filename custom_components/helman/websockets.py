from __future__ import annotations
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.websocket_api import async_register_command
from .const import DOMAIN
from .storage import HelmanStorage


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    async_register_command(hass, ws_get_config)
    async_register_command(hass, ws_save_config)
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
    stor: HelmanStorage = hass.data[DOMAIN]["storage"]
    await stor.async_save(msg["config"])
    coordinator = hass.data[DOMAIN].get("coordinator")
    if coordinator:
        coordinator.invalidate_tree()
        coordinator.invalidate_forecast()
    connection.send_result(msg["id"], {"success": True})


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
