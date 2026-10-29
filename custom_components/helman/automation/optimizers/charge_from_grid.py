"""``charge_from_grid`` optimizer (use case 4).

Bridge expensive import windows the battery cannot cover on its own by charging
it from the grid during the immediately preceding cheap window, on the cheapest
slots. Reads the simulated SoC trajectory to decide whether a window needs
bridging and how much. Not frozen — churn between runs is accepted since it only
ever adds energy.

**Self-gating.** ``reserve_floor_soc`` is registered as a RUN-scope, self-gating
condition rather than a slot mask, because the floor test runs over the
*expensive* band while every slot this optimizer writes lies in the *preceding
cheap* band — a mask of "slots where projected SoC dips below the floor" would
mark exactly the slots it never touches. Nor is the value it needs the config
value: it needs ``dip = floor - window_min_soc``, per expensive band. So the
condition contributes an all-true mask (keeping OR/candidate algebra and
``custom`` gating unchanged) and the dip arithmetic stays here. A consequence
worth knowing: two groups differing only in ``reserve_floor_soc`` resolve every
slot to group 0 — for a self-gating kind, groups discriminate on ``custom`` only.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from math import ceil
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ...const import (
    IMPORT_BAND_LEVEL_CHEAP,
    IMPORT_BAND_LEVEL_EXPENSIVE,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_SLOT_MINUTES,
)
from ...controllables.config import CONTROLLABLE_ID_INVERTER
from ...scheduling.schedule import (
    ScheduleDocument,
    ScheduleAction,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
)
from ..base import ScheduleWriter
from ..conditions.types import ConditionRailsUnavailable
from ..day_context import ImportBand
from ..explain import (
    SCOPE_WINDOW,
    STATE_FALSE,
    STATE_NOT_EVALUATED,
    STATE_TRUE,
    STATUS_SKIPPED,
)
from ..ownership import is_user_owned
from ..rails import (
    horizon_slots_between,
    read_forecast_soc_at,
    read_price_by_bucket,
    read_soc_by_bucket,
)
from ..trace import NULL_TRACE, ReserveFloorObservation

if TYPE_CHECKING:
    from ..conditions import SlotEligibility
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)
_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60

# The gates this kind owns. Every one of them is *per bridging window*: a cheap
# slot only ever meets them because some expensive band ahead of it needs
# bridging, and a slot no band reaches has none of these columns at all.
#: The SoC trajectory covers the expensive band (and the two points the sizing
#: reads). Without it nothing downstream can be evaluated, false or otherwise.
GATE_WINDOW_SOC_KNOWN = "window_soc_known"
#: Charging is actually needed: when simulated, the window's lowest SoC is below
#: the floor and a plan can lift it; else the battery does not reach the target
#: the dip implies on entering the cheap window.
GATE_CHARGE_NEEDED = "charge_needed"
#: The slot keeps the cheap band itself at the floor: it charges back up to it
#: from the first slot entered below it, or holds it there for the rest of the
#: band. Simulated plans only.
GATE_CHEAP_WINDOW_FLOOR = "cheap_window_floor"
#: The cheap window holds enough writable slots for the whole deficit. False
#: still charges — as much as the window allows — so this reads as "the bridge
#: is short", not "nothing was placed".
GATE_CHEAP_WINDOW_CAPACITY = "cheap_window_capacity"
#: Where the slot placed in the cheap window's price ranking. **An ordinal, not
#: a truth value**: `params.rank` / `params.rankOf` carry the position and
#: `state` only says whether it made the cut ("you lost to 4 cheaper slots" is
#: not a boolean).
GATE_CHEAPEST_RANK = "cheapest_rank"
#: The slot is writable at all — user-owned cheap slots are dropped before the
#: ranking, so the writer never sees them and cannot veto them itself.
GATE_SLOT_AVAILABLE = "slot_available"
#: The slot lies at or after the latest simulated hold cutoff that still keeps
#: the expensive window's lowest SoC at the goal.
GATE_LATEST_CUTOFF = "latest_cutoff"


@dataclass(frozen=True)
class ChargeFromGridOptimizer:
    id: str
    kind: str = "charge_from_grid"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        trace = trace or NULL_TRACE
        writer = ScheduleWriter.open(
            snapshot,
            config,
            trace,
            pre_filters_ownership=True,
        )
        eligibility = writer.eligibility

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
            # Nothing was evaluated; without the status this is indistinguishable
            # from a horizon on which every window turned out to be covered.
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="battery_params_missing"
            )
            return writer.flush()

        soc_by_bucket = read_soc_by_bucket(snapshot)
        if not soc_by_bucket:
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="soc_forecast_unavailable"
            )
            return writer.flush()
        import_price_by_bucket = read_price_by_bucket(
            snapshot.context.import_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)

        # Re-scope the self-gating floor node before anything resolves it: it is
        # registered RUN-scoped (one configured floor per run) but *answered*
        # per expensive band, and the payload carries one scope per column. Slots
        # no bridging window reaches keep the `not_evaluated` placeholder — the
        # floor was never consulted there, which is not the same as passing it.
        trace.resolve_condition(
            slot_ids=eligibility.horizon_slot_ids,
            key="reserve_floor_soc",
            state=STATE_NOT_EVALUATED,
            scope=SCOPE_WINDOW,
        )

        emit = _ChargeFromGridEmission(trace)
        # The forecast's SoC rail tells us *whether* an expensive window needs
        # repair.  Placement itself must be re-simulated: a hold changes the
        # cheap-window trajectory and cannot be sized from its entry SoC.
        try:
            # Kept lazy so lightweight optimizer-only consumers do not need to
            # import Home Assistant's battery-state integration.
            from .self_sustainability import build_horizon_simulator

            simulator = build_horizon_simulator(snapshot, appliance_id=self.id)
        except ImportError:
            # Optimizer-only callers deliberately stub the narrow scheduling
            # surface and do not load Home Assistant's battery integration.
            simulator = None
        except ConditionRailsUnavailable:
            simulator = None
        # Expensive windows may share one cheap band.  Each simulated plan starts
        # from what the earlier windows already placed, so a later window can
        # build on those actions instead of simulating past (and overwriting)
        # them.
        planned_actions: dict[datetime, ScheduleAction] = {}
        bands = _build_import_band_timeline(snapshot.context.day_contexts.values())
        for index, band in enumerate(bands):
            if band.level != IMPORT_BAND_LEVEL_EXPENSIVE:
                continue
            cheap_band = _find_preceding_cheap_band(bands, index)
            if cheap_band is None:
                continue
            cheap_slots = horizon_slots_between(
                cheap_band.start,
                cheap_band.end,
                horizon_start=horizon_start,
                horizon_end=horizon_end,
            )
            # Self-gating: every group's mask is all-true, so any slot of
            # the band resolves to the same group. No slots in the horizon
            # means nothing to write for this band.
            resolved = next(
                (
                    candidate
                    for candidate in map(eligibility.at, cheap_slots)
                    if candidate is not None
                ),
                None,
            )
            if resolved is None:
                continue
            self._plan_window(
                snapshot=snapshot,
                writer=writer,
                resolved=resolved,
                expensive_band=band,
                cheap_band=cheap_band,
                cheap_slots=cheap_slots,
                soc_by_bucket=soc_by_bucket,
                import_price_by_bucket=import_price_by_bucket,
                usable_capacity_kwh=usable_capacity_kwh,
                charge_efficiency=charge_efficiency,
                max_charge_power_kw=max_charge_power_kw,
                upper_target=battery_state.max_soc,
                lower_target=battery_state.min_soc,
                live_soc=battery_state.current_soc,
                simulator=simulator,
                planned_actions=planned_actions,
                emit=emit,
            )

        emit.flush()
        return writer.flush()

    def _plan_window(
        self,
        *,
        snapshot: "OptimizationSnapshot",
        writer: ScheduleWriter,
        resolved: "SlotEligibility",
        expensive_band: "ImportBand",
        cheap_band: "ImportBand",
        cheap_slots: list[str],
        soc_by_bucket: list[tuple[datetime, float]],
        import_price_by_bucket: dict[datetime, float],
        usable_capacity_kwh: float,
        charge_efficiency: float,
        max_charge_power_kw: float,
        upper_target: float,
        lower_target: float,
        live_soc: float | None,
        simulator,
        planned_actions: dict[datetime, ScheduleAction],
        emit: "_ChargeFromGridEmission",
    ) -> None:
        expensive_window = [
            format_slot_id(expensive_band.start),
            format_slot_id(expensive_band.end),
        ]
        floor = resolved.condition_value("reserve_floor_soc")
        group_index = resolved.group.index

        # #274 (P0 of #270): one raw observation per evaluated expensive
        # window, regardless of outcome — the reserve-floor breach classifier
        # joins these against snapshots the pipeline captures separately.
        # Deliberately a plain closure, not `emit`: `_ChargeFromGridEmission`
        # dedupes/reduces per slot by design and must stay lossy; this must
        # not be.
        def _observe(
            *,
            min_soc: float | None,
            bridge_written: bool,
            limit: str | None = None,
        ) -> None:
            emit.observe_reserve_floor(
                ReserveFloorObservation(
                    optimizer_id=self.id,
                    group_index=group_index,
                    window=(expensive_window[0], expensive_window[1]),
                    reserve_floor_soc=floor,
                    conditions_active=resolved.condition_met,
                    projected_min_soc=min_soc,
                    bridge_written=bridge_written,
                    limit=limit,
                )
            )

        window_min_soc = _min_soc_over(
            soc_by_bucket, expensive_band.start, expensive_band.end
        )
        if window_min_soc is None:
            _observe(min_soc=None, bridge_written=False)
            emit.window_unknown(
                cheap_slots,
                expensive_window=expensive_window,
                floor=_FloorResolution(STATE_NOT_EVALUATED, floor, None, group_index),
            )
            return
        soc_known = _Gate(
            GATE_WINDOW_SOC_KNOWN,
            STATE_TRUE,
            {
                "expensiveWindow": expensive_window,
                "projectedMinSoc": round(window_min_soc, 1),
            },
            role="veto",
        )
        # The floor is read by value, not as a mask — see the module docstring.
        # It is the condition's own result, so it is resolved onto the condition
        # node rather than recorded as a gate — window-scoped, because it is
        # answered once per expensive band and differs between bands.
        dip = floor - window_min_soc
        covered = _FloorResolution(
            STATE_FALSE, floor, round(window_min_soc, 1), group_index
        )
        breached = _FloorResolution(STATE_TRUE, floor, None, group_index)
        # Decided before the rail shortcuts below: the rail is clamped at the
        # battery's min SoC and says nothing about the cheap band itself, so a
        # covered window can still be entered below the floor, and a battery
        # entering the cheap window above the target can still drain through
        # it.  Only the simulated trajectory sees either.
        if simulator is not None and self._plan_simulated_window(
            writer=writer,
            resolved=resolved,
            expensive_band=expensive_band,
            cheap_slots=cheap_slots,
            upper_target=upper_target,
            lower_target=lower_target,
            live_soc=live_soc,
            window_min_soc=window_min_soc,
            soc_known=soc_known,
            floor=covered if dip <= 0 else breached,
            emit=emit,
            simulator=simulator,
            planned_actions=planned_actions,
        ):
            return
        if dip <= 0:
            # covered — SoC never dips below the reserve floor.
            _observe(min_soc=window_min_soc, bridge_written=False)
            emit.window_covered(cheap_slots, gates=[soc_known], floor=covered)
            return

        # Rail values are end-of-slot: read the SoC *entering* each band, or the
        # live reading when the band starts in the bucket in progress.
        window_start_soc = _first_known(
            read_forecast_soc_at(snapshot, expensive_band.start), live_soc
        )
        if window_start_soc is None:
            _observe(min_soc=window_min_soc, bridge_written=False)
            emit.window_unknown(
                cheap_slots,
                expensive_window=expensive_window,
                floor=breached,
            )
            return
        raw_target = window_start_soc + dip
        target = max(lower_target, min(upper_target, raw_target))
        capped_at_max_soc = raw_target > upper_target

        # Inverter targets are integral percentages.  Round upward so the
        # target action can actually satisfy the fractional bridge target used
        # by the sizing below, unless the battery's cap is itself fractional.
        # In that case the highest valid integral action is below the bridge
        # target and the remainder is necessarily cap-limited.
        target_soc = min(ceil(target), int(upper_target))
        capped_at_max_soc = capped_at_max_soc or target_soc < target

        cheap_start_soc = _first_known(
            read_forecast_soc_at(snapshot, cheap_band.start), live_soc
        )
        if cheap_start_soc is None:
            _observe(min_soc=window_min_soc, bridge_written=False)
            emit.window_unknown(
                cheap_slots,
                expensive_window=expensive_window,
                floor=breached,
            )
            return
        soc_gap = target - cheap_start_soc
        charge_needed_params = {
            "targetSoc": round(target, 1),
            "cheapStartSoc": round(cheap_start_soc, 1),
        }
        required_energy_kwh = (
            max(soc_gap, 0.0) / 100 * usable_capacity_kwh / charge_efficiency
        )
        slots_needed = ceil(required_energy_kwh / (max_charge_power_kw * _SLOT_HOURS))
        if soc_gap <= 0 or slots_needed <= 0:
            # already at/above target entering the cheap window.
            # A cap can itself make this branch reachable: the uncapped target
            # may require a bridge even though the clamped target is already
            # below the cheap-window starting SoC.  Preserve that binding limit
            # so the classifier does not report the residual as unexplained.
            _observe(
                min_soc=window_min_soc,
                bridge_written=False,
                limit="cap" if capped_at_max_soc else None,
            )
            emit.charge_not_needed(
                cheap_slots,
                gates=[
                    soc_known,
                    _Gate(
                        GATE_CHARGE_NEEDED,
                        STATE_FALSE,
                        charge_needed_params,
                        role="veto",
                    ),
                ],
                floor=breached,
            )
            return

        ranked = _rank_cheapest_slots(
            document=writer.document,
            cheap_slots=cheap_slots,
            import_price_by_bucket=import_price_by_bucket,
        )
        window_gates = [
            soc_known,
            _Gate(GATE_CHARGE_NEEDED, STATE_TRUE, charge_needed_params, role="veto"),
            _Gate(
                GATE_CHEAP_WINDOW_CAPACITY,
                STATE_TRUE if len(ranked) >= slots_needed else STATE_FALSE,
                {
                    "slotsNeeded": slots_needed,
                    "slotsAvailable": len(ranked),
                    "requiredEnergyKwh": round(required_energy_kwh, 3),
                },
                role="advisory",
            ),
        ]

        rankable = {slot_id for _price, slot_id in ranked}
        unavailable = [slot_id for slot_id in cheap_slots if slot_id not in rankable]
        if unavailable:
            # Dropped before the ranking, so the writer never sees them and the
            # writer-level veto cannot speak for them.
            emit.slot_unavailable(
                unavailable,
                gates=[
                    *window_gates,
                    _Gate(GATE_SLOT_AVAILABLE, STATE_FALSE, {}, role="veto"),
                ],
                floor=breached,
            )

        chosen = ranked[:slots_needed]
        chosen_price = max((price for price, _ in chosen), default=0.0)
        capacity_short = len(ranked) < slots_needed
        _observe(
            min_soc=window_min_soc,
            bridge_written=bool(chosen),
            # `capacity` takes priority: when both are true, a higher battery
            # `max_soc` alone would not close the gap either, since
            # there are not enough rankable slots to charge into regardless.
            limit=(
                "capacity" if capacity_short else "cap" if capped_at_max_soc else None
            ),
        )

        def _rank_gates(index: int, price: float, made_the_cut: bool) -> list["_Gate"]:
            return [
                *window_gates,
                _Gate(GATE_SLOT_AVAILABLE, STATE_TRUE, {}, role="veto"),
                _Gate(
                    GATE_CHEAPEST_RANK,
                    STATE_TRUE if made_the_cut else STATE_FALSE,
                    {
                        "rank": index + 1,
                        "rankOf": len(ranked),
                        "slotsNeeded": slots_needed,
                        "price": None if price == float("inf") else round(price, 4),
                        "chosenPrice": round(chosen_price, 4),
                    },
                    role="veto",
                ),
            ]

        for index, (price, slot_id) in enumerate(ranked):
            if index >= slots_needed:
                emit.cheaper_slot_chosen(
                    slot_id,
                    gates=_rank_gates(index, price, made_the_cut=False),
                    floor=breached,
                )
                continue
            writer.set(
                slot_id,
                ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC, target_soc=target_soc
                ),
            )
            emit.applied(
                slot_id,
                gates=_rank_gates(index, price, made_the_cut=True),
                floor=breached,
            )

    def _plan_simulated_window(
        self,
        *,
        writer: ScheduleWriter,
        resolved: "SlotEligibility",
        expensive_band: "ImportBand",
        cheap_slots: list[str],
        upper_target: float,
        lower_target: float,
        live_soc: float | None,
        window_min_soc: float,
        soc_known: "_Gate",
        floor: "_FloorResolution",
        emit: "_ChargeFromGridEmission",
        simulator,
        planned_actions: dict[datetime, ScheduleAction],
    ) -> bool:
        """Keep the cheap band at the floor, then bridge the expensive window.

        The bridge is the latest hold/charge plan that keeps the window's
        *lowest* simulated SoC at the floor — or, when no plan from this cheap
        band can, at the best minimum one can reach.  Nothing is placed for a
        minimum no action can lift.

        Returning false deliberately retains the legacy rail-only path for old
        or partial forecast payloads.  Complete rails always use this path.

        ``planned_actions`` holds what earlier windows of this run placed; it is
        both the simulation base and a floor under this plan (a hold never
        replaces an earlier charge, a charge never lowers an earlier target).
        The accepted plan is merged back into it.
        """
        from ...scheduling.schedule import parse_slot_id

        writable = [
            slot_id
            for slot_id in cheap_slots
            if not is_user_owned(
                writer.document.slots.get(slot_id, {}).get(CONTROLLABLE_ID_INVERTER)
            )
        ]
        if not writable:
            return False
        # ``simulator`` is built from ``snapshot.schedule_overlay``, the
        # effective action set used for the battery forecast.  Trial actions
        # must therefore only override the slots this run changes.  Rebuilding
        # them from ``writer.document`` would revive disabled, candidate, or
        # unsupported actions deliberately omitted from that overlay.
        boundary = dt_util.as_utc(expensive_band.start)
        window_end = dt_util.as_utc(expensive_band.end)
        keys = [parse_slot_id(slot_id) for slot_id in writable]
        floor_soc = floor.value

        def compose(
            hold_indices: range | list[int],
            charge_indices: range | list[int],
            charge_soc: int,
        ) -> dict[datetime, ScheduleAction]:
            actions = dict(planned_actions)
            for index in hold_indices:
                actions.setdefault(
                    keys[index], ScheduleAction(kind=SCHEDULE_ACTION_STOP_DISCHARGING)
                )
            for index in charge_indices:
                existing = actions.get(keys[index])
                existing_target = (
                    existing.target_soc or 0
                    if existing is not None
                    and existing.kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC
                    else 0
                )
                actions[keys[index]] = ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=max(existing_target, charge_soc),
                )
            return actions

        def simulate(
            actions: dict[datetime, ScheduleAction],
        ) -> Mapping[datetime, float]:
            # The simulator keys its buckets in local time, where an ambiguous
            # autumn hour is not equal to its UTC instant; the lookups below
            # are in UTC.
            return {
                dt_util.as_utc(key): soc
                for key, soc in simulator.simulate(
                    {}, action_overrides=actions
                ).soc_by_bucket.items()
            }

        def window_min(
            actions: dict[datetime, ScheduleAction],
        ) -> tuple[bool, float | None]:
            # SoC values are end-of-slot, so the last slot before the boundary
            # carries the SoC the expensive window starts from; it has to be
            # simulated for the window's own buckets to mean anything, and so
            # does the window's last slot — the horizon may end inside it.
            soc_by_bucket = simulate(actions)
            simulated = [dt_util.as_utc(key) for key in soc_by_bucket]
            preceding = [key for key in simulated if key < boundary]
            in_window = [
                soc
                for key, soc in soc_by_bucket.items()
                if boundary <= dt_util.as_utc(key) < window_end
            ]
            if not preceding or not in_window:
                return False, None
            return (
                max(preceding) + _SLOT_DURATION >= boundary
                and max(simulated) + _SLOT_DURATION >= window_end
            ), min(in_window)

        window_known, unplanned_min = window_min(planned_actions)
        if not window_known:
            # A partial rolling horizon cannot answer what SoC the expensive
            # window is entered with, or how low it sinks before the window
            # ends.  Let the rail-based planner size the
            # still-writable cheap slots instead of treating the horizon's
            # final, earlier bucket as the boundary value.  The horizon is
            # fixed, so once it reaches the boundary every trial plan does.
            return False

        # The cheap band itself: from the first slot entered below the floor,
        # charge back up to it, then hold the rest of the band.  Placed first
        # and merged into ``planned_actions``, so the bridge below builds on it
        # and never weakens it.  A cheap band shared by two expensive windows
        # gets it once: the second finds the same actions already in place.
        floor_written = False
        soc_by_bucket = simulate(planned_actions)
        first_bucket = min(dt_util.as_utc(key) for key in soc_by_bucket)
        entry: tuple[int, float] | None = None
        for index, key in enumerate(keys):
            # End-of-slot values: a slot is entered with the previous bucket's
            # SoC, or the live one for the horizon's first slot.
            soc = (
                live_soc
                if dt_util.as_utc(key) <= first_bucket
                else soc_by_bucket[dt_util.as_utc(key) - _SLOT_DURATION]
            )
            if soc < floor_soc - 1e-6:
                entry = index, soc
                break
        if entry is not None:
            start, entry_soc = entry
            floor_target = min(ceil(floor_soc), int(upper_target))
            floor_charges: list[int] = []
            for index in range(start, len(writable)):
                floor_charges.append(index)
                if (
                    simulate(compose([], floor_charges, floor_target))[
                        dt_util.as_utc(keys[index])
                    ]
                    >= floor_soc - 1e-6
                ):
                    break
            floor_actions = compose(
                range(floor_charges[-1] + 1, len(writable)), floor_charges, floor_target
            )
            # The floor is breached inside the cheap band itself, whether or not
            # the expensive window is covered, so the step's records say so.
            floor_breached = _FloorResolution(
                STATE_TRUE, floor_soc, None, floor.group_index
            )
            floor_gates = [
                soc_known,
                _Gate(
                    GATE_CHEAP_WINDOW_FLOOR,
                    STATE_TRUE,
                    {"floorSoc": floor_soc, "entrySoc": round(entry_soc, 1)},
                    role="veto",
                ),
                _Gate(GATE_SLOT_AVAILABLE, STATE_TRUE, {}, role="veto"),
            ]
            for index in range(start, len(writable)):
                action = floor_actions[keys[index]]
                if planned_actions.get(keys[index]) == action:
                    continue
                floor_written = True
                planned_actions[keys[index]] = action
                writer.set(writable[index], action)
                emit.applied(writable[index], gates=floor_gates, floor=floor_breached)

        # The goal is the floor, or the best minimum this cheap band can reach
        # at all: every slot held and charged to the cap.  Energy that cannot
        # lift the minimum — a dip after solar has filled the battery — is
        # never bought.
        margin = resolved.params.get("charge_start_margin_slots", 2)
        max_charge_soc = int(upper_target)
        every = range(len(writable))
        maximal = compose(every, every, max_charge_soc)
        best = window_min(maximal)[1]
        # Pinned at the battery's min SoC even then, the clamp hides how deep
        # the deficit runs.  When the maximal plan still spends fewer window
        # slots at the clamp, the cheap energy cuts expensive import: the goal
        # stays the floor, which no plan reaches, so the search below ends on
        # the maximal plan.  A dip after solar has refilled the battery is
        # clamped just as long either way and buys nothing.
        def clamped(actions: dict[datetime, ScheduleAction]) -> int:
            return sum(
                1
                for key, soc in simulate(actions).items()
                if boundary <= dt_util.as_utc(key) < window_end
                and soc <= lower_target + 1e-6
            )

        pinned = best <= lower_target + 1e-6 and clamped(maximal) < clamped(
            planned_actions
        )
        goal = floor_soc if pinned else min(floor_soc, best)
        # Short of the floor with the battery pinned at the cap inside the
        # cheap band: a higher battery ``max_soc`` would carry more across the
        # gap, so the cap binds.  Short below it, the slots themselves ran out.
        # Judged on the maximal plan, so the cause does not depend on which
        # plan below ends up written.
        capacity_short = best < floor_soc - 1e-6
        limit: str | None = None
        if capacity_short:
            utc_keys = {dt_util.as_utc(key) for key in keys}
            peak_soc = max(
                (soc for key, soc in simulate(maximal).items() if key in utc_keys),
                default=None,
            )
            limit = (
                "cap"
                if peak_soc is not None and peak_soc >= max_charge_soc - 1e-6
                else "capacity"
            )

        def reaches(soc: float | None) -> bool:
            return soc is not None and soc >= goal - 1e-6

        observation = dict(
            optimizer_id=self.id,
            group_index=resolved.group.index,
            window=(
                format_slot_id(expensive_band.start),
                format_slot_id(expensive_band.end),
            ),
            reserve_floor_soc=floor_soc,
            conditions_active=resolved.condition_met,
            projected_min_soc=window_min_soc,
        )

        # The run so far (or the forecast's own overlay) may already keep the
        # window at the goal; nothing to place then.
        window_soc = window_min(planned_actions)[1]
        if reaches(window_soc):
            emit.observe_reserve_floor(
                ReserveFloorObservation(
                    **observation,
                    bridge_written=floor_written,
                    limit=limit,
                )
            )
            if unplanned_min >= floor_soc - 1e-6:
                # Covered before this window's floor step placed anything.
                emit.window_covered(
                    cheap_slots,
                    gates=[soc_known],
                    floor=_FloorResolution(
                        STATE_FALSE,
                        floor_soc,
                        round(unplanned_min, 1),
                        floor.group_index,
                    ),
                )
                return True
            emit.charge_not_needed(
                cheap_slots,
                gates=[
                    soc_known,
                    _Gate(
                        GATE_CHARGE_NEEDED,
                        STATE_FALSE,
                        {
                            "goalSoc": round(goal, 1),
                            "projectedWindowMinSoc": round(window_soc, 1),
                        },
                        role="veto",
                    ),
                ],
                floor=floor,
            )
            return True

        # A later cutoff is always preferred.  The first one that reaches the
        # goal preserves ordinary self-consumption for as long as possible.
        hold_start: int | None = None
        for index in range(len(writable) - 1, -1, -1):
            window_soc = window_min(
                compose(range(index, len(writable)), [], max_charge_soc)
            )[1]
            if reaches(window_soc):
                hold_start = index
                break

        # The inverter stops charging at its own target inside the cheap band,
        # and whatever drains between it and the window's low point (normal
        # hours, the window's own first hours) has to be bought on top, so the
        # inverter target is searched up to the cap.
        charge_soc = max_charge_soc
        if hold_start is None:
            # Preservation is already maximised; replace the latest holds with
            # target actions until the window minimum reaches the goal.
            hold_start = 0
            all_holds = range(len(writable))
            charge_indices: list[int] = []
            for index in range(len(writable) - 1, -1, -1):
                charge_indices.append(index)
                window_soc = window_min(
                    compose(all_holds, charge_indices, max_charge_soc)
                )[1]
                if reaches(window_soc):
                    break
            # The fewest latest slots are fixed; now the lowest inverter target
            # that still carries them to the goal.  A higher target never lowers
            # the window minimum, so bisect.
            low, high = int(lower_target), max_charge_soc
            while low < high:
                middle = (low + high) // 2
                if reaches(window_min(compose(all_holds, charge_indices, middle))[1]):
                    high = middle
                else:
                    low = middle + 1
            charge_soc = low
            window_soc = window_min(compose(all_holds, charge_indices, charge_soc))[1]
            required = sorted(charge_indices)
            # Extra slots are opportunities, not extra target.  They extend
            # backward only after every physically required latest slot.
            extra = list(range(max(0, required[0] - margin), required[0]))
            charge_indices = sorted(set(required + extra))
        else:
            charge_indices = []

        charge_set = set(charge_indices)
        hold_set = set(range(hold_start, len(writable))) - charge_set
        gates = [
            soc_known,
            _Gate(
                GATE_CHARGE_NEEDED,
                STATE_TRUE,
                {
                    "goalSoc": round(goal, 1),
                    "projectedWindowMinSoc": round(window_soc, 1),
                    "forcedChargeSlots": len(charge_set),
                    "chargeStartMarginSlots": margin,
                    "chargeTargetSoc": charge_soc if charge_set else None,
                },
                role="veto",
            ),
            _Gate(
                GATE_CHEAP_WINDOW_CAPACITY,
                STATE_FALSE if capacity_short else STATE_TRUE,
                {
                    "slotsAvailable": len(writable),
                    "slotsNeeded": len(charge_set),
                },
                role="advisory",
            ),
        ]
        selected_count = len(charge_set | hold_set)
        cutoff_params = {
            "cutoff": writable[hold_start] if selected_count else None,
            "selectedSlots": selected_count,
        }
        unavailable = [slot_id for slot_id in cheap_slots if slot_id not in writable]
        if unavailable:
            emit.slot_unavailable(
                unavailable,
                gates=[
                    *gates,
                    _Gate(GATE_SLOT_AVAILABLE, STATE_FALSE, {}, role="veto"),
                ],
                floor=floor,
            )
        final = compose(sorted(hold_set), sorted(charge_set), charge_soc)
        for index, slot_id in enumerate(writable):
            if index not in charge_set and index not in hold_set:
                emit.cheaper_slot_chosen(
                    slot_id,
                    gates=[
                        *gates,
                        _Gate(GATE_SLOT_AVAILABLE, STATE_TRUE, {}, role="veto"),
                        _Gate(
                            GATE_LATEST_CUTOFF, STATE_FALSE, cutoff_params, role="veto"
                        ),
                    ],
                    floor=floor,
                )
                continue
            action = final[keys[index]]
            if planned_actions.get(keys[index]) == action:
                # An earlier window, or the cheap-band floor, already placed
                # exactly this; its record stays the explanation.
                continue
            planned_actions[keys[index]] = action
            writer.set(slot_id, action)
            emit.applied(
                slot_id,
                gates=[
                    *gates,
                    _Gate(GATE_SLOT_AVAILABLE, STATE_TRUE, {}, role="veto"),
                    _Gate(GATE_LATEST_CUTOFF, STATE_TRUE, cutoff_params, role="veto"),
                ],
                floor=floor,
            )
        emit.observe_reserve_floor(
            ReserveFloorObservation(
                **observation,
                bridge_written=bool(charge_set or hold_set) or floor_written,
                limit=limit,
            )
        )
        return True


def _rank_cheapest_slots(
    *,
    document: ScheduleDocument,
    cheap_slots: list[str],
    import_price_by_bucket: dict[datetime, float],
) -> list[tuple[float, str]]:
    from ...scheduling.schedule import parse_slot_id

    candidates: list[tuple[float, datetime, str]] = []
    for slot_id in cheap_slots:
        current_actions = document.slots.get(slot_id, {})
        if is_user_owned(current_actions.get(CONTROLLABLE_ID_INVERTER)):
            continue
        cursor = parse_slot_id(slot_id)
        candidates.append(
            (import_price_by_bucket.get(cursor, float("inf")), cursor, slot_id)
        )
    candidates.sort(key=lambda item: (item[0], dt_util.as_utc(item[1])))
    return [(price, slot_id) for price, _, slot_id in candidates]


@dataclass(frozen=True)
class _Gate:
    """One gate node, held until the emission accumulator resolves the slot."""

    key: str
    state: str
    params: dict[str, Any]
    role: str


@dataclass(frozen=True)
class _FloorResolution:
    """The ``reserve_floor_soc`` node's real result for one expensive band."""

    state: str
    value: Any
    actual: Any
    group_index: int


