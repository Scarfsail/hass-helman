"""Per-slot condition evaluation records (the "why" layer).

Where :mod:`.trace` records *what an optimizer did*, this module records *the
logic that produced it*: for every horizon slot and every optimizer, the params
it would have run under, one node per condition (system + custom) with its own
tri-valued result and the input that produced it, the post-condition gates the
optimizer applies (window, deadline, capacity, ranking, ...), and the terminal
verdict.

Design notes:
- **Node state is tri-valued plus "not applicable"** (:data:`NODE_STATES`). A
  capped ``appliance_runtime`` stops consulting its self-sustainability gate once
  ``slots_needed`` is met, so the remaining slots are ``not_evaluated``, not
  ``false``; a condition a group does not configure is ``not_applicable``, never
  ``true``. Nothing here may silently read as "passed".
- **Node scope is explicit** (:data:`NODE_SCOPES`). ``reserve_floor_soc`` tests
  the expensive band while writing the preceding cheap one, so its result is
  window-scoped; rendering it as a per-slot column would be a lie.
- The DTOs are **per slot** (one :class:`SlotExplanation` per horizon slot).
  The encoded serialization **pivots** them into index-aligned columns keyed by
  the single ``slotIds`` array of the :class:`RunExplanation`. Every per-slot
  column is run-length encoded and every ``actual`` is a sparse ``{index:
  value}`` map, so the ~90 KB of redundant ISO-8601 timestamps that
  :mod:`.trace`'s group-encoded ``slotIds`` would cost here never materializes.
- ``null`` in any encoded per-slot column means *the element does not exist in that
  slot* — an absent group, an unevaluated-because-absent node, an optimizer that
  never looked at the slot. It is distinct from ``"not_evaluated"``, which means
  the node exists and was deliberately not consulted.
- Builders record ``actual`` for every node that *has* one, passing or not: a
  threshold with no reading beside it is half a test. A node whose condition
  reports no reading at all (the self-gating pair, whose result is a
  simulation rather than a comparison) leaves it ``None``, contributes nothing
  to the sparse map, and the key disappears from the payload entirely.
- The encoded serialization canonicalizes ordering: nodes and groups are
  emitted in first-appearance order across slots, and slots in horizon order.
- Frontend-facing keys are camelCase, matching the trace payload.
- Two serializations exist. ``to_rows`` is the plain one that
  ``helman/get_schedule_explanation`` serves: one row per explained slot, built
  straight from the DTOs, with facts about a condition column (as opposed to
  its per-slot result) listed once per optimizer under ``conditions``.
  ``to_dict`` is the pivoted, run-length encoded one that :mod:`.trace` still
  embeds in the ``helman/run_automation`` payload.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
import logging
from typing import TYPE_CHECKING, Any, Iterable, Sequence

from ..scheduling.schedule import parse_slot_id

if TYPE_CHECKING:
    from .conditions.types import ConditionType

_LOGGER = logging.getLogger(__name__)

# --- vocabularies ------------------------------------------------------------

STATE_TRUE = "true"
STATE_FALSE = "false"
STATE_NOT_EVALUATED = "not_evaluated"
STATE_NOT_APPLICABLE = "not_applicable"

#: A node's result. ``not_evaluated`` = never consulted (short-circuited);
#: ``not_applicable`` = the group does not configure this condition at all.
NODE_STATES: frozenset[str] = frozenset(
    {STATE_TRUE, STATE_FALSE, STATE_NOT_EVALUATED, STATE_NOT_APPLICABLE}
)

SCOPE_SLOT = "slot"
SCOPE_DAY = "day"
SCOPE_WINDOW = "window"
SCOPE_RUN = "run"

#: How finely a node discriminates. Non-slot scopes render as spanning cells
#: rather than N identical checkmarks.
NODE_SCOPES: frozenset[str] = frozenset(
    {SCOPE_SLOT, SCOPE_DAY, SCOPE_WINDOW, SCOPE_RUN}
)

PARAMS_SOURCE_SLOT_MATCHED = "slot_matched"
PARAMS_SOURCE_DAY_RESOLVED = "day_resolved"
PARAMS_SOURCE_MASTER_FALLBACK = "master_fallback"

#: Which resolution path produced a group's params. ``charge_hold`` and capped
#: ``appliance_runtime`` resolve via ``Eligibility.for_day()``, which can pick a
#: *different* group than ``at(slot)`` — without the marker the params columns
#: silently show the wrong numbers.
PARAMS_SOURCES: frozenset[str] = frozenset(
    {
        PARAMS_SOURCE_SLOT_MATCHED,
        PARAMS_SOURCE_DAY_RESOLVED,
        PARAMS_SOURCE_MASTER_FALLBACK,
    }
)

VERDICT_EXECUTE = "execute"
VERDICT_CANDIDATE = "candidate"
VERDICT_SKIP = "skip"

#: Terminal verdict per slot. ``candidate`` = placed but ``condition_met`` is
#: false (kept for display, never executed).
VERDICTS: frozenset[str] = frozenset(
    {VERDICT_EXECUTE, VERDICT_CANDIDATE, VERDICT_SKIP}
)

STATUS_OK = "ok"
STATUS_SKIPPED = "skipped"
STATUS_FAILED = "failed"

#: Per-optimizer step status. A skipped step must never be indistinguishable
#: from "every slot false" — that is exactly what ``ConditionRailsUnavailable``
#: warns against.
OPTIMIZER_STATUSES: frozenset[str] = frozenset(
    {STATUS_OK, STATUS_SKIPPED, STATUS_FAILED}
)

#: Traced phases of the optimizer pipeline. Phase 1 is deliberately absent:
#: it is a provisional appliance-demand estimate, not an explanation record.
PHASE_SYSTEM_PLAN = 2
PHASE_FINAL_APPLIANCE_PLACEMENT = 3
OPTIMIZER_PHASES: frozenset[int] = frozenset(
    {PHASE_SYSTEM_PLAN, PHASE_FINAL_APPLIANCE_PLACEMENT}
)


def _warn_unknown(label: str, value: Any, allowed: frozenset[Any]) -> None:
    """Log an unknown vocabulary member. Never raises: this is observability."""
    if value not in allowed:
        _LOGGER.warning("explanation has unknown %s %r", label, value)


# --- index-aligned column codecs ---------------------------------------------


def encode_runs(values: Sequence[Any]) -> list[list[Any]]:
    """Run-length encode an index-aligned column as ``[[value, count], ...]``.

    Values are compared by equality, so dicts and lists (resolved params, custom
    condition results) collapse just as strings do. ``None`` encodes "absent in
    this slot" and is preserved.
    """
    runs: list[list[Any]] = []
    for value in values:
        if runs and runs[-1][0] == value and type(runs[-1][0]) is type(value):
            runs[-1][1] += 1
            continue
        runs.append([value, 1])
    return runs


def encode_sparse(values: Sequence[Any]) -> dict[str, Any]:
    """Encode an index-aligned column as ``{index: value}``, omitting ``None``.

    A condition that reports no reading carries no ``actual`` at all, so its
    column encodes to an empty map and its key is dropped from the payload
    entirely.
    """
    return {
        str(index): value
        for index, value in enumerate(values)
        if value is not None
    }


def _without_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values: an absent reading has no key in a plain row."""
    return {key: value for key, value in payload.items() if value is not None}


