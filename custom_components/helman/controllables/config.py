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

from collections.abc import Iterator, Mapping
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


def _iter_consumption_controllables(
    config: Mapping[str, Any] | None,
) -> Iterator[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """Every controllable that declares a ``consumption`` block, with that block.

    The inverter never has one: it moves energy rather than drawing it, and
    validation refuses it the block at all.
    """
    controllables = read_controllables(config)
    if not isinstance(controllables, list):
        return
    for entry in controllables:
        if not isinstance(entry, Mapping):
            continue
        if peek_controllable_kind(entry) == CONTROLLABLE_KIND_INVERTER:
            continue
        consumption = entry.get("consumption")
        if not isinstance(consumption, Mapping):
            continue
        yield entry, consumption


def _controllable_label(entry: Mapping[str, Any], fallback: str) -> str:
    """A controllable's display name, falling back when it declares none."""
    name = entry.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else fallback


def read_scheduled_consumers(
    config: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """``[{id, label, energy_entity_id, deferrable}]`` — every schedulable consumer.

    The forecast's itemisation is keyed by controllable id, so this is keyed by
    id too, and an entry that declares none is skipped: nothing can be scheduled
    against it. Unlike :func:`read_deferrable_consumers` a meter is not required
    — a scheduled appliance with no energy sensor still has demand to show, so
    it keeps its row and reports ``energy_entity_id: None`` rather than being
    dropped and later named by its raw slug.

    ``deferrable`` carries the same opt-out ``read_deferrable_consumers``
    filters on, rather than being assumed true for everything the planner
    scheduled: a device metered for its own projection but marked
    ``consumption.deferrable: False`` must read as non-deferrable on both sides
    of now, or the same appliance means two different things either side of it.
    """
    consumers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry, consumption in _iter_consumption_controllables(config):
        controllable_id = peek_controllable_id(entry)
        if controllable_id is None or controllable_id in seen:
            continue
        seen.add(controllable_id)
        entity_id = consumption.get("energy_entity_id")
        entity_id = (
            entity_id.strip()
            if isinstance(entity_id, str) and entity_id.strip()
            else None
        )
        consumers.append(
            {
                "id": controllable_id,
                "label": _controllable_label(entry, controllable_id),
                "energy_entity_id": entity_id,
                "deferrable": consumption.get("deferrable") is not False,
            }
        )
    return consumers


def read_deferrable_consumers(
    config: Mapping[str, Any] | None,
) -> list[dict[str, str]]:
    """``[{energy_entity_id, label, id}]`` — the devices carved out of house load.

    ``id`` is the controllable's own id, carried so a scheduled appliance's
    demand — which is keyed by exactly that id — resolves to the same meter and
    the same name the measured breakdown gives it. It is omitted for an entry
    that declares none; such an entry can never be scheduled, so nothing keys
    off it.

    The house consumption forecast splits the house total into a baseline plus
    the loads that can be moved in time; this is that second list. It used to
    be its own ``power_devices.house.forecast.deferrable_consumers`` key, hand
    maintained beside the very same devices in ``controllables``, with nothing
    keeping the two in agreement. There is nothing to keep in agreement now:
    a controllable *is* a device whose consumption can be deferred, so every
    metered one is in the list unless it says otherwise.

    Hence the default. ``consumption.deferrable`` opts a device *out* — for a
    load that is metered for its own projection but not realistically
    schedulable — and only ``False`` does so; a missing or malformed value
    reads as the default rather than silently shrinking the list.

    The inverter is never here: it moves energy rather than drawing it, and
    validation refuses it a ``consumption`` block at all. An entry with no
    meter contributes nothing either — there would be nothing to subtract.

    Order follows the ``controllables`` list, and a duplicate meter is taken
    once: counting one sensor twice would eat the baseline twice over.
    Validation reports the duplicate separately.
    """
    consumers: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry, consumption in _iter_consumption_controllables(config):
        if consumption.get("deferrable") is False:
            continue
        entity_id = consumption.get("energy_entity_id")
        if not isinstance(entity_id, str) or not entity_id.strip():
            continue
        entity_id = entity_id.strip()
        if entity_id in seen:
            continue
        seen.add(entity_id)
        consumer = {
            "energy_entity_id": entity_id,
            "label": _controllable_label(entry, entity_id),
        }
        controllable_id = peek_controllable_id(entry)
        if controllable_id is not None:
            consumer["id"] = controllable_id
        consumers.append(consumer)
    return consumers


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
