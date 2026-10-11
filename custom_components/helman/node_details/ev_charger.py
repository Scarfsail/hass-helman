"""The EV charger detail: how the charge goes, when it is planned, why it waits.

One detail per charger, named by its consumer id. The overview carries the
entity ids the card reads live: the device's own config (its power and energy
meters, Helman's charge switch, the use mode and eco gear selects, which a
hardware profile fills) and the profile's telemetry. A charger without a
profile (Custom) has only its config, and its answers stay config-backed.

One fact only the backend can tell is added: the charger's ``status``, as the
profile names the run mode the hardware reports. The session's own energy and
duration are the hardware's counters, read live; nothing here keeps a session
record (#428).

The vehicles, the plan and the projected completion come from the existing
appliance, schedule and appliance-projection clients, so they are not repeated.

Two sections, each read when its question opens:

- ``today``: this charger's node of today's ranking device report, its sources
  and attributed money over the local day so far. It is today's figure, never
  the session's.
- ``segment``: ``chargingSince``, the recorded transition into the charging run
  mode. That starts a charging *segment*: a pause and a restart start a new one
  within the same plugged-in session, so it is never the session's start. The
  run mode's ``last_changed`` cannot stand in for it, since an HA restart or an
  ``unavailable`` blip moves it too.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..controllables.config import own_meter, peek_controllable_id
from ..vendors import resolve_vendor_telemetry
from .battery import today_ranking_report
from .day_stats import day_window
from .house import ranking_money
from .inverter import run_mode_condition

#: How far back the charging segment's start is looked for.
SEGMENT_LOOKBACK = timedelta(hours=24)
#: A run mode gap (``unavailable``, ``unknown``) up to this long, an HA restart
#: or a Modbus blip, does not end a segment; a longer one leaves its start unknown.
SEGMENT_MAX_GAP = timedelta(minutes=10)
_GAP_STATES = frozenset({"unavailable", "unknown"})

#: The device's own config the answers read, by payload key: a dotted path
#: into the device. With a profile, the profile fills these.
_CONFIG_ENTITIES = {
    "power": "consumption.power_entity_id",
    "energy_total": "consumption.energy_entity_id",
    "charge_switch": "controls.charge.entity_id",
    "use_mode": "controls.use_mode.entity_id",
    "eco_gear": "controls.eco_gear.entity_id",
}


def build_ev_charger_overview(
    hass: Any, config: Mapping[str, Any], now: datetime, device: Mapping[str, Any]
) -> dict[str, Any]:
    """The charger's mappings and overview facts; no recorder read.

    ``profile`` is ``None`` for a Custom charger: ``entities`` then carries
    its config keys only, and ``status`` is ``None``. A telemetry key the
    profile has but the registry does not (disabled, missing) is present as
    ``None``.
    """
    device_id = peek_controllable_id(device)
    telemetry = resolve_vendor_telemetry(hass, config).get(device_id)

    entities: dict[str, str | None] = {
        key: _device_entity(device, path) for key, path in _CONFIG_ENTITIES.items()
    }
    if telemetry is not None:
        entities.update(telemetry.entities)

    return {
        "node": "ev_charger",
        "deviceId": device_id,
        "asOf": dt_util.as_local(now).isoformat(),
        "profile": (
            None
            if telemetry is None
            else {"id": telemetry.profile.id, "label": telemetry.profile.label}
        ),
        "entities": entities,
        "status": run_mode_condition(hass, telemetry),
        "sections": ["today", "segment"],
    }


async def async_ev_charger_section(
    hass: Any,
    config: Mapping[str, Any],
    section: str,
    now: datetime,
    device: Mapping[str, Any],
) -> dict[str, Any]:
    """The charging segment's start, or today's sources and attributed money.

    ``today`` is from the ranking report, over whole local dates: today so
    far, not the charging session. ``charger`` is ``None`` with an
    ``unavailable`` reason when the report cannot be built or has no node for
    this charger.
    """
    if section == "segment":
        return await _async_segment_section(hass, config, now, device)
    local_now = dt_util.as_local(now)
    start, end = day_window(local_now)
    payload: dict[str, Any] = {
        "node": "ev_charger",
        "section": section,
        "deviceId": peek_controllable_id(device),
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
        "currency": None,
        "complete": False,
        "unavailable": None,
        "charger": None,
    }
    report = await today_ranking_report(hass, local_now)
    if "unavailable" in report:
        return {**payload, "unavailable": report["unavailable"]}
    # The device tree, and so the report, names a metered device by its meter
    # and a meterless one by its id.
    node_id = own_meter(device) or payload["deviceId"]
    node = next(
        (node for node in report.get("nodes") or [] if node.get("id") == node_id), None
    )
    base = {
        **payload,
        # The report's dataset can be a few minutes older than the request.
        **({"asOf": report["as_of"]} if report.get("as_of") else {}),
        "currency": report.get("currency"),
        "complete": bool(report.get("complete")),
    }
    if node is None:
        return {**base, "unavailable": "no_charger_node"}
    return {
        **base,
        "charger": {
            "kwh": max(0.0, float(node.get("kwh") or 0.0)),
            "coverage": node.get("coverage", 0.0),
            "estimated": bool(node.get("estimated")),
            "sources": node.get("sources") or {},
            "money": ranking_money(node),
        },
    }


async def _async_segment_section(
    hass: Any, config: Mapping[str, Any], now: datetime, device: Mapping[str, Any]
) -> dict[str, Any]:
    """When the charging run mode began, as recorded; ``None`` when not charging or unknown."""
    device_id = peek_controllable_id(device)
    telemetry = resolve_vendor_telemetry(hass, config).get(device_id)
    status = run_mode_condition(hass, telemetry)
    since = None
    if status is not None and status["kind"] == "charging":
        start = now - SEGMENT_LOOKBACK
        states = list(await async_run_mode_history(hass, status["entityId"], start, now))
        live = hass.states.get(status["entityId"])
        # The recorder commits in batches: the live state may not be in it yet.
        if live is not None and (not states or live.last_changed > states[-1].last_changed):
            states.append(live)
        since = charging_segment_start(states, telemetry.profile.run_mode_conditions, now)
    return {
        "node": "ev_charger",
        "section": "segment",
        "deviceId": device_id,
        "asOf": dt_util.as_local(now).isoformat(),
        "chargingSince": None if since is None else dt_util.as_local(since).isoformat(),
    }


def charging_segment_start(
    states: Sequence[Any], conditions: Mapping[str, str], now: datetime
) -> datetime | None:
    """The start of the charging run the newest state is part of.

    Walks back over charging states and short gaps to the last state that is
    something else. ``None`` when the newest state is not charging, a gap
    longer than :data:`SEGMENT_MAX_GAP` breaks the record, or no other state
    is recorded (the run began before the history read).
    """
    ordered = sorted(states, key=lambda state: state.last_changed)
    since = None
    held_until = now
    for state in reversed(ordered):
        if state.state in _GAP_STATES:
            if held_until - state.last_changed > SEGMENT_MAX_GAP:
                return None
        elif conditions.get(state.state) == "charging":
            since = state.last_changed
        else:
            return since
        held_until = state.last_changed
    return None


async def async_run_mode_history(
    hass: Any, entity_id: str, start: datetime, end: datetime
) -> Sequence[Any]:
    """The run mode's recorded states over ``[start, end]``, the one before ``start`` included."""
    from homeassistant.components.recorder import get_instance

    def _read() -> list[Any]:
        from homeassistant.components.recorder.history import get_significant_states

        history = get_significant_states(
            hass,
            dt_util.as_utc(start),
            dt_util.as_utc(end),
            entity_ids=[entity_id],
            filters=None,
            include_start_time_state=True,
            significant_changes_only=False,
            minimal_response=False,
            no_attributes=True,
            compressed_state_format=False,
        )
        return list((history or {}).get(entity_id) or [])

    return await get_instance(hass).async_add_executor_job(_read)


def _device_entity(device: Mapping[str, Any], path: str) -> str | None:
    """The entity id at ``path`` in the device, ``None`` when unset."""
    value: Any = device
    for part in path.split("."):
        value = value.get(part) if isinstance(value, Mapping) else None
    return value if isinstance(value, str) and value else None
