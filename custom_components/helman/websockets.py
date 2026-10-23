"""Helman's websocket commands.

Casing: a stored document -- the config, a device's stored usage record -- passes through verbatim, in the snake_case it is stored in; a computed response is camelCase. Known exceptions still in snake_case: `helman/get_history`'s `entity_history` and the inspector's house consumers (`energy_entity_id`, `switch_entity_id`, `metered_children`).
"""

from __future__ import annotations
from datetime import date
import logging
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo
import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.websocket_api import async_register_command
from homeassistant.util import dt as dt_util
from .const import (
    CONFIG_DOCUMENT_VERSION,
    DOMAIN,
    EVENT_DATA_CHANGED,
)
from .automation.spec import OPTIMIZER_SPECS
from .controllables.spec import appliance_controllable_kinds
from .config_defaults import CONFIG_FIELD_DEFAULTS
from .config_validation import ValidationReport, validate_config_document
from .device_reports.reports import MAX_REPORT_DAYS, REPORTS, ReportQuery
from .span_buckets import BUCKETS
from .entity_inspection import inspect_targets
from .node_details import NodeDetailContext, NodeDetailError, async_get_node_detail
from .ws_common import get_coordinator, map_errors, validate_dates
from .solar_bias_correction.websocket import (
    ws_get_solar_bias_day_aggregates,
    ws_get_solar_bias_inspector,
)
from .scheduling.schedule import ScheduleError, slot_from_dict
from .training.websocket import ws_get_training_status, ws_train_now
from .storage import HelmanStorage, config_revision
from .vendors import describe_vendors, resolve_vendor_config

if TYPE_CHECKING:
    from homeassistant.core import Event

