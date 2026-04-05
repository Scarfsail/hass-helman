from __future__ import annotations

from copy import deepcopy
import asyncio
import logging
from dataclasses import dataclass
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Callable, Sequence

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import (
    async_track_time_change,
    async_track_time_interval,
)

from homeassistant.util import dt as dt_util

from .appliances import (
    ApplianceProjectionPlan,
    ApplianceMetadataResponseDict,
    ApplianceProjectionsResponseDict,
    AppliancesRuntimeRegistry,
    build_adjusted_house_forecast,
    build_appliance_projection_plan,
    build_appliance_projections_response,
    build_appliances_response,
    build_appliances_runtime_registry,
    build_projection_input_bundle,
    build_empty_appliance_projections_response,
)
from .battery_capacity_forecast_builder import BatteryCapacityForecastBuilder
from .battery_forecast_response import build_battery_forecast_response
from .battery_state import (
    describe_battery_entity_config_issue,
    describe_battery_live_state_issue,
    read_battery_entity_config,
    read_battery_live_state,
    read_battery_soc_bounds,
    read_battery_soc_bounds_config,
)
from .const import (
    BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS,
    CONSUMPTION_TOTAL_ENTITY_ID,
    DEFAULT_FORECAST_DAYS,
    DEFAULT_FORECAST_GRANULARITY_MINUTES,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
    PRODUCTION_TOTAL_ENTITY_ID,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
)
from .consumption_forecast_builder import ConsumptionForecastBuilder
from .forecast_aggregation import get_forecast_resolution
from .forecast_builder import HelmanForecastBuilder
from .forecast_request import ensure_supported_forecast_request
from .grid_flow_forecast_builder import build_grid_flow_forecast_snapshot
from .grid_flow_forecast_response import build_grid_flow_forecast_response
from .grid_price_forecast_response import build_grid_price_forecast_response
from .house_forecast_response import build_house_forecast_response
from .point_forecast_response import build_solar_forecast_response
from .recorder_hourly_series import get_local_current_slot_start
from .scheduling.schedule import (
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleError,
    ScheduleResponseDict,
    ScheduleSlot,
    apply_slot_patches,
    build_horizon_start,
    describe_schedule_control_config_issue,
    format_slot_id,
    materialize_schedule_slots,
    prune_expired_slots,
    normalize_schedule_document_for_registry,
    normalize_slot_patch_request,
    read_schedule_control_config,
    schedule_document_from_dict,
    schedule_document_to_dict,
    slot_to_dict,
    validate_slot_patch_request,
)
from .scheduling.runtime_status import (
    ScheduleExecutionStatus,
    schedule_execution_status_to_dict,
)
from .scheduling.action_resolution import resolve_executed_schedule_action
from .scheduling.schedule_executor import (
    ScheduleExecutor,
    ScheduleExecutorDependencies,
)
from .storage import HelmanStorage
from .tree_builder import HelmanTreeBuilder

_LOGGER = logging.getLogger(__name__)
_BATTERY_FORECAST_CACHE_SOC_TOLERANCE = 1.0
_BATTERY_FORECAST_CACHE_ENERGY_TOLERANCE_KWH = 0.1

if TYPE_CHECKING:
    from .scheduling.forecast_overlay import ScheduleForecastOverlay


def _merge_grid_forecast_responses(
    *,
    grid_flow_response: dict[str, Any],
    grid_price_response: dict[str, Any],
) -> dict[str, Any]:
    merged_response = deepcopy(grid_flow_response)
    merged_response["exportPriceUnit"] = deepcopy(
        grid_price_response.get("exportPriceUnit")
    )
    merged_response["currentExportPrice"] = deepcopy(
        grid_price_response.get("currentExportPrice")
    )
    merged_response["exportPricePoints"] = deepcopy(
        grid_price_response.get("exportPricePoints", [])
    )
    merged_response["importPriceUnit"] = deepcopy(
        grid_price_response.get("importPriceUnit")
    )
    merged_response["currentImportPrice"] = deepcopy(
        grid_price_response.get("currentImportPrice")
    )
    merged_response["importPricePoints"] = deepcopy(
        grid_price_response.get("importPricePoints", [])
    )
    return merged_response


