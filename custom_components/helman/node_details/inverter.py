"""The inverter detail: what Helman commanded, and what the hardware shows.

The overview keeps four facts apart that are easy to blur: the commanded mode
(Helman's mode control, the last command), the observed configuration (the
vendor's mode registers, compared by :func:`..vendors.modes.mode_agreement`),
the schedule's intent and the executor's outcome. The last two come from
``helman/get_schedule``, which the card already reads, so they are not repeated
here.

Two history sections, each read when the detail needs it:

- ``temperature``: today's inverter temperature, in five-minute buckets.
- ``modes``: today's observed modes. No single entity holds the inverter's
  mode: it is the option whose writes the profile's mode registers hold, by
  :func:`..vendors.modes.first_matching_option`, the same definition the
  overview's agreement uses. The registers' recorded states are replayed over
  the day, and each moment is mapped to that option, an action kind.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from ..controllables.spec import CONTROLLABLE_KIND_INVERTER, CONTROLLABLE_SPECS
from ..scheduling.schedule import read_schedule_control_config
from ..vendors import INVERTER_TELEMETRY_KEY, resolve_vendor_telemetry
from ..vendors.modes import BoundWrite, bound_mode_writes, first_matching_option, mode_agreement
from .day_stats import SEGMENT_MAX_GAP, async_day_stats, async_state_history, day_window, with_live_state

#: Config-backed readings the inverter answers use, beside the telemetry, by
#: the key the payload's ``entities`` carries them under. Plain percentages,
#: so the card reads them without a polarity.
_CONFIG_ENTITIES = {
    "battery_min_soc": ("battery", "min_soc"),
    "battery_max_soc": ("battery", "max_soc"),
}


def build_inverter_overview(
    hass: Any, config: Mapping[str, Any], now: datetime
) -> dict[str, Any]:
    """The inverter's mappings and overview facts; no recorder read.

    ``configured`` is false when the inverter has neither a mode control nor a
    hardware profile: the card then shows no inverter. ``profile`` is ``None``
    for a Custom inverter, whose answers come from its config alone, and its
    ``entities`` then carry no telemetry keys. A telemetry key the profile has
    but the registry does not (disabled, missing) is present as ``None``.
    """
    control = read_schedule_control_config(config)
    telemetry = resolve_vendor_telemetry(hass, config).get(INVERTER_TELEMETRY_KEY)

    mode: dict[str, Any] | None = None
    commanded: str | None = None
    if control is not None:
        action_options = CONTROLLABLE_SPECS[CONTROLLABLE_KIND_INVERTER].action_options(
            control
        )
        mode = {"entityId": control.mode_entity_id, "actionOptions": action_options}
        state = hass.states.get(control.mode_entity_id)
        if state is not None:
            commanded = next(
                (kind for kind, option in action_options.items() if option == state.state),
                None,
            )

    entities: dict[str, str | None] = {}
    if telemetry is not None:
        entities.update(telemetry.entities)
    energy_nodes = config.get("energy_nodes", {}) if isinstance(config, Mapping) else {}
    for key, (node, slot) in _CONFIG_ENTITIES.items():
        entity_id = energy_nodes.get(node, {}).get("entities", {}).get(slot)
        entities[key] = entity_id if isinstance(entity_id, str) and entity_id else None

    if telemetry is None or not telemetry.profile.modes:
        agreement: dict[str, Any] = {
            "status": "unknown",
            "reason": "no_profile",
            "commanded": commanded,
            "observedOption": None,
            "registers": [],
        }
    else:
        agreement = mode_agreement(
            hass, telemetry.profile, telemetry.entry, config, commanded
        )

    return {
        "node": "inverter",
        "asOf": dt_util.as_local(now).isoformat(),
        "configured": control is not None or telemetry is not None,
        "profile": (
            None
            if telemetry is None
            else {"id": telemetry.profile.id, "label": telemetry.profile.label}
        ),
        "mode": mode,
        "entities": entities,
        "maxAllowedExportPower": energy_nodes.get("grid", {}).get(
            "max_allowed_export_power"
        ),
        "agreement": agreement,
        "condition": run_mode_condition(hass, telemetry),
        "sections": [
            *(["temperature"] if entities.get("inverter_temperature") else []),
            *(["modes"] if telemetry is not None and telemetry.profile.modes else []),
        ],
    }


async def async_inverter_section(
    hass: Any, config: Mapping[str, Any], section: str, now: datetime
) -> dict[str, Any]:
    """Today's inverter temperature, or today's observed modes (``modes``).

    ``temperature`` is ``None`` when the profile resolves no temperature sensor.
    """
    telemetry = resolve_vendor_telemetry(hass, config).get(INVERTER_TELEMETRY_KEY)
    if section == "modes":
        return await _async_modes_section(hass, config, now, telemetry)
    entity_id = None if telemetry is None else telemetry.entities.get("inverter_temperature")
    start, end = day_window(dt_util.as_local(now))
    stats = (
        await async_day_stats(hass, [entity_id], start=start, end=end, now=now)
        if entity_id
        else {}
    )
    return {
        "node": "inverter",
        "section": section,
        "asOf": dt_util.as_local(now).isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
        "temperature": stats.get(entity_id) if entity_id else None,
    }


async def _async_modes_section(
    hass: Any, config: Mapping[str, Any], now: datetime, telemetry: Any
) -> dict[str, Any]:
    """Today's observed modes, from the recorded states of the mode registers.

    ``modes`` is ``None`` without registers to read (a Custom inverter, or a
    profile none of whose modes binds), else the stretches of today from
    midnight to ``asOf``, each with the action kind the registers held, or
    ``None`` where they held none (a register unreadable, unrecorded or in a
    combination no mode writes): unknown, never forced into a mode. ``open``
    marks the last stretch, still going when read.

    The export limit tells only ``stop_export`` (zero) from the other modes,
    whatever the cap is configured to now, so a past stretch stays as it was.
    """
    local_now = dt_util.as_local(now)
    start, end = day_window(local_now)
    modes = None
    bound = (
        bound_mode_writes(hass, telemetry.profile, telemetry.entry, config, history=True)
        if telemetry is not None and telemetry.profile.modes
        else {}
    )
    entity_ids = list(
        dict.fromkeys(entity_id for writes in bound.values() for entity_id, _ in writes or ())
    )
    if entity_ids:
        history = await async_state_history(hass, entity_ids, start, now)
        states = {
            entity_id: with_live_state(hass, entity_id, history[entity_id])
            for entity_id in entity_ids
        }
        modes = [
            {
                "start": dt_util.as_local(begin).isoformat(),
                "end": dt_util.as_local(stop).isoformat(),
                "kind": kind,
                "open": still,
            }
            for begin, stop, kind, still in mode_intervals(states, bound, start, now)
        ]
    return {
        "node": "inverter",
        "section": "modes",
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
        "modes": modes,
    }


def mode_intervals(
    states: Mapping[str, Sequence[Any]],
    bound: Mapping[str, list[BoundWrite] | None],
    start: datetime,
    now: datetime,
) -> list[tuple[datetime, datetime, str | None, bool]]:
    """The observed mode over ``[start, now]``, as ``(begin, end, kind, still going)``.

    Replays every register's recorded states in time order: after each change
    the mode is the first option whose writes all registers hold, ``None`` when
    none does. Before a register's first recorded state it holds nothing
    readable. Equal neighbours merge; nothing is drawn before the first record.
    Settled by :func:`_settle`: a blip or a half-written mode is no stretch.
    """
    events = sorted(
        (
            (dt_util.as_utc(state.last_changed), entity_id, state)
            for entity_id, recorded in states.items()
            for state in recorded
        ),
        key=lambda event: event[0],
    )
    held: dict[str, Any] = {}
    stretches: list[list[Any]] = []
    utc_start, utc_now = dt_util.as_utc(start), dt_util.as_utc(now)
    index = 0
    while index < len(events):
        at = events[index][0]
        # Changes recorded at the same instant are one change.
        while index < len(events) and events[index][0] == at:
            held[events[index][1]] = events[index][2]
            index += 1
        if at >= utc_now:
            break
        kind = first_matching_option(bound, held.get)
        begin = max(at, utc_start)
        if stretches and stretches[-1][2] == kind:
            continue
        if stretches and stretches[-1][0] >= begin:
            # States from before the window: only the last of them holds at its start.
            stretches[-1][2] = kind
            continue
        if stretches:
            stretches[-1][1] = begin
        stretches.append([begin, utc_now, kind])
    settled = _settle([(begin, stop, kind) for begin, stop, kind in stretches])
    return [
        (begin, stop, kind, index == len(settled) - 1)
        for index, (begin, stop, kind) in enumerate(settled)
    ]


def _settle(
    stretches: list[tuple[datetime, datetime, str | None]],
) -> list[tuple[datetime, datetime, str | None]]:
    """``stretches`` without the ones shorter than :data:`SEGMENT_MAX_GAP`.

    A mode written register by register is recorded as several states, and a
    Modbus blip as an ``unavailable`` one: either leaves a short stretch the
    inverter was never settled in. It is absorbed into the stretch that
    follows, which then merges with an equal one before it, so a blip between
    two equal modes is bridged. A longer unknown stretch stays a gap. The
    first stretch, which may have begun before the window, and the last, still
    going, are kept however short.
    """
    settled: list[list[Any]] = []
    absorbed_from: datetime | None = None
    for index, (begin, stop, kind) in enumerate(stretches):
        if 0 < index < len(stretches) - 1 and stop - begin < SEGMENT_MAX_GAP:
            absorbed_from = absorbed_from or begin
            continue
        begin, absorbed_from = absorbed_from or begin, None
        if settled and settled[-1][2] == kind:
            settled[-1][1] = stop
        else:
            settled.append([begin, stop, kind])
    return [(begin, stop, kind) for begin, stop, kind in settled]


def run_mode_condition(hass: Any, telemetry: Any) -> dict[str, str] | None:
    """An off-grid or fault run mode the profile names, as the hardware reports it."""
    if telemetry is None:
        return None
    entity_id = telemetry.entities.get("run_mode")
    state = hass.states.get(entity_id) if entity_id else None
    if state is None:
        return None
    kind = telemetry.profile.run_mode_conditions.get(state.state)
    return None if kind is None else {"kind": kind, "runMode": state.state, "entityId": entity_id}
