"""How much recorder history stands behind an entity, as facts.

The second evaluation kind, and the one that tests whether the boundary this
package draws is real. A history badge needs a number the frontend has no way
to obtain and a threshold it has no business knowing -- how many days the
recorder holds, and how many days *this particular setting* asks for -- and
both are read here, out of the same draft document the request already carries.
The editor sends nothing it did not already send for a polarity.

**Which setting the badge reads is this module's decision, not the call site's.**
A group may carry several day-count settings in its slot; only the one named in
:data:`~.registry.EVALUATORS` is a *requirement*, and the others (a training
window, a minimum valid-slot count) are simply other settings of the same
entity. Moving one into a group's slot is a layout choice; consulting it would
be a meaning choice, and meaning choices live here.

**The fact carries both tables' depth, and severity is judged on the one that
trains.** Long-term statistics and raw states can disagree by years on a stock
recorder (``purge_keep_days`` prunes one and not the other), and every trainer
in this integration reads raw states -- so a badge that judged "enough
history" against statistics would read green for an entity training will find
almost empty. ``available`` in the fact's params is always the raw-states
depth for exactly that reason; ``statistics`` rides alongside it so a reader
can see the gap the recorder-versus-statistics split (issue #169) is about.

Two things make this evaluator different from :mod:`.power`, and both are about
the recorder rather than about history:

* **The measurement is asynchronous, and this contract is not.** An evaluator
  answers synchronously because the websocket command is a callback. So the
  probe runs as a background task and the evaluator reports what the last one
  found: the first poll after a fresh entity id carries no history fact, and
  the one two seconds later does. A badge that appears a tick late is a far
  better trade than a websocket command that blocks on a database.
* **The probe is expensive**, so a measurement is reused for
  :data:`HISTORY_CACHE_TTL`. The poll runs every two seconds and history moves
  once a day; anything less than a minute of cache would mean thirty recorder
  scans for every one that could possibly say something new. A probe that fails
  is cached too, for the same span -- otherwise a recorder that is not set up
  would be asked again on every single tick.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .context import InspectionRequest
from .model import Fact, Inspection, Severity
from .state import read_numeric_state

if TYPE_CHECKING:  # pragma: no cover - the registry imports *this* module
    from .registry import Evaluator

_LOGGER = logging.getLogger(__name__)

#: How long one entity's measured history depth is reused.
HISTORY_CACHE_TTL = 60.0


@dataclass(frozen=True)
class _Measurement:
    """What the last probe found, and when.

    ``raw_states`` and ``statistics`` are both ``None`` together if the probe
    failed outright -- a recorder that is not set up, an import error, a query
    that raised. A successful probe always fills both, with ``0`` meaning "the
    recorder holds nothing in that table", the same convention
    :func:`~.recorder_statistics_span.query_history_depths` uses.
    """

    raw_states: int | None
    statistics: int | None
    at: float


#: Measured depth per entity id. Module-level rather than per-``hass`` because
#: an entity id is unique to an instance and there is one instance per process;
#: :func:`reset_history_cache` exists so a test does not inherit another's.
_MEASUREMENTS: dict[str, _Measurement] = {}

#: Entity ids with a probe already running, so a poll every two seconds cannot
#: stack up thirty tasks waiting on the same query.
_IN_FLIGHT: set[str] = set()


def reset_history_cache() -> None:
    """Forget every measurement. For tests, and for nothing else."""
    _MEASUREMENTS.clear()
    _IN_FLIGHT.clear()


def history_evaluator(
    required_days_path: tuple[str, ...] | None = None,
    default_required_days: int | None = None,
    governs: Callable[[InspectionRequest], bool] | None = None,
) -> Evaluator:
    """An evaluator for one entity whose worth depends on its recorder history.

    ``required_days_path`` is the absolute document path to the setting that
    says how much history this entity is expected to have. It used to be a key
    resolved as a sibling of the entity, back when every requirement lived in
    the same group as the entity it governed; the v14 relocation moved the
    settings to a top-level ``training`` section, so the registry now names
    where they live instead of leaving this module to infer it.
    ``default_required_days`` is what the runtime uses when that setting is
    absent, so an untouched draft is judged against the threshold that will
    actually apply rather than against nothing.

    Both ``None`` for a path where no amount of history is required: the badge
    then simply states what there is.

    ``governs`` is for a wildcard key whose matches are not all read by the
    same trainer. It is asked, per request, whether the requirement applies to
    *this* match; when it says no the entity is still measured and still shows
    its depth, but against no requirement -- so it cannot go orange for a
    window that never reads it, and the setting stays out of ``consulted``.
    A key whose every match is governed leaves this ``None``.
    """

    def evaluate(request: InspectionRequest) -> Inspection:
        if governs is not None and not governs(request):
            return _evaluate(request, None, None)
        return _evaluate(request, required_days_path, default_required_days)

    return evaluate


def fixed_entity_history_evaluator(
    entity_id: str,
    required_days_path: tuple[str, ...] | None = None,
    default_required_days: int | None = None,
) -> Evaluator:
    """:func:`history_evaluator` for an entity Helman publishes itself.

    Every other key here names a *config path* and resolves the entity from the
    draft document, which is what keeps "which entity, judged against which
    setting" on this side of the websocket. An entity Helman owns has no
    config path to resolve — its id is a constant — but the question the row
    answers is the same one, so it is answered here rather than by teaching the
    editor to ask about entities directly.

    Nothing about it is draft-dependent, so the path contributes no
    ``consulted`` entry of its own: a revert cannot change which entity this
    is, and a draft that differs from the saved document does not make this row
    read differently.
    """

    def evaluate(request: InspectionRequest) -> Inspection:
        required = _required_days(request, required_days_path, default_required_days)
        consulted: tuple[tuple[tuple[Any, ...], Any], ...] = ()
        if required_days_path is not None:
            consulted = ((tuple(required_days_path), required),)
        reading = read_numeric_state(request.hass, entity_id)
        facts: list[Fact] = []
        fact = _history_fact_if_worth_probing(request.hass, entity_id, required)
        if fact is not None:
            facts.append(fact)
        return Inspection(
            entity_id=entity_id,
            status="ok" if reading is not None else "unavailable",
            facts=tuple(facts),
            consulted=consulted,
        )

    return evaluate


def history_aware(
    base: Evaluator,
    required_days_path: tuple[str, ...] | None = None,
    default_required_days: int | None = None,
) -> Evaluator:
    """Another evaluator's answer, with a history fact appended to it.

    A power device's power sensor already has an evaluator -- :func:`.power.
    evaluate_power_entity` reads it, resolves its polarity and says which way
    it is flowing -- and that reading is worth keeping even for an entity a
    ``training`` window also governs (the grid meter feeds curtailment
    detection, for instance). Rerunning :func:`history_evaluator`'s own state
    read on top would just be a second, disagreeing opinion about the same
    entity, so this wraps the existing evaluator instead: run it, then append
    exactly the history fact :func:`history_evaluator` would have produced,
    onto the facts and the ``consulted`` list it already returned.

    The base evaluator's own read of the entity is the one this trusts for
    "does this entity exist at all" -- an ``entity_id`` of ``None`` (unset, or
    a path the base evaluator refuses) short-circuits before any recorder
    read is scheduled.
    """

    def evaluate(request: InspectionRequest) -> Inspection:
        inspection = base(request)
        if inspection.entity_id is None:
            return inspection
        required = _required_days(request, required_days_path, default_required_days)
        consulted = inspection.consulted
        if required_days_path is not None:
            consulted += ((tuple(required_days_path), required),)
        fact = _history_fact_if_worth_probing(
            request.hass, inspection.entity_id, required
        )
        facts = inspection.facts + ((fact,) if fact is not None else ())
        return Inspection(
            entity_id=inspection.entity_id,
            status=inspection.status,
            facts=facts,
            consulted=consulted,
        )

    return evaluate


def _evaluate(
    request: InspectionRequest,
    required_days_path: tuple[str, ...] | None,
    default_required_days: int | None,
) -> Inspection:
    required = _required_days(request, required_days_path, default_required_days)
    # Only the setting the badge is actually judged against is listed here. The
    # training window and the valid-slot minimum live in the same training
    # group, but nothing below reads them -- so they must neither move the
    # draft-versus-saved comparison nor be reset by a revert.
    consulted: tuple[tuple[tuple[Any, ...], Any], ...] = (
        (request.path, request.target_value()),
    )
    if required_days_path is not None:
        consulted += ((tuple(required_days_path), required),)

    entity_id = request.entity_id()
    if entity_id is None:
        return Inspection(entity_id=None, status="unset", consulted=consulted)

    reading = read_numeric_state(request.hass, entity_id)
    facts: list[Fact] = [
        reading.problem if reading.problem is not None else reading.value_fact()
    ]

    # An entity that is not in the state machine at all is a dead id, and its
    # history is not worth a database scan. One that exists but reads
    # ``unknown`` right now is a different matter: its history is exactly what
    # the reader is asking about. ``_history_fact_if_worth_probing`` makes
    # exactly this call itself, from the same reading rule.
    fact = _history_fact_if_worth_probing(request.hass, entity_id, required)
    if fact is not None:
        facts.append(fact)

    return Inspection(
        entity_id=entity_id,
        status="ok" if reading.problem is None else "unavailable",
        facts=tuple(facts),
        consulted=consulted,
    )


def _history_fact_if_worth_probing(
    hass: Any, entity_id: str, required: int | None
) -> Fact | None:
    """The history fact for ``entity_id``, unless it is a dead id.

    Shared between :func:`history_evaluator` and :func:`history_aware`, which
    each already know their entity exists in some sense (a numeric reading, a
    reading :mod:`.power` accepted) but neither has necessarily ruled out an
    id the state machine has never heard of -- so this checks again, cheaply:
    a state-machine lookup, not a recorder query.
    """
    reading = read_numeric_state(hass, entity_id)
    if reading.problem is not None and reading.problem.token == "entity_missing":
        return None
    depths = _history_depths(hass, entity_id)
    if depths is None:
        return None
    return _history_fact(depths, required)


def _history_fact(depths: _Measurement, required: int | None) -> Fact:
    """The depth in both tables, judged against a requirement when there is one.

    ``available`` is always the raw-states depth -- what the training runs
    that read ``recorder_hourly_series`` will actually find -- and
    ``statistics`` rides alongside it so a reader can see where the two
    disagree. Severity never looks at ``statistics``: a deep statistics table
    behind a shallow, purged raw-states one is exactly the false green
    #169 exists to remove.
    """
    raw_states = depths.raw_states or 0
    statistics = depths.statistics or 0
    if required is None:
        return Fact(
            id="history",
            token="history_depth_only",
            params={"available": raw_states, "statistics": statistics},
            severity="neutral",
        )
    severity: Severity = "ok" if raw_states >= required else "warn"
    return Fact(
        id="history",
        token="history_depth",
        params={"available": raw_states, "statistics": statistics, "required": required},
        severity=severity,
    )


def _required_days(
    request: InspectionRequest,
    required_days_path: tuple[str, ...] | None,
    default_required_days: int | None,
) -> int | None:
    """The threshold this entity is judged against, read from the draft.

    Tolerant in the same way the runtime readers are: a blank, a zero or a
    string where a day count belongs falls back to the default the integration
    would itself apply, because a half-typed number must not make the badge
    change its mind about what is being asked for.
    """
    if required_days_path is None:
        return None
    raw = request.value(*required_days_path)
    if isinstance(raw, bool):
        return default_required_days
    if isinstance(raw, int) and raw > 0:
        return raw
    if isinstance(raw, float) and raw.is_integer() and raw > 0:
        return int(raw)
    return default_required_days


def _history_depths(hass: Any, entity_id: str) -> _Measurement | None:
    """The last measured depths for this entity, refreshing them when stale.

    ``None`` means "not measured yet, or the last attempt failed" -- which is a
    fact the editor is not told, because "we do not know" is not worth a badge
    that would flicker into existence for one tick on every fresh pick.
    """
    measurement = _MEASUREMENTS.get(entity_id)
    if measurement is None or time.monotonic() - measurement.at >= HISTORY_CACHE_TTL:
        _schedule_measurement(hass, entity_id)
    if measurement is None or measurement.raw_states is None:
        return None
    return measurement


def _schedule_measurement(hass: Any, entity_id: str) -> None:
    """Start a probe, unless one is already out for this entity."""
    if entity_id in _IN_FLIGHT:
        return
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        # A hass that cannot take a task (a bare object in a unit test, or an
        # instance still starting) simply never gets a measurement, and the
        # rest of the inspection is unaffected.
        return
    _IN_FLIGHT.add(entity_id)
    try:
        create_task(_async_measure(hass, entity_id))
    except Exception:  # noqa: BLE001 - a poll never fails on scheduling
        _IN_FLIGHT.discard(entity_id)


async def _async_measure(hass: Any, entity_id: str) -> None:
    """Probe the recorder once and record what it said, success or failure."""
    raw_states: int | None = None
    statistics: int | None = None
    try:
        raw_states, statistics = await _query(hass, entity_id)
    except Exception as err:  # noqa: BLE001 - the recorder need not be there
        _LOGGER.debug("History depth probe failed for %s: %s", entity_id, err)
    finally:
        _IN_FLIGHT.discard(entity_id)
        # Cached either way: a failure that was not remembered would be retried
        # on every two-second tick.
        _MEASUREMENTS[entity_id] = _Measurement(
            raw_states=raw_states, statistics=statistics, at=time.monotonic()
        )


async def _query(hass: Any, entity_id: str) -> tuple[int, int]:
    """The one recorder read, behind a name a test can replace.

    Returns ``(raw_states_days, statistics_days)``. The import is deferred
    because ``recorder_statistics_span`` reaches into the recorder integration,
    which need not be set up -- an import error is one more way the recorder
    cannot answer, not a reason to fail a poll.
    """
    from ..recorder_statistics_span import query_history_depths

    depths = await query_history_depths(
        hass,
        entity_id,
        today_local=dt_util.now().date(),
        local_tz=dt_util.DEFAULT_TIME_ZONE,
    )
    return depths.raw_states_days, depths.statistics_days
