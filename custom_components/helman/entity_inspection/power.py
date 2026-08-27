"""The reading of a power device's power sensor, as facts.

The first evaluator, and the shape every later one should copy: it reads the
entity id at its own target path, reads the *setting* that qualifies that
entity -- here the polarity -- from the same document, asks the module that
owns the meaning what the value means, and returns tokens.

Nothing here decides how a reading is worded. ``power_polarity`` owns which
direction a sign carries, and the editor's translation files own the sentence;
this module only joins the two. A device added to ``POWER_POLARITY_OPTIONS``
therefore gets a live reading with no change to this file at all.

Getting from an entity id to a number is :mod:`.state`'s job, shared with every
other evaluator: an entity that does not exist, a state of ``unknown``, a
unit-less sensor and a ``nan`` from a template sensor are not power questions.

It never raises. This runs on a poll against a half-edited draft, so a polarity
copied from another device's vocabulary is an ordinary input with an ordinary
answer.
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
from .state import read_numeric_state


def evaluate_power_entity(request: InspectionRequest) -> Inspection:
    """What ``power_devices.<device>.entities.power`` currently reads.

    The device name comes from the path itself -- ``request.path[1]`` in
    ``power_devices.<device>.entities.power`` -- rather than from
    ``request.wildcards``. The wildcard would carry the same segment when this
    is reached through the generic ``power_devices.*.entities.power`` key, but
    ``power_devices.grid.entities.power`` is also registered as its own exact
    key (:mod:`.registry`, so :func:`~.history.history_aware` can wrap this
    evaluator for the grid meter), and an exact key matches no wildcard at
    all. Reading the path directly answers both the same way.
    """
    device = str(request.path[1]) if len(request.path) > 1 else ""
    if device not in POWER_POLARITY_OPTIONS:
        # A path shaped like a power device but naming one Helman has no
        # vocabulary for. Nothing truthful can be said about its sign.
        return Inspection(entity_id=None, status="unsupported")

    entity_id = request.entity_id()
    # The polarity sits beside the entity it qualifies, so it is read
    # relative to the target path rather than from a second literal path that
    # could drift away from the registry key.
    polarity_path = (*request.path[:-1], POWER_POLARITY_KEY)
    polarity = request.value(*polarity_path)
    polarity_token = polarity if isinstance(polarity, str) else None
    # The two values this reading is made of, each with the path it came from:
    # what the comparison against the saved document is run over, and exactly
    # what a revert puts back.
    consulted: tuple[tuple[tuple[Any, ...], Any], ...] = (
        (request.path, request.target_value()),
        (polarity_path, polarity),
    )

    if entity_id is None:
        return Inspection(entity_id=None, status="unset", consulted=consulted)

    reading = read_numeric_state(request.hass, entity_id)
    if reading.problem is not None:
        return Inspection(
            entity_id=entity_id,
            status="unavailable",
            facts=(reading.problem,),
            consulted=consulted,
        )

    # The *shown* value is what gets interpreted, not the raw one -- see
    # :class:`~.state.StateReading`, which rounds once so that the number and
    # the word agree by construction rather than by two thresholds happening to
    # line up.
    shown = reading.value or 0.0
    interpreted = interpret_power_reading(device, polarity_token, shown)

    facts = [
        reading.value_fact(),
        Fact(
            id="reading",
            token=f"power_reading.{interpreted['direction']}",
            severity="info",
        ),
    ]
    if interpreted["inverted"]:
        # Worth saying out loud: the sign on screen is the opposite of the one
        # Helman works in, and that is the setting the reader just chose rather
        # than something wrong.
        facts.append(Fact(id="polarity", token="polarity_inverted", severity="info"))

    return Inspection(
        entity_id=entity_id,
        status="ok",
        facts=tuple(facts),
        consulted=consulted,
    )
