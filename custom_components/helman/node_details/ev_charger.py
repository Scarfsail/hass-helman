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
  ``unavailable`` blip moves it too. From the same run mode history it carries
  ``charging``, today's recorded charging stretches, which the detail's
  charging strip draws on opening.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..config_path import get as config_value

from ..controllables.config import own_meter, peek_controllable_id
from .battery import today_ranking_report
from .context import NodeDetailContext
from .day_stats import SEGMENT_MAX_GAP, async_state_history, day_window, with_live_state
from .house import ranking_money
from .inverter import run_mode_condition

#: How far back the charging segment's start is looked for.
SEGMENT_LOOKBACK = timedelta(hours=24)
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
    hass: Any, ctx: NodeDetailContext, now: datetime, device: Mapping[str, Any]
) -> dict[str, Any]:
    """The charger's mappings and overview facts; no recorder read.

    ``profile`` is ``None`` for a Custom charger: ``entities`` then carries
    its config keys only, and ``status`` is ``None``. A telemetry key the
    profile has but the registry does not (disabled, missing) is present as
    ``None``.
    """
    device_id = peek_controllable_id(device)
    telemetry = ctx.telemetry.get(device_id)

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
    ctx: NodeDetailContext,
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
        return await _async_segment_section(hass, ctx, now, device)
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
        "priceUnit": None,
        "complete": False,
        "unavailable": None,
        "charger": None,
    }
    report = await today_ranking_report(ctx, local_now)
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
        "asOf": report["asOf"],
        "priceUnit": report.get("priceUnit"),
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
    hass: Any, ctx: NodeDetailContext, now: datetime, device: Mapping[str, Any]
) -> dict[str, Any]:
    """The charging segment's start and today's charging stretches, as recorded.

    ``chargingSince`` is ``None`` when not charging or unknown. ``charging`` is
    ``None`` without a run mode to read (a Custom charger), else the stretches
    of today in which the run mode was charging; ``open`` marks the one still
    charging when read, which ends at ``asOf``.
    """
    device_id = peek_controllable_id(device)
    telemetry = ctx.telemetry.get(device_id)
    local_now = dt_util.as_local(now)
    day_start, day_end = day_window(local_now)
    entity_id = telemetry.entities.get("run_mode") if telemetry is not None else None
    since = None
    charging = None
    if entity_id:
        # Back to midnight for the strip, and a day back for a segment begun yesterday.
        start = min(day_start, now - SEGMENT_LOOKBACK)
        history = await async_state_history(hass, [entity_id], start, now)
        states = with_live_state(hass, entity_id, history[entity_id])
        conditions = telemetry.profile.run_mode_conditions
        status = run_mode_condition(hass, telemetry)
        if status is not None and status["kind"] == "charging":
            since = charging_segment_start(states, conditions, now)
        charging = [
            {
                "start": dt_util.as_local(begin).isoformat(),
                "end": dt_util.as_local(end).isoformat(),
                "open": still_charging,
            }
            for begin, end, still_charging in charging_intervals(states, conditions, day_start, now)
        ]
    return {
        "node": "ev_charger",
        "section": "segment",
        "deviceId": device_id,
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(day_start).isoformat(),
            "end": dt_util.as_local(day_end).isoformat(),
        },
        "chargingSince": None if since is None else dt_util.as_local(since).isoformat(),
        "charging": charging,
    }


def charging_intervals(
    states: Sequence[Any], conditions: Mapping[str, str], start: datetime, now: datetime
) -> list[tuple[datetime, datetime, bool]]:
    """The recorded charging stretches over ``[start, now]``, clipped to it, each with whether it is still going.

    A stretch runs from a charging state to the next state that is something
    else. A gap state (``unavailable``, ``unknown``) up to
    :data:`SEGMENT_MAX_GAP` between two charging states does not break it, as
    for the segment; any other gap ends the stretch where the gap began, so
    only recorded charging is drawn. The newest charging state runs to ``now``,
    and is the one still going.
    """
    ordered = sorted(states, key=lambda state: state.last_changed)
    stretches: list[tuple[datetime, datetime, bool]] = []
    since: datetime | None = None
    gap_from: datetime | None = None
    for state in ordered:
        at = state.last_changed
        if state.state in _GAP_STATES:
            if since is not None and gap_from is None:
                gap_from = at
            continue
        charging = conditions.get(state.state) == "charging"
        if since is not None:
            if gap_from is not None and (not charging or at - gap_from > SEGMENT_MAX_GAP):
                stretches.append((since, gap_from, False))
                since = None
            elif not charging:
                stretches.append((since, at, False))
                since = None
        gap_from = None
        if charging and since is None:
            since = at
    if since is not None:
        open_gap = gap_from is not None and now - gap_from > SEGMENT_MAX_GAP
        stretches.append((since, gap_from if open_gap else now, not open_gap))
    return [
        (max(begin, start), min(end, now), still)
        for begin, end, still in stretches
        if end > start and begin < now and min(end, now) > max(begin, start)
    ]


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
    # When the run mode was last known after the states walked so far: a run
    # of consecutive gap states is measured as one gap.
    known_from = now
    for state in reversed(ordered):
        if state.state in _GAP_STATES:
            if known_from - state.last_changed > SEGMENT_MAX_GAP:
                return None
            continue
        if conditions.get(state.state) != "charging":
            return since
        since = known_from = state.last_changed
    return None


def _device_entity(device: Mapping[str, Any], path: str) -> str | None:
    """The entity id at ``path`` in the device, ``None`` when unset."""
    value = config_value(device, path)
    return value if isinstance(value, str) and value else None