@dataclass(frozen=True)
class _SlotRecord:
    priority: int
    gates: tuple[_Gate, ...]
    floor: _FloorResolution | None


class _ChargeFromGridEmission:
    """Accumulate per-slot records, dedupe by priority, and flush as groups.

    The same cheap slot can be evaluated by more than one expensive window, so
    a slot is resolved to a single record (applied > cheaper_slot_chosen >
    unavailable > covered/not-needed; between two applied records the later
    write wins, as it does in the document) before anything is emitted. Gates
    and the floor resolution ride along with the record rather than being written as the
    windows are walked: emitting them eagerly would let a later, weaker window
    overwrite the gates of the window that actually placed the action, leaving a
    slot whose verdict says `execute` and whose gates say `window_covered`.
    """

    _APPLIED = 4
    _CHEAPER = 3
    _UNAVAILABLE = 2
    _COVERED = 1

    def __init__(self, trace) -> None:
        self._trace = trace
        self._by_slot: dict[str, _SlotRecord] = {}

    def observe_reserve_floor(self, observation: "ReserveFloorObservation") -> None:
        """Forward one raw #274 observation straight to the trace.

        Unlike every other method here, this is not accumulated/deduped by
        slot: it is recorded once per evaluated window immediately, since the
        classifier needs the raw, unreduced list.
        """
        self._trace.record_reserve_floor_observation(observation)

    def _add(self, slot_id: str, record: _SlotRecord) -> None:
        current = self._by_slot.get(slot_id)
        if (
            current is None
            or record.priority > current.priority
            # A later write replaces the slot's action, so the window that
            # wrote last is the one that explains it.
            or record.priority == current.priority == self._APPLIED
        ):
            self._by_slot[slot_id] = record

    def applied(self, slot_id, *, gates, floor) -> None:
        self._add(
            slot_id,
            _SlotRecord(
                priority=self._APPLIED,
                gates=tuple(gates),
                floor=floor,
            ),
        )

    def cheaper_slot_chosen(self, slot_id, *, gates, floor) -> None:
        self._add(
            slot_id,
            _SlotRecord(
                priority=self._CHEAPER,
                gates=tuple(gates),
                floor=floor,
            ),
        )

    def slot_unavailable(self, slot_ids, *, gates, floor) -> None:
        for slot_id in slot_ids:
            self._add(
                slot_id,
                _SlotRecord(
                    priority=self._UNAVAILABLE,
                    gates=tuple(gates),
                    floor=floor,
                ),
            )

    def window_covered(self, slot_ids, *, gates, floor) -> None:
        for slot_id in slot_ids:
            self._add(
                slot_id,
                _SlotRecord(
                    priority=self._COVERED,
                    gates=tuple(gates),
                    floor=floor,
                ),
            )

    def charge_not_needed(self, slot_ids, *, gates, floor) -> None:
        for slot_id in slot_ids:
            self._add(
                slot_id,
                _SlotRecord(
                    priority=self._COVERED,
                    gates=tuple(gates),
                    floor=floor,
                ),
            )

    def window_unknown(self, slot_ids, *, expensive_window, floor) -> None:
        """The SoC trajectory does not cover this window: nothing is decidable."""
        for slot_id in slot_ids:
            self._add(
                slot_id,
                _SlotRecord(
                    priority=self._COVERED,
                    gates=(
                        _Gate(
                            GATE_WINDOW_SOC_KNOWN,
                            STATE_FALSE,
                            {"expensiveWindow": expensive_window},
                            role="veto",
                        ),
                    ),
                    floor=floor,
                ),
            )

    def flush(self) -> None:
        by_gate: dict[str, tuple[_Gate, list[str]]] = {}
        by_floor: dict[str, tuple[_FloorResolution, list[str]]] = {}
        for slot_id, record in self._by_slot.items():
            for gate in record.gates:
                key = json.dumps(
                    [gate.key, gate.role, gate.state, gate.params], sort_keys=True
                )
                by_gate.setdefault(key, (gate, []))[1].append(slot_id)
            if record.floor is not None:
                floor = record.floor
                key = json.dumps(
                    [floor.state, floor.value, floor.actual, floor.group_index],
                    sort_keys=True,
                )
                by_floor.setdefault(key, (floor, []))[1].append(slot_id)

        for gate, slot_ids in by_gate.values():
            self._trace.gate(
                role=gate.role,
                slot_ids=slot_ids,
                key=gate.key,
                state=gate.state,
                params=gate.params,
            )
        for floor, slot_ids in by_floor.values():
            self._trace.resolve_condition(
                slot_ids=slot_ids,
                key="reserve_floor_soc",
                state=floor.state,
                value=floor.value,
                actual=floor.actual,
                group_index=floor.group_index,
                # Answered once per expensive band, not once per run: a
                # run-scoped cell would span a horizon whose answer changes.
                scope=SCOPE_WINDOW,
            )