@dataclass(frozen=True)
class _ApplianceForecastPipelineSnapshot:
    started_at: datetime
    original_house_forecast: dict[str, Any]
    adjusted_house_forecast: dict[str, Any]
    projection_plan: ApplianceProjectionPlan
    battery_forecast: dict[str, Any]


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
        self._active_config: dict[str, Any] = deepcopy(storage.config)
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
        self._cached_battery_forecast: dict | None = None
        self._cached_battery_forecast_expires_at: datetime | None = None
        self._cached_battery_forecast_house_generated_at: str | None = None
        self._cached_battery_forecast_solar_signature: tuple[Any, ...] | None = None
        self._cached_battery_forecast_schedule_execution_enabled: bool | None = None
        self._cached_battery_forecast_schedule_signature: (
            tuple[tuple[str, str, int | None], ...] | None
        ) = None
        self._cached_battery_forecast_schedule_effective_signature: (
            tuple[str, str, int | None, str, str] | None
        ) = None
        self._cached_appliance_forecast_pipeline: (
            _ApplianceForecastPipelineSnapshot | None
        ) = None
        self._cached_appliance_projection_plan: ApplianceProjectionPlan | None = None
        self._cached_appliance_projection_expires_at: datetime | None = None
        self._cached_appliance_projection_started_at: datetime | None = None
        self._cached_appliance_projection_house_generated_at: str | None = None
        self._cached_appliance_projection_solar_signature: tuple[Any, ...] | None = None
        self._cached_appliance_projection_schedule_signature: tuple[
            tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
            ...,
        ] | None = None
        self._unsub_forecast_refresh: Callable[[], None] | None = None
        self._schedule_lock = asyncio.Lock()
        self._schedule_execution_lock = asyncio.Lock()
        self._schedule_executor = ScheduleExecutor(
            hass,
            ScheduleExecutorDependencies(
                schedule_lock=self._schedule_lock,
                load_schedule_document=self._load_schedule_document,
                save_schedule_document=self._save_schedule_document,
                read_schedule_control_config=self._read_schedule_executor_control_config,
                read_battery_state=self._read_schedule_executor_battery_state,
                read_appliances_registry=lambda: self._appliances_registry,
            ),
        )
        self._appliances_registry = AppliancesRuntimeRegistry()
        self._last_schedule_control_config_issue: str | None = None
        self._last_schedule_battery_state_issue: str | None = None
        # Mapping: parent_node_id → unmeasured_entity_id (e.g. "house" → "sensor.helman_house_unmeasured_power")
        self._unmeasured_entity_id_map: dict[str, str] = {}
        # Entity IDs whose values are computed by the tick (not read from hass.states)
        self._virtual_sensor_ids: set[str] = set()

    @property
    def config(self) -> dict:
        return self._active_config

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
        self._active_config = deepcopy(self._storage.config)
        self._appliances_registry = build_appliances_runtime_registry(
            self._active_config,
            logger=_LOGGER,
        )
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

        await self._async_normalize_schedule_document()
        if self._load_schedule_document().execution_enabled:
            await self._async_reconcile_schedule_execution_if_enabled(
                reason="startup",
                reference_time=dt_util.now(),
            )
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
            builder = HelmanTreeBuilder(self._hass, self._active_config)
            self._cached_tree = await builder.build()
        return self._cached_tree

    def _read_house_forecast_config(self) -> tuple[str | None, int, int, str]:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._active_config.get("power_devices")
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

        if (
            self._cached_forecast.get("sourceGranularityMinutes")
            != FORECAST_CANONICAL_GRANULARITY_MINUTES
        ):
            return False

        if self._cached_forecast.get("forecastDaysAvailable") != MAX_FORECAST_DAYS:
            return False

        if (
            self._cached_forecast.get("alignmentPaddingSlots")
            != ConsumptionForecastBuilder._MAX_ALIGNMENT_PADDING_SLOTS
        ):
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

        return self._has_current_slot_forecast(
            self._cached_forecast,
            reference_time=reference_time,
        )

    @staticmethod
    def _has_current_slot_forecast(
        snapshot: dict[str, Any], reference_time: datetime | None = None
    ) -> bool:
        current_slot = snapshot.get("currentSlot")
        if not isinstance(current_slot, dict):
            return False

        timestamp = current_slot.get("timestamp")
        if not isinstance(timestamp, str):
            return False

        current_slot_dt = dt_util.parse_datetime(timestamp)
        if current_slot_dt is None:
            return False

        local_snapshot_slot = get_local_current_slot_start(
            current_slot_dt,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        local_current_slot = get_local_current_slot_start(
            reference_time or dt_util.now(),
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        return local_snapshot_slot == local_current_slot

    async def get_forecast(
        self,
        *,
        granularity: int = DEFAULT_FORECAST_GRANULARITY_MINUTES,
        forecast_days: int = DEFAULT_FORECAST_DAYS,
    ) -> dict:
        """Return the current forecast response.

        Increment 2 makes schedule state part of battery forecast dependencies
        while keeping the external battery response unchanged.
        """
        ensure_supported_forecast_request(
            granularity=granularity,
            forecast_days=forecast_days,
        )
        request_now = dt_util.now()
        builder = HelmanForecastBuilder(self._hass, self._active_config)
        raw_result = await builder.build(reference_time=request_now)
        canonical_solar_forecast = build_solar_forecast_response(
            raw_result["solar"],
            granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days=MAX_FORECAST_DAYS,
        )
        result = {
            "solar": build_solar_forecast_response(
                raw_result["solar"],
                granularity=granularity,
                forecast_days=forecast_days,
            ),
        }
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
            canonical_house_forecast = self._cached_forecast
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
                canonical_house_forecast = self._cached_forecast
            else:
                self._cached_forecast = None
                self._invalidate_battery_forecast_cache()
                canonical_house_forecast = ConsumptionForecastBuilder._make_payload(
                    status="not_configured"
                    if total_energy_entity_id is None
                    else "unavailable",
                    training_window_days=training_window_days,
                    min_history_days=min_history_days,
                    config_fingerprint=config_fingerprint,
                    resolution=get_forecast_resolution(
                        FORECAST_CANONICAL_GRANULARITY_MINUTES
                    ),
                    horizon_hours=MAX_FORECAST_DAYS * 24,
                    source_granularity_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
                    forecast_days_available=MAX_FORECAST_DAYS,
                    alignment_padding_slots=ConsumptionForecastBuilder._MAX_ALIGNMENT_PADDING_SLOTS,
                )
        pipeline = await self._async_get_appliance_forecast_pipeline(
            solar_forecast=canonical_solar_forecast,
            house_forecast=canonical_house_forecast,
            started_at=request_now,
        )
        result["house_consumption"] = build_house_forecast_response(
            pipeline.adjusted_house_forecast,
            granularity=granularity,
            forecast_days=forecast_days,
        )
        canonical_battery_forecast = pipeline.battery_forecast
        grid_price_response = build_grid_price_forecast_response(
            raw_result["grid"],
            granularity=granularity,
            forecast_days=forecast_days,
        )
        canonical_grid_flow_forecast = build_grid_flow_forecast_snapshot(
            canonical_battery_forecast
        )
        result["grid"] = _merge_grid_forecast_responses(
            grid_flow_response=build_grid_flow_forecast_response(
                canonical_grid_flow_forecast,
                granularity=granularity,
                forecast_days=forecast_days,
            ),
            grid_price_response=grid_price_response,
        )
        result["battery_capacity"] = build_battery_forecast_response(
            canonical_battery_forecast,
            granularity=granularity,
            forecast_days=forecast_days,
        )
        return result

    async def _async_get_canonical_house_forecast(
        self,
        *,
        reference_time: datetime,
    ) -> dict[str, Any] | None:
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
            reference_time=reference_time,
        ):
            return self._cached_forecast

        if total_energy_entity_id is not None:
            await self._async_refresh_forecast(reference_time=reference_time)

        if self._has_compatible_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
            reference_time=reference_time,
        ):
            return self._cached_forecast

        self._cached_forecast = None
        self._invalidate_battery_forecast_cache()
        return ConsumptionForecastBuilder._make_payload(
            status="not_configured"
            if total_energy_entity_id is None
            else "unavailable",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
            resolution=get_forecast_resolution(
                FORECAST_CANONICAL_GRANULARITY_MINUTES
            ),
            horizon_hours=MAX_FORECAST_DAYS * 24,
            source_granularity_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days_available=MAX_FORECAST_DAYS,
            alignment_padding_slots=ConsumptionForecastBuilder._MAX_ALIGNMENT_PADDING_SLOTS,
        )

    def _read_schedule_control_config(self) -> ScheduleControlConfig | None:
        return read_schedule_control_config(self._active_config)

    def _read_schedule_executor_control_config(self) -> ScheduleControlConfig | None:
        control_config = self._read_schedule_control_config()
        if control_config is not None:
            self._last_schedule_control_config_issue = None
            return control_config

        issue = describe_schedule_control_config_issue(self._active_config)
        if issue is None:
            issue = "required scheduler control config values are unavailable"
        if self._last_schedule_control_config_issue != issue:
            _LOGGER.warning("Schedule execution control config unavailable: %s", issue)
            self._last_schedule_control_config_issue = issue
        return None

    async def _async_normalize_schedule_document(self) -> None:
        raw_document = self._storage.schedule_document
        if raw_document is None:
            return

        try:
            schedule_document = schedule_document_from_dict(raw_document)
            schedule_document = normalize_schedule_document_for_registry(
                schedule_document,
                appliances_registry=self._appliances_registry,
            )
        except ScheduleError as err:
            _LOGGER.warning(
                "Resetting persisted schedule data because it is invalid or "
                "does not match the configured slot duration: %s",
                err,
            )
            await self._save_schedule_document(ScheduleDocument())
            return

        if schedule_document_to_dict(schedule_document) != raw_document:
            await self._save_schedule_document(schedule_document)

    def _load_schedule_document(self) -> ScheduleDocument:
        return schedule_document_from_dict(self._storage.schedule_document)

    async def _save_schedule_document(self, doc: ScheduleDocument) -> None:
        await self._storage.async_save_schedule_document(schedule_document_to_dict(doc))

    async def _load_pruned_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        loaded_document = self._load_schedule_document()
        schedule_document = normalize_schedule_document_for_registry(
            loaded_document,
            appliances_registry=self._appliances_registry,
        )
        pruned_slots = prune_expired_slots(
            stored_slots=schedule_document.slots,
            reference_time=reference_time,
        )
        pruned_document = ScheduleDocument(
            execution_enabled=schedule_document.execution_enabled,
            slots=pruned_slots,
        )
        if pruned_document != loaded_document:
            await self._save_schedule_document(pruned_document)
        return pruned_document

    def _build_schedule_response(
        self,
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
        execution_status: ScheduleExecutionStatus | None = None,
    ) -> ScheduleResponseDict:
        response: ScheduleResponseDict = {
            "executionEnabled": schedule_document.execution_enabled,
            "slots": [
                slot_to_dict(slot)
                for slot in materialize_schedule_slots(
                    stored_slots=schedule_document.slots,
                    reference_time=reference_time,
                )
            ],
        }
        runtime = (
            None
            if execution_status is None
            else schedule_execution_status_to_dict(execution_status)
        )
        if runtime is not None:
            response["runtime"] = runtime
        return response

    async def get_schedule(
        self,
        *,
        reference_time: datetime | None = None,
    ) -> ScheduleResponseDict:
        request_now = reference_time or dt_util.now()
        async with self._schedule_lock:
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=request_now
            )
            execution_status = None
            if schedule_document.execution_enabled:
                current_slot_id = format_slot_id(build_horizon_start(request_now))
                latest_execution_status = self._schedule_executor.get_execution_status()
                if latest_execution_status.active_slot_id == current_slot_id:
                    execution_status = latest_execution_status
            return self._build_schedule_response(
                schedule_document=schedule_document,
                reference_time=request_now,
                execution_status=execution_status,
            )

    async def get_appliances(self) -> ApplianceMetadataResponseDict:
        return build_appliances_response(self._appliances_registry)

    async def get_appliance_projections(self) -> ApplianceProjectionsResponseDict:
        request_now = dt_util.now()
        raw_result = await HelmanForecastBuilder(
            self._hass,
            self._active_config,
        ).build(reference_time=request_now)
        canonical_solar_forecast = build_solar_forecast_response(
            raw_result["solar"],
            granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days=MAX_FORECAST_DAYS,
        )
        canonical_house_forecast = await self._async_get_canonical_house_forecast(
            reference_time=request_now
        )
        if canonical_house_forecast is None:
            return build_empty_appliance_projections_response(
                generated_at=request_now.isoformat()
            )

        plan = await self._async_get_appliance_projection_plan(
            solar_forecast=canonical_solar_forecast,
            house_forecast=canonical_house_forecast,
            started_at=request_now,
        )
        if not plan.appliances_by_id:
            return build_empty_appliance_projections_response(generated_at=plan.generated_at)
        return build_appliance_projections_response(
            plan=plan,
            registry=self._appliances_registry,
            hass=self._hass,
        )

    async def set_schedule(
        self,
        *,
        slots: Sequence[ScheduleSlot],
        reference_time: datetime | None = None,
    ) -> None:
        request_now = reference_time or dt_util.now()
        document_changed = False
        async with self._schedule_lock:
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=request_now
            )
            normalized_slots = normalize_slot_patch_request(
                slots=slots,
                reference_time=request_now,
                battery_soc_bounds=self._read_battery_soc_bounds(),
                appliances_registry=self._appliances_registry,
            )
            updated_document = ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots=apply_slot_patches(
                    stored_slots=schedule_document.slots,
                    slot_patches=normalized_slots,
                ),
            )
            if updated_document != schedule_document:
                await self._save_schedule_document(updated_document)
                document_changed = True

        if document_changed:
            self._invalidate_battery_forecast_cache()
            await self._async_reconcile_schedule_execution_if_enabled(
                reason="schedule_updated",
                reference_time=request_now,
            )

    async def set_schedule_execution(
        self,
        *,
        enabled: bool,
        reference_time: datetime | None = None,
    ) -> bool:
        request_now = reference_time or dt_util.now()

        async with self._schedule_execution_lock:
            async with self._schedule_lock:
                current_document = await self._load_pruned_schedule_document_locked(
                    reference_time=request_now
                )
                was_enabled = current_document.execution_enabled

                if enabled and not was_enabled:
                    await self._save_schedule_document(
                        ScheduleDocument(
                            execution_enabled=True,
                            slots=current_document.slots,
                        )
                    )
                    self._invalidate_battery_forecast_cache()

            if enabled:
                await self._schedule_executor.async_start()
                try:
                    await self._schedule_executor.async_reconcile(
                        reason="enable_request",
                        reference_time=request_now,
                    )
                except ScheduleError as err:
                    if not was_enabled:
                        _LOGGER.warning(
                            "Failed to enable schedule execution: %s (%s); rolling back persisted execution flag",
                            err,
                            err.code,
                        )
                    else:
                        _LOGGER.warning(
                            "Failed to reconcile already-enabled schedule execution: %s (%s)",
                            err,
                            err.code,
                        )
                    if not was_enabled:
                        async with self._schedule_lock:
                            latest_document = self._load_schedule_document()
                            if latest_document.execution_enabled:
                                await self._save_schedule_document(
                                    ScheduleDocument(
                                        execution_enabled=False,
                                        slots=latest_document.slots,
                                    )
                                )
                                self._invalidate_battery_forecast_cache()
                        await self._schedule_executor.async_stop()
                    raise
                return True

            if not was_enabled:
                await self._schedule_executor.async_stop()
                return False

            try:
                await self._schedule_executor.async_restore_normal(
                    reason="disable_request"
                )
            except ScheduleError as err:
                _LOGGER.warning(
                    "Failed to disable schedule execution while restoring normal mode: %s (%s); keeping execution enabled",
                    err,
                    err.code,
                )
                self._schedule_executor.clear_appliance_memories()
                await self._schedule_executor.async_start()
                await self._schedule_executor.async_reconcile_safely(
                    reason="disable_restore_failed",
                    reference_time=request_now,
                )
                raise
            await self._schedule_executor.async_stop()

            async with self._schedule_lock:
                latest_document = await self._load_pruned_schedule_document_locked(
                    reference_time=request_now
                )
                if latest_document.execution_enabled:
                    await self._save_schedule_document(
                        ScheduleDocument(
                            execution_enabled=False,
                            slots=latest_document.slots,
                        )
                    )
                    self._invalidate_battery_forecast_cache()

            return False

    async def _async_reconcile_schedule_execution_if_enabled(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        request_now = reference_time or dt_util.now()
        async with self._schedule_execution_lock:
            async with self._schedule_lock:
                execution_enabled = (
                    await self._load_pruned_schedule_document_locked(
                        reference_time=request_now
                    )
                ).execution_enabled

            if not execution_enabled:
                await self._schedule_executor.async_stop()
                return

            await self._schedule_executor.async_start()
            await self._schedule_executor.async_reconcile_safely(
                reason=reason,
                reference_time=request_now,
            )

    async def async_handle_config_saved(self) -> None:
        self.invalidate_tree()
        self.invalidate_forecast()
        self._schedule_executor.reset_runtime()
        await self._async_reconcile_schedule_execution_if_enabled(
            reason="config_saved",
            reference_time=dt_util.now(),
        )

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
            builder = ConsumptionForecastBuilder(self._hass, self._active_config)
            snapshot = await builder.build(
                reference_time=reference_time,
                forecast_days=MAX_FORECAST_DAYS,
                padding_slots=ConsumptionForecastBuilder._MAX_ALIGNMENT_PADDING_SLOTS,
            )
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
        pipeline = await self._async_get_appliance_forecast_pipeline(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
        )
        return pipeline.battery_forecast

    async def _async_get_appliance_forecast_pipeline(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
    ) -> _ApplianceForecastPipelineSnapshot:
        async with self._schedule_lock:
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=started_at
            )
        forecast_schedule_document = self._build_battery_forecast_schedule_document(
            schedule_document=schedule_document
        )
        schedule_execution_enabled = forecast_schedule_document.execution_enabled
        schedule_signature = (
            self._build_battery_forecast_schedule_signature(forecast_schedule_document)
            if schedule_execution_enabled
            else ()
        )
        projection_schedule_document = (
            schedule_document if schedule_execution_enabled else ScheduleDocument()
        )
        appliance_schedule_signature = (
            self._build_appliance_projection_schedule_signature(
                projection_schedule_document
            )
        )
        schedule_effective_signature = (
            self._build_battery_forecast_schedule_effective_signature(
                schedule_document=forecast_schedule_document,
                reference_time=started_at,
            )
        )
        if self._has_valid_battery_forecast_cache(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
            schedule_execution_enabled=schedule_execution_enabled,
            schedule_signature=schedule_signature,
            appliance_schedule_signature=appliance_schedule_signature,
            schedule_effective_signature=schedule_effective_signature,
        ):
            if self._cached_appliance_forecast_pipeline is None:
                raise RuntimeError("Forecast pipeline cache is missing shared snapshot")
            return self._cached_appliance_forecast_pipeline

        schedule_overlay = None
        if schedule_execution_enabled:
            schedule_overlay = self._build_battery_forecast_schedule_overlay(
                schedule_document=forecast_schedule_document,
                reference_time=started_at,
            )
        generated_at = started_at.isoformat()
        input_bundle = build_projection_input_bundle(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            reference_time=started_at,
        )
        if input_bundle is None:
            projection_plan = ApplianceProjectionPlan(
                generated_at=generated_at,
                appliances_by_id={},
                demand_points=(),
            )
        else:
            projection_plan = build_appliance_projection_plan(
                generated_at=generated_at,
                registry=self._appliances_registry,
                schedule_document=projection_schedule_document,
                inputs=input_bundle,
                hass=self._hass,
            )
        adjusted_house_forecast = build_adjusted_house_forecast(
            house_forecast=house_forecast,
            demand_points=projection_plan.demand_points,
        )
        forecast = await self._build_battery_forecast(
            solar_forecast=solar_forecast,
            house_forecast=adjusted_house_forecast,
            started_at=started_at,
            forecast_days=MAX_FORECAST_DAYS,
            schedule_overlay=schedule_overlay,
        )
        pipeline = _ApplianceForecastPipelineSnapshot(
            started_at=started_at,
            original_house_forecast=deepcopy(house_forecast),
            adjusted_house_forecast=adjusted_house_forecast,
            projection_plan=projection_plan,
            battery_forecast=forecast,
        )
        self._store_battery_forecast_cache(
            pipeline=pipeline,
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
            schedule_execution_enabled=schedule_execution_enabled,
            schedule_signature=schedule_signature,
            appliance_schedule_signature=appliance_schedule_signature,
            schedule_effective_signature=schedule_effective_signature,
        )
        return pipeline

    async def _async_get_appliance_projection_plan(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
    ) -> ApplianceProjectionPlan:
        pipeline = await self._async_get_appliance_forecast_pipeline(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
        )
        return pipeline.projection_plan

    async def _build_battery_forecast(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        forecast_days: int,
        schedule_overlay: ScheduleForecastOverlay | None = None,
    ) -> dict[str, Any]:
        return await BatteryCapacityForecastBuilder(
            self._hass,
            self._active_config,
        ).build(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
            forecast_days=forecast_days,
            schedule_overlay=schedule_overlay,
        )

    @staticmethod
    def _build_battery_forecast_schedule_signature(
        schedule_document: ScheduleDocument,
    ) -> tuple[tuple[str, str, int | None], ...]:
        return tuple(
            (
                slot_id,
                domains.inverter.kind,
                domains.inverter.target_soc,
            )
            for slot_id, domains in sorted(schedule_document.slots.items())
        )

    def _build_battery_forecast_schedule_document(
        self,
        *,
        schedule_document: ScheduleDocument,
    ) -> ScheduleDocument:
        if not schedule_document.execution_enabled:
            return schedule_document

        control_config = self._read_schedule_control_config()
        if control_config is None:
            return ScheduleDocument()

        forecast_slots = {
            slot_id: domains
            for slot_id, domains in schedule_document.slots.items()
            if not (
                domains.inverter.kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC
                and control_config.charge_to_target_soc_option is None
            )
            and not (
                domains.inverter.kind == SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC
                and control_config.discharge_to_target_soc_option is None
            )
        }
        return ScheduleDocument(
            execution_enabled=schedule_document.execution_enabled,
            slots=forecast_slots,
        )

    def _build_battery_forecast_schedule_effective_signature(
        self,
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
    ) -> tuple[str, str, int | None, str, str] | None:
        if not schedule_document.execution_enabled:
            return None

        active_slot_id = format_slot_id(build_horizon_start(reference_time))
        active_domains = schedule_document.slots.get(active_slot_id)
        active_action = None if active_domains is None else active_domains.inverter
        if active_action is None or active_action.kind not in {
            SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
            SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
        }:
            return None

        battery_entity_config = read_battery_entity_config(self._active_config)
        if battery_entity_config is None:
            return (
                active_slot_id,
                active_action.kind,
                active_action.target_soc,
                "not_configured",
                "not_configured",
            )

        live_state = read_battery_live_state(self._hass, battery_entity_config)
        if live_state is None:
            return (
                active_slot_id,
                active_action.kind,
                active_action.target_soc,
                "unavailable",
                "execution_unavailable",
            )

        resolution = resolve_executed_schedule_action(
            action=active_action,
            current_soc=live_state.current_soc,
        )
        return (
            active_slot_id,
            active_action.kind,
            active_action.target_soc,
            resolution.executed_action.kind,
            resolution.reason,
        )

    @staticmethod
    def _build_battery_forecast_schedule_overlay(
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
    ) -> ScheduleForecastOverlay | None:
        if not schedule_document.execution_enabled:
            return None

        from .scheduling.forecast_overlay import build_schedule_forecast_overlay

        return build_schedule_forecast_overlay(
            schedule_document=schedule_document,
            reference_time=reference_time,
        )

    def _invalidate_battery_forecast_cache(self) -> None:
        self._cached_appliance_forecast_pipeline = None
        self._cached_battery_forecast = None
        self._cached_battery_forecast_expires_at = None
        self._cached_battery_forecast_house_generated_at = None
        self._cached_battery_forecast_solar_signature = None
        self._cached_battery_forecast_schedule_execution_enabled = None
        self._cached_battery_forecast_schedule_signature = None
        self._cached_battery_forecast_schedule_effective_signature = None
        self._invalidate_appliance_projection_cache()

    def _invalidate_appliance_projection_cache(self) -> None:
        self._cached_appliance_projection_plan = None
        self._cached_appliance_projection_expires_at = None
        self._cached_appliance_projection_started_at = None
        self._cached_appliance_projection_house_generated_at = None
        self._cached_appliance_projection_solar_signature = None
        self._cached_appliance_projection_schedule_signature = None

    def _has_valid_battery_forecast_cache(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        schedule_execution_enabled: bool,
        schedule_signature: tuple[tuple[str, str, int | None], ...],
        appliance_schedule_signature: tuple[
            tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
            ...,
        ],
        schedule_effective_signature: tuple[str, str, int | None, str, str] | None,
    ) -> bool:
        if (
            self._cached_battery_forecast is None
            or self._cached_battery_forecast_expires_at is None
        ):
            return False

        if (
            dt_util.as_utc(started_at)
            >= dt_util.as_utc(self._cached_battery_forecast_expires_at)
        ):
            return False

        cached_started_at_raw = self._cached_battery_forecast.get("startedAt")
        if not isinstance(cached_started_at_raw, str):
            return False

        cached_started_at = dt_util.parse_datetime(cached_started_at_raw)
        if cached_started_at is None:
            return False

        if get_local_current_slot_start(
            cached_started_at,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        ) != get_local_current_slot_start(
            started_at,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        ):
            return False

        if (
            self._cached_battery_forecast_house_generated_at
            != house_forecast.get("generatedAt")
        ):
            return False

        if (
            self._cached_battery_forecast_solar_signature
            != self._build_battery_forecast_solar_signature(solar_forecast)
        ):
            return False

        if (
            self._cached_battery_forecast_schedule_execution_enabled
            != schedule_execution_enabled
        ):
            return False

        if self._cached_battery_forecast_schedule_signature != schedule_signature:
            return False

        if (
            self._cached_appliance_projection_schedule_signature
            != appliance_schedule_signature
        ):
            return False

        if (
            self._cached_battery_forecast_schedule_effective_signature
            != schedule_effective_signature
        ):
            return False

        return self._has_compatible_battery_forecast_live_state()

    def _store_battery_forecast_cache(
        self,
        *,
        pipeline: _ApplianceForecastPipelineSnapshot,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        schedule_execution_enabled: bool,
        schedule_signature: tuple[tuple[str, str, int | None], ...],
        appliance_schedule_signature: tuple[
            tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
            ...,
        ],
        schedule_effective_signature: tuple[str, str, int | None, str, str] | None,
    ) -> None:
        self._cached_appliance_forecast_pipeline = pipeline
        self._cached_battery_forecast = pipeline.battery_forecast
        self._cached_battery_forecast_expires_at = dt_util.as_local(
            dt_util.as_utc(started_at)
            + timedelta(seconds=BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS)
        )
        self._cached_battery_forecast_house_generated_at = house_forecast.get(
            "generatedAt"
        )
        self._cached_battery_forecast_solar_signature = (
            self._build_battery_forecast_solar_signature(solar_forecast)
        )
        self._cached_battery_forecast_schedule_execution_enabled = (
            schedule_execution_enabled
        )
        self._cached_battery_forecast_schedule_signature = schedule_signature
        self._cached_battery_forecast_schedule_effective_signature = (
            schedule_effective_signature
        )
        self._cached_appliance_projection_plan = pipeline.projection_plan
        self._cached_appliance_projection_expires_at = self._cached_battery_forecast_expires_at
        self._cached_appliance_projection_started_at = started_at
        self._cached_appliance_projection_house_generated_at = house_forecast.get(
            "generatedAt"
        )
        self._cached_appliance_projection_solar_signature = (
            self._build_battery_forecast_solar_signature(solar_forecast)
        )
        self._cached_appliance_projection_schedule_signature = appliance_schedule_signature

    def _has_valid_appliance_projection_cache(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        schedule_signature: tuple[
            tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
            ...,
        ],
    ) -> bool:
        if (
            self._cached_appliance_projection_plan is None
            or self._cached_appliance_projection_expires_at is None
            or self._cached_appliance_projection_started_at is None
        ):
            return False
        if dt_util.as_utc(started_at) >= dt_util.as_utc(
            self._cached_appliance_projection_expires_at
        ):
            return False
        if dt_util.as_utc(started_at) != dt_util.as_utc(
            self._cached_appliance_projection_started_at
        ):
            return False
        if (
            self._cached_appliance_projection_house_generated_at
            != house_forecast.get("generatedAt")
        ):
            return False
        if (
            self._cached_appliance_projection_solar_signature
            != self._build_battery_forecast_solar_signature(solar_forecast)
        ):
            return False
        return self._cached_appliance_projection_schedule_signature == schedule_signature

    def _store_appliance_projection_cache(
        self,
        *,
        plan: ApplianceProjectionPlan,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        schedule_signature: tuple[
            tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
            ...,
        ],
    ) -> None:
        self._cached_appliance_projection_plan = plan
        self._cached_appliance_projection_expires_at = dt_util.as_local(
            dt_util.as_utc(started_at)
            + timedelta(seconds=BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS)
        )
        self._cached_appliance_projection_started_at = started_at
        self._cached_appliance_projection_house_generated_at = house_forecast.get(
            "generatedAt"
        )
        self._cached_appliance_projection_solar_signature = (
            self._build_battery_forecast_solar_signature(solar_forecast)
        )
        self._cached_appliance_projection_schedule_signature = schedule_signature

    @staticmethod
    def _build_appliance_projection_schedule_signature(
        schedule_document: ScheduleDocument,
    ) -> tuple[
        tuple[str, tuple[tuple[str, tuple[tuple[str, object], ...]], ...]],
        ...,
    ]:
        return tuple(
            (
                slot_id,
                tuple(
                    (
                        appliance_id,
                        tuple(sorted(action.items())),
                    )
                    for appliance_id, action in sorted(domains.appliances.items())
                ),
            )
            for slot_id, domains in sorted(schedule_document.slots.items())
        )

    def _has_compatible_battery_forecast_live_state(self) -> bool:
        battery_entity_config = read_battery_entity_config(self._active_config)
        if battery_entity_config is None:
            return True

        live_state = read_battery_live_state(self._hass, battery_entity_config)
        if live_state is None:
            return True

        if self._cached_battery_forecast is None:
            return False

        current_soc = self._cached_battery_forecast.get("currentSoc")
        current_remaining_energy_kwh = self._cached_battery_forecast.get(
            "currentRemainingEnergyKwh"
        )
        if not isinstance(current_soc, (int, float)) or not isinstance(
            current_remaining_energy_kwh, (int, float)
        ):
            return False

        return (
            abs(float(current_soc) - live_state.current_soc)
            <= _BATTERY_FORECAST_CACHE_SOC_TOLERANCE
            and abs(
                float(current_remaining_energy_kwh)
                - live_state.current_remaining_energy_kwh
            )
            <= _BATTERY_FORECAST_CACHE_ENERGY_TOLERANCE_KWH
        )

    @staticmethod
    def _build_battery_forecast_solar_signature(
        solar_forecast: dict[str, Any],
    ) -> tuple[Any, ...]:
        points = solar_forecast.get("points")
        if not isinstance(points, list):
            points = []

        normalized_points: list[tuple[str, float]] = []
        for point in points:
            if not isinstance(point, dict):
                continue

            timestamp = point.get("timestamp")
            value = point.get("value")
            if not isinstance(timestamp, str):
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            normalized_points.append((timestamp, round(float(value), 4)))

        return (
            solar_forecast.get("status"),
            tuple(normalized_points),
        )

    def _start_forecast_refresh(self) -> None:
        """Start the slot-aligned house forecast refresh schedule."""
        if self._unsub_forecast_refresh is not None:
            return

        @callback
        def _on_forecast_interval(_now: datetime) -> None:
            self._hass.async_create_task(self._async_refresh_forecast())

        self._unsub_forecast_refresh = async_track_time_change(
            self._hass,
            _on_forecast_interval,
            minute=[0, 15, 30, 45],
            second=0,
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
        history_buckets: int = self._active_config.get("history_buckets", 60)

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
        bucket_duration: int = self._active_config.get("history_bucket_duration", 1)
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
            battery_cfg = self._active_config.get("power_devices", {}).get("battery", {})
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
        buckets: int = self._active_config.get("history_buckets", 60)
        bucket_duration: int = self._active_config.get("history_bucket_duration", 1)
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
        entity_config = read_battery_entity_config(self._active_config)
        if entity_config is None:
            return None
        return read_battery_live_state(self._hass, entity_config)

    def _read_schedule_executor_battery_state(self):
        entity_config = read_battery_entity_config(self._active_config)
        if entity_config is None:
            issue = describe_battery_entity_config_issue(self._active_config)
            if issue is None:
                issue = "required battery entity config values are unavailable"
            if self._last_schedule_battery_state_issue != issue:
                _LOGGER.warning(
                    "Schedule execution battery state unavailable: %s",
                    issue,
                )
                self._last_schedule_battery_state_issue = issue
            return None

        battery_state = read_battery_live_state(self._hass, entity_config)
        if battery_state is not None:
            self._last_schedule_battery_state_issue = None
            return battery_state

        issue = describe_battery_live_state_issue(self._hass, entity_config)
        if issue is None:
            issue = "battery live state is unavailable"
        if self._last_schedule_battery_state_issue != issue:
            _LOGGER.warning(
                "Schedule execution battery state unavailable: %s",
                issue,
            )
            self._last_schedule_battery_state_issue = issue
        return None

    def _read_battery_soc_bounds(self):
        bounds_config = read_battery_soc_bounds_config(self._active_config)
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
        await self._schedule_executor.async_unload()
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