def _condition_column(
    key: str, condition: "ConditionType | None"
) -> dict[str, Any]:
    """One condition column's own facts; an unregistered key has only its key."""
    if condition is None:
        return {"key": key}
    return _without_none(
        {
            "key": key,
            "selfGating": True if condition.self_gating else None,
            "operator": condition.operator,
        }
    )


# --- per-slot DTOs -----------------------------------------------------------


@dataclass(frozen=True)
class ConditionNode:
    """One condition as it resolved for one slot.

    ``value`` is what the condition was configured with (the threshold);
    ``actual`` is what the slot actually presented, recorded whether the node
    passed or not -- the margin a slot passed by is as much a part of the test
    as the reading that failed it.

    Nodes are flat. Conditions do not nest: ``build_group_explanations`` emits
    one node per configured condition and nothing below it. Per-entry custom
    conditions are group-level and live on ``GroupExplanation.custom_results``,
    not under a condition.
    """

    key: str
    scope: str = SCOPE_SLOT
    state: str = STATE_NOT_EVALUATED
    value: Any = None
    actual: Any = None

    def __post_init__(self) -> None:
        _warn_unknown("node state", self.state, NODE_STATES)
        _warn_unknown("node scope", self.scope, NODE_SCOPES)

    def to_row(self) -> dict[str, Any]:
        # Scope stays per slot: an optimizer may re-scope a resolved node
        # (``reserve_floor_soc`` resolves per band) while unresolved slots keep
        # the scope the condition type declared.
        return _without_none(
            {
                "key": self.key,
                "scope": self.scope,
                "state": self.state,
                "value": self.value,
                "actual": self.actual,
            }
        )


