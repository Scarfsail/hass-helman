"""What every Helman entity platform shares.

Each entity sits on a device: a node's own entities on that node's ``Helman
<Node>`` service device, a configured consumer's on the consumer's real HA
device when its hardware has one, else on a Helman device named after it.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .controllables.config import (
    Device,
    device_energy_entity,
    device_source_entity_ids,
    entity_friendly_name,
    iter_devices,
    peek_controllable_id,
    read_name_cleaner_regex,
    resolve_device_name,
)

_NODE_DEVICE_NAMES = {
    "solar": "Helman Solar",
    "battery": "Helman Battery",
    "inverter": "Helman Inverter",
    "grid": "Helman Grid",
    "house": "Helman House",
}


def node_device_info(entry: ConfigEntry, node: str) -> DeviceInfo:
    """The ``Helman <Node>`` service device of energy node ``node`` (else the house's)."""
    key = node if node in _NODE_DEVICE_NAMES else "house"
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry.entry_id}_{key}")},
        name=_NODE_DEVICE_NAMES[key],
        manufacturer="Helman",
        entry_type=DeviceEntryType.SERVICE,
    )


@dataclass(frozen=True)
class ConsumerDeviceBinding:
    """Where a consumer's entity sits: a foreign HA device, or a Helman one.

    Exactly one of ``device_entry`` and ``device_info`` is set. ``shared`` is
    true when other configured consumers sit on the same foreign device too;
    their entities then carry ``name``, the consumer's name, to stay apart.
    """

    device_entry: dr.DeviceEntry | None = None
    device_info: DeviceInfo | None = None
    name: str = ""
    shared: bool = False

    def apply(self, entity: Entity) -> None:
        """Put ``entity`` on this device; a shared one names it ``<key>_named``."""
        if self.device_entry is None:
            entity._attr_device_info = self.device_info
            return
        # With no device info, the platform registers the entity on the
        # device_entry as it is, so the foreign device stays its integration's own.
        entity.device_entry = self.device_entry
        if self.shared:
            entity._attr_translation_key = f"{entity._attr_translation_key}_named"
            entity._attr_translation_placeholders = {"name": self.name}


def device_owner_entry_ids(device: Any) -> set[str]:
    """The config entries owning an HA device, on either device-registry shape.

    HA 2026.8+ has one ``config_entry_id``; before, a set of
    ``config_entries``, which later releases warn on reading, so it is read
    only on a device without ``config_entry_id``.
    """
    if hasattr(device, "config_entry_id"):
        return {device.config_entry_id} - {None}
    return set(device.config_entries)


def _is_helman_owned(hass: HomeAssistant, device: Any) -> bool:
    return any(
        (owner := hass.config_entries.async_get_entry(entry_id)) is not None
        and owner.domain == DOMAIN
        for entry_id in device_owner_entry_ids(device)
    )


def _foreign_device(
    hass: HomeAssistant,
    entry: ConfigEntry,
    device: Device | None,
    meter_entity_id: str | None,
) -> dr.DeviceEntry | None:
    """The real HA device a consumer's hardware is on, if it has one.

    Its profile's bound device first, then the device of each entity it is
    read through. Helman's own entities and devices never count, so a reload
    cannot link a consumer to the entities this very binding placed.
    """
    profile = device.get("profile") if device is not None else None
    profile_device_id = (
        profile.get("device_id") if isinstance(profile, Mapping) else None
    )
    entity_ids = (
        device_source_entity_ids(device)
        if device is not None
        else [meter_entity_id] if meter_entity_id else []
    )
    if not isinstance(profile_device_id, str) and not entity_ids:
        return None
    ent_reg = er.async_get(hass)
    candidates = [profile_device_id] if isinstance(profile_device_id, str) else []
    for entity_id in entity_ids:
        row = ent_reg.async_get(entity_id)
        if (
            row is None
            or row.platform == DOMAIN
            or row.config_entry_id == entry.entry_id
            or row.device_id is None
        ):
            continue
        candidates.append(row.device_id)
    dev_reg = dr.async_get(hass)
    for device_id in candidates:
        # ``devices.get``, not ``async_get``: from HA 2026.8 the latter
        # synthesizes a read-only device for a pre-migration composite id.
        ha_device = dev_reg.devices.get(device_id)
        if ha_device is not None and not _is_helman_owned(hass, ha_device):
            return ha_device
    return None


