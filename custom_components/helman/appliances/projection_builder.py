from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
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
from .climate_appliance import ClimateApplianceRuntime
from .ev_charger import (
    EvChargerApplianceRuntime,
    EvChargerUseModeRuntime,
    EvVehicleRuntime,
)
from .generic_appliance import GenericApplianceRuntime
from .state import AppliancesRuntimeRegistry

_CANONICAL_SLOT_DURATION = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
_CANONICAL_SLOT_HOURS = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
_UNAVAILABLE_STATES = {"unknown", "unavailable", "none"}


@dataclass(frozen=True)
class ApplianceDemandPoint:
    """One appliance's demand in one canonical slot.

    ``energy_kwh`` is what the optimizer plans against: the slot containing
    ``now`` carries only the energy still to come, because that is all that can
    still be scheduled. ``scheduled_energy_kwh`` is the same computation with the
    clock taken out — what the whole slot was scheduled to draw — so a reader
    comparing a slot against a whole-slot forecast gets a figure that does not
    shrink as the slot ages. They differ only in the slot containing ``now``.
    """

    appliance_id: str
    slot_id: str
    energy_kwh: float
    scheduled_energy_kwh: float


@dataclass(frozen=True)
class ApplianceProjectionPlanPoint:
    slot_id: str
    energy_kwh: float
    mode: str | None = None
    vehicle_id: str | None = None
    projection_method: str | None = None


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


@dataclass(frozen=True)
class WhenActiveDemandProfile:
    hourly_energy_kwh: float
    projection_method: str


@dataclass(frozen=True)
class WhenActiveDemandSlice:
    bucket_start: datetime
    duration_hours: float
    energy_kwh: float


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
    house_series_by_slot = _build_house_series_map(house_forecast)
    current_house_kwh = _read_current_slot_house_value(
        house_forecast=house_forecast,
        current_slot_start=current_slot_start,
        house_series_by_slot=house_series_by_slot,
    )
    if current_house_kwh is None:
        return None

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
    inputs: ProjectionInputBundle | None,
    hass,
    reference_time: datetime | None = None,
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float | None] | None = None,
    vehicle_remaining_capacity_kwh_by_vehicle_id: Mapping[str, float | None] | None = None,
) -> ApplianceProjectionPlan:
    appliances_by_id: dict[str, ApplianceProjectionSeries] = {}
    demand_points: list[ApplianceDemandPoint] = []
    historical_hourly_energy_by_appliance_id = (
        {}
        if when_active_hourly_energy_kwh_by_appliance_id is None
        else when_active_hourly_energy_kwh_by_appliance_id
    )
    active_reference_time = (
        inputs.reference_time
        if inputs is not None
        else None if reference_time is None else dt_util.as_local(reference_time)
    )

    # EV chargers follow the solar surplus, which is what is left over after
    # every other appliance scheduled in the same slot has taken its share.
    # Project the fixed-demand appliances first, then feed their per-slot demand
    # into the EV pass so the surplus it chases is the true grid surplus.
    deferred_ev_appliances: list[EvChargerApplianceRuntime] = []

    for appliance in registry.appliances:
        if isinstance(appliance, EvChargerApplianceRuntime):
            deferred_ev_appliances.append(appliance)
            continue
        elif isinstance(appliance, ClimateApplianceRuntime):
            if active_reference_time is None:
                raise ValueError(
                    "reference_time is required when projecting climate appliances "
                    "without forecast inputs"
                )
            result = _build_climate_appliance_projection_series(
                appliance=appliance,
                schedule_document=schedule_document,
                reference_time=active_reference_time,
                historical_hourly_energy_kwh=historical_hourly_energy_by_appliance_id.get(
                    appliance.id
                ),
            )
        elif isinstance(appliance, GenericApplianceRuntime):
            if active_reference_time is None:
                raise ValueError(
                    "reference_time is required when projecting generic appliances "
                    "without forecast inputs"
                )
            result = _build_generic_appliance_projection_series(
                appliance=appliance,
                schedule_document=schedule_document,
                reference_time=active_reference_time,
                historical_hourly_energy_kwh=historical_hourly_energy_by_appliance_id.get(
                    appliance.id
                ),
            )
        else:
            continue
        series = result.series
        if not series.points:
            continue
        appliances_by_id[appliance.id] = series
        demand_points.extend(result.demand_points)

    concurrent_demand_kwh_by_slot_id = _aggregate_demand_kwh_by_slot_id(demand_points)
    concurrent_scheduled_demand_kwh_by_slot_id = _aggregate_demand_kwh_by_slot_id(
        demand_points, scheduled=True
    )

    for appliance in deferred_ev_appliances:
        if inputs is None:
            continue
        result = _build_ev_charger_projection_series(
            appliance=appliance,
            schedule_document=schedule_document,
            inputs=inputs,
            hass=hass,
            concurrent_demand_kwh_by_slot_id=concurrent_demand_kwh_by_slot_id,
            concurrent_scheduled_demand_kwh_by_slot_id=(
                concurrent_scheduled_demand_kwh_by_slot_id
            ),
            vehicle_remaining_capacity_kwh_by_vehicle_id=(
                vehicle_remaining_capacity_kwh_by_vehicle_id
            ),
        )
        series = result.series
        if not series.points:
            continue
        appliances_by_id[appliance.id] = series
        demand_points.extend(result.demand_points)

    return ApplianceProjectionPlan(
        generated_at=generated_at,
        appliances_by_id=appliances_by_id,
        demand_points=tuple(demand_points),
    )


