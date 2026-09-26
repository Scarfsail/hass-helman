"""Reading the ``devices:`` tree — one entry point for every device reader.

Config version 20 replaced the flat ``controllables:`` list with a tree of
devices: the inverter plus every energy-consuming device, schedulable or
passive, with ``children`` for what sits behind a device's meter. Every reader
of that tree walks it through :func:`iter_devices`, so "which devices are
there" is one question asked once.

What lives here is what would otherwise be derived twice: a device's kind and
id, whether Helman may schedule it, which meter it draws from (its *effective
meter*), which meters are carved out of the house baseline, which devices split
a meter, and a device's display name. The per-kind runtime readers stay in
:mod:`..appliances.config` and
:func:`..scheduling.schedule.read_schedule_control_config`.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Collection, Iterator, Mapping
from typing import Any

from .spec import (
    CONTROLLABLE_KIND_CLIMATE,
    CONTROLLABLE_KIND_GENERIC,
    CONTROLLABLE_KIND_INVERTER,
)

#: The id the inverter entry is migrated to and the one the UI seeds. Reserved:
#: config validation refuses it to every other kind, so an optimizer targeting
#: ``inverter`` can only ever mean the inverter.
CONTROLLABLE_ID_INVERTER = "inverter"

#: Device = one mapping of the tree; ``(device, parent)`` is what the flattening
#: generator yields, ``parent`` being ``None`` at the top level.
Device = Mapping[str, Any]


def read_devices(config: Mapping[str, Any] | None) -> Any:
    """The raw ``devices:`` value — ``None`` when absent.

    Returned unvalidated on purpose: the runtime reader logs a bad type and
    carries on, while the config validator reports it, and both need to tell
    "absent" apart from "present but wrong".
    """
    if not isinstance(config, Mapping):
        return None
    return config.get("devices")


def iter_devices(
    config: Mapping[str, Any] | None,
) -> Iterator[tuple[Device, Device | None]]:
    """Every device in the tree as ``(device, parent)``, in document order.

    Depth first, a parent before its children, which is the order the document
    reads in. Anything that is not a mapping is skipped, and so is a
    ``children`` value that is not a list — the validator reports both.
    """
    for _path, device, parent in iter_device_paths(config):
        if isinstance(device, Mapping):
            yield device, parent


def iter_device_paths(
    config: Mapping[str, Any] | None,
) -> Iterator[tuple[str, Any, Device | None]]:
    """:func:`iter_devices` with each entry's document path, non-mappings included.

    For the readers that must say *where* something is — validation and the
    runtime registry's log lines: ``devices[1].children[0]``.
    """
    devices = read_devices(config)
    if isinstance(devices, list):
        yield from _iter_children(devices, None, "devices")


def _iter_children(
    devices: list[Any], parent: Device | None, path: str
) -> Iterator[tuple[str, Any, Device | None]]:
    for index, device in enumerate(devices):
        device_path = f"{path}[{index}]"
        yield device_path, device, parent
        if not isinstance(device, Mapping):
            continue
        children = device.get("children")
        if isinstance(children, list):
            yield from _iter_children(children, device, f"{device_path}.children")


def device_children(device: Device) -> list[Device]:
    """A device's direct children that are mappings."""
    children = device.get("children")
    if not isinstance(children, list):
        return []
    return [child for child in children if isinstance(child, Mapping)]


def peek_controllable_kind(value: Any) -> str | None:
    """The kind of one device, without reading the rest of it.

    ``kind`` is optional and defaults to ``generic``; a declared value that is
    not a string, or is blank, reads as ``None`` for the validator to report.
    """
    if not isinstance(value, Mapping):
        return None
    if "kind" not in value:
        return CONTROLLABLE_KIND_GENERIC
    kind = value.get("kind")
    if not isinstance(kind, str):
        return None
    return kind.strip() or None


def peek_controllable_id(value: Any) -> str | None:
    """The declared ``id`` of one device, without reading the rest of it."""
    if not isinstance(value, Mapping):
        return None
    controllable_id = value.get("id")
    if not isinstance(controllable_id, str):
        return None
    return controllable_id.strip() or None


def is_schedulable(device: Device) -> bool:
    """Whether Helman may plan and execute this device.

    The inverter always is and carries no flag; every other device only when it
    says ``schedulable: true``.
    """
    if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
        return True
    return device.get("schedulable") is True


def own_meter(device: Device) -> str | None:
    """The device's own ``consumption.energy_entity_id``, stripped."""
    consumption = device.get("consumption")
    if not isinstance(consumption, Mapping):
        return None
    entity_id = consumption.get("energy_entity_id")
    if not isinstance(entity_id, str) or not entity_id.strip():
        return None
    return entity_id.strip()


def effective_meter(device: Device, parent: Device | None) -> str | None:
    """The meter this device's energy is read from.

    Its own meter, else its parent's: a meterless child draws from the meter it
    sits behind, and that is where its runtimes and training read.
    """
    meter = own_meter(device)
    if meter is not None or parent is None:
        return meter
    return own_meter(parent)


