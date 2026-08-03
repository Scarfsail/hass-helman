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
    SCHEDULE_SLOT_MINUTES,
)
from ...scheduling.schedule import (
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
)
from ..base import ScheduleWriter
from ..conditions import build_eligibility
from ..explain import (
    SCOPE_WINDOW,
    STATE_FALSE,
    STATE_NOT_EVALUATED,
    STATE_TRUE,
    STATUS_SKIPPED,
    VERDICT_CANDIDATE,
    VERDICT_EXECUTE,
    VERDICT_SKIP,
)
from ..ownership import is_user_owned_inverter_action
from ..rails import horizon_slots_between, read_price_by_bucket, read_soc_by_bucket
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..conditions import SlotEligibility
    from ..config import OptimizerInstanceConfig
    from ..day_context import ImportBand
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)
_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60
_ACTION = {"domain": "inverter", "kind": SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC}

# The gates this kind owns. Every one of them is *per bridging window*: a cheap
# slot only ever meets them because some expensive band ahead of it needs
# bridging, and a slot no band reaches has none of these columns at all.
#: The SoC trajectory covers the expensive band (and the two points the sizing
#: reads). Without it nothing downstream can be evaluated, false or otherwise.
GATE_WINDOW_SOC_KNOWN = "window_soc_known"
#: Charging is actually needed: the battery does not already enter the cheap
#: window at or above the target the dip implies.
GATE_CHARGE_NEEDED = "charge_needed"
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
        eligibility = build_eligibility(snapshot, config, trace)
        writer = ScheduleWriter(
            snapshot,
            eligibility=eligibility,
            trace=trace,
            # Every write comes out of the ranking, and the ranking already
            # dropped user-owned slots under `slot_available`.
            pre_filters_ownership=True,
        )
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
            # Nothing was evaluated; without the status this is indistinguishable
            # from a horizon on which every window turned out to be covered.
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="battery_params_missing"
            )
            return writer.flush(action=_ACTION)

        soc_by_bucket = read_soc_by_bucket(snapshot)
        if not soc_by_bucket:
            trace.set_step_status(
                status=STATUS_SKIPPED, reason="soc_forecast_unavailable"
            )
            return writer.flush(action=_ACTION)
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
        for day_context in snapshot.context.day_contexts.values():
            bands = day_context.import_bands
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
                    upper_target=min(
                        battery_state.max_soc, resolved.params["max_target_soc"]
                    ),
                    lower_target=battery_state.min_soc,
                    emit=emit,
                )

        emit.flush()
        return writer.flush(action=_ACTION)

    def _plan_window(
        self,
        *,
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
        emit: "_ChargeFromGridEmission",
    ) -> None:
        expensive_window = [
            format_slot_id(expensive_band.start),
            format_slot_id(expensive_band.end),
        ]
        floor = resolved.condition_value("reserve_floor_soc")
        group_index = resolved.group.index
        window_min_soc = _min_soc_over(
            soc_by_bucket, expensive_band.start, expensive_band.end
        )
        if window_min_soc is None:
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
        )
        # The floor is read by value, not as a mask — see the module docstring.
        # It is the condition's own result, so it is resolved onto the condition
        # node rather than recorded as a gate — window-scoped, because it is
        # answered once per expensive band and differs between bands.
        dip = floor - window_min_soc
        if dip <= 0:
            # covered — SoC never dips below the reserve floor.
            emit.window_covered(
                cheap_slots,
                gates=[soc_known],
                floor=_FloorResolution(
                    STATE_FALSE, floor, round(window_min_soc, 1), group_index
                ),
            )
            return
        breached = _FloorResolution(STATE_TRUE, floor, None, group_index)

        window_start_soc = _soc_at(soc_by_bucket, expensive_band.start)
        if window_start_soc is None:
            emit.window_unknown(
                cheap_slots,
                expensive_window=expensive_window,
                floor=breached,
            )
            return
        target = window_start_soc + dip * (1 + resolved.params["margin_pct"] / 100)
        target = max(lower_target, min(upper_target, target))

        cheap_start_soc = _soc_at(soc_by_bucket, cheap_band.start)
        if cheap_start_soc is None:
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
        slots_needed = ceil(
            required_energy_kwh / (max_charge_power_kw * _SLOT_HOURS)
        )
        if soc_gap <= 0 or slots_needed <= 0:
            # already at/above target entering the cheap window.
            emit.charge_not_needed(
                cheap_slots,
                gates=[
                    soc_known,
                    _Gate(GATE_CHARGE_NEEDED, STATE_FALSE, charge_needed_params),
                ],
                floor=breached,
            )
            return

        target_soc = int(round(target))
        ranked = _rank_cheapest_slots(
            document=writer.document,
            cheap_slots=cheap_slots,
            import_price_by_bucket=import_price_by_bucket,
        )
        window_gates = [
            soc_known,
            _Gate(GATE_CHARGE_NEEDED, STATE_TRUE, charge_needed_params),
            _Gate(
                GATE_CHEAP_WINDOW_CAPACITY,
                STATE_TRUE if len(ranked) >= slots_needed else STATE_FALSE,
                {
                    "slotsNeeded": slots_needed,
                    "slotsAvailable": len(ranked),
                    "requiredEnergyKwh": round(required_energy_kwh, 3),
                },
            ),
        ]

        rankable = {slot_id for _price, slot_id in ranked}
        unavailable = [
            slot_id for slot_id in cheap_slots if slot_id not in rankable
        ]
        if unavailable:
            # Dropped before the ranking, so the writer never sees them and the
            # writer-level veto cannot speak for them.
            emit.slot_unavailable(
                unavailable,
                gates=[*window_gates, _Gate(GATE_SLOT_AVAILABLE, STATE_FALSE, {})],
                floor=breached,
            )

        chosen = ranked[:slots_needed]
        chosen_price = max((price for price, _ in chosen), default=0.0)

        def _rank_gates(index: int, price: float, made_the_cut: bool) -> list["_Gate"]:
            return [
                *window_gates,
                _Gate(GATE_SLOT_AVAILABLE, STATE_TRUE, {}),
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
            writer.set_inverter(
                slot_id,
                kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                target_soc=target_soc,
            )
            emit.applied(
                slot_id,
                gates=_rank_gates(index, price, made_the_cut=True),
                floor=breached,
                condition_met=resolved.condition_met,
            )


def _rank_cheapest_slots(
    *,
    document: ScheduleDocument,
    cheap_slots: list[str],
    import_price_by_bucket: dict[datetime, float],
) -> list[tuple[float, str]]:
    from ...scheduling.schedule import parse_slot_id

    candidates: list[tuple[float, datetime, str]] = []
    for slot_id in cheap_slots:
        current_domains = document.slots.get(slot_id, ScheduleDomains())
        if is_user_owned_inverter_action(current_domains.inverter):
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
    outcome: str | None
    gates: tuple[_Gate, ...]
    floor: _FloorResolution | None
    verdict: str | None = None


class _ChargeFromGridEmission:
    """Accumulate per-slot records, dedupe by priority, and flush as groups.

    The same cheap slot can be evaluated by more than one expensive window, so
    a slot is resolved to a single record (applied > cheaper_slot_chosen >
    unavailable > covered/not-needed) before anything is emitted. Gates and the
    floor resolution ride along with the record rather than being written as the
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

    def _add(self, slot_id: str, record: _SlotRecord) -> None:
        current = self._by_slot.get(slot_id)
        if current is None or record.priority > current.priority:
            self._by_slot[slot_id] = record

    def applied(self, slot_id, *, gates, floor, condition_met) -> None:
        self._add(
            slot_id,
            _SlotRecord(
                priority=self._APPLIED,
                outcome="applied",
                gates=tuple(gates),
                floor=floor,
                verdict=VERDICT_EXECUTE if condition_met else VERDICT_CANDIDATE,
            ),
        )

    def cheaper_slot_chosen(self, slot_id, *, gates, floor) -> None:
        self._add(
            slot_id,
            _SlotRecord(
                priority=self._CHEAPER,
                outcome="rejected",
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
                    # The decision layer never claimed these slots — nothing was
                    # written and nothing was rejected on their own merits.
                    outcome=None,
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
                    outcome="rejected",
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
                    outcome="rejected",
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
                    outcome=None,
                    gates=(
                        _Gate(
                            GATE_WINDOW_SOC_KNOWN,
                            STATE_FALSE,
                            {"expensiveWindow": expensive_window},
                        ),
                    ),
                    floor=floor,
                ),
            )

    def flush(self) -> None:
        by_outcome: dict[str, list[str]] = {}
        by_gate: dict[str, tuple[_Gate, list[str]]] = {}
        by_floor: dict[str, tuple[_FloorResolution, list[str]]] = {}
        by_verdict: dict[str, list[str]] = {}
        for slot_id, record in self._by_slot.items():
            if record.outcome is not None:
                by_outcome.setdefault(record.outcome, []).append(slot_id)
            if record.verdict is not None:
                by_verdict.setdefault(record.verdict, []).append(slot_id)
            for gate in record.gates:
                key = json.dumps(
                    [gate.key, gate.state, gate.params], sort_keys=True
                )
                by_gate.setdefault(key, (gate, []))[1].append(slot_id)
            if record.floor is not None:
                floor = record.floor
                key = json.dumps(
                    [floor.state, floor.value, floor.actual, floor.group_index],
                    sort_keys=True,
                )
                by_floor.setdefault(key, (floor, []))[1].append(slot_id)

        for outcome, slot_ids in by_outcome.items():
            self._trace.decision(
                slot_ids=slot_ids,
                outcome=outcome,
                action=_ACTION if outcome == "applied" else None,
            )
        for gate, slot_ids in by_gate.values():
            self._trace.gate(
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
        for verdict, slot_ids in by_verdict.items():
            self._trace.set_verdict(slot_ids=slot_ids, verdict=verdict)


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


def build_charge_from_grid_optimizer(
    config: "OptimizerInstanceConfig",
    **_kwargs: Any,
) -> ChargeFromGridOptimizer:
    return ChargeFromGridOptimizer(id=config.id)
