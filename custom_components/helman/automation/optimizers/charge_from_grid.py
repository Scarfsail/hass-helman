"""``charge_from_grid`` optimizer (use case 4).

Bridge expensive import windows the battery cannot cover on its own by charging
it from the grid during the immediately preceding cheap window, on the cheapest
slots. Self-gating (no ``only_on_days``); reads the simulated SoC trajectory to
decide whether a window needs bridging and how much. Not frozen — churn between
runs is accepted since it only ever adds energy.
"""

from __future__ import annotations

from copy import deepcopy
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
    ScheduleAction,
    ScheduleDocument,
    ScheduleDomains,
    build_horizon_end,
    build_horizon_start,
    format_slot_id,
    iter_horizon_slot_ids,
)
from ..ownership import is_user_owned_inverter_action
from ..rails import horizon_slots_between, read_price_by_bucket, read_soc_by_bucket
from ..trace import NULL_TRACE

if TYPE_CHECKING:
    from ..config import OptimizerInstanceConfig
    from ..day_context import ImportBand
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)
_SLOT_HOURS = SCHEDULE_SLOT_MINUTES / 60


class ChargeFromGridValidationError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class ValidatedChargeFromGridConfig:
    reserve_floor_soc: float
    margin_pct: float
    max_target_soc: float


@dataclass(frozen=True)
class ChargeFromGridOptimizer:
    id: str
    config: ValidatedChargeFromGridConfig
    kind: str = "charge_from_grid"

    def optimize(
        self,
        snapshot: "OptimizationSnapshot",
        config: "OptimizerInstanceConfig",
        trace: "OptimizerTrace | None" = None,
    ) -> ScheduleDocument:
        del config
        trace = trace or NULL_TRACE
        condition_met = snapshot.context.condition_met_by_optimizer_id.get(
            self.id, True
        )
        # Only band-relative rationales are non-derivable; every other horizon
        # slot is "not considered" and left to a frontend default (D).
        trace.declare_derivable(iter_horizon_slot_ids(snapshot.context.now))
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
            return updated

        soc_by_bucket = read_soc_by_bucket(snapshot)
        if not soc_by_bucket:
            return updated
        import_price_by_bucket = read_price_by_bucket(
            snapshot.context.import_price_forecast
        )

        horizon_start = build_horizon_start(snapshot.context.now)
        horizon_end = build_horizon_end(snapshot.context.now)
        upper_target = min(battery_state.max_soc, self.config.max_target_soc)
        lower_target = battery_state.min_soc

        emit = _ChargeFromGridEmission(trace)
        for day_context in snapshot.context.day_contexts.values():
            bands = day_context.import_bands
            for index, band in enumerate(bands):
                if band.level != IMPORT_BAND_LEVEL_EXPENSIVE:
                    continue
                cheap_band = _find_preceding_cheap_band(bands, index)
                if cheap_band is None:
                    continue
                self._plan_window(
                    updated=updated,
                    expensive_band=band,
                    cheap_band=cheap_band,
                    soc_by_bucket=soc_by_bucket,
                    import_price_by_bucket=import_price_by_bucket,
                    usable_capacity_kwh=usable_capacity_kwh,
                    charge_efficiency=charge_efficiency,
                    max_charge_power_kw=max_charge_power_kw,
                    upper_target=upper_target,
                    lower_target=lower_target,
                    horizon_start=horizon_start,
                    horizon_end=horizon_end,
                    emit=emit,
                    condition_met=condition_met,
                )

        emit.flush()
        return updated

    def _plan_window(
        self,
        *,
        updated: ScheduleDocument,
        expensive_band: "ImportBand",
        cheap_band: "ImportBand",
        soc_by_bucket: list[tuple[datetime, float]],
        import_price_by_bucket: dict[datetime, float],
        usable_capacity_kwh: float,
        charge_efficiency: float,
        max_charge_power_kw: float,
        upper_target: float,
        lower_target: float,
        horizon_start: datetime,
        horizon_end: datetime,
        emit: "_ChargeFromGridEmission",
        condition_met: bool,
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
        dip = self.config.reserve_floor_soc - window_min_soc
        if dip <= 0:
            # covered — SoC never dips below the reserve floor.
            emit.window_covered(
                horizon_slots_between(
                    cheap_band.start,
                    cheap_band.end,
                    horizon_start=horizon_start,
                    horizon_end=horizon_end,
                ),
                expensive_window=expensive_window,
                projected_min_soc=round(window_min_soc, 1),
            )
            return

        window_start_soc = _soc_at(soc_by_bucket, expensive_band.start)
        if window_start_soc is None:
            return
        target = window_start_soc + dip * (1 + self.config.margin_pct / 100)
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
        ranked = self._pick_cheapest_slots(
            updated=updated,
            cheap_band=cheap_band,
            import_price_by_bucket=import_price_by_bucket,
            horizon_start=horizon_start,
            horizon_end=horizon_end,
        )
        chosen = ranked[:slots_needed]
        for price, slot_id in chosen:
            current_domains = updated.slots.get(slot_id, ScheduleDomains())
            updated.slots[slot_id] = ScheduleDomains(
                inverter=ScheduleAction(
                    kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                    target_soc=target_soc,
                    set_by="automation",
                    condition_met=condition_met,
                ),
                appliances=dict(current_domains.appliances),
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

    def _pick_cheapest_slots(
        self,
        *,
        updated: ScheduleDocument,
        cheap_band: "ImportBand",
        import_price_by_bucket: dict[datetime, float],
        horizon_start: datetime,
        horizon_end: datetime,
    ) -> list[tuple[float, str]]:
        candidates: list[tuple[float, datetime, str]] = []
        cursor = cheap_band.start
        while cursor < cheap_band.end:
            if horizon_start <= cursor < horizon_end:
                slot_id = format_slot_id(cursor)
                current_domains = updated.slots.get(slot_id, ScheduleDomains())
                if not is_user_owned_inverter_action(current_domains.inverter):
                    price = import_price_by_bucket.get(cursor, float("inf"))
                    candidates.append((price, cursor, slot_id))
            cursor += _SLOT_DURATION
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
) -> ChargeFromGridOptimizer:
    return ChargeFromGridOptimizer(
        id=config.id,
        config=validate_charge_from_grid_optimizer_config(config),
    )


def validate_charge_from_grid_optimizer_config(
    config: "OptimizerInstanceConfig",
) -> ValidatedChargeFromGridConfig:
    params = config.params
    reserve_floor_soc = _read_soc(params, "reserve_floor_soc")
    max_target_soc = _read_soc(params, "max_target_soc", default=100.0)
    margin_pct = _read_margin_pct(params)
    return ValidatedChargeFromGridConfig(
        reserve_floor_soc=reserve_floor_soc,
        margin_pct=margin_pct,
        max_target_soc=max_target_soc,
    )


def _read_soc(
    params: dict[str, Any], field: str, *, default: float | None = None
) -> float:
    value = params.get(field, default if default is not None else _MISSING)
    if value is _MISSING:
        raise ChargeFromGridValidationError(field, f"{field} is required")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ChargeFromGridValidationError(field, f"{field} must be a number")
    if not 0 <= value <= 100:
        raise ChargeFromGridValidationError(
            field, f"{field} must be between 0 and 100"
        )
    return float(value)


def _read_margin_pct(params: dict[str, Any]) -> float:
    value = params.get("margin_pct", 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ChargeFromGridValidationError("margin_pct", "margin_pct must be a number")
    if value < 0:
        raise ChargeFromGridValidationError("margin_pct", "margin_pct must be >= 0")
    return float(value)


_MISSING = object()
