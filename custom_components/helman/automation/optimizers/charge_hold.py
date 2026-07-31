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
from ..explain import (
    STATE_FALSE,
    STATE_TRUE,
    STATUS_SKIPPED,
    VERDICT_CANDIDATE,
    VERDICT_EXECUTE,
    VERDICT_SKIP,
)
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

# The gates this kind owns, in the order a slot meets them. None of them lives
# in ``masks_by_key``: the conditions decide *which days* qualify, and every one
# of these decides *which slots of a qualifying day* are held.
#: The run classified this calendar date at all (a 48 h horizon reaches into a
#: date the day-context builder has no forecast for).
GATE_DAY_CONTEXT = "day_context"
#: Some group owns a slot of this date, so the day has params to run under.
#: Day-scoped by construction — ``Eligibility.for_day`` resolves once per date.
GATE_DAY_GROUP_MATCHED = "day_group_matched"
#: The slot falls inside the group's configured hold window.
GATE_HOLD_WINDOW = "hold_window"
#: The day's remaining solar can still refill the battery from *somewhere* in
#: the window. Day-scoped: one release computation serves every slot of the date.
GATE_HOLD_ROOM = "hold_room"
#: The slot precedes the day's release. This is the day-hold release itself —
#: ``params.boundBy`` names what set it (surplus / window_end / day_min_window).
GATE_BEFORE_RELEASE = "before_release"


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
        # Every slot starts at `skip` and is upgraded only where something is
        # actually placed; the condition matrix covers the whole horizon, so a
        # verdict-less slot would read as "never looked at".
        trace.set_verdict(
            slot_ids=eligibility.horizon_slot_ids, verdict=VERDICT_SKIP
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
            # Not "every slot false": nothing was evaluated at all, and only the
            # step status keeps those two readings apart.
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="battery_params_missing"
            )
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
        no_day_context: list[str] = []
        outside_window_by_day: dict[date, list[str]] = {}
        day_not_matched: dict[str, list[str]] = {}
        # Every slot the hold covers, whether or not the writer got to keep it:
        # a user-owned slot passed every gate and still was not written.
        held_by_day: dict[date, list[str]] = {}

        for slot_id in eligibility.horizon_slot_ids:
            slot_start = parse_slot_id(slot_id)
            local_date = slot_start.date()
            resolved = _resolution(local_date)
            if resolved is None:
                day_context = snapshot.context.day_contexts.get(local_date)
                if day_context is None:
                    no_day_context.append(slot_id)
                else:
                    day_not_matched.setdefault(day_context.classification, []).append(
                        slot_id
                    )
                continue
            if not (resolved.window_start <= slot_start < resolved.window_end):
                outside_window_by_day.setdefault(local_date, []).append(slot_id)
                continue
            if resolved.release_slot is None:
                no_room_by_day.setdefault(local_date, []).append(slot_id)
                continue
            if slot_start < resolved.release_slot:
                held_by_day.setdefault(local_date, []).append(slot_id)
                if writer.set_inverter(slot_id, kind=SCHEDULE_ACTION_STOP_CHARGING):
                    applied_by_day.setdefault(local_date, []).append(slot_id)
            else:
                after_release_by_day.setdefault(local_date, []).append(slot_id)

        _emit_charge_hold_gates(
            trace,
            eligibility=eligibility,
            resolutions=resolutions,
            applied_by_day=applied_by_day,
            after_release_by_day=after_release_by_day,
            no_room_by_day=no_room_by_day,
            no_day_context=no_day_context,
            outside_window_by_day=outside_window_by_day,
            day_not_matched=day_not_matched,
            held_by_day=held_by_day,
        )
        _emit_charge_hold_decisions(
            trace,
            applied_by_day=applied_by_day,
            after_release_by_day=after_release_by_day,
            no_room_by_day=no_room_by_day,
            outside_window=[
                slot_id
                for slot_ids in outside_window_by_day.values()
                for slot_id in slot_ids
            ]
            + no_day_context,
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
    applied_by_day: dict[date, list[str]],
    after_release_by_day: dict[date, list[str]],
    no_room_by_day: dict[date, list[str]],
    outside_window: list[str],
    day_not_matched: dict[str, list[str]],
) -> None:
    """The v1 outcome layer: which slots ended in which bucket, and nothing else.

    The rationale that used to ride along as ``reason`` now lives in the gates
    (:func:`_emit_charge_hold_gates`), where it is structured rather than
    prose-coded. What remains is the outcome vocabulary the run explanation
    still reads, plus the slot coverage the trace validator requires.
    """
    for slot_ids in applied_by_day.values():
        trace.decision(slot_ids=slot_ids, outcome="applied", action=_ACTION)
    for slot_ids in after_release_by_day.values():
        trace.decision(slot_ids=slot_ids, outcome="out_of_scope")
    for slot_ids in no_room_by_day.values():
        trace.decision(slot_ids=slot_ids, outcome="rejected")
    if outside_window:
        trace.decision(slot_ids=outside_window, outcome="out_of_scope")
    for slot_ids in day_not_matched.values():
        trace.decision(slot_ids=slot_ids, outcome="out_of_scope")