@dataclass(frozen=True)
class _ProjectionTimeSlice:
    slot_start: datetime
    duration_hours: float


@dataclass(frozen=True)
class _ProjectionSlotSlice(_ProjectionTimeSlice):
    solar_kwh: float
    baseline_house_kwh: float


@dataclass(frozen=True)
class _ApplianceProjectionBuildResult:
    series: ApplianceProjectionSeries
    demand_points: tuple[ApplianceDemandPoint, ...]


def _build_ev_charger_projection_series(
    *,
    appliance: EvChargerApplianceRuntime,
    schedule_document: ScheduleDocument,
    inputs: ProjectionInputBundle,
    hass,
    concurrent_demand_kwh_by_slot_id: Mapping[str, float] | None = None,
    concurrent_scheduled_demand_kwh_by_slot_id: Mapping[str, float] | None = None,
    vehicle_remaining_capacity_kwh_by_vehicle_id: Mapping[str, float | None] | None = None,
) -> _ApplianceProjectionBuildResult:
    points: list[ApplianceProjectionPlanPoint] = []
    demand_points: list[ApplianceDemandPoint] = []
    vehicle_charged_kwh: dict[str, float] = {}
    vehicle_remaining_kwh: dict[str, float | None] = {}
    concurrent_demand_kwh = concurrent_demand_kwh_by_slot_id or {}
    concurrent_scheduled_demand_kwh = (
        concurrent_scheduled_demand_kwh_by_slot_id
        if concurrent_scheduled_demand_kwh_by_slot_id is not None
        else concurrent_demand_kwh
    )

    for slot_id, actions in sorted(schedule_document.slots.items()):
        action = actions.get(appliance.id)
        if not action or action.get("charge") is not True:
            continue

        vehicle_id = action.get("vehicleId")
        if not isinstance(vehicle_id, str):
            continue
        vehicle = appliance.get_vehicle(vehicle_id)
        if vehicle is None:
            continue

        mode = action.get("useMode")
        if not isinstance(mode, str):
            continue
        use_mode = appliance.get_use_mode(mode)
        if use_mode is None:
            continue

        if vehicle.id not in vehicle_remaining_kwh:
            if (
                vehicle_remaining_capacity_kwh_by_vehicle_id is not None
                and vehicle.id in vehicle_remaining_capacity_kwh_by_vehicle_id
            ):
                vehicle_remaining_kwh[vehicle.id] = (
                    vehicle_remaining_capacity_kwh_by_vehicle_id[vehicle.id]
                )
            else:
                vehicle_remaining_kwh[vehicle.id] = (
                    _read_vehicle_remaining_capacity_kwh(hass=hass, vehicle=vehicle)
                )

        remaining = vehicle_remaining_kwh[vehicle.id]
        charged_so_far = vehicle_charged_kwh.get(vehicle.id, 0.0)
        if remaining is not None:
            capacity_left = max(0.0, remaining - charged_so_far)
            if capacity_left <= 0:
                continue
        else:
            capacity_left = None

        slot_slices = _build_schedule_slot_slices(slot_id=slot_id, inputs=inputs)
        if slot_slices is None or not slot_slices:
            continue

        slice_energy_kwhs = _build_slice_energies(
            appliance=appliance,
            vehicle=vehicle,
            action=action,
            use_mode=use_mode,
            slot_slices=slot_slices,
            concurrent_demand_kwh_by_slot_id=concurrent_demand_kwh,
            capacity_left=capacity_left,
        )

        # The whole-slot figure for the one canonical slot the clock cuts short:
        # the same computation with `now` moved back to that slot's own start, and
        # against the unclipped concurrent demand so both passes agree about the
        # surplus an ECO gear chases. Every other slot in this schedule slot is
        # untouched by the clip, so its two figures are the same number — only the
        # first slice is recomputed, and it is capped against the same capacity the
        # clipped pass had on entering the slot.
        scheduled_energy_by_slot_id: dict[str, float] = {}
        if slot_slices[0].slot_start == inputs.current_slot_start:
            unclipped_slices = _build_schedule_slot_slices(
                slot_id=slot_id,
                inputs=inputs,
                reference_time=inputs.current_slot_start,
            )
            if unclipped_slices:
                scheduled_energy_by_slot_id = {
                    format_slot_id(inputs.current_slot_start): _build_slice_energies(
                        appliance=appliance,
                        vehicle=vehicle,
                        action=action,
                        use_mode=use_mode,
                        slot_slices=unclipped_slices[:1],
                        concurrent_demand_kwh_by_slot_id=concurrent_scheduled_demand_kwh,
                        capacity_left=capacity_left,
                    )[0]
                }

        energy_kwh = sum(slice_energy_kwhs)
        if energy_kwh <= 0:
            continue

        vehicle_charged_kwh[vehicle.id] = charged_so_far + energy_kwh

        points.append(
            ApplianceProjectionPlanPoint(
                slot_id=slot_id,
                energy_kwh=round(energy_kwh, 4),
                mode=mode,
                vehicle_id=vehicle.id,
            )
        )
        demand_points.extend(
            ApplianceDemandPoint(
                appliance_id=appliance.id,
                slot_id=format_slot_id(slot_slice.slot_start),
                energy_kwh=round(slice_energy_kwh, 4),
                scheduled_energy_kwh=round(
                    scheduled_energy_by_slot_id.get(
                        format_slot_id(slot_slice.slot_start), slice_energy_kwh
                    ),
                    4,
                ),
            )
            for slot_slice, slice_energy_kwh in zip(
                slot_slices,
                slice_energy_kwhs,
                strict=True,
            )
            if slice_energy_kwh > 0
        )

    return _ApplianceProjectionBuildResult(
        series=ApplianceProjectionSeries(
            appliance_id=appliance.id,
            points=tuple(points),
        ),
        demand_points=tuple(demand_points),
    )


