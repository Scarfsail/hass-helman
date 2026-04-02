from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from ..recorder_hourly_series import get_local_current_slot_start
from ..scheduling.schedule import (
    SCHEDULE_SLOT_DURATION,
    ScheduleDocument,
    format_slot_id,
    parse_slot_id,
)
from .ev_charger import EvChargerApplianceRuntime, EvVehicleRuntime
from .state import AppliancesRuntimeRegistry

_CANONICAL_SLOT_DURATION = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
_CANONICAL_SLOT_HOURS = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
_UNAVAILABLE_STATES = {"unknown", "unavailable", "none"}


@dataclass(frozen=True)
class ApplianceDemandPoint:
    appliance_id: str
    slot_id: str
    energy_kwh: float


@dataclass(frozen=True)
class ApplianceProjectionPlanPoint:
    slot_id: str
    energy_kwh: float
    mode: str
    vehicle_id: str | None


@dataclass(frozen=True)
class ApplianceProjectionSeries:
    appliance_id: str
    points: tuple[ApplianceProjectionPlanPoint, ...]


@dataclass(frozen=True)
class ApplianceProjectionPlan:
    generated_at: str
    appliances_by_id: dict[str, ApplianceProjectionSeries]
    demand_points: tuple[ApplianceDemandPoint, ...]


@dataclass(frozen=True)
class ProjectionInputBundle:
    current_slot_start: datetime
    reference_time: datetime
    current_house_kwh: float
    house_series_by_slot: dict[datetime, float]
    solar_by_slot_wh: dict[datetime, float]


def build_projection_input_bundle(
    *,
    solar_forecast: dict[str, Any],
    house_forecast: dict[str, Any],
    reference_time: datetime,
) -> ProjectionInputBundle | None:
    if (
        solar_forecast.get("status") != "available"
        or house_forecast.get("status") != "available"
    ):
        return None

    local_reference = dt_util.as_local(reference_time)
    current_slot_start = get_local_current_slot_start(
        local_reference,
        interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
    )
    current_house_kwh = _read_current_slot_house_value(
        house_forecast=house_forecast,
        current_slot_start=current_slot_start,
    )
    if current_house_kwh is None:
        return None

    house_series_by_slot = _build_house_series_map(house_forecast)
    solar_by_slot_wh = _build_solar_slot_map(solar_forecast)
    if not solar_by_slot_wh:
        return None

    return ProjectionInputBundle(
        current_slot_start=current_slot_start,
        reference_time=local_reference,
        current_house_kwh=current_house_kwh,
        house_series_by_slot=house_series_by_slot,
        solar_by_slot_wh=solar_by_slot_wh,
    )


def build_appliance_projection_plan(
    *,
    generated_at: str,
    registry: AppliancesRuntimeRegistry,
    schedule_document: ScheduleDocument,
    inputs: ProjectionInputBundle,
) -> ApplianceProjectionPlan:
    appliances_by_id: dict[str, ApplianceProjectionSeries] = {}
    demand_points: list[ApplianceDemandPoint] = []

    for appliance in registry.appliances:
        series = _build_ev_charger_projection_series(
            appliance=appliance,
            schedule_document=schedule_document,
            inputs=inputs,
        )
        if not series.points:
            continue
        appliances_by_id[appliance.id] = series
        demand_points.extend(
            ApplianceDemandPoint(
                appliance_id=appliance.id,
                slot_id=point.slot_id,
                energy_kwh=point.energy_kwh,
            )
            for point in series.points
        )

    return ApplianceProjectionPlan(
        generated_at=generated_at,
        appliances_by_id=appliances_by_id,
        demand_points=tuple(demand_points),
    )


@dataclass(frozen=True)
class _ProjectionSlotSlice:
    duration_hours: float
    solar_kwh: float
    baseline_house_kwh: float


def _build_ev_charger_projection_series(
    *,
    appliance: EvChargerApplianceRuntime,
    schedule_document: ScheduleDocument,
    inputs: ProjectionInputBundle,
) -> ApplianceProjectionSeries:
    points: list[ApplianceProjectionPlanPoint] = []

    for slot_id, domains in sorted(schedule_document.slots.items()):
        action = domains.appliances.get(appliance.id)
        if not action or action.get("charge") is not True:
            continue

        vehicle_id = action.get("vehicleId")
        if not isinstance(vehicle_id, str):
            continue
        vehicle = appliance.get_vehicle(vehicle_id)
        if vehicle is None:
            continue

        mode = action.get("useMode")
        if mode not in {"Fast", "ECO"}:
            continue

        slot_slices = _build_schedule_slot_slices(slot_id=slot_id, inputs=inputs)
        if slot_slices is None or not slot_slices:
            continue

        energy_kwh = _calculate_slot_energy(
            appliance=appliance,
            vehicle=vehicle,
            action=action,
            slot_slices=slot_slices,
        )
        if energy_kwh <= 0:
            continue

        points.append(
            ApplianceProjectionPlanPoint(
                slot_id=slot_id,
                energy_kwh=round(energy_kwh, 4),
                mode=mode,
                vehicle_id=vehicle.id,
            )
        )

    return ApplianceProjectionSeries(
        appliance_id=appliance.id,
        points=tuple(points),
    )


