from __future__ import annotations

from typing import TypedDict

from ..controllables.config import CONTROLLABLE_ID_INVERTER
from ..controllables.spec import CONTROLLABLE_KIND_INVERTER
from ..scheduling.normal_state import (
    ControllableEntityDict,
    build_controllable_entity,
    iter_controllable_sources,
)
from ..scheduling.schedule import ScheduleControlConfig
from .climate_appliance import ClimateApplianceResponseDict
from .ev_charger import EvChargerApplianceResponseDict
from .generic_appliance import GenericApplianceResponseDict
from .roster import ControllableRosterFieldsDict
from .state import AppliancesRuntimeRegistry


class InverterResponseDict(ControllableRosterFieldsDict):
    """The inverter's entry: the roster fields alone, under its reserved id."""

    id: str
    name: str
    kind: str
    supportsAuthoring: bool


ApplianceResponseDict = (
    InverterResponseDict
    | ClimateApplianceResponseDict
    | EvChargerApplianceResponseDict
    | GenericApplianceResponseDict
)


class ApplianceMetadataResponseDict(TypedDict):
    appliances: list[ApplianceResponseDict]


def build_appliances_response(
    registry: AppliancesRuntimeRegistry,
    *,
    control_config: ScheduleControlConfig | None = None,
) -> ApplianceMetadataResponseDict:
    """Everything Helman can drive, in configuration order, the inverter first.

    One list serves both questions the card asks of it: each kind's own payload
    (the EV node detail reads the charger's controls and vehicles), and the
    resting state the schedule surfaces compare live state against.
    """
    appliances: list[ApplianceResponseDict] = []
    for spec, source in iter_controllable_sources(
        control_config=control_config, registry=registry
    ):
        entity = build_controllable_entity(spec, source)
        if entity is None:
            continue
        roster = _roster_fields(entity)
        if spec.kind == CONTROLLABLE_KIND_INVERTER:
            appliances.append({
                "id": CONTROLLABLE_ID_INVERTER,
                "name": entity["name"],
                "kind": spec.kind,
                **roster,
                "supportsAuthoring": True,
            })
        else:
            appliances.append(spec.metadata(source, roster))
    return {"appliances": appliances}


def _roster_fields(entity: ControllableEntityDict) -> ControllableRosterFieldsDict:
    roster = ControllableRosterFieldsDict(
        primaryEntityId=entity["entityId"],
        normalState=entity["normalState"],
    )
    if "actionOptions" in entity:
        roster["actionOptions"] = entity["actionOptions"]
    return roster

