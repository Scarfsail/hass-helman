"""Group/OR semantics over condition masks — written once, for every optimizer.

```
group.system_mask = AND(mask(c) for c in group's system conditions)
group.custom_met  = evaluate(group.custom)                    # constant per run
planned[s]   = any(g.system_mask[s] and g.custom_met for g in groups)
candidate[s] = (not planned[s]) and any(g.system_mask[s] for g in groups)
matched[s]   = first g with (g.system_mask[s] and g.custom_met),
               else first g with g.system_mask[s]
```

Candidates are the pre-existing behaviour made explicit: a group whose system
conditions match but whose ``custom`` conditions are false still places its
actions, visible and ``condition_met=false``, excluded from resource accounting
and never executed. When the system conditions themselves don't match, nothing
is placed at all.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any

from ...scheduling.schedule import parse_slot_id
from ..explain import (
    PARAMS_SOURCE_DAY_RESOLVED,
    PARAMS_SOURCE_MASTER_FALLBACK,
    PARAMS_SOURCE_SLOT_MATCHED,
    STATE_FALSE,
    STATE_NOT_APPLICABLE,
    STATE_NOT_EVALUATED,
    STATE_TRUE,
    ConditionNode,
    GroupExplanation,
)
from ..trace import NULL_TRACE, TraceConditionGroup
from .types import CONDITION_TYPES, MaskInputs, Scope, evaluate_mask, horizon_slot_ids

if TYPE_CHECKING:
    from ..config import OptimizerInstanceConfig
    from ..snapshot import OptimizationSnapshot
    from ..trace import OptimizerTrace


@dataclass(frozen=True)
class GroupResolution:
    """One condition group, resolved against this run's snapshot."""

    index: int
    name: str | None
    params: dict[str, Any]
    condition_values: dict[str, Any]
    custom_met: bool
    system_mask: frozenset[str]
    # Per-condition masks before the AND, so `Eligibility.rejection` can name
    # *which* condition excluded a slot rather than just that one did.
    masks_by_key: dict[str, frozenset[str]]
    # What each slot actually presented, per condition, for the conditions that
    # report it (price, SoC, solar coverage). Explanation-only: nothing in
    # `Eligibility` reads it.
    actuals_by_key: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def label(self) -> str:
        """The name the inspector shows; falls back to the config index."""
        return self.name or f"#{self.index + 1}"


@dataclass(frozen=True)
class SlotEligibility:
    """The group that owns one slot, and the params resolved for it."""

    slot_id: str
    group: GroupResolution

    @property
    def params(self) -> dict[str, Any]:
        return self.group.params

    @property
    def condition_met(self) -> bool:
        """``False`` places the action as a candidate rather than as planned."""
        return self.group.custom_met

    def condition_value(self, key: str, default: Any = None) -> Any:
        return self.group.condition_values.get(key, default)


class Eligibility:
    """Which slots this optimizer may act on, under which group's params."""

    def __init__(
        self,
        *,
        groups: tuple[GroupResolution, ...],
        horizon_slot_ids: tuple[str, ...],
    ) -> None:
        self.groups = groups
        self.horizon_slot_ids = horizon_slot_ids
        self._matched: dict[str, GroupResolution] = {}
        planned: list[str] = []
        candidates: list[str] = []
        for slot_id in horizon_slot_ids:
            matching = [group for group in groups if slot_id in group.system_mask]
            if not matching:
                continue
            fully = next((group for group in matching if group.custom_met), None)
            self._matched[slot_id] = fully or matching[0]
            (planned if fully is not None else candidates).append(slot_id)
        self.planned_slot_ids = tuple(planned)
        self.candidate_slot_ids = tuple(candidates)

    @property
    def condition_met_by_group(self) -> tuple[bool, ...]:
        return tuple(group.custom_met for group in self.groups)

    def at(self, slot_id: str) -> SlotEligibility | None:
        """The slot's matched group, or ``None`` when no group's mask covers it."""
        group = self._matched.get(slot_id)
        return None if group is None else SlotEligibility(slot_id, group)

    def for_day(self, local_date: date) -> SlotEligibility | None:
        """The group whose params a day runs under, for kinds that resolve per day.

        When every condition is day- or run-scoped, all slots of a day resolve
        to the same group and there is nothing to choose. A slot-scoped
        condition breaks that: with a price threshold in play, one group may own
        the day's cheap slots and another its expensive ones. The tie goes to
        the **first group in config order** that owns any slot of the day —
        config order is what the user reads as their primary intent, matching
        :meth:`rejection`. Resolving by earliest *slot* instead would hand the
        day to whichever group happened to own the first quarter-hour.

        A kind using this must still restrict its writes to the slots that group
        owns (:meth:`slot_ids_owned_by`); the params are day-wide, the
        eligibility is not.
        """
        day_slot_ids = frozenset(
            slot_id
            for slot_id in self.horizon_slot_ids
            if parse_slot_id(slot_id).date() == local_date
        )
        for group in self.groups:
            owned = self.slot_ids_owned_by(group) & day_slot_ids
            if not owned:
                continue
            first = next(s for s in self.horizon_slot_ids if s in owned)
            return SlotEligibility(first, group)
        return None

    def slot_ids_owned_by(self, group: GroupResolution) -> frozenset[str]:
        """Slots this group *matched*, i.e. won over its siblings — not its mask.

        A slot inside two groups' masks belongs to only one of them (see
        :meth:`at`), so an optimizer that placed on the raw mask would write
        into slots a different group's params govern.
        """
        return frozenset(
            slot_id
            for slot_id, matched in self._matched.items()
            if matched is group
        )

    def iter_slots(self) -> Iterator[SlotEligibility]:
        """Every eligible slot in horizon order, planned and candidate alike."""
        for slot_id in self.horizon_slot_ids:
            resolved = self.at(slot_id)
            if resolved is not None:
                yield resolved

    def rejection(self, slot_id: str) -> tuple[str, Any] | None:
        """``(condition_key, value)`` for an ineligible slot, from the first group.

        The key is the condition's own key — the same string the condition
        matrix columns are keyed by — so a caller branching on a rejection and
        the explanation payload cannot drift apart. (It used to be a separate
        ``reason_code`` string, one per type, which had to be kept in sync by
        hand.) ``value`` is what the group configured for that condition.

        The first group is the one the user reads as the primary intent, so its
        failing condition is the explanation worth showing. ``None`` when the
        slot is eligible or there are no groups.
        """
        if slot_id in self._matched or not self.groups:
            return None
        group = self.groups[0]
        for key, value in group.condition_values.items():
            condition = CONDITION_TYPES[key]
            if condition.self_gating:
                continue
            if slot_id not in group.masks_by_key[key]:
                return (condition.key, value)
        return None


