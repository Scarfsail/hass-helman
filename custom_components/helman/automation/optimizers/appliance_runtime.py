"""``appliance_runtime`` optimizer — when an appliance may run, and how long.

One behavioural fork, on whether ``daily_minimum`` is configured:

* **capped** — accumulate at least ``min_hours_per_day`` within the window,
  placing the remaining hours on the cheapest slots and preferring slots the
  day's solar surplus already covers. Stateless beyond the framework's A2
  runtime input; manual runs count automatically because they show up in
  history.
* **uncapped** — place on *every* slot the conditions allow. Nothing ranks:
  with no deficit to size a placement against, price and solar coverage
  discriminate between nothing. The gate is the conditions plus the optional
  window, so an uncapped optimizer with neither would mean "on 24/7" — which
  the config reader rejects.

Day gating is the ``run_when`` condition — on a day no group matches, nothing is
placed. ``max_run_price`` and ``min_soc_pct`` narrow further, per slot: the
day still runs, but only the window slots whose price or projected SoC clears
the threshold may be chosen. So the matched group decides the day's *params*
while its mask decides the day's *slots*, which is why capped placement ranks
``plan.placeable_slots`` and not the whole window.

Capped placement additionally treats the slot being *executed right now* as a
commitment rather than a free variable: if the appliance is running and its
current slot survived ranking, that slot is promoted to the front so the
shrinking ``slots_needed`` cut cannot drop it mid-run. Promotion only — every
condition that gates placement still stops the appliance the moment it stops
holding.

``max_consecutive_skips`` is the one construct that defeats the whole OR chain:
after that many consecutive short days the optimizer runs anyway, past every
group's ``custom`` conditions and past every slot condition, over the full
window, carrying its own ``consecutive_skip_override`` gate so a forced run
never reads as an unexplained one. It is ``overridable=False`` — it describes
the chain, not any one day in it, so no single group can own it.

Explanation-wise this is the richest kind in the pipeline. The conditions decide
which days run and which of a day's slots are eligible; everything after that is
this module's own — the window, the daily-minimum bookkeeping, the day's
capacity, the cheapness ranking (an **ordinal**, never a boolean) and the
self-sustainability gate, whose result the rails cannot compute at all. Capped
placement stops consulting that gate once ``slots_needed`` is met, so the slots
below the cut stay ``not_evaluated`` rather than ``false``: they were never
tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import ceil
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...const import SCHEDULE_SLOT_MINUTES
from ...scheduling.schedule import (
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
    iter_horizon_slot_ids,
    parse_slot_id,
)
from ..base import ApplianceTarget, ScheduleWriter, resolve_appliance_target
from ..conditions import build_eligibility
from ..conditions.types import ConditionRailsUnavailable
from ..explain import (
    STATE_FALSE,
    STATE_TRUE,
    STATUS_SKIPPED,
    VERDICT_CANDIDATE,
    VERDICT_EXECUTE,
    VERDICT_SKIP,
)
from ..fields import time_on
from ..ownership import is_user_owned_appliance_action
from ..rails import (
    horizon_slots_between,
    read_available_surplus_by_bucket,
    read_price_by_bucket,
    read_when_active_hourly_energy_kwh,
    slot_solar_coverage_pct,
)
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ...appliances import AppliancesRuntimeRegistry
    from ..conditions import Eligibility
    from ..config import OptimizerInstanceConfig
    from ..day_context import DayContext
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace
    from .self_sustainability import Trajectory

_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60

# "≈ 0" for strict's day-balance test. Both are the inspector's own rail
# epsilons (`RAIL_METRICS` in automation-inspector-model.ts): a difference the
# UI would not render as a change is not one to reject a placement over.
_STRICT_SOC_TOLERANCE_PCT = 0.5
_STRICT_IMPORT_TOLERANCE_KWH = 0.05

# The gates this kind owns. None of them lives in ``masks_by_key``: the
# conditions decide which *days* run and which of a day's slots are eligible,
# and every one of these decides what happens to an eligible slot afterwards.
# A gate is emitted only for the slots that actually reached it, so an absent
# column means "never got that far", which is not the same as ``false``.
#: The slot falls inside the day's configured ``window``. Emitted only when a
#: window is configured — without one the whole day is the window and the gate
#: would discriminate between nothing.
GATE_RUN_WINDOW = "run_window"
#: Some group owns a slot of this date, so the day has params to run under.
#: Day-scoped: ``Eligibility.for_day`` resolves once per date.
GATE_DAY_GROUP_MATCHED = "day_group_matched"
#: The daily-minimum bookkeeping: hours still owed after what history already
#: delivered. ``false`` means the day is already satisfied — nothing is placed
#: however cheap the remaining slots are.
GATE_DAILY_MINIMUM_REMAINING = "daily_minimum_remaining"
#: The slots the matched group owns inside the window can carry the whole
#: deficit. ``false`` still places what the day allows, so it reads as "the day
#: will under-run", not "nothing was placed".
GATE_PLACEMENT_CAPACITY = "placement_capacity"
#: ``max_consecutive_skips`` fired: the day runs past every group and every
#: condition. Emitted only on a forced day; absence means "not forced".
GATE_CONSECUTIVE_SKIP_OVERRIDE = "consecutive_skip_override"
#: The slot is writable at all — user-owned slots are dropped before the
#: ranking, so the writer never sees them and cannot veto them itself.
GATE_SLOT_AVAILABLE = "slot_available"
#: Where the slot placed in the day's ranking. **An ordinal, not a truth
#: value**: ``params.rank`` / ``params.rankOf`` carry the position and ``state``
#: only says whether the placement cut reached the slot ("you lost to 4 cheaper
#: slots" is not a boolean). A slot the cut reached may still be refused by
#: ``ensure_self_sustainability``, which is a separate node.
GATE_CHEAPEST_RANK = "cheapest_rank"


@dataclass(frozen=True)
class _DayPlan:
    """The params one day runs under, where it may run, and why it runs at all."""

    params: dict[str, Any]
    #: Every slot of the daily window, whether or not it is eligible.
    window_slots: list[str]
    #: The subset the matched group actually owns — what ranking may choose
    #: from. Equal to ``window_slots`` on a forced run, which ignores conditions.
    placeable_slots: list[str]
    group_label: str | None
    forced_after_skips: int | None
    #: The matched group's config index, or ``None`` on a forced run (which
    #: matched no group). Explanation-only: it is what lets the optimizer
    #: resolve this day's ``ensure_self_sustainability`` node in the *right*
    #: group's column instead of every group's.
    group_index: int | None = None
    #: The matched group's ``ensure_self_sustainability``, or ``None`` when it
    #: set none — and always ``None`` on a forced run, which bypasses it as it
    #: bypasses every other condition.
    #:
    #: Constant across the day by construction: capped placement intersects the
    #: window with the resolved group's own slots, so every placeable slot of a
    #: day belongs to the same group, hence the same level and the same resolved
    #: ``margin_pct``. No "the floor moves mid-day" rule is needed.
    self_sustainability: str | None = None


@dataclass(frozen=True)
class ApplianceRuntimeOptimizer:
    id: str
    target: ApplianceTarget
    kind: str = "appliance_runtime"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        trace = trace or NULL_TRACE
        try:
            return self._optimize(snapshot, config, trace)
        except ConditionRailsUnavailable:
            # The pipeline turns this into a skipped step. Stamp the status here,
            # where the cause is known: without it the explanation is a horizon
            # of slots that read as uniformly false, which is exactly the
            # confusion `ConditionRailsUnavailable` exists to prevent.
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="condition_rails_unavailable"
            )
            raise

    def _optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace",
    ) -> ScheduleDocument:
        # Slots outside the daily window are "not considered" — left to a
        # frontend default (D); only the placement/ranking rationale is emitted.
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))

        eligibility = build_eligibility(snapshot, config, trace)
        # Every slot starts at `skip` and is upgraded only where something is
        # actually written: the condition matrix covers the whole horizon, so a
        # verdict-less slot would read as "never looked at".
        trace.set_verdict(
            slot_ids=eligibility.horizon_slot_ids, verdict=VERDICT_SKIP
        )
        appliance_id = self.target.appliance.id
        appliance_domain = f"appliance:{appliance_id}"
        # Capped mode ranks, and `_rank_slots` drops user-owned slots and reports
        # that as `slot_available`, so the writer's veto would only restate it.
        # Uncapped mode does not rank at all: there the veto is the only node
        # that speaks about ownership, so it keeps its say.
        capped = config.params.get("daily_minimum") is not None
        writer = ScheduleWriter(
            snapshot,
            eligibility=eligibility,
            trace=trace,
            domain=appliance_domain,
            pre_filters_ownership=capped,
        )
        action = {"domain": appliance_domain, **self.target.authored_action}

        # Master params decide the mode: `daily_minimum` is not something a group
        # can introduce (its required, non-overridable `max_consecutive_skips`
        # makes a partial override unreadable), so this is stable across groups.
        if not capped:
            return self._optimize_uncapped(
                snapshot=snapshot,
                config=config,
                eligibility=eligibility,
                writer=writer,
                trace=trace,
                action=action,
            )

        runtime_by_date = (
            snapshot.context.runtime_hours_by_appliance_id_by_local_date.get(
                appliance_id, {}
            )
        )
        available_surplus_by_bucket = read_available_surplus_by_bucket(snapshot)
        demand_hourly_energy = read_when_active_hourly_energy_kwh(
            snapshot, appliance_id
        )
        export_price_by_bucket = read_price_by_bucket(
            snapshot.context.export_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)
        tzinfo = horizon_start.tzinfo

        gate = _SelfSustainabilityGate.for_run(
            snapshot=snapshot,
            config=config,
            appliance_id=appliance_id,
            demand_hourly_energy=demand_hourly_energy,
        )

        horizon_slots_by_date = _horizon_slots_by_date(eligibility.horizon_slot_ids)

        # The day loop must run chronologically, and does: `build_day_contexts`
        # inserts in sorted date order and every hop preserves it. That used to
        # be incidental; with self-sustainability it is load-bearing, because
        # day 1's placements lower day 2's trajectory.
        for local_date, day_context in snapshot.context.day_contexts.items():
            delivered_hours = runtime_by_date.get(local_date, 0.0)
            plan = self._plan_for_day(
                local_date=local_date,
                config=config,
                eligibility=eligibility,
                runtime_by_date=runtime_by_date,
                delivered_hours=delivered_hours,
                horizon_start=horizon_start,
                horizon_end=horizon_end,
                tzinfo=tzinfo,
            )
            params = config.params if plan is None else plan.params
            min_hours_per_day = params["daily_minimum"]["min_hours_per_day"]
            window_slots = (
                self._window_slots(
                    params=params,
                    local_date=local_date,
                    horizon_start=horizon_start,
                    horizon_end=horizon_end,
                    tzinfo=tzinfo,
                )
                if plan is None
                else plan.window_slots
            )

            _trace_run_window(
                trace=trace,
                params=params,
                window_slots=window_slots,
                day_slots=horizon_slots_by_date.get(local_date) or [],
            )

            remaining_hours = min_hours_per_day - delivered_hours
            slots_needed = ceil(remaining_hours / _SLOT_HOURS)
            # The daily-minimum bookkeeping, as a gate rather than as prose: what
            # the day owes after what history already delivered. `false` is the
            # already-satisfied day, on which nothing is placed however cheap the
            # remaining slots are.
            minimum_params: dict[str, Any] = {
                "minHours": min_hours_per_day,
                "doneHours": round(delivered_hours, 3),
                "remainingHours": round(remaining_hours, 3),
            }
            if remaining_hours <= 0:
                if window_slots:
                    trace.gate(
                        slot_ids=window_slots,
                        key=GATE_DAILY_MINIMUM_REMAINING,
                        state=STATE_FALSE,
                        params=minimum_params,
                    )
                    trace.decision(slot_ids=window_slots, outcome="out_of_scope")
                continue
            if window_slots:
                trace.gate(
                    slot_ids=window_slots,
                    key=GATE_DAILY_MINIMUM_REMAINING,
                    state=STATE_TRUE,
                    params={**minimum_params, "slotsNeeded": slots_needed},
                )

            if plan is None:
                _trace_unmatched_day(
                    trace=trace,
                    eligibility=eligibility,
                    window_slots=window_slots,
                    day_context=day_context,
                )
                continue

            if window_slots:
                # A forced day matched no group and runs anyway; the override
                # gate is what says so, and it is absent on every ordinary day.
                trace.gate(
                    slot_ids=window_slots,
                    key=GATE_DAY_GROUP_MATCHED,
                    state=STATE_FALSE if plan.group_label is None else STATE_TRUE,
                    params={"matchedGroup": plan.group_label},
                )
                if plan.forced_after_skips is not None:
                    trace.gate(
                        slot_ids=window_slots,
                        key=GATE_CONSECUTIVE_SKIP_OVERRIDE,
                        state=STATE_TRUE,
                        params={
                            "consecutiveSkips": plan.forced_after_skips,
                            "maxConsecutiveSkips": config.params["daily_minimum"][
                                "max_consecutive_skips"
                            ],
                        },
                    )
                trace.gate(
                    slot_ids=window_slots,
                    key=GATE_PLACEMENT_CAPACITY,
                    state=(
                        STATE_TRUE
                        if len(plan.placeable_slots) >= slots_needed
                        else STATE_FALSE
                    ),
                    params={
                        "slotsNeeded": slots_needed,
                        "slotsPlaceable": len(plan.placeable_slots),
                        "windowSlots": len(window_slots),
                    },
                )

            _trace_window_exclusions(
                trace=trace,
                eligibility=eligibility,
                window_slots=window_slots,
                placeable=set(plan.placeable_slots),
            )

            ranked = _rank_slots(
                document=writer.document,
                appliance_id=appliance_id,
                window_slots=plan.placeable_slots,
                available_surplus_by_bucket=available_surplus_by_bucket,
                demand_hourly_energy=demand_hourly_energy,
                export_price_by_bucket=export_price_by_bucket,
                reference_time=snapshot.context.now,
                # A forced run bypasses self-sustainability as it bypasses every
                # other condition, but it need not be gratuitous about it:
                # ranking by coverage first takes the slots that move the SoC
                # least. The coverage flag is already computed.
                prefer_covered=plan.forced_after_skips is not None,
            )
            ranked = _promote_in_flight_slot(
                ranked,
                active=snapshot.context.appliance_active_by_id.get(
                    appliance_id, False
                ),
                active_slot_id=format_slot_id(horizon_start),
            )
            # Placeable slots the user owns never enter the ranking, so the
            # writer never sees them and its own veto cannot speak for them.
            rankable = {slot_id for _cost, slot_id in ranked}
            unavailable = [
                slot_id
                for slot_id in plan.placeable_slots
                if slot_id not in rankable
            ]
            if unavailable:
                trace.gate(
                    slot_ids=unavailable,
                    key=GATE_SLOT_AVAILABLE,
                    state=STATE_FALSE,
                )
            if rankable:
                trace.gate(
                    slot_ids=sorted(rankable),
                    key=GATE_SLOT_AVAILABLE,
                    state=STATE_TRUE,
                )

            chosen, floor_rejected, not_reached = gate.take(
                ranked,
                slots_needed=slots_needed,
                plan=plan,
            )
            _trace_ranking(
                trace=trace,
                ranked=ranked,
                chosen=chosen,
                floor_rejected=floor_rejected,
                slots_needed=slots_needed,
            )
            _resolve_self_sustainability(
                trace=trace,
                plan=plan,
                chosen=chosen,
                floor_rejected=floor_rejected,
            )
            for _cost, slot_id in chosen:
                if not writer.set_appliance(
                    slot_id,
                    appliance_id=appliance_id,
                    action=self.target.authored_action,
                ):
                    # User-owned: `base.py` records the veto and the slot keeps
                    # its `skip` baseline. Unreachable while `_rank_slots` drops
                    # those slots, but the verdict must not outrun the write.
                    continue
                resolved_slot = eligibility.at(slot_id)
                trace.set_verdict(
                    slot_ids=[slot_id],
                    verdict=(
                        VERDICT_EXECUTE
                        if resolved_slot is None or resolved_slot.condition_met
                        else VERDICT_CANDIDATE
                    ),
                )
            if chosen:
                trace.decision(
                    slot_ids=[slot_id for _cost, slot_id in chosen],
                    outcome="applied",
                    action=action,
                )
            for slot_id, _detail in floor_rejected:
                trace.decision(slot_ids=[slot_id], outcome="rejected")
            if not_reached:
                trace.decision(
                    slot_ids=[slot_id for _cost, slot_id in not_reached],
                    outcome="rejected",
                )

        return writer.flush(action=action)

    def _optimize_uncapped(
        self,
        *,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        eligibility: "Eligibility",
        writer: ScheduleWriter,
        trace: "OptimizerTrace",
        action: dict[str, Any],
    ) -> ScheduleDocument:
        """Place on every eligible slot, with no deficit to size the placement.

        There is nothing to rank: without a cap every slot the conditions allow
        is taken, so neither price nor solar coverage discriminates. The gate is
        the conditions plus the optional window, and nothing else.
        """
        appliance_id = self.target.appliance.id
        window = _window_slot_ids(config.params, snapshot)
        gate = _SelfSustainabilityGate.for_run(
            snapshot=snapshot,
            config=config,
            appliance_id=appliance_id,
            demand_hourly_energy=read_when_active_hourly_energy_kwh(
                snapshot, appliance_id
            ),
        )

        window_params = (
            None
            if not config.params.get("window")
            else {
                "start": config.params["window"]["start"],
                "end": config.params["window"]["end"],
            }
        )

        applied_by_group: dict[int, list[str]] = {}
        # `iter_slots` yields in horizon order, which is what the coupled
        # self-sustainability constraint needs: uncapped mode has no ranking, so
        # chronological is the only defensible acceptance order.
        for resolved in eligibility.iter_slots():
            if window is not None:
                inside = resolved.slot_id in window
                trace.gate(
                    slot_ids=[resolved.slot_id],
                    key=GATE_RUN_WINDOW,
                    state=STATE_TRUE if inside else STATE_FALSE,
                    params=window_params,
                )
                if not inside:
                    continue
            level = resolved.condition_value("ensure_self_sustainability")
            rejection = gate.accept(
                resolved.slot_id,
                level=level,
                params=resolved.params,
            )
            if level is not None:
                # The self-gating node's real result, which the rails leave
                # `not_evaluated`. Order-dependent by construction: acceptance is
                # greedy, so this is a log of what this run found when it reached
                # the slot, not a function of the slot alone.
                trace.resolve_condition(
                    slot_ids=[resolved.slot_id],
                    key="ensure_self_sustainability",
                    state=STATE_FALSE if rejection is not None else STATE_TRUE,
                    value=level,
                    actual=rejection,
                    group_index=resolved.group.index,
                )
            if rejection is not None:
                trace.decision(slot_ids=[resolved.slot_id], outcome="rejected")
                continue
            if writer.set_appliance(
                resolved.slot_id,
                appliance_id=appliance_id,
                action=self.target.authored_action,
            ):
                applied_by_group.setdefault(resolved.group.index, []).append(
                    resolved.slot_id
                )
                trace.set_verdict(
                    slot_ids=[resolved.slot_id],
                    verdict=(
                        VERDICT_EXECUTE
                        if resolved.condition_met
                        else VERDICT_CANDIDATE
                    ),
                )

        for slot_ids in applied_by_group.values():
            trace.decision(slot_ids=slot_ids, outcome="applied", action=action)
        return writer.flush(action=action)

    def _plan_for_day(
        self,
        *,
        local_date: date,
        config: "OptimizerInstanceConfig",
        eligibility: "Eligibility",
        runtime_by_date: dict[date, float],
        delivered_hours: float,
        horizon_start: datetime,
        horizon_end: datetime,
        tzinfo: Any,
    ) -> _DayPlan | None:
        """Which params today runs under and where, or ``None`` when it is skipped.

        Two ways a day can come up short, and both feed the same escape hatch:
        no group matched it at all, or a group matched but its slot-scoped
        conditions leave too few slots to cover the deficit. The second is new
        with ``max_run_price`` — without it, a day whose prices never drop
        below the threshold would under-run silently and forever, because
        forcing would only ever fire for the first case.
        """
        resolved = eligibility.for_day(local_date)
        short_plan: _DayPlan | None = None
        if resolved is not None:
            window_slots = self._window_slots(
                params=resolved.params,
                local_date=local_date,
                horizon_start=horizon_start,
                horizon_end=horizon_end,
                tzinfo=tzinfo,
            )
            owned = eligibility.slot_ids_owned_by(resolved.group)
            placeable = [slot for slot in window_slots if slot in owned]
            plan = _DayPlan(
                params=resolved.params,
                window_slots=window_slots,
                placeable_slots=placeable,
                group_label=resolved.group.label,
                forced_after_skips=None,
                group_index=resolved.group.index,
                self_sustainability=resolved.condition_value(
                    "ensure_self_sustainability"
                ),
            )
            remaining_hours = (
                resolved.params["daily_minimum"]["min_hours_per_day"] - delivered_hours
            )
            if remaining_hours <= 0 or len(placeable) * _SLOT_HOURS >= remaining_hours:
                return plan
            short_plan = plan

        # Skipping (or under-running) today extends the run by one; once that
        # would pass max_consecutive_skips the optimizer runs anyway — past
        # every group, including their `custom` conditions and their price
        # threshold. Master params, since no group's override governs a run that
        # matched no group.
        master_daily_minimum = config.params["daily_minimum"]
        consecutive_skips = (
            _prior_consecutive_skips(
                local_date=local_date,
                runtime_by_date=runtime_by_date,
                min_hours_per_day=master_daily_minimum["min_hours_per_day"],
            )
            + 1
        )
        if consecutive_skips <= master_daily_minimum["max_consecutive_skips"]:
            # Not yet due a forced run: place what the group does allow, so a
            # partially-eligible day still delivers what it can.
            return short_plan
        forced_window = self._window_slots(
            params=config.params,
            local_date=local_date,
            horizon_start=horizon_start,
            horizon_end=horizon_end,
            tzinfo=tzinfo,
        )
        return _DayPlan(
            params=config.params,
            window_slots=forced_window,
            placeable_slots=forced_window,
            group_label=None,
            forced_after_skips=consecutive_skips,
        )

    @staticmethod
    def _window_slots(
        *,
        params: dict[str, Any],
        local_date: date,
        horizon_start: datetime,
        horizon_end: datetime,
        tzinfo: Any,
    ) -> list[str]:
        """The day's placeable span: its window, or the whole day without one."""
        window = params.get("window")
        start = (
            time_on(window["start"], local_date, tzinfo=tzinfo)
            if window
            else time_on("00:00", local_date, tzinfo=tzinfo)
        )
        end = (
            time_on(window["end"], local_date, tzinfo=tzinfo)
            if window
            else time_on("00:00", local_date + timedelta(days=1), tzinfo=tzinfo)
        )
        return horizon_slots_between(
            start, end, horizon_start=horizon_start, horizon_end=horizon_end
        )


