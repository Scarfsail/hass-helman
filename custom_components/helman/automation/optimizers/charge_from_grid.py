"""``charge_from_grid`` optimizer (use case 4).

Bridge expensive import windows the battery cannot cover on its own by charging
it from the grid during the immediately preceding cheap window, on the cheapest
slots. Self-gating (no ``only_on_days``); reads the simulated SoC trajectory to
decide whether a window needs bridging and how much. Not frozen — churn between
runs is accepted since it only ever adds energy.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import ceil
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...const import (
    IMPORT_BAND_LEVEL_CHEAP,
    IMPORT_BAND_LEVEL_EXPENSIVE,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_SLOT_MINUTES,
)
from ...scheduling.schedule import (
    ScheduleAction,
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
)
from ..ownership import is_user_owned_inverter_action

if TYPE_CHECKING:
    from ..config import OptimizerInstanceConfig
    from ..day_context import ImportBand
    from ..snapshot import OptimizationSnapshot

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)
_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60


class ChargeFromGridValidationError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class ValidatedChargeFromGridConfig:
    reserve_floor_soc: float
    margin_pct: float
    max_target_soc: float


@dataclass(frozen=True)
class ChargeFromGridOptimizer:
    id: str
    config: ValidatedChargeFromGridConfig
    kind: str = "charge_from_grid"

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

        battery_state = snapshot.context.battery_state
        usable_capacity_kwh = snapshot.context.battery_usable_capacity_kwh
        charge_efficiency = snapshot.context.battery_charge_efficiency
        max_charge_power_kw = snapshot.context.battery_max_charge_power_kw
        if (
            battery_state is None
            or usable_capacity_kwh is None
            or not usable_capacity_kwh > 0
            or charge_efficiency is None
            or not charge_efficiency > 0
            or max_charge_power_kw is None
            or not max_charge_power_kw > 0
        ):
            return updated

        soc_by_bucket = _build_soc_by_bucket_start(snapshot)
        if not soc_by_bucket:
            return updated
        import_price_by_bucket = _build_price_by_bucket_start(
            snapshot.context.import_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)
        upper_target = min(battery_state.max_soc, self.config.max_target_soc)
        lower_target = battery_state.min_soc

        for day_context in snapshot.context.day_contexts.values():
            bands = day_context.import_bands
            for index, band in enumerate(bands):
                if band.level != IMPORT_BAND_LEVEL_EXPENSIVE:
                    continue
                cheap_band = _find_preceding_cheap_band(bands, index)
                if cheap_band is None:
                    continue
                self._plan_window(
                    updated=updated,
                    expensive_band=band,
                    cheap_band=cheap_band,
                    soc_by_bucket=soc_by_bucket,
                    import_price_by_bucket=import_price_by_bucket,
                    usable_capacity_kwh=usable_capacity_kwh,
                    charge_efficiency=charge_efficiency,
                    max_charge_power_kw=max_charge_power_kw,
                    upper_target=upper_target,
                    lower_target=lower_target,
                    horizon_start=horizon_start,
                    horizon_end=horizon_end,
                )

        return updated

    def _plan_window(
        self,
        *,
        updated: ScheduleDocument,
        expensive_band: "ImportBand",
        cheap_band: "ImportBand",
        soc_by_bucket: list[tuple[datetime, float]],
        import_price_by_bucket: dict[datetime, float],
        usable_capacity_kwh: float,
        charge_efficiency: float,
        max_charge_power_kw: float,
        upper_target: float,
        lower_target: float,
        horizon_start: datetime,
        horizon_end: datetime,
    ) -> None:
        window_min_soc = _min_soc_over(
            soc_by_bucket, expensive_band.start, expensive_band.end
        )
        if window_min_soc is None:
            return
        dip = self.config.reserve_floor_soc - window_min_soc
        if dip <= 0:
            return  # covered — SoC never dips below the reserve floor.

        window_start_soc = _soc_at(soc_by_bucket, expensive_band.start)
        if window_start_soc is None:
            return
        target = window_start_soc + dip * (1 + self.config.margin_pct / 100)
        target = max(lower_target, min(upper_target, target))

        cheap_start_soc = _soc_at(soc_by_bucket, cheap_band.start)
        if cheap_start_soc is None:
            return
        soc_gap = target - cheap_start_soc
        if soc_gap <= 0:
            return  # already at/above target entering the cheap window.

        required_energy_kwh = soc_gap / 100 * usable_capacity_kwh / charge_efficiency
        slots_needed = ceil(
            required_energy_kwh / (max_charge_power_kw * _SLOT_HOURS)
        )
        if slots_needed <= 0:
            return

        target_soc = int(round(target))
        for slot_id in self._pick_cheapest_slots(
            updated=updated,
            cheap_band=cheap_band,
            import_price_by_bucket=import_price_by_bucket,
            slots_needed=slots_needed,
            horizon_start=horizon_start,
            horizon_end=horizon_end,
        ):
            current_domains = updated.slots.get(slot_id, ScheduleDomains())
            updated.slots[slot_id] = ScheduleDomains(
                inverter=ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=target_soc,
                    set_by="automation",
                ),
                appliances=dict(current_domains.appliances),
            )

    def _pick_cheapest_slots(
        self,
        *,
        updated: ScheduleDocument,
        cheap_band: "ImportBand",
        import_price_by_bucket: dict[datetime, float],
        slots_needed: int,
        horizon_start: datetime,
        horizon_end: datetime,
    ) -> list[str]:
        candidates: list[tuple[float, datetime, str]] = []
        cursor = cheap_band.start
        while cursor < cheap_band.end:
            if horizon_start <= cursor < horizon_end:
                slot_id = format_slot_id(cursor)
                current_domains = updated.slots.get(slot_id, ScheduleDomains())
                if not is_user_owned_inverter_action(current_domains.inverter):
                    price = import_price_by_bucket.get(cursor, float("inf"))
                    candidates.append((price, cursor, slot_id))
            cursor += _SLOT_DURATION
        candidates.sort(key=lambda item: (item[0], dt_util.as_utc(item[1])))
        return [slot_id for _, _, slot_id in candidates[:slots_needed]]


def _find_preceding_cheap_band(
    bands: tuple["ImportBand", ...],
    expensive_index: int,
) -> "ImportBand | None":
    for band in reversed(bands[:expensive_index]):
        if band.level == IMPORT_BAND_LEVEL_CHEAP:
            return band
    return None


def _min_soc_over(
    soc_by_bucket: list[tuple[datetime, float]],
    start: datetime,
    end: datetime,
) -> float | None:
    start_utc = dt_util.as_utc(start)
    end_utc = dt_util.as_utc(end)
    values = [
        soc
        for bucket_start, soc in soc_by_bucket
        if start_utc <= dt_util.as_utc(bucket_start) < end_utc
    ]
    if not values:
        return None
    return min(values)


def _soc_at(
    soc_by_bucket: list[tuple[datetime, float]],
    at: datetime,
) -> float | None:
    at_utc = dt_util.as_utc(at)
    latest: float | None = None
    for bucket_start, soc in soc_by_bucket:
        if dt_util.as_utc(bucket_start) <= at_utc:
            latest = soc
        else:
            break
    if latest is not None:
        return latest
    # Fall back to the earliest known SoC if the window starts before the series.
    return soc_by_bucket[0][1] if soc_by_bucket else None


def _build_soc_by_bucket_start(
    snapshot: "OptimizationSnapshot",
) -> list[tuple[datetime, float]]:
    raw_series = snapshot.battery_forecast.get("series")
    if not isinstance(raw_series, list):
        return []
    soc_by_bucket: list[tuple[datetime, float]] = []
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        soc_pct = _read_optional_float(point.get("socPct"))
        if timestamp is None or soc_pct is None:
            continue
        soc_by_bucket.append((timestamp, soc_pct))
    soc_by_bucket.sort(key=lambda item: dt_util.as_utc(item[0]))
    return soc_by_bucket


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


def build_charge_from_grid_optimizer(
    config: "OptimizerInstanceConfig",
) -> ChargeFromGridOptimizer:
    return ChargeFromGridOptimizer(
        id=config.id,
        config=validate_charge_from_grid_optimizer_config(config),
    )


def validate_charge_from_grid_optimizer_config(
    config: "OptimizerInstanceConfig",
) -> ValidatedChargeFromGridConfig:
    params = config.params
    reserve_floor_soc = _read_soc(params, "reserve_floor_soc")
    max_target_soc = _read_soc(params, "max_target_soc", default=100.0)
    margin_pct = _read_margin_pct(params)
    return ValidatedChargeFromGridConfig(
        reserve_floor_soc=reserve_floor_soc,
        margin_pct=margin_pct,
        max_target_soc=max_target_soc,
    )


def _read_soc(
    params: dict[str, Any], field: str, *, default: float | None = None
) -> float:
    value = params.get(field, default if default is not None else _MISSING)
    if value is _MISSING:
        raise ChargeFromGridValidationError(field, f"{field} is required")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ChargeFromGridValidationError(field, f"{field} must be a number")
    if not 0 <= value <= 100:
        raise ChargeFromGridValidationError(
            field, f"{field} must be between 0 and 100"
        )
    return float(value)


def _read_margin_pct(params: dict[str, Any]) -> float:
    value = params.get("margin_pct", 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ChargeFromGridValidationError("margin_pct", "margin_pct must be a number")
    if value < 0:
        raise ChargeFromGridValidationError("margin_pct", "margin_pct must be >= 0")
    return float(value)


_MISSING = object()


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
