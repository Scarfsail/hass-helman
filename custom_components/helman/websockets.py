from __future__ import annotations
from datetime import date
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.websocket_api import async_register_command
from .const import (
    CONFIG_DOCUMENT_VERSION,
    DATA_CHANGED_KIND_CONFIG,
    DEFAULT_FORECAST_DAYS,
    DOMAIN,
    EVENT_DATA_CHANGED,
    MAX_FORECAST_DAYS,
    SCHEDULE_ACTION_KINDS,
)
from .automation.spec import OPTIMIZER_SPECS
from .controllables.spec import appliance_controllable_kinds
from .config_validation import validate_config_document
from .entity_inspection import inspect_targets
from .solar_bias_correction.websocket import (
    ws_get_solar_bias_day_aggregates,
    ws_get_solar_bias_inspector,
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
    vol.Optional("forecast_days", default=DEFAULT_FORECAST_DAYS): (
        lambda value: _validate_forecast_days(value)
    ),
}
GET_FORECAST_REQUEST_SCHEMA = vol.Schema(
    GET_FORECAST_REQUEST_FIELDS,
    extra=vol.PREVENT_EXTRA,
)


def _validate_schedule_date(value: object) -> str:
    """A calendar date as ``YYYY-MM-DD`` — the explanation book's bucket key."""
    if not isinstance(value, str):
        raise vol.Invalid("date must be a string")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as err:
        raise vol.Invalid("date must be an ISO calendar date (YYYY-MM-DD)") from err


def _validate_controllable_id(value: object) -> str:
    """A schedule lane: the controllable's own id, ``inverter`` included."""
    if not isinstance(value, str) or not value:
        raise vol.Invalid("controllable_id must be a non-empty string")
    return value


def _validate_optimizer_id(value: object) -> str:
    """An optimizer instance id, as authored in the automation config."""
    if not isinstance(value, str) or not value:
        raise vol.Invalid("optimizer_id must be a non-empty string")
    return value