@dataclass(frozen=True)
class GateNode:
    """One post-condition gate the optimizer itself applies, for one slot.

    Gates are the ~60% of a slot's fate that lives outside ``masks_by_key``:
    window, deadline, capacity, daily-minimum bookkeeping, the writer-level
    ``blocked_user_owned`` veto. ``params`` carries whatever the gate needs to
    explain itself — including ordinals such as cheapness ``rank``, which have
    no truth value and must not render as a boolean.
    """

    key: str
    state: str = STATE_NOT_EVALUATED
    params: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _warn_unknown("gate state", self.state, NODE_STATES)

    def to_row(self) -> dict[str, Any]:
        return {"key": self.key, "state": self.state, "params": dict(self.params)}


@dataclass(frozen=True)
class GroupExplanation:
    """One ORed condition group as it resolved for one slot."""

    index: int
    label: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    params_source: str = PARAMS_SOURCE_SLOT_MATCHED
    custom_results: tuple[bool | None, ...] = ()
    conditions: tuple[ConditionNode, ...] = ()
    #: This is the group ``Eligibility.at(slot)`` matched: the first group whose
    #: system mask covers the slot and whose custom conditions held, else the
    #: first whose mask covers it. The *slot* match only — a DAY/RUN-scoped
    #: kind runs under ``for_day()``'s group, which may be another one (see
    #: ``params_source``). Serialized once per slot as ``matchedGroupIndex``.
    slot_matched: bool = False

    def __post_init__(self) -> None:
        _warn_unknown("params source", self.params_source, PARAMS_SOURCES)

    def to_row(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "label": self.label,
            "paramsSource": self.params_source,
            "params": dict(self.params),
            "customResults": list(self.custom_results),
            "conditions": [node.to_row() for node in self.conditions],
        }


@dataclass(frozen=True)
class SlotExplanation:
    """Everything one optimizer decided about one slot."""

    slot_id: str
    groups: tuple[GroupExplanation, ...] = ()
    gates: tuple[GateNode, ...] = ()
    verdict: str = VERDICT_SKIP
    winning_optimizer: str | None = None

    def __post_init__(self) -> None:
        _warn_unknown("verdict", self.verdict, VERDICTS)

    def to_row(self) -> dict[str, Any]:
        return _without_none(
            {
                "slotId": self.slot_id,
                "verdict": self.verdict,
                "winningOptimizer": self.winning_optimizer,
                "matchedGroupIndex": next(
                    (group.index for group in self.groups if group.slot_matched),
                    None,
                ),
                "groups": [group.to_row() for group in self.groups],
                "gates": [gate.to_row() for gate in self.gates],
            }
        )


# --- record DTOs (own the pivot) ---------------------------------------------


def _first_appearance_keys(node_groups: Iterable[Iterable[ConditionNode]]) -> list[str]:
    """Condition keys across ``node_groups``, in first-appearance order."""
    keys: list[str] = []
    for nodes in node_groups:
        for node in nodes:
            if node.key not in keys:
                keys.append(node.key)
    return keys


def _encode_condition_columns(
    nodes_by_slot: Sequence[tuple[ConditionNode, ...] | None],
) -> list[dict[str, Any]]:
    """Pivot per-slot node tuples into index-aligned columns, recursively."""
    keys = _first_appearance_keys(nodes or () for nodes in nodes_by_slot)

    columns: list[dict[str, Any]] = []
    for key in keys:
        per_slot: list[ConditionNode | None] = [
            next((node for node in nodes or () if node.key == key), None)
            for nodes in nodes_by_slot
        ]
        present = [node for node in per_slot if node is not None]
        column: dict[str, Any] = {
            "key": key,
            "scope": present[0].scope if present else SCOPE_SLOT,
            "state": encode_runs(
                [node.state if node is not None else None for node in per_slot]
            ),
        }
        values = [node.value if node is not None else None for node in per_slot]
        if any(value is not None for value in values):
            column["value"] = encode_runs(values)
        actuals = encode_sparse(
            [node.actual if node is not None else None for node in per_slot]
        )
        if actuals:
            column["actual"] = actuals
        columns.append(column)
    return columns


