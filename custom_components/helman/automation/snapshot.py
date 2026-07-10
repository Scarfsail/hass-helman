from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from ..appliances import AppliancesRuntimeRegistry, build_appliances_response
from ..forecast_series_fields import (
    BATTERY_PUBLIC_SERIES_FIELDS,
    project_series_fields,
)
from ..scheduling.schedule import (
    ScheduleDocument,
    materialize_schedule_slots,
    schedule_document_to_dict,
    slot_to_dict,
)

if TYPE_CHECKING:
    from ..battery_state import BatteryLiveState
    from .day_context import DayContext


@dataclass(frozen=True)
class OptimizationContext:
    now: datetime
    battery_state: BatteryLiveState | None
    solar_forecast: dict[str, Any]
    import_price_forecast: dict[str, Any]
    export_price_forecast: dict[str, Any]
    appliance_registry: AppliancesRuntimeRegistry
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float]
    # A1 — battery parameters surfaced from the battery config/live state so
    # single-pass rules (charge_hold) can size charge energy without touching
    # the forecast builder. Static per run.
    battery_max_charge_power_kw: float | None = None
    battery_usable_capacity_kwh: float | None = None
    battery_charge_efficiency: float | None = None
    # A2 — framework-resolved runtime hours per appliance per local calendar day
    # (recorder-derived). Rules read this synchronously.
    runtime_hours_by_appliance_id_by_local_date: dict[str, dict[date, float]] = field(
        default_factory=dict
    )
    # A3/A4 — frozen per-calendar-day context, keyed by local date. Attached by
    # the coordinator once per run. Read-only for optimizers.
    day_contexts: dict[date, "DayContext"] = field(default_factory=dict)


@dataclass(frozen=True)
class OptimizationSnapshot:
    schedule: ScheduleDocument
    adjusted_house_forecast: dict[str, Any]
    battery_forecast: dict[str, Any]
    grid_forecast: dict[str, Any]
    context: OptimizationContext


def attach_day_contexts(
    snapshot: OptimizationSnapshot,
    day_contexts: dict[date, "DayContext"],
) -> OptimizationSnapshot:
    """Return a copy of ``snapshot`` with day contexts on its context."""
    return replace(
        snapshot,
        context=replace(snapshot.context, day_contexts=day_contexts),
    )


def snapshot_to_dict(snapshot: OptimizationSnapshot) -> dict[str, Any]:
    return {
        "scheduleDocument": schedule_document_to_dict(snapshot.schedule),
        "scheduleSlots": [
            slot_to_dict(slot)
            for slot in materialize_schedule_slots(
                stored_slots=snapshot.schedule.slots,
                reference_time=snapshot.context.now,
            )
        ],
        "adjustedHouseForecast": deepcopy(snapshot.adjusted_house_forecast),
        "batteryForecast": _serialize_battery_forecast(snapshot.battery_forecast),
        "gridForecast": deepcopy(snapshot.grid_forecast),
        "context": {
            "now": snapshot.context.now.isoformat(),
            "batteryState": _battery_state_to_dict(snapshot.context.battery_state),
            "solarForecast": deepcopy(snapshot.context.solar_forecast),
            "importPriceForecast": deepcopy(snapshot.context.import_price_forecast),
            "exportPriceForecast": deepcopy(snapshot.context.export_price_forecast),
            "applianceRegistry": build_appliances_response(
                snapshot.context.appliance_registry
            ),
            "whenActiveHourlyEnergyKwhByApplianceId": deepcopy(
                snapshot.context.when_active_hourly_energy_kwh_by_appliance_id
            ),
            "batteryMaxChargePowerKw": snapshot.context.battery_max_charge_power_kw,
            "batteryUsableCapacityKwh": snapshot.context.battery_usable_capacity_kwh,
            "batteryChargeEfficiency": snapshot.context.battery_charge_efficiency,
            "runtimeHoursByApplianceIdByLocalDate": {
                appliance_id: {
                    local_date.isoformat(): hours
                    for local_date, hours in hours_by_date.items()
                }
                for appliance_id, hours_by_date in (
                    snapshot.context.runtime_hours_by_appliance_id_by_local_date.items()
                )
            },
            "dayContexts": {
                local_date.isoformat(): day_context.to_dict()
                for local_date, day_context in snapshot.context.day_contexts.items()
            },
        },
    }


def _serialize_battery_forecast(battery_forecast: dict[str, Any]) -> dict[str, Any]:
    serialized = deepcopy(battery_forecast)
    for field in ("series", "baselineSeries"):
        if isinstance(serialized.get(field), list):
            serialized[field] = project_series_fields(
                serialized[field],
                BATTERY_PUBLIC_SERIES_FIELDS,
            )
    return serialized


def _battery_state_to_dict(
    battery_state: BatteryLiveState | None,
) -> dict[str, Any] | None:
    if battery_state is None:
        return None
    return {
        "currentRemainingEnergyKwh": battery_state.current_remaining_energy_kwh,
        "currentSoc": battery_state.current_soc,
        "minSoc": battery_state.min_soc,
        "maxSoc": battery_state.max_soc,
        "nominalCapacityKwh": battery_state.nominal_capacity_kwh,
        "minEnergyKwh": battery_state.min_energy_kwh,
        "maxEnergyKwh": battery_state.max_energy_kwh,
    }