def _build_generic_appliance_projection_series(
    *,
    appliance: GenericApplianceRuntime,
    schedule_document: ScheduleDocument,
    reference_time: datetime,
    historical_hourly_energy_kwh: float | None,
) -> _ApplianceProjectionBuildResult:
    demand_profile = get_when_active_demand_profile(
        appliance=appliance,
        historical_hourly_energy_kwh=historical_hourly_energy_kwh,
    )
    return _build_constant_hourly_projection_series(
        appliance_id=appliance.id,
        schedule_document=schedule_document,
        reference_time=reference_time,
        demand_profile=demand_profile,
        resolve_action_projection=_resolve_generic_action_projection,
    )


def _build_climate_appliance_projection_series(
    *,
    appliance: ClimateApplianceRuntime,
    schedule_document: ScheduleDocument,
    reference_time: datetime,
    historical_hourly_energy_kwh: float | None,
) -> _ApplianceProjectionBuildResult:
    demand_profile = get_when_active_demand_profile(
        appliance=appliance,
        historical_hourly_energy_kwh=historical_hourly_energy_kwh,
    )
    return _build_constant_hourly_projection_series(
        appliance_id=appliance.id,
        schedule_document=schedule_document,
        reference_time=reference_time,
        demand_profile=demand_profile,
        resolve_action_projection=lambda action: _resolve_climate_action_projection(
            action,
            appliance=appliance,
        ),
    )


def _resolve_projected_hourly_energy_kwh(
    *,
    projection_strategy: str,
    hourly_energy_kwh: float,
    historical_hourly_energy_kwh: float | None,
) -> tuple[float, str]:
    if projection_strategy != "history_average":
        return hourly_energy_kwh, "fixed"
    if (
        historical_hourly_energy_kwh is None
        or historical_hourly_energy_kwh <= 0
    ):
        return hourly_energy_kwh, "fixed_fallback"
    return historical_hourly_energy_kwh, "history_average"


