"""``charge_hold`` optimizer (use case 1).

On qualifying days, hold the battery out of charging through the morning so the
day's solar surplus charges it later (displacing morning grid charging and
freeing the surplus for export), releasing no later than the latest slot from
which the day's remaining solar can still refill the battery — and no later than
the day's cheapest export slot. Single pass, read-only over the input snapshot.

Runs **before** ``export_price`` in config order so ``export_price``'s protective
``stop_export`` wins any slot both want.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    SCHEDULE_ACTION_STOP_CHARGING,
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
    from ..day_context import DayContext
    from ..snapshot import OptimizationSnapshot

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)


class ChargeHoldValidationError(ValueError):
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
class ValidatedChargeHoldConfig:
    only_on_days: tuple[str, ...]
    window_start: _WindowTime
    window_end: _WindowTime
    target_soc: float
    margin_pct: float


@dataclass(frozen=True)
class ChargeHoldOptimizer:
    id: str
    config: ValidatedChargeHoldConfig
    kind: str = "charge_hold"

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

        needed_kwh = _compute_needed_kwh(
            target_soc=self.config.target_soc,
            current_soc=battery_state.current_soc,
            usable_capacity_kwh=usable_capacity_kwh,
            charge_efficiency=charge_efficiency,
        )
        margin_multiplier = 1 + (self.config.margin_pct / 100)

        surplus_by_bucket = _build_clipped_surplus_by_bucket_start(
            snapshot=snapshot,
            max_charge_power_kw=max_charge_power_kw,
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)
        tzinfo = horizon_start.tzinfo

        hold_slot_ids: set[str] = set()
        for local_date, day_context in snapshot.context.day_contexts.items():
            if day_context.classification not in self.config.only_on_days:
                continue
            hold_slot_ids.update(
                self._resolve_hold_slot_ids(
                    local_date=local_date,
                    day_context=day_context,
                    needed_kwh=needed_kwh,
                    margin_multiplier=margin_multiplier,
                    surplus_by_bucket=surplus_by_bucket,
                    horizon_start=horizon_start,
                    horizon_end=horizon_end,
                    tzinfo=tzinfo,
                )
            )

        for slot_id in hold_slot_ids:
            current_domains = updated.slots.get(slot_id, ScheduleDomains())
            if is_user_owned_inverter_action(current_domains.inverter):
                continue
            updated.slots[slot_id] = ScheduleDomains(
                inverter=ScheduleAction(
                    kind=SCHEDULE_ACTION_STOP_CHARGING,
                    set_by="automation",
                ),
                appliances=dict(current_domains.appliances),
            )

        return updated

    def _resolve_hold_slot_ids(
        self,
        *,
        local_date: date,
        day_context: "DayContext",
        needed_kwh: float,
        margin_multiplier: float,
        surplus_by_bucket: list[tuple[datetime, float]],
        horizon_start: datetime,
        horizon_end: datetime,
        tzinfo,
    ) -> set[str]:
        window_start = self.config.window_start.on(local_date, tzinfo=tzinfo)
        window_end = self.config.window_end.on(local_date, tzinfo=tzinfo)
        if window_end <= window_start:
            return set()

        # Only this calendar day's own solar can refill the battery for this
        # day's hold, so bound the surplus accounting at the local midnight after
        # ``local_date`` — never spill tomorrow's forecast surplus into today.
        day_end = datetime.combine(
            local_date + timedelta(days=1), time.min, tzinfo=tzinfo
        )

        release_slot = _resolve_release_slot(
            window_start=window_start,
            window_end=window_end,
            day_end=day_end,
            needed_kwh=needed_kwh,
            margin_multiplier=margin_multiplier,
            surplus_by_bucket=surplus_by_bucket,
            day_min_window_start=(
                None
                if day_context.day_min_window is None
                else day_context.day_min_window.start
            ),
        )
        if release_slot is None:
            return set()

        hold_slot_ids: set[str] = set()
        cursor = window_start
        while cursor < release_slot:
            if horizon_start <= cursor < horizon_end:
                hold_slot_ids.add(format_slot_id(cursor))
            cursor += _SLOT_DURATION
        return hold_slot_ids


def _compute_needed_kwh(
    *,
    target_soc: float,
    current_soc: float,
    usable_capacity_kwh: float,
    charge_efficiency: float,
) -> float:
    soc_gap_fraction = (target_soc - current_soc) / 100
    if soc_gap_fraction <= 0:
        return 0.0
    return soc_gap_fraction * usable_capacity_kwh / charge_efficiency


def _resolve_release_slot(
    *,
    window_start: datetime,
    window_end: datetime,
    day_end: datetime,
    needed_kwh: float,
    margin_multiplier: float,
    surplus_by_bucket: list[tuple[datetime, float]],
    day_min_window_start: datetime | None,
) -> datetime | None:
    if needed_kwh <= 0:
        # Nothing to charge: hold across the whole window (price bound may only
        # shorten it).
        latest_safe_release = window_end
    else:
        threshold = needed_kwh * margin_multiplier
        # surplus in [t, day_end) is monotonically non-increasing in t, so the
        # latest candidate slot that still covers the threshold is the boundary.
        latest_safe_release = None
        cursor = window_start
        while cursor <= window_end:
            if _surplus_between(surplus_by_bucket, cursor, day_end) >= threshold:
                latest_safe_release = cursor
            cursor += _SLOT_DURATION
        if latest_safe_release is None:
            # Even releasing at window.start cannot cover the need: no room to
            # hold.
            return None

    if day_min_window_start is not None:
        release_slot = min(day_min_window_start, latest_safe_release)
    else:
        release_slot = latest_safe_release
    return release_slot


def _surplus_between(
    surplus_by_bucket: list[tuple[datetime, float]],
    release_time: datetime,
    day_end: datetime,
) -> float:
    release_utc = dt_util.as_utc(release_time)
    day_end_utc = dt_util.as_utc(day_end)
    return sum(
        surplus
        for bucket_start, surplus in surplus_by_bucket
        if release_utc <= dt_util.as_utc(bucket_start) < day_end_utc
    )


def _build_clipped_surplus_by_bucket_start(
    *,
    snapshot: "OptimizationSnapshot",
    max_charge_power_kw: float,
) -> list[tuple[datetime, float]]:
    raw_series = snapshot.battery_forecast.get("series")
    if not isinstance(raw_series, list):
        return []

    surplus_by_bucket: list[tuple[datetime, float]] = []
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        solar_kwh = _read_optional_float(point.get("solarKwh"))
        house_kwh = _read_optional_float(point.get("baselineHouseKwh"))
        if timestamp is None or solar_kwh is None or house_kwh is None:
            continue
        duration_hours = _read_optional_float(point.get("durationHours"))
        if duration_hours is None or duration_hours <= 0:
            duration_hours = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
        raw_surplus = max(0.0, solar_kwh - house_kwh)
        clipped = min(raw_surplus, max_charge_power_kw * duration_hours)
        surplus_by_bucket.append((timestamp, clipped))
    return surplus_by_bucket


def build_charge_hold_optimizer(
    config: "OptimizerInstanceConfig",
) -> ChargeHoldOptimizer:
    return ChargeHoldOptimizer(
        id=config.id,
        config=validate_charge_hold_optimizer_config(config),
    )


def validate_charge_hold_optimizer_config(
    config: "OptimizerInstanceConfig",
) -> ValidatedChargeHoldConfig:
    params = config.params
    window_start = _read_window_time(params, "window", "start")
    window_end = _read_window_time(params, "window", "end")
    if (window_end.hour, window_end.minute) <= (window_start.hour, window_start.minute):
        raise ChargeHoldValidationError(
            "window", "window.end must be after window.start"
        )
    return ValidatedChargeHoldConfig(
        only_on_days=_read_only_on_days(params),
        window_start=window_start,
        window_end=window_end,
        target_soc=_read_target_soc(params),
        margin_pct=_read_margin_pct(params),
    )


def _read_only_on_days(params: dict[str, Any]) -> tuple[str, ...]:
    from ...const import DAY_CLASSIFICATIONS

    value = params.get("only_on_days")
    if value is None:
        return DAY_CLASSIFICATIONS
    if not isinstance(value, (list, tuple)) or not value:
        raise ChargeHoldValidationError(
            "only_on_days", "only_on_days must be a non-empty list"
        )
    days: list[str] = []
    for item in value:
        if item not in DAY_CLASSIFICATIONS:
            raise ChargeHoldValidationError(
                "only_on_days",
                f"only_on_days entries must be one of {', '.join(DAY_CLASSIFICATIONS)}",
            )
        days.append(item)
    return tuple(days)


def _read_window_time(
    params: dict[str, Any], key: str, field: str
) -> _WindowTime:
    window = params.get(key)
    if not isinstance(window, dict):
        raise ChargeHoldValidationError(key, f"{key} must be an object")
    raw = window.get(field)
    if not isinstance(raw, str):
        raise ChargeHoldValidationError(
            key, f"{key}.{field} must be an 'HH:MM' string"
        )
    parts = raw.split(":")
    if len(parts) != 2:
        raise ChargeHoldValidationError(
            key, f"{key}.{field} must be an 'HH:MM' string"
        )
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError as err:
        raise ChargeHoldValidationError(
            key, f"{key}.{field} must be an 'HH:MM' string"
        ) from err
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ChargeHoldValidationError(
            key, f"{key}.{field} must be a valid 'HH:MM' time"
        )
    return _WindowTime(hour=hour, minute=minute)


def _read_target_soc(params: dict[str, Any]) -> float:
    battery_first = params.get("battery_first")
    if not isinstance(battery_first, dict):
        raise ChargeHoldValidationError(
            "battery_first", "battery_first must be an object"
        )
    value = battery_first.get("target_soc")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ChargeHoldValidationError(
            "battery_first", "battery_first.target_soc must be a number"
        )
    if not 0 <= value <= 100:
        raise ChargeHoldValidationError(
            "battery_first", "battery_first.target_soc must be between 0 and 100"
        )
    return float(value)


def _read_margin_pct(params: dict[str, Any]) -> float:
    battery_first = params.get("battery_first")
    if not isinstance(battery_first, dict):
        raise ChargeHoldValidationError(
            "battery_first", "battery_first must be an object"
        )
    value = battery_first.get("margin_pct", 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ChargeHoldValidationError(
            "battery_first", "battery_first.margin_pct must be a number"
        )
    if value < 0:
        raise ChargeHoldValidationError(
            "battery_first", "battery_first.margin_pct must be >= 0"
        )
    return float(value)


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
