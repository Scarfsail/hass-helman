from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...appliances.climate_appliance import ClimateApplianceRuntime
from ...appliances.generic_appliance import GenericApplianceRuntime
from ...scheduling.schedule import (
    ScheduleDocument,
    ScheduleDomains,
    is_default_domains,
    iter_horizon_slot_ids,
)
from ..ownership import (
    is_user_owned_appliance_action,
    stamp_automation_appliance_action,
)

if TYPE_CHECKING:
    from ...appliances import AppliancesRuntimeRegistry
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot

@dataclass(frozen=True)
class _SurplusApplianceTarget:
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime
    authored_action: dict[str, object]


@dataclass(frozen=True)
class ValidatedSurplusApplianceConfig:
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime
    authored_action: dict[str, object]
    min_surplus_buffer_pct: int


class SurplusApplianceValidationError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


class SurplusApplianceSkip(RuntimeError):
    def __init__(self, appliance_id: str, message: str) -> None:
        super().__init__(message)
        self.appliance_id = appliance_id


@dataclass(frozen=True)
class SurplusApplianceOptimizer:
    id: str
    target: _SurplusApplianceTarget
    min_surplus_buffer_pct: int
    kind: str = "surplus_appliance"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
    ) -> ScheduleDocument:
        from ...appliances.projection_builder import (
            build_when_active_demand_slices,
            get_when_active_demand_profile,
        )

        del config
        updated_schedule_document = ScheduleDocument(
            execution_enabled=snapshot.schedule.execution_enabled,
            slots=deepcopy(snapshot.schedule.slots),
        )
        if (
            self.target.appliance.id
            not in snapshot.context.when_active_hourly_energy_kwh_by_appliance_id
        ):
            raise SurplusApplianceSkip(
                self.target.appliance.id,
                "when-active demand is unavailable",
            )
        demand_profile = get_when_active_demand_profile(
            appliance=self.target.appliance,
            resolved_hourly_energy_kwh=(
                snapshot.context.when_active_hourly_energy_kwh_by_appliance_id[
                    self.target.appliance.id
                ]
            ),
        )
        if demand_profile is None:
            raise SurplusApplianceSkip(
                self.target.appliance.id,
                "when-active demand is unavailable",
            )

        export_surplus_by_bucket_start = _build_export_surplus_by_bucket_start(
            snapshot=snapshot
        )
        if export_surplus_by_bucket_start is None:
            raise SurplusApplianceSkip(
                self.target.appliance.id,
                "forecast surplus inputs are unavailable",
            )

        _clear_automation_owned_target_actions(
            schedule_document=updated_schedule_document,
            appliance_id=self.target.appliance.id,
        )
        buffer_multiplier = 1 + (self.min_surplus_buffer_pct / 100)
        for slot_id in iter_horizon_slot_ids(snapshot.context.now):
            current_domains = updated_schedule_document.slots.get(slot_id, ScheduleDomains())
            if is_user_owned_appliance_action(
                current_domains.appliances.get(self.target.appliance.id)
            ):
                continue

            demand_slices = build_when_active_demand_slices(
                slot_id=slot_id,
                reference_time=snapshot.context.now,
                hourly_energy_kwh=demand_profile.hourly_energy_kwh,
            )
            if not demand_slices:
                continue
            if not _slot_has_sufficient_surplus(
                export_surplus_by_bucket_start=export_surplus_by_bucket_start,
                demand_slices=demand_slices,
                buffer_multiplier=buffer_multiplier,
            ):
                continue

            updated_appliances = dict(current_domains.appliances)
            updated_appliances[self.target.appliance.id] = (
                stamp_automation_appliance_action(self.target.authored_action)
            )
            updated_schedule_document.slots[slot_id] = ScheduleDomains(
                inverter=current_domains.inverter,
                appliances=updated_appliances,
            )

        return updated_schedule_document


def build_surplus_appliance_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: AppliancesRuntimeRegistry,
) -> SurplusApplianceOptimizer:
    validated = validate_surplus_appliance_optimizer_config(
        config,
        appliance_registry=appliance_registry,
    )
    return SurplusApplianceOptimizer(
        id=config.id,
        target=_SurplusApplianceTarget(
            appliance=validated.appliance,
            authored_action=validated.authored_action,
        ),
        min_surplus_buffer_pct=validated.min_surplus_buffer_pct,
    )


