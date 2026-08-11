"""Per-run optimizer decision trace (observability layer).

The trace makes every automation run explainable: for each schedule slot and
each optimizer in the pipeline it records what the optimizer saw (rails), what
it did (framework-recorded writes and emitted decisions), and — via the
explanation layer in ``.explain`` — the condition logic that produced it. The
recorder is a *dumb appender* owned by the optimizer loop — it never raises into
the run, so an instrumentation bug can never stop the battery from charging.

Design notes:
- The serialized shape uses parallel arrays keyed by ``slotIds`` to stay compact.
- Coverage validation (below) never fails the run: an overlap or a write without
  a covering ``applied`` decision only warns and marks the step incomplete.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import logging
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from homeassistant.util import dt as dt_util

from ..scheduling.schedule import (
    SCHEDULE_SLOT_DURATION,
    format_slot_id,
    parse_slot_id,
)
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

# outcome vocabulary emitted by optimizers
DECISION_OUTCOMES: frozenset[str] = frozenset(
    {"applied", "rejected", "blocked", "out_of_scope"}
)


# --- serialized DTOs ---------------------------------------------------------


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

    def to_dict(self) -> dict[str, Any]:
        return {
            "slotId": self.slot_id,
            "domain": self.controllable_id,
            "before": self.before,
            "after": self.after,
        }


@dataclass(frozen=True)
class TraceDecision:
    """A group-encoded decision: one outcome covering a list of slots."""

    slot_ids: tuple[str, ...]
    outcome: str
    action: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "slotIds": list(self.slot_ids),
            "outcome": self.outcome,
        }
        if self.action is not None:
            payload["action"] = self.action
        return payload


@dataclass(frozen=True)
class TraceNote:
    code: str
    params: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "params": self.params}


@dataclass
class _MutableStep:
    optimizer_id: str
    kind: str
    # The lane this step writes: the controllable's own id, matching
    # `TraceWrite.controllable_id`. Set at `begin_step`; empty for callers that
    # do not supply it (unit tests), which simply forgoes winner attribution.
    controllable_id: str = ""
    status: str = "ok"
    complete: bool = True
    # False when this optimizer carries an execution condition that is NOT met:
    # its placements are candidates (kept for display, excluded from resource
    # accounting, never executed). The frontend explains its actions as tentative
    # rather than as planned-for-execution. Defaults True (no condition / met).
    condition_met: bool = True
    rails_in: dict[str, list[float | None]] = field(default_factory=dict)
    writes: list[TraceWrite] = field(default_factory=list)
    decisions: list[TraceDecision] = field(default_factory=list)
    notes: list[TraceNote] = field(default_factory=list)
    # --- explanation layer (see .explain) ---------------------------------
    # Serialized under the ``explanation`` key (pivoted against the run's
    # ``slotIds``) only once something is actually recorded, so an unconverted
    # optimizer's payload stays byte-identical.
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
        serialize as ``null`` in every column rather than claiming a verdict.

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
            status=self.explain_status or STATUS_OK,
            status_reason=self.explain_status_reason,
            slots=tuple(slots),
        )

    def to_dict(
        self,
        slot_ids: Sequence[str] = (),
        winners: Mapping[tuple[str, str], str] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "optimizerId": self.optimizer_id,
            "kind": self.kind,
            "status": self.status,
            "complete": self.complete,
            "railsIn": self.rails_in,
            "writes": [write.to_dict() for write in self.writes],
            "decisions": [decision.to_dict() for decision in self.decisions],
            "notes": [note.to_dict() for note in self.notes],
        }
        # Serialized only when present, to stay compact and keep existing
        # fixtures (which never set either) unchanged.
        if not self.condition_met:
            payload["conditionMet"] = False
        if self.has_explanation():
            payload["explanation"] = self.explanation(slot_ids, winners).to_dict(
                slot_ids
            )
        return payload


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

    All public mutators swallow their own errors: observability must never fail
    the run. ``to_dict`` produces the serialized shape returned by the
    ``helman/run_automation`` websocket.
    """

    def __init__(self, *, slot_ids: Sequence[str]) -> None:
        self._slot_ids: tuple[str, ...] = tuple(slot_ids)
        self._slot_id_set: frozenset[str] = frozenset(slot_ids)
        self._static_rails: dict[str, list[float | None]] = {}
        self._rails_final: dict[str, list[float | None]] = {}
        self._steps: list[_MutableStep] = []
        self._current: _MutableStep | None = None

    @property
    def slot_ids(self) -> tuple[str, ...]:
        return self._slot_ids

    # --- rails ---------------------------------------------------------------

    def set_static_rails(self, rails: dict[str, list[float | None]]) -> None:
        self._static_rails = rails

    def set_rails_final(self, rails: dict[str, list[float | None]]) -> None:
        self._rails_final = rails

    # --- step lifecycle ------------------------------------------------------

    def begin_step(
        self, optimizer_id: str, kind: str, *, controllable_id: str = ""
    ) -> None:
        """Open a step. ``controllable_id`` is the lane it writes.

        The controllable's own id — the same identity as
        :attr:`TraceWrite.controllable_id`, which is what lets winner
        attribution match a step's explanation rows against the writes that
        landed on its lane.
        """
        self._current = _MutableStep(
            optimizer_id=optimizer_id, kind=kind, controllable_id=controllable_id
        )

    def set_condition_met(self, condition_met: bool) -> None:
        """Record whether the current step's execution condition is met.

        Called by the optimizer loop once per step. ``False`` marks every
        placement this step makes as a candidate (condition not met), which the
        frontend surfaces as tentative in the run explanation.
        """
        if self._current is not None:
            self._current.condition_met = condition_met

    def set_rails_in(self, rails: dict[str, list[float | None]]) -> None:
        if self._current is not None:
            self._current.rails_in = rails

    def record_writes(self, writes: Iterable[TraceWrite]) -> None:
        if self._current is not None:
            self._current.writes = list(writes)

    def discard_step_decisions(self) -> None:
        """Drop partial decisions/notes for the current step (skip path)."""
        if self._current is not None:
            self._current.decisions = []
            self._current.notes = []

    def end_step(self, *, status: str) -> None:
        """Finalize the current step, running coverage validation.

        ``status="skipped"`` steps are exempt from the gap check (they carry a
        single horizon-wide note instead).
        """
        step = self._current
        self._current = None
        if step is None:
            return
        step.status = status
        if step.explain_status is None:
            # never stamped explicitly: inherit the loop's own verdict, so a
            # skipped/failed step stays distinguishable in the explanation too.
            step.explain_status = (
                status if status in OPTIMIZER_STATUSES else STATUS_OK
            )
        try:
            if status != "skipped":
                self._validate_coverage(step)
        except Exception:  # pragma: no cover - observability must not fail runs
            _LOGGER.exception("trace coverage validation failed; run continues")
        self._steps.append(step)

    # --- decisions / notes ---------------------------------------------------

    def decision(
        self,
        *,
        slot_ids: Sequence[str],
        outcome: str,
        action: dict[str, Any] | None = None,
    ) -> None:
        if self._current is None:
            return
        if outcome not in DECISION_OUTCOMES:
            _LOGGER.warning("trace decision has unknown outcome %r", outcome)
        self._current.decisions.append(
            TraceDecision(
                slot_ids=tuple(slot_ids),
                outcome=outcome,
                action=action,
            )
        )

    def note(self, *, code: str, params: dict[str, Any] | None = None) -> None:
        if self._current is None:
            return
        self._current.notes.append(TraceNote(code=code, params=params or {}))

    def note_horizon(
        self,
        *,
        code: str,
        params: dict[str, Any] | None = None,
        outcome: str = "out_of_scope",
    ) -> None:
        """Record a note and expand it to a horizon-wide decision group.

        Used for run-level rationales (battery params missing, forecast
        unavailable, optimizer skipped): the note carries the ``code``, the
        decision states the outcome it produced across the whole horizon.
        """
        if self._current is None:
            return
        self.note(code=code, params=params)
        self.decision(slot_ids=self._slot_ids, outcome=outcome)

    # --- explanation layer ---------------------------------------------------
    #
    # Where decisions say *what* an optimizer did, these record *the logic that
    # produced it*: the per-group condition matrix, the post-condition gates,
    # and the step's own status. They accumulate on the current step and are
    # assembled into a ``RunExplanation`` by the pipeline; they do not appear in
    # ``to_dict`` and never affect coverage validation.

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
                "trace group explanations reference %d off-horizon slot(s); "
                "dropped",
                strays,
            )
        step.group_explanations = stored

    def gate(
        self,
        *,
        slot_ids: Sequence[str],
        key: str,
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
        node = GateNode(key=key, state=state, params=dict(params or {}))
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

        Does not touch the decision-trace ``status``, which :meth:`end_step`
        owns; when this is never called, ``end_step`` back-fills from that.
        """
        step = self._current
        if step is None:
            return
        if status not in OPTIMIZER_STATUSES:
            _LOGGER.warning("trace step has unknown status %r", status)
        step.explain_status = status
        step.explain_status_reason = reason

    def winning_optimizers(self) -> dict[tuple[str, str], str]:
        """``(lane, slot id) -> the optimizer whose write survived``.

        ``ScheduleWriter.set_inverter`` blind-overwrites and guards only against
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
        optimizers=trace.optimizer_explanations())``. The same objects are what
        each step serializes under its ``explanation`` key.
        """
        winners = self.winning_optimizers()
        return tuple(
            step.explanation(self._slot_ids, winners) for step in self._steps
        )

    # --- coverage validation -------------------------------------------------

    def _validate_coverage(self, step: _MutableStep) -> None:
        """Warn about decisions that contradict the committed writes.

        Not every slot needs a decision — an optimizer that had nothing to say
        about a slot says nothing. What must hold is that no two decisions claim
        the same slot, and that every write is backed by an ``applied`` decision,
        because that pairing is what attributes a scheduled action to the step
        that produced it.
        """
        covered: set[str] = set()
        overlaps: set[str] = set()
        applied: set[str] = set()
        for decision in step.decisions:
            for slot_id in decision.slot_ids:
                if slot_id in covered:
                    overlaps.add(slot_id)
                covered.add(slot_id)
                if decision.outcome == "applied":
                    applied.add(slot_id)
        if overlaps:
            step.complete = False
            _LOGGER.warning(
                "trace overlap in step %s: %d slots claimed by >1 decision",
                step.optimizer_id,
                len(overlaps),
            )

        # writes must be explained by a covering `applied` decision
        unbacked_writes = [
            write
            for write in step.writes
            if write.slot_id in self._slot_id_set and write.slot_id not in applied
        ]
        if unbacked_writes:
            step.complete = False
            _LOGGER.warning(
                "trace: step %s has %d committed write(s) without an `applied` "
                "decision",
                step.optimizer_id,
                len(unbacked_writes),
            )

    # --- serialization -------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        winners = self.winning_optimizers()
        return {
            "slotIds": list(self._slot_ids),
            "staticRails": self._static_rails,
            "steps": [
                step.to_dict(self._slot_ids, winners) for step in self._steps
            ],
            "railsFinal": self._rails_final,
        }


# A shared no-op recorder for callers (e.g. unit tests) that invoke an optimizer
# without a live trace. It has no open step, so every mutator no-ops and nothing
# ever accumulates on it.
NULL_TRACE = OptimizerTrace(slot_ids=())


# --- buckets -> slots reducer -----------------------------------------------


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = dt_util.parse_datetime(value)
    if parsed is None:
        return None
    return dt_util.as_local(parsed)


def _read_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _slot_id_for_timestamp(
    timestamp: datetime, slot_id_set: frozenset[str]
) -> str | None:
    """Floor ``timestamp`` to its 30-min schedule slot boundary."""
    local = dt_util.as_local(timestamp)
    floored = local.replace(
        minute=(local.minute // 30) * 30,
        second=0,
        microsecond=0,
    )
    slot_id = format_slot_id(floored)
    return slot_id if slot_id in slot_id_set else None


def aggregate_series_to_slots(
    series: Any,
    slot_ids: Sequence[str],
    *,
    sum_fields: Sequence[str] = (),
    last_fields: Sequence[str] = (),
) -> dict[str, list[float | None]]:
    """Reduce 15-min canonical forecast buckets to 30-min schedule slots.

    ``sum_fields`` are summed across the covering buckets (energies);
    ``last_fields`` take the end-of-slot value (SoC trajectory). Slots past
    forecast coverage are left ``None``.
    """
    slot_id_set = frozenset(slot_ids)
    buckets_by_slot: dict[str, list[tuple[datetime, dict[str, Any]]]] = {
        slot_id: [] for slot_id in slot_ids
    }
    if isinstance(series, list):
        for entry in series:
            if not isinstance(entry, dict):
                continue
            timestamp = _parse_timestamp(entry.get("timestamp"))
            if timestamp is None:
                continue
            slot_id = _slot_id_for_timestamp(timestamp, slot_id_set)
            if slot_id is None:
                continue
            buckets_by_slot[slot_id].append((timestamp, entry))

    fields = (*sum_fields, *last_fields)
    result: dict[str, list[float | None]] = {
        field_name: [None] * len(slot_ids) for field_name in fields
    }
    for index, slot_id in enumerate(slot_ids):
        buckets = sorted(buckets_by_slot[slot_id], key=lambda item: item[0])
        if not buckets:
            continue
        for field_name in sum_fields:
            values = [
                value
                for _, entry in buckets
                if (value := _read_float(entry.get(field_name))) is not None
            ]
            result[field_name][index] = sum(values) if values else None
        for field_name in last_fields:
            last_value: float | None = None
            for _, entry in buckets:
                value = _read_float(entry.get(field_name))
                if value is not None:
                    last_value = value
            result[field_name][index] = last_value
    return result


def price_points_to_slots(
    points: Any,
    slot_ids: Sequence[str],
) -> list[float | None]:
    """Map a price forecast ``points[]`` step function onto schedule slots.

    Prices are step functions (a slot takes the most recent price at or before
    its start), not additive — so this is separate from the energy reducer.
    """
    parsed: list[tuple[datetime, float]] = []
    if isinstance(points, list):
        for point in points:
            if not isinstance(point, dict):
                continue
            timestamp = _parse_timestamp(point.get("timestamp"))
            value = _read_float(point.get("value"))
            if timestamp is None or value is None:
                continue
            parsed.append((timestamp, value))
    parsed.sort(key=lambda item: item[0])

    result: list[float | None] = [None] * len(slot_ids)
    for index, slot_id in enumerate(slot_ids):
        slot_start = parse_slot_id(slot_id)
        slot_end = slot_start + SCHEDULE_SLOT_DURATION
        current: float | None = None
        for timestamp, value in parsed:
            if timestamp <= slot_start:
                # latest price at or before the slot start (step function)
                current = value
            elif timestamp < slot_end and current is None:
                # no earlier price, but one starts within this slot
                current = value
                break
            else:
                break
        result[index] = current
    return result
