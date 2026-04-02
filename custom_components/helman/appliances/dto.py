from __future__ import annotations

from typing import TypedDict

from .ev_charger import (
    EvChargerApplianceResponseDict,
    build_ev_charger_metadata_dict,
)
from .state import AppliancesRuntimeRegistry


class ApplianceMetadataResponseDict(TypedDict):
    appliances: list[EvChargerApplianceResponseDict]


class ApplianceProjectionsResponseDict(TypedDict):
    generatedAt: str
    appliances: dict[str, dict]


def build_appliances_response(
    registry: AppliancesRuntimeRegistry,
) -> ApplianceMetadataResponseDict:
    if not registry.appliances:
        return build_empty_appliances_response()

    return {
        "appliances": [
            build_ev_charger_metadata_dict(appliance)
            for appliance in registry.appliances
        ]
    }


def build_empty_appliances_response() -> ApplianceMetadataResponseDict:
    return {"appliances": []}


def build_empty_appliance_projections_response(
    *,
    generated_at: str,
) -> ApplianceProjectionsResponseDict:
    return {
        "generatedAt": generated_at,
        "appliances": {},
    }
