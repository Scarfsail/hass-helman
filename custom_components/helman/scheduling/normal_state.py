"""The hardware Helman can drive, and the state that counts as at rest for each.

"Normal" is uniformly the resting state: the configured normal mode for the
inverter, and off for every appliance regardless of kind. The inspector reads
this list to name its lanes and to tell a running entity from an idle one.

The uniformity is not asserted here any more — it is read off
:data:`..controllables.spec.CONTROLLABLE_SPECS`, which declares per kind where
the control entity lives and what its rest looks like. What is left in this
module is the roster's *shape*: which entities exist, in what order, and how they
are serialised for the card.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, NotRequired, TypedDict

from ..controllables.spec import (
    CONTROLLABLE_KIND_INVERTER,
    CONTROLLABLE_SPECS,
    ControllableSpec,
)
from .schedule import ScheduleControlConfig

if TYPE_CHECKING:
    from ..appliances.state import AppliancesRuntimeRegistry


class ControllableEntityDict(TypedDict):
    """An entity Helman can drive, and the state that counts as "at rest".

    A single ``normalState`` string covers every kind: the configured normal
    option for the inverter, and off for every appliance. An entity is
    non-normal exactly when its live state differs from it, which lets the card
    filter the list straight from ``hass.states`` and stay reactive without
    asking the backend again.

    ``actionOptions`` maps schedule action kinds to the inverter mode option
    each one selects. The card needs it in both directions: to label the live
    inverter mode with the same chip the slot editor uses, and to project a
    scheduled action onto the entity state it will produce. Only the inverter
    carries it -- appliance states follow from their action shape, which is why
    only the inverter's spec declares ``action_option_attrs``.
    """

    kind: str
    name: str
    entityId: str
    normalState: str
    actionOptions: NotRequired[dict[str, str]]


def build_controllable_entities(
    *,
    control_config: ScheduleControlConfig | None,
    registry: "AppliancesRuntimeRegistry",
) -> list[ControllableEntityDict]:
    """List everything Helman can drive, with the state that counts as at rest.

    The two arguments are two config readers, not two species: the inverter is
    emitted by exactly the same walk as every appliance, from its own spec.
    Pairing each source with its spec is all that is left of the split, and it
    disappears once the inverter is configured in the same list as the rest.

    Appliances are emitted in registry order rather than grouped by kind,
    because that is the order the user wrote them in and the order the card's
    lanes appear in.
    """
    sources: list[tuple[ControllableSpec, Any]] = []
    if control_config is not None:
        sources.append(
            (CONTROLLABLE_SPECS[CONTROLLABLE_KIND_INVERTER], control_config)
        )
    for appliance in registry.appliances:
        spec = CONTROLLABLE_SPECS.get(appliance.kind)
        # A kind no spec knows cannot be driven, named or given a resting
        # state, so it cannot be listed. The config readers already reject
        # unknown kinds, so this is a guard, not a path.
        if spec is not None:
            sources.append((spec, appliance))

    entities: list[ControllableEntityDict] = []
    for spec, source in sources:
        entity = _build_controllable_entity(spec, source)
        if entity is not None:
            entities.append(entity)
    return entities


def _build_controllable_entity(
    spec: ControllableSpec,
    source: Any,
) -> ControllableEntityDict | None:
    """One roster entry, or nothing when the instance cannot be placed on it.

    An entry needs all three of a control entity, a name and a resting state:
    without the entity there is nothing to watch, and without a resting state
    the card cannot tell running from idle. Any of them missing means a partly
    configured instance, which is skipped rather than half-listed.
    """
    entity_id = spec.control_entity_id(source)
    name = spec.name(source)
    normal_state = spec.resting_state(source)
    if entity_id is None or name is None or normal_state is None:
        return None

    entity = ControllableEntityDict(
        kind=spec.kind,
        name=name,
        entityId=entity_id,
        normalState=normal_state,
    )
    action_options = spec.action_options(source)
    if action_options:
        entity["actionOptions"] = action_options
    return entity
