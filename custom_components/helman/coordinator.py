from __future__ import annotations

from typing import Awaitable, Callable

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant, callback

from .storage import HelmanStorage
from .tree_builder import HelmanTreeBuilder


class HelmanCoordinator:
    def __init__(self, hass: HomeAssistant, storage: HelmanStorage) -> None:
        self._hass = hass
        self._storage = storage
        self._cached_tree: dict | None = None
        self._unsub_listeners: list = []
        self._energy_update_listener: Callable[[], Awaitable] | None = None

    async def async_setup(self) -> None:
        """Register event listeners that invalidate the cached tree."""
        self._unsub_listeners.append(
            self._hass.bus.async_listen(
                "entity_registry_updated", self._on_registry_updated
            )
        )
        self._unsub_listeners.append(
            self._hass.bus.async_listen(
                "device_registry_updated", self._on_registry_updated
            )
        )

        # Energy prefs use an internal listener API, not the event bus
        async def _on_energy_updated() -> None:
            self._cached_tree = None

        self._energy_update_listener = _on_energy_updated
        manager = await energy_data.async_get_manager(self._hass)
        manager.async_listen_updates(_on_energy_updated)

    @callback
    def _on_registry_updated(self, event) -> None:
        self._cached_tree = None

    def invalidate_tree(self) -> None:
        """Invalidate the cached tree (call after config changes)."""
        self._cached_tree = None

    async def get_device_tree(self) -> dict:
        """Return cached or freshly built device tree."""
        if self._cached_tree is None:
            builder = HelmanTreeBuilder(self._hass, self._storage.config)
            self._cached_tree = await builder.build()
        return self._cached_tree

    async def async_unload(self) -> None:
        """Clean up event listeners."""
        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()

        # Remove energy update listener from the manager's internal list
        if self._energy_update_listener is not None:
            manager = await energy_data.async_get_manager(self._hass)
            try:
                manager._update_listeners.remove(self._energy_update_listener)
            except ValueError:
                pass
            self._energy_update_listener = None
