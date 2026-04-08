from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from .climate_appliance import (
    ClimateApplianceResponseDict,
    ClimateApplianceRuntime,
    build_climate_appliance_metadata_dict,
)
from .ev_charger import (
    EvChargerApplianceResponseDict,
    EvChargerApplianceRuntime,
    build_ev_charger_metadata_dict,
)
from .generic_appliance import (
    GenericApplianceResponseDict,
    GenericApplianceRuntime,
    build_generic_appliance_metadata_dict,
)
from .state import AppliancesRuntimeRegistry

if TYPE_CHECKING:
    from .projection_response import ApplianceProjectionsResponseDict


ApplianceResponseDict = (
    ClimateApplianceResponseDict
    | EvChargerApplianceResponseDict
    | GenericApplianceResponseDict
)


class ApplianceMetadataResponseDict(TypedDict):
    appliances: list[ApplianceResponseDict]


def build_appliances_response(
    registry: AppliancesRuntimeRegistry,
) -> ApplianceMetadataResponseDict:
    if not registry.appliances:
        return build_empty_appliances_response()

    return {
        "appliances": [_build_appliance_metadata(appliance) for appliance in registry.appliances]
    }


def build_empty_appliances_response() -> ApplianceMetadataResponseDict:
    return {"appliances": []}


def _build_appliance_metadata(appliance) -> ApplianceResponseDict:
    if isinstance(appliance, ClimateApplianceRuntime):
        return build_climate_appliance_metadata_dict(appliance)
    if isinstance(appliance, EvChargerApplianceRuntime):
        return build_ev_charger_metadata_dict(appliance)
    if isinstance(appliance, GenericApplianceRuntime):
        return build_generic_appliance_metadata_dict(appliance)
    raise TypeError(f"Unsupported appliance runtime {type(appliance)!r}")


def build_empty_appliance_projections_response(
    *,
    generated_at: str,
) -> ApplianceProjectionsResponseDict:
    return {
        "generatedAt": generated_at,
        "appliances": {},
    }
