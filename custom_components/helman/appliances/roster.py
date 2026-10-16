"""The fields every ``helman/get_appliances`` entry carries, whatever its kind.

Each entry is its kind's own payload (controls, capabilities, vehicles) plus
what every consumer of "what can Helman drive" needs: which entity says whether
it is running, the state that counts as at rest and, for a select-driven kind,
the option each schedule action selects. The card used to fetch those from a
second endpoint and join the two on the primary entity.
"""

from __future__ import annotations

from typing import NotRequired, TypedDict


class EntityReferenceDict(TypedDict):
    entityId: str


class ControllableRosterFieldsDict(TypedDict):
    """Read off the controllable spec, so every kind spells them the same way.

    ``primaryEntityId`` is the spec's control entity -- the one whose state says
    whether the controllable is running. ``normalState`` and ``actionOptions``
    are :class:`..scheduling.normal_state.ControllableEntityDict`'s fields.
    """

    primaryEntityId: str
    normalState: str
    actionOptions: NotRequired[dict[str, str]]
