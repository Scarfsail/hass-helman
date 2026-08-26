"""The reading of a power device's power sensor, as facts.

The first evaluator, and the shape every later one should copy: it reads the
entity id at its own target path, reads the *setting* that qualifies that
entity -- here the polarity -- from the same document, asks the module that
owns the meaning what the value means, and returns tokens.

Nothing here decides how a reading is worded. ``power_polarity`` owns which
direction a sign carries, and the editor's translation files own the sentence;
this module only joins the two. A device added to ``POWER_POLARITY_OPTIONS``
therefore gets a live reading with no change to this file at all.

It never raises. This runs on a poll against a half-edited draft, so an entity
that does not exist, a state of ``unknown``, a unit-less sensor and a polarity
copied from another device's vocabulary are all ordinary inputs with ordinary
answers.
"""

from __future__ import annotations

from typing import Any

from ..power_polarity import (
    POWER_POLARITY_KEY,
    POWER_POLARITY_OPTIONS,
    interpret_power_reading,
)
from .context import InspectionRequest
from .model import Fact, Inspection

#: HA's two "no reading" sentinels, which are states like any other and would
#: otherwise be reported as a non-numeric value.
_ABSENT_STATES = frozenset({"unknown", "unavailable", "", "none"})


def _format_value(value: float) -> str:
    """The reading as the editor should show it, without a locale opinion.

    Trailing zeros are trimmed because a power sensor reporting ``1400.0`` and
    one reporting ``1400`` are saying the same thing, and a status line that
    changes width on the second decimal is hard to read at a two-second poll.
    """
    rounded = round(value, 2)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:g}"


def evaluate_power_entity(request: InspectionRequest) -> Inspection:
    """What ``power_devices.<device>.entities.power`` currently reads."""
    device = request.wildcards[0] if request.wildcards else ""
    if device not in POWER_POLARITY_OPTIONS:
        # A path shaped like a power device but naming one Helman has no
        # vocabulary for. Nothing truthful can be said about its sign.
        return Inspection(entity_id=None, status="unsupported")

    entity_id = request.entity_id()
    # The polarity sits beside the entity it qualifies, so it is read
    # relative to the target path rather than from a second literal path that
    # could drift away from the registry key.
    polarity = request.value(*request.path[:-1], POWER_POLARITY_KEY)
    polarity_token = polarity if isinstance(polarity, str) else None
    signature: tuple[Any, ...] = (request.target_value(), polarity)

    if entity_id is None:
        return Inspection(entity_id=None, status="unset", signature=signature)

    state = _state_of(request.hass, entity_id)
    if state is None:
        return Inspection(
            entity_id=entity_id,
            status="unavailable",
            facts=(Fact(id="state", token="entity_missing", severity="warn"),),
            signature=signature,
        )

    raw = getattr(state, "state", None)
    text = raw.strip() if isinstance(raw, str) else ""
    if text.lower() in _ABSENT_STATES:
        return Inspection(
            entity_id=entity_id,
            status="unavailable",
            facts=(
                Fact(
                    id="state",
                    token="state_absent",
                    params={"state": text},
                    severity="warn",
                ),
            ),
            signature=signature,
        )

    try:
        value = float(text)
    except (TypeError, ValueError):
        return Inspection(
            entity_id=entity_id,
            status="unavailable",
            facts=(
                Fact(
                    id="state",
                    token="not_numeric",
                    params={"state": text},
                    severity="warn",
                ),
            ),
            signature=signature,
        )

    attributes = getattr(state, "attributes", None) or {}
    unit = attributes.get("unit_of_measurement") if hasattr(attributes, "get") else None
    reading = interpret_power_reading(device, polarity_token, value)

    facts = [
        Fact(
            id="value",
            token="value",
            params={"value": _format_value(value), "unit": unit or ""},
            severity="neutral",
        ),
        Fact(
            id="reading",
            token=f"power_reading.{reading['direction']}",
            severity="info",
        ),
    ]
    if reading["inverted"]:
        # Worth saying out loud: the sign on screen is the opposite of the one
        # Helman works in, and that is the setting the reader just chose rather
        # than something wrong.
        facts.append(Fact(id="polarity", token="polarity_inverted", severity="info"))

    return Inspection(
        entity_id=entity_id,
        status="ok",
        facts=tuple(facts),
        signature=signature,
    )


def _state_of(hass: Any, entity_id: str) -> Any:
    """``hass.states.get`` behind a guard, for a hass that may be half-set-up."""
    states = getattr(hass, "states", None)
    getter = getattr(states, "get", None)
    if getter is None:
        return None
    try:
        return getter(entity_id)
    except Exception:  # noqa: BLE001 - a poll must never fail on a bad id
        return None
