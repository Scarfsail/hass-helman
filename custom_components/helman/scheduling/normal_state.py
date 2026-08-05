"""The hardware Helman can drive, and the state that counts as at rest for each.

"Normal" is uniformly the resting state: the configured normal mode for the
inverter, and off for every appliance regardless of kind. The inspector reads
this list to name its lanes and to tell a running entity from an idle one.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, NotRequired, TypedDict

from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from .schedule import ScheduleControlConfig

if TYPE_CHECKING:
    from ..appliances.state import AppliancesRuntimeRegistry

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


def _appliance_entity_id(appliance: Any) -> str | None:
    """The entity that decides whether the appliance is running."""
    for attribute in ("climate_entity_id", "charge_entity_id", "switch_entity_id"):
        entity_id = getattr(appliance, attribute, None)
        if isinstance(entity_id, str) and entity_id:
            return entity_id
    return None
