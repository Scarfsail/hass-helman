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
- The DTOs are **per slot** (one :class:`SlotExplanation` per horizon slot);
  serialization **pivots** them into index-aligned columns keyed by the single
  ``slotIds`` array of the :class:`RunExplanation`. Every per-slot column is
  run-length encoded and every ``actual`` is a sparse ``{index: value}`` map, so
  the ~90 KB of redundant ISO-8601 timestamps that :mod:`.trace`'s
  group-encoded ``slotIds`` would cost here never materializes.
- ``null`` in any per-slot column means *the element does not exist in that
  slot* — an absent group, an unevaluated-because-absent node, an optimizer that
  never looked at the slot. It is distinct from ``"not_evaluated"``, which means
  the node exists and was deliberately not consulted.
- Builders record ``actual`` **only for nodes that did not pass**; a passing
  node leaves it ``None``, contributes nothing to the sparse map, and the key
  disappears from the payload entirely.
- Serialization canonicalizes ordering: nodes and groups are emitted in
  first-appearance order across slots, and slots in horizon order. A round trip
  is lossless for records built that way (every builder in this package is).
- Frontend-facing keys are camelCase, matching the trace payload.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import logging
from typing import Any, Iterable, Mapping, Sequence

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


def _warn_unknown(label: str, value: Any, allowed: frozenset[str]) -> None:
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


def decode_runs(runs: Any, length: int | None = None) -> list[Any]:
    """Expand :func:`encode_runs` output, right-padding with ``None``."""
    values: list[Any] = []
    if isinstance(runs, list):
        for run in runs:
            if not isinstance(run, (list, tuple)) or len(run) != 2:
                _LOGGER.warning("explanation has malformed run %r", run)
                continue
            value, count = run
            if not isinstance(count, int) or count < 0:
                _LOGGER.warning("explanation has malformed run length %r", count)
                continue
            values.extend([value] * count)
    if length is None:
        return values
    if len(values) > length:
        return values[:length]
    return values + [None] * (length - len(values))


def encode_sparse(values: Sequence[Any]) -> dict[str, Any]:
    """Encode an index-aligned column as ``{index: value}``, omitting ``None``.

    Passing nodes carry no ``actual``, so an all-passing column encodes to an
    empty map and its key is dropped from the payload entirely.
    """
    return {
        str(index): value
        for index, value in enumerate(values)
        if value is not None
    }


def decode_sparse(mapping: Any, length: int) -> list[Any]:
    """Expand :func:`encode_sparse` output back to an index-aligned list."""
    values: list[Any] = [None] * length
    if isinstance(mapping, Mapping):
        for key, value in mapping.items():
            try:
                index = int(key)
            except (TypeError, ValueError):
                _LOGGER.warning("explanation has non-integer sparse key %r", key)
                continue
            if 0 <= index < length:
                values[index] = value
    return values


# --- per-slot DTOs -----------------------------------------------------------


@dataclass(frozen=True)
class ConditionNode:
    """One condition as it resolved for one slot.

    ``value`` is what the condition was configured with (the threshold);
    ``actual`` is what the slot actually presented, recorded only when the node
    did not pass. ``children`` carries inner and per-entry custom conditions.
    """

    key: str
    scope: str = SCOPE_SLOT
    state: str = STATE_NOT_EVALUATED
    value: Any = None
    actual: Any = None
    children: tuple["ConditionNode", ...] = ()

    def __post_init__(self) -> None:
        _warn_unknown("node state", self.state, NODE_STATES)
        _warn_unknown("node scope", self.scope, NODE_SCOPES)


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


@dataclass(frozen=True)
class GroupExplanation:
    """One ORed condition group as it resolved for one slot."""

    index: int
    label: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    params_source: str = PARAMS_SOURCE_SLOT_MATCHED
    custom_results: tuple[bool | None, ...] = ()
    conditions: tuple[ConditionNode, ...] = ()

    def __post_init__(self) -> None:
        _warn_unknown("params source", self.params_source, PARAMS_SOURCES)


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


# --- record DTOs (own the pivot) ---------------------------------------------


def _encode_condition_columns(
    nodes_by_slot: Sequence[tuple[ConditionNode, ...] | None],
) -> list[dict[str, Any]]:
    """Pivot per-slot node tuples into index-aligned columns, recursively."""
    keys: list[str] = []
    for nodes in nodes_by_slot:
        for node in nodes or ():
            if node.key not in keys:
                keys.append(node.key)

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
        children = _encode_condition_columns(
            [node.children if node is not None else None for node in per_slot]
        )
        if children:
            column["children"] = children
        columns.append(column)
    return columns


