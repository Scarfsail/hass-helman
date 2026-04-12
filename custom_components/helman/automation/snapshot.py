from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ..appliances import AppliancesRuntimeRegistry, build_appliances_response
from ..scheduling.schedule import (
    ScheduleDocument,
    materialize_schedule_slots,
    schedule_document_to_dict,
    slot_to_dict,
)

if TYPE_CHECKING:
    from ..battery_state import BatteryLiveState


@dataclass(frozen=True)
class OptimizationContext:
    now: datetime
    battery_state: BatteryLiveState | None
    solar_forecast: dict[str, Any]
    import_price_forecast: dict[str, Any]
    export_price_forecast: dict[str, Any]
    appliance_registry: AppliancesRuntimeRegistry
    when_active_hourly_energy_kwh_by_appliance_id: dict[str, float]


@dataclass(frozen=True)
class OptimizationSnapshot:
    schedule: ScheduleDocument
    adjusted_house_forecast: dict[str, Any]
    battery_forecast: dict[str, Any]
    grid_forecast: dict[str, Any]
    context: OptimizationContext


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
        "batteryForecast": deepcopy(snapshot.battery_forecast),
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
        },
    }


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
