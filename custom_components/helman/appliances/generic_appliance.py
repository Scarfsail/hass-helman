from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

from ..controllables.config import SWITCH_CONTROL_DOMAINS
from ..controllables.kinds import CONTROLLABLE_KIND_GENERIC
from ._read import (
    ProjectionConfig,
    read_entity_id,
    read_kind,
    read_mapping,
    read_optional_icon,
    read_projection_config,
    read_required_string,
)
from .icon import resolve_appliance_icon
from .roster import ControllableRosterFieldsDict, EntityReferenceDict


@dataclass(frozen=True)
class GenericApplianceRuntime:
    id: str
    name: str
    switch_entity_id: str
    projection: ProjectionConfig
    icon: str | None = None

    @property
    def kind(self) -> str:
        return CONTROLLABLE_KIND_GENERIC


class GenericApplianceScheduleCapabilitiesDict(TypedDict):
    onOffToggle: bool


class GenericApplianceMetadataDict(TypedDict):
    icon: str
    scheduleCapabilities: GenericApplianceScheduleCapabilitiesDict


class GenericApplianceControlsDict(TypedDict):
    switch: EntityReferenceDict


class GenericApplianceResponseDict(ControllableRosterFieldsDict):
    id: str
    name: str
    kind: str
    supportsAuthoring: bool
    metadata: GenericApplianceMetadataDict
    controls: GenericApplianceControlsDict


def build_generic_appliance_metadata_dict(
    appliance: GenericApplianceRuntime,
    roster: ControllableRosterFieldsDict,
) -> GenericApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        **roster,
        "supportsAuthoring": True,
        "metadata": {
            "icon": resolve_appliance_icon(appliance.icon),
            "scheduleCapabilities": {
                "onOffToggle": True,
            }
        },
        "controls": {
            "switch": {"entityId": appliance.switch_entity_id},
        },
    }


def read_generic_appliance(
    value: object,
    *,
    path: str,
) -> GenericApplianceRuntime:
    value = read_mapping(value, path=path)
    read_kind(value, path=path, kind=CONTROLLABLE_KIND_GENERIC)
    appliance_id = read_required_string(value.get("id"), path=f"{path}.id")
    name = read_required_string(value.get("name"), path=f"{path}.name")

    controls = read_mapping(value.get("controls"), path=f"{path}.controls")
    switch = read_mapping(controls.get("switch"), path=f"{path}.controls.switch")
    switch_entity_id = read_entity_id(
        switch.get("entity_id"),
        path=f"{path}.controls.switch.entity_id",
        allowed_domains=SWITCH_CONTROL_DOMAINS,
    )

    return GenericApplianceRuntime(
        id=appliance_id,
        name=name,
        switch_entity_id=switch_entity_id,
        projection=read_projection_config(value, path=path),
        icon=read_optional_icon(value.get("icon"), path=f"{path}.icon"),
    )
