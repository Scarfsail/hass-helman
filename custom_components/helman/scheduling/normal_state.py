"""Listing and restoring the hardware Helman left in a non-normal state.

Disabling schedule execution is passive: whatever the inverter and the
appliances were doing keeps going. This module answers "what is still not in
its resting state?" so the scheduling card can show it, and applies the bulk
"turn everything to normal" the user triggers from that card.

"Normal" is uniformly the resting state: the configured normal mode for the
inverter, and off for every appliance regardless of kind.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, NotRequired, TypedDict

from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from .actuation import ScheduleActuator
from .schedule import ScheduleControlConfig

if TYPE_CHECKING:
    from ..appliances.state import AppliancesRuntimeRegistry

_LOGGER = logging.getLogger(__name__)

_UNAVAILABLE_STATES = {"unknown", "unavailable", "none", ""}
_DEFAULT_CLIMATE_OFF_MODE = "off"


class ControllableEntityDict(TypedDict):
    """An entity Helman can drive, and the state that counts as "at rest".

    A single ``normalState`` string covers every kind: the configured normal
    option for the inverter, and off for every appliance. An entity is
    non-normal exactly when its live state differs from it, which lets the card
    filter the list straight from ``hass.states`` and stay reactive without
    asking the backend again.

    ``actionOptions`` maps schedule action kinds to the inverter mode option
    each one selects. The card needs it in both directions: to label the live
    inverter mode with the same chip the slot editor uses, and to project a
    scheduled action onto the entity state it will produce. Only the inverter
    carries it -- appliance states follow from their action shape.
    """

    kind: str
    name: str
    entityId: str
    normalState: str
    actionOptions: NotRequired[dict[str, str]]


class NonNormalEntityDict(ControllableEntityDict):
    """A controllable entity that is currently not at rest."""

    state: str


def _read_state_value(actuator: ScheduleActuator, entity_id: str) -> str | None:
    """Return the entity's state, or None when it cannot be read."""
    state = actuator.read_state(entity_id)
    raw_state = getattr(state, "state", None)
    if not isinstance(raw_state, str):
        return None
    normalized = raw_state.strip()
    if normalized.lower() in _UNAVAILABLE_STATES:
        return None
    return normalized


def _climate_off_mode(appliance: Any) -> str:
    return getattr(appliance, "stop_hvac_mode", None) or _DEFAULT_CLIMATE_OFF_MODE


def build_controllable_entities(
    *,
    control_config: ScheduleControlConfig | None,
    registry: "AppliancesRuntimeRegistry",
) -> list[ControllableEntityDict]:
    """List everything Helman can drive, with the state that counts as at rest."""
    entities: list[ControllableEntityDict] = []

    if control_config is not None:
        entities.append(
            ControllableEntityDict(
                kind="inverter",
                name="Inverter",
                entityId=control_config.mode_entity_id,
                normalState=control_config.normal_option,
                actionOptions=_build_inverter_action_options(control_config),
            )
        )

    for appliance in registry.appliances:
        entity_id = _appliance_entity_id(appliance)
        if entity_id is None:
            continue
        entities.append(
            ControllableEntityDict(
                kind=appliance.kind,
                name=appliance.name,
                entityId=entity_id,
                normalState=(
                    _climate_off_mode(appliance)
                    if getattr(appliance, "climate_entity_id", None)
                    else "off"
                ),
            )
        )

    return entities


def _build_inverter_action_options(
    control_config: ScheduleControlConfig,
) -> dict[str, str]:
    """The inverter mode option each schedule action kind selects.

    Actions the installation has no option configured for are left out rather
    than mapped to a placeholder, so the card can tell "not available here"
    apart from "selects this option".
    """
    options = {
        SCHEDULE_ACTION_NORMAL: control_config.normal_option,
        SCHEDULE_ACTION_STOP_CHARGING: control_config.stop_charging_option,
        SCHEDULE_ACTION_STOP_DISCHARGING: control_config.stop_discharging_option,
        SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC: (
            control_config.charge_to_target_soc_option
        ),
        SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC: (
            control_config.discharge_to_target_soc_option
        ),
        SCHEDULE_ACTION_STOP_EXPORT: control_config.stop_export_option,
    }
    return {kind: option for kind, option in options.items() if option}


def build_non_normal_entities(
    *,
    actuator: ScheduleActuator,
    control_config: ScheduleControlConfig | None,
    registry: "AppliancesRuntimeRegistry",
) -> list[NonNormalEntityDict]:
    """List the inverter and appliances that are not in their resting state.

    Entities that cannot be read are omitted rather than guessed at: an
    unavailable entity is not something the user can act on from here.
    """
    entities: list[NonNormalEntityDict] = []

    for controllable in build_controllable_entities(
        control_config=control_config,
        registry=registry,
    ):
        state = _read_state_value(actuator, controllable["entityId"])
        if state is None or state == controllable["normalState"]:
            continue
        entities.append(NonNormalEntityDict(**controllable, state=state))

    return entities


def _appliance_entity_id(appliance: Any) -> str | None:
    """The entity that decides whether the appliance is running."""
    for attribute in ("climate_entity_id", "charge_entity_id", "switch_entity_id"):
        entity_id = getattr(appliance, attribute, None)
        if isinstance(entity_id, str) and entity_id:
            return entity_id
    return None


async def async_restore_normal_state(
    *,
    actuator: ScheduleActuator,
    control_config: ScheduleControlConfig | None,
    registry: "AppliancesRuntimeRegistry",
) -> int:
    """Put the inverter and every running appliance back to rest, best effort.

    Failures are logged and skipped rather than aborting or rolling back: the
    card re-renders from live entity state, so whatever did not settle simply
    stays listed and the user can retry or act on it individually.

    Returns the number of entities that were successfully restored.
    """
    restored = 0

    for entity in build_non_normal_entities(
        actuator=actuator,
        control_config=control_config,
        registry=registry,
    ):
        try:
            await _async_restore_entity(actuator=actuator, entity=entity)
        except Exception:
            _LOGGER.warning(
                "Failed to restore '%s' to its normal state",
                entity["entityId"],
                exc_info=True,
            )
            continue
        restored += 1

    return restored


async def _async_restore_entity(
    *,
    actuator: ScheduleActuator,
    entity: NonNormalEntityDict,
) -> None:
    """Drive one entity to its normal state, picking the service by domain."""
    entity_id = entity["entityId"]
    domain = entity_id.partition(".")[0]
    normal_state = entity["normalState"]

    if domain == "climate":
        await actuator.async_call(
            "climate",
            "set_hvac_mode",
            {"entity_id": entity_id, "hvac_mode": normal_state},
        )
    elif domain == "switch":
        await actuator.async_call(
            "switch", "turn_off", {"entity_id": entity_id}
        )
    else:
        await actuator.async_call(
            domain,
            "select_option",
            {"entity_id": entity_id, "option": normal_state},
        )