_LOGGER = logging.getLogger(__name__)

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
}


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


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    async_register_command(hass, ws_get_config)
    async_register_command(hass, ws_suggest_device_entities)
    async_register_command(hass, ws_preview_energy_import)
    async_register_command(hass, ws_validate_config)
    async_register_command(hass, ws_get_vendors)
    async_register_command(hass, ws_save_config)
    async_register_command(hass, ws_get_config_defaults)
    async_register_command(hass, ws_get_optimizer_schema)
    async_register_command(hass, ws_get_schedule)
    async_register_command(hass, ws_set_schedule)
    async_register_command(hass, ws_set_schedule_execution)
    async_register_command(hass, ws_get_automation_coverage)
    async_register_command(hass, ws_get_entity_actual_history)
    async_register_command(hass, ws_get_appliances)
    async_register_command(hass, ws_get_appliance_projections)
    async_register_command(hass, ws_get_device_tree)
    async_register_command(hass, ws_get_forecast)
    async_register_command(hass, ws_get_device_stats)
    async_register_command(hass, ws_get_device_report)
    async_register_command(hass, ws_get_node_detail)
    async_register_command(hass, ws_get_solar_bias_inspector)
    async_register_command(hass, ws_get_solar_bias_day_aggregates)
    async_register_command(hass, ws_get_training_status)
    async_register_command(hass, ws_train_now)
    async_register_command(hass, ws_get_history)
    async_register_command(hass, ws_get_schedule_explanation)
    async_register_command(hass, ws_get_condition_trace)
    async_register_command(hass, ws_inspect_entities)
    async_register_command(hass, ws_subscribe_updates)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/inspect_entities",
    vol.Required("config"): dict,
    vol.Optional("saved_config"): _validate_optional_config_document,
    vol.Required("targets"): [dict],
})
@websocket_api.require_admin
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

    # Read through the hardware profiles, so a slot a profile fills reads the
    # entity it resolves to rather than "not configured".
    saved = msg.get("saved_config")
    connection.send_result(
        msg["id"],
        {
            "results": inspect_targets(
                hass,
                resolve_vendor_config(hass, msg["config"])[0],
                msg["targets"],
                saved_config=(
                    None if saved is None else resolve_vendor_config(hass, saved)[0]
                ),
            )
        },
    )


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_schedule_explanation",
    vol.Required("controllable_id"): _validate_controllable_id,
    vol.Required("date"): str,
})
@websocket_api.require_admin
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
    if not validate_dates(connection, msg, msg.get("date")):
        return
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
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
@websocket_api.require_admin
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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
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
    vol.Optional("include_revision", default=False): bool,
})
@websocket_api.require_admin
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
    result = (
        {"config": stor.config, "revision": config_revision(stor.config)}
        if msg.get("include_revision", False)
        else stor.config
    )
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_config_defaults",
})
@websocket_api.require_admin
@callback
def ws_get_config_defaults(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Serve what an unset optional config field is worth at runtime.

    Same reason as the optimizer schema: the defaults are declared once, in
    `const.py`, and applied by the readers. A parallel table in TypeScript
    would drift, and a hint that disagrees with the backend is worse than no
    hint at all — so the editor asks for them instead of knowing them.
    """
    connection.send_result(msg["id"], dict(CONFIG_FIELD_DEFAULTS))


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_optimizer_schema",
})
@websocket_api.require_admin
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
    vol.Required("type"): "helman/suggest_device_entities",
    vol.Required("anchor_entity_ids"): [str],
    vol.Required("config"): dict,
})
@websocket_api.require_admin
@callback
def ws_suggest_device_entities(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    from .controllables.suggestions import suggest_entities

    connection.send_result(
        msg["id"], suggest_entities(hass, msg["anchor_entity_ids"], msg["config"])
    )


@websocket_api.websocket_command({
    vol.Required("type"): "helman/preview_energy_import",
    vol.Required("config"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_preview_energy_import(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    from homeassistant.components.energy import data as energy_data
    from .controllables.import_preview import preview_energy_import

    manager = await energy_data.async_get_manager(hass)
    connection.send_result(
        msg["id"], preview_energy_import(msg["config"], manager.data)
    )


@websocket_api.websocket_command({
    vol.Required("type"): "helman/validate_config",
    vol.Required("config"): dict,
})
@websocket_api.require_admin
@callback
def ws_validate_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    connection.send_result(
        msg["id"], _validate_with_vendors(hass, msg["config"]).to_dict()
    )


def _validate_with_vendors(hass: HomeAssistant, config: dict) -> ValidationReport:
    """Validate ``config`` as it will run: with its hardware profiles applied.

    The profiles fill the entity slots they own, so the completeness checks
    have to see the filled document; the resolver's own findings join the
    report beside them.
    """
    resolved, issues = resolve_vendor_config(hass, config)
    report = validate_config_document(resolved)
    for issue in issues:
        add = report.add_error if issue.error else report.add_warning
        add(
            section=issue.section,
            path=issue.path,
            code=issue.code,
            message=issue.message,
        )
    return report


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_vendors",
    vol.Required("config"): dict,
})
@websocket_api.require_admin
@callback
def ws_get_vendors(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """The hardware profiles, and what each one owns in the editor's draft."""
    connection.send_result(msg["id"], describe_vendors(hass, msg["config"]))


@websocket_api.websocket_command({
    vol.Required("type"): "helman/save_config",
    vol.Required("config"): dict,
    vol.Optional("expected_revision"): str,
})
@websocket_api.require_admin
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

    if "expected_revision" in msg and msg["expected_revision"] != config_revision(stor.config):
        connection.send_result(msg["id"], {
            "success": False,
            "conflict": True,
            "config": stor.config,
            "revision": config_revision(stor.config),
        })
        return

    # Stamp the version before validating, so a YAML round-trip through the
    # editor can never drop it — a document that lost `config_version` would
    # re-trigger the load migration on the next start, against a document
    # already in the new shape.
    config = {**msg["config"], "config_version": CONFIG_DOCUMENT_VERSION}

    validation = _validate_with_vendors(hass, config)
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
    stored = {"config": stor.config, "revision": config_revision(stor.config)}

    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        connection.send_result(msg["id"], {
            "success": False, "validation": validation.to_dict(),
            "reloadStarted": False, "reloadSucceeded": False,
            "reloadError": "Helman entry not available", **stored,
        })
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
            **stored,
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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    try:
        schedule = await coordinator.schedule.get()
    except ScheduleError as err:
        map_errors(connection, msg, err)
        return

    connection.send_result(msg["id"], schedule)


@websocket_api.websocket_command(SET_SCHEDULE_REQUEST_FIELDS)
@websocket_api.async_response
async def ws_set_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    try:
        schedule = await coordinator.set_schedule(
            slots=[slot_from_dict(slot) for slot in msg["slots"]],
            set_by="user",
        )
    except ScheduleError as err:
        map_errors(connection, msg, err)
        return

    connection.send_result(msg["id"], schedule)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_appliances",
})
@websocket_api.async_response
async def ws_get_appliances(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    try:
        schedule = await coordinator.set_schedule_execution(enabled=msg["enabled"])
    except ScheduleError as err:
        map_errors(connection, msg, err)
        return

    connection.send_result(msg["id"], schedule)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_automation_coverage",
})
@callback
def ws_get_automation_coverage(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Which automations drive each controllable, for the schedule badges.

    Not admin-gated, unlike the config it is read from: it names optimizer ids
    and whether they run, which every viewer of the schedule band may see.
    """
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    connection.send_result(msg["id"], coordinator.get_automation_coverage())


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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
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
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return
    connection.send_result(msg["id"], coordinator.live.get_history())


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_device_stats",
    vol.Required("device_key"): str,
})
@callback
def ws_get_device_stats(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """One device's learned usage record, or ``null`` when it has none.

    Not admin-gated: it carries only numbers, keyed by an id the card already
    has, the same exposure as ``helman/get_forecast``. The device detail is
    open to every user, and ``helman/training/status`` is not.
    """
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return
    connection.send_result(msg["id"], coordinator.get_device_stats(msg["device_key"]))


@websocket_api.websocket_command({
    vol.Required("type"): "helman/device_report",
    vol.Required("report"): vol.In(REPORTS),
    vol.Required("start_date"): str,
    vol.Required("end_date"): str,
    vol.Optional("granularity", default="day"): vol.In(BUCKETS),
})
@websocket_api.async_response
async def ws_get_device_report(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """One device report over a period of local dates, both inclusive.

    One command for every report: ``report`` names a registry entry. An
    ``end_date`` past today, in Home Assistant's time zone, is clamped to today
    rather than rejected, as the inspector's span read does. A period over
    :data:`~.device_reports.reports.MAX_REPORT_DAYS` days, or one that starts
    after it ends, is ``invalid_date``. ``granularity`` (``day``, ``week`` or
    ``month``) is read only by a report bucketed by it.

    Not admin-gated: it carries only numbers, the same exposure as
    ``helman/get_device_stats``.
    """
    raw_start = msg.get("start_date")
    raw_end = msg.get("end_date")
    if not validate_dates(connection, msg, raw_start, raw_end):
        return
    today = dt_util.now().astimezone(ZoneInfo(str(hass.config.time_zone))).date()
    start_date = date.fromisoformat(raw_start)
    end_date = min(date.fromisoformat(raw_end), today)
    if start_date > end_date:
        connection.send_error(
            msg["id"], "invalid_date", "start_date must not be after end_date or today"
        )
        return
    if (end_date - start_date).days + 1 > MAX_REPORT_DAYS:
        connection.send_error(
            msg["id"], "invalid_date", f"A report covers at most {MAX_REPORT_DAYS} days"
        )
        return

    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return
    try:
        payload = await coordinator.async_device_report(
            msg["report"],
            ReportQuery(
                start_date=start_date, end_date=end_date, granularity=msg["granularity"]
            ),
        )
    except Exception:
        _LOGGER.exception("Unexpected device report failure")
        connection.send_error(msg["id"], "internal_error", "Unexpected device report failure")
        return
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_node_detail",
    vol.Required("node"): str,
    vol.Optional("device_id"): str,
    vol.Optional("section"): str,
})
@websocket_api.async_response
async def ws_get_node_detail(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """One node detail's overview, or one of its history sections.

    The node registry (:mod:`.node_details`) validates the node, the device and
    the section; a refused request is a websocket error with its code. Not
    admin-gated: it carries entity ids and numbers the card already shows, the
    same exposure as ``helman/get_appliances``.
    """
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return
    try:
        payload = await async_get_node_detail(
            hass,
            NodeDetailContext(
                config=coordinator.config,
                telemetry=coordinator.live.vendor_telemetry,
                device_report=coordinator.async_device_report,
                house_profile=coordinator.training.served_house_profile,
            ),
            node=msg["node"],
            device_id=msg.get("device_id"),
            section=msg.get("section"),
            now=dt_util.now(),
        )
    except NodeDetailError as err:
        map_errors(connection, msg, err)
        return
    except Exception:
        _LOGGER.exception("Unexpected node detail failure")
        connection.send_error(msg["id"], "internal_error", "Unexpected node detail failure")
        return
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(GET_FORECAST_REQUEST_FIELDS)
@websocket_api.async_response
async def ws_get_forecast(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    coordinator = get_coordinator(hass, connection, msg)
    if coordinator is None:
        return

    forecast = await coordinator.get_forecast()
    connection.send_result(msg["id"], forecast)




@websocket_api.websocket_command({
    vol.Required("type"): "helman/subscribe_updates",
})
@callback
def ws_subscribe_updates(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """The feed a card listens on to learn that its data has been rewritten.

    The integration announces every rewrite as one coarse ``helman_data_changed``
    on the event bus, but a client cannot subscribe to that bus directly:
    ``subscribe_events`` refuses any event outside Home Assistant's fixed
    ``SUBSCRIBE_ALLOWLIST`` to a non-admin user, and a custom integration's event
    can never be in that set. A household member with a normal account would get
    an error in the log and cards that never refresh on their own.

    So the subscription is a command of our own instead, where the permission
    rule is ours to make, and there is no admin check here. What it discloses is
    one kind per rewrite: a non-admin learns that *something* moved, including a
    ``config`` whose contents ``helman/get_config`` would still refuse them. The
    payload is the event's data unchanged -- one ``kind`` and, for ``config``,
    a content hash; no config or plan is disclosed --
    and the client does its own batching.
    """

    @callback
    def _forward(event: Event) -> None:
        connection.send_message(
            websocket_api.event_message(msg["id"], dict(event.data))
        )

    connection.subscriptions[msg["id"]] = hass.bus.async_listen(
        EVENT_DATA_CHANGED, _forward
    )
    connection.send_result(msg["id"])