def _decode_condition_columns(
    columns: Any, length: int
) -> list[list[ConditionNode]]:
    """Inverse of :func:`_encode_condition_columns`."""
    per_slot: list[list[ConditionNode]] = [[] for _ in range(length)]
    if not isinstance(columns, list):
        return per_slot
    for column in columns:
        if not isinstance(column, Mapping):
            continue
        states = decode_runs(column.get("state"), length)
        values = decode_runs(column.get("value"), length)
        actuals = decode_sparse(column.get("actual"), length)
        children = _decode_condition_columns(column.get("children"), length)
        for index in range(length):
            if states[index] is None:
                continue
            per_slot[index].append(
                ConditionNode(
                    key=column.get("key", ""),
                    scope=column.get("scope", SCOPE_SLOT),
                    state=states[index],
                    value=values[index],
                    actual=actuals[index],
                    children=tuple(children[index]),
                )
            )
    return per_slot


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


def _decode_gate_columns(columns: Any, length: int) -> list[list[GateNode]]:
    per_slot: list[list[GateNode]] = [[] for _ in range(length)]
    if not isinstance(columns, list):
        return per_slot
    for column in columns:
        if not isinstance(column, Mapping):
            continue
        states = decode_runs(column.get("state"), length)
        params = decode_runs(column.get("params"), length)
        for index in range(length):
            if states[index] is None:
                continue
            per_slot[index].append(
                GateNode(
                    key=column.get("key", ""),
                    state=states[index],
                    params=dict(params[index] or {}),
                )
            )
    return per_slot


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


def _decode_group_columns(
    columns: Any, length: int
) -> list[list[GroupExplanation]]:
    per_slot: list[list[GroupExplanation]] = [[] for _ in range(length)]
    if not isinstance(columns, list):
        return per_slot
    for column in columns:
        if not isinstance(column, Mapping):
            continue
        sources = decode_runs(column.get("paramsSource"), length)
        params = decode_runs(column.get("params"), length)
        custom = decode_runs(column.get("customResults"), length)
        conditions = _decode_condition_columns(column.get("conditions"), length)
        for index in range(length):
            if sources[index] is None:
                continue
            per_slot[index].append(
                GroupExplanation(
                    index=column.get("index", 0),
                    label=column.get("label", ""),
                    params=dict(params[index] or {}),
                    params_source=sources[index],
                    custom_results=tuple(custom[index] or ()),
                    conditions=tuple(conditions[index]),
                )
            )
    return per_slot


@dataclass(frozen=True)
class OptimizerExplanation:
    """One pipeline step's evaluation of the whole horizon.

    ``status``/``status_reason`` keep a skipped or failed step distinguishable
    from a step that evaluated every slot to ``false``.
    """

    optimizer_id: str
    kind: str
    status: str = STATUS_OK
    status_reason: str | None = None
    slots: tuple[SlotExplanation, ...] = ()

    def __post_init__(self) -> None:
        _warn_unknown("optimizer status", self.status, OPTIMIZER_STATUSES)

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

    def to_dict(self, slot_ids: Sequence[str]) -> dict[str, Any]:
        """Serialize, pivoted against the record's ``slotIds`` array."""
        aligned = self._aligned_slots(slot_ids)
        payload: dict[str, Any] = {
            "optimizerId": self.optimizer_id,
            "kind": self.kind,
            "status": self.status,
            # the presence column: null == this optimizer said nothing about
            # that slot.
            "verdict": encode_runs(
                [slot.verdict if slot is not None else None for slot in aligned]
            ),
        }
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

    @classmethod
    def from_dict(
        cls, payload: Mapping[str, Any], slot_ids: Sequence[str]
    ) -> "OptimizerExplanation":
        length = len(slot_ids)
        verdicts = decode_runs(payload.get("verdict"), length)
        winners = decode_sparse(payload.get("winningOptimizer"), length)
        groups = _decode_group_columns(payload.get("groups"), length)
        gates = _decode_gate_columns(payload.get("gates"), length)
        slots = [
            SlotExplanation(
                slot_id=slot_ids[index],
                groups=tuple(groups[index]),
                gates=tuple(gates[index]),
                verdict=verdicts[index],
                winning_optimizer=winners[index],
            )
            for index in range(length)
            if verdicts[index] is not None
        ]
        return cls(
            optimizer_id=payload.get("optimizerId", ""),
            kind=payload.get("kind", ""),
            status=payload.get("status", STATUS_OK),
            status_reason=payload.get("statusReason"),
            slots=tuple(slots),
        )


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

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "RunExplanation":
        raw_slot_ids = payload.get("slotIds")
        slot_ids: tuple[str, ...] = (
            tuple(raw_slot_ids) if isinstance(raw_slot_ids, list) else ()
        )
        raw_optimizers = payload.get("optimizers")
        optimizers: Iterable[Any] = (
            raw_optimizers if isinstance(raw_optimizers, list) else ()
        )
        return cls(
            run_at=datetime.fromisoformat(payload["runAt"]),
            slot_ids=slot_ids,
            optimizers=tuple(
                OptimizerExplanation.from_dict(entry, slot_ids)
                for entry in optimizers
                if isinstance(entry, Mapping)
            ),
        )