def _find_preceding_cheap_band(
    bands: tuple[ImportBand, ...],
    expensive_index: int,
) -> "ImportBand | None":
    if expensive_index <= 0:
        return None

    # Overlapping expensive windows may share one cheap predecessor, but a
    # missing interval must end the search.  Track how far continuous coverage
    # reaches backward so an older cheap band cannot bridge a forecast gap.
    coverage_start = dt_util.as_utc(bands[expensive_index].start)
    for band in reversed(bands[:expensive_index]):
        band_end = dt_util.as_utc(band.end)
        if band_end < coverage_start:
            return None
        coverage_start = min(coverage_start, dt_util.as_utc(band.start))
        if band.level == IMPORT_BAND_LEVEL_CHEAP:
            return band
    return None


def _build_import_band_timeline(day_contexts) -> tuple[ImportBand, ...]:
    """Join equal-level import bands that are continuous in elapsed time.

    Day contexts deliberately remain calendar-scoped.  This boundary-local
    timeline lets a tariff window cross that calendar boundary without changing
    their representation or classification semantics.
    """
    ordered = sorted(
        (band for day_context in day_contexts for band in day_context.import_bands),
        key=lambda band: dt_util.as_utc(band.start),
    )
    timeline: list[ImportBand] = []
    for band in ordered:
        if (
            timeline
            and timeline[-1].level == band.level
            and dt_util.as_utc(timeline[-1].end) == dt_util.as_utc(band.start)
        ):
            previous = timeline[-1]
            timeline[-1] = ImportBand(
                level=previous.level,
                start=previous.start,
                end=band.end,
            )
            continue
        timeline.append(band)
    return tuple(timeline)


def _first_known(*values: float | None) -> float | None:
    return next((value for value in values if value is not None), None)


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


def build_charge_from_grid_optimizer(
    config: "OptimizerInstanceConfig",
    **_kwargs: Any,
) -> ChargeFromGridOptimizer:
    return ChargeFromGridOptimizer(id=config.id)
