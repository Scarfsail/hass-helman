"""Per-run optimizer decision trace (observability layer).

The trace makes every automation run explainable: for each schedule slot and
each optimizer in the pipeline it records what the optimizer saw (rails), what
it did (framework-recorded writes), and why (emitted decisions + notes). The
recorder is a *dumb appender* owned by the optimizer loop — it never raises into
the run, so an instrumentation bug can never stop the battery from charging.

Design notes:
- Reasons are opaque ``{code, params, signals?}`` dicts; no formatting happens
  here (the frontend formats + localizes).
- The serialized shape uses parallel arrays keyed by ``slotIds`` to stay compact.
- Coverage validation (below) never fails the run: gaps warn and are filled with
  a synthetic ``unexplained`` decision so the UI invariant "every cell is
  clickable and says something" holds unconditionally.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from datetime import datetime
from typing import Any, Iterable, Sequence

from homeassistant.util import dt as dt_util

from ..scheduling.schedule import (
    SCHEDULE_SLOT_DURATION,
    format_slot_id,
    parse_slot_id,
)

_LOGGER = logging.getLogger(__name__)

# outcome vocabulary emitted by optimizers (the synthetic fill reuses
# ``out_of_scope`` with the ``unexplained`` reason code).
DECISION_OUTCOMES: frozenset[str] = frozenset(
    {"applied", "rejected", "blocked", "out_of_scope"}
)

UNEXPLAINED_REASON_CODE = "unexplained"


# --- serialized DTOs ---------------------------------------------------------


@dataclass(frozen=True)
class TraceWrite:
    """A committed schedule write recorded by the framework diff (layer 1)."""

    slot_id: str
    domain: str  # "inverter" | "appliance:<id>"
    before: dict[str, Any] | None
    after: dict[str, Any] | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "slotId": self.slot_id,
            "domain": self.domain,
            "before": self.before,
            "after": self.after,
        }


@dataclass(frozen=True)
class TraceDecision:
    """A group-encoded decision: one rationale covering a list of slots."""

    slot_ids: tuple[str, ...]
    outcome: str
    action: dict[str, Any] | None = None
    reason: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "slotIds": list(self.slot_ids),
            "outcome": self.outcome,
        }
        if self.action is not None:
            payload["action"] = self.action
        if self.reason is not None:
            payload["reason"] = self.reason
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
    status: str = "ok"
    complete: bool = True
    rails_in: dict[str, list[float | None]] = field(default_factory=dict)
    writes: list[TraceWrite] = field(default_factory=list)
    decisions: list[TraceDecision] = field(default_factory=list)
    notes: list[TraceNote] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "optimizerId": self.optimizer_id,
            "kind": self.kind,
            "status": self.status,
            "complete": self.complete,
            "railsIn": self.rails_in,
            "writes": [write.to_dict() for write in self.writes],
            "decisions": [decision.to_dict() for decision in self.decisions],
            "notes": [note.to_dict() for note in self.notes],
        }


class OptimizerTrace:
    """Per-run recorder. One instance per automation run, owned by the loop.

    All public mutators swallow their own errors: observability must never fail
    the run. ``to_dict`` produces the serialized shape consumed over the
    ``helman/get_last_automation_run`` websocket.
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

    def begin_step(self, optimizer_id: str, kind: str) -> None:
        self._current = _MutableStep(optimizer_id=optimizer_id, kind=kind)

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

    def end_step(
        self,
        *,
        status: str,
        derivable_slot_ids: Iterable[str] = (),
    ) -> None:
        """Finalize the current step, running coverage validation.

        ``status="skipped"`` steps are exempt from the gap check (they carry a
        single horizon-wide note instead).
        """
        step = self._current
        self._current = None
        if step is None:
            return
        step.status = status
        try:
            if status != "skipped":
                self._validate_coverage(step, frozenset(derivable_slot_ids))
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
        reason: dict[str, Any] | None = None,
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
                reason=reason,
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
        unavailable, optimizer skipped) so the whole column stays explained.
        """
        if self._current is None:
            return
        self.note(code=code, params=params)
        self.decision(
            slot_ids=self._slot_ids,
            outcome=outcome,
            reason={"code": code, "params": params or {}},
        )

    # --- coverage validation -------------------------------------------------

    def _validate_coverage(
        self, step: _MutableStep, derivable: frozenset[str]
    ) -> None:
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
        unexplained_writes = [
            write
            for write in step.writes
            if write.slot_id in self._slot_id_set and write.slot_id not in applied
        ]
        if unexplained_writes:
            step.complete = False
            _LOGGER.warning(
                "trace: step %s has %d committed write(s) without an `applied` "
                "decision",
                step.optimizer_id,
                len(unexplained_writes),
            )

        uncovered = [
            slot_id
            for slot_id in self._slot_ids
            if slot_id not in covered and slot_id not in derivable
        ]
        if uncovered:
            step.complete = False
            _LOGGER.warning(
                "trace: step %s left %d/%d slot(s) unexplained; synthetic fill",
                step.optimizer_id,
                len(uncovered),
                len(self._slot_ids),
            )
            step.decisions.append(
                TraceDecision(
                    slot_ids=tuple(uncovered),
                    outcome="out_of_scope",
                    reason={"code": UNEXPLAINED_REASON_CODE, "params": {}},
                )
            )

    # --- serialization -------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "slotIds": list(self._slot_ids),
            "staticRails": self._static_rails,
            "steps": [step.to_dict() for step in self._steps],
            "railsFinal": self._rails_final,
        }


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