def _validate_group_index(value: object) -> int:
    """A condition group's position within its optimizer's ``conditions``."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise vol.Invalid("group_index must be a non-negative integer")
    return value


def _validate_optional_config_document(value: object) -> dict | None:
    """A config document, or ``None`` meaning "there is no saved one yet".

    Spelled out rather than written as ``vol.Any(dict, None)`` so the schema
    stays readable to the hand-rolled voluptuous stub some test modules install
    in place of the real package.
    """
    if value is None or isinstance(value, dict):
        return value
    raise vol.Invalid("saved_config must be a config document or null")


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
    async_register_command(hass, ws_get_optimizer_schema)
    async_register_command(hass, ws_get_schedule)
    async_register_command(hass, ws_set_schedule)
    async_register_command(hass, ws_set_schedule_execution)
    async_register_command(hass, ws_get_controllable_entities)
    async_register_command(hass, ws_get_entity_actual_history)
    async_register_command(hass, ws_get_appliances)
    async_register_command(hass, ws_get_appliance_projections)
    async_register_command(hass, ws_get_device_tree)
    async_register_command(hass, ws_get_forecast)
    async_register_command(hass, ws_get_solar_bias_status)
    async_register_command(hass, ws_train_solar_bias_now)
    async_register_command(hass, ws_get_solar_bias_profile)
    async_register_command(hass, ws_get_solar_bias_inspector)
    async_register_command(hass, ws_get_solar_bias_day_aggregates)
    async_register_command(hass, ws_get_history)
    async_register_command(hass, ws_run_automation)
    async_register_command(hass, ws_get_schedule_explanation)
    async_register_command(hass, ws_get_condition_trace)
    async_register_command(hass, ws_inspect_entities)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/inspect_entities",
    vol.Required("config"): dict,
    vol.Optional("saved_config"): _validate_optional_config_document,
    vol.Required("targets"): [dict],
})
@callback
def ws_inspect_entities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """What the entities picked in an editor draft currently read.

    The request names **paths, not entities**: it carries the draft config
    document and a list of config paths into it, and the backend resolves the
    entity id and every setting that qualifies it from that document. That is
    deliberate — "which settings matter for this path" is knowledge that has to
    stay in :mod:`.entity_inspection` rather than being split across the
    websocket boundary into the editor's TypeScript. See that package's
    docstring for the whole argument.

    The answer is a list of localizable facts per target, which the editor
    renders in order and does not interpret. ``saved`` is non-``null`` only
    when the stored document would read differently, which is a question only
    the evaluator can answer — so both documents are sent and the comparison
    happens here.

    Polled roughly every two seconds while the editor is open, so it never
    raises on a target it dislikes: an unknown entity, a non-numeric state or a
    path with no evaluator is a ``status`` on that row, not an error on the
    call.
    """
    if not _require_admin(connection, msg):
        return

    connection.send_result(
        msg["id"],
        {
            "results": inspect_targets(
                hass,
                msg["config"],
                msg["targets"],
                saved_config=msg.get("saved_config"),
            )
        },
    )


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_schedule_explanation",
    vol.Required("controllable_id"): _validate_controllable_id,
    vol.Required("date"): _validate_schedule_date,
})
@callback
def ws_get_schedule_explanation(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Why every slot of one schedule lane looks the way it does, on one date.

    Keyed by the lane the user clicked — the controllable's own id — not by
    optimizer: the inverter lane is written by three optimizer kinds, so one
    lane click has no single optimizer to ask. The result carries every
    optimizer that touched the target, in pipeline order.

    ``None`` when nothing is recorded for that lane and date — before the first
    run, for a lane no optimizer targets, or for a date outside what the
    accumulated record still covers.
    """
    if not _require_admin(connection, msg):
        return
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    connection.send_result(
        msg["id"],
        coordinator.get_schedule_explanation(
            controllable_id=msg["controllable_id"],
            date=msg["date"],
        ),
    )


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_condition_trace",
    vol.Required("optimizer_id"): _validate_optimizer_id,
    vol.Required("group_index"): _validate_group_index,
})
@callback
def ws_get_condition_trace(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """The last evaluation of one condition group's ``custom`` conditions.

    Home Assistant's own condition trace, over the group's ``custom`` list and
    carrying the config it ran, so the caller can draw it with HA's trace
    components instead of a second way to render a condition tree.

    Only the newest evaluation is kept while the explanation record accumulates
    across runs, so the payload's ``runAt`` can be later than the plan row the
    reader clicked — which is why it travels with the trace.

    ``None`` before the first run, for a group with no ``custom`` conditions,
    and for a group that no longer exists.
    """
    if not _require_admin(connection, msg):
        return
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    connection.send_result(
        msg["id"],
        coordinator.get_condition_trace(
            optimizer_id=msg["optimizer_id"],
            group_index=msg["group_index"],
        ),
    )


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
    vol.Required("type"): "helman/get_optimizer_schema",
})
@callback
def ws_get_optimizer_schema(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Serve the optimizer config schema the visual editor renders from.

    The schema is defined once, in Python, and read by both the config reader
    and the editor. Hand-maintaining a parallel TypeScript schema guarantees
    drift between what the editor lets you build and what the reader accepts —
    which is exactly how the editor came to render a `hold_action` field no
    Python code has ever read.
    """
    if not _require_admin(connection, msg):
        return
    connection.send_result(
        msg["id"],
        {
            "version": CONFIG_DOCUMENT_VERSION,
            "kinds": [spec.to_dict() for spec in OPTIMIZER_SPECS.values()],
            # Document-level rather than per-kind: this is "which controllables
            # are appliances", which the `requires_appliance` picker filters by
            # and `_validate_requires_appliance` enforces. Served from the one
            # declaration so the picker cannot offer what validation rejects.
            "applianceKinds": sorted(appliance_controllable_kinds()),
        },
    )


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

    # Stamp the version before validating, so a YAML round-trip through the
    # editor can never drop it — a document that lost `config_version` would
    # re-trigger the load migration on the next start, against a document
    # already in the new shape.
    config = {**msg["config"], "config_version": CONFIG_DOCUMENT_VERSION}

    validation = validate_config_document(config)
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

    await stor.async_save(config)

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

    if reload_succeeded:
        # After the reload, never before: a subscriber that reloads on this
        # event has to read the config the entry is now actually running on.
        hass.bus.async_fire(EVENT_DATA_CHANGED, {"kind": DATA_CHANGED_KIND_CONFIG})

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
    vol.Required("type"): "helman/get_controllable_entities",
})
@callback
def ws_get_controllable_entities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """List what Helman can drive, plus each entity's resting state."""
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    connection.send_result(
        msg["id"], {"entities": coordinator.get_controllable_entities()}
    )


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_entity_actual_history",
})
@websocket_api.async_response
async def ws_get_entity_actual_history(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Report what each controllable entity actually did earlier today.

    The schedule keeps no record of elapsed slots, so the card cannot draw the
    morning from it. This reads the recorder instead, which also answers the
    better question: not what was planned, but what really ran.
    """
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return

    connection.send_result(
        msg["id"], {"entities": await coordinator.async_get_entity_actual_history()}
    )


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

    forecast = await coordinator.get_forecast(forecast_days=msg["forecast_days"])
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
