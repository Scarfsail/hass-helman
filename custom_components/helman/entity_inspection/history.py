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
    """What the last probe found, and when. ``days`` is ``None`` if it failed."""

    days: int | None
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
    """

    def evaluate(request: InspectionRequest) -> Inspection:
        return _evaluate(request, required_days_path, default_required_days)

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
    # the reader is asking about.
    if reading.problem is None or reading.problem.token != "entity_missing":
        days = _history_days(request.hass, entity_id)
        if days is not None:
            facts.append(_history_fact(days, required))

    return Inspection(
        entity_id=entity_id,
        status="ok" if reading.problem is None else "unavailable",
        facts=tuple(facts),
        consulted=consulted,
    )


def _history_fact(available: int, required: int | None) -> Fact:
    """The depth, judged against a requirement when there is one."""
    if required is None:
        return Fact(
            id="history",
            token="history_depth_only",
            params={"available": available},
            severity="neutral",
        )
    severity: Severity = "ok" if available >= required else "warn"
    return Fact(
        id="history",
        token="history_depth",
        params={"available": available, "required": required},
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


def _history_days(hass: Any, entity_id: str) -> int | None:
    """The last measured depth for this entity, refreshing it when it is stale.

    ``None`` means "not measured yet, or the last attempt failed" -- which is a
    fact the editor is not told, because "we do not know" is not worth a badge
    that would flicker into existence for one tick on every fresh pick.
    """
    measurement = _MEASUREMENTS.get(entity_id)
    if measurement is None or time.monotonic() - measurement.at >= HISTORY_CACHE_TTL:
        _schedule_measurement(hass, entity_id)
    return measurement.days if measurement is not None else None


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
    days: int | None = None
    try:
        days = await _query(hass, entity_id)
    except Exception as err:  # noqa: BLE001 - the recorder need not be there
        _LOGGER.debug("History depth probe failed for %s: %s", entity_id, err)
    finally:
        _IN_FLIGHT.discard(entity_id)
        # Cached either way: a failure that was not remembered would be retried
        # on every two-second tick.
        _MEASUREMENTS[entity_id] = _Measurement(days=days, at=time.monotonic())


async def _query(hass: Any, entity_id: str) -> int:
    """The one recorder read, behind a name a test can replace.

    The import is deferred because ``recorder_statistics_span`` reaches into the
    recorder integration, which need not be set up -- an import error is one
    more way the recorder cannot answer, not a reason to fail a poll.
    """
    from ..recorder_statistics_span import query_history_days

    return await query_history_days(
        hass,
        entity_id,
        today_local=dt_util.now().date(),
        local_tz=dt_util.DEFAULT_TIME_ZONE,
    )