def _build_schedule_slot_slices(
    *,
    slot_id: str,
    inputs: ProjectionInputBundle,
) -> list[_ProjectionSlotSlice] | None:
    slot_start = parse_slot_id(slot_id)
    slot_end = slot_start + SCHEDULE_SLOT_DURATION
    if slot_end <= inputs.reference_time:
        return []

    slices: list[_ProjectionSlotSlice] = []
    cursor = slot_start
    while cursor < slot_end:
        slice_end = min(cursor + _CANONICAL_SLOT_DURATION, slot_end)
        if slice_end <= inputs.reference_time:
            cursor = slice_end
            continue

        effective_start = max(cursor, inputs.reference_time)
        duration_hours = (slice_end - effective_start).total_seconds() / 3600
        if duration_hours <= 0:
            cursor = slice_end
            continue

        baseline_house_kwh = (
            inputs.current_house_kwh
            if cursor == inputs.current_slot_start
            else inputs.house_series_by_slot.get(cursor)
        )
        solar_wh = inputs.solar_by_slot_wh.get(cursor)
        if baseline_house_kwh is None or solar_wh is None:
            return None

        scale = duration_hours / _CANONICAL_SLOT_HOURS
        slices.append(
            _ProjectionSlotSlice(
                duration_hours=duration_hours,
                solar_kwh=(solar_wh / 1000) * scale,
                baseline_house_kwh=baseline_house_kwh * scale,
            )
        )
        cursor = slice_end

    return slices


def _calculate_slot_energy(
    *,
    appliance: EvChargerApplianceRuntime,
    vehicle: EvVehicleRuntime,
    action: dict[str, Any],
    slot_slices: list[_ProjectionSlotSlice],
) -> float:
    effective_max_power_kw = min(
        appliance.max_charging_power_kw,
        vehicle.max_charging_power_kw,
    )
    mode = action["useMode"]
    total_energy_kwh = 0.0

    for slot_slice in slot_slices:
        if mode == "Fast":
            slice_energy_kwh = effective_max_power_kw * slot_slice.duration_hours
        else:
            eco_gear = action.get("ecoGear")
            if not isinstance(eco_gear, str):
                continue
            eco_min_power_kw = appliance.eco_gear_min_power_kw_by_id.get(eco_gear)
            if eco_min_power_kw is None:
                continue

            slice_energy_kwh = min(
                effective_max_power_kw * slot_slice.duration_hours,
                max(
                    slot_slice.solar_kwh - slot_slice.baseline_house_kwh,
                    eco_min_power_kw * slot_slice.duration_hours,
                ),
            )

        total_energy_kwh += slice_energy_kwh

    return total_energy_kwh


def _read_current_slot_house_value(
    *,
    house_forecast: dict[str, Any],
    current_slot_start: datetime,
) -> float | None:
    current_slot = house_forecast.get("currentSlot")
    if not isinstance(current_slot, dict):
        return None

    timestamp = _parse_timestamp(current_slot.get("timestamp"))
    if timestamp is None or dt_util.as_local(timestamp) != current_slot_start:
        return None
    return _read_house_entry_value(current_slot)


def _build_house_series_map(house_forecast: dict[str, Any]) -> dict[datetime, float]:
    series = house_forecast.get("series")
    if not isinstance(series, list):
        return {}

    by_slot: dict[datetime, float] = {}
    for entry in series:
        if not isinstance(entry, dict):
            continue
        timestamp = _parse_timestamp(entry.get("timestamp"))
        value = _read_house_entry_value(entry)
        if timestamp is None or value is None:
            continue
        by_slot[dt_util.as_local(timestamp)] = value
    return by_slot


def _build_solar_slot_map(solar_forecast: dict[str, Any]) -> dict[datetime, float]:
    points = solar_forecast.get("points")
    if not isinstance(points, list):
        return {}

    parsed_points: list[tuple[datetime, float]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        value = _read_float(point.get("value"))
        if timestamp is None or value is None:
            continue
        parsed_points.append((dt_util.as_local(timestamp), value))

    if not parsed_points:
        return {}

    parsed_points.sort(key=lambda item: dt_util.as_utc(item[0]))
    split_factor = _get_solar_point_split_factor(parsed_points)
    divisor = split_factor if split_factor > 0 else 1
    by_slot: dict[datetime, float] = {}

    for slot_start, value in parsed_points:
        slot_value = value / divisor
        for split_index in range(divisor):
            expanded_slot_start = _advance_canonical_slots(slot_start, slot_count=split_index)
            by_slot[expanded_slot_start] = by_slot.get(expanded_slot_start, 0.0) + slot_value

    return by_slot


def _read_house_entry_value(entry: dict[str, Any]) -> float | None:
    non_deferrable = entry.get("nonDeferrable")
    if not isinstance(non_deferrable, dict):
        return None
    return _read_float(non_deferrable.get("value"))


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)


def _read_float(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)
    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped or stripped.lower() in _UNAVAILABLE_STATES:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _get_solar_point_split_factor(points: list[tuple[datetime, float]]) -> int:
    if len(points) < 2:
        return 1

    candidate_intervals: list[int] = []
    for index in range(1, len(points)):
        delta_seconds = (
            dt_util.as_utc(points[index][0]) - dt_util.as_utc(points[index - 1][0])
        ).total_seconds()
        if delta_seconds <= 0:
            continue
        candidate_intervals.append(int(round(delta_seconds / 60)))

    if not candidate_intervals:
        return 1

    interval_minutes = min(candidate_intervals)
    if interval_minutes < FORECAST_CANONICAL_GRANULARITY_MINUTES:
        return 1
    if interval_minutes % FORECAST_CANONICAL_GRANULARITY_MINUTES != 0:
        return 1
    return interval_minutes // FORECAST_CANONICAL_GRANULARITY_MINUTES


def _advance_canonical_slots(value: datetime, *, slot_count: int) -> datetime:
    return dt_util.as_local(
        dt_util.as_utc(value) + (_CANONICAL_SLOT_DURATION * slot_count)
    )
