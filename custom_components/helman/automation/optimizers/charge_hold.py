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
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_SLOT_MINUTES,
)
from ...scheduling.schedule import (
    ScheduleAction,
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_start,
    format_slot_id,
    iter_horizon_slot_ids,
    parse_slot_id,
)
from ..ownership import is_user_owned_inverter_action
from ..rails import read_clipped_surplus_by_bucket
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..config import OptimizerInstanceConfig
    from ..day_context import DayContext
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

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
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        del config
        trace = trace or NULL_TRACE
        # When this optimizer's execution condition is not met, its actions are
        # placed as candidates: still scheduled (for display/promotion) but
        # excluded from resource accounting and not executed.
        condition_met = snapshot.context.condition_met_by_optimizer_id.get(
            self.id, True
        )
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
            # Whole run out of scope: the column stays explained by one note.
            trace.note_horizon(code="battery_params_missing", params={})
            return updated

        needed_kwh = _compute_needed_kwh(
            target_soc=self.config.target_soc,
            current_soc=battery_state.current_soc,
            usable_capacity_kwh=usable_capacity_kwh,
            charge_efficiency=charge_efficiency,
        )
        margin_multiplier = 1 + (self.config.margin_pct / 100)

        surplus_by_bucket = read_clipped_surplus_by_bucket(
            snapshot,
            max_charge_power_kw=max_charge_power_kw,
        )

        tzinfo = build_horizon_start(snapshot.context.now).tzinfo

        # Categorize every horizon slot so the column is fully explained. The
        # hold window / release rationale is genuinely non-derivable, so it is
        # all emitted here (the E rows of the reason catalogue).
        resolutions: dict[date, _DayHoldResolution] = {}

        def _resolution(local_date: date, day_context: "DayContext") -> "_DayHoldResolution":
            cached = resolutions.get(local_date)
            if cached is not None:
                return cached
            resolved = _resolve_day_hold(
                local_date=local_date,
                day_context=day_context,
                window_start=self.config.window_start.on(local_date, tzinfo=tzinfo),
                window_end=self.config.window_end.on(local_date, tzinfo=tzinfo),
                needed_kwh=needed_kwh,
                margin_multiplier=margin_multiplier,
                surplus_by_bucket=surplus_by_bucket,
                tzinfo=tzinfo,
            )
            resolutions[local_date] = resolved
            return resolved

        applied_by_day: dict[date, list[str]] = {}
        blocked_by_day: dict[date, list[str]] = {}
        after_release_by_day: dict[date, list[str]] = {}
        no_room_by_day: dict[date, list[str]] = {}
        outside_window: list[str] = []
        day_not_matched: dict[str, list[str]] = {}

        for slot_id in iter_horizon_slot_ids(snapshot.context.now):
            slot_start = parse_slot_id(slot_id)
            local_date = slot_start.date()
            day_context = snapshot.context.day_contexts.get(local_date)
            if day_context is None:
                outside_window.append(slot_id)
                continue
            if day_context.classification not in self.config.only_on_days:
                day_not_matched.setdefault(day_context.classification, []).append(slot_id)
                continue
            resolved = _resolution(local_date, day_context)
            if not (resolved.window_start <= slot_start < resolved.window_end):
                outside_window.append(slot_id)
                continue
            if resolved.release_slot is None:
                no_room_by_day.setdefault(local_date, []).append(slot_id)
                continue
            if slot_start < resolved.release_slot:
                current_domains = updated.slots.get(slot_id, ScheduleDomains())
                if is_user_owned_inverter_action(current_domains.inverter):
                    blocked_by_day.setdefault(local_date, []).append(slot_id)
                    continue
                updated.slots[slot_id] = ScheduleDomains(
                    inverter=ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="automation",
                        condition_met=condition_met,
                    ),
                    appliances=dict(current_domains.appliances),
                )
                applied_by_day.setdefault(local_date, []).append(slot_id)
            else:
                after_release_by_day.setdefault(local_date, []).append(slot_id)

        _emit_charge_hold_decisions(
            trace,
            needed_kwh=needed_kwh,
            margin_pct=self.config.margin_pct,
            only_on_days=self.config.only_on_days,
            resolutions=resolutions,
            applied_by_day=applied_by_day,
            blocked_by_day=blocked_by_day,
            after_release_by_day=after_release_by_day,
            no_room_by_day=no_room_by_day,
            outside_window=outside_window,
            day_not_matched=day_not_matched,
        )
        return updated


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


@dataclass(frozen=True)
class _DayHoldResolution:
    window_start: datetime
    window_end: datetime
    release_slot: datetime | None
    bound_by: str | None
    surplus_at_window_start: float


