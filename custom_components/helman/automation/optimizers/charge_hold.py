"""``charge_hold`` optimizer (use case 1).

On qualifying days, hold the battery out of charging wherever the surplus is
worth more exported than stored, so the battery fills from **the day's cheapest
export slots** and everything dearer is sold. Single pass, read-only over the
input snapshot.

**The charge set, not a release time.** Charging the battery from solar costs
the export revenue that surplus would have earned, so the slots to charge in are
the cheapest ones that together cover the need — which is in general *not* a
contiguous block, and in particular not "everything from the cheapest slot
onward". Anchoring on a release time is what made the hold end *at* the day's
minimum and spill the rest of the charge into the rising prices behind it
(issue #79). So the day resolves to a set: rank every slot from the window start
to the end of the local day by export price, take the cheapest until the need is
covered, and hold every window slot outside that set.

The ranking spans the whole day while the hold only covers the window, because
those are different questions: which slots are *worth* charging in is a fact
about the day, while the window is the user's declaration of where this rule may
write at all. Slots past ``window.end`` are never held — they are free either
way, and ranking them is what lets "hold the whole morning, charge in the
afternoon" fall out of the same arithmetic as "charge at noon".

**The hold ends when the battery reaches target.** Once the charge set has
covered the need, holding on protects nothing — the surplus is worth the same
exported whether the battery is full or not — while denying the battery the
headroom to absorb a consumption peak and take the dip straight back. So every
slot from the last charge-set slot onward joins the charge set: the battery is
free to breathe for the rest of the day.

**The need is measured per day, at that day's window start.** How much the
battery has to take is a fact about the morning the hold governs, not about the
moment the run happens: a 48 h horizon sizes tomorrow too, and the overnight
discharge sits between the two readings. Sizing every day off the run-time SoC
made tomorrow look nearly full, so a single slot covered the phantom need and
the rest of the cheap band was held — leaving the real charge to finish in the
dear afternoon behind it.

Runs **before** ``export_price`` in config order so ``export_price``'s protective
``stop_export`` wins any slot both want.

Day gating lives in the ``run_when`` condition; params resolve per day (R2), so
a group can hold to a later hour or a higher target SoC on surplus days.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
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
from ..rails import (
    read_clipped_surplus_by_bucket,
    read_export_price_by_bucket,
    read_forecast_soc_at,
    slot_bucket_starts,
)
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..conditions import Eligibility
    from ..config import OptimizerInstanceConfig
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
#: The day's remaining solar can still refill the battery at all. Day-scoped:
#: one accounting serves every slot of the date.
GATE_HOLD_ROOM = "hold_room"
#: Where the slot placed in the day's export-price ranking. **An ordinal, not a
#: truth value** — ``params.rank`` / ``params.rankOf`` carry the position, the
#: same shape ``charge_from_grid`` uses for its cheap band.
#:
#: The polarity is the one this module's gates have always had — ``true`` means
#: *this slot is held*. So ``true`` is the slot that lost the ranking: enough
#: cheaper slots already cover the need, and the surplus here is worth more
#: exported. ``false`` releases the slot to charge. (``charge_from_grid`` reads
#: the other way round because there the cut is what it *writes*; here the cut
#: is what it leaves alone.) The diagram requires it this way too: a slot that
#: ends at ``execute`` must have every gate ``true``, or the picture contradicts
#: its own terminal.
GATE_CHEAPEST_RANK = "cheapest_rank"


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

        surplus_by_slot = _read_surplus_by_slot(
            snapshot,
            slot_ids=eligibility.horizon_slot_ids,
            max_charge_power_kw=max_charge_power_kw,
        )
        price_by_slot = _read_export_price_by_slot(
            snapshot, slot_ids=eligibility.horizon_slot_ids
        )
        tzinfo = build_horizon_start(snapshot.context.now).tzinfo

        slots_by_date: dict[date, list[str]] = {}
        for slot_id in eligibility.horizon_slot_ids:
            slots_by_date.setdefault(parse_slot_id(slot_id).date(), []).append(slot_id)

        # Categorize every horizon slot so the column is fully explained. The
        # hold window / ranking rationale is genuinely non-derivable, so it is
        # all emitted here (the E rows of the reason catalogue).
        resolutions: dict[date, _DayHoldResolution] = {}

        def _resolution(local_date: date) -> "_DayHoldResolution | None":
            if local_date in resolutions:
                return resolutions[local_date]
            resolved = eligibility.for_day(local_date)
            if resolved is None or local_date not in snapshot.context.day_contexts:
                return None
            params = resolved.params
            battery_first = params["battery_first"]
            window_start = time_on(params["window"]["start"], local_date, tzinfo=tzinfo)
            # The gap to close is the one the battery will have when this day's
            # window opens, not the one it has at run time: a 48 h horizon sizes
            # tomorrow, and the overnight discharge between the two is exactly
            # what tonight's reading omits. A window already open (today's, on a
            # midday run) reads at `now`, which is where the forecast starts and
            # so is the live SoC either way.
            start_soc = _soc_at_window_start(
                snapshot,
                window_start=window_start,
                fallback_soc=battery_state.current_soc,
            )
            resolution = _resolve_day_hold(
                window_start=window_start,
                window_end=time_on(params["window"]["end"], local_date, tzinfo=tzinfo),
                needed_kwh=_compute_needed_kwh(
                    target_soc=battery_first["target_soc"],
                    current_soc=start_soc,
                    usable_capacity_kwh=usable_capacity_kwh,
                    charge_efficiency=charge_efficiency,
                ),
                start_soc=start_soc,
                margin_pct=battery_first["margin_pct"],
                group_label=resolved.group.label,
                day_slot_ids=slots_by_date.get(local_date, []),
                surplus_by_slot=surplus_by_slot,
                price_by_slot=price_by_slot,
            )
            resolutions[local_date] = resolution
            return resolution

        applied_by_day: dict[date, list[str]] = {}
        released_by_day: dict[date, list[str]] = {}
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
            if not resolved.has_room:
                no_room_by_day.setdefault(local_date, []).append(slot_id)
                continue
            if slot_id in resolved.released:
                released_by_day.setdefault(local_date, []).append(slot_id)
                continue
            held_by_day.setdefault(local_date, []).append(slot_id)
            if writer.set_inverter(slot_id, kind=SCHEDULE_ACTION_STOP_CHARGING):
                applied_by_day.setdefault(local_date, []).append(slot_id)

        _emit_charge_hold_gates(
            trace,
            eligibility=eligibility,
            resolutions=resolutions,
            applied_by_day=applied_by_day,
            released_by_day=released_by_day,
            no_room_by_day=no_room_by_day,
            no_day_context=no_day_context,
            outside_window_by_day=outside_window_by_day,
            day_not_matched=day_not_matched,
            held_by_day=held_by_day,
        )
        _emit_charge_hold_decisions(
            trace,
            applied_by_day=applied_by_day,
            released_by_day=released_by_day,
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


def _soc_at_window_start(
    snapshot: "OptimizationSnapshot",
    *,
    window_start: datetime,
    fallback_soc: float,
) -> float:
    """The day's starting SoC, forecast where the window is still ahead.

    Clamped to ``now`` because the forecast begins there: a window that opened
    hours ago has no forecast point before it, and the battery's own reading is
    the honest answer for the stretch that is already running. A forecast with
    no SoC at all falls back the same way, which is what keeps this readable
    against a series that carries only solar and house figures.
    """
    read_at = max(
        dt_util.as_utc(window_start), dt_util.as_utc(snapshot.context.now)
    )
    forecast_soc = read_forecast_soc_at(snapshot, read_at)
    return fallback_soc if forecast_soc is None else forecast_soc


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
class _RankedSlot:
    """One candidate slot's place in the day's export-price ranking."""

    slot_id: str
    rank: int  # 1-based
    price: float | None  # None = the export feed says nothing about this slot
    surplus_kwh: float
    #: Need covered by this slot and every cheaper one — only for a slot that is
    #: actually in the charge set. A held slot contributes nothing, so quoting a
    #: running total against it would read as energy it supplies.
    cumulative_kwh: float | None


@dataclass(frozen=True)
class _DayHoldResolution:
    window_start: datetime
    window_end: datetime
    #: The day's slots that may charge: the cheapest prefix of the ranking that
    #: covers the threshold, plus everything from ``charge_complete_at`` on.
    #: Slots outside the window are in here too, because the ranking spans the
    #: day; the hold only ever consults window slots.
    released: frozenset[str]
    #: When the charge set reaches the target — after this the battery is free.
    #: ``None`` only when the day's surplus never covers the need, which is the
    #: no-room case and holds nothing regardless.
    charge_complete_at: datetime | None
    #: Rank record per *window* slot, for the gate. Keyed by slot id.
    ranked_by_slot: dict[str, _RankedSlot]
    rank_of: int
    #: Price of the dearest slot that made the charge set — what every held slot
    #: lost to.
    marginal_price: float | None
    has_room: bool
    surplus_at_window_start: float
    threshold_kwh: float
    # Carried per day because `battery_first` is group-overridable: two days can
    # resolve to different groups and so to different needs and margins.
    needed_kwh: float
    #: SoC the day's window opens at — what `needed_kwh` was measured from.
    start_soc: float
    margin_pct: float
    group_label: str


def _resolve_day_hold(
    *,
    window_start: datetime,
    window_end: datetime,
    needed_kwh: float,
    start_soc: float,
    margin_pct: float,
    group_label: str,
    day_slot_ids: list[str],
    surplus_by_slot: dict[str, float],
    price_by_slot: dict[str, float],
) -> _DayHoldResolution:
    """Rank the day's slots by export price and cut at the need.

    Candidates run from ``window_start`` to the end of the local day — only this
    calendar day's own solar can refill the battery for this day's hold, and
    ``day_slot_ids`` is already scoped to the date, so no part of tomorrow's
    forecast can leak in.
    """
    threshold = max(0.0, needed_kwh) * (1 + margin_pct / 100)
    # A slot with no surplus is not a place the battery can charge, so it takes
    # no place in the ranking: letting it into the cheap prefix would spend a
    # rank on nothing and read as "released" where there is nothing to release.
    # Left out of the ranking it is simply held, as every pre-dawn slot was
    # under the release model.
    candidates = [
        slot_id
        for slot_id in day_slot_ids
        if parse_slot_id(slot_id) >= window_start
        and surplus_by_slot.get(slot_id, 0.0) > 0
    ]
    # Cheapest first; ties go to the earlier slot, which banks the charge sooner
    # and so leaves more of the day to recover from a short forecast. An unknown
    # price sorts last: it is only ever charged into as a last resort.
    ranking = sorted(
        candidates,
        key=lambda slot_id: (
            price_by_slot.get(slot_id, float("inf")),
            dt_util.as_utc(parse_slot_id(slot_id)),
        ),
    )

    charge_set: set[str] = set()
    ranked: list[_RankedSlot] = []
    cumulative = 0.0
    covered = cumulative >= threshold
    for index, slot_id in enumerate(ranking):
        surplus_kwh = surplus_by_slot.get(slot_id, 0.0)
        in_charge_set = not covered
        if in_charge_set:
            cumulative += surplus_kwh
            charge_set.add(slot_id)
            covered = cumulative >= threshold
        ranked.append(
            _RankedSlot(
                slot_id=slot_id,
                rank=index + 1,
                price=price_by_slot.get(slot_id),
                surplus_kwh=surplus_kwh,
                cumulative_kwh=cumulative if in_charge_set else None,
            )
        )

    # `covered` is the room test: the ranking walks every slot of the day from
    # the window start, so failing to reach the threshold means the day's whole
    # remaining surplus falls short and no slot of it can be held.
    marginal_price: float | None = None
    if covered and charge_set:
        prices = [
            record.price
            for record in ranked
            if record.slot_id in charge_set and record.price is not None
        ]
        marginal_price = max(prices) if prices else None

    # Where the charge set finishes the job — the instant the battery is at
    # target and the hold has nothing left to protect. An empty charge set on a
    # covered day means the need was already zero, so that instant is the window
    # start itself. Not covered at all is the no-room case, which holds nothing
    # anyway.
    charge_complete_at: datetime | None = None
    if covered:
        charge_complete_at = (
            max(parse_slot_id(slot_id) for slot_id in charge_set)
            if charge_set
            else window_start
        )
        # Past that instant the battery may charge freely. Holding on would buy
        # nothing — the surplus it protects is worth the same exported whether
        # the battery is full or not — while costing the battery its headroom to
        # ride a consumption peak and take the dip straight back. Every slot
        # qualifies, not just the ranked ones: a slot with no surplus of its own
        # is still a slot the battery should be free to move in.
        charge_set.update(
            slot_id
            for slot_id in day_slot_ids
            if parse_slot_id(slot_id) >= charge_complete_at
        )

    return _DayHoldResolution(
        window_start=window_start,
        window_end=window_end,
        released=frozenset(charge_set),
        charge_complete_at=charge_complete_at,
        ranked_by_slot={
            record.slot_id: record
            for record in ranked
            if parse_slot_id(record.slot_id) < window_end
        },
        rank_of=len(ranked),
        marginal_price=marginal_price,
        has_room=covered and window_end > window_start,
        surplus_at_window_start=sum(
            surplus_by_slot.get(slot_id, 0.0) for slot_id in candidates
        ),
        threshold_kwh=threshold,
        needed_kwh=needed_kwh,
        start_soc=start_soc,
        margin_pct=margin_pct,
        group_label=group_label,
    )


def _emit_charge_hold_decisions(
    trace,
    *,
    applied_by_day: dict[date, list[str]],
    released_by_day: dict[date, list[str]],
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
    for slot_ids in released_by_day.values():
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
    released_by_day: dict[date, list[str]],
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
        # — the failing column, rather than "no group matched". The fallback is
        # `run_when` because a day landing here was classified and rejected on
        # its classification; the only way `rejection` returns `None` is a
        # config with no condition groups at all.
        #
        # `list(value)` is safe because `charge_hold` declares
        # `condition_types=("run_when",)` (spec.py) and the config layer rejects
        # any other key, so the value here is always a tuple of classifications
        # — never one of the scalar slot-scoped thresholds (issue #15). The
        # param is keyed `conditionValue` to match `appliance_runtime`, which is
        # also what the explanation UI has labels for.
        key, value = eligibility.rejection(slot_ids[0]) or ("run_when", ())
        trace.gate(slot_ids=slot_ids, key=GATE_DAY_CONTEXT, state=STATE_TRUE)
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_DAY_GROUP_MATCHED,
            state=STATE_FALSE,
            params={
                "classification": classification,
                "failingCondition": key,
                "conditionValue": list(value),
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
            # The SoC the need was measured from — the one number that makes a
            # surprising `neededKwh` legible instead of arbitrary.
            "startSocPct": round(resolved.start_soc, 2),
            "marginPct": resolved.margin_pct,
            "surplusAtWindowStart": round(resolved.surplus_at_window_start, 3),
            "thresholdKwh": round(resolved.threshold_kwh, 3),
        }

    def _emit_rank(
        local_date: date, slot_ids: list[str], *, state: str
    ) -> None:
        """One gate per slot: the ranking is the one thing that differs per slot."""
        resolved = resolutions[local_date]
        for slot_id in slot_ids:
            record = resolved.ranked_by_slot.get(slot_id)
            trace.gate(
                slot_ids=[slot_id],
                key=GATE_CHEAPEST_RANK,
                state=state,
                params={
                    "rank": None if record is None else record.rank,
                    "rankOf": resolved.rank_of,
                    "price": None if record is None else _rounded(record.price),
                    "marginalPrice": _rounded(resolved.marginal_price),
                    "slotSurplusKwh": (
                        None if record is None else round(record.surplus_kwh, 3)
                    ),
                    "cumulativeKwh": (
                        None
                        if record is None or record.cumulative_kwh is None
                        else round(record.cumulative_kwh, 3)
                    ),
                    "thresholdKwh": round(resolved.threshold_kwh, 3),
                },
            )

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
        # Day-scoped: the day's whole remaining surplus falls short of the need,
        # so no slot of it can be held.
        trace.gate(
            slot_ids=slot_ids,
            key=GATE_HOLD_ROOM,
            state=STATE_FALSE,
            params=_room_params(resolved),
        )
    for local_date, slot_ids in released_by_day.items():
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
        _emit_rank(local_date, slot_ids, state=STATE_FALSE)
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
        _emit_rank(local_date, slot_ids, state=STATE_TRUE)
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


def _rounded(value: float | None) -> float | None:
    return None if value is None else round(value, 4)


def _read_surplus_by_slot(
    snapshot: "OptimizationSnapshot",
    *,
    slot_ids: list[str],
    max_charge_power_kw: float,
) -> dict[str, float]:
    """Charge-able surplus per schedule slot, from the finer forecast buckets.

    Buckets are assigned to the slot that *contains* them rather than looked up
    by :func:`slot_bucket_starts`, because the first bucket of a run starts at
    ``now`` and so is off the canonical grid — an exact lookup would silently
    drop the current slot's surplus.
    """
    by_slot: dict[str, float] = {}
    slot_start_by_time = {parse_slot_id(slot_id): slot_id for slot_id in slot_ids}
    if not slot_start_by_time:
        return by_slot
    starts = sorted(slot_start_by_time, key=dt_util.as_utc)
    for bucket_start, surplus_kwh in read_clipped_surplus_by_bucket(
        snapshot, max_charge_power_kw=max_charge_power_kw
    ):
        containing = _slot_containing(starts, bucket_start)
        if containing is None:
            continue
        slot_id = slot_start_by_time[containing]
        by_slot[slot_id] = by_slot.get(slot_id, 0.0) + surplus_kwh
    return by_slot


def _slot_containing(
    starts: list[datetime], bucket_start: datetime
) -> datetime | None:
    """The latest slot start at or before ``bucket_start``, if it spans it."""
    bucket_utc = dt_util.as_utc(bucket_start)
    latest: datetime | None = None
    for start in starts:
        if dt_util.as_utc(start) <= bucket_utc:
            latest = start
        else:
            break
    if latest is None or dt_util.as_utc(latest) + _SLOT_DURATION <= bucket_utc:
        return None
    return latest


def _read_export_price_by_slot(
    snapshot: "OptimizationSnapshot", *, slot_ids: list[str]
) -> dict[str, float]:
    """Export price per schedule slot, or absent where the feed says nothing.

    The rail already forward-fills the published points onto the canonical
    buckets and stops at the end of the published day, so a slot's price is the
    mean over the buckets it spans — within a slot they are all but always the
    same value, and averaging never invents one where the day has ended.
    """
    price_by_bucket = read_export_price_by_bucket(snapshot)
    by_slot: dict[str, float] = {}
    for slot_id in slot_ids:
        known = [
            price
            for bucket_start in slot_bucket_starts(slot_id)
            if (price := price_by_bucket.get(bucket_start)) is not None
        ]
        if known:
            by_slot[slot_id] = sum(known) / len(known)
    return by_slot


def build_charge_hold_optimizer(
    config: "OptimizerInstanceConfig",
    **_kwargs: Any,
) -> ChargeHoldOptimizer:
    return ChargeHoldOptimizer(id=config.id)
