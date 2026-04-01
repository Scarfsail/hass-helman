from __future__ import annotations

from typing import TypedDict


class ApplianceMetadataResponseDict(TypedDict):
    appliances: list[dict]


class ApplianceProjectionsResponseDict(TypedDict):
    generatedAt: str
    appliances: dict[str, dict]


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