def _resolve_day_hold(
    *,
    local_date: date,
    day_context: "DayContext",
    window_start: datetime,
    window_end: datetime,
    needed_kwh: float,
    margin_multiplier: float,
    surplus_by_bucket: list[tuple[datetime, float]],
    tzinfo,
) -> _DayHoldResolution:
    if window_end <= window_start:
        return _DayHoldResolution(
            window_start=window_start,
            window_end=window_end,
            release_slot=None,
            bound_by=None,
            surplus_at_window_start=0.0,
        )

    # Only this calendar day's own solar can refill the battery for this day's
    # hold, so bound the surplus accounting at the local midnight after
    # ``local_date`` — never spill tomorrow's forecast surplus into today.
    day_end = datetime.combine(local_date + timedelta(days=1), time.min, tzinfo=tzinfo)
    surplus_at_window_start = _surplus_between(surplus_by_bucket, window_start, day_end)
    day_min_window_start = (
        None if day_context.day_min_window is None else day_context.day_min_window.start
    )

    if needed_kwh <= 0:
        # Nothing to charge: hold across the whole window (price bound may only
        # shorten it).
        latest_safe_release = window_end
        bound_by = "window_end"
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
            return _DayHoldResolution(
                window_start=window_start,
                window_end=window_end,
                release_slot=None,
                bound_by=None,
                surplus_at_window_start=surplus_at_window_start,
            )
        bound_by = "surplus"

    if day_min_window_start is not None and day_min_window_start < latest_safe_release:
        release_slot = day_min_window_start
        bound_by = "day_min_window"
    else:
        release_slot = latest_safe_release
    return _DayHoldResolution(
        window_start=window_start,
        window_end=window_end,
        release_slot=release_slot,
        bound_by=bound_by,
        surplus_at_window_start=surplus_at_window_start,
    )


def _emit_charge_hold_decisions(
    trace,
    *,
    needed_kwh: float,
    margin_pct: float,
    only_on_days: tuple[str, ...],
    resolutions: dict[date, _DayHoldResolution],
    applied_by_day: dict[date, list[str]],
    blocked_by_day: dict[date, list[str]],
    after_release_by_day: dict[date, list[str]],
    no_room_by_day: dict[date, list[str]],
    outside_window: list[str],
    day_not_matched: dict[str, list[str]],
) -> None:
    for local_date, slot_ids in applied_by_day.items():
        resolved = resolutions[local_date]
        trace.decision(
            slot_ids=slot_ids,
            outcome="applied",
            action={"domain": "inverter", "kind": SCHEDULE_ACTION_STOP_CHARGING},
            reason={
                "code": "hold_window_applied",
                "params": {
                    "neededKwh": round(needed_kwh, 3),
                    "marginPct": margin_pct,
                    "releaseSlot": (
                        None
                        if resolved.release_slot is None
                        else format_slot_id(resolved.release_slot)
                    ),
                    "boundBy": resolved.bound_by,
                },
            },
        )
    for slot_ids in blocked_by_day.values():
        trace.decision(
            slot_ids=slot_ids,
            outcome="blocked",
            action={"domain": "inverter", "kind": SCHEDULE_ACTION_STOP_CHARGING},
            reason={"code": "blocked_user_owned", "params": {"domain": "inverter"}},
        )
    for local_date, slot_ids in after_release_by_day.items():
        resolved = resolutions[local_date]
        trace.decision(
            slot_ids=slot_ids,
            outcome="out_of_scope",
            reason={
                "code": "after_release",
                "params": {
                    "releaseSlot": (
                        None
                        if resolved.release_slot is None
                        else format_slot_id(resolved.release_slot)
                    )
                },
            },
        )
    for local_date, slot_ids in no_room_by_day.items():
        resolved = resolutions[local_date]
        trace.decision(
            slot_ids=slot_ids,
            outcome="rejected",
            reason={
                "code": "no_room_to_hold",
                "params": {
                    "neededKwh": round(needed_kwh, 3),
                    "surplusAtWindowStart": round(resolved.surplus_at_window_start, 3),
                },
            },
        )
    if outside_window:
        trace.decision(
            slot_ids=outside_window,
            outcome="out_of_scope",
            reason={"code": "outside_window", "params": {}},
        )
    for classification, slot_ids in day_not_matched.items():
        trace.decision(
            slot_ids=slot_ids,
            outcome="out_of_scope",
            reason={
                "code": "day_not_matched",
                "params": {
                    "classification": classification,
                    "onlyOnDays": list(only_on_days),
                },
            },
        )


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