def get_when_active_demand_profile(
    *,
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime,
    historical_hourly_energy_kwh: float | None = None,
    resolved_hourly_energy_kwh: float | None = None,
) -> WhenActiveDemandProfile | None:
    if resolved_hourly_energy_kwh is not None:
        if resolved_hourly_energy_kwh <= 0:
            return None
        return WhenActiveDemandProfile(
            hourly_energy_kwh=resolved_hourly_energy_kwh,
            projection_method="resolved_input",
        )

    resolved_hourly_energy_kwh, projection_method = (
        _resolve_projected_hourly_energy_kwh(
            projection_strategy=appliance.projection_strategy,
            hourly_energy_kwh=appliance.hourly_energy_kwh,
            historical_hourly_energy_kwh=historical_hourly_energy_kwh,
        )
    )
    if resolved_hourly_energy_kwh <= 0:
        return None
    return WhenActiveDemandProfile(
        hourly_energy_kwh=resolved_hourly_energy_kwh,
        projection_method=projection_method,
    )


def build_when_active_demand_slices(
    *,
    slot_id: str,
    reference_time: datetime,
    hourly_energy_kwh: float,
) -> tuple[WhenActiveDemandSlice, ...]:
    if hourly_energy_kwh <= 0:
        return ()
    return tuple(
        WhenActiveDemandSlice(
            bucket_start=time_slice.slot_start,
            duration_hours=time_slice.duration_hours,
            energy_kwh=round(hourly_energy_kwh * time_slice.duration_hours, 4),
        )
        for time_slice in _build_time_slices(
            slot_id=slot_id,
            reference_time=reference_time,
        )
        if hourly_energy_kwh * time_slice.duration_hours > 0
    )


def _build_constant_hourly_projection_series(
    *,
    appliance_id: str,
    schedule_document: ScheduleDocument,
    reference_time: datetime,
    demand_profile: WhenActiveDemandProfile | None,
    resolve_action_projection: Callable[
        [Mapping[str, object]], tuple[bool, str | None]
    ],
) -> _ApplianceProjectionBuildResult:
    points: list[ApplianceProjectionPlanPoint] = []
    demand_points: list[ApplianceDemandPoint] = []

    for slot_id, actions in sorted(schedule_document.slots.items()):
        action = actions.get(appliance_id)
        if not isinstance(action, Mapping):
            continue

        is_active, mode = resolve_action_projection(action)
        if not is_active:
            continue

        if demand_profile is None:
            continue

        demand_slices = build_when_active_demand_slices(
            slot_id=slot_id,
            reference_time=reference_time,
            hourly_energy_kwh=demand_profile.hourly_energy_kwh,
        )
        if not demand_slices:
            continue

        energy_kwh = sum(demand_slice.energy_kwh for demand_slice in demand_slices)
        if energy_kwh <= 0:
            continue

        # The whole-slot figures: the same slices built with `now` moved back to
        # the start of the canonical slot it falls in, so the clock cannot shorten
        # the one slice it cuts through. Every other slice is unaffected and comes
        # out identical to the clipped pass.
        scheduled_energy_by_bucket = {
            demand_slice.bucket_start: demand_slice.energy_kwh
            for demand_slice in build_when_active_demand_slices(
                slot_id=slot_id,
                reference_time=_canonical_slot_start(reference_time),
                hourly_energy_kwh=demand_profile.hourly_energy_kwh,
            )
        }

        points.append(
            ApplianceProjectionPlanPoint(
                slot_id=slot_id,
                energy_kwh=round(energy_kwh, 4),
                mode=mode,
                projection_method=demand_profile.projection_method,
            )
        )
        demand_points.extend(
            ApplianceDemandPoint(
                appliance_id=appliance_id,
                slot_id=format_slot_id(demand_slice.bucket_start),
                energy_kwh=demand_slice.energy_kwh,
                scheduled_energy_kwh=scheduled_energy_by_bucket.get(
                    demand_slice.bucket_start, demand_slice.energy_kwh
                ),
            )
            for demand_slice in demand_slices
        )

    return _ApplianceProjectionBuildResult(
        series=ApplianceProjectionSeries(
            appliance_id=appliance_id,
            points=tuple(points),
        ),
        demand_points=tuple(demand_points),
    )


def _resolve_generic_action_projection(
    action: Mapping[str, object],
) -> tuple[bool, str | None]:
    return action.get("on") is True, None


def _resolve_climate_action_projection(
    action: Mapping[str, object],
    *,
    appliance: ClimateApplianceRuntime,
) -> tuple[bool, str | None]:
    mode = action.get("mode")
    if not isinstance(mode, str):
        return False, None
    if mode == appliance.stop_hvac_mode:
        return False, None
    if mode in appliance.authorable_modes:
        return True, mode
    return False, None


