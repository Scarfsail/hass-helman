"""What every Helman entity platform shares."""

from __future__ import annotations

from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo

from .const import DOMAIN


def helman_device_info(entry: ConfigEntry) -> DeviceInfo:
    """The one shared ``Helman`` device every Helman entity sits on."""
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="Helman",
        entry_type=DeviceEntryType.SERVICE,
    )


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
