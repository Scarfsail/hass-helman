from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal, TypedDict

from ..controllables.kinds import CONTROLLABLE_KIND_CLIMATE
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

_DEFAULT_CLIMATE_STOP_HVAC_MODE = "off"

ClimateApplianceMode = Literal["heat", "cool"]
SUPPORTED_CLIMATE_MODES: tuple[ClimateApplianceMode, ...] = ("heat", "cool")


@dataclass(frozen=True)
class ClimateApplianceRuntime:
    id: str
    name: str
    climate_entity_id: str
    projection: ProjectionConfig
    icon: str | None = None
    supported_modes: tuple[ClimateApplianceMode, ...] = SUPPORTED_CLIMATE_MODES
    stop_hvac_mode: str | None = _DEFAULT_CLIMATE_STOP_HVAC_MODE

    @property
    def kind(self) -> str:
        return CONTROLLABLE_KIND_CLIMATE

    @property
    def authorable_modes(self) -> tuple[ClimateApplianceMode, ...]:
        if self.stop_hvac_mode is None:
            return ()
        return self.supported_modes


class ClimateApplianceScheduleCapabilitiesDict(TypedDict):
    modes: list[ClimateApplianceMode]


class ClimateApplianceMetadataDict(TypedDict):
    icon: str
    scheduleCapabilities: ClimateApplianceScheduleCapabilitiesDict


class ClimateApplianceControlsDict(TypedDict):
    climate: EntityReferenceDict


class ClimateApplianceResponseDict(ControllableRosterFieldsDict):
    id: str
    name: str
    kind: str
    supportsAuthoring: bool
    metadata: ClimateApplianceMetadataDict
    controls: ClimateApplianceControlsDict


def build_climate_appliance_metadata_dict(
    appliance: ClimateApplianceRuntime,
    roster: ControllableRosterFieldsDict,
) -> ClimateApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        **roster,
        # Without a mode to switch it into there is nothing to author.
        "supportsAuthoring": bool(appliance.authorable_modes),
        "metadata": {
            "icon": resolve_appliance_icon(appliance.icon),
            "scheduleCapabilities": {
                "modes": list(appliance.authorable_modes),
            },
        },
        "controls": {
            "climate": {"entityId": appliance.climate_entity_id},
        },
    }


def read_climate_appliance(
    value: object,
    *,
    path: str,
) -> ClimateApplianceRuntime:
    value = read_mapping(value, path=path)
    read_kind(value, path=path, kind=CONTROLLABLE_KIND_CLIMATE)
    appliance_id = read_required_string(value.get("id"), path=f"{path}.id")
    name = read_required_string(value.get("name"), path=f"{path}.name")

    controls = read_mapping(value.get("controls"), path=f"{path}.controls")
    climate = read_mapping(controls.get("climate"), path=f"{path}.controls.climate")
    climate_entity_id = read_entity_id(
        climate.get("entity_id"),
        path=f"{path}.controls.climate.entity_id",
        allowed_domains=("climate",),
    )

    return ClimateApplianceRuntime(
        id=appliance_id,
        name=name,
        climate_entity_id=climate_entity_id,
        projection=read_projection_config(value, path=path),
        icon=read_optional_icon(value.get("icon"), path=f"{path}.icon"),
    )


def resolve_supported_climate_modes(
    available_hvac_modes: Iterable[str],
) -> tuple[ClimateApplianceMode, ...]:
    available_modes = set()
    for raw_mode in available_hvac_modes:
        stripped = raw_mode.strip()
        if stripped:
            available_modes.add(stripped)
    return tuple(mode for mode in SUPPORTED_CLIMATE_MODES if mode in available_modes)
