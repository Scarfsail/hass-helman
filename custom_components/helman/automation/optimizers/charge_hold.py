"""``charge_hold`` optimizer (use case 1).

On qualifying days, hold the battery out of charging through the morning so the
day's solar surplus charges it later (displacing morning grid charging and
freeing the surplus for export), releasing no later than the latest slot from
which the day's remaining solar can still refill the battery — and no later than
the day's cheapest export slot. Single pass, read-only over the input snapshot.

Runs **before** ``export_price`` in config order so ``export_price``'s protective
``stop_export`` wins any slot both want.

Day gating lives in the ``run_when`` condition; params resolve per day (R2), so
a group can hold to a later hour or a higher target SoC on surplus days.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...const import SCHEDULE_ACTION_STOP_CHARGING, SCHEDULE_SLOT_MINUTES
from ...scheduling.schedule import (
    ScheduleDocument,
    build_horizon_start,
    format_slot_id,
    parse_slot_id,
)
from ..base import ScheduleWriter
from ..conditions import build_eligibility
from ..fields import time_on
from ..rails import read_clipped_surplus_by_bucket
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..conditions import Eligibility
    from ..config import OptimizerInstanceConfig
    from ..day_context import DayContext
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)
_ACTION = {"domain": "inverter", "kind": SCHEDULE_ACTION_STOP_CHARGING}


@dataclass(frozen=True)
class ChargeHoldOptimizer:
    id: str
    kind: str = "charge_hold"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        trace = trace or NULL_TRACE
        eligibility = build_eligibility(snapshot, config, trace)
        writer = ScheduleWriter(snapshot, eligibility=eligibility, trace=trace)

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
            return writer.flush(action=_ACTION)

        surplus_by_bucket = read_clipped_surplus_by_bucket(
            snapshot, max_charge_power_kw=max_charge_power_kw
        )
        tzinfo = build_horizon_start(snapshot.context.now).tzinfo

        # Categorize every horizon slot so the column is fully explained. The
        # hold window / release rationale is genuinely non-derivable, so it is
        # all emitted here (the E rows of the reason catalogue).
        resolutions: dict[date, _DayHoldResolution] = {}

        def _resolution(local_date: date) -> "_DayHoldResolution | None":
            if local_date in resolutions:
                return resolutions[local_date]
            resolved = eligibility.for_day(local_date)
            day_context = snapshot.context.day_contexts.get(local_date)
            if resolved is None or day_context is None:
                return None
            params = resolved.params
            battery_first = params["battery_first"]
            resolution = _resolve_day_hold(
                local_date=local_date,
                day_context=day_context,
                window_start=time_on(
                    params["window"]["start"], local_date, tzinfo=tzinfo
                ),
                window_end=time_on(params["window"]["end"], local_date, tzinfo=tzinfo),
                needed_kwh=_compute_needed_kwh(
                    target_soc=battery_first["target_soc"],
                    current_soc=battery_state.current_soc,
                    usable_capacity_kwh=usable_capacity_kwh,
                    charge_efficiency=charge_efficiency,
                ),
                margin_pct=battery_first["margin_pct"],
                group_label=resolved.group.label,
                surplus_by_bucket=surplus_by_bucket,
                tzinfo=tzinfo,
            )
            resolutions[local_date] = resolution
            return resolution

        applied_by_day: dict[date, list[str]] = {}
        after_release_by_day: dict[date, list[str]] = {}
        no_room_by_day: dict[date, list[str]] = {}
        outside_window: list[str] = []
        day_not_matched: dict[str, list[str]] = {}

        for slot_id in eligibility.horizon_slot_ids:
            slot_start = parse_slot_id(slot_id)
            local_date = slot_start.date()
            resolved = _resolution(local_date)
            if resolved is None:
                day_context = snapshot.context.day_contexts.get(local_date)
                if day_context is None:
                    outside_window.append(slot_id)
                else:
                    day_not_matched.setdefault(day_context.classification, []).append(
                        slot_id
                    )
                continue
            if not (resolved.window_start <= slot_start < resolved.window_end):
                outside_window.append(slot_id)
                continue
            if resolved.release_slot is None:
                no_room_by_day.setdefault(local_date, []).append(slot_id)
                continue
            if slot_start < resolved.release_slot:
                if writer.set_inverter(slot_id, kind=SCHEDULE_ACTION_STOP_CHARGING):
                    applied_by_day.setdefault(local_date, []).append(slot_id)
            else:
                after_release_by_day.setdefault(local_date, []).append(slot_id)

        _emit_charge_hold_decisions(
            trace,
            eligibility=eligibility,
            resolutions=resolutions,
            applied_by_day=applied_by_day,
            after_release_by_day=after_release_by_day,
            no_room_by_day=no_room_by_day,
            outside_window=outside_window,
            day_not_matched=day_not_matched,
        )
        return writer.flush(action=_ACTION)


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
    # Carried per day because `battery_first` is group-overridable: two days can
    # resolve to different groups and so to different needs and margins.
    needed_kwh: float
    margin_pct: float
    group_label: str


def _resolve_day_hold(
    *,
    local_date: date,
    day_context: "DayContext",
    window_start: datetime,
    window_end: datetime,
    needed_kwh: float,
    margin_pct: float,
    group_label: str,
    surplus_by_bucket: list[tuple[datetime, float]],
    tzinfo,
) -> _DayHoldResolution:
    def _resolution(
        release_slot: datetime | None,
        bound_by: str | None,
        surplus_at_window_start: float,
    ) -> _DayHoldResolution:
        return _DayHoldResolution(
            window_start=window_start,
            window_end=window_end,
            release_slot=release_slot,
            bound_by=bound_by,
            surplus_at_window_start=surplus_at_window_start,
            needed_kwh=needed_kwh,
            margin_pct=margin_pct,
            group_label=group_label,
        )

    if window_end <= window_start:
        return _resolution(None, None, 0.0)

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
        threshold = needed_kwh * (1 + margin_pct / 100)
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
            return _resolution(None, None, surplus_at_window_start)
        bound_by = "surplus"

    if day_min_window_start is not None and day_min_window_start < latest_safe_release:
        return _resolution(
            day_min_window_start, "day_min_window", surplus_at_window_start
        )
    return _resolution(latest_safe_release, bound_by, surplus_at_window_start)


def _emit_charge_hold_decisions(
    trace,
    *,
    eligibility: "Eligibility",
    resolutions: dict[date, _DayHoldResolution],
    applied_by_day: dict[date, list[str]],
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
            action=_ACTION,
            reason={
                "code": "hold_window_applied",
                "params": {
                    "neededKwh": round(resolved.needed_kwh, 3),
                    "marginPct": resolved.margin_pct,
                    "releaseSlot": (
                        None
                        if resolved.release_slot is None
                        else format_slot_id(resolved.release_slot)
                    ),
                    "boundBy": resolved.bound_by,
                    "matchedGroup": resolved.group_label,
                },
            },
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
                    "neededKwh": round(resolved.needed_kwh, 3),
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
        code, value = eligibility.rejection(slot_ids[0]) or ("day_not_matched", ())
        trace.decision(
            slot_ids=slot_ids,
            outcome="out_of_scope",
            reason={
                "code": code,
                "params": {
                    "classification": classification,
                    "runWhen": list(value),
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
    **_kwargs: Any,
) -> ChargeHoldOptimizer:
    return ChargeHoldOptimizer(id=config.id)
