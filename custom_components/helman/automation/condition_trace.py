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

What the trace does *not* carry is the reading behind an entity platform
condition. ``condition_trace_set_result`` -- the call that stamps ``state``
beside ``wanted_state_above`` -- is made only by HA's legacy function conditions
(``numeric_state``, ``state``, ``template``, ``time``). The entity-condition base
classes ``EntityConditionBase``, ``EntityStateConditionBase``,
``EntityNumericalConditionBase`` and ``EntityNumericalConditionWithUnitBase``
make no trace calls at all, so a ``temperature.is_value`` entry records its
verdict and nothing else -- in HA's own automation trace just as much as here.
The reading is therefore captured here instead: whatever entities the entry
references, read at the moment it was evaluated. ``async_extract_entities``
finds them, so this stays generic -- no per-platform semantics are restated here,
and a condition shape HA grows later is followed for free.

Those readings are stamped onto the entry's own trace step under ``params``
rather than travelling beside it. ``ha-trace-path-details`` destructures a step
into the keys it knows and YAML-dumps *whatever is left* into the block at the
top of the pane, beneath the result (see ``_renderSelectedTraceInfo`` in
``frontend/hass-frontend/src/components/trace/ha-trace-path-details.ts``). So a
key HA has no name for is not ignored -- it is rendered, in the one place the
reader is already looking. ``params`` is safe to use: a trace element only ever
carries ``path``, ``timestamp``, ``child_id``, ``changed_variables``, ``error``,
``template_errors`` and ``result``.

Nothing here may cost a run its plan: the plan is worth more than the record of
why it exists, so a collection that breaks is logged and dropped.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from datetime import date, datetime, time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

#: One group's trace: HA trace path -> the steps recorded at it.
ConditionTrace = dict[str, list[dict[str, Any]]]

#: One entry's readings, as the pane renders them: label -> value.
ConditionParams = dict[str, str | None]

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


def entry_root(entry_index: int) -> str:
    """The trace path one ``custom`` entry is rooted at."""
    return f"condition/{entry_index}"


def extract_entity_ids(validated_config: Any) -> tuple[str, ...]:
    """Which entities one validated ``custom`` entry reads, sorted.

    Taken from the *validated* config, which is where a ``device`` condition has
    had its entity resolved. A config HA cannot walk yields nothing rather than
    raising: a missing reading is worth less than the plan it would cost.
    """
    from homeassistant.helpers import condition as ha_condition

    try:
        return tuple(sorted(ha_condition.async_extract_entities(validated_config)))
    except Exception:  # noqa: BLE001 - observability must never fail a run
        _LOGGER.debug(
            "Could not extract entities from a custom condition", exc_info=True
        )
        return ()


def read_entity_params(
    hass: "HomeAssistant", entity_ids: Iterable[str]
) -> ConditionParams:
    """The live state of each entity, as the one line each will be dumped to.

    Flat text, because that is all the pane does with it: a YAML dump of a map.
    The unit rides along with the value -- a bare ``28.4`` beside a threshold in
    degrees is a number the reader has to take on trust -- and the friendly name
    rides along with the id, which stays in the label because it is the only
    unambiguous half of it.

    An entity with no state is kept, valued ``None`` and so dumped as ``null``,
    rather than dropped: that a condition reads something that does not exist is
    exactly what the reader is hunting for.
    """
    params: ConditionParams = {}
    for entity_id in entity_ids:
        state = hass.states.get(entity_id)
        attributes = getattr(state, "attributes", None) or {}
        name = attributes.get("friendly_name")
        unit = attributes.get("unit_of_measurement")
        label = f"{entity_id} ({name})" if name else entity_id
        if state is None:
            params[label] = None
        else:
            params[label] = f"{state.state} {unit}" if unit else str(state.state)
    return params


def stamp_params(
    trace: ConditionTrace, *, entry_index: int, params: ConditionParams
) -> None:
    """Hang one entry's readings off its own trace step.

    Only where the entry left a step to hang them on. A step is not invented for
    an entry that recorded none, because a fabricated one would draw a node in
    the graph that HA never evaluated -- and an entry that got far enough to read
    its entities almost always left one, since ``ConditionChecker.async_check``
    opens its trace element before doing anything else.
    """
    root = entry_root(entry_index)
    if not params or root not in trace:
        return
    trace[root] = [{**element, "params": params} for element in trace[root]]


def _merge(
    trace: Mapping[str, Iterable[Any]], entry_index: int, into: ConditionTrace
) -> None:
    """Re-root one entry's trace at ``condition/<entry_index>`` and add it."""
    for path, elements in trace.items():
        if path != _ENTRY_ROOT and not path.startswith(f"{_ENTRY_ROOT}/"):
            # After the clear nothing else can be here; dropping rather than
            # passing through is what keeps two entries off the same path.
            continue
        rooted = f"{entry_root(entry_index)}{path[len(_ENTRY_ROOT):]}"
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