def running_signal(device: Device) -> tuple[str, str] | None:
    """``(entity id, "switch" | "climate")`` telling when this device runs.

    A meterless child's share of its parent's meter follows this entity.
    ``None`` when the device names neither control.
    """
    controls = device.get("controls")
    if not isinstance(controls, Mapping):
        return None
    for activity in ("switch", CONTROLLABLE_KIND_CLIMATE):
        control = controls.get(activity)
        if not isinstance(control, Mapping):
            continue
        entity_id = control.get("entity_id")
        if isinstance(entity_id, str) and entity_id.strip():
            return entity_id.strip(), activity
    return None


#: What "running" means for each running signal: a switch is on, a climate
#: entity is heating or cooling. Named once so a shared meter's members are
#: judged exactly as a lone appliance of the same kind would be.
SWITCH_ACTIVE_STATES: tuple[str, ...] = ("on",)
CLIMATE_ACTIVE_STATES: tuple[str, ...] = ("heat", "cool")


def running_active_states(activity: str) -> tuple[str, ...]:
    """The active states of a :func:`running_signal`'s ``"switch" | "climate"``.

    With :func:`is_active_state`, the one definition of "running" for a
    meterless child: the shared-meter history split and the live share power
    both ask it, so the trained and the live split cannot disagree.
    """
    return SWITCH_ACTIVE_STATES if activity == "switch" else CLIMATE_ACTIVE_STATES


def is_active_state(value: Any, active_states: Collection[str]) -> bool:
    """Whether a state value is one of ``active_states`` (lower-case)."""
    return isinstance(value, str) and value.strip().lower() in active_states


def read_controllable_kinds_by_id(
    config: Mapping[str, Any] | None,
) -> dict[str, str]:
    """``device id -> kind`` for every device in the tree that names both.

    The lookup an optimizer's ``target.controllable_id`` resolves against. It
    reads the raw document rather than a runtime registry on purpose: the
    validator must answer "does this id name something, and what kind is it"
    even for a device whose per-kind config is broken enough that no runtime
    object could be built from it — otherwise one bad appliance would be
    reported twice, once as itself and once as every optimizer aiming at it.

    An inverter with no ``id`` is indexed under :data:`CONTROLLABLE_ID_INVERTER`
    anyway. Validation reports the missing id on the device, where the fix is.

    First wins on a duplicate id, matching :func:`find_inverter_device`;
    validation rejects duplicates separately.
    """
    kinds_by_id: dict[str, str] = {}
    for device, _parent in iter_devices(config):
        kind = peek_controllable_kind(device)
        if kind is None:
            continue
        controllable_id = peek_controllable_id(device)
        if controllable_id is None:
            if kind != CONTROLLABLE_KIND_INVERTER:
                continue
            controllable_id = CONTROLLABLE_ID_INVERTER
        kinds_by_id.setdefault(controllable_id, kind)
    return kinds_by_id


def read_schedulable_ids(config: Mapping[str, Any] | None) -> set[str]:
    """The ids of every schedulable device — what an optimizer may target.

    The inverter is indexed under :data:`CONTROLLABLE_ID_INVERTER` even without
    an id, as in :func:`read_controllable_kinds_by_id`.
    """
    schedulable_ids: set[str] = set()
    for device, _parent in iter_devices(config):
        if not is_schedulable(device):
            continue
        controllable_id = peek_controllable_id(device)
        if controllable_id is None and (
            peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER
        ):
            controllable_id = CONTROLLABLE_ID_INVERTER
        if controllable_id is not None:
            schedulable_ids.add(controllable_id)
    return schedulable_ids


def _device_label(device: Device, fallback: str) -> str:
    """A device's configured name, falling back when it declares none."""
    name = device.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else fallback


