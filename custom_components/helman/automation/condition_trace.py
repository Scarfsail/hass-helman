"""Home Assistant's own condition trace, for an optimizer's ``custom`` conditions.

HA's condition helpers instrument themselves: ``ConditionsChecker.async_check``
opens ``trace_path(["condition", <i>])`` around each child, ``and``/``or``/``not``
recurse under ``conditions/<i>``, and ``state``/``numeric_state`` record the
reading they saw beside the bound they wanted. Every one of those calls no-ops
unless a trace context is open, which is the only reason a ``custom`` entry used
to leave nothing behind but a pair of booleans.

Opening that context costs a ``trace_clear()``/``trace_get()`` pair around the
evaluation that already happens. The one thing needing care is the path: the
coordinator builds a *separate* checker per ``custom`` entry, so every entry's
trace is rooted at ``condition/0`` and two entries would overwrite each other.
Each entry is therefore collected on its own and re-rooted at
``condition/<entry_index>``, which leaves the group's trace in exactly the
``{path: [step, ...]}`` shape the automation editor's trace view consumes over a
list of conditions -- so the frontend can hand it to Home Assistant's own
renderer untouched.

Nothing here may cost a run its plan: the plan is worth more than the record of
why it exists, so a collection that breaks is logged and dropped.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from datetime import date, datetime, time
from typing import Any

_LOGGER = logging.getLogger(__name__)

#: One group's trace: HA trace path -> the steps recorded at it.
ConditionTrace = dict[str, list[dict[str, Any]]]

#: Where a single-entry ``ConditionsChecker`` roots its trace, always.
_ENTRY_ROOT = "condition/0"


def evaluate_traced(
    check: Callable[[], bool], *, entry_index: int, into: ConditionTrace
) -> bool:
    """Call ``check`` with a trace context open, merging what it recorded.

    The return value and any exception are the checker's own -- this sits beside
    the evaluation, never in front of it. Collection runs in a ``finally``, so an
    entry that raised keeps whatever it reached, including the ``error`` HA
    stamps on the element it was inside. That is the case the reader most needs.
    """
    from homeassistant.helpers.trace import trace_clear, trace_get

    # Contextvars are per-task and this runs on the coordinator's own task, so
    # the clear cannot stomp an ambient script or automation trace.
    trace_clear()
    try:
        return check()
    finally:
        try:
            _merge(trace_get(clear=False) or {}, entry_index, into)
        except Exception:  # noqa: BLE001 - observability must never fail a run
            _LOGGER.debug(
                "Could not collect the trace of custom condition %d",
                entry_index,
                exc_info=True,
            )


def _merge(
    trace: Mapping[str, Iterable[Any]], entry_index: int, into: ConditionTrace
) -> None:
    """Re-root one entry's trace at ``condition/<entry_index>`` and add it."""
    for path, elements in trace.items():
        if path != _ENTRY_ROOT and not path.startswith(f"{_ENTRY_ROOT}/"):
            # After the clear nothing else can be here; dropping rather than
            # passing through is what keeps two entries off the same path.
            continue
        rooted = f"condition/{entry_index}{path[len(_ENTRY_ROOT):]}"
        # The element repeats its own path; re-root that too, so a reader that
        # trusts the step over the key it arrived under is not misled.
        into[rooted] = [
            {**_json_safe(element.as_dict()), "path": rooted} for element in elements
        ]


def _json_safe(value: Any) -> Any:
    """Coerce a recorded value to something ``json.dumps`` accepts.

    A condition records whatever it compared, and plenty of that has no JSON
    form: a ``time`` condition's bounds are ``datetime.time``, a ``for`` period
    is a ``timedelta``, and a template can leave anything at all in
    ``changed_variables``. Dates and times become ISO strings; everything else
    unrecognised is stringified rather than dropped, because the value it holds
    is the whole reason the node is worth showing.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    return str(value)
