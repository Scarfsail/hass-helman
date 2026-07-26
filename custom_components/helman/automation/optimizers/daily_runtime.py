"""``daily_runtime`` optimizer (use case 3).

Ensure an appliance (generic switch or climate mode) accumulates at least
``min_hours_per_day`` within a daily window, placing the remaining hours on the
cheapest slots, preferring slots the day's solar surplus already covers.
Stateless beyond the framework's A2 runtime input; manual runs count
automatically because they show up in history.

Day gating is the ``run_when`` condition — on a day no group matches, nothing is
placed. ``max_consecutive_skips`` is the one construct that defeats the whole OR
chain: after that many consecutive short days the optimizer runs anyway, past
every group's ``custom`` conditions, stamped with its own reason code so the
inspector never shows a forced run as an unexplained one.
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
    """The params one day runs under, and why it is running at all."""

    params: dict[str, Any]
    group_label: str | None
    forced_after_skips: int | None


@dataclass(frozen=True)
class DailyRuntimeOptimizer:
    id: str
    target: ApplianceTarget
    kind: str = "daily_runtime"

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
            plan = self._plan_for_day(
                local_date=local_date,
                config=config,
                eligibility=eligibility,
                runtime_by_date=runtime_by_date,
            )
            params = config.params if plan is None else plan.params
            min_hours_per_day = params["min_hours_per_day"]
            window_slots = horizon_slots_between(
                time_on(params["window"]["start"], local_date, tzinfo=tzinfo),
                time_on(params["window"]["end"], local_date, tzinfo=tzinfo),
                horizon_start=horizon_start,
                horizon_end=horizon_end,
            )

            delivered_hours = runtime_by_date.get(local_date, 0.0)
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

            slots_needed = ceil(remaining_hours / _SLOT_HOURS)
            ranked = _rank_slots(
                document=writer.document,
                appliance_id=appliance_id,
                window_slots=window_slots,
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

    def _plan_for_day(
        self,
        *,
        local_date: date,
        config: "OptimizerInstanceConfig",
        eligibility: "Eligibility",
        runtime_by_date: dict[date, float],
    ) -> _DayPlan | None:
        """Which params today runs under, or ``None`` when today is skipped."""
        resolved = eligibility.for_day(local_date)
        if resolved is not None:
            return _DayPlan(
                params=resolved.params,
                group_label=resolved.group.label,
                forced_after_skips=None,
            )
        # No group matched. Skipping today extends the run by one; once that
        # would pass max_consecutive_skips the optimizer runs anyway — past
        # every group, including their `custom` conditions. Master params, since
        # no group matched to override them.
        consecutive_skips = (
            _prior_consecutive_skips(
                local_date=local_date,
                runtime_by_date=runtime_by_date,
                min_hours_per_day=config.params["min_hours_per_day"],
            )
            + 1
        )
        if consecutive_skips <= config.params["max_consecutive_skips"]:
            return None
        return _DayPlan(
            params=config.params,
            group_label=None,
            forced_after_skips=consecutive_skips,
        )


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


def build_daily_runtime_optimizer(
    config: "OptimizerInstanceConfig",
    *,
    appliance_registry: "AppliancesRuntimeRegistry",
    path: str = "automation.optimizers[?]",
    **_kwargs: Any,
) -> DailyRuntimeOptimizer:
    return DailyRuntimeOptimizer(
        id=config.id,
        target=resolve_appliance_target(
            config, appliance_registry=appliance_registry, path=path
        ),
    )
