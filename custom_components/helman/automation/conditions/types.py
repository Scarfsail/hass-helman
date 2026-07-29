"""The catalogue of system condition types.

Each type owns its value schema, its scope, its mask and its trace reason code —
so adding ``run_when`` to ``export_price`` later is one entry in a tuple, and a
reason code is emitted from one place per type rather than once per optimizer.

**R1 — a mask reads ``target`` and the *master* params only, never a group's
override.** Resolved params depend on which group matched, which depends on the
masks; letting a mask read the override closes the loop. If a future condition
genuinely needs an overridden param, it is not a condition — it is optimizer
logic.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import TYPE_CHECKING, Any

from ...const import (
    DAY_CLASSIFICATIONS,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    SCHEDULE_SLOT_MINUTES,
)
from ...scheduling.schedule import (
    build_horizon_start,
    format_slot_id,
    iter_horizon_slot_ids,
    parse_slot_id,
)
from .. import fields as F
from ..fields import Field
from ..rails import (
    canonical_bucket_start,
    parse_timestamp,
    read_available_surplus_by_bucket_covering_horizon,
    read_optional_float,
    read_soc_by_bucket_covering_horizon,
    read_when_active_hourly_energy_kwh,
    slot_solar_coverage_pct,
)

if TYPE_CHECKING:
    from ..snapshot import OptimizationSnapshot

class Scope(Enum):
    """How finely a condition discriminates. ``SLOT`` is the finest."""

    SLOT = "slot"
    DAY = "day"
    RUN = "run"


class ConditionRailsUnavailable(RuntimeError):
    """The rails a group's condition needs are unavailable, so the run is void.

    Control flow, not an error: the pipeline catches it, restores the appliance's
    baseline automation-owned actions and collapses the column. It must never
    degrade into "no slots matched", which would silently clear the appliance.
    """

    def __init__(self, appliance_id: str, message: str) -> None:
        super().__init__(message)
        self.appliance_id = appliance_id


@dataclass(frozen=True)
class MaskInputs:
    """Everything a mask may read. Deliberately excludes group overrides (R1)."""

    snapshot: "OptimizationSnapshot"
    value: Any
    target: Mapping[str, Any]
    master_params: Mapping[str, Any]
    horizon_slot_ids: tuple[str, ...]

    @property
    def all_slots(self) -> frozenset[str]:
        return frozenset(self.horizon_slot_ids)


@dataclass(frozen=True)
class ConditionType:
    """One system condition: value schema, scope, mask and trace reason code."""

    key: str
    scope: Scope
    field: Field
    reason_code: str
    build_mask: Callable[[MaskInputs], frozenset[str]]
    self_gating: bool = False


def _run_when_mask(inputs: MaskInputs) -> frozenset[str]:
    day_contexts = inputs.snapshot.context.day_contexts
    allowed = set(inputs.value)
    eligible: set[str] = set()
    for slot_id in inputs.horizon_slot_ids:
        day_context = day_contexts.get(parse_slot_id(slot_id).date())
        if day_context is not None and day_context.classification in allowed:
            eligible.add(slot_id)
    return frozenset(eligible)


def _export_price_below_mask(inputs: MaskInputs) -> frozenset[str]:
    forecast = inputs.snapshot.context.export_price_forecast
    threshold = inputs.value
    reference_time = inputs.snapshot.context.now

    below_bucket_starts: set[datetime] = set()
    current_price = read_optional_float(forecast.get("currentPrice"))
    if current_price is not None and current_price < threshold:
        below_bucket_starts.add(canonical_bucket_start(reference_time))
    raw_points = forecast.get("points")
    if isinstance(raw_points, list):
        for point in raw_points:
            if not isinstance(point, dict):
                continue
            timestamp = parse_timestamp(point.get("timestamp"))
            value = read_optional_float(point.get("value"))
            if timestamp is None or value is None or value >= threshold:
                continue
            below_bucket_starts.add(canonical_bucket_start(timestamp))

    # Forecast buckets are finer than schedule slots; a slot qualifies when any
    # of its buckets does, which is what mapping bucket -> slot start gives.
    below_slot_ids = {
        format_slot_id(build_horizon_start(bucket_start))
        for bucket_start in below_bucket_starts
    }
    return frozenset(below_slot_ids & inputs.all_slots)


def _min_soc_mask(inputs: MaskInputs) -> frozenset[str]:
    """Slots whose projected SoC stays at or above the threshold throughout.

    Every forecast bucket the slot overlaps must clear it, not just the slot's
    first or last: sampling one end would let an appliance switch on into a
    battery that falls through the floor halfway through the slot.

    Unlike the energy rails there is no duration scaling — ``socPct`` is a level,
    so the config value is compared directly.

    Buckets that have already elapsed are skipped. The forecast begins at the
    bucket containing ``now``, so once ``now`` passes a slot's midpoint the
    slot's first bucket is history and absent from the series. Reading that
    absence as a failure excluded the slot *being executed* from every re-plan
    landing in the second half of a slot — switching the appliance off mid-run
    over a bucket whose SoC is already a matter of record. Only buckets still
    to come can be gated.

    Blind spot worth knowing: the mask is built once from the pre-run snapshot,
    so it cannot see the appliance's own draw depressing the very SoC that
    authorised the slot. Same limitation the surplus buffer had.
    """
    snapshot = inputs.snapshot
    appliance_id = str(inputs.target.get("appliance_id"))
    soc_by_bucket = read_soc_by_bucket_covering_horizon(snapshot)
    if soc_by_bucket is None:
        raise ConditionRailsUnavailable(
            appliance_id, "the battery SoC forecast is unavailable"
        )

    threshold = inputs.value
    bucket_duration = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
    now = snapshot.context.now
    eligible: set[str] = set()
    for slot_id in inputs.horizon_slot_ids:
        pending = [
            bucket_start
            for bucket_start in _slot_bucket_starts(slot_id)
            if bucket_start + bucket_duration > now
        ]
        if pending and all(
            (soc_pct := soc_by_bucket.get(bucket_start)) is not None
            and soc_pct >= threshold
            for bucket_start in pending
        ):
            eligible.add(slot_id)
    return frozenset(eligible)


def _min_solar_coverage_mask(inputs: MaskInputs) -> frozenset[str]:
    """Slots whose every bucket's surplus covers the appliance's own demand.

    "Is this slot's energy free *right now*." For each 15-minute bucket the slot
    spans, the appliance's demand for that bucket must be met by the projected
    ``availableSurplusKwh`` to at least the configured share; the worst bucket
    decides, as in :func:`_min_soc_mask`.

    **Why this needs no simulation, unlike ``ensure_self_sustainability``.**
    ``availableSurplusKwh`` is what remains *after* the battery has charged, so
    it is non-zero only when solar exceeds what the battery can or will absorb.
    Consuming it neither discharges the battery nor slows its charge, so the SoC
    trajectory is unchanged — and distinct slots consume distinct buckets, so no
    placement changes another's coverage. That independence is what makes this a
    legal mask rather than a self-gating condition.

    Caveat worth knowing: during a ``charge_to_target_soc`` bucket the surplus
    can be non-zero while the house is *simultaneously* importing, so
    "solar-covered" does not strictly imply "free".

    ``100`` is the whole appliance running on sun alone. Lower values exist
    because full coverage is unreachable for the appliance class this targets: a
    1 kW pool pump against 0.8 kW of surplus is never covered, so a
    strict-only condition would mean "never runs".
    """
    snapshot = inputs.snapshot
    appliance_id = str(inputs.target.get("appliance_id"))
    # This condition gates placement, so an unavailable rail must void the run.
    # Yielding an empty mask instead would be indistinguishable from the
    # condition correctly saying "no sun anywhere", and would silently clear the
    # appliance rather than restoring its baseline actions.
    surplus_by_bucket = read_available_surplus_by_bucket_covering_horizon(snapshot)
    if surplus_by_bucket is None:
        raise ConditionRailsUnavailable(
            appliance_id, "the grid surplus forecast does not cover the horizon"
        )
    demand_hourly_energy = read_when_active_hourly_energy_kwh(snapshot, appliance_id)
    if demand_hourly_energy is None:
        raise ConditionRailsUnavailable(
            appliance_id, "the appliance's when-active demand profile is unavailable"
        )

    threshold = inputs.value
    eligible: set[str] = set()
    for slot_id in inputs.horizon_slot_ids:
        coverage_pct = slot_solar_coverage_pct(
            slot_id=slot_id,
            reference_time=snapshot.context.now,
            available_surplus_by_bucket=surplus_by_bucket,
            demand_hourly_energy=demand_hourly_energy,
        )
        if coverage_pct is not None and coverage_pct >= threshold:
            eligible.add(slot_id)
    return frozenset(eligible)


def _slot_bucket_starts(slot_id: str) -> tuple[datetime, ...]:
    """The forecast bucket starts a schedule slot spans, in order."""
    slot_start = parse_slot_id(slot_id)
    return tuple(
        slot_start + timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * index)
        for index in range(SCHEDULE_SLOT_MINUTES // FORECAST_CANONICAL_GRANULARITY_MINUTES)
    )


def _all_slots_mask(inputs: MaskInputs) -> frozenset[str]:
    return inputs.all_slots


CONDITION_TYPES: dict[str, ConditionType] = {
    condition.key: condition
    for condition in (
        ConditionType(
            key="run_when",
            scope=Scope.DAY,
            field=F.day_classifications("run_when", default=DAY_CLASSIFICATIONS),
            reason_code="day_not_matched",
            build_mask=_run_when_mask,
        ),
        # Optional, and deliberately without a default: a threshold of 0 is a
        # *restriction*, not the permissive no-op that `run_when`'s
        # all-classifications default is. Filling it in for a group that never
        # asked would silently gate `appliance_runtime` on negative prices. Absent
        # means unconstrained — an AND over no conditions is true.
        ConditionType(
            key="when_price_below",
            scope=Scope.SLOT,
            field=F.number("when_price_below", required=False),
            reason_code="price_not_below_threshold",
            build_mask=_export_price_below_mask,
        ),
        # Optional and without a default, for the same reason as
        # `when_price_below`: a floor filled in for a group that never asked for
        # one is a restriction nobody authored.
        ConditionType(
            key="min_soc_pct",
            scope=Scope.SLOT,
            field=F.soc("min_soc_pct", required=False),
            reason_code="soc_below_threshold",
            build_mask=_min_soc_mask,
        ),
        # Optional and without a default, as above: a coverage floor filled in
        # for a group that never asked for one would stop the appliance running
        # on any slot the sun does not already pay for.
        ConditionType(
            key="min_solar_coverage_pct",
            scope=Scope.SLOT,
            field=F.percent("min_solar_coverage_pct", required=False),
            reason_code="insufficient_solar_coverage",
            build_mask=_min_solar_coverage_mask,
        ),
        # Self-gating, and for a sharper reason than `reserve_floor_soc`: this
        # condition *couples slots*. Placing at 09:00 changes whether 20:00 is
        # feasible, and `system_mask &= mask` (evaluation.py) assumes slot
        # independence. So the mask is all-true, the optimizer re-simulates the
        # horizon with its own placements folded in, and the reason codes are
        # emitted from there rather than from here — a mask cannot say *which*
        # placement broke the floor. `reason_code` is the one a lone rejection
        # falls back to.
        #
        # The level is the condition's value rather than a bool beside a
        # separate knob: one key, three states (absent / soft / strict), so they
        # cannot contradict each other.
        ConditionType(
            key="ensure_self_sustainability",
            scope=Scope.RUN,
            field=F.string(
                "ensure_self_sustainability",
                required=False,
                choices=("soft", "strict"),
            ),
            reason_code="would_break_soc_floor",
            build_mask=_all_slots_mask,
            self_gating=True,
        ),
        # Self-gating: `charge_from_grid` conditions on the SoC dip over the
        # *expensive* band but writes into the *preceding cheap* band, so a mask
        # of "slots where SoC dips below the floor" would mark exactly the slots
        # it never touches. The mask is therefore all-true and the optimizer
        # reads the floor by value, keeping its own dip test. See
        # charge_from_grid._plan_window.
        ConditionType(
            key="reserve_floor_soc",
            scope=Scope.RUN,
            field=F.soc("reserve_floor_soc"),
            reason_code="window_covered",
            build_mask=_all_slots_mask,
            self_gating=True,
        ),
    )
}


def horizon_slot_ids(snapshot: "OptimizationSnapshot") -> tuple[str, ...]:
    return tuple(iter_horizon_slot_ids(snapshot.context.now))
