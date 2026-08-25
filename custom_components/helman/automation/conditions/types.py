"""The catalogue of system condition types.

Each type owns its value schema, its scope, its mask and its label — so adding
``run_when`` to ``export_price`` later is one entry in a tuple. A type is
identified everywhere by its ``key``: masks, explanation columns and the
``(key, value)`` rejections optimizers branch on all speak the same string.

**R1 — a mask reads ``target`` and the *master* params only, never a group's
override.** Resolved params depend on which group matched, which depends on the
masks; letting a mask read the override closes the loop. If a future condition
genuinely needs an overridden param, it is not a condition — it is optimizer
logic.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from enum import Enum
from typing import TYPE_CHECKING, Any

from ...const import (
    DAY_CLASSIFICATIONS,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
)
from ...scheduling.schedule import (
    iter_horizon_slot_ids,
    parse_slot_id,
)
from .. import fields as F
from ..fields import Field
from ..rails import (
    canonical_bucket_start,
    read_available_surplus_by_bucket_covering_horizon,
    read_export_price_by_bucket,
    read_optional_float,
    read_planned_appliance_slot_ids,
    read_soc_by_bucket_covering_horizon,
    read_when_active_hourly_energy_kwh,
    slot_bucket_starts,
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
class MaskResult:
    """A mask plus, optionally, what each slot actually presented.

    Only the conditions worth annotating build one — price, SoC, solar
    coverage, the day's classification — so that a slot rejected on price can
    carry the price that rejected it, and a slot that passed can carry the
    price it passed with. ``actuals_by_slot`` is the value the condition's own
    aggregation compared against the threshold (the *worst* bucket for an
    all-must-clear condition, the *best* for an any-may-clear one), recorded for
    every slot and kept for every slot: a threshold without the reading beside
    it is half a test, and which half is missing does not depend on the answer.
    """

    mask: frozenset[str]
    actuals_by_slot: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ConditionType:
    """One system condition: value schema, scope, mask and label."""

    key: str
    scope: Scope
    field: Field
    #: Returns the eligible slots, or a :class:`MaskResult` when it also has
    #: actuals to report. Call through :func:`evaluate_mask`, never directly.
    build_mask: Callable[[MaskInputs], "frozenset[str] | MaskResult"]
    self_gating: bool = False
    #: This entry configures *another* condition's test rather than being one.
    #: It admits every slot, resolves nothing, and gets no node in the
    #: explanation — a block that could only ever read "not evaluated" is noise
    #: on every group that carries the default. It lives among the conditions
    #: because that is where the knob it qualifies lives, not because it gates.
    qualifier: bool = False
    #: Localization key for the condition's human label, used by the explanation
    #: UI. Defaults to ``automation.condition.<key>``; a field rather than a
    #: derived property so a type can point elsewhere without a special case.
    label_key: str = ""

    def __post_init__(self) -> None:
        if not self.label_key:
            object.__setattr__(self, "label_key", f"automation.condition.{self.key}")

    @property
    def explain_scope(self) -> str:
        """The node scope string the explanation layer uses (``NODE_SCOPES``)."""
        return self.scope.value


def evaluate_mask(condition: ConditionType, inputs: MaskInputs) -> MaskResult:
    """Call a condition's mask and normalize it to a :class:`MaskResult`.

    The adapter is what lets only the annotated conditions change shape: a mask
    that has nothing to report keeps returning a bare ``frozenset``.
    """
    result = condition.build_mask(inputs)
    if isinstance(result, MaskResult):
        return result
    return MaskResult(mask=result)


def _run_when_mask(inputs: MaskInputs) -> MaskResult:
    """Slots whose day is classified as one of the configured kinds.

    Reports the classification it found, like the numeric conditions report the
    number they found: "which kinds are allowed" without "and what kind is
    today" is half a test, and the half the reader cannot supply themselves.
    """
    day_contexts = inputs.snapshot.context.day_contexts
    allowed = set(inputs.value)
    eligible: set[str] = set()
    actuals: dict[str, Any] = {}
    for slot_id in inputs.horizon_slot_ids:
        day_context = day_contexts.get(parse_slot_id(slot_id).date())
        actuals[slot_id] = None if day_context is None else day_context.classification
        if day_context is not None and day_context.classification in allowed:
            eligible.add(slot_id)
    return MaskResult(mask=frozenset(eligible), actuals_by_slot=actuals)


def _export_price_below_mask(inputs: MaskInputs) -> MaskResult:
    """Slots where the export price drops below the threshold at any point.

    A slot spans two forecast buckets and qualifies when **either** clears the
    threshold. That is the conservative reading for this kind: ``export_price``
    takes a protective action, so a slot half of which is priced badly is a
    slot to act on. ``appliance_runtime`` needs the opposite (permission to
    consume requires the *whole* slot to clear), which is why it has its own
    condition — see :func:`_max_run_price_mask`.

    Prices come from :func:`..rails.read_export_price_by_bucket` rather than
    from the raw points, so an hourly feed reaches every bucket of the hour
    instead of only the one a point lands in. A bucket the feed does not cover
    is absent, and absent never qualifies a slot.

    ``currentPrice`` is a second, independent reading of the bucket containing
    ``now``: either it or the published point can qualify the slot in progress,
    which is what the union has always done. It is deliberately not an override
    — a point that says the current bucket is negative still stops the export
    even when the live sensor has already ticked back above the threshold.

    The reported actual is the **cheapest** price the slot offers, since any
    bucket clearing the threshold qualifies it: that is the number the slot
    lost by.
    """
    price_by_bucket = read_export_price_by_bucket(inputs.snapshot)
    threshold = inputs.value
    current_price = read_optional_float(
        inputs.snapshot.context.export_price_forecast.get("currentPrice")
    )
    now_bucket = canonical_bucket_start(inputs.snapshot.context.now)
    current_bucket = (
        now_bucket
        if current_price is not None and current_price < threshold
        else None
    )
    eligible: set[str] = set()
    actuals: dict[str, Any] = {}
    for slot_id in inputs.horizon_slot_ids:
        if any(
            bucket_start == current_bucket
            or (
                (price := price_by_bucket.get(bucket_start)) is not None
                and price < threshold
            )
            for bucket_start in slot_bucket_starts(slot_id)
        ):
            eligible.add(slot_id)
        known = [
            price
            for bucket_start in slot_bucket_starts(slot_id)
            for price in (
                current_price if bucket_start == now_bucket else None,
                price_by_bucket.get(bucket_start),
            )
            if price is not None
        ]
        actuals[slot_id] = min(known) if known else None
    return MaskResult(mask=frozenset(eligible), actuals_by_slot=actuals)


def _max_run_price_mask(inputs: MaskInputs) -> MaskResult:
    """Slots whose export price stays at or below the threshold throughout.

    ``appliance_runtime`` reads this as permission to consume, the opposite of
    :func:`_export_price_below_mask`'s protective any-bucket reading: an
    appliance must not run straight through an expensive half of a slot, so
    every pending bucket has to clear the threshold, not just one (issue #5).

    Prices come from the same carry-forward rail as the export-side mask
    (:func:`..rails.read_export_price_by_bucket`), so a sparse or hourly feed
    already reaches every 15-minute bucket — no extra handling needed here for
    that. A bucket the feed doesn't cover is absent, and absent fails the
    slot closed, same as a bucket priced at or above the threshold.

    ``currentPrice`` is authoritative for the bucket containing ``now``, unlike
    the export-side mask's independent-OR treatment: a live sensor reading
    overrides the forecast point for that one bucket rather than adding another
    way to qualify it, because permission-to-consume should track the price
    actually in effect right now, not a stale point plus a live one both being
    allowed to win.

    Buckets that have already elapsed are skipped, mirroring
    :func:`_min_soc_mask`: gating on a bucket that's already history would
    switch the appliance off mid-run over a quarter-hour nothing can change.

    The reported actual is the **most expensive** pending bucket, since every
    one of them has to clear the threshold: that is the number that failed the
    slot. Buckets the feed does not cover fail the slot but contribute no
    number, so an all-unknown slot reports ``None``.
    """
    price_by_bucket = read_export_price_by_bucket(inputs.snapshot)
    threshold = inputs.value
    current_price = read_optional_float(
        inputs.snapshot.context.export_price_forecast.get("currentPrice")
    )
    now = inputs.snapshot.context.now
    current_bucket = canonical_bucket_start(now)
    bucket_duration = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)

    def _bucket_price(bucket_start: "datetime") -> float | None:
        if bucket_start == current_bucket and current_price is not None:
            return current_price
        return price_by_bucket.get(bucket_start)

    def _bucket_clears(bucket_start: "datetime") -> bool:
        price = _bucket_price(bucket_start)
        return price is not None and price < threshold

    eligible: set[str] = set()
    actuals: dict[str, Any] = {}
    for slot_id in inputs.horizon_slot_ids:
        pending = [
            bucket_start
            for bucket_start in slot_bucket_starts(slot_id)
            if bucket_start + bucket_duration > now
        ]
        if pending and all(_bucket_clears(bucket_start) for bucket_start in pending):
            eligible.add(slot_id)
        known = [
            price
            for price in (_bucket_price(bucket_start) for bucket_start in pending)
            if price is not None
        ]
        actuals[slot_id] = max(known) if known else None
    return MaskResult(mask=frozenset(eligible), actuals_by_slot=actuals)


def _min_soc_mask(inputs: MaskInputs) -> MaskResult:
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
    appliance_id = str(inputs.target.get("controllable_id"))
    soc_by_bucket = read_soc_by_bucket_covering_horizon(snapshot)
    if soc_by_bucket is None:
        raise ConditionRailsUnavailable(
            appliance_id, "the battery SoC forecast is unavailable"
        )

    threshold = inputs.value
    bucket_duration = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
    now = snapshot.context.now
    eligible: set[str] = set()
    actuals: dict[str, Any] = {}
    for slot_id in inputs.horizon_slot_ids:
        pending = [
            bucket_start
            for bucket_start in slot_bucket_starts(slot_id)
            if bucket_start + bucket_duration > now
        ]
        if pending and all(
            (soc_pct := soc_by_bucket.get(bucket_start)) is not None
            and soc_pct >= threshold
            for bucket_start in pending
        ):
            eligible.add(slot_id)
        # The worst pending bucket is the one that decides, so it is the one
        # worth reporting.
        known = [
            soc_pct
            for soc_pct in (soc_by_bucket.get(bucket) for bucket in pending)
            if soc_pct is not None
        ]
        actuals[slot_id] = min(known) if known else None
    return MaskResult(mask=frozenset(eligible), actuals_by_slot=actuals)


def _min_solar_coverage_mask(inputs: MaskInputs) -> MaskResult:
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
    appliance_id = str(inputs.target.get("controllable_id"))
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
    actuals: dict[str, Any] = {}
    for slot_id in inputs.horizon_slot_ids:
        coverage_pct = slot_solar_coverage_pct(
            slot_id=slot_id,
            reference_time=snapshot.context.now,
            available_surplus_by_bucket=surplus_by_bucket,
            demand_hourly_energy=demand_hourly_energy,
        )
        if coverage_pct is not None and coverage_pct >= threshold:
            eligible.add(slot_id)
        actuals[slot_id] = coverage_pct
    return MaskResult(mask=frozenset(eligible), actuals_by_slot=actuals)


def _requires_appliance_mask(inputs: MaskInputs) -> frozenset[str]:
    """Slots where the appliance this one depends on is planned to run.

    A pool heat pump heats nothing while the filtration pump is off, however
    cheap the slot is. This is the only mask that reads the **plan** rather than
    a forecast rail, and two things follow from that.

    It is what makes optimizer *order* load-bearing: ``snapshot.schedule``
    carries the writes of the optimizers before this one and none of the ones
    after (:mod:`..pipeline`), so a provider planned later is invisible here.
    Config validation warns about that arrangement rather than this mask
    pretending it did not happen.

    It does not weaken R1. R1 forbids reading a *group's override*, because
    resolved params depend on which group matched; the schedule is not a param
    and does not close that loop.

    No actuals: the only reading this condition has is the boolean the mask
    already is, and an actual that restates the verdict is noise on every slot.
    """
    return inputs.all_slots & read_planned_appliance_slot_ids(
        inputs.snapshot, str(inputs.value)
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
            build_mask=_run_when_mask,
        ),
        # A structural precondition rather than a threshold, which is why it
        # sits next to `run_when` and ahead of the numeric conditions: the
        # editor renders condition fields in this order.
        #
        # Optional and without a default. Absent means "depends on nothing" —
        # a dependency filled in for a group that never asked for one is a
        # restriction nobody authored, and no id could serve as a default
        # anyway. Absent is the *only* way to say that: `read_field` rejects an
        # empty string, so the editor must drop the key when the picker is
        # cleared rather than write "".
        ConditionType(
            key="requires_appliance",
            scope=Scope.SLOT,
            field=F.string("requires_appliance", required=False),
            build_mask=_requires_appliance_mask,
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
            build_mask=_export_price_below_mask,
        ),
        # `appliance_runtime`'s own price condition (issue #5): permission to
        # consume needs the opposite aggregation from `when_price_below`, so it
        # is a distinct key rather than a shared one with a hidden branch.
        # Same "optional, no default" reasoning as `when_price_below`.
        ConditionType(
            key="max_run_price",
            scope=Scope.SLOT,
            field=F.number("max_run_price", required=False),
            build_mask=_max_run_price_mask,
        ),
        # Optional and without a default, for the same reason as
        # `when_price_below`: a floor filled in for a group that never asked for
        # one is a restriction nobody authored.
        ConditionType(
            key="min_soc_pct",
            scope=Scope.SLOT,
            field=F.soc("min_soc_pct", required=False),
            build_mask=_min_soc_mask,
        ),
        # Optional and without a default, as above: a coverage floor filled in
        # for a group that never asked for one would stop the appliance running
        # on any slot the sun does not already pay for.
        ConditionType(
            key="min_solar_coverage_pct",
            scope=Scope.SLOT,
            field=F.percent("min_solar_coverage_pct", required=False),
            build_mask=_min_solar_coverage_mask,
        ),
        # Self-gating, and for a sharper reason than `reserve_floor_soc`: this
        # condition *couples slots*. Placing at 09:00 changes whether 20:00 is
        # feasible, and `system_mask &= mask` (evaluation.py) assumes slot
        # independence. So the mask is all-true, the optimizer re-simulates the
        # horizon with its own placements folded in, and the node is resolved
        # from there rather than from here — a mask cannot say *which* placement
        # broke the floor.
        #
        # The budget is the condition's value rather than a bool beside a
        # separate knob: one key, and absent still means unconstrained.
        #
        # **Zero is the strictest setting, not the absent one.** Every reader
        # must test `is None`, never truthiness — `if not value` would silently
        # disable the gate for the config that asked for the most.
        ConditionType(
            key="ensure_self_sustainability",
            scope=Scope.RUN,
            field=F.percent("ensure_self_sustainability", required=False),
            build_mask=_all_slots_mask,
            self_gating=True,
        ),
        # The floor `ensure_self_sustainability` keeps above the inverter's own
        # reserve, in percentage points. A condition rather than a param so it
        # sits beside the budget it qualifies, and so it varies per group with
        # the policy it belongs to.
        #
        # A *qualifier*, not a gate: it never admits or refuses a slot on its
        # own, it moves the floor the budget's own test compares against. So it
        # draws no block — `ensure_self_sustainability` reports the refusal, and
        # a second block reading "not evaluated" beside it, on every group,
        # would say nothing.
        #
        # A floor *at* min_soc is provably inert — every discharge path clamps
        # `remaining` to `min_energy_kwh`, so the projected SoC can never reach
        # min_soc, let alone breach it. Only a margin strictly above it gives
        # the floor teeth, which is what the default is for.
        ConditionType(
            key="self_sustainability_margin_pct",
            scope=Scope.RUN,
            field=F.percent("self_sustainability_margin_pct", default=5),
            build_mask=_all_slots_mask,
            qualifier=True,
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
            build_mask=_all_slots_mask,
            self_gating=True,
        ),
    )
}


def horizon_slot_ids(snapshot: "OptimizationSnapshot") -> tuple[str, ...]:
    return tuple(iter_horizon_slot_ids(snapshot.context.now))