def build_eligibility(
    snapshot: "OptimizationSnapshot",
    config: "OptimizerInstanceConfig",
    trace: "OptimizerTrace | None" = None,
) -> Eligibility:
    """Evaluate every group's mask and fold them into one :class:`Eligibility`."""
    slot_ids = horizon_slot_ids(snapshot)
    custom_met_by_group = _custom_met_by_group(snapshot, config)

    groups: list[GroupResolution] = []
    for group in config.conditions:
        masks_by_key: dict[str, frozenset[str]] = {}
        actuals_by_key: dict[str, dict[str, Any]] = {}
        system_mask = frozenset(slot_ids)
        for key, value in group.condition_values.items():
            result = evaluate_mask(
                CONDITION_TYPES[key],
                MaskInputs(
                    snapshot=snapshot,
                    value=value,
                    target=config.target,
                    master_params=config.params,
                    horizon_slot_ids=slot_ids,
                ),
            )
            masks_by_key[key] = result.mask
            if result.actuals_by_slot:
                actuals_by_key[key] = dict(result.actuals_by_slot)
            system_mask &= result.mask
        groups.append(
            GroupResolution(
                index=group.index,
                name=group.name,
                params=group.params,
                condition_values=dict(group.condition_values),
                custom_met=custom_met_by_group[group.index],
                system_mask=system_mask,
                masks_by_key=masks_by_key,
                actuals_by_key=actuals_by_key,
            )
        )

    recorder = trace or NULL_TRACE
    recorder.set_condition_groups(
        TraceConditionGroup(
            index=group.index,
            label=group.label,
            values=dict(group.condition_values),
            custom_met=group.custom_met,
        )
        for group in groups
    )
    eligibility = Eligibility(groups=tuple(groups), horizon_slot_ids=slot_ids)
    if trace is not None:
        # A node per group per condition per horizon slot is real work, and the
        # forecast/projection paths (which pass no trace) would throw all of it
        # away — `NULL_TRACE` has no current step to record onto.
        trace.set_group_explanations(
            build_group_explanations(snapshot, config, eligibility)
        )
    return eligibility


# --- explanation ------------------------------------------------------------


def _condition_column_keys(
    groups: tuple[GroupResolution, ...],
) -> tuple[str, ...]:
    """The union of every group's condition keys, in first-appearance order.

    Groups may configure different condition sets, so the matrix has one column
    per key any group uses; the groups that don't use it report
    ``not_applicable`` there rather than an unearned ``true``.
    """
    keys: list[str] = []
    for group in groups:
        for key in group.condition_values:
            if key not in keys:
                keys.append(key)
    return tuple(keys)


