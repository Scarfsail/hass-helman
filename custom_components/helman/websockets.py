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
from .config_validation import validate_config_document
from .forecast_request import (
    ForecastRequestNotSupportedError,
    ensure_supported_forecast_request,
)
from .solar_bias_correction.websocket import (
    ws_get_solar_bias_profile,
    ws_get_solar_bias_status,
    ws_train_solar_bias_now,
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
    async_register_command(hass, ws_validate_config)
    async_register_command(hass, ws_save_config)
    async_register_command(hass, ws_get_schedule)
    async_register_command(hass, ws_set_schedule)
    async_register_command(hass, ws_set_schedule_execution)
    async_register_command(hass, ws_get_appliances)
    async_register_command(hass, ws_get_appliance_projections)
    async_register_command(hass, ws_get_device_tree)
    async_register_command(hass, ws_get_forecast)
    async_register_command(hass, ws_get_solar_bias_status)
    async_register_command(hass, ws_train_solar_bias_now)
    async_register_command(hass, ws_get_solar_bias_profile)
    async_register_command(hass, ws_get_history)
    async_register_command(hass, ws_run_automation)
    async_register_command(hass, ws_get_last_automation_run)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_last_automation_run",
})
@callback
def ws_get_last_automation_run(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    if not _require_admin(connection, msg):
        return
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    result = coordinator.get_last_automation_run_result()
    connection.send_result(msg["id"], None if result is None else result.to_dict())


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_config",
})
@callback
def ws_get_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    if not _require_admin(connection, msg):
        return
    stor: HelmanStorage | None = hass.data.get(DOMAIN, {}).get("storage")
    if not stor:
        connection.send_error(msg["id"], "not_loaded", "Helman storage not available")
        return
    connection.send_result(msg["id"], stor.config)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/validate_config",
    vol.Required("config"): dict,
})
@callback
def ws_validate_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    if not _require_admin(connection, msg):
        return
    connection.send_result(msg["id"], validate_config_document(msg["config"]).to_dict())


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
    if not _require_admin(connection, msg):
        return
    domain_data = hass.data.get(DOMAIN, {})
    stor: HelmanStorage | None = domain_data.get("storage")
    if not stor:
        connection.send_error(msg["id"], "not_loaded", "Helman storage not available")
        return

    validation = validate_config_document(msg["config"])
    if not validation.valid:
        connection.send_result(
            msg["id"],
            {
                "success": False,
                "validation": validation.to_dict(),
                "reloadStarted": False,
            },
        )
        return

    await stor.async_save(msg["config"])

    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        connection.send_error(msg["id"], "not_loaded", "Helman entry not available")
        return

    reload_started = True
    reload_succeeded = False
    reload_error: str | None = None
    try:
        reload_succeeded = await hass.config_entries.async_reload(entries[0].entry_id)
    except Exception as err:
        reload_error = str(err)

    connection.send_result(
        msg["id"],
        {
            "success": reload_succeeded,
            "validation": validation.to_dict(),
            "reloadStarted": reload_started,
            "reloadSucceeded": reload_succeeded,
            "reloadError": reload_error,
        },
    )


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
            slots=[slot_from_dict(slot) for slot in msg["slots"]],
            set_by="user",
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


@websocket_api.websocket_command({
    vol.Required("type"): "helman/run_automation",
})
@websocket_api.async_response
async def ws_run_automation(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    if not _require_admin(connection, msg):
        return

    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    result = await coordinator.run_automation(reason="websocket")
    connection.send_result(msg["id"], result.to_dict())


def _require_admin(
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> bool:
    user = getattr(connection, "user", None)
    if user is None or not getattr(user, "is_admin", False):
        connection.send_error(msg["id"], "unauthorized", "Admin access required")
        return False
    return True