def _canonical_slot_start(reference_time: datetime) -> datetime:
    """The start of the canonical slot ``reference_time`` falls in.

    The clip only ever cuts through this one slot: everything before it has
    elapsed and everything after it is whole, so this is the reference that takes
    the clock out of the projection without inventing energy for a slot that has
    already gone.
    """
    return get_local_current_slot_start(
        dt_util.as_local(reference_time),
        interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
    )


def _build_schedule_slot_slices(
    *,
    slot_id: str,
    inputs: ProjectionInputBundle,
    reference_time: datetime | None = None,
) -> list[_ProjectionSlotSlice] | None:
    slices: list[_ProjectionSlotSlice] = []
    for time_slice in _build_time_slices(
        slot_id=slot_id,
        reference_time=inputs.reference_time if reference_time is None else reference_time,
    ):
        baseline_house_kwh = (
            inputs.current_house_kwh
            if time_slice.slot_start == inputs.current_slot_start
            else inputs.house_series_by_slot.get(time_slice.slot_start)
        )
        solar_wh = inputs.solar_by_slot_wh.get(time_slice.slot_start)
        if baseline_house_kwh is None or solar_wh is None:
            return None

        scale = time_slice.duration_hours / _CANONICAL_SLOT_HOURS
        slices.append(
            _ProjectionSlotSlice(
                slot_start=time_slice.slot_start,
                duration_hours=time_slice.duration_hours,
                solar_kwh=(solar_wh / 1000) * scale,
                baseline_house_kwh=baseline_house_kwh * scale,
            )
        )

    return slices


def _build_time_slices(
    *,
    slot_id: str,
    reference_time: datetime,
) -> list[_ProjectionTimeSlice]:
    slot_start = parse_slot_id(slot_id)
    slot_end = slot_start + SCHEDULE_SLOT_DURATION
    local_reference_time = dt_util.as_local(reference_time)
    if slot_end <= local_reference_time:
        return []

    slices: list[_ProjectionTimeSlice] = []
    cursor = slot_start
    while cursor < slot_end:
        slice_end = min(cursor + _CANONICAL_SLOT_DURATION, slot_end)
        if slice_end <= local_reference_time:
            cursor = slice_end
            continue

        effective_start = max(cursor, local_reference_time)
        duration_hours = (slice_end - effective_start).total_seconds() / 3600
        if duration_hours > 0:
            slices.append(
                _ProjectionTimeSlice(
                    slot_start=cursor,
                    duration_hours=duration_hours,
                )
            )
        cursor = slice_end

    return slices


def _calculate_slot_slice_energy(
    *,
    appliance: EvChargerApplianceRuntime,
    vehicle: EvVehicleRuntime,
    action: dict[str, Any],
    use_mode: EvChargerUseModeRuntime,
    slot_slice: _ProjectionSlotSlice,
    concurrent_demand_kwh: float = 0.0,
) -> float:
    effective_max_power_kw = min(
        appliance.max_charging_power_kw,
        vehicle.max_charging_power_kw,
    )
    if use_mode.behavior == "fixed_max_power":
        return effective_max_power_kw * slot_slice.duration_hours

    eco_gear = action.get("ecoGear")
    if not isinstance(eco_gear, str):
        return 0.0
    eco_min_power_kw = appliance.eco_gear_min_power_kw_by_id.get(eco_gear)
    if eco_min_power_kw is None:
        return 0.0

    # The surplus the charger follows is what solar leaves after the base house
    # load and every other appliance scheduled in this slot. The ECO gear still
    # floors the draw, so a surplus below the floor is topped up from battery/grid.
    available_surplus_kwh = (
        slot_slice.solar_kwh - slot_slice.baseline_house_kwh - concurrent_demand_kwh
    )
    return min(
        effective_max_power_kw * slot_slice.duration_hours,
        max(
            available_surplus_kwh,
            eco_min_power_kw * slot_slice.duration_hours,
        ),
    )


