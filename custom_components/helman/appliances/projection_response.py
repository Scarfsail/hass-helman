from __future__ import annotations

from typing import NotRequired, TypedDict

from .ev_charger import EvChargerApplianceRuntime
from .generic_appliance import GenericApplianceRuntime
from .projection_builder import ApplianceProjectionPlan, ApplianceProjectionSeries
from .state import AppliancesRuntimeRegistry


class ApplianceProjectionPointDict(TypedDict):
    slotId: str
    energyKwh: float
    mode: NotRequired[str]
    projectionMethod: NotRequired[str]
    vehicleId: NotRequired[str | None]
    vehicleSoc: NotRequired[int | None]


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

        if isinstance(appliance, EvChargerApplianceRuntime):
            response_points = _build_ev_projection_points(
                series=series,
                appliance=appliance,
                hass=hass,
            )
        elif isinstance(appliance, GenericApplianceRuntime):
            response_points = _build_generic_projection_points(series=series)
        else:
            continue

        if response_points:
            appliances[appliance_id] = {"series": response_points}

    return {
        "generatedAt": plan.generated_at,
        "appliances": appliances,
    }


def _build_ev_projection_points(
    *,
    series: ApplianceProjectionSeries,
    appliance: EvChargerApplianceRuntime,
    hass,
) -> list[ApplianceProjectionPointDict]:
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
                "mode": point.mode if point.mode is not None else "",
                "vehicleId": point.vehicle_id,
                "vehicleSoc": vehicle_soc,
            }
        )

    return response_points


def _build_generic_projection_points(
    *,
    series: ApplianceProjectionSeries,
) -> list[ApplianceProjectionPointDict]:
    response_points: list[ApplianceProjectionPointDict] = []

    for point in series.points:
        response_point: ApplianceProjectionPointDict = {
            "slotId": point.slot_id,
            "energyKwh": point.energy_kwh,
        }
        if point.projection_method is not None:
            response_point["projectionMethod"] = point.projection_method
        response_points.append(response_point)

    return response_points


def _read_vehicle_soc_pct(
    *,
    hass,
    appliance: EvChargerApplianceRuntime,
    vehicle_id: str,
) -> float | None:
    if hass is None:
        return None
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