def _window_slot_ids(
    params: dict[str, Any],
    snapshot: "OptimizationSnapshot",
) -> frozenset[str] | None:
    """Every day's window slots as one set, or ``None`` when unconstrained."""
    window = params.get("window")
    if not window:
        return None
    horizon_start = build_horizon_start(snapshot.context.now)
    horizon_end = build_horizon_end(snapshot.context.now)
    tzinfo = horizon_start.tzinfo
    slot_ids: set[str] = set()
    for local_date in snapshot.context.day_contexts:
        slot_ids.update(
            horizon_slots_between(
                time_on(window["start"], local_date, tzinfo=tzinfo),
                time_on(window["end"], local_date, tzinfo=tzinfo),
                horizon_start=horizon_start,
                horizon_end=horizon_end,
            )
        )
    return frozenset(slot_ids)


class _SelfSustainabilityGate:
    """Greedy acceptance under ``ensure_self_sustainability``.

    Inert unless some group asked for it — `for_run` returns a gate that takes
    the ranking's top ``slots_needed`` unchanged, which is exactly the previous
    behaviour, and never builds a simulator.

    When it is live, a candidate is accepted only if the horizon *re-simulated
    with every accepted placement plus this one* keeps the battery above the
    floor. Acceptance re-checks the whole accepted set rather than the candidate
    alone: taking an 18:00 slot changes the SoC after 18:00, which lies inside
    the region a 13:00 slot was already checked over.

    The accepted set spans days, not just the day being planned, because the
    trajectory does.
    """

    def __init__(
        self,
        *,
        snapshot: "OptimizationSnapshot",
        appliance_id: str,
        demand_hourly_energy: float,
    ) -> None:
        from .self_sustainability import build_horizon_simulator

        self._snapshot = snapshot
        self._demand_hourly_energy = demand_hourly_energy
        self._simulator = build_horizon_simulator(
            snapshot, appliance_id=appliance_id
        )
        self._accepted_demand: dict[datetime, float] = {}
        self._demand_cache: dict[str, dict[datetime, float]] = {}

    @classmethod
    def for_run(
        cls,
        *,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        appliance_id: str,
        demand_hourly_energy: float | None,
    ) -> "_SelfSustainabilityGate | _NullGate":
        if not any(
            group.condition_values.get("ensure_self_sustainability")
            for group in config.conditions
        ):
            return _NullGate()
        if demand_hourly_energy is None:
            # Without a demand profile there is no "what would this cost";
            # the gate would silently pass everything.
            raise ConditionRailsUnavailable(
                appliance_id,
                "the appliance's when-active demand profile is unavailable",
            )
        return cls(
            snapshot=snapshot,
            appliance_id=appliance_id,
            demand_hourly_energy=demand_hourly_energy,
        )

    def take(
        self,
        ranked: list[tuple[float, str]],
        *,
        slots_needed: int,
        plan: _DayPlan,
    ) -> tuple[
        list[tuple[float, str]],
        list[tuple[str, dict[str, Any]]],
        list[tuple[float, str]],
    ]:
        """``(chosen, floor_rejected, not_reached)`` for one day's ranking."""
        if plan.self_sustainability is None:
            return ranked[:slots_needed], [], ranked[slots_needed:]

        floor = self._floor_pct(plan.params)
        chosen: list[tuple[float, str]] = []
        floor_rejected: list[tuple[str, dict[str, Any]]] = []
        not_reached: list[tuple[float, str]] = []
        for cost, slot_id in ranked:
            if len(chosen) >= slots_needed:
                not_reached.append((cost, slot_id))
                continue
            reason = self._accept(
                slot_id, floor=floor, level=plan.self_sustainability
            )
            if reason is None:
                chosen.append((cost, slot_id))
            else:
                floor_rejected.append((slot_id, reason))
        return chosen, floor_rejected, not_reached

    def accept(
        self, slot_id: str, *, level: str | None, params: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Uncapped acceptance of one slot. ``None`` accepts; a reason rejects.

        Uncapped mode iterates ``eligibility.iter_slots()`` across groups, so
        unlike capped placement the level and the margin can change from slot to
        slot; both come from the group owning the candidate. Candidates arrive
        in horizon order, which is the ordering the coupled constraint needs.
        """
        if level is None:
            return None
        return self._accept(slot_id, floor=self._floor_pct(params), level=level)

    def _accept(
        self, slot_id: str, *, floor: float, level: str
    ) -> dict[str, Any] | None:
        baseline = self._simulator.baseline
        if baseline.min_soc_pct < floor:
            # The no-appliance trajectory already dips below the floor, so the
            # appliance is not the cause and must not be blamed. Decided from
            # the baseline, never by re-testing "the accepted set minus the
            # candidate" — for the first candidate that set is empty, the test
            # passes trivially, and the first candidate takes the blame.
            return {
                "code": "soc_floor_already_breached",
                "floor": round(floor, 2),
                "baselineMinSoc": round(baseline.min_soc_pct, 2),
            }
        candidate_demand = _merge_demand(
            self._accepted_demand, self._slot_demand(slot_id)
        )
        trajectory = self._simulator.simulate(candidate_demand)
        if trajectory.min_soc_pct < floor:
            return {
                "code": "would_break_soc_floor",
                "floor": round(floor, 2),
                "projectedMinSoc": round(trajectory.min_soc_pct, 2),
                "atSlot": trajectory.min_soc_at,
            }
        if level == "strict":
            # Strict *inherits* the floor rather than replacing it: a day can
            # balance while still dipping through the floor at noon.
            unbalanced = self._day_imbalance(slot_id, trajectory, baseline)
            if unbalanced is not None:
                return unbalanced
        self._accepted_demand = candidate_demand
        return None

    def _day_imbalance(
        self,
        slot_id: str,
        trajectory: "Trajectory",
        baseline: "Trajectory",
    ) -> dict[str, Any] | None:
        """Strict's extra test: did the day the slot belongs to pay for itself?

        Over that day, to local midnight and against the no-appliance baseline,
        the battery must be restored *and* no extra grid energy bought. Together
        those mean the appliance's energy came from solar that would otherwise
        have been exported or curtailed. The battery may be drained mid-morning
        provided the day's sun refills it — which is exactly what
        ``min_solar_coverage_pct`` cannot express, being per-slot and unable to
        time-shift.

        **Why SoC alone is not enough.** Grid import also leaves the battery
        unchanged: ``charge_from_grid`` charging to a target simply imports one
        more kWh to still hit it, so end-of-day SoC is identical and the
        appliance ran on imported energy.

        **Consequence, intended:** energy consumed after sunset cannot be repaid
        by today's sun, so strict confines the appliance to daylight hours.

        Both comparisons are one-sided. Ending the day *better* than the
        baseline is not a failure, it just cannot happen often.
        """
        local_date = parse_slot_id(slot_id).date()
        nominal_capacity_kwh = self._nominal_capacity_kwh()
        # A day whose midnight lies beyond the horizon falls back to the horizon
        # end, which is what the simulator recorded for it.
        delta_energy_kwh = trajectory.end_energy_kwh_by_date.get(
            local_date, 0.0
        ) - baseline.end_energy_kwh_by_date.get(local_date, 0.0)
        delta_soc_pct = delta_energy_kwh / nominal_capacity_kwh * 100
        delta_import_kwh = trajectory.imported_kwh_by_date.get(
            local_date, 0.0
        ) - baseline.imported_kwh_by_date.get(local_date, 0.0)
        if (
            -delta_soc_pct <= _STRICT_SOC_TOLERANCE_PCT
            and delta_import_kwh <= _STRICT_IMPORT_TOLERANCE_KWH
        ):
            return None
        return {
            "code": "not_solar_neutral",
            "deltaSocPct": round(delta_soc_pct, 2),
            "deltaImportKwh": round(delta_import_kwh, 3),
        }

    def _nominal_capacity_kwh(self) -> float:
        battery_state = self._snapshot.context.battery_state
        assert battery_state is not None  # build_horizon_simulator guarantees it
        return battery_state.nominal_capacity_kwh

    def _floor_pct(self, params: dict[str, Any]) -> float:
        # In percentage *points* above the inverter's own reserve. A floor at
        # `min_soc` is provably inert: every discharge path clamps `remaining`
        # to `min_energy_kwh`, so the projected SoC can never reach `min_soc`,
        # let alone breach it. Only the margin gives the floor teeth.
        battery_state = self._snapshot.context.battery_state
        assert battery_state is not None  # build_horizon_simulator guarantees it
        return battery_state.min_soc + _margin_pct(params)

    def _slot_demand(self, slot_id: str) -> dict[datetime, float]:
        cached = self._demand_cache.get(slot_id)
        if cached is None:
            from ...appliances.projection_builder import (
                build_when_active_demand_slices,
            )

            cached = {
                demand_slice.bucket_start: demand_slice.energy_kwh
                for demand_slice in build_when_active_demand_slices(
                    slot_id=slot_id,
                    reference_time=self._snapshot.context.now,
                    hourly_energy_kwh=self._demand_hourly_energy,
                )
            }
            self._demand_cache[slot_id] = cached
        return cached


class _NullGate:
    """No group asked for self-sustainability, so the ranking decides alone."""

    def take(
        self,
        ranked: list[tuple[float, str]],
        *,
        slots_needed: int,
        plan: _DayPlan,
    ) -> tuple[
        list[tuple[float, str]],
        list[tuple[str, dict[str, Any]]],
        list[tuple[float, str]],
    ]:
        return ranked[:slots_needed], [], ranked[slots_needed:]

    def accept(
        self, slot_id: str, *, level: str | None, params: dict[str, Any]
    ) -> dict[str, Any] | None:
        return None


def _merge_demand(
    base: dict[datetime, float], extra: dict[datetime, float]
) -> dict[datetime, float]:
    merged = dict(base)
    for bucket_start, energy_kwh in extra.items():
        merged[bucket_start] = merged.get(bucket_start, 0.0) + energy_kwh
    return merged


def _margin_pct(params: dict[str, Any]) -> float:
    return (params.get("self_sustainability") or {}).get("margin_pct", 0.0)


def _horizon_slots_by_date(slot_ids: tuple[str, ...]) -> dict[date, list[str]]:
    """The horizon bucketed by local date — what the window gate needs.

    A 48 h horizon spans three calendar dates, the first truncated, so "the
    slots of this day" is not derivable from the window alone.
    """
    by_date: dict[date, list[str]] = {}
    for slot_id in slot_ids:
        by_date.setdefault(parse_slot_id(slot_id).date(), []).append(slot_id)
    return by_date


def _trace_run_window(
    *,
    trace: "OptimizerTrace",
    params: dict[str, Any],
    window_slots: list[str],
    day_slots: list[str],
) -> None:
    """Record which of the day's slots the configured window admits.

    Emitted only when a window is actually configured: without one the whole day
    *is* the window, and a gate that is true for every slot of every day
    discriminates between nothing. A date the day loop never reaches gets no
    column at all, which is the honest reading — not a false one.
    """
    window = params.get("window")
    if not window:
        return
    window_params = {"start": window["start"], "end": window["end"]}
    inside = set(window_slots)
    outside = [slot_id for slot_id in day_slots if slot_id not in inside]
    if window_slots:
        trace.gate(
            slot_ids=window_slots,
            key=GATE_RUN_WINDOW,
            state=STATE_TRUE,
            params=window_params,
        )
    if outside:
        trace.gate(
            slot_ids=outside,
            key=GATE_RUN_WINDOW,
            state=STATE_FALSE,
            params=window_params,
        )


def _trace_ranking(
    *,
    trace: "OptimizerTrace",
    ranked: list[tuple[float, str]],
    chosen: list[tuple[float, str]],
    floor_rejected: list[tuple[str, dict[str, Any]]],
    slots_needed: int,
) -> None:
    """Record each candidate's position in the day's ranking, as an ordinal.

    ``state`` says only whether the placement cut *reached* the slot; the
    position itself lives in ``params.rank`` / ``params.rankOf``, because "you
    lost to four cheaper slots" has no truth value and must never render as a
    boolean. A slot the cut reached and self-sustainability then refused is
    ``true`` here — the refusal is the ``ensure_self_sustainability`` node's to
    report, not the ranking's.
    """
    if not ranked:
        return
    reached = {slot_id for _cost, slot_id in chosen}
    reached.update(slot_id for slot_id, _detail in floor_rejected)
    worst_chosen_cost = max((cost for cost, _slot_id in chosen), default=None)
    for index, (cost, slot_id) in enumerate(ranked):
        trace.gate(
            slot_ids=[slot_id],
            key=GATE_CHEAPEST_RANK,
            state=STATE_TRUE if slot_id in reached else STATE_FALSE,
            params={
                "rank": index + 1,
                "rankOf": len(ranked),
                "slotsNeeded": slots_needed,
                "cost": _finite(cost),
                "worstChosenCost": _finite(worst_chosen_cost),
            },
        )


def _resolve_self_sustainability(
    *,
    trace: "OptimizerTrace",
    plan: _DayPlan,
    chosen: list[tuple[float, str]],
    floor_rejected: list[tuple[str, dict[str, Any]]],
) -> None:
    """Resolve the self-gating node for the slots the gate actually consulted.

    ``ensure_self_sustainability`` contributes an all-true mask, so
    ``build_eligibility`` can only leave it ``not_evaluated``; the optimizer is
    the only place its real result exists.

    **The slots below the cut are deliberately left alone.** Capped placement
    stops consulting the gate once ``slots_needed`` is met, so those slots were
    never tested — they keep the ``not_evaluated`` placeholder. Writing ``false``
    there would claim the gate refused a slot it never looked at.

    The result is also **order-dependent**: acceptance is greedy and re-checks
    the whole accepted set, so a slot's answer depends on which slots were
    accepted before it. This is a log of what this run found, not a function of
    the slot.
    """
    level = plan.self_sustainability
    if level is None or plan.group_index is None:
        return
    accepted = [slot_id for _cost, slot_id in chosen]
    if accepted:
        trace.resolve_condition(
            slot_ids=accepted,
            key="ensure_self_sustainability",
            state=STATE_TRUE,
            value=level,
            group_index=plan.group_index,
        )
    for slot_id, detail in floor_rejected:
        trace.resolve_condition(
            slot_ids=[slot_id],
            key="ensure_self_sustainability",
            state=STATE_FALSE,
            value=level,
            # Per slot: the projected minimum and where it falls are what make
            # the refusal readable, and they differ slot by slot.
            actual=detail,
            group_index=plan.group_index,
        )


def _finite(value: float | None) -> float | None:
    """``None`` for a missing or infinite cost — the payload must stay JSON."""
    if value is None or value == float("inf"):
        return None
    return round(value, 4)


def _jsonable(value: Any) -> Any:
    """Condition values reach the payload as-is; sequences must not be tuples."""
    if isinstance(value, (tuple, list, set, frozenset)):
        return list(value)
    return value


def _trace_unmatched_day(
    *,
    trace: "OptimizerTrace",
    eligibility: "Eligibility",
    window_slots: list[str],
    day_context: "DayContext",
) -> None:
    """Explain a day on which no group owned a single window slot.

    Usually the day itself was not matched, and the answer is the day's
    classification against the group's ``run_when``. But a *slot*-scoped
    condition can empty a whole day too — a day whose prices never drop below
    the threshold, or an overcast one no slot of which clears
    ``min_solar_coverage_pct``. Either way no group has params for the day, so
    the gate is ``false``; ``failingCondition`` names which condition of the
    first group did it, and the condition matrix carries what each slot
    presented.
    """
    if not window_slots:
        return
    rejection = eligibility.rejection(window_slots[0])
    trace.gate(
        slot_ids=window_slots,
        key=GATE_DAY_GROUP_MATCHED,
        state=STATE_FALSE,
        params={
            "classification": day_context.classification,
            "failingCondition": None if rejection is None else rejection[0],
            "conditionValue": (
                None if rejection is None else _jsonable(rejection[1])
            ),
        },
    )
    if rejection is not None and rejection[0] != "run_when":
        _trace_window_exclusions(
            trace=trace,
            eligibility=eligibility,
            window_slots=window_slots,
            placeable=set(),
        )
        return
    trace.decision(slot_ids=window_slots, outcome="out_of_scope")


def _trace_window_exclusions(
    *,
    trace: "OptimizerTrace",
    eligibility: "Eligibility",
    window_slots: list[str],
    placeable: set[str],
) -> None:
    """Mark window slots the matched group does not own as rejected.

    The *why* lives entirely in the condition matrix now: ``masks_by_key`` names
    the failing condition per slot and carries the value the slot actually
    presented — the price against ``max_run_price``, the projected SoC, the
    solar coverage this appliance's demand achieved. What is left here is the
    outcome vocabulary the retained trace consumers still read.

    Which slots that vocabulary covers is unchanged: price and solar coverage
    are claimed here, everything else (a SoC floor, an unmatched day) stays with
    the frontend's own derivation. The set is now named by condition key rather
    than by the retired ``reason_code`` — the same two conditions, so the slots
    that get a ``rejected`` decision are exactly the slots that got one before.
    """
    rejected = []
    for slot_id in window_slots:
        if slot_id in placeable:
            continue
        rejection = eligibility.rejection(slot_id)
        if rejection is None:
            continue
        if rejection[0] in ("min_solar_coverage_pct", "max_run_price"):
            rejected.append(slot_id)
    if rejected:
        trace.decision(slot_ids=rejected, outcome="rejected")


def _prior_consecutive_skips(
    *,
    local_date: date,
    runtime_by_date: dict[date, float],
    min_hours_per_day: float,
) -> int:
    """Prior days that fell short of the minimum, walking backwards.

    Counts *any* short day, not only days skipped by policy — a day that fell
    short because its window was too narrow counts too. Pre-existing behaviour,
    preserved deliberately.
    """
    consecutive_prior_skips = 0
    cursor = local_date - timedelta(days=1)
    while cursor in runtime_by_date:
        if runtime_by_date[cursor] >= min_hours_per_day:
            break
        consecutive_prior_skips += 1
        cursor -= timedelta(days=1)
    return consecutive_prior_skips


def _rank_slots(
    *,
    document: ScheduleDocument,
    appliance_id: str,
    window_slots: list[str],
    available_surplus_by_bucket: dict[datetime, float] | None,
    demand_hourly_energy: float | None,
    export_price_by_bucket: dict[datetime, float],
    reference_time: datetime,
    prefer_covered: bool = False,
) -> list[tuple[float, str]]:
    """Window slots cheapest-first, solar-covered slots winning ties.

    ``prefer_covered`` inverts the two keys for a forced run, which places past
    every condition including self-sustainability: ordering by coverage first
    takes the slots that move the battery least, so the escape hatch does as
    little damage as it can while still delivering the runtime.
    """
    candidates: list[tuple[float, int, datetime, str]] = []
    for slot_id in window_slots:
        current_domains = document.slots.get(slot_id, ScheduleDomains())
        if is_user_owned_appliance_action(current_domains.appliances.get(appliance_id)):
            continue
        covered = _slot_is_solar_covered(
            slot_id=slot_id,
            reference_time=reference_time,
            available_surplus_by_bucket=available_surplus_by_bucket,
            demand_hourly_energy=demand_hourly_energy,
        )
        cursor = parse_slot_id(slot_id)
        candidates.append(
            (
                export_price_by_bucket.get(cursor, float("inf")),
                0 if covered else 1,
                cursor,
                slot_id,
            )
        )
    candidates.sort(
        key=lambda item: (
            (item[1], item[0], dt_util.as_utc(item[2]))
            if prefer_covered
            else (item[0], item[1], dt_util.as_utc(item[2]))
        )
    )
    return [(cost, slot_id) for cost, _covered, _cursor, slot_id in candidates]


def _promote_in_flight_slot(
    ranked: list[tuple[float, str]],
    *,
    active: bool,
    active_slot_id: str,
) -> list[tuple[float, str]]:
    """Move a running appliance's current slot to the front of the ranking.

    Ranking sorts by price, then solar coverage, then time — and knows nothing
    about what is running. Because ``slots_needed`` shrinks as runtime is
    delivered, the cut at ``ranked[:slots_needed]`` walks up the list, and the
    slot being executed right now is routinely the one it removes: the appliance
    is switched off mid-run and back on at whichever slot won instead.

    Promotion, not exemption. The slot must still have survived ranking, which
    means it is still in ``placeable_slots`` — so every condition that gates
    placement (``min_soc_pct``, ``max_run_price``, ``run_when``) still stops
    the appliance the moment it stops holding. A ``custom`` condition going
    false stops it too, by a different route: the action is still placed here,
    but stamped ``condition_met=False`` and stripped before execution.

    The cost is one marginal slot: promoting displaces whatever sat last above
    the cut. That is the trade for not short-cycling the appliance.
    """
    if not active:
        return ranked
    for index, (_cost, slot_id) in enumerate(ranked):
        if slot_id == active_slot_id:
            if index == 0:
                return ranked
            return [ranked[index], *ranked[:index], *ranked[index + 1 :]]
    return ranked


def _slot_coverage_pct(
    *,
    slot_id: str,
    reference_time: datetime,
    available_surplus_by_bucket: dict[datetime, float] | None,
    demand_hourly_energy: float | None,
) -> float | None:
    """The slot's worst-bucket solar coverage, or ``None`` when unknowable.

    Ranking is best-effort where the ``min_solar_coverage_pct`` mask is strict:
    a missing rail here costs a tiebreak, so it degrades to "not covered"
    instead of voiding the run the way the mask must.
    """
    if available_surplus_by_bucket is None or demand_hourly_energy is None:
        return None
    return slot_solar_coverage_pct(
        slot_id=slot_id,
        reference_time=reference_time,
        available_surplus_by_bucket=available_surplus_by_bucket,
        demand_hourly_energy=demand_hourly_energy,
    )


def _slot_is_solar_covered(
    *,
    slot_id: str,
    reference_time: datetime,
    available_surplus_by_bucket: dict[datetime, float] | None,
    demand_hourly_energy: float | None,
) -> bool:
    """Fully covered — the ranking tiebreak, i.e. a 100 % coverage threshold.

    Still a boolean with ``min_solar_coverage_pct`` in play: for a threshold
    below 100 the gate leaves several slots standing, and "runs entirely on sun"
    is what discriminates between them.
    """
    coverage_pct = _slot_coverage_pct(
        slot_id=slot_id,
        reference_time=reference_time,
        available_surplus_by_bucket=available_surplus_by_bucket,
        demand_hourly_energy=demand_hourly_energy,
    )
    return coverage_pct is not None and coverage_pct >= 100.0


def build_appliance_runtime_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: "AppliancesRuntimeRegistry",
    path: str = "automation.optimizers[?]",
    **_kwargs: Any,
) -> ApplianceRuntimeOptimizer:
    return ApplianceRuntimeOptimizer(
        id=config.id,
        target=resolve_appliance_target(
            config, appliance_registry=appliance_registry, path=path
        ),
    )