def _encode_gate_columns(
    gates_by_slot: Sequence[tuple[GateNode, ...] | None],
) -> list[dict[str, Any]]:
    keys: list[str] = []
    for gates in gates_by_slot:
        for gate in gates or ():
            if gate.key not in keys:
                keys.append(gate.key)

    columns: list[dict[str, Any]] = []
    for key in keys:
        per_slot: list[GateNode | None] = [
            next((gate for gate in gates or () if gate.key == key), None)
            for gates in gates_by_slot
        ]
        column: dict[str, Any] = {
            "key": key,
            "state": encode_runs(
                [gate.state if gate is not None else None for gate in per_slot]
            ),
        }
        params = [
            gate.params if gate is not None and gate.params else None
            for gate in per_slot
        ]
        if any(entry is not None for entry in params):
            column["params"] = encode_runs(params)
        columns.append(column)
    return columns


def _encode_group_columns(
    groups_by_slot: Sequence[tuple[GroupExplanation, ...] | None],
) -> list[dict[str, Any]]:
    indexes: list[int] = []
    for groups in groups_by_slot:
        for group in groups or ():
            if group.index not in indexes:
                indexes.append(group.index)

    columns: list[dict[str, Any]] = []
    for group_index in indexes:
        per_slot: list[GroupExplanation | None] = [
            next(
                (group for group in groups or () if group.index == group_index),
                None,
            )
            for groups in groups_by_slot
        ]
        present = [group for group in per_slot if group is not None]
        column: dict[str, Any] = {
            "index": group_index,
            "label": present[0].label if present else "",
            # ``paramsSource`` is the presence column: null == this group does
            # not exist for that slot.
            "paramsSource": encode_runs(
                [
                    group.params_source if group is not None else None
                    for group in per_slot
                ]
            ),
        }
        params = [
            group.params if group is not None and group.params else None
            for group in per_slot
        ]
        if any(entry is not None for entry in params):
            column["params"] = encode_runs(params)
        custom = [
            list(group.custom_results)
            if group is not None and group.custom_results
            else None
            for group in per_slot
        ]
        if any(entry is not None for entry in custom):
            column["customResults"] = encode_runs(custom)
        conditions = _encode_condition_columns(
            [group.conditions if group is not None else None for group in per_slot]
        )
        if conditions:
            column["conditions"] = conditions
        columns.append(column)
    return columns


@dataclass(frozen=True)
class OptimizerExplanation:
    """One pipeline step's evaluation of the whole horizon.

    ``status``/``status_reason`` keep a skipped or failed step distinguishable
    from a step that evaluated every slot to ``false``.
    """

    optimizer_id: str
    kind: str
    #: The schedule lane this step writes: the controllable's own id, matching
    #: ``TraceWrite.controllable_id`` and the key of the frontend's lane. The
    #: record is queried by lane, not by optimizer — the inverter lane is
    #: written by three optimizer kinds, so one lane click has no single
    #: optimizer to ask.
    controllable_id: str = ""
    #: Runtime phase that produced this authoritative trace record. Phase 1 is
    #: intentionally never represented because it is provisional and untraced.
    phase: int = PHASE_SYSTEM_PLAN
    status: str = STATUS_OK
    status_reason: str | None = None
    slots: tuple[SlotExplanation, ...] = ()

    def __post_init__(self) -> None:
        _warn_unknown("optimizer status", self.status, OPTIMIZER_STATUSES)
        _warn_unknown("optimizer phase", self.phase, OPTIMIZER_PHASES)

    def _aligned_slots(
        self, slot_ids: Sequence[str]
    ) -> list[SlotExplanation | None]:
        index_of = {slot_id: index for index, slot_id in enumerate(slot_ids)}
        aligned: list[SlotExplanation | None] = [None] * len(slot_ids)
        for slot in self.slots:
            index = index_of.get(slot.slot_id)
            if index is None:
                _LOGGER.warning(
                    "explanation for %s references off-horizon slot %s",
                    self.optimizer_id,
                    slot.slot_id,
                )
                continue
            aligned[index] = slot
        return aligned

    def to_rows(self) -> dict[str, Any]:
        """Serialize as plain rows: one per explained slot, in record order.

        A slot this optimizer said nothing about has no row. ``conditions``
        lists every condition column once, in first-appearance order across
        slots and groups, with the facts about the column rather than its
        per-slot result — ``selfGating`` and the ``operator`` its test
        compares with (:class:`~.conditions.types.ConditionType`) — so they
        are not repeated per slot.
        """
        # Imported here: ``conditions`` builds these DTOs, so a module-level
        # import would be circular.
        from .conditions.types import CONDITION_TYPES

        keys = _first_appearance_keys(
            group.conditions for slot in self.slots for group in slot.groups
        )
        return _without_none(
            {
                "optimizerId": self.optimizer_id,
                "kind": self.kind,
                "controllableId": self.controllable_id or None,
                "phase": self.phase,
                "status": self.status,
                "statusReason": self.status_reason,
                "conditions": [
                    _condition_column(key, CONDITION_TYPES.get(key)) for key in keys
                ],
                "slots": [slot.to_row() for slot in self.slots],
            }
        )

    def to_dict(self, slot_ids: Sequence[str]) -> dict[str, Any]:
        """Serialize, pivoted against the record's ``slotIds`` array."""
        aligned = self._aligned_slots(slot_ids)
        payload: dict[str, Any] = {
            "optimizerId": self.optimizer_id,
            "kind": self.kind,
            "phase": self.phase,
            "status": self.status,
            # the presence column: null == this optimizer said nothing about
            # that slot.
            "verdict": encode_runs(
                [slot.verdict if slot is not None else None for slot in aligned]
            ),
        }
        if self.controllable_id:
            payload["controllableId"] = self.controllable_id
        if self.status_reason is not None:
            payload["statusReason"] = self.status_reason
        winners = encode_sparse(
            [
                slot.winning_optimizer if slot is not None else None
                for slot in aligned
            ]
        )
        if winners:
            payload["winningOptimizer"] = winners
        groups = _encode_group_columns(
            [slot.groups if slot is not None else None for slot in aligned]
        )
        if groups:
            payload["groups"] = groups
        gates = _encode_gate_columns(
            [slot.gates if slot is not None else None for slot in aligned]
        )
        if gates:
            payload["gates"] = gates
        return payload

