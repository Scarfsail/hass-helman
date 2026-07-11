"""``daily_runtime`` optimizer (use case 3).

Ensure an appliance (generic switch or climate mode) accumulates at least
``min_hours_per_day`` within a daily window, placing the remaining hours on the
cheapest slots, preferring slots the day's solar surplus already covers. Honours
a skip policy on configured day classifications, bounded by a consecutive-skip
guard evaluated against recorder history. Stateless beyond the framework's A2
runtime input; manual runs count automatically because they show up in history.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from math import ceil
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...appliances.climate_appliance import ClimateApplianceRuntime
from ...appliances.generic_appliance import GenericApplianceRuntime
from ...const import SCHEDULE_SLOT_MINUTES
from ...scheduling.schedule import (
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
)
from ..ownership import (
    is_user_owned_appliance_action,
    stamp_automation_appliance_action,
)

if TYPE_CHECKING:
    from ...appliances import AppliancesRuntimeRegistry
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)
_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60


class DailyRuntimeValidationError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class _WindowTime:
    hour: int
    minute: int

    def on(self, local_date: date, *, tzinfo) -> datetime:
        return datetime.combine(
            local_date, time(self.hour, self.minute), tzinfo=tzinfo
        )


@dataclass(frozen=True)
class ValidatedDailyRuntimeConfig:
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime
    authored_action: dict[str, object]
    min_hours_per_day: float
    window_start: _WindowTime
    window_end: _WindowTime
    skip_on_days: tuple[str, ...]
    max_consecutive_skips: int


@dataclass(frozen=True)
class DailyRuntimeOptimizer:
    id: str
    config: ValidatedDailyRuntimeConfig
    kind: str = "daily_runtime"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
    ) -> ScheduleDocument:
        del config
        updated = ScheduleDocument(
            execution_enabled=snapshot.schedule.execution_enabled,
            slots=deepcopy(snapshot.schedule.slots),
        )
        appliance_id = self.config.appliance.id

        runtime_by_date = (
            snapshot.context.runtime_hours_by_appliance_id_by_local_date.get(
                appliance_id, {}
            )
        )
        available_surplus_by_bucket = _build_available_surplus_by_bucket_start(snapshot)
        demand_hourly_energy = _resolve_demand_hourly_energy(
            snapshot=snapshot, appliance=self.config.appliance
        )
        export_price_by_bucket = _build_price_by_bucket_start(
            snapshot.context.export_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)
        tzinfo = horizon_start.tzinfo

        for local_date, day_context in snapshot.context.day_contexts.items():
            delivered_hours = runtime_by_date.get(local_date, 0.0)
            remaining_hours = self.config.min_hours_per_day - delivered_hours
            if remaining_hours <= 0:
                continue

            if self._should_skip(
                classification=day_context.classification,
                local_date=local_date,
                runtime_by_date=runtime_by_date,
            ):
                continue

            slots_needed = ceil(remaining_hours / _SLOT_HOURS)
            chosen_slot_ids = self._pick_slots(
                updated=updated,
                appliance_id=appliance_id,
                local_date=local_date,
                slots_needed=slots_needed,
                available_surplus_by_bucket=available_surplus_by_bucket,
                demand_hourly_energy=demand_hourly_energy,
                export_price_by_bucket=export_price_by_bucket,
                reference_time=snapshot.context.now,
                horizon_start=horizon_start,
                horizon_end=horizon_end,
                tzinfo=tzinfo,
            )
            for slot_id in chosen_slot_ids:
                current_domains = updated.slots.get(slot_id, ScheduleDomains())
                updated_appliances = dict(current_domains.appliances)
                updated_appliances[appliance_id] = stamp_automation_appliance_action(
                    self.config.authored_action
                )
                updated.slots[slot_id] = ScheduleDomains(
                    inverter=current_domains.inverter,
                    appliances=updated_appliances,
                )

        return updated

    def _should_skip(
        self,
        *,
        classification: str,
        local_date: date,
        runtime_by_date: dict[date, float],
    ) -> bool:
        if classification not in self.config.skip_on_days:
            return False
        consecutive_prior_skips = 0
        cursor = local_date - timedelta(days=1)
        while cursor in runtime_by_date:
            if runtime_by_date[cursor] < self.config.min_hours_per_day:
                consecutive_prior_skips += 1
                cursor -= timedelta(days=1)
            else:
                break
        # Skipping today extends the run by one; only allowed while it stays
        # within max_consecutive_skips.
        return consecutive_prior_skips + 1 <= self.config.max_consecutive_skips

    def _pick_slots(
        self,
        *,
        updated: ScheduleDocument,
        appliance_id: str,
        local_date: date,
        slots_needed: int,
        available_surplus_by_bucket: dict[datetime, float] | None,
        demand_hourly_energy: float | None,
        export_price_by_bucket: dict[datetime, float],
        reference_time: datetime,
        horizon_start: datetime,
        horizon_end: datetime,
        tzinfo,
    ) -> list[str]:
        window_start = self.config.window_start.on(local_date, tzinfo=tzinfo)
        window_end = self.config.window_end.on(local_date, tzinfo=tzinfo)

        candidates: list[tuple[int, float, datetime, str]] = []
        cursor = window_start
        while cursor < window_end:
            if horizon_start <= cursor < horizon_end:
                slot_id = format_slot_id(cursor)
                current_domains = updated.slots.get(slot_id, ScheduleDomains())
                if not is_user_owned_appliance_action(
                    current_domains.appliances.get(appliance_id)
                ):
                    covered = _slot_is_solar_covered(
                        slot_id=slot_id,
                        reference_time=reference_time,
                        available_surplus_by_bucket=available_surplus_by_bucket,
                        demand_hourly_energy=demand_hourly_energy,
                    )
                    export_price = export_price_by_bucket.get(cursor, float("inf"))
                    candidates.append(
                        (export_price, 0 if covered else 1, cursor, slot_id)
                    )
            cursor += _SLOT_DURATION

        candidates.sort(key=lambda item: (item[0], item[1], dt_util.as_utc(item[2])))
        return [slot_id for _, _, _, slot_id in candidates[:slots_needed]]


def _slot_is_solar_covered(
    *,
    slot_id: str,
    reference_time: datetime,
    available_surplus_by_bucket: dict[datetime, float] | None,
    demand_hourly_energy: float | None,
) -> bool:
    if (
        available_surplus_by_bucket is None
        or demand_hourly_energy is None
        or demand_hourly_energy <= 0
    ):
        return False
    from ...appliances.projection_builder import build_when_active_demand_slices

    demand_slices = build_when_active_demand_slices(
        slot_id=slot_id,
        reference_time=reference_time,
        hourly_energy_kwh=demand_hourly_energy,
    )
    if not demand_slices:
        return False
    for demand_slice in demand_slices:
        available = available_surplus_by_bucket.get(demand_slice.bucket_start)
        if available is None or available < demand_slice.energy_kwh:
            return False
    return True


def _resolve_demand_hourly_energy(
    *,
    snapshot: "OptimizationSnapshot",
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime,
) -> float | None:
    from ...appliances.projection_builder import get_when_active_demand_profile

    resolved = snapshot.context.when_active_hourly_energy_kwh_by_appliance_id.get(
        appliance.id
    )
    if resolved is None:
        return None
    profile = get_when_active_demand_profile(
        appliance=appliance,
        resolved_hourly_energy_kwh=resolved,
    )
    return None if profile is None else profile.hourly_energy_kwh


def _build_available_surplus_by_bucket_start(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float] | None:
    raw_series = snapshot.grid_forecast.get("series")
    if not isinstance(raw_series, list):
        return None
    surplus_by_bucket: dict[datetime, float] = {}
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        available = _read_optional_float(point.get("availableSurplusKwh"))
        if timestamp is None or available is None:
            continue
        surplus_by_bucket[timestamp] = available
    return surplus_by_bucket or None


def _build_price_by_bucket_start(
    price_forecast: dict[str, Any],
) -> dict[datetime, float]:
    points = price_forecast.get("points")
    if not isinstance(points, list):
        return {}
    price_by_bucket: dict[datetime, float] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        value = _read_optional_float(point.get("value"))
        if timestamp is None or value is None:
            continue
        price_by_bucket[timestamp] = value
    return price_by_bucket


def build_daily_runtime_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: "AppliancesRuntimeRegistry",
) -> DailyRuntimeOptimizer:
    return DailyRuntimeOptimizer(
        id=config.id,
        config=validate_daily_runtime_optimizer_config(
            config, appliance_registry=appliance_registry
        ),
    )


def validate_daily_runtime_optimizer_config(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: "AppliancesRuntimeRegistry",
) -> ValidatedDailyRuntimeConfig:
    from ...const import DAY_CLASSIFICATIONS

    params = config.params
    appliance_id = params.get("appliance_id")
    if not isinstance(appliance_id, str) or not appliance_id:
        raise DailyRuntimeValidationError(
            "appliance_id", "appliance_id must be a non-empty string"
        )
    appliance = appliance_registry.get_appliance(appliance_id)
    if appliance is None:
        raise DailyRuntimeValidationError(
            "appliance_id", f"unknown appliance_id {appliance_id!r}"
        )

    climate_mode = params.get("climate_mode")
    if isinstance(appliance, GenericApplianceRuntime):
        if climate_mode is not None:
            raise DailyRuntimeValidationError(
                "climate_mode",
                f"climate_mode is not allowed for generic appliance {appliance_id!r}",
            )
        authored_action: dict[str, object] = {"on": True}
    elif isinstance(appliance, ClimateApplianceRuntime):
        if not isinstance(climate_mode, str) or not climate_mode:
            raise DailyRuntimeValidationError(
                "climate_mode",
                f"climate_mode is required for climate appliance {appliance_id!r}",
            )
        if climate_mode not in appliance.authorable_modes:
            raise DailyRuntimeValidationError(
                "climate_mode",
                f"climate_mode {climate_mode!r} is not supported for appliance "
                f"{appliance_id!r}",
            )
        authored_action = {"mode": climate_mode}
    else:
        raise DailyRuntimeValidationError(
            "appliance_id",
            f"appliance {appliance_id!r} must be generic or climate",
        )

    min_hours_per_day = _read_positive_number(params, "min_hours_per_day")
    window_start = _read_window_time(params, "start")
    window_end = _read_window_time(params, "end")
    window_hours = (
        (window_end.hour * 60 + window_end.minute)
        - (window_start.hour * 60 + window_start.minute)
    ) / 60
    if window_hours <= 0:
        raise DailyRuntimeValidationError(
            "window", "window.end must be after window.start"
        )
    if window_hours < min_hours_per_day:
        raise DailyRuntimeValidationError(
            "window",
            "window width must be at least min_hours_per_day",
        )

    skip_on_days, max_consecutive_skips = _read_skip(params, DAY_CLASSIFICATIONS)

    return ValidatedDailyRuntimeConfig(
        appliance=appliance,
        authored_action=authored_action,
        min_hours_per_day=min_hours_per_day,
        window_start=window_start,
        window_end=window_end,
        skip_on_days=skip_on_days,
        max_consecutive_skips=max_consecutive_skips,
    )


def _read_positive_number(params: dict[str, Any], field: str) -> float:
    value = params.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DailyRuntimeValidationError(field, f"{field} must be a number")
    if value <= 0:
        raise DailyRuntimeValidationError(field, f"{field} must be > 0")
    return float(value)


def _read_window_time(params: dict[str, Any], field: str) -> _WindowTime:
    window = params.get("window")
    if not isinstance(window, dict):
        raise DailyRuntimeValidationError("window", "window must be an object")
    raw = window.get(field)
    if not isinstance(raw, str):
        raise DailyRuntimeValidationError(
            "window", f"window.{field} must be an 'HH:MM' string"
        )
    parts = raw.split(":")
    if len(parts) != 2:
        raise DailyRuntimeValidationError(
            "window", f"window.{field} must be an 'HH:MM' string"
        )
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError as err:
        raise DailyRuntimeValidationError(
            "window", f"window.{field} must be an 'HH:MM' string"
        ) from err
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise DailyRuntimeValidationError(
            "window", f"window.{field} must be a valid 'HH:MM' time"
        )
    return _WindowTime(hour=hour, minute=minute)


def _read_skip(
    params: dict[str, Any], classifications: tuple[str, ...]
) -> tuple[tuple[str, ...], int]:
    skip = params.get("skip")
    if skip is None:
        return (), 0
    if not isinstance(skip, dict):
        raise DailyRuntimeValidationError("skip", "skip must be an object")
    raw_on_days = skip.get("on_days", [])
    if not isinstance(raw_on_days, (list, tuple)):
        raise DailyRuntimeValidationError("skip", "skip.on_days must be a list")
    on_days: list[str] = []
    for item in raw_on_days:
        if item not in classifications:
            raise DailyRuntimeValidationError(
                "skip",
                f"skip.on_days entries must be one of {', '.join(classifications)}",
            )
        on_days.append(item)
    raw_max = skip.get("max_consecutive_skips", 0)
    if isinstance(raw_max, bool) or not isinstance(raw_max, int):
        raise DailyRuntimeValidationError(
            "skip", "skip.max_consecutive_skips must be an integer"
        )
    if raw_max < 0:
        raise DailyRuntimeValidationError(
            "skip", "skip.max_consecutive_skips must be >= 0"
        )
    return tuple(on_days), raw_max


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = dt_util.parse_datetime(value)
    if parsed is None or parsed.tzinfo is None:
        return None
    return dt_util.as_local(parsed)


def _read_optional_float(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
