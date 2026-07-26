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
from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING, Any

from ...scheduling.schedule import parse_slot_id
from ..trace import NULL_TRACE, TraceConditionGroup
from .types import CONDITION_TYPES, MaskInputs, horizon_slot_ids

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
        """``(reason_code, value)`` for an ineligible slot, from the first group.

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
                return (condition.reason_code, value)
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
        system_mask = frozenset(slot_ids)
        for key, value in group.condition_values.items():
            mask = CONDITION_TYPES[key].build_mask(
                MaskInputs(
                    snapshot=snapshot,
                    value=value,
                    target=config.target,
                    master_params=config.params,
                    horizon_slot_ids=slot_ids,
                )
            )
            masks_by_key[key] = mask
            system_mask &= mask
        groups.append(
            GroupResolution(
                index=group.index,
                name=group.name,
                params=group.params,
                condition_values=dict(group.condition_values),
                custom_met=custom_met_by_group[group.index],
                system_mask=system_mask,
                masks_by_key=masks_by_key,
            )
        )

    (trace or NULL_TRACE).set_condition_groups(
        TraceConditionGroup(
            index=group.index,
            label=group.label,
            values=dict(group.condition_values),
            custom_met=group.custom_met,
        )
        for group in groups
    )
    return Eligibility(groups=tuple(groups), horizon_slot_ids=slot_ids)


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
