from __future__ import annotations

from typing import TypedDict

from .projection_builder import ApplianceProjectionPlan
from .state import AppliancesRuntimeRegistry


class ApplianceProjectionPointDict(TypedDict):
    slotId: str
    energyKwh: float
    mode: str
    vehicleId: str | None
    vehicleSoc: int | None


class ApplianceProjectionSeriesDict(TypedDict):
    series: list[ApplianceProjectionPointDict]


class ApplianceProjectionsResponseDict(TypedDict):
    generatedAt: str
    appliances: dict[str, ApplianceProjectionSeriesDict]


def build_empty_appliance_projections_response(
    *,
    generated_at: str,
) -> ApplianceProjectionsResponseDict:
    return {
        "generatedAt": generated_at,
        "appliances": {},
    }


def build_appliance_projections_response(
    *,
    plan: ApplianceProjectionPlan,
    registry: AppliancesRuntimeRegistry,
    hass,
) -> ApplianceProjectionsResponseDict:
    appliances: dict[str, ApplianceProjectionSeriesDict] = {}

    for appliance_id, series in plan.appliances_by_id.items():
        appliance = registry.get_appliance(appliance_id)
        if appliance is None:
            continue

        cumulative_energy_by_vehicle: dict[str, float] = {}
        response_points: list[ApplianceProjectionPointDict] = []
        for point in series.points:
            vehicle_soc = None
            if point.vehicle_id is not None:
                live_soc = _read_vehicle_soc_pct(
                    hass=hass,
                    appliance=appliance,
                    vehicle_id=point.vehicle_id,
                )
                if live_soc is not None:
                    cumulative_energy_by_vehicle[point.vehicle_id] = (
                        cumulative_energy_by_vehicle.get(point.vehicle_id, 0.0)
                        + point.energy_kwh
                    )
                    vehicle = appliance.get_vehicle(point.vehicle_id)
                    if vehicle is not None and vehicle.battery_capacity_kwh > 0:
                        vehicle_soc = round(
                            min(
                                100.0,
                                live_soc
                                + (
                                    cumulative_energy_by_vehicle[point.vehicle_id]
                                    / vehicle.battery_capacity_kwh
                                )
                                * 100.0,
                            )
                        )

            response_points.append(
                {
                    "slotId": point.slot_id,
                    "energyKwh": point.energy_kwh,
                    "mode": point.mode,
                    "vehicleId": point.vehicle_id,
                    "vehicleSoc": vehicle_soc,
                }
            )

        if response_points:
            appliances[appliance_id] = {"series": response_points}

    return {
        "generatedAt": plan.generated_at,
        "appliances": appliances,
    }


def _read_vehicle_soc_pct(*, hass, appliance, vehicle_id: str) -> float | None:
    vehicle = appliance.get_vehicle(vehicle_id)
    if vehicle is None:
        return None
    state = hass.states.get(vehicle.soc_entity_id)
    if state is None:
        return None
    raw_state = getattr(state, "state", None)
    if isinstance(raw_state, (int, float)) and not isinstance(raw_state, bool):
        return float(raw_state)
    if not isinstance(raw_state, str):
        return None
    stripped = raw_state.strip()
    if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
        return None
    try:
        return float(stripped)
    except ValueError:
        return None
