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
    ``power_entity_id``. Existing devices are never moved. ``devices`` itself
    is not modified.
    """
    imported = deepcopy(list(devices))
    owners: dict[str, dict[str, Any]] = {}
    taken_ids = {CONTROLLABLE_ID_INVERTER}
    for device, _parent in iter_devices({"devices": imported}):
        if (device_id := peek_controllable_id(device)) is not None:
            taken_ids.add(device_id)
        if (meter := own_meter(device)) is not None:
            owners.setdefault(meter, device)

    new_devices: list[tuple[dict[str, Any], str | None]] = []
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
    for device, parent_meter in new_devices:
        blocker = _schedulable_container(device, included_in, owners)
        if blocker is not None:
            conflicts.append(
                EnergyImportConflict(
                    energy_entity_id=device["consumption"]["energy_entity_id"],
                    device_id=peek_controllable_id(blocker),
                )
            )
            continue
        parent = owners.get(parent_meter) if parent_meter is not None else None
        # A cycle in Energy's nesting (or a row nested in itself) has no
        # parent to go under; the row stays at the top level.
        if parent is not None and _nested_in(parent, device, included_in, owners):
            parent = None
        if (
            parent is not None
            and "power_entity_id" not in device["consumption"]
            and any(own_meter(child) is None for child in device_children(parent))
        ):
            conflicts.append(
                EnergyImportConflict(
                    energy_entity_id=device["consumption"]["energy_entity_id"],
                    device_id=peek_controllable_id(parent),
                    reason="power_required",
                )
            )
            continue
        children = parent.setdefault("children", []) if parent is not None else None
        (children if isinstance(children, list) else imported).append(device)
    return EnergyImport(imported, conflicts, external)


def _schedulable_container(
    device: Mapping[str, Any],
    included_in: Mapping[int, str | None],
    owners: Mapping[str, Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    """The schedulable device whose meter contains ``device``'s, if any.

    Follows Energy's nesting up through the imported rows. It stops at the
    first existing device: that is where the row is placed, and a schedulable
    one cannot take it.
    """
    seen: set[int] = set()
    while (parent_meter := included_in.get(id(device))) is not None:
        parent = owners.get(parent_meter)
        if parent is None or id(parent) in seen:
            return None
        if is_schedulable(parent):
            return parent
        if id(parent) not in included_in:
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
