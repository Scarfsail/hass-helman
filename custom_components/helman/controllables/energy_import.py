"""Home Assistant Energy preferences as ``devices:`` entries.

Energy preferences are an import source only: the upgrade to config version 21
runs this once, and a manual re-import reuses it. Nothing reads Energy at
runtime.

Pure: the preferences come in as an argument, so the caller decides where they
come from and what to do with what could not be imported.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .config import (
    CONTROLLABLE_ID_INVERTER,
    device_children,
    is_schedulable,
    iter_devices,
    own_meter,
    peek_controllable_id,
)


@dataclass(frozen=True)
class EnergyImportConflict:
    """An Energy row nested where the devices tree cannot hold it.

    ``reason`` is ``schedulable`` when the row is nested under a schedulable
    device's meter (a schedulable device is a leaf), or ``power_required`` when
    the row has no ``stat_rate`` and its parent has meterless children (the
    live split needs every metered sibling's power). Never placed: moving the
    row to the top level would count its energy twice, since the parent's
    meter already includes it.
    """

    energy_entity_id: str
    device_id: str | None
    reason: str = "schedulable"


@dataclass(frozen=True)
class EnergyImport:
    devices: list[Any]
    conflicts: list[EnergyImportConflict]
    #: External statistics (``source:stat``): no entity, so no device.
    external_statistics: list[str]


def import_energy_preferences(
    devices: list[Any], preferences: Mapping[str, Any] | None
) -> EnergyImport:
    """``devices`` with every Energy ``device_consumption`` row imported.

    Each row becomes a passive device: ``id`` from the ``stat_consumption``
    object id, ``energy_entity_id`` = ``stat_consumption``, ``power_entity_id``
    = ``stat_rate`` when there is one. ``included_in_stat`` becomes nesting
    under the device owning that meter.

    A row whose meter a device already owns is not duplicated: that device
    keeps its identity, flags and controls and only gains a missing
    ``power_entity_id``. Existing devices keep their place relative to one
    another; the one move made is a top-level existing device going, with its
    subtree, under a *newly imported* device Energy nests it in — otherwise the
    new meter and the one inside it would both count the same energy.
    ``devices`` itself is not modified.
    """
    imported = deepcopy(list(devices))
    owners: dict[str, dict[str, Any]] = {}
    taken_ids = {CONTROLLABLE_ID_INVERTER}
    for device, _parent in iter_devices({"devices": imported}):
        if (device_id := peek_controllable_id(device)) is not None:
            taken_ids.add(device_id)
        if (meter := own_meter(device)) is not None:
            owners.setdefault(meter, device)

    top_level = list(imported)
    new_devices: list[tuple[dict[str, Any], str | None]] = []
    existing_nesting: list[tuple[dict[str, Any], str]] = []
    external: list[str] = []
    for row in _device_consumption(preferences):
        meter = _entity_id(row.get("stat_consumption"))
        if meter is None:
            continue
        if ":" in meter:
            external.append(meter)
            continue
        power = _entity_id(row.get("stat_rate"))
        owner = owners.get(meter)
        if owner is not None:
            if power is not None and not owner["consumption"].get("power_entity_id"):
                owner["consumption"] = {**owner["consumption"], "power_entity_id": power}
            if (parent_meter := _entity_id(row.get("included_in_stat"))) is not None:
                existing_nesting.append((owner, parent_meter))
            continue
        consumption = {"energy_entity_id": meter}
        if power is not None:
            consumption["power_entity_id"] = power
        device = {
            "id": meter_device_id(meter, taken_ids),
            "consumption": consumption,
        }
        owners[meter] = device
        new_devices.append((device, _entity_id(row.get("included_in_stat"))))

    included_in = {id(device): parent for device, parent in new_devices}
    conflicts: list[EnergyImportConflict] = []
    placed: set[int] = set()
    for device, parent_meter in new_devices:
        blocked = _blocking_container(device, included_in, owners)
        if blocked is not None:
            blocker, reason = blocked
            conflicts.append(
                EnergyImportConflict(
                    energy_entity_id=device["consumption"]["energy_entity_id"],
                    device_id=peek_controllable_id(blocker),
                    reason=reason,
                )
            )
            continue
        parent = owners.get(parent_meter) if parent_meter is not None else None
        # A cycle in Energy's nesting (or a row nested in itself) has no
        # parent to go under; the row stays at the top level.
        if parent is not None and _nested_in(parent, device, included_in, owners):
            parent = None
        children = parent.setdefault("children", []) if parent is not None else None
        (children if isinstance(children, list) else imported).append(device)
        placed.add(id(device))

    for owner, parent_meter in existing_nesting:
        parent = owners.get(parent_meter)
        if (
            parent is None
            or id(parent) not in placed
            or not any(owner is device for device in top_level)
            or _in_subtree(parent, owner)
        ):
            continue
        imported[:] = [device for device in imported if device is not owner]
        parent.setdefault("children", []).append(owner)
    return EnergyImport(imported, conflicts, external)


def _in_subtree(device: Mapping[str, Any], root: Mapping[str, Any]) -> bool:
    """Whether ``device`` is ``root`` or sits anywhere beneath it."""
    return device is root or any(
        _in_subtree(device, child) for child in device_children(root)
    )


def _blocking_container(
    device: Mapping[str, Any],
    included_in: Mapping[int, str | None],
    owners: Mapping[str, Mapping[str, Any]],
) -> tuple[Mapping[str, Any], str] | None:
    """The existing device that cannot take ``device``'s branch, and why.

    Follows Energy's nesting up through the imported rows to the first
    existing device, which is where the branch would be placed. It cannot take
    it when it is schedulable (a leaf), or when it has meterless children and
    the imported row directly beneath it has no power (the live split needs
    every metered sibling's). Every row in a refused branch is refused with it:
    the existing meter already counts all of them.
    """
    seen: set[int] = set()
    while (parent_meter := included_in.get(id(device))) is not None:
        parent = owners.get(parent_meter)
        if parent is None or id(parent) in seen:
            return None
        if is_schedulable(parent):
            return parent, "schedulable"
        if id(parent) not in included_in:
            if "power_entity_id" not in device["consumption"] and any(
                own_meter(child) is None for child in device_children(parent)
            ):
                return parent, "power_required"
            return None
        seen.add(id(device))
        device = parent
    return None


def _nested_in(
    device: Mapping[str, Any],
    ancestor: Mapping[str, Any],
    included_in: Mapping[int, str | None],
    owners: Mapping[str, Mapping[str, Any]],
) -> bool:
    """Whether Energy's nesting leads from ``device`` up to ``ancestor``."""
    seen: set[int] = set()
    while device is not None and id(device) not in seen:
        if device is ancestor:
            return True
        seen.add(id(device))
        parent_meter = included_in.get(id(device))
        device = owners.get(parent_meter) if parent_meter is not None else None
    return False


def _device_consumption(preferences: Mapping[str, Any] | None) -> list[Mapping[str, Any]]:
    rows = preferences.get("device_consumption") if isinstance(preferences, Mapping) else None
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, Mapping)]


def _entity_id(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def meter_device_id(meter: str, taken_ids: set[str]) -> str:
    """The id a device created for ``meter`` gets, and claims in ``taken_ids``.

    The meter's object id, or ``_2``, ``_3``... on a clash — generated once and
    never changed, so a later meter swap keeps schedules and targets.
    """
    base = meter.partition(".")[2] or meter
    candidate, suffix = base, 2
    while candidate in taken_ids:
        candidate, suffix = f"{base}_{suffix}", suffix + 1
    taken_ids.add(candidate)
    return candidate
