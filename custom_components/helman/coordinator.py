from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Awaitable, Callable

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .history_aggregator import HelmanHistoryAggregator
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
        self._battery_time_sensor = None
        self._unmeasured_sensor = None
        self._sensors_ready: int = 0
        self._sensors_total: int = 0
        self._power_sensor_ids: list[str] = []
        self._source_sensor_ids: list[str] = []
        self._source_value_types: dict[str, str] = {}
        self._consumer_entity_ids: list[str] = []
        self._consumer_value_types: dict[str, str] = {}
        self._unsubscribe_power: list = []
        self._history_cache: dict | None = None
        self._history_expires_at: datetime | None = None
        self._history_lock: asyncio.Lock = asyncio.Lock()
        self._aggregator = HelmanHistoryAggregator(hass)

    def set_sensors(self, power_summary, battery_time, unmeasured) -> None:
        """Called from async_setup_entry to register all sensor entities."""
        self._sensor = power_summary
        self._battery_time_sensor = battery_time
        self._unmeasured_sensor = unmeasured
        self._sensors_total = 3
        self._sensors_ready = 0

    def register_sensor_ready(self) -> None:
        """Called by each sensor entity from async_added_to_hass."""
        self._sensors_ready += 1
        if self._sensors_ready >= self._sensors_total:
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
        self._source_sensor_ids = self._collect_source_sensor_ids(tree)
        self._source_value_types = self._collect_source_value_types(tree)
        self._consumer_entity_ids, self._consumer_value_types = (
            self._collect_dual_role_consumer_info(tree, self._source_sensor_ids)
        )
        self._subscribe_to_power_sensors()

    @callback
    def _on_registry_updated(self, event) -> None:
        self._cached_tree = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    def invalidate_tree(self) -> None:
        """Invalidate the cached tree (call after config changes)."""
        self._cached_tree = None
        self._history_cache = None
        self._history_expires_at = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    async def _async_rebuild_subscriptions(self) -> None:
        """Rebuild tree and re-subscribe to power sensors after tree invalidation."""
        try:
            tree = await self.get_device_tree()
            self._power_sensor_ids = self._collect_power_sensor_ids(tree)
            self._source_sensor_ids = self._collect_source_sensor_ids(tree)
            self._source_value_types = self._collect_source_value_types(tree)
            self._consumer_entity_ids, self._consumer_value_types = (
                self._collect_dual_role_consumer_info(tree, self._source_sensor_ids)
            )
            self._history_cache = None
            self._subscribe_to_power_sensors()
            self._push_power_snapshot()
        except Exception:
            logging.getLogger(__name__).exception(
                "Error rebuilding Helman subscriptions"
            )

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

    def _collect_source_sensor_ids(self, tree: dict) -> list[str]:
        """Collect power_sensor_id values for top-level source nodes only."""
        ids: list[str] = []
        for node in tree.get("sources", []):
            sensor_id = node.get("powerSensorId")
            if sensor_id:
                ids.append(sensor_id)
        return ids

    def _collect_source_value_types(self, tree: dict) -> dict[str, str]:
        """Return a mapping of source power_sensor_id → value_type."""
        types: dict[str, str] = {}
        for node in tree.get("sources", []):
            sensor_id = node.get("powerSensorId")
            if sensor_id:
                types[sensor_id] = node.get("valueType", "default")
        return types

    @staticmethod
    def _collect_dual_role_consumer_info(
        tree: dict, source_sensor_ids: list[str]
    ) -> tuple[list[str], dict[str, str]]:
        """Find consumer nodes whose entity ID is also a source entity ID.

        Battery and grid nodes appear both as sources and as consumers.  The
        history aggregator needs to compute source-ratio breakdowns for the
        consumer side separately, using consumer-mode value_type clamping
        (positive = charging / importing).

        Returns (entity_ids, value_types_map).
        """
        ids: list[str] = []
        types: dict[str, str] = {}
        source_id_set = set(source_sensor_ids)
        for node in tree.get("consumers", []):
            sensor_id = node.get("powerSensorId")
            if sensor_id and sensor_id in source_id_set:
                ids.append(sensor_id)
                types[sensor_id] = node.get("valueType", "positive")
        return ids, types

    async def get_history(self) -> dict:
        """Return cached or freshly computed bucketed history."""
        async with self._history_lock:
            now = datetime.now(tz=timezone.utc)
            if (
                self._history_cache is None
                or self._history_expires_at is None
                or now >= self._history_expires_at
            ):
                self._history_cache = await self._aggregator.async_get_history(
                    self._power_sensor_ids,
                    self._source_sensor_ids,
                    self._source_value_types,
                    self._consumer_entity_ids,
                    self._consumer_value_types,
                    self._storage.config,
                )
                bucket_duration = self._storage.config.get("history_bucket_duration", 1)
                self._history_expires_at = now + timedelta(seconds=bucket_duration * 2)
            return self._history_cache

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

    def _read_power(self, entity_id: str | None, value_type: str) -> float:
        """Read a power sensor's current value from hass.states."""
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

    def _push_power_snapshot(self) -> None:
        """Compute current power snapshot and push it to all sensor entities."""
        if self._sensor is None or self._cached_tree is None:
            return
        if self._sensors_ready < self._sensors_total:
            return
        snapshot = self._compute_snapshot()
        self._sensor.update_snapshot(snapshot)

        if self._battery_time_sensor is not None:
            minutes, target_time, mode, target_soc = self._compute_battery_eta(snapshot)
            self._battery_time_sensor.update_value(minutes, target_time, mode, target_soc)

        if self._unmeasured_sensor is not None:
            unmeasured = self._compute_unmeasured_power()
            self._unmeasured_sensor.update_value(unmeasured)

    def _compute_snapshot(self) -> dict:
        """Read current hass.states for all power entities and build snapshot dict."""
        devices: dict = {}

        def collect(nodes: list) -> None:
            for node in nodes:
                if not node.get("isVirtual") and not node.get("isUnmeasured"):
                    sensor_id = node.get("powerSensorId")
                    if sensor_id:
                        power = self._read_power(sensor_id, node.get("valueType", "default"))
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
            return self._read_power(sensor, "default") if sensor else 0.0

        return {
            "house_power": round(get_raw("house")),
            "solar_power": round(get_raw("solar")),
            "battery_power": round(get_raw("battery")),
            "grid_power": round(get_raw("grid")),
            "devices": devices,
            "timestamp": dt_util.now().isoformat(),
        }

    def _compute_battery_eta(
        self, snapshot: dict
    ) -> tuple[float | None, str, str, int | None]:
        """Compute battery time-to-target. Returns (minutes, target_time_iso, mode, target_soc)."""
        battery_cfg = self._storage.config.get("power_devices", {}).get("battery", {})
        entities = battery_cfg.get("entities", {})

        try:
            remaining_wh = float(self._hass.states.get(entities["remaining_energy"]).state)
            capacity_pct = float(self._hass.states.get(entities["capacity"]).state)
            min_soc = float(self._hass.states.get(entities["min_soc"]).state)
            max_soc = float(self._hass.states.get(entities["max_soc"]).state)
        except (KeyError, TypeError, ValueError, AttributeError):
            return None, "", "idle", None

        if capacity_pct <= 0:
            return None, "", "idle", None

        power_w = snapshot.get("battery_power", 0.0)
        rolling_power = abs(power_w)

        if power_w < -1:  # discharging (source)
            usable = remaining_wh - (remaining_wh / (capacity_pct / 100)) * min_soc / 100
            if usable <= 0:
                return None, "", "idle", None
            hours = usable / rolling_power
            mode = "discharging"
            target_soc = round(min_soc)
        elif power_w > 1:  # charging (consumer)
            total_wh = remaining_wh / (capacity_pct / 100)
            to_full = total_wh * max_soc / 100 - remaining_wh
            if to_full <= 0:
                return None, "", "idle", None
            hours = to_full / rolling_power
            mode = "charging"
            target_soc = round(max_soc)
        else:
            return None, "", "idle", None

        minutes = hours * 60
        target = datetime.now(tz=timezone.utc) + timedelta(hours=hours)
        return minutes, target.isoformat(), mode, target_soc

    def _compute_unmeasured_power(self) -> float:
        """Compute unmeasured house power = house power minus sum of measured house children."""
        if self._cached_tree is None:
            return 0.0
        house_node = next(
            (n for n in self._cached_tree.get("consumers", []) if n.get("id") == "house"),
            None,
        )
        if not house_node:
            return 0.0
        house_power = self._read_power(house_node.get("powerSensorId"), "default")
        measured_sum = sum(
            self._read_power(child.get("powerSensorId"), child.get("valueType", "default"))
            for child in house_node.get("children", [])
            if not child.get("isVirtual")
            and not child.get("isUnmeasured")
            and child.get("powerSensorId")
        )
        return max(0.0, house_power - measured_sum)

    async def async_unload(self) -> None:
        """Clean up event listeners."""
        for unsub in self._unsubscribe_power:
            unsub()
        self._unsubscribe_power = []
        self._sensor = None
        self._battery_time_sensor = None
        self._unmeasured_sensor = None
        self._sensors_ready = 0

        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()

        if self._unsub_energy is not None:
            self._unsub_energy()
            self._unsub_energy = None