def _consumer_name(hass: HomeAssistant, config: Any, device: Device) -> str:
    def friendly_name(entity_id: str) -> str | None:
        # Helman's own entities (an EV charging switch) are named after this
        # very name: read back, it would grow on every reload.
        row = er.async_get(hass).async_get(entity_id)
        if row is not None and row.platform == DOMAIN:
            return None
        return entity_friendly_name(hass, entity_id)

    return resolve_device_name(
        device,
        friendly_name=friendly_name,
        cleaner_regex=read_name_cleaner_regex(config),
    )


def foreign_device_consumer_counts(
    hass: HomeAssistant, entry: ConfigEntry, config: Any
) -> dict[str, Counter[str]]:
    """Per foreign HA device id, how many consumers resolve to it, by name."""
    counts: dict[str, Counter[str]] = {}
    for device, _parent in iter_devices(config):
        ha_device = _foreign_device(hass, entry, device, None)
        if ha_device is not None:
            counts.setdefault(ha_device.id, Counter())[
                _consumer_name(hass, config, device)
            ] += 1
    return counts


def _find_consumer(
    config: Any, device_id: str | None, meter_entity_id: str | None
) -> Device | None:
    if device_id is not None:
        return next(
            (d for d, _parent in iter_devices(config) if peek_controllable_id(d) == device_id),
            None,
        )
    # A tree node's id is its energy entity: a meterless parent's is its share sensor.
    return next(
        (
            d
            for d, parent in iter_devices(config)
            if device_energy_entity(d, parent) == meter_entity_id
        ),
        None,
    )


def consumer_device_binding(
    hass: HomeAssistant,
    entry: ConfigEntry,
    config: Any,
    *,
    device_id: str | None = None,
    meter_entity_id: str | None = None,
    device: Device | None = None,
    fallback_name: str | None = None,
    counts: Mapping[str, Counter[str]] | None = None,
) -> ConsumerDeviceBinding:
    """The device a configured consumer's Helman entities sit on.

    The consumer is ``device``, else the one with id ``device_id``, else the
    one whose tree node is ``meter_entity_id``. Its real HA device when it has
    one, else a Helman device named after it. ``counts`` is
    :func:`foreign_device_consumer_counts`, computed once by a caller binding
    many consumers; computed here when omitted.
    """
    if device is None:
        device = _find_consumer(config, device_id, meter_entity_id)
    resolved_id = peek_controllable_id(device) or device_id or meter_entity_id or "unknown"
    name = (
        _consumer_name(hass, config, device) if device is not None else None
    ) or fallback_name or resolved_id
    ha_device = _foreign_device(hass, entry, device, meter_entity_id)
    if ha_device is None:
        return ConsumerDeviceBinding(
            device_info=DeviceInfo(
                identifiers={(DOMAIN, f"{entry.entry_id}_device_{resolved_id}")},
                name=name,
                manufacturer="Helman",
            ),
            name=name,
        )
    if counts is None:
        counts = foreign_device_consumer_counts(hass, entry, config)
    names = counts.get(ha_device.id, Counter())
    if names[name] > 1:
        name = f"{name} ({resolved_id})"
    return ConsumerDeviceBinding(
        device_entry=ha_device, name=name, shared=names.total() > 1
    )


@callback
def remove_stale_devices(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Remove the devices only this entry owns that none of its entities is on.

    Rows still on the retired ``Helman`` hub are for unique ids Helman no
    longer creates, which no platform setup moves off it: they are detached
    first, so the hub goes too. A device another entry also owns is left alone.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    hub = dev_reg.async_get_device(identifiers={(DOMAIN, entry.entry_id)})
    if hub is not None:
        for row in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
            if row.device_id == hub.id:
                ent_reg.async_update_entity(row.entity_id, device_id=None)
    referenced = {
        row.device_id for row in er.async_entries_for_config_entry(ent_reg, entry.entry_id)
    }
    for device in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        if device_owner_entry_ids(device) == {entry.entry_id} and device.id not in referenced:
            dev_reg.async_remove_device(device.id)


@callback
def remove_stale_entities(
    hass: HomeAssistant,
    entry: ConfigEntry,
    domain: str,
    is_stale: Callable[[str], bool],
) -> None:
    """Drop this entry's ``domain`` registry rows whose unique id ``is_stale``.

    For an entity whose hardware profile is gone: left registered, a picker
    would still offer it.
    """
    registry = er.async_get(hass)
    for row in er.async_entries_for_config_entry(registry, entry.entry_id):
        if row.domain == domain and is_stale(row.unique_id):
            registry.async_remove(row.entity_id)