def validate_surplus_appliance_optimizer_config(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: AppliancesRuntimeRegistry,
) -> ValidatedSurplusApplianceConfig:
    appliance_id = _read_appliance_id(config)
    appliance = appliance_registry.get_appliance(appliance_id)
    if appliance is None:
        raise SurplusApplianceValidationError(
            "appliance_id",
            f"Optimizer {config.id!r} references unknown appliance_id {appliance_id!r}"
        )

    action = _read_action(config)
    if action != "on":
        raise SurplusApplianceValidationError(
            "action",
            f"Optimizer {config.id!r} uses unsupported surplus_appliance action {action!r}"
        )

    climate_mode = _read_optional_climate_mode(config)
    if isinstance(appliance, GenericApplianceRuntime):
        if climate_mode is not None:
            raise SurplusApplianceValidationError(
                "climate_mode",
                f"Optimizer {config.id!r} cannot set climate_mode for generic appliance "
                f"{appliance.id!r}"
            )
        authored_action = {"on": True}
    elif isinstance(appliance, ClimateApplianceRuntime):
        if climate_mode is None:
            raise SurplusApplianceValidationError(
                "climate_mode",
                f"Optimizer {config.id!r} must set climate_mode for climate appliance "
                f"{appliance.id!r}"
            )
        if climate_mode not in appliance.authorable_modes:
            raise SurplusApplianceValidationError(
                "climate_mode",
                f"Optimizer {config.id!r} climate_mode {climate_mode!r} is not "
                f"supported for appliance {appliance.id!r}"
            )
        authored_action = {"mode": climate_mode}
    else:
        raise SurplusApplianceValidationError(
            "appliance_id",
            f"Optimizer {config.id!r} appliance {appliance.id!r} must be generic or "
            "climate"
        )

    return ValidatedSurplusApplianceConfig(
        appliance=appliance,
        authored_action=authored_action,
        min_surplus_buffer_pct=_read_min_surplus_buffer_pct(config),
    )


def _build_export_surplus_by_bucket_start(
    *,
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float] | None:
    if (
        snapshot.adjusted_house_forecast.get("status") != "available"
        or snapshot.battery_forecast.get("status") != "available"
        or snapshot.grid_forecast.get("status") != "available"
    ):
        return None

    raw_series = snapshot.grid_forecast.get("series")
    if not isinstance(raw_series, list):
        return None

    export_surplus_by_bucket_start: dict[datetime, float] = {}
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        bucket_start = _parse_timestamp(point.get("timestamp"))
        exported_to_grid_kwh = _read_optional_float(point.get("exportedToGridKwh"))
        if bucket_start is None or exported_to_grid_kwh is None:
            continue
        export_surplus_by_bucket_start[bucket_start] = exported_to_grid_kwh

    return export_surplus_by_bucket_start


def _slot_has_sufficient_surplus(
    *,
    export_surplus_by_bucket_start: dict[datetime, float],
    demand_slices,
    buffer_multiplier: float,
) -> bool:
    for demand_slice in demand_slices:
        available_surplus_kwh = export_surplus_by_bucket_start.get(
            demand_slice.bucket_start
        )
        if available_surplus_kwh is None:
            return False
        if available_surplus_kwh < (demand_slice.energy_kwh * buffer_multiplier):
            return False
    return True


def _clear_automation_owned_target_actions(
    *,
    schedule_document: ScheduleDocument,
    appliance_id: str,
) -> None:
    for slot_id in list(schedule_document.slots):
        domains = schedule_document.slots[slot_id]
        if is_user_owned_appliance_action(domains.appliances.get(appliance_id)):
            continue
        if appliance_id not in domains.appliances:
            continue
        updated_appliances = dict(domains.appliances)
        updated_appliances.pop(appliance_id, None)
        updated_domains = ScheduleDomains(
            inverter=domains.inverter,
            appliances=updated_appliances,
        )
        if is_default_domains(updated_domains):
            del schedule_document.slots[slot_id]
            continue
        schedule_document.slots[slot_id] = updated_domains


def _read_appliance_id(config: "OptimizerInstanceConfig") -> str:
    appliance_id = config.params.get("appliance_id")
    if not isinstance(appliance_id, str) or not appliance_id:
        raise SurplusApplianceValidationError(
            "appliance_id",
            f"Optimizer {config.id!r} is missing an appliance_id parameter"
        )
    return appliance_id


def _read_action(config: "OptimizerInstanceConfig") -> str:
    action = config.params.get("action")
    if not isinstance(action, str) or not action:
        raise SurplusApplianceValidationError(
            "action",
            f"Optimizer {config.id!r} is missing an action parameter",
        )
    return action


def _read_optional_climate_mode(config: "OptimizerInstanceConfig") -> str | None:
    climate_mode = config.params.get("climate_mode")
    if climate_mode is None:
        return None
    if not isinstance(climate_mode, str) or not climate_mode:
        raise SurplusApplianceValidationError(
            "climate_mode",
            f"Optimizer {config.id!r} climate_mode must be a non-empty string"
        )
    return climate_mode


def _read_min_surplus_buffer_pct(config: "OptimizerInstanceConfig") -> int:
    buffer_pct = config.params.get("min_surplus_buffer_pct")
    if isinstance(buffer_pct, bool) or not isinstance(buffer_pct, int):
        raise SurplusApplianceValidationError(
            "min_surplus_buffer_pct",
            f"Optimizer {config.id!r} min_surplus_buffer_pct must be an integer"
        )
    if buffer_pct < 0:
        raise SurplusApplianceValidationError(
            "min_surplus_buffer_pct",
            f"Optimizer {config.id!r} min_surplus_buffer_pct must be >= 0"
        )
    return buffer_pct


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = dt_util.parse_datetime(value)
    if parsed is None or parsed.tzinfo is None:
        return None
    return dt_util.as_local(parsed)


def _read_optional_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