def _condition_nodes(
    group: GroupResolution,
    column_keys: tuple[str, ...],
    slot_id: str,
) -> tuple[ConditionNode, ...]:
    nodes: list[ConditionNode] = []
    for key in column_keys:
        condition = CONDITION_TYPES[key]
        if key not in group.condition_values:
            nodes.append(
                ConditionNode(
                    key=key,
                    scope=condition.explain_scope,
                    state=STATE_NOT_APPLICABLE,
                )
            )
            continue
        value = group.condition_values[key]
        if condition.self_gating:
            # `_all_slots_mask` is a placeholder, not a result: reading it here
            # would render "always true" for a condition that has not been
            # consulted yet. The optimizer that does consult it overwrites this
            # node through `OptimizerTrace.resolve_condition`.
            nodes.append(
                ConditionNode(
                    key=key,
                    scope=condition.explain_scope,
                    state=STATE_NOT_EVALUATED,
                    value=value,
                )
            )
            continue
        passed = slot_id in group.masks_by_key[key]
        nodes.append(
            ConditionNode(
                key=key,
                scope=condition.explain_scope,
                state=STATE_TRUE if passed else STATE_FALSE,
                value=value,
                # Recorded whether the slot passed or failed. A threshold on its
                # own is only half a test: "≥ 40" says what was asked for and
                # nothing about what the slot brought, so a passing node was
                # unreadable exactly where a reader wants to know the margin --
                # 41 % and 95 % pass the same condition and mean very different
                # things about tomorrow.
                actual=group.actuals_by_key.get(key, {}).get(slot_id),
            )
        )
    return tuple(nodes)


def _custom_results(
    snapshot: "OptimizationSnapshot",
    config: "OptimizerInstanceConfig",
) -> dict[int, tuple[bool | None, ...]]:
    """Per-entry ``custom`` results by group index.

    ``None`` is an entry that *errored* rather than one that evaluated false —
    the whole point of ``CustomConditionResult.errored``. A run that never
    evaluated custom conditions (forecast/projection) contributes nothing, and
    the groups' ``custom_results`` stay empty.
    """
    detailed = snapshot.context.custom_condition_results_by_optimizer_id.get(config.id)
    if not detailed:
        return {}
    return {
        result.index: tuple(
            None if entry.errored else entry.met for entry in result.entries
        )
        for result in detailed
    }


def build_group_explanations(
    snapshot: "OptimizationSnapshot",
    config: "OptimizerInstanceConfig",
    eligibility: Eligibility,
) -> dict[str, tuple[GroupExplanation, ...]]:
    """The per-slot condition matrix: every group, every column, every slot.

    Every configured group appears in every horizon slot — the matrix is what a
    reader compares across groups, so a group that matched nothing must still
    show *why*, column by column.

    ``params_source`` follows the kind's ``param_scope`` rather than the group:
    a SLOT-scoped kind reads the params of whichever group ``at(slot)`` matched,
    while a DAY/RUN-scoped kind resolves them once per day through
    :meth:`Eligibility.for_day`, which may pick a different group than the one
    matching the slot. Where ``for_day`` finds no group at all, such a kind falls
    back to master params — ``master_fallback``. Without the marker the params
    column silently shows numbers the optimizer never ran under.
    """
    column_keys = _condition_column_keys(eligibility.groups)
    custom_results = _custom_results(snapshot, config)
    day_scoped = config.spec.param_scope is not Scope.SLOT

    source_by_date: dict[date, str] = {}
    explanations: dict[str, tuple[GroupExplanation, ...]] = {}
    for slot_id in eligibility.horizon_slot_ids:
        if day_scoped:
            local_date = parse_slot_id(slot_id).date()
            params_source = source_by_date.get(local_date)
            if params_source is None:
                params_source = (
                    PARAMS_SOURCE_DAY_RESOLVED
                    if eligibility.for_day(local_date) is not None
                    else PARAMS_SOURCE_MASTER_FALLBACK
                )
                source_by_date[local_date] = params_source
        else:
            params_source = PARAMS_SOURCE_SLOT_MATCHED
        explanations[slot_id] = tuple(
            GroupExplanation(
                index=group.index,
                label=group.label,
                params=dict(group.params),
                params_source=params_source,
                custom_results=custom_results.get(group.index, ()),
                conditions=_condition_nodes(group, column_keys, slot_id),
            )
            for group in eligibility.groups
        )
    return explanations


def _custom_met_by_group(
    snapshot: "OptimizationSnapshot",
    config: "OptimizerInstanceConfig",
) -> tuple[bool, ...]:
    """Per-group ``custom`` results, defaulting to met when the run didn't evaluate.

    Forecast/projection paths build snapshots without evaluating conditions; an
    optimizer id absent from the map means "not evaluated", which stays "met" so
    those paths keep seeing the plan the automation would produce.
    """
    evaluated = snapshot.context.condition_met_by_optimizer_id.get(config.id)
    if evaluated is None:
        return tuple(True for _ in config.conditions)
    return tuple(
        evaluated[group.index] if group.index < len(evaluated) else True
        for group in config.conditions
    )
