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

A path no key matches is not an error, and no longer answers with nothing
either: it falls through to :func:`~.fallback.evaluate_entity_value`, which
states the entity's current value and interprets none of it. A specific key
always wins over the fallback, so registering one is how a path stops being
merely shown and starts being read.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from ..const import (
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
)
from .context import InspectionRequest, PathSegment
from .fallback import evaluate_entity_value
from .history import history_evaluator
from .model import Inspection
from .power import evaluate_power_entity

#: An evaluator turns one resolved target into facts. It must never raise.
Evaluator = Callable[[InspectionRequest], Inspection]

#: Registry keys in declaration order. Matching is exact on segment count, so
#: order only decides which of two equally specific keys wins -- there are none
#: today, and a later key that overlaps an earlier one is a mistake worth
#: noticing rather than a precedence rule worth relying on.
#:
#: The history entries carry the *requirement* each entity is judged against --
#: an absolute path to the setting, and what the runtime falls back to when the
#: draft leaves it blank. That pairing is the registry's business precisely
#: because it is a statement of meaning: the same top-level ``training`` group
#: also carries a training window and (for solar bias) a valid-slot minimum,
#: and those are settings of the *trainer* rather than requirements on this
#: one entity's history, so nothing here consults them.
EVALUATORS: dict[str, Evaluator] = {
    "power_devices.*.entities.power": evaluate_power_entity,
    "power_devices.house.forecast.total_energy_entity_id": history_evaluator(
        ("training", "house_consumption", "min_history_days"),
        HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    ),
    "power_devices.solar.forecast.total_energy_entity_id": history_evaluator(),
    "power_devices.solar.forecast.bias_correction.total_energy_entity_id": (
        history_evaluator(
            ("training", "solar_bias", "min_history_days"),
            SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
        )
    ),
    "power_devices.solar.forecast.daily_energy_entity_ids.*": history_evaluator(),
}

#: What speaks for a path no key claims: the value, and no interpretation. It
#: is not an entry in :data:`EVALUATORS` because it matches every path length
#: at once, which is the one thing a key cannot express -- and because a key
#: that matched everything would have to be kept last by convention rather than
#: by construction.
FALLBACK_EVALUATOR: Evaluator = evaluate_entity_value

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
) -> tuple[Evaluator, tuple[str, ...]]:
    """The evaluator that speaks for ``path``, with the wildcards it matched.

    Always answers: an unclaimed path gets :data:`FALLBACK_EVALUATOR` and no
    wildcards, because every entity in the configuration is worth a reading
    even where there is nothing to make of it.
    """
    for key, evaluator in EVALUATORS.items():
        wildcards = match_key(key, path)
        if wildcards is not None:
            return evaluator, wildcards
    return FALLBACK_EVALUATOR, ()
