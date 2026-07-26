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
    iter_horizon_slot_ids,
)
from ..base import ScheduleWriter
from ..conditions import build_eligibility
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
        # Only band-relative rationales are non-derivable; every other horizon
        # slot is "not considered" and left to a frontend default (D).
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))
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
            return writer.flush(action=_ACTION)

        soc_by_bucket = read_soc_by_bucket(snapshot)
        if not soc_by_bucket:
            return writer.flush(action=_ACTION)
        import_price_by_bucket = read_price_by_bucket(
            snapshot.context.import_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)

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
        window_min_soc = _min_soc_over(
            soc_by_bucket, expensive_band.start, expensive_band.end
        )
        if window_min_soc is None:
            return
        # The floor is read by value, not as a mask — see the module docstring.
        dip = resolved.condition_value("reserve_floor_soc") - window_min_soc
        if dip <= 0:
            # covered — SoC never dips below the reserve floor.
            emit.window_covered(
                cheap_slots,
                expensive_window=expensive_window,
                projected_min_soc=round(window_min_soc, 1),
            )
            return

        window_start_soc = _soc_at(soc_by_bucket, expensive_band.start)
        if window_start_soc is None:
            return
        target = window_start_soc + dip * (1 + resolved.params["margin_pct"] / 100)
        target = max(lower_target, min(upper_target, target))

        cheap_start_soc = _soc_at(soc_by_bucket, cheap_band.start)
        if cheap_start_soc is None:
            return
        soc_gap = target - cheap_start_soc
        if soc_gap <= 0:
            return  # already at/above target entering the cheap window.

        required_energy_kwh = soc_gap / 100 * usable_capacity_kwh / charge_efficiency
        slots_needed = ceil(
            required_energy_kwh / (max_charge_power_kw * _SLOT_HOURS)
        )
        if slots_needed <= 0:
            return

        target_soc = int(round(target))
        ranked = _rank_cheapest_slots(
            document=writer.document,
            cheap_slots=cheap_slots,
            import_price_by_bucket=import_price_by_bucket,
        )
        chosen = ranked[:slots_needed]
        for _price, slot_id in chosen:
            writer.set_inverter(
                slot_id,
                kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                target_soc=target_soc,
            )
            emit.applied(
                slot_id,
                expensive_window=expensive_window,
                deficit_kwh=round(required_energy_kwh, 3),
                target_soc=target_soc,
            )
        chosen_price = max((price for price, _ in chosen), default=0.0)
        for _price, slot_id in ranked[slots_needed:]:
            emit.cheaper_slot_chosen(slot_id, chosen_price=round(chosen_price, 4))


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


class _ChargeFromGridEmission:
    """Accumulate per-slot decisions, dedupe by priority, and flush as groups.

    The same cheap slot can be evaluated by more than one expensive window, so
    decisions are resolved per slot (applied > cheaper_slot_chosen >
    window_covered) before grouping — a slot never lands in two groups.
    """

    _APPLIED = 3
    _CHEAPER = 2
    _COVERED = 1

    def __init__(self, trace) -> None:
        self._trace = trace
        self._by_slot: dict[str, tuple[int, str, str, dict[str, Any]]] = {}

    def _add(self, slot_id, priority, outcome, code, params) -> None:
        current = self._by_slot.get(slot_id)
        if current is None or priority > current[0]:
            self._by_slot[slot_id] = (priority, outcome, code, params)

    def applied(self, slot_id, *, expensive_window, deficit_kwh, target_soc) -> None:
        self._add(
            slot_id,
            self._APPLIED,
            "applied",
            "bridge_window",
            {
                "expensiveWindow": expensive_window,
                "deficitKwh": deficit_kwh,
                "targetSoc": target_soc,
            },
        )

    def cheaper_slot_chosen(self, slot_id, *, chosen_price) -> None:
        self._add(
            slot_id,
            self._CHEAPER,
            "rejected",
            "cheaper_slot_chosen",
            {"chosenPrice": chosen_price},
        )

    def window_covered(self, slot_ids, *, expensive_window, projected_min_soc) -> None:
        for slot_id in slot_ids:
            self._add(
                slot_id,
                self._COVERED,
                "rejected",
                "window_covered",
                {
                    "expensiveWindow": expensive_window,
                    "projectedMinSoc": projected_min_soc,
                },
            )

    def flush(self) -> None:
        groups: dict[str, tuple[str, str, dict[str, Any], list[str]]] = {}
        for slot_id, (_priority, outcome, code, params) in self._by_slot.items():
            key = json.dumps([outcome, code, params], sort_keys=True)
            groups.setdefault(key, (outcome, code, params, []))[3].append(slot_id)
        for outcome, code, params, slot_ids in groups.values():
            reason: dict[str, Any] = {"code": code, "params": params}
            action: dict[str, Any] | None = None
            if code == "bridge_window":
                action = {
                    "domain": "inverter",
                    "kind": SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                }
            if code == "cheaper_slot_chosen":
                reason["signals"] = ["importPrice"]
            self._trace.decision(
                slot_ids=slot_ids,
                outcome=outcome,
                action=action,
                reason=reason,
            )


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
