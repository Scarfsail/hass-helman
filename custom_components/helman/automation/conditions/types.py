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
    read_optional_float,
    read_soc_by_bucket_covering_horizon,
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
    eligible: set[str] = set()
    for slot_id in inputs.horizon_slot_ids:
        buckets = _slot_bucket_starts(slot_id)
        if all(
            (soc_pct := soc_by_bucket.get(bucket_start)) is not None
            and soc_pct >= threshold
            for bucket_start in buckets
        ):
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
