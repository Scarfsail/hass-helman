"""Reading the ``controllables:`` list — one entry point for all four kinds.

Config version 7 replaced ``appliances:`` and ``scheduler.control`` with a
single list, so "which of my entities is this thing wired to" is one question
asked once. This module owns the two things every reader of that list needs:
getting at the list itself, and picking out the inverter, which is a singleton
by rule rather than by convention.

Deliberately thin. The per-kind readers stay where they are —
:mod:`..appliances.config` for the appliance kinds,
:func:`..scheduling.schedule.read_schedule_control_config` for the inverter —
because their runtime shapes are genuinely different and folding them is a
later phase. What lives here is only what would otherwise be spelled out twice
in modules that must not import each other.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .spec import CONTROLLABLE_KIND_INVERTER

#: The id the inverter entry is migrated to and the one the UI seeds. Reserved:
#: config validation refuses it to every other kind, so an optimizer targeting
#: ``inverter`` can only ever mean the inverter.
CONTROLLABLE_ID_INVERTER = "inverter"


def read_controllables(config: Mapping[str, Any] | None) -> Any:
    """The raw ``controllables:`` value — ``None`` when absent.

    Returned unvalidated on purpose: the runtime reader logs a bad type and
    carries on, while the config validator reports it, and both need to tell
    "absent" apart from "present but wrong".
    """
    if not isinstance(config, Mapping):
        return None
    return config.get("controllables")


def peek_controllable_kind(value: Any) -> str | None:
    """The declared ``kind`` of one entry, without reading the rest of it."""
    if not isinstance(value, Mapping):
        return None
    kind = value.get("kind")
    if not isinstance(kind, str):
        return None
    return kind.strip() or None


def read_controllable_kinds_by_id(
    config: Mapping[str, Any] | None,
) -> dict[str, str]:
    """``controllable id -> kind`` for every entry that names both.

    The lookup an optimizer's ``target.controllable_id`` resolves against. It
    reads the raw document rather than a runtime registry on purpose: the
    validator must answer "does this id name something, and what kind is it"
    even for an entry whose per-kind config is broken enough that no runtime
    object could be built from it — otherwise one bad appliance would be
    reported twice, once as itself and once as every optimizer aiming at it.

    An inverter entry with no ``id`` is indexed under
    :data:`CONTROLLABLE_ID_INVERTER` anyway. Validation reports the missing id
    on the entry, where the fix is; making every optimizer targeting the
    inverter *also* fail would bury that one finding under a pile of
    consequences.

    First wins on a duplicate id, matching :func:`find_inverter_controllable`;
    validation rejects duplicates separately.
    """
    controllables = read_controllables(config)
    if not isinstance(controllables, list):
        return {}
    kinds_by_id: dict[str, str] = {}
    for entry in controllables:
        kind = peek_controllable_kind(entry)
        if kind is None:
            continue
        controllable_id = peek_controllable_id(entry)
        if controllable_id is None:
            if kind != CONTROLLABLE_KIND_INVERTER:
                continue
            controllable_id = CONTROLLABLE_ID_INVERTER
        kinds_by_id.setdefault(controllable_id, kind)
    return kinds_by_id


def peek_controllable_id(value: Any) -> str | None:
    """The declared ``id`` of one entry, without reading the rest of it."""
    if not isinstance(value, Mapping):
        return None
    controllable_id = value.get("id")
    if not isinstance(controllable_id, str):
        return None
    return controllable_id.strip() or None


def find_inverter_controllable(config: Mapping[str, Any] | None) -> Mapping[str, Any]:
    """The single ``kind: inverter`` entry, or an empty mapping.

    First wins if a hand-edited config declares two; validation rejects that
    case, and picking the first keeps the runtime deterministic in the window
    between a bad save and the user fixing it.
    """
    controllables = read_controllables(config)
    if not isinstance(controllables, list):
        return {}
    for entry in controllables:
        if peek_controllable_kind(entry) == CONTROLLABLE_KIND_INVERTER:
            return entry
    return {}