def _build_slice_energies(
    *,
    appliance: EvChargerApplianceRuntime,
    vehicle: EvVehicleRuntime,
    action: dict[str, Any],
    use_mode: EvChargerUseModeRuntime,
    slot_slices: Iterable[_ProjectionSlotSlice],
    concurrent_demand_kwh_by_slot_id: Mapping[str, float],
    capacity_left: float | None,
) -> tuple[float, ...]:
    raw_slice_energies = tuple(
        _calculate_slot_slice_energy(
            appliance=appliance,
            vehicle=vehicle,
            action=action,
            use_mode=use_mode,
            slot_slice=slot_slice,
            concurrent_demand_kwh=concurrent_demand_kwh_by_slot_id.get(
                format_slot_id(slot_slice.slot_start), 0.0
            ),
        )
        for slot_slice in slot_slices
    )
    if capacity_left is None:
        return raw_slice_energies
    return _cap_slice_energies(raw_slice_energies, capacity_left)


def _aggregate_demand_kwh_by_slot_id(
    demand_points: Iterable[ApplianceDemandPoint],
    *,
    scheduled: bool = False,
) -> dict[str, float]:
    totals: dict[str, float] = {}
    for point in demand_points:
        energy_kwh = point.scheduled_energy_kwh if scheduled else point.energy_kwh
        totals[point.slot_id] = round(totals.get(point.slot_id, 0.0) + energy_kwh, 4)
    return totals


def _cap_slice_energies(
    slice_energies: tuple[float, ...], capacity: float
) -> tuple[float, ...]:
    capped: list[float] = []
    remaining = capacity
    for energy in slice_energies:
        capped_energy = min(energy, max(0.0, remaining))
        capped.append(capped_energy)
        remaining -= capped_energy
    return tuple(capped)


def _read_vehicle_remaining_capacity_kwh(
    *,
    hass,
    vehicle: EvVehicleRuntime,
) -> float | None:
    if hass is None:
        return None
    current_soc = _read_entity_float(hass, vehicle.soc_entity_id)
    if current_soc is None:
        return None
    if vehicle.charge_limit_entity_id is not None:
        target_soc = _read_entity_float(hass, vehicle.charge_limit_entity_id)
        if target_soc is None:
            return None
    else:
        target_soc = 100.0
    pct_remaining = max(0.0, target_soc - current_soc)
    return (pct_remaining / 100.0) * vehicle.battery_capacity_kwh


def read_vehicle_remaining_capacity_kwh_by_vehicle_id(
    hass, registry: AppliancesRuntimeRegistry
) -> dict[str, float | None]:
    """Precompute each EV vehicle's remaining charge capacity from ``hass.states``.

    Reads the live SoC / charge-limit entities once on the event loop so the
    projection compute path can run pure (see ``build_appliance_projection_plan``'s
    ``vehicle_remaining_capacity_kwh_by_vehicle_id`` parameter).
    """
    remaining_by_vehicle_id: dict[str, float | None] = {}
    for appliance in registry.appliances:
        if not isinstance(appliance, EvChargerApplianceRuntime):
            continue
        for vehicle in appliance.vehicles:
            remaining_by_vehicle_id[vehicle.id] = _read_vehicle_remaining_capacity_kwh(
                hass=hass, vehicle=vehicle
            )
    return remaining_by_vehicle_id


def _read_entity_float(hass, entity_id: str) -> float | None:
    state = hass.states.get(entity_id)
    if state is None:
        return None
    raw = getattr(state, "state", None)
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if not isinstance(raw, str):
        return None
    stripped = raw.strip()
    if not stripped or stripped.lower() in _UNAVAILABLE_STATES:
        return None
    try:
        return float(stripped)
    except ValueError:
        return None


def _read_current_slot_house_value(
    *,
    house_forecast: dict[str, Any],
    current_slot_start: datetime,
    house_series_by_slot: dict[datetime, float],
) -> float | None:
    """The house demand for the slot the projection starts in.

    The same anchor rule the battery builder's namesake follows, for the same
    reason: the house payload is anchored on the *house build's* own slot, and a
    projection one slot past that anchor finds its slot in the ``series`` rather
    than in ``currentSlot``. Refusing it there returned no input bundle at all,
    which drops the scheduled appliance demand out of the adjusted house
    forecast rather than failing loudly. See #204.
    """
    current_slot = house_forecast.get("currentSlot")
    if isinstance(current_slot, dict):
        timestamp = _parse_timestamp(current_slot.get("timestamp"))
        if timestamp is not None and dt_util.as_local(timestamp) == current_slot_start:
            value = _read_house_entry_value(current_slot)
            if value is not None:
                return value

    return house_series_by_slot.get(current_slot_start)


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
    points = solar_forecast.get("adjustedPoints")
    if not isinstance(points, list):
        points = solar_forecast.get("correctedPoints")
    if not isinstance(points, list):
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
