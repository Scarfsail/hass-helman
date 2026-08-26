"""Which evaluator speaks for which config path.

A registry key is a dotted path with ``*`` standing for one segment the key
does not care about -- ``power_devices.*.entities.power`` covers all four power
devices, and a later key can cover a list with
``power_devices.solar.forecast.daily_energy_entity_ids.*``. The segments a
``*`` matched are handed to the evaluator, so an evaluator learns *which*
device or index it is looking at from the path rather than from the request.
That is what lets the websocket command carry no entity id and no settings.

Adding an evaluation kind is a new module plus one line in :data:`EVALUATORS`.
Nothing else in the integration, and nothing at all in the frontend, changes.

A path no key matches is not an error. The editor may put an entity group
anywhere, and one whose path nothing knows about simply shows its picker with
no facts under it -- see ``status: "unsupported"`` in :mod:`.model`.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from .context import InspectionRequest, PathSegment
from .model import Inspection
from .power import evaluate_power_entity

#: An evaluator turns one resolved target into facts. It must never raise.
Evaluator = Callable[[InspectionRequest], Inspection]

#: Registry keys in declaration order. Matching is exact on segment count, so
#: order only decides which of two equally specific keys wins -- there are none
#: today, and a later key that overlaps an earlier one is a mistake worth
#: noticing rather than a precedence rule worth relying on.
EVALUATORS: dict[str, Evaluator] = {
    "power_devices.*.entities.power": evaluate_power_entity,
}

#: The segment a key uses to mean "anything, and tell the evaluator what".
WILDCARD = "*"


def match_key(key: str, path: Sequence[PathSegment]) -> tuple[str, ...] | None:
    """The wildcard segments ``path`` fills in, or ``None`` if the key misses.

    A list index arrives as an ``int`` and is matched as its decimal string, so
    one key covers both a mapping key and a list position without the caller
    having to know which the config uses.
    """
    segments = key.split(".")
    if len(segments) != len(path):
        return None
    wildcards: list[str] = []
    for expected, actual in zip(segments, path):
        text = str(actual)
        if expected == WILDCARD:
            wildcards.append(text)
            continue
        if expected != text:
            return None
    return tuple(wildcards)


def evaluator_for(
    path: Sequence[PathSegment],
) -> tuple[Evaluator, tuple[str, ...]] | None:
    """The evaluator that speaks for ``path``, with the wildcards it matched."""
    for key, evaluator in EVALUATORS.items():
        wildcards = match_key(key, path)
        if wildcards is not None:
            return evaluator, wildcards
    return None
