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
placed. ``when_price_below`` and ``min_soc_pct`` narrow further, per slot: the
day still runs, but only the window slots whose price or projected SoC clears
the threshold may be chosen. So the matched group decides the day's *params*
while its mask decides the day's *slots*, which is why capped placement ranks
``plan.placeable_slots`` and not the whole window.

``max_consecutive_skips`` is the one construct that defeats the whole OR chain:
after that many consecutive short days the optimizer runs anyway, past every
group's ``custom`` conditions and past every slot condition, over the full
window, stamped with its own reason code so the inspector never shows a forced
run as an unexplained one. It is ``overridable=False`` — it describes the chain,
not any one day in it, so no single group can own it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
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
    iter_horizon_slot_ids,
    parse_slot_id,
)
from ..base import ApplianceTarget, ScheduleWriter, resolve_appliance_target
from ..conditions import build_eligibility
from ..fields import time_on
from ..ownership import is_user_owned_appliance_action
from ..rails import (
    horizon_slots_between,
    read_available_surplus_by_bucket,
    read_price_by_bucket,
)
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ...appliances import AppliancesRuntimeRegistry
    from ..conditions import Eligibility
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60


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
    #: The matched group's ``when_price_below``, so a slot the threshold priced
    #: out can be told *which* threshold it failed. ``None`` when unconstrained.
    price_threshold: float | None = None


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
        # Slots outside the daily window are "not considered" — left to a
        # frontend default (D); only the placement/ranking rationale is emitted.
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))

        eligibility = build_eligibility(snapshot, config, trace)
        appliance_id = self.target.appliance.id
        appliance_domain = f"appliance:{appliance_id}"
        writer = ScheduleWriter(
            snapshot,
            eligibility=eligibility,
            trace=trace,
            domain=appliance_domain,
        )
        action = {"domain": appliance_domain, **self.target.authored_action}

        # Master params decide the mode: `daily_minimum` is not something a group
        # can introduce (its required, non-overridable `max_consecutive_skips`
        # makes a partial override unreadable), so this is stable across groups.
        if config.params.get("daily_minimum") is None:
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
        demand_hourly_energy = _resolve_demand_hourly_energy(
            snapshot=snapshot, appliance=self.target.appliance
        )
        export_price_by_bucket = read_price_by_bucket(
            snapshot.context.export_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)
        tzinfo = horizon_start.tzinfo

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

            remaining_hours = min_hours_per_day - delivered_hours
            if remaining_hours <= 0:
                if window_slots:
                    trace.decision(
                        slot_ids=window_slots,
                        outcome="out_of_scope",
                        reason={
                            "code": "runtime_satisfied",
                            "params": {"doneHours": round(delivered_hours, 3)},
                        },
                    )
                continue

            if plan is None:
                if window_slots:
                    code, value = eligibility.rejection(window_slots[0]) or (
                        "day_not_matched",
                        (),
                    )
                    trace.decision(
                        slot_ids=window_slots,
                        outcome="out_of_scope",
                        reason={
                            "code": code,
                            "params": {
                                "classification": day_context.classification,
                                "runWhen": list(value),
                            },
                        },
                    )
                continue

            # Slots inside the window that the matched group does not own —
            # priced out, in practice. They are neither placed nor "ranked more
            # expensive", so they get their own rejection rather than falling
            # through to the frontend's generic "not considered".
            placeable = set(plan.placeable_slots)
            filtered_out = [
                slot_id for slot_id in window_slots if slot_id not in placeable
            ]
            if filtered_out:
                trace.decision(
                    slot_ids=filtered_out,
                    outcome="rejected",
                    reason={
                        "code": "price_above_run_threshold",
                        "params": {"threshold": plan.price_threshold},
                        "signals": ["exportPrice"],
                    },
                )

            slots_needed = ceil(remaining_hours / _SLOT_HOURS)
            ranked = _rank_slots(
                document=writer.document,
                appliance_id=appliance_id,
                window_slots=plan.placeable_slots,
                available_surplus_by_bucket=available_surplus_by_bucket,
                demand_hourly_energy=demand_hourly_energy,
                export_price_by_bucket=export_price_by_bucket,
                reference_time=snapshot.context.now,
            )
            chosen = ranked[:slots_needed]
            for _cost, slot_id in chosen:
                writer.set_appliance(
                    slot_id,
                    appliance_id=appliance_id,
                    action=self.target.authored_action,
                )
            if chosen:
                trace.decision(
                    slot_ids=[slot_id for _cost, slot_id in chosen],
                    outcome="applied",
                    action=action,
                    reason=_placement_reason(
                        plan=plan,
                        min_hours_per_day=min_hours_per_day,
                        delivered_hours=delivered_hours,
                        placed_slots=len(chosen),
                    ),
                )
            rejected = ranked[slots_needed:]
            if rejected:
                worst_chosen_cost = max(
                    (cost for cost, _slot_id in chosen), default=0.0
                )
                trace.decision(
                    slot_ids=[slot_id for _cost, slot_id in rejected],
                    outcome="rejected",
                    reason={
                        "code": "ranked_more_expensive",
                        "params": {
                            "worstChosenCost": (
                                None
                                if worst_chosen_cost == float("inf")
                                else round(worst_chosen_cost, 4)
                            )
                        },
                        "signals": ["exportPrice"],
                    },
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

        applied_by_group: dict[int, list[str]] = {}
        for resolved in eligibility.iter_slots():
            if window is not None and resolved.slot_id not in window:
                continue
            if writer.set_appliance(
                resolved.slot_id,
                appliance_id=appliance_id,
                action=self.target.authored_action,
            ):
                applied_by_group.setdefault(resolved.group.index, []).append(
                    resolved.slot_id
                )

        for group_index, slot_ids in applied_by_group.items():
            trace.decision(
                slot_ids=slot_ids,
                outcome="applied",
                action=action,
                reason={
                    "code": "conditions_matched",
                    "params": {
                        "matchedGroup": eligibility.groups[group_index].label
                    },
                },
            )
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
        with ``when_price_below`` — without it, a day whose prices never drop
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
                price_threshold=resolved.condition_value("when_price_below"),
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


def _placement_reason(
    *,
    plan: _DayPlan,
    min_hours_per_day: float,
    delivered_hours: float,
    placed_slots: int,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "minHours": min_hours_per_day,
        "doneHours": round(delivered_hours, 3),
        "placedHours": round(placed_slots * _SLOT_HOURS, 3),
    }
    if plan.forced_after_skips is not None:
        return {
            "code": "forced_after_consecutive_skips",
            "params": {**params, "consecutiveSkips": plan.forced_after_skips},
            "signals": ["exportPrice"],
        }
    return {
        "code": "runtime_deficit_placed",
        "params": {**params, "matchedGroup": plan.group_label},
        "signals": ["exportPrice"],
    }


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
) -> list[tuple[float, str]]:
    """Window slots cheapest-first, solar-covered slots winning ties."""
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
    candidates.sort(key=lambda item: (item[0], item[1], dt_util.as_utc(item[2])))
    return [(cost, slot_id) for cost, _covered, _cursor, slot_id in candidates]


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
