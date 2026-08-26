"""What an entity reads when there is nothing to interpret.

Most of the entities in the configuration carry no meaning for Helman to
unfold: a charge switch is on or off, an inverter's mode select says whatever
its options say, an energy meter counts kWh. There is no polarity to apply and
no history requirement to judge them against, and inventing an evaluator per
path so each could say the same single thing would be a registry the size of
the config schema.

So this is the answer the registry gives when no specific key matches: the
entity's current value, and nothing else. It is what makes the editor's promise
whole -- *every* picked entity shows what it reads, and the ones with an
interpretation show that too -- without the frontend ever growing a branch for
"a picker with no facts".

Two things it deliberately does not do:

* **It does not judge.** A value is shown; whether it is the right entity is
  ``helman/validate_config``'s business.
* **It does not require a number.** A state that will not parse as one is not a
  failure here the way it is for a power sensor -- ``on``, ``eco`` and
  ``heating`` are perfectly good readings of a switch, a select and a climate
  entity. So a non-numeric state is shown as itself rather than as the warning
  :mod:`.state` raises it as for evaluators that go on to do arithmetic.

A path whose value is not an entity id at all -- a mapping, a list, a number --
is still ``unsupported``. A group pointed at one of those is a call-site
mistake, and showing a fabricated reading for it would hide the mistake.
"""

from __future__ import annotations

from typing import Any

from .context import InspectionRequest
from .model import Inspection
from .state import read_numeric_state


def evaluate_entity_value(request: InspectionRequest) -> Inspection:
    """The current value at any config path holding an entity id."""
    consulted: tuple[tuple[tuple[Any, ...], Any], ...] = (
        (request.path, request.target_value()),
    )

    target = request.target_value()
    if target is not None and not isinstance(target, str):
        # Not a picker's path at all. Nothing here can be said about it.
        return Inspection(entity_id=None, status="unsupported")

    entity_id = request.entity_id()
    if entity_id is None:
        return Inspection(entity_id=None, status="unset", consulted=consulted)

    reading = read_numeric_state(request.hass, entity_id)
    if reading.problem is None:
        return Inspection(
            entity_id=entity_id,
            status="ok",
            facts=(reading.value_fact(),),
            consulted=consulted,
        )
    if reading.problem.token == "not_numeric":
        # A reading all the same -- see the module docstring.
        return Inspection(
            entity_id=entity_id,
            status="ok",
            facts=(reading.text_fact(),),
            consulted=consulted,
        )
    return Inspection(
        entity_id=entity_id,
        status="unavailable",
        facts=(reading.problem,),
        consulted=consulted,
    )