@dataclass(frozen=True)
class RunExplanation:
    """The whole run: one ``slotIds`` array, one record per pipeline step."""

    run_at: datetime
    slot_ids: tuple[str, ...] = ()
    optimizers: tuple[OptimizerExplanation, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "runAt": self.run_at.isoformat(),
            "slotIds": list(self.slot_ids),
            "optimizers": [
                optimizer.to_dict(self.slot_ids) for optimizer in self.optimizers
            ],
        }

# --- the in-memory book ------------------------------------------------------
#
# Deliberately **not** persisted. The plan is rebuilt from
# ``build_horizon_start(now)`` every 15 minutes (plus on edits, reality checks
# and startup), so the record regenerates on its own within minutes of a
# restart; writing it to disk would buy ~96 whole-file rewrites/day of a
# 100-300 KB JSON on SD-card installs and nothing else.
#
# It is accumulative *within* the session, because a run only covers the rolling
# 48 h from ``build_horizon_start(now)``: without merging, a run at 20:00 would
# erase the 08:00 run's explanation of the morning, and "why did nothing run at
# 09:00?" — the question the whole feature exists to answer — would have no
# answer by lunchtime. Every row therefore carries the ``run_at`` of the run
# that produced it, and a newer run overwrites an older one slot by slot.


@dataclass
class _OptimizerRecord:
    """One optimizer's accumulated rows for one target on one date."""

    optimizer_id: str
    kind: str
    controllable_id: str
    phase: int
    status: str
    status_reason: str | None
    #: Newest run that reported this optimizer for this date; owns the header
    #: fields above (status greys the whole column, so it is column-scoped).
    run_at: datetime
    #: slot id -> (the run that produced this row, the row).
    slots: dict[str, tuple[datetime, SlotExplanation]] = field(
        default_factory=dict
    )

    def explanation(self, slot_ids: Sequence[str]) -> OptimizerExplanation:
        """The accumulated rows as one record, in ``slot_ids`` order."""
        return OptimizerExplanation(
            optimizer_id=self.optimizer_id,
            kind=self.kind,
            controllable_id=self.controllable_id,
            phase=self.phase,
            status=self.status,
            status_reason=self.status_reason,
            slots=tuple(
                self.slots[slot_id][1] for slot_id in slot_ids if slot_id in self.slots
            ),
        )


def _slot_start(slot_id: str) -> datetime | None:
    try:
        return parse_slot_id(slot_id)
    except Exception:  # noqa: BLE001 - observability must never fail a run
        _LOGGER.warning("explanation has unparsable slot id %r", slot_id)
        return None


