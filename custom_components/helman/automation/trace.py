"""Per-run committed writes and optimizer explanations.

The pipeline records actual schedule differences for winner attribution;
optimizers record the conditions, gates and verdicts behind their plans.
Reserve-floor observations remain a separate diagnostic-only collector.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import logging
from typing import Any, Iterable, Mapping, Sequence


from .explain import (
    NODE_SCOPES,
    NODE_STATES,
    OPTIMIZER_STATUSES,
    STATUS_OK,
    VERDICT_SKIP,
    VERDICTS,
    ConditionNode,
    GateNode,
    GroupExplanation,
    OptimizerExplanation,
    SlotExplanation,
)

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class TraceWrite:
    """A committed schedule write recorded by the framework diff (layer 1)."""

    slot_id: str
    #: The lane this write landed on: the controllable's own id, ``inverter``
    #: for the inverter. A plain id since the schedule flattened to one
    #: id-keyed map; it used to be prefixed ``appliance:<id>`` because the
    #: schedule had two domains to tell apart.
    controllable_id: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None


@dataclass(frozen=True)
class ReserveFloorObservation:
    """One evaluated expensive window from a ``charge_from_grid`` step (#274).

    Raw and unreduced — one entry per evaluated window, including overlapping
    windows — unlike ``_ChargeFromGridEmission`` (charge_from_grid.py), which
    is lossy per slot by design. This is the transport for the P0 reserve-floor
    breach classifier (#270/#274): a diagnostic-only collector on
    :class:`OptimizerTrace`, deliberately excluded from
    ``optimizer_explanations()`` so it never reaches the wire format or the
    inspector.

    ``limit`` records which cap bound the write: ``"cap"`` (target_soc clamped
    at the battery's ``max_soc``), ``"capacity"`` (the cheap window held fewer
    rankable slots than needed), or ``None``. Never ``"power"`` — charge power
    is already folded into ``slots_needed`` before this point.
    """

    #: The ``charge_from_grid`` instance that evaluated this window.
    optimizer_id: str
    #: The condition group whose ``reserve_floor_soc`` was consulted.
    group_index: int
    #: ``(start_slot_id, end_slot_id)`` of the expensive band being bridged.
    window: tuple[str, str]
    #: The resolved ``reserve_floor_soc`` for this group.
    reserve_floor_soc: float
    #: Whether the group's execution conditions were active this run.
    conditions_active: bool
    #: The projected SoC minimum across the window, as this step read it.
    #: ``None`` when the trajectory did not cover the window.
    projected_min_soc: float | None
    #: Whether this step actually wrote a bridge for the window.
    bridge_written: bool
    #: ``"cap"``, ``"capacity"``, or ``None``.
    limit: str | None = None


@dataclass
class _MutableStep:
    optimizer_id: str
    kind: str
    # The lane this step writes: the controllable's own id, matching
    # `TraceWrite.controllable_id`. Set at `begin_step`; empty for callers that
    # do not supply it (unit tests), which simply forgoes winner attribution.
    controllable_id: str = ""
    #: The runtime pipeline phase that produced this trace. Phase 1 is never
    #: traced, so explanation records only carry the authoritative phases 2/3.
    phase: int = 2
    status: str = "ok"
    writes: list[TraceWrite] = field(default_factory=list)
    # --- explanation layer (see .explain) ---------------------------------
    # slot_id -> group index -> group explanation, in first-recorded order.
    group_explanations: dict[str, dict[int, GroupExplanation]] = field(
        default_factory=dict
    )
    # slot_id -> gate key -> gate node, in first-recorded order.
    gates: dict[str, dict[str, GateNode]] = field(default_factory=dict)
    # slot_id -> terminal verdict; unrecorded slots fall back to ``skip``.
    verdicts: dict[str, str] = field(default_factory=dict)
    # ``None`` until stamped; ``end_step`` falls back to its own status.
    explain_status: str | None = None
    explain_status_reason: str | None = None

    def has_explanation(self) -> bool:
        return bool(self.group_explanations or self.gates or self.verdicts)

    def explanation(
        self,
        slot_ids: Sequence[str],
        winners: Mapping[tuple[str, str], str] | None = None,
    ) -> OptimizerExplanation:
        """Assemble what was recorded into an :class:`OptimizerExplanation`.

        A slot appears only where this step actually said something about it
        (groups, gates or a verdict); slots it never looked at stay absent, and
        have no explanation row rather than claiming a verdict.

        ``winners`` maps ``(lane, slot id)`` to the optimizer whose write
        survived on that lane, so a row can say "yes I decided execute, and no,
        that is not what the schedule shows".
        """
        slots: list[SlotExplanation] = []
        for slot_id in slot_ids:
            groups = self.group_explanations.get(slot_id) or {}
            gates = self.gates.get(slot_id) or {}
            verdict = self.verdicts.get(slot_id)
            if not groups and not gates and verdict is None:
                continue
            slots.append(
                SlotExplanation(
                    slot_id=slot_id,
                    groups=tuple(groups[index] for index in sorted(groups)),
                    gates=tuple(gates.values()),
                    verdict=verdict or VERDICT_SKIP,
                    winning_optimizer=(winners or {}).get(
                        (self.controllable_id, slot_id)
                    ),
                )
            )
        return OptimizerExplanation(
            optimizer_id=self.optimizer_id,
            kind=self.kind,
            controllable_id=self.controllable_id,
            phase=self.phase,
            status=self.explain_status or STATUS_OK,
            status_reason=self.explain_status_reason,
            slots=tuple(slots),
        )


def _resolve_nodes(
    nodes: tuple[ConditionNode, ...],
    key: str,
    state: str,
    value: Any,
    actual: Any,
    scope: str | None,
) -> tuple[tuple[ConditionNode, ...], bool]:
    """Replace the ``key`` node with its resolved result.

    Nodes are flat -- ``build_group_explanations`` emits one per configured
    condition and nothing below it -- so this is a single pass, not a walk.
    """
    resolved: list[ConditionNode] = []
    changed = False
    for node in nodes:
        if node.key == key:
            resolved.append(
                replace(
                    node,
                    state=state,
                    value=node.value if value is None else value,
                    actual=actual,
                    scope=node.scope if scope is None else scope,
                )
            )
            changed = True
            continue
        resolved.append(node)
    return tuple(resolved), changed


class OptimizerTrace:
    """Per-run recorder. One instance per automation run, owned by the loop.

    The pipeline owns its lifecycle; explanation rows serve the schedule UI.
    """

    def __init__(self, *, slot_ids: Sequence[str]) -> None:
        self._slot_ids: tuple[str, ...] = tuple(slot_ids)
        self._slot_id_set: frozenset[str] = frozenset(slot_ids)
        self._steps: list[_MutableStep] = []
        self._current: _MutableStep | None = None
        # Raw #274 collector, kept strictly separate from the explanation gates
        # above: see `ReserveFloorObservation`. Never serialized.
        self._reserve_floor_observations: list[ReserveFloorObservation] = []

    @property
    def slot_ids(self) -> tuple[str, ...]:
        return self._slot_ids

    # --- step lifecycle ------------------------------------------------------

    def begin_step(
        self,
        optimizer_id: str,
        kind: str,
        *,
        controllable_id: str = "",
        phase: int = 2,
    ) -> None:
        """Open a step. ``controllable_id`` is the lane it writes.

        The controllable's own id — the same identity as
        :attr:`TraceWrite.controllable_id`, which is what lets winner
        attribution match a step's explanation rows against the writes that
        landed on its lane.
        """
        self._current = _MutableStep(
            optimizer_id=optimizer_id,
            kind=kind,
            controllable_id=controllable_id,
            phase=phase,
        )


    def record_writes(self, writes: Iterable[TraceWrite]) -> None:
        if self._current is not None:
            self._current.writes = list(writes)

    def end_step(self, *, status: str) -> None:
        """Finalize the current step and retain its execution status."""
        step = self._current
        self._current = None
        if step is None:
            return
        step.status = status
        if step.explain_status is None:
            # never stamped explicitly: inherit the loop's own verdict, so a
            # skipped/failed step stays distinguishable in the explanation too.
            step.explain_status = status if status in OPTIMIZER_STATUSES else STATUS_OK
        self._steps.append(step)

    # --- explanation layer ---------------------------------------------------

    def _horizon_slots(self, slot_ids: Iterable[str], what: str) -> list[str]:
        """Filter to horizon slots, warning about (and dropping) strays."""
        known: list[str] = []
        strays = 0
        for slot_id in slot_ids:
            if slot_id in self._slot_id_set:
                known.append(slot_id)
            else:
                strays += 1
        if strays:
            _LOGGER.warning(
                "trace %s references %d off-horizon slot(s); dropped",
                what,
                strays,
            )
        return known

    def set_group_explanations(
        self,
        explanations: Mapping[str, Iterable[GroupExplanation]],
    ) -> None:
        """Attach the per-group condition explanations for the current step.

        ``explanations`` maps slot id -> the ORed condition groups as they
        resolved for that slot. Stamped once where the information is born
        (``build_eligibility``) rather than by each optimizer. Replaces whatever
        was recorded before, so a re-evaluating step cannot end up with two
        generations mixed.
        """
        step = self._current
        if step is None:
            return
        if not isinstance(explanations, Mapping):
            _LOGGER.warning(
                "trace group explanations must be a mapping, got %r",
                type(explanations).__name__,
            )
            return
        stored: dict[str, dict[int, GroupExplanation]] = {}
        strays = 0
        for slot_id, groups in explanations.items():
            if slot_id not in self._slot_id_set:
                strays += 1
                continue
            by_index: dict[int, GroupExplanation] = {}
            for group in groups:
                by_index[group.index] = group
            stored[slot_id] = by_index
        if strays:
            _LOGGER.warning(
                "trace group explanations reference %d off-horizon slot(s); dropped",
                strays,
            )
        step.group_explanations = stored

    def gate(
        self,
        *,
        slot_ids: Sequence[str],
        key: str,
        role: str,
        state: str,
        params: dict[str, Any] | None = None,
    ) -> None:
        """Record a post-condition gate for a set of slots.

        Gates are the part of a slot's fate that lives outside the condition
        rails: window, deadline, capacity, daily-minimum bookkeeping, the
        day-hold release, the writer-level ``blocked_user_owned`` veto.

        ``state`` is tri-valued plus ``not_applicable`` (:data:`NODE_STATES`) —
        a gate the optimizer short-circuited past is ``not_evaluated``, never
        ``false``.

        **Ranking is an ordinal, not a gate result.** "You lost to 4 cheaper
        slots" has no truth value, so cheapness ranking is recorded as ``rank``
        / ``rank_of`` inside ``params`` (per slot, hence one call per slot);
        ``state`` then only says whether the slot made the cut, and may be
        ``not_applicable`` for a purely informational ordinal.

        Re-recording the same key for the same slot overwrites: the last word
        an optimizer has about a gate is the one that decided the slot.
        """
        step = self._current
        if step is None:
            return
        if state not in NODE_STATES:
            _LOGGER.warning("trace gate %r has unknown state %r", key, state)
        node = GateNode(key=key, role=role, state=state, params=dict(params or {}))
        for slot_id in self._horizon_slots(slot_ids, f"gate {key!r}"):
            step.gates.setdefault(slot_id, {})[key] = node

    def set_verdict(self, *, slot_ids: Sequence[str], verdict: str) -> None:
        """Record the terminal verdict for a set of slots.

        ``execute`` = written and meant to run, ``candidate`` = written with
        ``condition_met=false`` (kept for display, never executed), ``skip`` =
        nothing placed. Slots an optimizer never stamps default to ``skip``,
        which is the honest reading of "the conditions said something about this
        slot and nothing was placed".

        Re-recording overwrites: the last word wins, so an optimizer may stamp a
        horizon-wide ``skip`` baseline and then upgrade the slots it wrote.
        """
        step = self._current
        if step is None:
            return
        if verdict not in VERDICTS:
            _LOGGER.warning("trace has unknown verdict %r", verdict)
        for slot_id in self._horizon_slots(slot_ids, f"verdict {verdict!r}"):
            step.verdicts[slot_id] = verdict

    def resolve_condition(
        self,
        *,
        slot_ids: Sequence[str],
        key: str,
        state: str,
        value: Any = None,
        actual: Any = None,
        group_index: int | None = None,
        scope: str | None = None,
    ) -> None:
        """Resolve a self-gating condition node the rails could not decide.

        ``ensure_self_sustainability`` and ``reserve_floor_soc`` deliberately
        contribute an all-true mask, so ``build_eligibility`` can only leave
        them ``not_evaluated``; only the optimizer that consults them knows
        their real result — and, for a capped run, which slots it never got as
        far as consulting. This overwrites the placeholder in place.

        ``scope`` re-scopes the node, because only the optimizer knows how
        finely its answer discriminates: ``reserve_floor_soc`` is registered
        RUN-scoped (one configured floor per run) but *resolves* per expensive
        band, so leaving it run-scoped would render one spanning cell over a
        horizon where the answer changes from window to window. ``None`` keeps
        the scope the condition type declared.

        ``group_index=None`` resolves the node in every group that carries it.
        Slots where no such node exists are skipped with a warning: a condition
        a group does not configure must stay ``not_applicable``, never be
        invented here.
        """
        step = self._current
        if step is None:
            return
        if state not in NODE_STATES:
            _LOGGER.warning(
                "trace condition resolution %r has unknown state %r", key, state
            )
        if scope is not None and scope not in NODE_SCOPES:
            _LOGGER.warning(
                "trace condition resolution %r has unknown scope %r", key, scope
            )
        missing = 0
        for slot_id in self._horizon_slots(slot_ids, f"condition {key!r}"):
            groups = step.group_explanations.get(slot_id)
            if not groups:
                missing += 1
                continue
            resolved_any = False
            for index, group in groups.items():
                if group_index is not None and index != group_index:
                    continue
                conditions, changed = _resolve_nodes(
                    group.conditions, key, state, value, actual, scope
                )
                if changed:
                    groups[index] = replace(group, conditions=conditions)
                    resolved_any = True
            if not resolved_any:
                missing += 1
        if missing:
            _LOGGER.warning(
                "trace: condition %r has no placeholder node in %d slot(s); "
                "resolution dropped",
                key,
                missing,
            )

    def set_step_status(self, *, status: str, reason: str | None = None) -> None:
        """Record the current step's explanation status and why.

        ``status`` is one of :data:`OPTIMIZER_STATUSES` (``ok`` / ``skipped`` /
        ``failed``). A skipped or failed step must never be indistinguishable
        from a step that evaluated every slot to ``false`` — ``reason`` carries
        the cause (``condition_rails_unavailable``, ``battery_params_missing``,
        ``stop_export_unsupported``, ...).

        Does not touch the pipeline step ``status``, which :meth:`end_step`
        owns; when this is never called, ``end_step`` back-fills from that.
        """
        step = self._current
        if step is None:
            return
        if status not in OPTIMIZER_STATUSES:
            _LOGGER.warning("trace step has unknown status %r", status)
        step.explain_status = status
        step.explain_status_reason = reason

    # --- #274 reserve-floor observations --------------------------------

    def record_reserve_floor_observation(
        self, observation: ReserveFloorObservation
    ) -> None:
        """Append one raw observation for the current step (#274).

        No-ops with no open step, mirroring every other mutator — so calling
        an optimizer against ``NULL_TRACE`` (no ``begin_step``) never leaks
        into the shared singleton. Swallows its own errors: observability must
        never fail the run.
        """
        if self._current is None:
            return
        try:
            self._reserve_floor_observations.append(observation)
        except Exception:  # pragma: no cover - observability must not fail runs
            _LOGGER.debug("trace reserve floor observation failed", exc_info=True)

    @property
    def reserve_floor_observations(self) -> tuple[ReserveFloorObservation, ...]:
        """The raw, unreduced observations recorded this run.

        Deliberately absent from ``optimizer_explanations()``
        — see :class:`ReserveFloorObservation`.
        """
        return tuple(self._reserve_floor_observations)

    def winning_optimizers(self) -> dict[tuple[str, str], str]:
        """``(lane, slot id) -> the optimizer whose write survived``.

        ``ScheduleWriter.set`` blind-overwrites and guards only against
        *user*-owned actions, so among optimizers the schedule is
        **last-writer-wins in pipeline order**: an optimizer can decide
        ``execute``, write, and silently lose to a later step. Steps are visited
        in order and each write overwrites the previous claim, so the last one
        standing is what the schedule actually shows.

        Slots nobody wrote have no entry — an unwritten slot has no winner, and
        inventing one would read as "you were overwritten" for a step that in
        fact landed a no-op.
        """
        winners: dict[tuple[str, str], str] = {}
        for step in self._steps:
            for write in step.writes:
                winners[(write.controllable_id, write.slot_id)] = step.optimizer_id
        return winners

    def optimizer_explanations(self) -> tuple[OptimizerExplanation, ...]:
        """The recorded explanation data, one entry per ended step.

        The assembly seam for the run record: a caller builds
        ``RunExplanation(run_at=..., slot_ids=trace.slot_ids,
        optimizers=trace.optimizer_explanations())``.
        """
        winners = self.winning_optimizers()
        return tuple(step.explanation(self._slot_ids, winners) for step in self._steps)


# A shared no-op recorder for callers (e.g. unit tests) that invoke an optimizer
# without a live trace. It has no open step, so every mutator no-ops and nothing
# ever accumulates on it.
NULL_TRACE = OptimizerTrace(slot_ids=())