def read_schedulable_consumers(
    config: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """``[{id, label, energy_entity_id, deferrable}]`` — every schedulable consumer.

    The forecast's itemisation is keyed by device id, so this is keyed by id
    too, and a device that declares none is skipped: nothing can be scheduled
    against it. ``energy_entity_id`` is the device's effective meter, so a
    meterless child names the meter it draws from, and ``deferrable`` says
    whether that meter is carved out of the house baseline — the same answer
    :func:`read_carved_meters` gives, on both sides of now.
    """
    carved = {meter["energy_entity_id"] for meter in read_carved_meters(config)}
    consumers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for device, parent in iter_devices(config):
        if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
            continue
        if not is_schedulable(device):
            continue
        controllable_id = peek_controllable_id(device)
        if controllable_id is None or controllable_id in seen:
            continue
        seen.add(controllable_id)
        meter = effective_meter(device, parent)
        consumers.append(
            {
                "id": controllable_id,
                "label": _device_label(device, controllable_id),
                "energy_entity_id": meter,
                "deferrable": meter in carved,
            }
        )
    return consumers


def read_carved_meters(
    config: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """``[{energy_entity_id, label, ids, metered_children}]`` — meters carved out of house load.

    The house forecast is the baseline plus schedulable demand, so a meter's
    *own* energy — its reading minus its metered children's — is carved out of
    the baseline exactly when all demand behind it is schedulable:

    * the owner is schedulable (then it is a leaf, and its own energy is its
      meter), or
    * it has meterless children and every one of them is schedulable.

    ``metered_children`` are the meters of the owner's direct children that
    have their own, which is what own energy subtracts; nested meters therefore
    never subtract twice. ``ids`` are the devices whose demand the meter stands
    for: the owner's id when it is schedulable, else its meterless children's —
    a schedule keyed by exactly those ids resolves to this meter.

    ``label`` is the owner's configured name, else the meter's entity id.
    """
    carved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for device, _parent in iter_devices(config):
        if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
            continue
        meter = own_meter(device)
        if meter is None or meter in seen:
            continue
        children = device_children(device)
        meterless = [child for child in children if own_meter(child) is None]
        if is_schedulable(device):
            owner_id = peek_controllable_id(device)
            ids = [owner_id] if owner_id is not None else []
        elif meterless and all(is_schedulable(child) for child in meterless):
            ids = [
                child_id
                for child in meterless
                if (child_id := peek_controllable_id(child)) is not None
            ]
        else:
            continue
        seen.add(meter)
        carved.append(
            {
                "energy_entity_id": meter,
                "label": _device_label(device, meter),
                "ids": ids,
                "metered_children": _metered_children(children),
            }
        )
    return carved


def read_shared_meters(
    config: Mapping[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """``meter -> {members, metered_children}`` for every meter with meterless children.

    The one source of truth for "which devices split this meter": a meter
    owner's meterless children, schedulable or passive — a passive child still
    runs and still draws from the meter. Each member is
    ``(id, running-signal entity, "switch" | "climate")``; a child without an id
    or a running signal is skipped (validation requires both).

    ``metered_children`` are the owner's children with their own meter, whose
    readings own energy subtracts before the split.
    """
    shared: dict[str, dict[str, Any]] = {}
    for device, _parent in iter_devices(config):
        meter = own_meter(device)
        if meter is None or meter in shared:
            continue
        children = device_children(device)
        members = [
            (child_id, *signal)
            for child in children
            if own_meter(child) is None
            and (child_id := peek_controllable_id(child)) is not None
            and (signal := running_signal(child)) is not None
        ]
        if members:
            shared[meter] = {
                "members": members,
                "metered_children": _metered_children(children),
            }
    return shared


def _metered_children(children: list[Device]) -> list[str]:
    return [meter for child in children if (meter := own_meter(child)) is not None]


def find_inverter_device(config: Mapping[str, Any] | None) -> Mapping[str, Any]:
    """The single ``kind: inverter`` device, or an empty mapping.

    Top level only: validation refuses an inverter anywhere else. First wins if
    a hand-edited config declares two; validation rejects that case, and
    picking the first keeps the runtime deterministic in the window between a
    bad save and the user fixing it.
    """
    devices = read_devices(config)
    if not isinstance(devices, list):
        return {}
    for device in devices:
        if peek_controllable_kind(device) == CONTROLLABLE_KIND_INVERTER:
            return device
    return {}


def resolve_device_name(
    device: Device,
    *,
    friendly_name: Callable[[str], str | None],
    cleaner_regex: str | None = None,
) -> str:
    """The name every surface shows for a device.

    The ``name`` override, else the friendly name of ``power_entity_id``, else
    of ``energy_entity_id``, else of the control entity — a looked-up friendly
    name cleaned with ``cleaner_regex`` (``visualization.
    power_sensor_name_cleaner_regex``). The device id when none of them
    resolves. ``friendly_name`` maps an entity id to its friendly name or
    ``None``, so the caller decides where states come from.
    """
    name = device.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    consumption = device.get("consumption")
    consumption = consumption if isinstance(consumption, Mapping) else {}
    candidates = [
        consumption.get("power_entity_id"),
        consumption.get("energy_entity_id"),
        *_control_entity_ids(device),
    ]
    for entity_id in candidates:
        if not isinstance(entity_id, str) or not entity_id.strip():
            continue
        friendly = friendly_name(entity_id.strip())
        if friendly:
            return clean_name(friendly, cleaner_regex)
    return peek_controllable_id(device) or ""


def _control_entity_ids(device: Device) -> list[Any]:
    controls = device.get("controls")
    if not isinstance(controls, Mapping):
        return []
    return [
        control.get("entity_id")
        for control in controls.values()
        if isinstance(control, Mapping)
    ]


def clean_name(name: str, pattern: str | None) -> str:
    """``name`` with ``power_sensor_name_cleaner_regex`` removed; unchanged on a bad pattern."""
    if pattern:
        try:
            return re.sub(pattern, "", name).strip()
        except re.error:
            pass
    return name