class ExplanationBook:
    """Accumulative, in-memory ``(controllable_id, date)`` index of run records.

    A run spans three calendar dates (96 half-hour slots from a slot-floored
    start), so each run's slots are filed into per-date buckets rather than
    replacing a "today" record wholesale. Dates before the recording run's own
    date are evicted: they can no longer be reached from the schedule editor,
    and keeping them would grow without bound.
    """

    def __init__(self) -> None:
        # date (YYYY-MM-DD) -> controllable id -> optimizer id -> record, the last
        # dict in the pipeline order of the newest run that touched it.
        self._by_date: dict[str, dict[str, dict[str, _OptimizerRecord]]] = {}

    # --- writing -------------------------------------------------------------

    def record(self, explanation: RunExplanation) -> None:
        """Merge one run's slots into the per-date buckets.

        Only successful runs reach here — a failed run raises out of the
        optimizer loop before assembly, so the previous good record stands
        rather than being clobbered by a partial one.
        """
        run_at = explanation.run_at
        touched: dict[tuple[str, str], list[str]] = {}
        for optimizer in explanation.optimizers:
            controllable_id = optimizer.controllable_id
            if not controllable_id:
                _LOGGER.warning(
                    "explanation for %s has no controllable id; not recorded",
                    optimizer.optimizer_id,
                )
                continue
            for slot in optimizer.slots:
                slot_start = _slot_start(slot.slot_id)
                if slot_start is None:
                    continue
                date_key = slot_start.date().isoformat()
                bucket = self._by_date.setdefault(date_key, {}).setdefault(
                    controllable_id, {}
                )
                record = bucket.get(optimizer.optimizer_id)
                if record is None:
                    record = _OptimizerRecord(
                        optimizer_id=optimizer.optimizer_id,
                        kind=optimizer.kind,
                        controllable_id=controllable_id,
                        phase=optimizer.phase,
                        status=optimizer.status,
                        status_reason=optimizer.status_reason,
                        run_at=run_at,
                    )
                    bucket[optimizer.optimizer_id] = record
                elif record.run_at <= run_at:
                    record.kind = optimizer.kind
                    record.phase = optimizer.phase
                    record.status = optimizer.status
                    record.status_reason = optimizer.status_reason
                    record.run_at = run_at
                previous = record.slots.get(slot.slot_id)
                if previous is None or previous[0] <= run_at:
                    record.slots[slot.slot_id] = (run_at, slot)
                order = touched.setdefault((date_key, controllable_id), [])
                if optimizer.optimizer_id not in order:
                    order.append(optimizer.optimizer_id)

        # Column order is pipeline order, and the newest run is the authority on
        # what that is (optimizers can be added, removed or reordered in config).
        for (date_key, controllable_id), order in touched.items():
            bucket = self._by_date[date_key][controllable_id]
            reordered = {
                optimizer_id: bucket[optimizer_id]
                for optimizer_id in order
                if optimizer_id in bucket
            }
            for optimizer_id, record in bucket.items():
                reordered.setdefault(optimizer_id, record)
            self._by_date[date_key][controllable_id] = reordered

        self.evict_before(run_at.date())

    def evict_before(self, today: date) -> None:
        """Drop every bucket for a date earlier than ``today``."""
        cutoff = today.isoformat()
        for date_key in [key for key in self._by_date if key < cutoff]:
            del self._by_date[date_key]

    def clear(self) -> None:
        self._by_date.clear()

    # --- reading -------------------------------------------------------------

    def get(self, *, controllable_id: str, date: str) -> dict[str, Any] | None:
        """The plain rows for one lane on one date, or ``None``.

        Returns **every** optimizer that touched the target, in pipeline order —
        the inverter lane is written by three optimizer kinds, so a lane click
        has no single optimizer to ask. Each row carries the ``runAt`` of the
        run that produced it: rows do not all come from the same run — that is
        the whole point of accumulating.
        """
        records = self._by_date.get(date, {}).get(controllable_id)
        if not records:
            return None
        slot_ids = sorted(
            {slot_id for record in records.values() for slot_id in record.slots},
            key=lambda slot_id: (_slot_start(slot_id), slot_id),
        )
        optimizers: list[dict[str, Any]] = []
        for record in records.values():
            payload = record.explanation(slot_ids).to_rows()
            for row in payload["slots"]:
                row["runAt"] = record.slots[row["slotId"]][0].isoformat()
            optimizers.append(payload)
        return {
            "controllableId": controllable_id,
            "date": date,
            "slotIds": slot_ids,
            # The newest run contributing to this lane/date; per-row provenance
            # lives on each optimizer's rows.
            "runAt": max(record.run_at for record in records.values()).isoformat(),
            "optimizers": optimizers,
        }