def _emit_charge_hold_gates(
    trace,
    *,
    eligibility: "Eligibility",
    resolutions: dict[date, _DayHoldResolution],
    applied_by_day: dict[date, list[str]],
    after_release_by_day: dict[date, list[str]],
    no_room_by_day: dict[date, list[str]],
    no_day_context: list[str],
    outside_window_by_day: dict[date, list[str]],
    day_not_matched: dict[str, list[str]],
    held_by_day: dict[date, list[str]],
) -> None:
    """Record the gates in the order a slot meets them, and its verdict.

    A gate is emitted only for the slots that actually reached it: a slot whose
    date was never classified never met the window, so its ``hold_window``
    column is *absent* (``null``) rather than false. Absence and falsehood are
    different claims and the payload keeps them apart.
    """
    if no_day_context:
        trace.gate(
            slot_ids=no_day_context,
            key=GATE_DAY_CONTEXT,
            state=STATE_FALSE,
        )
    for classification, slot_ids in day_not_matched.items():
        # `rejection` names which condition of the first group excluded the day
        # — the failing column, rather than "no group matched".
        code, value = eligibility.rejection(slot_ids[0]) or ("day_not_matched", ())
        trace.gate(slot_ids=slot_ids, key=GATE_DAY_CONTEXT, state=STATE_TRUE)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_DAY_GROUP_MATCHED,
            state=STATE_FALSE,
            params={
                "classification": classification,
                "failingCondition": code,
                "runWhen": list(value),
            },
        )

    def _day_gates(local_date: date, slot_ids: list[str]) -> _DayHoldResolution:
        resolved = resolutions[local_date]
        trace.gate(slot_ids=slot_ids, key=GATE_DAY_CONTEXT, state=STATE_TRUE)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_DAY_GROUP_MATCHED,
            state=STATE_TRUE,
            params={"matchedGroup": resolved.group_label},
        )
        return resolved

    def _window_params(resolved: _DayHoldResolution) -> dict[str, Any]:
        return {
            "start": format_slot_id(resolved.window_start),
            "end": format_slot_id(resolved.window_end),
        }

    def _room_params(resolved: _DayHoldResolution) -> dict[str, Any]:
        return {
            "neededKwh": round(resolved.needed_kwh, 3),
            "marginPct": resolved.margin_pct,
            "surplusAtWindowStart": round(resolved.surplus_at_window_start, 3),
        }

    def _release_params(resolved: _DayHoldResolution) -> dict[str, Any]:
        return {
            "releaseSlot": (
                None
                if resolved.release_slot is None
                else format_slot_id(resolved.release_slot)
            ),
            "boundBy": resolved.bound_by,
        }

    for local_date, slot_ids in outside_window_by_day.items():
        resolved = _day_gates(local_date, slot_ids)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_WINDOW,
            state=STATE_FALSE,
            params=_window_params(resolved),
        )
    for local_date, slot_ids in no_room_by_day.items():
        resolved = _day_gates(local_date, slot_ids)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_WINDOW,
            state=STATE_TRUE,
            params=_window_params(resolved),
        )
        # Day-scoped: even releasing at the window start leaves the day's
        # remaining solar short of the need, so no slot of it can be held.
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_ROOM,
            state=STATE_FALSE,
            params=_room_params(resolved),
        )
    for local_date, slot_ids in after_release_by_day.items():
        resolved = _day_gates(local_date, slot_ids)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_WINDOW,
            state=STATE_TRUE,
            params=_window_params(resolved),
        )
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_ROOM,
            state=STATE_TRUE,
            params=_room_params(resolved),
        )
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_BEFORE_RELEASE,
            state=STATE_FALSE,
            params=_release_params(resolved),
        )
    for local_date, slot_ids in held_by_day.items():
        # Held slots the user owns pass every one of these gates and are still
        # not written, so the gates cover the whole held set while only the
        # slots the writer kept get a non-`skip` verdict.
        resolved = _day_gates(local_date, slot_ids)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_WINDOW,
            state=STATE_TRUE,
            params=_window_params(resolved),
        )
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_ROOM,
            state=STATE_TRUE,
            params=_room_params(resolved),
        )
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_BEFORE_RELEASE,
            state=STATE_TRUE,
            params=_release_params(resolved),
        )
    for slot_ids in applied_by_day.values():
        _stamp_verdicts(trace, eligibility, slot_ids)


def _stamp_verdicts(
    trace, eligibility: "Eligibility", slot_ids: list[str]
) -> None:
    """Upgrade written slots from the ``skip`` baseline.

    ``condition_met`` is read per slot exactly as ``ScheduleWriter`` reads it —
    including its "a slot no group covers counts as met" fallback, since
    ``charge_hold`` resolves its params per *day* and may hold a slot its own
    group never matched.
    """
    for slot_id in slot_ids:
        resolved = eligibility.at(slot_id)
        condition_met = True if resolved is None else resolved.condition_met
        trace.set_verdict(
            slot_ids=[slot_id],
            verdict=VERDICT_EXECUTE if condition_met else VERDICT_CANDIDATE,
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
