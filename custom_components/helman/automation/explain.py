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
- DTOs retain one record per explained slot. ``to_rows`` serves those facts
  through ``helman/get_schedule_explanation``; condition column metadata is
  listed once per optimizer.
- A missing row means the optimizer said nothing about that slot. An existing
  node with ``not_evaluated`` was deliberately not consulted.
- Every emitted gate declares its role where the optimizer knows whether it
  can veto, reports capacity, or overrides condition matching.
- ``actual`` is retained for passing and failing comparisons alike.
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
VERDICTS: frozenset[str] = frozenset({VERDICT_EXECUTE, VERDICT_CANDIDATE, VERDICT_SKIP})

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


# --- plain-row serialization ------------------------------------------------


def _without_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values: an absent reading has no key in a plain row."""
    return {key: value for key, value in payload.items() if value is not None}


def _condition_column(key: str, condition: "ConditionType | None") -> dict[str, Any]:
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
    role: str
    state: str = STATE_NOT_EVALUATED
    params: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _warn_unknown("gate state", self.state, NODE_STATES)
        _warn_unknown(
            "gate role", self.role, frozenset({"veto", "advisory", "override"})
        )

    def to_row(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "role": self.role,
            "state": self.state,
            "params": dict(self.params),
        }


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


# --- record DTOs ------------------------------------------------------------


def _first_appearance_keys(node_groups: Iterable[Iterable[ConditionNode]]) -> list[str]:
    """Condition keys across ``node_groups``, in first-appearance order."""
    keys: list[str] = []
    for nodes in node_groups:
        for node in nodes:
            if node.key not in keys:
                keys.append(node.key)
    return keys


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


@dataclass(frozen=True)
class RunExplanation:
    """The whole run: one ``slotIds`` array, one record per pipeline step."""

    run_at: datetime
    slot_ids: tuple[str, ...] = ()
    optimizers: tuple[OptimizerExplanation, ...] = ()


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
    slots: dict[str, tuple[datetime, SlotExplanation]] = field(default_factory=dict)

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
