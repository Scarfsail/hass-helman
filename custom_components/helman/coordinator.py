from __future__ import annotations

from typing import TYPE_CHECKING, Awaitable, Callable

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .storage import HelmanStorage
from .tree_builder import HelmanTreeBuilder

if TYPE_CHECKING:
    from .sensor import HelmanPowerSummarySensor


class HelmanCoordinator:
    def __init__(self, hass: HomeAssistant, storage: HelmanStorage) -> None:
        self._hass = hass
        self._storage = storage
        self._cached_tree: dict | None = None
        self._unsub_listeners: list = []
        self._unsub_energy: Callable[[], None] | None = None
        self._sensor: HelmanPowerSummarySensor | None = None
        self._power_sensor_ids: list[str] = []
        self._unsubscribe_power: list = []

    def set_sensor(self, sensor: HelmanPowerSummarySensor) -> None:
        """Called by the sensor entity after it is added to hass."""
        self._sensor = sensor
        self._push_power_snapshot()

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

        # Energy prefs use an internal listener API, not the event bus.
        # Capture the returned unsubscribe callable for clean teardown.
        async def _on_energy_updated() -> None:
            await self._async_rebuild_subscriptions()

        manager = await energy_data.async_get_manager(self._hass)
        self._unsub_energy = manager.async_listen_updates(_on_energy_updated)

        # Build tree upfront to learn which power sensors to track
        tree = await self.get_device_tree()
        self._power_sensor_ids = self._collect_power_sensor_ids(tree)
        self._subscribe_to_power_sensors()

    @callback
    def _on_registry_updated(self, event) -> None:
        self._cached_tree = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    def invalidate_tree(self) -> None:
        """Invalidate the cached tree (call after config changes)."""
        self._cached_tree = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    async def _async_rebuild_subscriptions(self) -> None:
        """Rebuild tree and re-subscribe to power sensors after tree invalidation."""
        tree = await self.get_device_tree()
        self._power_sensor_ids = self._collect_power_sensor_ids(tree)
        self._subscribe_to_power_sensors()
        self._push_power_snapshot()

    async def get_device_tree(self) -> dict:
        """Return cached or freshly built device tree."""
        if self._cached_tree is None:
            builder = HelmanTreeBuilder(self._hass, self._storage.config)
            self._cached_tree = await builder.build()
        return self._cached_tree

    def _collect_power_sensor_ids(self, tree: dict) -> list[str]:
        """Collect all unique power_sensor_id values from the tree dict."""
        ids: set[str] = set()

        def traverse(nodes: list) -> None:
            for node in nodes:
                sensor_id = node.get("powerSensorId")
                if sensor_id:
                    ids.add(sensor_id)
                traverse(node.get("children", []))

        traverse(tree.get("sources", []))
        traverse(tree.get("consumers", []))
        return list(ids)

    def _subscribe_to_power_sensors(self) -> None:
        """Subscribe to state changes for all tracked power sensors."""
        for unsub in self._unsubscribe_power:
            unsub()
        self._unsubscribe_power = []
        if self._power_sensor_ids:
            self._unsubscribe_power.append(
                async_track_state_change_event(
                    self._hass,
                    self._power_sensor_ids,
                    self._on_power_sensor_change,
                )
            )

    @callback
    def _on_power_sensor_change(self, event) -> None:
        """Called by HA whenever any tracked power sensor changes state."""
        self._push_power_snapshot()

    def _push_power_snapshot(self) -> None:
        """Compute current power snapshot and push it to the sensor entity."""
        if self._sensor is None or self._cached_tree is None:
            return
        snapshot = self._compute_snapshot()
        self._sensor.update_snapshot(snapshot)

    def _compute_snapshot(self) -> dict:
        """Read current hass.states for all power entities and build snapshot dict."""
        devices: dict = {}

        def get_power(entity_id: str | None, value_type: str) -> float:
            if not entity_id:
                return 0.0
            state = self._hass.states.get(entity_id)
            if state is None or state.state in ("unavailable", "unknown", "none"):
                return 0.0
            try:
                raw = float(state.state)
            except ValueError:
                return 0.0
            if value_type == "positive":
                return max(0.0, raw)
            if value_type == "negative":
                return abs(min(0.0, raw))
            return raw

        def collect(nodes: list) -> None:
            for node in nodes:
                if not node.get("isVirtual") and not node.get("isUnmeasured"):
                    sensor_id = node.get("powerSensorId")
                    if sensor_id:
                        power = get_power(sensor_id, node.get("valueType", "default"))
                        devices[node["id"]] = {
                            "power": round(power),
                            "name": node.get("displayName", ""),
                        }
                collect(node.get("children", []))

        collect(self._cached_tree.get("sources", []))
        collect(self._cached_tree.get("consumers", []))

        pd = self._storage.config.get("power_devices", {})

        def get_raw(key: str) -> float:
            sensor = pd.get(key, {}).get("entities", {}).get("power")
            return get_power(sensor, "default") if sensor else 0.0

        return {
            "house_power": round(get_raw("house")),
            "solar_power": round(get_raw("solar")),
            "battery_power": round(get_raw("battery")),
            "grid_power": round(get_raw("grid")),
            "devices": devices,
            "timestamp": dt_util.now().isoformat(),
        }

    async def async_unload(self) -> None:
        """Clean up event listeners."""
        for unsub in self._unsubscribe_power:
            unsub()
        self._unsubscribe_power = []
        self._sensor = None

        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()

        if self._unsub_energy is not None:
            self._unsub_energy()
            self._unsub_energy = None
