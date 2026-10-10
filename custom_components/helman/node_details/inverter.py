"""The inverter detail: what Helman commanded, and what the hardware shows.

The overview keeps four facts apart that are easy to blur: the commanded mode
(Helman's mode control, the last command), the observed configuration (the
vendor's mode registers, compared by :func:`..vendors.modes.mode_agreement`),
the schedule's intent and the executor's outcome. The last two come from
``helman/get_schedule``, which the card already reads, so they are not repeated
here.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from ..controllables.spec import CONTROLLABLE_KIND_INVERTER, CONTROLLABLE_SPECS
from ..scheduling.schedule import read_schedule_control_config
from ..vendors import INVERTER_TELEMETRY_KEY, resolve_vendor_telemetry
from ..vendors.modes import mode_agreement
from .day_stats import async_day_stats, day_window

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
        "condition": _run_mode_condition(hass, telemetry),
        "sections": ["temperature"] if entities.get("inverter_temperature") else [],
    }


async def async_inverter_section(
    hass: Any, config: Mapping[str, Any], section: str, now: datetime
) -> dict[str, Any]:
    """Today's inverter temperature, the one history section of the inverter.

    ``temperature`` is ``None`` when the profile resolves no temperature sensor.
    """
    telemetry = resolve_vendor_telemetry(hass, config).get(INVERTER_TELEMETRY_KEY)
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


def _run_mode_condition(hass: Any, telemetry: Any) -> dict[str, str] | None:
    """An off-grid or fault run mode the profile names, as the hardware reports it."""
    if telemetry is None:
        return None
    entity_id = telemetry.entities.get("run_mode")
    state = hass.states.get(entity_id) if entity_id else None
    if state is None:
        return None
    kind = telemetry.profile.run_mode_conditions.get(state.state)
    return None if kind is None else {"kind": kind, "runMode": state.state, "entityId": entity_id}
