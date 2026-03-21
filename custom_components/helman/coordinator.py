from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Sequence

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import (
    async_track_time_change,
    async_track_time_interval,
)

from homeassistant.util import dt as dt_util

from .battery_capacity_forecast_builder import BatteryCapacityForecastBuilder
from .battery_state import (
    read_battery_entity_config,
    read_battery_live_state,
    read_battery_soc_bounds,
    read_battery_soc_bounds_config,
)
from .const import (
    CONSUMPTION_TOTAL_ENTITY_ID,
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
    PRODUCTION_TOTAL_ENTITY_ID,
)
from .consumption_forecast_builder import ConsumptionForecastBuilder
from .forecast_builder import HelmanForecastBuilder
from .scheduling.schedule import (
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleResponseDict,
    ScheduleSlot,
    apply_slot_patches,
    materialize_schedule_slots,
    prune_expired_slots,
    read_schedule_control_config,
    schedule_document_from_dict,
    schedule_document_to_dict,
    slot_to_dict,
    validate_slot_patch_request,
)
from .storage import HelmanStorage
from .tree_builder import HelmanTreeBuilder

_LOGGER = logging.getLogger(__name__)


class HelmanCoordinator:
    def __init__(self, hass: HomeAssistant, storage: HelmanStorage) -> None:
        self._hass = hass
        self._storage = storage
        self._cached_tree: dict | None = None
        self._unsub_listeners: list = []
        self._unsub_energy: Callable[[], None] | None = None
        self._battery_time_to_full = None
        self._battery_time_to_empty = None
        self._unmeasured_sensors: dict[str, Any] = {}
        self._consumption_total_sensor = None
        self._production_total_sensor = None
        self._async_add_entities: Callable | None = None
        self._unmeasured_sensor_factory: Callable | None = None
        self._entry: Any = None
        self._removing_entity_ids: set[str] = set()
        self._power_sensor_ids: list[str] = []
        self._source_sensor_ids: list[str] = []
        self._source_value_types: dict[str, str] = {}
        # In-memory rolling buffers (oldest first)
        self._power_history: dict[str, deque[float]] = {}
        self._source_ratio_sensors: dict[str, Any] = {}
        # Tick lifecycle
        self._unsub_tick: Callable[[], None] | None = None
        # House forecast snapshot (persisted + cached)
        self._cached_forecast: dict | None = None
        self._unsub_forecast_refresh: Callable[[], None] | None = None
        self._schedule_lock = asyncio.Lock()
        # Mapping: parent_node_id → unmeasured_entity_id (e.g. "house" → "sensor.helman_house_unmeasured_power")
        self._unmeasured_entity_id_map: dict[str, str] = {}
        # Entity IDs whose values are computed by the tick (not read from hass.states)
        self._virtual_sensor_ids: set[str] = set()

    @property
    def config(self) -> dict:
        return self._storage.config

    @staticmethod
    def collect_qualifying_nodes(tree: dict) -> dict[str, str | None]:
        """Return {node_id: parent_power_sensor_id} for non-virtual consumer nodes with unmeasured children."""
        result: dict[str, str | None] = {}

        def walk(nodes: list) -> None:
            for node in nodes:
                children = node.get("children", [])
                if not node.get("isVirtual") and any(c.get("isUnmeasured") for c in children):
                    result[node["id"]] = node.get("powerSensorId")
                walk(children)

        walk(tree.get("consumers", []))
        return result

    def set_sensors(self, battery_time_to_full, battery_time_to_empty, unmeasured_sensors: dict, total_power=None, production_total=None, source_ratio_sensors: dict | None = None) -> None:
        """Called from async_setup_entry to register all sensor entities."""
        self._battery_time_to_full = battery_time_to_full
        self._battery_time_to_empty = battery_time_to_empty
        self._unmeasured_sensors = unmeasured_sensors
        self._consumption_total_sensor = total_power
        self._production_total_sensor = production_total
        self._source_ratio_sensors = source_ratio_sensors or {}

    def set_entity_factory(
        self,
        entry,
        async_add_entities: Callable,
        unmeasured_sensor_factory: Callable,
    ) -> None:
        """Store the async_add_entities callback and sensor factory for dynamic entity management."""
        self._entry = entry
        self._async_add_entities = async_add_entities
        self._unmeasured_sensor_factory = unmeasured_sensor_factory

    def register_sensor_ready(self) -> None:
        """No-op: sensors receive their first value on the next tick."""

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
            self._cached_tree = None
            await self._async_rebuild_subscriptions()

        manager = await energy_data.async_get_manager(self._hass)
        self._unsub_energy = manager.async_listen_updates(_on_energy_updated)

        # Build tree upfront to learn which power sensors to track
        tree = await self.get_device_tree()
        self._power_sensor_ids = self._collect_power_sensor_ids(tree)
        self._source_sensor_ids = self._collect_source_sensor_ids(tree)
        self._source_value_types = self._collect_source_value_types(tree)
        self._init_buffers(tree)
        self._start_tick()

        # House forecast: load persisted snapshot, schedule hourly refresh
        self._cached_forecast = self._storage.forecast_snapshot
        (
            total_energy_entity_id,
            training_window_days,
            min_history_days,
            config_fingerprint,
        ) = self._read_house_forecast_config()
        if not self._has_compatible_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
        ):
            self._cached_forecast = None
        self._start_forecast_refresh()
        self._hass.async_create_task(self._async_refresh_forecast())

    @callback
    def _on_registry_updated(self, event) -> None:
        # Skip events triggered by our own entity removals to avoid rebuild loops.
        entity_id = event.data.get("entity_id", "")
        if entity_id in self._removing_entity_ids:
            self._removing_entity_ids.discard(entity_id)
            return
        self._cached_tree = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    def invalidate_tree(self) -> None:
        """Invalidate the cached tree (call after config changes)."""
        self._cached_tree = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    async def _async_rebuild_subscriptions(self) -> None:
        """Rebuild tree and restart tick after tree invalidation."""
        try:
            self._stop_tick()
            tree = await self.get_device_tree()
            self._power_sensor_ids = self._collect_power_sensor_ids(tree)
            self._source_sensor_ids = self._collect_source_sensor_ids(tree)
            self._source_value_types = self._collect_source_value_types(tree)
            self._init_buffers(tree)
            self._start_tick()
            await self._sync_unmeasured_sensors(tree)
        except Exception:
            logging.getLogger(__name__).exception(
                "Error rebuilding Helman subscriptions"
            )

    async def _sync_unmeasured_sensors(self, tree: dict) -> None:
        """Add/remove HelmanUnmeasuredPowerSensor entities to match the current tree."""
        if self._async_add_entities is None or self._unmeasured_sensor_factory is None:
            return

        qualifying = self.collect_qualifying_nodes(tree)  # {node_id: parent_sensor_id}
        new_ids = set(qualifying.keys())
        existing_ids = set(self._unmeasured_sensors.keys())

        # Remove stale entities from HA and entity registry
        ent_reg = er.async_get(self._hass)
        for node_id in existing_ids - new_ids:
            sensor = self._unmeasured_sensors.pop(node_id)
            entity_id = sensor.entity_id
            if entity_id:
                # Track the removal so _on_registry_updated skips the rebuild loop
                self._removing_entity_ids.add(entity_id)
                ent_reg.async_remove(entity_id)

        # Add new entities to HA
        to_add = new_ids - existing_ids
        if to_add:
            new_sensors = {
                node_id: self._unmeasured_sensor_factory(node_id, qualifying[node_id])
                for node_id in to_add
            }
            self._unmeasured_sensors.update(new_sensors)
            self._async_add_entities(list(new_sensors.values()))

    async def get_device_tree(self) -> dict:
        """Return cached or freshly built device tree."""
        if self._cached_tree is None:
            builder = HelmanTreeBuilder(self._hass, self._storage.config)
            self._cached_tree = await builder.build()
        return self._cached_tree

    def _read_house_forecast_config(self) -> tuple[str | None, int, int, str]:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._storage.config.get("power_devices")
        )
        house_config = ConsumptionForecastBuilder._read_dict(power_devices.get("house"))
        forecast_cfg = ConsumptionForecastBuilder._read_dict(house_config.get("forecast"))
        total_energy_entity_id = ConsumptionForecastBuilder._read_entity_id(
            forecast_cfg.get("total_energy_entity_id")
        )
        training_window_days = ConsumptionForecastBuilder._read_positive_int(
            forecast_cfg.get("training_window_days"),
            HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
        )
        min_history_days = ConsumptionForecastBuilder._read_positive_int(
            forecast_cfg.get("min_history_days"),
            HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
        )
        consumers_config = ConsumptionForecastBuilder._read_deferrable_consumers(
            forecast_cfg.get("deferrable_consumers")
        )
        config_fingerprint = ConsumptionForecastBuilder._build_config_fingerprint(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            consumers_config=consumers_config,
        )
        return (
            total_energy_entity_id,
            training_window_days,
            min_history_days,
            config_fingerprint,
        )

    def _has_matching_forecast_snapshot(
        self,
        *,
        total_energy_entity_id: str | None,
        training_window_days: int,
        min_history_days: int,
        config_fingerprint: str,
    ) -> bool:
        if not isinstance(self._cached_forecast, dict):
            return False

        if not isinstance(self._cached_forecast.get("actualHistory"), list):
            return False

        if self._cached_forecast.get("trainingWindowDays") != training_window_days:
            return False

        if self._cached_forecast.get("requiredHistoryDays") != min_history_days:
            return False

        if self._cached_forecast.get("configFingerprint") != config_fingerprint:
            return False

        status = self._cached_forecast.get("status")
        if total_energy_entity_id is None:
            return status == "not_configured"

        if status == "not_configured":
            return False

        if status == "available":
            return self._cached_forecast.get("model") == HOUSE_FORECAST_MODEL_ID

        return True

    def _has_compatible_forecast_snapshot(
        self,
        *,
        total_energy_entity_id: str | None,
        training_window_days: int,
        min_history_days: int,
        config_fingerprint: str,
        reference_time: datetime | None = None,
    ) -> bool:
        if not self._has_matching_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
        ):
            return False

        if self._cached_forecast is None or self._cached_forecast.get("status") != "available":
            return True

        return self._has_current_hour_forecast(
            self._cached_forecast,
            reference_time=reference_time,
        )

    @staticmethod
    def _has_current_hour_forecast(
        snapshot: dict[str, Any], reference_time: datetime | None = None
    ) -> bool:
        current_hour = snapshot.get("currentHour")
        if not isinstance(current_hour, dict):
            return False

        timestamp = current_hour.get("timestamp")
        if not isinstance(timestamp, str):
            return False

        current_hour_dt = dt_util.parse_datetime(timestamp)
        if current_hour_dt is None:
            return False

        local_snapshot_hour = dt_util.as_local(current_hour_dt).replace(
            minute=0, second=0, microsecond=0
        )
        local_current_hour = (reference_time or dt_util.now()).replace(
            minute=0, second=0, microsecond=0
        )
        return local_snapshot_hour == local_current_hour

    async def get_forecast(self) -> dict:
        request_now = dt_util.now()
        builder = HelmanForecastBuilder(self._hass, self._storage.config)
        result = await builder.build(reference_time=request_now)
        (
            total_energy_entity_id,
            training_window_days,
            min_history_days,
            config_fingerprint,
        ) = self._read_house_forecast_config()
        if self._has_compatible_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
            reference_time=request_now,
        ):
            result["house_consumption"] = self._cached_forecast
        else:
            if total_energy_entity_id is not None:
                await self._async_refresh_forecast(reference_time=request_now)

            if self._has_compatible_forecast_snapshot(
                total_energy_entity_id=total_energy_entity_id,
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                config_fingerprint=config_fingerprint,
                reference_time=request_now,
            ):
                result["house_consumption"] = self._cached_forecast
            else:
                self._cached_forecast = None
                self._invalidate_battery_forecast_cache()
                result["house_consumption"] = ConsumptionForecastBuilder._make_payload(
                    status="not_configured"
                    if total_energy_entity_id is None
                    else "unavailable",
                    training_window_days=training_window_days,
                    min_history_days=min_history_days,
                    config_fingerprint=config_fingerprint,
                )
        result["battery_capacity"] = await self._async_get_battery_forecast(
            solar_forecast=result["solar"],
            house_forecast=result["house_consumption"],
            started_at=request_now,
        )
        return result

    def _read_schedule_control_config(self) -> ScheduleControlConfig | None:
        return read_schedule_control_config(self._storage.config)

    def _load_schedule_document(self) -> ScheduleDocument:
        return schedule_document_from_dict(self._storage.schedule_document)

    async def _save_schedule_document(self, doc: ScheduleDocument) -> None:
        await self._storage.async_save_schedule_document(schedule_document_to_dict(doc))

    def _build_schedule_response(
        self,
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
    ) -> ScheduleResponseDict:
        return {
            "executionEnabled": schedule_document.execution_enabled,
            "slots": [
                slot_to_dict(slot)
                for slot in materialize_schedule_slots(
                    stored_slots=schedule_document.slots,
                    reference_time=reference_time,
                )
            ],
        }

    async def get_schedule(
        self,
        *,
        reference_time: datetime | None = None,
    ) -> ScheduleResponseDict:
        request_now = reference_time or dt_util.now()
        async with self._schedule_lock:
            schedule_document = self._load_schedule_document()
            pruned_slots = prune_expired_slots(
                stored_slots=schedule_document.slots,
                reference_time=request_now,
            )
            pruned_document = ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots=pruned_slots,
            )
            if pruned_document != schedule_document:
                await self._save_schedule_document(pruned_document)
            return self._build_schedule_response(
                schedule_document=pruned_document,
                reference_time=request_now,
            )

    async def set_schedule(
        self,
        *,
        slots: Sequence[ScheduleSlot],
        reference_time: datetime | None = None,
    ) -> None:
        request_now = reference_time or dt_util.now()
        async with self._schedule_lock:
            schedule_document = self._load_schedule_document()
            pruned_slots = prune_expired_slots(
                stored_slots=schedule_document.slots,
                reference_time=request_now,
            )
            validate_slot_patch_request(
                slots=slots,
                reference_time=request_now,
                battery_soc_bounds=self._read_battery_soc_bounds(),
            )
            updated_document = ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots=apply_slot_patches(
                    stored_slots=pruned_slots,
                    slot_patches=slots,
                ),
            )
            if updated_document != schedule_document:
                await self._save_schedule_document(updated_document)

    def invalidate_forecast(self) -> None:
        """Trigger a background house forecast refresh."""
        self._cached_forecast = None
        self._invalidate_battery_forecast_cache()
        self._hass.async_create_task(self._async_refresh_forecast())

    async def _async_refresh_forecast(
        self, reference_time: datetime | None = None
    ) -> None:
        """Build a new house forecast snapshot, cache it, and persist it."""
        try:
            builder = ConsumptionForecastBuilder(self._hass, self._storage.config)
            snapshot = await builder.build(reference_time=reference_time)
            self._cached_forecast = snapshot
            self._invalidate_battery_forecast_cache()
            await self._storage.async_save_snapshot(snapshot)
        except Exception:
            _LOGGER.exception("Error refreshing house consumption forecast")

    async def _async_get_battery_forecast(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
    ) -> dict[str, Any]:
        return await self._build_battery_forecast(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
        )

    async def _build_battery_forecast(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
    ) -> dict[str, Any]:
        return await BatteryCapacityForecastBuilder(
            self._hass,
            self._storage.config,
        ).build(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
        )

    def _invalidate_battery_forecast_cache(self) -> None:
        return

    def _start_forecast_refresh(self) -> None:
        """Start the hourly house forecast refresh schedule."""
        if self._unsub_forecast_refresh is not None:
            return

        @callback
        def _on_forecast_interval(_now: datetime) -> None:
            self._hass.async_create_task(self._async_refresh_forecast())

        self._unsub_forecast_refresh = async_track_time_change(
            self._hass, _on_forecast_interval, minute=0, second=0
        )

    def _stop_forecast_refresh(self) -> None:
        """Stop the hourly house forecast refresh interval."""
        if self._unsub_forecast_refresh is not None:
            self._unsub_forecast_refresh()
            self._unsub_forecast_refresh = None

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
    def _collect_virtual_sensor_ids(tree: dict) -> set[str]:
        """Collect powerSensorId values for unmeasured virtual nodes (computed by tick)."""
        ids: set[str] = set()

        def walk(nodes: list) -> None:
            for node in nodes:
                if node.get("isUnmeasured") and node.get("powerSensorId"):
                    ids.add(node["powerSensorId"])
                walk(node.get("children", []))

        walk(tree.get("consumers", []))
        return ids

    @staticmethod
    def _collect_unmeasured_entity_id_map(tree: dict) -> dict[str, str]:
        """Return {parent_node_id: unmeasured_entity_id} for nodes with unmeasured children."""
        result: dict[str, str] = {}

        def walk(nodes: list) -> None:
            for node in nodes:
                if not node.get("isVirtual"):
                    for child in node.get("children", []):
                        if child.get("isUnmeasured") and child.get("powerSensorId"):
                            result[node["id"]] = child["powerSensorId"]
                walk(node.get("children", []))

        walk(tree.get("consumers", []))
        return result

    def _init_buffers(self, tree: dict) -> None:
        """Initialize empty rolling deques for all tracked sensors."""
        history_buckets: int = self._storage.config.get("history_buckets", 60)

        self._virtual_sensor_ids = self._collect_virtual_sensor_ids(tree)
        self._virtual_sensor_ids.add(CONSUMPTION_TOTAL_ENTITY_ID)
        self._virtual_sensor_ids.add(PRODUCTION_TOTAL_ENTITY_ID)

        self._unmeasured_entity_id_map = self._collect_unmeasured_entity_id_map(tree)

        # Create deques for all power sensors (real + virtual unmeasured) plus virtual totals
        self._power_history = {
            eid: deque(maxlen=history_buckets) for eid in self._power_sensor_ids
        }
        self._power_history[CONSUMPTION_TOTAL_ENTITY_ID] = deque(maxlen=history_buckets)
        self._power_history[PRODUCTION_TOTAL_ENTITY_ID] = deque(maxlen=history_buckets)
        # Add deques for source ratio sensors so their history is included in get_history()
        for sensor in self._source_ratio_sensors.values():
            self._power_history[sensor.entity_id] = deque(maxlen=history_buckets)

    def _start_tick(self) -> None:
        """Start the periodic tick using HA's time-interval tracker."""
        if self._unsub_tick is not None:
            return
        bucket_duration: int = self._storage.config.get("history_bucket_duration", 1)
        self._unsub_tick = async_track_time_interval(
            self._hass,
            self._tick,
            timedelta(seconds=bucket_duration),
        )

    def _stop_tick(self) -> None:
        """Stop the periodic tick."""
        if self._unsub_tick is not None:
            self._unsub_tick()
            self._unsub_tick = None

    @callback
    def _tick(self, now: datetime) -> None:
        """Periodic snapshot: read sensors, compute ratios, push derived sensor values."""
        if self._cached_tree is None:
            return

        # Step 1: Read all real (non-virtual) power sensors from hass.states
        for entity_id, dq in self._power_history.items():
            if entity_id not in self._virtual_sensor_ids:
                dq.append(self._read_power(entity_id, "default"))

        # Step 2: Compute virtual sensor values and record into _power_history
        # Unmeasured powers (one per qualifying parent node)
        unmeasured_map = self._compute_all_unmeasured_powers()
        for node_id, watts in unmeasured_map.items():
            entity_id = self._unmeasured_entity_id_map.get(node_id)
            if entity_id and entity_id in self._power_history:
                self._power_history[entity_id].append(watts)
            sensor = self._unmeasured_sensors.get(node_id)
            if sensor is not None:
                sensor.update_value(watts)

        # Total power (consumption side)
        total = self._compute_consumption_total()
        if CONSUMPTION_TOTAL_ENTITY_ID in self._power_history:
            self._power_history[CONSUMPTION_TOTAL_ENTITY_ID].append(total)
        if self._consumption_total_sensor is not None:
            self._consumption_total_sensor.update_value(total)

        # Production total (source side)
        production = self._compute_production_total()
        if PRODUCTION_TOTAL_ENTITY_ID in self._power_history:
            self._power_history[PRODUCTION_TOTAL_ENTITY_ID].append(production)
        if self._production_total_sensor is not None:
            self._production_total_sensor.update_value(production)

        # Step 3: Compute global source ratios and update ratio sensors
        if self._source_ratio_sensors:
            normalized = {
                src: self._normalize_source_value(
                    self._power_history[src][-1] if self._power_history.get(src) else 0.0,
                    self._source_value_types.get(src, "default"),
                )
                for src in self._source_sensor_ids
                if src in self._power_history
            }
            total_source = sum(normalized.values())
            for src_eid, sensor in self._source_ratio_sensors.items():
                ratio_pct = (normalized.get(src_eid, 0.0) / total_source * 100.0) if total_source > 0 else 0.0
                sensor.update_value(ratio_pct)
                if sensor.entity_id in self._power_history:
                    self._power_history[sensor.entity_id].append(ratio_pct)

        # Step 4: Battery ETAs (separate sensors for charging and discharging)
        if self._battery_time_to_full is not None or self._battery_time_to_empty is not None:
            battery_cfg = self._storage.config.get("power_devices", {}).get("battery", {})
            sensor_id = battery_cfg.get("entities", {}).get("power")
            hist = list(self._power_history.get(sensor_id, [])) if sensor_id else []

            pos_values = [v for v in hist if v > 1]
            neg_values = [abs(v) for v in hist if v < -1]
            charging_avg = sum(pos_values) / len(pos_values) if pos_values else 0.0
            discharging_avg = sum(neg_values) / len(neg_values) if neg_values else 0.0

            if self._battery_time_to_full is not None:
                minutes, target_time, target_soc = (
                    self._compute_charging_eta(charging_avg) if charging_avg > 0
                    else (None, "", None)
                )
                self._battery_time_to_full.update_value(minutes, target_time, target_soc)

            if self._battery_time_to_empty is not None:
                minutes, target_time, target_soc = (
                    self._compute_discharging_eta(discharging_avg) if discharging_avg > 0
                    else (None, "", None)
                )
                self._battery_time_to_empty.update_value(minutes, target_time, target_soc)

    @staticmethod
    def _normalize_source_value(raw: float, value_type: str) -> float:
        """Convert a raw source sensor reading to an absolute positive power contribution."""
        if value_type == "negative":
            return abs(min(0.0, raw))
        if value_type == "positive":
            return max(0.0, raw)
        # "default" — trust the raw value; guard against negatives
        return max(0.0, raw)

    def get_history(self) -> dict:
        """Return a pure dict copy of the in-memory rolling buffer. Zero computation."""
        buckets: int = self._storage.config.get("history_buckets", 60)
        bucket_duration: int = self._storage.config.get("history_bucket_duration", 1)
        return {
            "buckets": buckets,
            "bucket_duration": bucket_duration,
            "entity_history": {eid: list(dq) for eid, dq in self._power_history.items()},
        }

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

    def _read_battery_state(self):
        entity_config = read_battery_entity_config(self._storage.config)
        if entity_config is None:
            return None
        return read_battery_live_state(self._hass, entity_config)

    def _read_battery_soc_bounds(self):
        bounds_config = read_battery_soc_bounds_config(self._storage.config)
        if bounds_config is None:
            return None
        return read_battery_soc_bounds(self._hass, bounds_config)

    def _compute_charging_eta(
        self, charging_avg_w: float
    ) -> tuple[float | None, str, int | None]:
        """Compute time to reach max_soc at the given average charging rate."""
        state = self._read_battery_state()
        if state is None:
            return None, "", None
        to_full_kwh = state.max_energy_kwh - state.current_remaining_energy_kwh
        if to_full_kwh <= 0:
            return None, "", None
        hours = (to_full_kwh * 1000) / charging_avg_w
        minutes = hours * 60
        target = datetime.now(tz=timezone.utc) + timedelta(hours=hours)
        return minutes, target.isoformat(), round(state.max_soc)

    def _compute_discharging_eta(
        self, discharging_avg_w: float
    ) -> tuple[float | None, str, int | None]:
        """Compute time to reach min_soc at the given average discharging rate."""
        state = self._read_battery_state()
        if state is None:
            return None, "", None
        usable_kwh = state.current_remaining_energy_kwh - state.min_energy_kwh
        if usable_kwh <= 0:
            return None, "", None
        hours = (usable_kwh * 1000) / discharging_avg_w
        minutes = hours * 60
        target = datetime.now(tz=timezone.utc) + timedelta(hours=hours)
        return minutes, target.isoformat(), round(state.min_soc)

    def _compute_consumption_total(self) -> float:
        """Sum consumer-side top-level node powers (house + battery charging + grid export)."""
        if self._cached_tree is None:
            return 0.0
        total = 0.0
        for node in self._cached_tree.get("consumers", []):
            if node.get("isVirtual"):
                continue
            total += self._read_power(
                node.get("powerSensorId"), node.get("valueType", "default")
            )
        return total

    def _compute_production_total(self) -> float:
        """Sum source-side top-level node powers (solar + battery_discharging + grid_import)."""
        if self._cached_tree is None:
            return 0.0
        total = 0.0
        for node in self._cached_tree.get("sources", []):
            if node.get("isVirtual"):
                continue
            raw = self._read_power(node.get("powerSensorId"), "default")
            total += self._normalize_source_value(raw, node.get("valueType", "default"))
        return total

    def _compute_all_unmeasured_powers(self) -> dict[str, float]:
        """Return {node_id → unmeasured_watts} for every parent that has an unmeasured node."""
        result: dict[str, float] = {}
        self._traverse_for_unmeasured(self._cached_tree.get("consumers", []), result)
        return result

    def _traverse_for_unmeasured(self, nodes: list, result: dict) -> None:
        for node in nodes:
            children = node.get("children", [])
            if children and not node.get("isVirtual"):
                has_unmeasured = any(c.get("isUnmeasured") for c in children)
                if has_unmeasured:
                    parent_power = self._read_power(
                        node.get("powerSensorId"), node.get("valueType", "default")
                    )
                    measured_sum = sum(
                        self._read_power(c.get("powerSensorId"), c.get("valueType", "default"))
                        for c in children
                        if not c.get("isVirtual")
                        and not c.get("isUnmeasured")
                        and c.get("powerSensorId")
                    )
                    result[node["id"]] = max(0.0, parent_power - measured_sum)
            self._traverse_for_unmeasured(children, result)

    async def async_unload(self) -> None:
        """Clean up event listeners and stop the tick."""
        self._stop_tick()
        self._stop_forecast_refresh()
        self._invalidate_battery_forecast_cache()

        self._battery_time_to_full = None
        self._battery_time_to_empty = None
        self._unmeasured_sensors = {}
        self._consumption_total_sensor = None
        self._production_total_sensor = None
        self._source_ratio_sensors = {}
        self._async_add_entities = None
        self._unmeasured_sensor_factory = None
        self._entry = None
        self._removing_entity_ids.clear()
        self._power_history.clear()

        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()

        if self._unsub_energy is not None:
            self._unsub_energy()
            self._unsub_energy = None
