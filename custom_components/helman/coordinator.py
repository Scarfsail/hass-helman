from __future__ import annotations

from copy import deepcopy
import asyncio
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from collections import deque
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import TYPE_CHECKING, Any, Callable, Sequence
from zoneinfo import ZoneInfo

from homeassistant.components.energy import data as energy_data
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.start import async_at_started
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
    read_vehicle_remaining_capacity_kwh_by_vehicle_id,
    build_appliance_projections_response,
    build_appliances_response,
    build_appliances_runtime_registry,
    build_projection_input_bundle,
    build_empty_appliance_projections_response,
)
from .automation.compute_inputs import (
    ComputeInputs,
    CustomConditionGroupResult,
    CustomConditionResult,
)
from .automation.config import (
    AutomationConfig,
    ConditionGroup,
    read_automation_config,
)
from .automation.day_context import (
    DayContext,
    FrozenDayContext,
    build_day_contexts,
)
from .automation.day_context_store import DayContextStore
from .automation.explain import ExplanationBook, RunExplanation
from .automation.input_bundle import AutomationInputBundle
from .automation.ownership import (
    has_automation_owned_actions,
    merge_automation_result,
    strip_automation_owned_actions,
)
from .automation.snapshot import OptimizationContext, OptimizationSnapshot
from .automation.triggers import AutomationTriggerCoordinator
from .appliances.climate_appliance import ClimateApplianceRuntime
from .appliances.climate_appliance import resolve_supported_climate_modes
from .battery_capacity_forecast_builder import BatteryCapacityForecastBuilder
from .battery_forecast_response import build_battery_forecast_response
from .battery_state import (
    describe_battery_entity_config_issue,
    describe_battery_live_state_issue,
    read_battery_entity_config,
    read_battery_forecast_settings,
    read_battery_live_state,
    read_battery_soc_bounds,
    read_battery_soc_bounds_config,
)
from .const import (
    AUTOMATION_CONDITION_PLAN_FRESHNESS_SECONDS,
    BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS,
    CONSUMPTION_TOTAL_ENTITY_ID,
    DATA_CHANGED_KIND_PLAN,
    DATA_CHANGED_KIND_SCHEDULE,
    DATA_CHANGED_KIND_SOLAR_BIAS,
    DEFAULT_FORECAST_DAYS,
    EVENT_DATA_CHANGED,
    DEFAULT_FORECAST_GRANULARITY_MINUTES,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_STALE_AFTER_SECONDS,
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
    PRODUCTION_TOTAL_ENTITY_ID,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_SLOT_MINUTES,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from .consumption_forecast_builder import ConsumptionForecastBuilder
from .consumption_forecast_profiles import (
    HouseConsumptionProfile,
    profile_from_dict,
)
from .forecast_aggregation import get_forecast_resolution
from .forecast_builder import HelmanForecastBuilder
from .forecast_request import ensure_supported_forecast_request
from .grid_flow_forecast_builder import build_grid_flow_forecast_snapshot
from .grid_flow_forecast_response import build_grid_flow_forecast_response
from .grid_price_forecast_builder import GridPriceForecastBuilder
from .grid_price_forecast_response import build_grid_price_forecast_response
from .house_device_consumers import extract_house_device_consumers
from .house_forecast_response import build_house_forecast_response
from .point_forecast_response import build_solar_forecast_response
from .solar_bias_correction.response import build_bias_correction_payload
from .recorder_hourly_series import (
    TodaySlotEnergyReader,
    get_local_current_slot_start,
    query_active_hours_by_local_date,
)
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
    strip_candidate_actions,
    with_slot_set_by,
    validate_slot_patch_request,
)
from .schedule_action_metadata import ScheduleActionSetBy
from .appliances.generic_appliance import GenericApplianceRuntime
from .scheduling.runtime_status import (
    ScheduleExecutionStatus,
    schedule_execution_status_to_dict,
)
from .scheduling.action_resolution import resolve_executed_schedule_action
from .scheduling.actual_history import ActualHistorySlot, build_entity_actual_history
from .scheduling.actuation import OverrideScheduleActuator
from .scheduling.normal_state import (
    ControllableEntityDict,
    async_restore_normal_state as async_apply_normal_state,
    build_controllable_entities,
)
from .scheduling.schedule_executor import (
    ScheduleExecutor,
    ScheduleExecutorDependencies,
)
from .solar_bias_correction.models import read_bias_config
from .solar_bias_correction.service import SolarBiasCorrectionService
from .storage import HelmanStorage, TrainingArtifactsStore
from .training.appliance_energy import (
    ApplianceEnergyTrainingJob,
    ApplianceEnergyTrainingRequest,
)
from .training.batch import TrainingBatch
from .training.house_consumption import (
    HouseConsumptionTrainingJob,
    HouseTrainingRequest,
)
from .tree_builder import HelmanTreeBuilder

_LOGGER = logging.getLogger(__name__)
# Sentinel distinguishing "battery live state not supplied" from "supplied as
# None" (None legitimately means the battery is unavailable). Lets a caller that
# has already read the live state once per run pass it through instead of the
# callee re-reading hass.states.
_LIVE_STATE_UNSET: Any = object()
_UNAVAILABLE_ENTITY_STATES = {"unknown", "unavailable", "none"}
_BATTERY_FORECAST_CACHE_SOC_TOLERANCE = 1.0
_BATTERY_FORECAST_CACHE_ENERGY_TOLERANCE_KWH = 0.1
# The battery-forecast schedule cache key: the inverter action of every slot.
# Built from the forecast schedule document, which is already empty when
# execution is off, so an execution toggle moves this key without it having to
# carry the flag itself.
_BatteryForecastScheduleSignature = tuple[tuple[str, str, int | None], ...]
# How far back the unmeasured remainder looks when smoothing away meter skew.
# See _smooth_unmeasured for why the raw remainder cannot be published as-is.
_UNMEASURED_SMOOTHING_WINDOW_S = 15.0
# When a stored house consumption profile is due for a refit. Long on purpose:
# the batch runs nightly, so anything under two days is a slipped timer rather
# than a fault, and the profile keeps being served either way.
_HOUSE_PROFILE_STALE_AFTER_SECONDS = 48 * 3600
_FORECAST_STALE_HINT = (
    "Forecast data has not been rebuilt for over an hour. "
    "Check the Home Assistant log for forecast refresh errors."
)

if TYPE_CHECKING:
    from .automation.pipeline import AutomationRunResult
    from .battery_forecast_history import BatteryForecastHistoryStore
    from .scheduling.forecast_overlay import ScheduleForecastOverlay


def _resolve_runtime_entity_and_states(
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime,
) -> tuple[str | None, tuple[str, ...]]:
    """Return the recorder entity id and active-state set defining "on" runtime.

    Generic appliances count their switch being ``on``; climate appliances count
    the compressor running in any active heating/cooling mode.
    """
    if isinstance(appliance, GenericApplianceRuntime):
        return appliance.switch_entity_id, ("on",)
    if isinstance(appliance, ClimateApplianceRuntime):
        return appliance.climate_entity_id, ("heat", "cool")
    return None, ()


def _build_forecast_staleness(
    generated_at: Any,
    *,
    reference_time: datetime,
    override: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """Forecast health for the card's banner.

    Age never makes a forecast unavailable — an aging snapshot is old, not
    wrong, and blanking the card is worse than showing good data with a
    warning. So every payload carries when it was last rebuilt and says for
    itself whether that is long enough ago to be a fault. ``reason`` is a
    stable machine string; ``hint`` is what the banner shows.

    ``override`` is a ``(reason, hint)`` pair that wins outright: the snapshot
    itself can be minutes old and still be built on a model that failed to
    refit, and that is the fault the user needs told about. Age remains the
    rule for everything with no such story of its own.
    """
    generated_at_dt = (
        dt_util.parse_datetime(generated_at) if isinstance(generated_at, str) else None
    )
    if override is not None:
        reason, hint = override
        return {
            "generatedAt": generated_at_dt.isoformat() if generated_at_dt else None,
            "isStale": True,
            "reason": reason,
            "hint": hint,
        }
    is_stale = (
        generated_at_dt is None
        or (
            dt_util.as_utc(reference_time) - dt_util.as_utc(generated_at_dt)
        ).total_seconds()
        > FORECAST_STALE_AFTER_SECONDS
    )
    return {
        "generatedAt": generated_at_dt.isoformat() if generated_at_dt else None,
        "isStale": is_stale,
        "reason": "stale_forecast" if is_stale else None,
        "hint": _FORECAST_STALE_HINT if is_stale else None,
    }


def _build_house_profile_health(snapshot: dict[str, Any]) -> tuple[str, str] | None:
    """The banner's ``(reason, hint)`` for a house profile that failed to refit.

    A profile trained nightly is at most ~24 h old, and past 48 h we keep
    serving it and refit in the background — a merely slipped timer is no
    user-visible event. Only a refit that failed or could not run gets a
    banner, because only that one needs the user. ``reason`` is localized by
    the card; the numbers stay in ``hint``, which the card falls back to,
    because ``localize`` takes no interpolation parameters.
    """
    last_outcome = snapshot.get("lastOutcome")
    if last_outcome == "insufficient_history":
        return (
            "house_profile_insufficient_history",
            "Not enough recorder history to fit a house consumption profile: "
            f"{snapshot.get('historyDaysAvailable')} days available, "
            f"{snapshot.get('requiredHistoryDays')} required.",
        )
    if last_outcome == "entity_missing":
        return (
            "house_profile_entity_missing",
            "The configured house total energy entity no longer exists; "
            "the house consumption profile cannot be refitted.",
        )
    if last_outcome == "training_failed":
        return (
            "house_profile_training_failed",
            "House consumption profile training failed. Check the Home "
            "Assistant log.",
        )
    return None


def _iter_local_dates(start: date, end: date) -> list[date]:
    """Inclusive list of local calendar dates from ``start`` to ``end``."""
    dates: list[date] = []
    cursor = start
    while cursor <= end:
        dates.append(cursor)
        cursor += timedelta(days=1)
    return dates


def _merge_grid_forecast_responses(
    *,
    grid_flow_response: dict[str, Any],
    grid_price_response: dict[str, Any],
) -> dict[str, Any]:
    return {
        **grid_flow_response,
        "exportPriceUnit": grid_price_response.get("exportPriceUnit"),
        "currentExportPrice": grid_price_response.get("currentExportPrice"),
        "exportPricePoints": list(grid_price_response.get("exportPricePoints", [])),
        "importPriceUnit": grid_price_response.get("importPriceUnit"),
        "currentImportPrice": grid_price_response.get("currentImportPrice"),
        "importPricePoints": list(grid_price_response.get("importPricePoints", [])),
    }


def _build_grid_forecast_snapshot_with_prices(
    *,
    battery_forecast: dict[str, Any],
    grid_price_forecast: dict[str, Any],
) -> dict[str, Any]:
    return _merge_grid_forecast_responses(
        grid_flow_response=build_grid_flow_forecast_snapshot(battery_forecast),
        grid_price_response=grid_price_forecast,
    )


def _build_price_channel_snapshot(
    *,
    grid_price_forecast: dict[str, Any],
    unit_field: str,
    current_price_field: str,
    points_field: str,
) -> dict[str, Any]:
    return {
        "unit": grid_price_forecast.get(unit_field),
        "currentPrice": grid_price_forecast.get(current_price_field),
        "points": list(grid_price_forecast.get(points_field, [])),
    }


def _iter_local_solar_points(
    points: list[dict[str, Any]],
) -> list[tuple[datetime, float]]:
    normalized_points: list[tuple[datetime, float]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str) or isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            continue
        parsed_timestamp = dt_util.parse_datetime(timestamp)
        if parsed_timestamp is None:
            continue
        normalized_points.append((dt_util.as_local(parsed_timestamp), float(value)))
    normalized_points.sort(key=lambda item: dt_util.as_utc(item[0]))
    return normalized_points


def _bucket_points_by_local_day(
    points: list[dict[str, Any]],
) -> dict[str, list[float]]:
    buckets: dict[str, list[float]] = {}
    for point_time, value in _iter_local_solar_points(points):
        bucket_key = point_time.date().isoformat()
        buckets.setdefault(bucket_key, []).append(value)
    return buckets


def _build_corrected_solar_forecast_view(
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    forecast = deepcopy(snapshot)
    corrected_points = forecast.get("correctedPoints")
    if isinstance(corrected_points, list) and corrected_points:
        # corrected canonical points for automation and battery planning.
        forecast["points"] = deepcopy(corrected_points)
        forecast["adjustedPoints"] = deepcopy(corrected_points)
    return forecast


@dataclass(frozen=True)
class _ApplianceForecastPipelineSnapshot:
    started_at: datetime
    original_house_forecast: dict[str, Any]
    adjusted_house_forecast: dict[str, Any]
    projection_plan: ApplianceProjectionPlan
    battery_forecast: dict[str, Any]


@dataclass(frozen=True)
class _ForecastScheduleDocuments:
    forecast_schedule_document: ScheduleDocument
    projection_schedule_document: ScheduleDocument


@dataclass(frozen=True)
class _ForecastRebuildSnapshot:
    adjusted_house_forecast: dict[str, Any]
    battery_forecast: dict[str, Any]
    projection_plan: ApplianceProjectionPlan
    grid_forecast: dict[str, Any] | None = None
    #: The overlay ``battery_forecast`` was simulated from, kept so the
    #: optimization snapshot can carry it. Re-deriving it downstream is not
    #: possible: the snapshot's schedule document is the unstripped original.
    schedule_overlay: ScheduleForecastOverlay | None = None


@dataclass(frozen=True)
class _ForecastRefreshResult:
    forecast_refreshed: bool
    bundle_ready: bool


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
        self._unmeasured_raw_history: dict[str, deque] = {}
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
        # Map: source_power_sensor_id → ratio_sensor_entity_id (derived from the tree in
        # _init_buffers, independent of when the sensor platform registers the ratio entities).
        self._source_ratio_entity_ids: dict[str, str] = {}
        self._solar_forecast_sensors: list[Any] = []
        # Tick lifecycle
        self._unsub_tick: Callable[[], None] | None = None
        # House forecast snapshot (persisted + cached)
        self._cached_forecast: dict | None = None
        self._house_consumption_forecast_current_sensor = None
        self._cached_solar_forecast: dict[str, Any] | None = None
        self._battery_forecast_history: BatteryForecastHistoryStore | None = None
        self._cached_battery_forecast: dict | None = None
        self._cached_battery_forecast_expires_at: datetime | None = None
        self._cached_battery_forecast_house_generated_at: str | None = None
        self._cached_battery_forecast_solar_signature: tuple[Any, ...] | None = None
        self._cached_battery_forecast_schedule_signature: (
            _BatteryForecastScheduleSignature | None
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
        self._create_task = getattr(self._hass, "async_create_task", asyncio.create_task)
        self._refresh_tasks: set[asyncio.Task[Any]] = set()
        self._automation_input_bundle: AutomationInputBundle | None = None
        self._day_context_store = DayContextStore(hass)
        self._last_automation_run_result: AutomationRunResult | None = None
        # Per-slot condition explanations, accumulated in memory and keyed by
        # (target lane, date). Deliberately not persisted: the plan is rebuilt
        # from `build_horizon_start(now)` every 15 minutes, so the record
        # regenerates on its own within minutes of a restart, and writing it out
        # would cost ~96 whole-file rewrites/day of a 100-300 KB JSON.
        self._explanation_book = ExplanationBook()
        # (optimizer_id, group_index) -> (custom config, built ConditionChecker
        # | None). Keyed per group because groups are ORed and each carries its
        # own `custom` list.
        # Cached across runs; rebuilt when a group's `custom` changes and
        # unloaded when it is removed or on shutdown.
        # Value: (the group's `custom` config it was built from, one checker per
        # entry in that config — per-entry so each result stands on its own).
        self._optimizer_condition_checkers: dict[
            tuple[str, int], tuple[Any, tuple[Any, ...]]
        ] = {}
        # Plan-freshness bookkeeping for the pre-execution reality check:
        # the condition map the current plan was built from, and when.
        self._last_automation_plan_at: datetime | None = None
        self._last_plan_condition_map: dict[str, tuple[bool, ...]] = {}
        self._automation_triggers = AutomationTriggerCoordinator(
            create_task=self._create_task,
            run_callback=self._async_run_automation_trigger_request,
        )
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
                check_reality_and_maybe_replan=(
                    self._async_reality_check_and_maybe_replan
                ),
            ),
        )
        self._appliances_registry = AppliancesRuntimeRegistry()
        self._solar_bias_store: Any = None
        self._solar_bias_service: SolarBiasCorrectionService | None = None
        self._training_artifacts_store: TrainingArtifactsStore | None = None
        self._training_batch: TrainingBatch | None = None
        # The fitted house consumption model the forecast is assembled from,
        # adopted from the training artifacts store at startup and replaced
        # whenever the nightly batch refits it. None means "nothing to serve".
        self._house_profile: HouseConsumptionProfile | None = None
        self._house_profile_trained_at: str | None = None
        self._house_profile_last_outcome: str = "no_training_yet"
        # Per-appliance average hourly energy while running, keyed by appliance
        # id, adopted from the same store. An appliance missing from the map —
        # never trained, no usable history, or on a fixed strategy — falls back
        # to its configured hourly_energy_kwh, which is what the resolvers did
        # for a failed estimate before this was stored at all.
        self._appliance_energy_estimates: dict[str, float] = {}
        # Today's completed slots are immutable, so the reader keeps the ones it
        # has already resolved. It lives here because the forecast builder is
        # rebuilt on every refresh and a cache inside it would never be read.
        self._slot_history = TodaySlotEnergyReader(hass)
        # The rebuild currently in flight, if any, so a second trigger joins it
        # instead of starting its own 56-day recorder scan.
        self._forecast_refresh_task: asyncio.Task[Any] | None = None
        self._last_schedule_control_config_issue: str | None = None
        self._last_schedule_battery_state_issue: str | None = None
        # Mapping: parent_node_id → unmeasured_entity_id (e.g. "house" → "sensor.helman_house_unmeasured_power")
        self._unmeasured_entity_id_map: dict[str, str] = {}
        # Entity IDs whose values are computed by the tick (not read from hass.states)
        self._virtual_sensor_ids: set[str] = set()

    @property
    def config(self) -> dict:
        return self._active_config

    def get_last_automation_run_result(self) -> AutomationRunResult | None:
        if self._last_automation_run_result is None:
            return None
        return deepcopy(self._last_automation_run_result)

    def record_run_explanation(self, explanation: "RunExplanation | None") -> None:
        """Merge one successful run's condition record into the book.

        Called only from the optimizer loop's success path — a failed run never
        gets here, so the accumulated record survives it intact.
        """
        if explanation is None:
            return
        self._explanation_book.record(explanation)

    def get_schedule_explanation(
        self, *, target_key: str, date: str
    ) -> dict[str, Any] | None:
        """The condition record for one schedule lane on one date.

        ``target_key`` is the lane's identity (``"inverter"`` /
        ``"appliance:<id>"``), and the result carries **every** optimizer that
        touched it, in pipeline order: the inverter lane is written by three
        optimizer kinds, so a lane click has no single optimizer to ask.
        """
        return self._explanation_book.get(target_key=target_key, date=date)

    def _set_last_automation_run_result(self, result: AutomationRunResult) -> None:
        self._last_automation_run_result = deepcopy(result)
        # Record the condition map + time this plan was built from, so the
        # condition-check poll can detect a flip and trigger a fast re-plan.
        if result.ran_automation and result.snapshot is not None:
            self._last_automation_plan_at = result.snapshot.context.now
            self._last_plan_condition_map = dict(
                result.snapshot.context.condition_met_by_optimizer_id
            )
        # Fired even when the merged result equalled the stored document and no
        # write happened: the explanation book, the last-run result and the
        # derived forecasts still moved, and the inspector draws those.
        self._fire_data_changed(DATA_CHANGED_KIND_PLAN)

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

    def set_sensors(
        self,
        battery_time_to_full,
        battery_time_to_empty,
        unmeasured_sensors: dict,
        total_power=None,
        production_total=None,
        source_ratio_sensors: dict | None = None,
        forecast_sensors: list[Any] | None = None,
    ) -> None:
        """Called from async_setup_entry to register all sensor entities."""
        self._battery_time_to_full = battery_time_to_full
        self._battery_time_to_empty = battery_time_to_empty
        self._unmeasured_sensors = unmeasured_sensors
        self._consumption_total_sensor = total_power
        self._production_total_sensor = production_total
        self._source_ratio_sensors = source_ratio_sensors or {}
        self._solar_forecast_sensors = list(forecast_sensors or [])

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

    def _publish_solar_forecast_entities(self) -> None:
        for sensor in self._solar_forecast_sensors:
            if getattr(sensor, "hass", None) is None:
                continue
            try:
                sensor.async_write_ha_state()
            except Exception:
                _LOGGER.exception(
                    "Error publishing solar forecast sensor state: %s",
                    getattr(sensor, "entity_id", "<unknown>"),
                )
        hcfc_sensor = getattr(self, "_house_consumption_forecast_current_sensor", None)
        if hcfc_sensor is not None:
            if getattr(hcfc_sensor, "hass", None) is not None:
                hcfc_sensor.async_write_ha_state()

    async def async_setup(self) -> None:
        """Register event listeners that invalidate the cached tree."""
        self._active_config = deepcopy(self._storage.config)
        from .battery_forecast_history import BatteryForecastHistoryStore
        from .storage import SolarBiasCorrectionStore

        self._solar_bias_store = SolarBiasCorrectionStore(self._hass)
        await self._solar_bias_store.async_load()
        self._battery_forecast_history = BatteryForecastHistoryStore(self._hass)
        await self._battery_forecast_history.async_load()
        bias_config = read_bias_config(self._active_config)
        self._solar_bias_service = SolarBiasCorrectionService(
            self._hass,
            self._solar_bias_store,
            bias_config,
            canonical_solar_forecast_provider=self._async_get_canonical_solar_forecast,
            battery_forecast_provider=self._async_get_battery_forecast_snapshot,
            battery_forecast_history=self._battery_forecast_history,
            house_forecast_snapshot_provider=self._get_adjusted_house_forecast_snapshot,
            house_energy_entity_id_provider=self._get_house_energy_entity_id,
            house_deferrable_consumers_provider=self._get_house_deferrable_consumers,
            house_device_consumers_provider=self._get_house_device_consumers,
            house_unmeasured_label_provider=self._get_house_unmeasured_label,
            battery_soc_entity_id_provider=self._get_battery_soc_entity_id,
            battery_soc_bounds_provider=self._get_battery_soc_bounds,
            battery_soc_bounds_entity_id_provider=self._get_battery_soc_bounds_entity_ids,
            grid_import_energy_entity_id_provider=lambda: self._get_grid_energy_entity_id(
                "today_import"
            ),
            grid_export_energy_entity_id_provider=lambda: self._get_grid_energy_entity_id(
                "today_export"
            ),
            battery_charge_energy_entity_id_provider=lambda: self._get_battery_entity_id(
                "today_charge_energy"
            ),
            battery_discharge_energy_entity_id_provider=lambda: self._get_battery_entity_id(
                "today_discharge_energy"
            ),
        )
        await self._solar_bias_service.async_setup()
        self._training_artifacts_store = TrainingArtifactsStore(self._hass)
        await self._training_artifacts_store.async_load()
        # Unconditionally, outside any bias enable gate: with bias correction
        # off, a gated batch would never fit the house consumption profile and
        # the house forecast would sit at unavailable forever.
        self._training_batch = TrainingBatch(
            self._hass,
            solar_bias_service=self._solar_bias_service,
            house_consumption_job=HouseConsumptionTrainingJob(
                self._hass,
                self._training_artifacts_store,
                read_request=self._read_house_training_request,
                on_trained=self._async_on_house_profile_trained,
            ),
            appliance_energy_job=ApplianceEnergyTrainingJob(
                self._hass,
                self._training_artifacts_store,
                read_request=self._read_appliance_energy_training_request,
                on_trained=self._async_on_appliance_energy_trained,
            ),
        )
        try:
            self._training_batch.schedule(bias_config.training_time)
        except ValueError:
            _LOGGER.warning(
                "Nightly training batch not scheduled due to invalid training time: %s",
                bias_config.training_time,
            )
        self._appliances_registry = build_appliances_runtime_registry(
            self._active_config,
            logger=_LOGGER,
        )
        # After the registry: the stored estimates are keyed on the appliances
        # it holds, so there is nothing to adopt them against before this point.
        refit_reason = self._adopt_stored_appliance_energy()
        if refit_reason is not None:
            self._schedule_appliance_energy_refit(refit_reason)
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
        self._unsub_listeners.append(
            self._hass.bus.async_listen(
                "helman_solar_bias_trained",
                self._on_solar_bias_changed,
            )
        )
        self._unsub_listeners.append(
            self._hass.bus.async_listen(
                "helman_solar_bias_status_changed",
                self._on_solar_bias_changed,
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

        # House forecast: load persisted snapshot and schedule recurring
        # refreshes. The persisted snapshots are served as-is however old they
        # are — a read never rebuilds, so discarding them on age would leave
        # the first card opened after a restart with nothing until the startup
        # refresh below completes. Only a snapshot that answers a *different*
        # question (entity, window, fingerprint) is thrown away.
        self._cached_forecast = self._storage.forecast_snapshot
        self._cached_solar_forecast = self._storage.solar_forecast_snapshot
        (
            total_energy_entity_id,
            training_window_days,
            min_history_days,
            config_fingerprint,
        ) = self._read_house_forecast_config()
        if not self._has_matching_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
        ):
            self._cached_forecast = None
        # The house profile is loaded against the very same fingerprint, so the
        # profile and the snapshot can never disagree about what is stale.
        # A config save is a restart (ws_save_config -> async_reload ->
        # async_setup), which is why this one path covers startup and config
        # save both, and why there is no config-save handler anywhere.
        refit_reason = self._adopt_stored_house_profile(
            config_fingerprint=config_fingerprint
        )
        if refit_reason is not None:
            self._schedule_house_profile_refit(refit_reason)
        reference_time = dt_util.now()
        self._start_forecast_refresh()

        await self._async_normalize_schedule_document()
        automation_config = read_automation_config(self._active_config)
        if automation_config is None:
            automation_config = AutomationConfig(enabled=False)
        # Stale automation-owned actions are stripped when automation itself is
        # off. This is independent of execution_enabled: with execution off the
        # optimizers still plan, so their actions stay.
        if not (automation_config.enabled and automation_config.execution_optimizers):
            await self._async_cleanup_automation_owned_actions_if_needed(
                reference_time=reference_time,
            )
        await self._async_reconcile_schedule_execution(
            reason="startup",
            reference_time=reference_time,
        )
        self._schedule_startup_forecast_refresh()

    def _schedule_startup_forecast_refresh(self) -> None:
        """Build the first forecast once Home Assistant has finished starting.

        Deferred for the same reason as ``_schedule_house_profile_refit``: the
        solar half reads its points straight off the forecast provider's daily
        energy entities, and on a cold start that integration has not
        registered them yet — the build comes back ``unavailable`` with no
        points a fraction of a second after setup. Until this fires the
        persisted snapshot is served, so the card shows the last known forecast
        rather than nothing.

        When Home Assistant is already running — a config save reloads the
        entry — ``async_at_started`` fires immediately, so **G3** is unaffected.
        """

        @callback
        def _run_startup_refresh(_hass: HomeAssistant) -> None:
            self._create_tracked_refresh_task(
                self._async_refresh_forecast(reason="startup")
            )

        self._unsub_listeners.append(
            async_at_started(self._hass, _run_startup_refresh)
        )

    @callback
    def _on_registry_updated(self, event) -> None:
        # Skip events triggered by our own entity removals to avoid rebuild loops.
        entity_id = event.data.get("entity_id", "")
        if entity_id in self._removing_entity_ids:
            self._removing_entity_ids.discard(entity_id)
            return
        self._cached_tree = None
        self._hass.async_create_task(self._async_rebuild_subscriptions())

    @callback
    def _on_solar_bias_changed(self, event) -> None:
        # A freshly trained or re-enabled bias profile changes every solar
        # point, so rebuild at once rather than waiting for the quarter hour.
        # The single-flight guard absorbs an event landing on a timer tick.
        self._create_tracked_refresh_task(
            self._async_refresh_forecast(reason="solar_bias_changed")
        )
        # Bridged rather than subscribed to directly by the cards: the two bias
        # events are this coordinator's own cache-invalidation wiring, and the
        # frontend should only ever have to know one event name.
        self._fire_data_changed(DATA_CHANGED_KIND_SOLAR_BIAS)

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

    def _get_house_energy_entity_id(self) -> str | None:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._active_config.get("power_devices")
        )
        house_config = ConsumptionForecastBuilder._read_dict(power_devices.get("house"))
        forecast_cfg = ConsumptionForecastBuilder._read_dict(house_config.get("forecast"))
        return ConsumptionForecastBuilder._read_entity_id(
            forecast_cfg.get("total_energy_entity_id")
        )

    def _get_house_deferrable_consumers(self) -> list[dict[str, str]]:
        """The configured deferrable appliances feeding the house forecast.

        Reuses the forecast builder's own reader so the inspector splits the
        house actual by exactly the consumers the forecast is trained on.
        """
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._active_config.get("power_devices")
        )
        house_config = ConsumptionForecastBuilder._read_dict(power_devices.get("house"))
        forecast_cfg = ConsumptionForecastBuilder._read_dict(house_config.get("forecast"))
        return ConsumptionForecastBuilder._read_deferrable_consumers(
            forecast_cfg.get("deferrable_consumers")
        )

    def _get_house_unmeasured_label(self) -> str | None:
        """The power card's own title for unmetered house load.

        The inspector's breakdown remainder is the same concept the card shows as
        its "unmeasured" node, so it reuses the very title the user configured
        there and the two views name it identically. ``None`` when unset, leaving
        the inspector its own localized string rather than the card's English
        default.
        """
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._active_config.get("power_devices")
        )
        house_config = ConsumptionForecastBuilder._read_dict(power_devices.get("house"))
        title = house_config.get("unmeasured_power_title")
        if isinstance(title, str) and title.strip():
            return title.strip()
        return None

    async def _get_house_device_consumers(self) -> list[dict[str, Any]]:
        """Individually-measured house devices, from the shared device tree.

        Reuses the very tree the power card renders, so the inspector lists the
        same devices and offers the same control — including offering none where
        the card resolved no switch. See :mod:`.house_device_consumers`.
        """
        try:
            tree = await self.get_device_tree()
        except Exception:
            _LOGGER.exception("Failed to read device tree for inspector breakdown")
            return []
        return extract_house_device_consumers(tree)

    def _get_battery_soc_entity_id(self) -> str | None:
        entity_config = read_battery_entity_config(self._active_config)
        return entity_config.capacity_entity_id if entity_config is not None else None

    def _get_battery_soc_bounds(self) -> tuple[float, float] | None:
        bounds_config = read_battery_soc_bounds_config(self._active_config)
        if bounds_config is None:
            return None
        bounds = read_battery_soc_bounds(self._hass, bounds_config)
        if bounds is None:
            return None
        return (bounds.min_soc, bounds.max_soc)

    def _get_battery_soc_bounds_entity_ids(self) -> tuple[str | None, str | None]:
        bounds_config = read_battery_soc_bounds_config(self._active_config)
        if bounds_config is None:
            return (None, None)
        return (bounds_config.min_soc_entity_id, bounds_config.max_soc_entity_id)

    def _get_grid_energy_entity_id(self, key: str) -> str | None:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._active_config.get("power_devices")
        )
        grid_config = ConsumptionForecastBuilder._read_dict(power_devices.get("grid"))
        entities = ConsumptionForecastBuilder._read_dict(grid_config.get("entities"))
        return ConsumptionForecastBuilder._read_entity_id(entities.get(key))

    def _get_battery_entity_id(self, key: str) -> str | None:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._active_config.get("power_devices")
        )
        battery_config = ConsumptionForecastBuilder._read_dict(
            power_devices.get("battery")
        )
        entities = ConsumptionForecastBuilder._read_dict(battery_config.get("entities"))
        return ConsumptionForecastBuilder._read_entity_id(entities.get(key))

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

    def _read_house_training_request(self) -> HouseTrainingRequest:
        """What the house consumption fit should answer, read live per run."""
        (
            total_energy_entity_id,
            training_window_days,
            min_history_days,
            config_fingerprint,
        ) = self._read_house_forecast_config()
        return HouseTrainingRequest(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            consumers_config=self._get_house_deferrable_consumers(),
            config_fingerprint=config_fingerprint,
        )

    def _adopt_stored_house_profile(self, *, config_fingerprint: str) -> str | None:
        """Adopt the stored house profile; return why a refit is due, or None.

        Three cases, and they are not the same case:

        * missing (or unreadable) — nothing to serve, refit;
        * fingerprint-stale — the stored profile answers a question the user
          has since changed, so it is blanked to make the change visible;
        * older than 48 h — keep serving it, a 56-day fit does not become
          wrong because it missed a night, and refit in the background.
        """
        self._house_profile = None
        self._house_profile_trained_at = None
        self._house_profile_last_outcome = "no_training_yet"

        store = self._training_artifacts_store
        section = store.house_consumption if store is not None else None
        if section is None:
            return "no_stored_profile"

        last_outcome = section.get("last_outcome")
        if isinstance(last_outcome, str):
            self._house_profile_last_outcome = last_outcome

        if section.get("fingerprint") != config_fingerprint:
            return "config_changed"

        profile = profile_from_dict(section.get("data"))
        if profile is None:
            return "unreadable_profile"

        self._house_profile = profile
        trained_at = section.get("trained_at")
        self._house_profile_trained_at = (
            trained_at if isinstance(trained_at, str) else None
        )
        if self._is_house_profile_expired(self._house_profile_trained_at):
            return "profile_expired"
        return None

    def _schedule_house_profile_refit(self, reason: str) -> None:
        """Refit the house profile once Home Assistant has finished starting.

        Deferred rather than run here. The fit reads the house energy entity,
        and on a cold start that entity's own integration may not have
        registered it yet — the job would see ``hass.states.get()`` return
        ``None``, record ``entity_missing``, and leave the house forecast
        unavailable until the next nightly run. Observed in practice: the
        entity appeared about eighty seconds after setup.

        When Home Assistant is already running — a config save reloads the
        entry — ``async_at_started`` fires immediately, so **G3** is unaffected.

        Never awaited either way: startup must not block on a multi-day
        recorder read, and the batch's single flight keeps this from colliding
        with the nightly run.
        """
        if self._training_batch is None:
            return

        @callback
        def _start_house_refit(_hass: HomeAssistant) -> None:
            if self._training_batch is None:
                return
            self._create_tracked_refresh_task(
                self._training_batch.async_run_house_consumption(reason=reason)
            )

        self._unsub_listeners.append(
            async_at_started(self._hass, _start_house_refit)
        )

    def _read_appliance_energy_training_request(
        self,
    ) -> ApplianceEnergyTrainingRequest:
        """The appliances whose estimates the nightly job resolves.

        Every appliance on ``history_average``, not just the ones an enabled
        optimizer references: the same estimates feed the demand projection,
        which runs for anything holding a scheduled action however it got there.
        """
        return ApplianceEnergyTrainingRequest(
            appliances=tuple(
                appliance
                for appliance in self._iter_automation_candidate_appliances()
                if appliance.uses_history_average
            )
        )

    def _adopt_stored_appliance_energy(self) -> str | None:
        """Adopt the stored estimates; return why a refresh is due, or None.

        Mirrors ``_adopt_stored_house_profile``, minus the expiry arm: a
        30-day average of energy-while-running does not go stale on a clock the
        way a house profile does, and the nightly run refreshes it anyway. What
        is left is missing (nothing trained yet) and fingerprint-stale (the
        appliance set, its entities or a lookback window changed).

        A fingerprint change does **not** blank the estimates the way a stale
        house profile is blanked. The map is keyed per appliance, so the entries
        for appliances that did not change are still right, and dropping them
        would push those appliances onto their fixed fallback for no reason
        until the refit lands.
        """
        self._appliance_energy_estimates = {}

        store = self._training_artifacts_store
        section = store.appliance_energy if store is not None else None
        if section is None:
            # A config with no history_average appliance still refits: the job
            # records "not_configured" against the current fingerprint, which is
            # what stops this from rescheduling a refit on every restart.
            return "no_stored_estimates"

        data = section.get("data")
        if isinstance(data, dict):
            self._appliance_energy_estimates = {
                appliance_id: float(value)
                for appliance_id, value in data.items()
                if isinstance(appliance_id, str)
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and value > 0
            }

        request = self._read_appliance_energy_training_request()
        if section.get("fingerprint") != request.fingerprint:
            return "config_changed"
        return None

    def _schedule_appliance_energy_refit(self, reason: str) -> None:
        """Resolve the estimates once Home Assistant has finished starting.

        Deferred for the same reason as ``_schedule_house_profile_refit``: these
        reads touch other integrations' entities, which on a cold start may not
        exist yet — and the estimate would come back empty rather than wrong,
        silently pinning every appliance to its fixed figure for the day.
        """
        if self._training_batch is None:
            return

        @callback
        def _start_appliance_energy_refit(_hass: HomeAssistant) -> None:
            if self._training_batch is None:
                return
            self._create_tracked_refresh_task(
                self._training_batch.async_run_appliance_energy(reason=reason)
            )

        self._unsub_listeners.append(
            async_at_started(self._hass, _start_appliance_energy_refit)
        )

    async def _async_on_appliance_energy_trained(self) -> None:
        """Adopt what the job just wrote, then rebuild so it is visible.

        Re-read from the store rather than handed the map directly, for the same
        reason the house profile is: the preserve-the-previous-value-on-failure
        rule lives in the store, so reading it back is the only way the
        in-memory state agrees with what a failed run decided.
        """
        self._adopt_stored_appliance_energy()
        await self._async_refresh_forecast(reason="appliance_energy_trained")

    @staticmethod
    def _is_house_profile_expired(trained_at: str | None) -> bool:
        trained_at_dt = (
            dt_util.parse_datetime(trained_at) if isinstance(trained_at, str) else None
        )
        if trained_at_dt is None:
            return True
        age = (
            dt_util.as_utc(dt_util.now()) - dt_util.as_utc(trained_at_dt)
        ).total_seconds()
        return age > _HOUSE_PROFILE_STALE_AFTER_SECONDS

    async def _async_on_house_profile_trained(self) -> None:
        """Adopt what the training job just wrote, then rebuild at once.

        Re-read from the store rather than handed the profile directly: the
        store is where the preserve-the-previous-fit-on-failure rule lives, so
        reading it back is the only way the in-memory state agrees with what a
        failed refit decided. Rebuilding here is what makes a fresh profile
        show up immediately instead of at the next quarter hour.
        """
        (_entity_id, _window, _min_days, config_fingerprint) = (
            self._read_house_forecast_config()
        )
        self._adopt_stored_house_profile(config_fingerprint=config_fingerprint)
        await self._async_refresh_forecast(reason="house_profile_trained")

    def _has_matching_forecast_snapshot(
        self,
        *,
        total_energy_entity_id: str | None,
        training_window_days: int,
        min_history_days: int,
        config_fingerprint: str,
    ) -> bool:
        """Whether the cached house snapshot answers the question we are asking.

        The only invalidation there is: entity, training window, minimum
        history, config fingerprint, model and payload shape. Age is
        deliberately not part of it — an old snapshot is the right answer,
        late; a mismatched one answers a question the user has since changed,
        and must be blanked so the change is visible.
        """
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

    def _build_canonical_solar_forecast(
        self,
        raw_solar: dict[str, Any],
        *,
        reference_time: datetime,
    ) -> dict[str, Any]:
        # ``build_solar_forecast_response`` returns a freshly built structure —
        # every point dict is minted by the aggregation — so the snapshot shares
        # nothing with ``raw_solar`` and needs no copy of its own.
        snapshot = build_solar_forecast_response(
            raw_solar,
            granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days=MAX_FORECAST_DAYS,
        )
        raw_points = snapshot.get("points", []) or []
        # rawPoints is the untouched record of what the forecaster said, so it
        # stays independent of ``points``, which consumers are handed live. The
        # points are flat {timestamp, value} dicts, so a per-point dict() is a
        # full copy at a fraction of deepcopy's cost.
        snapshot["rawPoints"] = [dict(point) for point in raw_points]
        solar_bias_service = getattr(self, "_solar_bias_service", None)
        if solar_bias_service is not None:
            bias_result = solar_bias_service.build_adjustment_result(
                raw_points,
                reference_time,
            )
            if bias_result is not None:
                snapshot["biasCorrection"] = build_bias_correction_payload(
                    bias_result
                )
                if bias_result.effective_variant == "adjusted":
                    # The adjuster mints new point dicts per call and the
                    # service keeps no reference to them.
                    snapshot["correctedPoints"] = bias_result.adjusted_points
        snapshot["generatedAt"] = reference_time.isoformat()
        return snapshot

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
        canonical_solar_forecast = await self._async_get_canonical_solar_forecast(
            reference_time=request_now
        )
        if canonical_solar_forecast is None:
            # Stamped now, like the house half's placeholder payload: there is
            # no snapshot yet rather than an old one, and "never built" is
            # already visible as the unavailable status. Reporting it stale as
            # well would put a banner on every card in the seconds between a
            # restart and the startup refresh.
            canonical_solar_forecast = {
                "status": "unavailable",
                "generatedAt": request_now.isoformat(),
                "points": [],
                "rawPoints": [],
            }

        solar_response = build_solar_forecast_response(
            canonical_solar_forecast,
            granularity=granularity,
            forecast_days=forecast_days,
            corrected_points=canonical_solar_forecast.get("correctedPoints"),
        )
        bias_correction = canonical_solar_forecast.get("biasCorrection")
        if isinstance(bias_correction, dict):
            solar_response["biasCorrection"] = deepcopy(bias_correction)
        solar_response["staleness"] = _build_forecast_staleness(
            canonical_solar_forecast.get("generatedAt"),
            reference_time=request_now,
        )
        result = {
            "solar": solar_response,
        }
        # Built per request, not read off the refresh: the price points and the
        # "price now" they carry are derived at the reference time, and a card
        # asking mid-quarter-hour must not be told the last refresh's price.
        # Only the grid half: HelmanForecastBuilder would also run the solar
        # half's same-day recorder scan, and a read has no use for it.
        raw_grid_price_forecast = GridPriceForecastBuilder(
            self._hass,
            self._active_config,
        ).build(reference_time=request_now)
        canonical_house_forecast = await self._async_get_canonical_house_forecast(
            reference_time=request_now
        )
        pipeline = await self._async_get_appliance_forecast_pipeline(
            solar_forecast=_build_corrected_solar_forecast_view(
                canonical_solar_forecast
            ),
            house_forecast=canonical_house_forecast,
            started_at=request_now,
        )
        result["house_consumption"] = build_house_forecast_response(
            pipeline.adjusted_house_forecast,
            granularity=granularity,
            forecast_days=forecast_days,
        )
        # Read off the canonical snapshot, not the adjusted view the pipeline
        # derives from it: the adjusted copy is rebuilt per request.
        result["house_consumption"]["staleness"] = _build_forecast_staleness(
            canonical_house_forecast.get("generatedAt"),
            reference_time=request_now,
            override=_build_house_profile_health(canonical_house_forecast),
        )
        canonical_battery_forecast = pipeline.battery_forecast
        grid_price_response = build_grid_price_forecast_response(
            raw_grid_price_forecast,
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

    async def _async_get_canonical_solar_forecast(
        self,
        *,
        reference_time: datetime,
    ) -> dict[str, Any] | None:
        """The cached solar snapshot, however old it is, or None.

        A pure cache read: rebuilding here would put a 56-day recorder scan on
        the path of every card open. The snapshot's age reaches the card in the
        payload's ``staleness`` block instead.
        """
        cached_solar_forecast = getattr(self, "_cached_solar_forecast", None)
        if isinstance(cached_solar_forecast, dict):
            return cached_solar_forecast
        return None

    async def _async_get_canonical_house_forecast(
        self,
        *,
        reference_time: datetime,
    ) -> dict[str, Any]:
        """The cached house snapshot, however old it is.

        Like the solar half, a pure cache read. A snapshot that no longer
        matches the current config is not old but wrong, so it is blanked and
        reported unavailable until the next refresh rebuilds it.
        """
        (
            total_energy_entity_id,
            training_window_days,
            min_history_days,
            config_fingerprint,
        ) = self._read_house_forecast_config()
        if self._has_matching_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
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
            trained_at=self._house_profile_trained_at,
            last_outcome=self._house_profile_last_outcome,
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

    def get_controllable_entities(self) -> list[ControllableEntityDict]:
        """List what Helman can drive, plus each entity's resting state.

        The card filters this against live entity state, so it reacts to state
        changes without asking the backend again.
        """
        self._refresh_climate_appliance_capabilities()
        return build_controllable_entities(
            control_config=self._read_schedule_control_config(),
            registry=self._appliances_registry,
        )

    async def async_get_entity_actual_history(
        self,
    ) -> dict[str, list[ActualHistorySlot]]:
        """What each controllable entity actually did earlier today.

        Queried per entity rather than in one sweep because that is how the
        recorder answers, and the set is small: it is the same roster the card
        already lists.
        """
        reference_time = dt_util.utcnow()
        history: dict[str, list[ActualHistorySlot]] = {}
        for entity in self.get_controllable_entities():
            history[entity["entityId"]] = await build_entity_actual_history(
                self._hass,
                entity_id=entity["entityId"],
                normal_state=entity["normalState"],
                reference_time=reference_time,
                interval_minutes=SCHEDULE_SLOT_MINUTES,
            )
        return history

    async def async_restore_normal_state(self) -> int:
        """Put everything back to rest, on explicit user request.

        This is the one path allowed to actuate while execution is disabled --
        the user asked for it from the card -- so it uses an override actuator
        rather than the gated one. It is best effort: whatever fails stays
        listed for the user to retry or handle individually.
        """
        self._refresh_climate_appliance_capabilities()
        restored = await async_apply_normal_state(
            actuator=OverrideScheduleActuator(self._hass),
            control_config=self._read_schedule_control_config(),
            registry=self._appliances_registry,
        )
        # Whatever the executor remembered about appliance state is stale now.
        self._schedule_executor.clear_appliance_memories()
        return restored

    def _refresh_climate_appliance_capabilities(self) -> None:
        refreshed_appliances = []
        changed = False

        for appliance in self._appliances_registry.appliances:
            if not isinstance(appliance, ClimateApplianceRuntime):
                refreshed_appliances.append(appliance)
                continue

            refreshed_appliance = self._resolve_climate_appliance_capabilities(appliance)
            refreshed_appliances.append(refreshed_appliance)
            if refreshed_appliance != appliance:
                changed = True

        if changed:
            self._appliances_registry = AppliancesRuntimeRegistry.from_appliances(
                refreshed_appliances
            )

    def _resolve_climate_appliance_capabilities(
        self,
        appliance: ClimateApplianceRuntime,
    ) -> ClimateApplianceRuntime:
        climate_state = self._hass.states.get(appliance.climate_entity_id)
        if climate_state is None:
            return appliance

        raw_state = getattr(climate_state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_ENTITY_STATES
        ):
            return appliance

        raw_attributes = getattr(climate_state, "attributes", {})
        if not isinstance(raw_attributes, Mapping):
            return appliance

        raw_hvac_modes = raw_attributes.get("hvac_modes")
        if not isinstance(raw_hvac_modes, (list, tuple)) or not raw_hvac_modes:
            return appliance

        hvac_modes: list[str] = []
        for raw_mode in raw_hvac_modes:
            if not isinstance(raw_mode, str) or not raw_mode.strip():
                return appliance
            hvac_modes.append(raw_mode.strip())

        supported_modes = resolve_supported_climate_modes(hvac_modes)
        stop_hvac_mode = "off" if "off" in hvac_modes else None
        return replace(
            appliance,
            supported_modes=supported_modes,
            stop_hvac_mode=stop_hvac_mode,
        )

    async def _async_normalize_schedule_document(self) -> None:
        self._refresh_climate_appliance_capabilities()
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

    def _fire_data_changed(self, kind: str) -> None:
        """Announce that something the cards draw has been rewritten.

        ``async_fire`` is synchronous and non-blocking, so the schedule write
        sites may call this from inside ``_schedule_lock`` without holding it a
        moment longer than the dict copy takes.

        No coalescing here on purpose: one automation run legitimately produces
        both a ``schedule`` and a ``plan`` event, and horizon pruning can add a
        third. Collapsing them belongs on the subscriber side, where a single
        debounce covers every emitter at once — including the ones fired by
        modules that never see this coordinator.
        """
        self._hass.bus.async_fire(EVENT_DATA_CHANGED, {"kind": kind})

    async def _save_schedule_document(self, doc: ScheduleDocument) -> None:
        await self._storage.async_save_schedule_document(schedule_document_to_dict(doc))
        # Every schedule mutation in this file funnels through here -- user
        # edits, automation results, execution toggles, pruning and cleanup --
        # so this is the one place the announcement has to live.
        self._fire_data_changed(DATA_CHANGED_KIND_SCHEDULE)

    def _build_pruned_schedule_document(
        self,
        *,
        reference_time: datetime,
    ) -> tuple[ScheduleDocument, ScheduleDocument]:
        self._refresh_climate_appliance_capabilities()
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
        return loaded_document, pruned_document

    async def _load_pruned_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        loaded_document, pruned_document = self._build_pruned_schedule_document(
            reference_time=reference_time
        )
        if pruned_document != loaded_document:
            await self._save_schedule_document(pruned_document)
        return pruned_document

    def _build_automation_working_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        _loaded_document, pruned_document = self._build_pruned_schedule_document(
            reference_time=reference_time
        )
        return pruned_document

    def _normalize_schedule_document_for_strict_write(
        self,
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
    ) -> ScheduleDocument:
        if not schedule_document.slots:
            return ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots={},
            )

        normalized_slots = normalize_slot_patch_request(
            slots=[
                ScheduleSlot(id=slot_id, domains=domains)
                for slot_id, domains in schedule_document.slots.items()
            ],
            reference_time=reference_time,
            battery_soc_bounds=self._read_battery_soc_bounds(),
            appliances_registry=self._appliances_registry,
        )
        return ScheduleDocument(
            execution_enabled=schedule_document.execution_enabled,
            slots=apply_slot_patches(stored_slots={}, slot_patches=normalized_slots),
        )

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
        self._refresh_climate_appliance_capabilities()
        return build_appliances_response(self._appliances_registry)

    def get_raw_solar_forecast_points(self) -> list[dict[str, Any]]:
        snapshot = self._cached_solar_forecast or {}
        points = snapshot.get("points")
        if isinstance(points, list):
            return points
        raw_points = snapshot.get("rawPoints")
        if isinstance(raw_points, list):
            return raw_points
        return []

    def get_corrected_solar_forecast_points(self) -> list[dict[str, Any]]:
        snapshot = self._cached_solar_forecast or {}
        corrected_points = snapshot.get("correctedPoints")
        if isinstance(corrected_points, list) and corrected_points:
            return corrected_points
        return self.get_raw_solar_forecast_points()

    def get_solar_forecast_day_total(self, day_offset: int) -> float | None:
        buckets = _bucket_points_by_local_day(self.get_corrected_solar_forecast_points())
        target_day = (dt_util.now().date() + timedelta(days=day_offset)).isoformat()
        values = buckets.get(target_day)
        if not values:
            return None
        return round(sum(values) / 1000.0, 4)

    def register_house_consumption_forecast_current_sensor(self, sensor) -> None:
        self._house_consumption_forecast_current_sensor = sensor

    def get_house_consumption_forecast_current_w(self) -> float | None:
        # Report the same house demand the battery and grid forecasts are built
        # from: the adjusted forecast, whose nonDeferrable already folds in the
        # scheduled deferrable appliances (pool, car charging, ...). The raw
        # deferrableConsumers band is the model's probabilistic account of those
        # same appliances and must not be added on top, or the recorded history
        # this sensor feeds would double-count them against solar in the
        # inspector. Fall back to the unadjusted base load only while the
        # appliance pipeline is cold — never to base + deferrableConsumers.
        pipeline = self._cached_appliance_forecast_pipeline
        forecast: dict[str, Any] | None = None
        if pipeline is not None and isinstance(
            pipeline.adjusted_house_forecast, dict
        ):
            forecast = pipeline.adjusted_house_forecast
        if not isinstance(forecast, dict) or forecast.get("status") != "available":
            forecast = self._cached_forecast
        if not isinstance(forecast, dict):
            return None
        if forecast.get("status") != "available":
            return None
        series = forecast.get("series") or []
        current_slot = forecast.get("currentSlot")
        if not series and current_slot is None:
            return None
        now_local = dt_util.as_local(dt_util.now())
        all_entries = []
        if isinstance(current_slot, dict):
            all_entries.append(current_slot)
        all_entries.extend(series if isinstance(series, list) else [])
        for entry in all_entries:
            if not isinstance(entry, dict):
                continue
            ts_raw = entry.get("timestamp")
            if not isinstance(ts_raw, str):
                continue
            slot_start = dt_util.as_local(dt_util.parse_datetime(ts_raw))
            if slot_start is None:
                continue
            slot_end = slot_start + timedelta(minutes=15)
            if slot_start <= now_local < slot_end:
                nd = entry.get("nonDeferrable") or {}
                nd_kwh = nd.get("value") if isinstance(nd, dict) else None
                if nd_kwh is None:
                    return None
                try:
                    nd_kwh = float(nd_kwh)
                except (TypeError, ValueError):
                    return None
                # Value is kWh per 15-min slot; convert to W: kWh * 1000 / 0.25 h
                return nd_kwh * 1000 / 0.25
        return None

    def get_solar_forecast_today_remaining(self) -> float | None:
        now = dt_util.now()
        total = 0.0
        found = False
        for point_time, value in _iter_local_solar_points(
            self.get_corrected_solar_forecast_points()
        ):
            if point_time.date() != now.date() or point_time < now:
                continue
            total += value
            found = True
        if not found:
            return None
        return round(total / 1000.0, 4)

    async def get_appliance_projections(self) -> ApplianceProjectionsResponseDict:
        self._refresh_climate_appliance_capabilities()
        request_now = dt_util.now()
        canonical_solar_forecast = await self._async_get_canonical_solar_forecast(
            reference_time=request_now
        )
        if canonical_solar_forecast is None:
            canonical_solar_forecast = {"status": "unavailable", "points": []}
        canonical_house_forecast = await self._async_get_canonical_house_forecast(
            reference_time=request_now
        )
        if canonical_house_forecast is None:
            return build_empty_appliance_projections_response(
                generated_at=request_now.isoformat()
            )

        plan = await self._async_get_appliance_projection_plan(
            solar_forecast=_build_corrected_solar_forecast_view(
                canonical_solar_forecast
            ),
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

    async def run_automation(
        self,
        *,
        reference_time: datetime | None = None,
        reason: str | None = None,
    ) -> "AutomationRunResult":
        from .automation.pipeline import (
            AutomationRunFailure,
            AutomationRunResult,
            AutomationRunner,
        )

        automation_config = read_automation_config(self._active_config)
        if automation_config is None:
            automation_config = AutomationConfig(enabled=False)

        run_started_at = time.perf_counter()
        try:
            result = await AutomationRunner(
                coordinator=self,
                automation_config=automation_config,
            ).run(reference_time=reference_time, run_reason=reason)
        except Exception as err:
            _LOGGER.exception("Automation runner escaped coordinator boundary")
            result = AutomationRunResult.failed(
                reason="runner_failed",
                failure=AutomationRunFailure(
                    stage="coordinator",
                    message=str(err) or err.__class__.__name__,
                ),
                duration_ms=max(0, int((time.perf_counter() - run_started_at) * 1000)),
            )
            _LOGGER.info(
                "automation run result trigger=%s outcome=%s ran=%s optimizers=%s duration_ms=%s cleanup_reason=%s cleanup_actions=%s failure_stage=%s",
                reason or "manual",
                result.reason or "completed",
                result.ran_automation,
                len(result.optimizers),
                result.duration_ms,
                None,
                0,
                result.failure.stage,
            )
        self._set_last_automation_run_result(result)
        return result

    async def _async_run_automation_trigger_request(
        self,
        request,
    ) -> None:
        await self.run_automation(
            reference_time=request.reference_time,
            reason=request.reason,
        )

    async def set_schedule(
        self,
        *,
        slots: Sequence[ScheduleSlot],
        reference_time: datetime | None = None,
        set_by: ScheduleActionSetBy | None = None,
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
            stamped_slots = [
                with_slot_set_by(slot, set_by=set_by) for slot in normalized_slots
            ]
            updated_document = ScheduleDocument(
                execution_enabled=schedule_document.execution_enabled,
                slots=apply_slot_patches(
                    stored_slots=schedule_document.slots,
                    slot_patches=stamped_slots,
                ),
            )
            if updated_document != schedule_document:
                await self._save_schedule_document(updated_document)
                document_changed = True

        if document_changed:
            await self._async_run_post_schedule_write_side_effects(
                reason="schedule_updated",
                reference_time=request_now,
            )
            if set_by == "user":
                await self._automation_triggers.request_immediate(
                    reason="user_edit",
                    reference_time=request_now,
                )

    async def _async_run_post_schedule_write_side_effects(
        self,
        *,
        reason: str,
        reference_time: datetime,
    ) -> None:
        # No cache invalidation here: the schedule signatures the pipeline read
        # computes cover every slot this write can have touched, so the next
        # card read rebuilds only if the plan it draws actually changed.
        await self._async_reconcile_schedule_execution(
            reason=reason,
            reference_time=reference_time,
        )

    async def _persist_automation_result_locked(
        self,
        *,
        automation_result: ScheduleDocument,
        reference_time: datetime | None = None,
    ) -> bool:
        request_now = reference_time or dt_util.now()
        latest_document = await self._load_pruned_schedule_document_locked(
            reference_time=request_now
        )
        normalized_automation_result = self._normalize_schedule_document_for_strict_write(
            schedule_document=ScheduleDocument(
                execution_enabled=latest_document.execution_enabled,
                slots=automation_result.slots,
            ),
            reference_time=request_now,
        )
        merged_document = merge_automation_result(
            baseline=latest_document,
            automation_result=normalized_automation_result,
        )
        canonical_document = normalize_schedule_document_for_registry(
            merged_document,
            appliances_registry=self._appliances_registry,
        )
        if canonical_document == latest_document:
            return False

        await self._save_schedule_document(canonical_document)
        return True

    async def set_schedule_execution(
        self,
        *,
        enabled: bool,
        reference_time: datetime | None = None,
    ) -> bool:
        request_now = reference_time or dt_util.now()
        should_trigger_automation_on_enable = False

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
                    should_trigger_automation_on_enable = True

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
                        await self._schedule_executor.async_stop()
                    raise
                if should_trigger_automation_on_enable:
                    await self._automation_triggers.request_immediate(
                        reason="execution_enabled",
                        reference_time=request_now,
                    )
                return True

            # Disabling execution is passive: Helman stops touching hardware and
            # leaves the inverter and every appliance exactly as they are. The
            # user restores normal state explicitly, whenever they choose, via
            # the scheduling card. Disabling therefore cannot fail and never
            # rolls back.
            #
            # The executor keeps running so its tick still drives the
            # pre-execution reality check; it just stops applying anything.
            # Runtime status is dropped right away so the card does not keep
            # showing what was executing a moment ago.
            await self._schedule_executor.async_start()
            self._schedule_executor.reset_runtime()

            if not was_enabled:
                return False

            async with self._schedule_lock:
                latest_document = await self._load_pruned_schedule_document_locked(
                    reference_time=request_now
                )
                if latest_document.execution_enabled:
                    # Keep the plan intact: automation keeps planning while
                    # execution is off, so the card and the inspectors show what
                    # Helman would be doing. Only the apply step is suppressed.
                    await self._save_schedule_document(
                        ScheduleDocument(
                            execution_enabled=False,
                            slots=latest_document.slots,
                        )
                    )

            return False

    @staticmethod
    def _build_cleaned_automation_schedule_document(
        *,
        schedule_document: ScheduleDocument,
    ) -> ScheduleDocument:
        cleaned_document = strip_automation_owned_actions(schedule_document)
        return ScheduleDocument(
            execution_enabled=schedule_document.execution_enabled,
            slots=cleaned_document.slots,
        )

    async def _async_cleanup_automation_owned_actions_if_needed(
        self,
        *,
        reference_time: datetime,
    ) -> bool:
        async with self._schedule_lock:
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=reference_time
            )
            cleaned_document = self._build_cleaned_automation_schedule_document(
                schedule_document=schedule_document,
            )
            if cleaned_document == schedule_document:
                return False
            await self._save_schedule_document(cleaned_document)
            return True

    async def _async_reconcile_schedule_execution(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        # The executor keeps running whether or not execution is enabled: its
        # tick drives the pre-execution reality check, which keeps the plan in
        # sync with current conditions even when nothing is applied. Whether
        # anything is actually applied is decided inside the reconcile, and
        # ultimately by the actuation gate.
        request_now = reference_time or dt_util.now()
        async with self._schedule_execution_lock:
            await self._schedule_executor.async_start()
            await self._schedule_executor.async_reconcile_safely(
                reason=reason,
                reference_time=request_now,
            )

    def get_automation_input_bundle(self) -> AutomationInputBundle | None:
        if self._automation_input_bundle is None:
            return None
        return AutomationInputBundle(
            original_house_forecast=deepcopy(
                self._automation_input_bundle.original_house_forecast
            ),
            solar_forecast=deepcopy(self._automation_input_bundle.solar_forecast),
            grid_price_forecast=deepcopy(
                self._automation_input_bundle.grid_price_forecast
            ),
            when_active_hourly_energy_kwh_by_appliance_id=deepcopy(
                self._automation_input_bundle.when_active_hourly_energy_kwh_by_appliance_id
            ),
            runtime_hours_by_appliance_id_by_local_date=deepcopy(
                self._automation_input_bundle.runtime_hours_by_appliance_id_by_local_date
            ),
        )

    async def _async_refresh_forecast(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        """The one way to rebuild the forecast. Never called from a read path.

        Single-flight: the writers — the quarter-hour timer, startup, a config
        save and the bias events — fire independently of each other, and a
        bias-trained event landing on a quarter hour would otherwise run two
        56-day recorder scans at once. A caller arriving while a rebuild is in
        flight joins it and returns when it does. The joiner does not adopt its
        failure: the run under way already logs it, and the joiner has no
        recovery of its own to attempt.
        """
        in_flight = self._forecast_refresh_task
        if in_flight is not None and not in_flight.done():
            await asyncio.wait({in_flight})
            return

        task = self._create_tracked_refresh_task(
            self._async_run_forecast_refresh(
                reason=reason,
                reference_time=reference_time,
            )
        )
        self._forecast_refresh_task = task
        try:
            await task
        finally:
            if self._forecast_refresh_task is task:
                self._forecast_refresh_task = None

    async def _async_run_forecast_refresh(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        """Rebuild the snapshots, then ask for a re-plan if one is warranted."""
        request_now = reference_time or dt_util.now()
        refresh_result = await self._async_build_forecast_snapshots(
            reference_time=request_now
        )

        automation_config = read_automation_config(self._active_config)
        if automation_config is None:
            automation_config = AutomationConfig(enabled=False)

        async with self._schedule_lock:
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=request_now
            )

        if not (automation_config.enabled and automation_config.execution_optimizers):
            if not has_automation_owned_actions(schedule_document):
                return
        elif not (
            refresh_result.forecast_refreshed and refresh_result.bundle_ready
        ):
            return

        await self._automation_triggers.request_debounced(
            reason=reason,
            reference_time=request_now,
        )

    async def _async_build_forecast_snapshots(
        self, *, reference_time: datetime | None = None
    ) -> _ForecastRefreshResult:
        """Build new forecast snapshots, cache them, and persist them."""
        request_now = reference_time or dt_util.now()
        try:
            builder = ConsumptionForecastBuilder(
                self._hass, self._active_config, self._slot_history
            )
            house_snapshot = await builder.build(
                reference_time=request_now,
                profile=self._house_profile,
                trained_at=self._house_profile_trained_at,
                last_outcome=self._house_profile_last_outcome,
                forecast_days=MAX_FORECAST_DAYS,
                padding_slots=ConsumptionForecastBuilder._MAX_ALIGNMENT_PADDING_SLOTS,
            )
            # One HelmanForecastBuilder.build() per refresh: its solar half
            # feeds the canonical snapshot, its grid half the automation bundle.
            raw_forecast = await HelmanForecastBuilder(
                self._hass,
                self._active_config,
            ).build(reference_time=request_now)
            solar_snapshot = self._build_canonical_solar_forecast(
                raw_forecast["solar"],
                reference_time=request_now,
            )
            solar_degraded = self._is_degraded_solar_rebuild(
                solar_snapshot,
                self._cached_solar_forecast,
            )
            if solar_degraded:
                # Keep what we already have, including through the save below —
                # the store only skips a write when the hash is unchanged, so
                # persisting the empty snapshot would lose the good one for
                # good. The preserved snapshot keeps its old ``generatedAt``,
                # which is what makes the staleness banner report this rather
                # than the card silently going blank.
                _LOGGER.debug(
                    "Solar forecast rebuild came back unavailable; keeping the "
                    "previous snapshot"
                )
                solar_snapshot = self._cached_solar_forecast
            self._cached_forecast = house_snapshot
            self._cached_solar_forecast = solar_snapshot
            self._invalidate_battery_forecast_cache()
            save_snapshots = getattr(self._storage, "async_save_snapshots", None)
            if save_snapshots is not None:
                await save_snapshots(
                    house_snapshot=house_snapshot,
                    solar_snapshot=solar_snapshot,
                )
            else:
                await self._storage.async_save_snapshot(house_snapshot)
            # Warm the appliance pipeline before publishing so the house
            # consumption sensor reports the adjusted (base + scheduled) demand,
            # keeping the recorded history it feeds aligned with the battery and
            # grid forecasts. Never let a pipeline failure block the refresh.
            await self._async_warm_appliance_pipeline(
                house_forecast=house_snapshot,
                solar_snapshot=solar_snapshot,
                started_at=request_now,
            )
            self._publish_solar_forecast_entities()
        except Exception:
            _LOGGER.exception("Error refreshing house consumption forecast")
            return _ForecastRefreshResult(
                forecast_refreshed=False,
                bundle_ready=False,
            )

        bundle_ready = await self._async_refresh_automation_input_bundle(
            reference_time=request_now,
            house_forecast=house_snapshot,
            raw_forecast=raw_forecast,
        )
        return _ForecastRefreshResult(
            forecast_refreshed=not solar_degraded,
            bundle_ready=bundle_ready,
        )

    @staticmethod
    def _is_degraded_solar_rebuild(
        new_snapshot: dict[str, Any],
        cached_snapshot: dict[str, Any] | None,
    ) -> bool:
        """Would adopting ``new_snapshot`` throw away a forecast we still have?

        Only an outright ``unavailable`` build with nothing in it counts. That
        is the shape a missing provider produces — its entities are absent, so
        not one of them yields a point — and it carries no information at all,
        which is what makes preserving the previous result strictly better.

        ``partial`` deliberately does not count. It means some of the configured
        daily energy entities have points and some do not, which is the normal
        steady state whenever the provider publishes fewer days ahead than there
        are entities: a partial build still carries today and the days that
        matter most, and it is the only build that configuration will ever
        produce. Treating it as degraded would freeze the forecast at the first
        good build and never move again.
        """
        if cached_snapshot is None:
            return False
        if not cached_snapshot.get("points"):
            return False
        return (
            new_snapshot.get("status") == "unavailable"
            and not new_snapshot.get("points")
        )

    async def _async_warm_appliance_pipeline(
        self,
        *,
        house_forecast: dict[str, Any],
        solar_snapshot: dict[str, Any] | None,
        started_at: datetime,
    ) -> None:
        """Build the appliance forecast pipeline so its adjusted house forecast
        is available to the house consumption sensor at publish time.

        Best-effort: a missing or unavailable forecast just leaves the pipeline
        cold, and the sensor falls back to the base load.
        """
        if house_forecast.get("status") != "available":
            return
        solar_forecast = (
            _build_corrected_solar_forecast_view(solar_snapshot)
            if isinstance(solar_snapshot, dict)
            else {"status": "unavailable", "points": []}
        )
        try:
            await self._async_get_appliance_forecast_pipeline(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
            )
        except Exception:
            _LOGGER.exception("Failed to warm appliance forecast pipeline")

    async def _async_refresh_automation_input_bundle(
        self,
        *,
        reference_time: datetime,
        house_forecast: dict[str, Any],
        raw_forecast: dict[str, Any],
    ) -> bool:
        try:
            bundle = await self._async_build_automation_input_bundle(
                reference_time=reference_time,
                house_forecast=house_forecast,
                raw_forecast=raw_forecast,
            )
        except Exception:
            _LOGGER.exception("Error refreshing automation input bundle")
            return False

        if bundle is not None:
            self._automation_input_bundle = bundle
            return True
        return False

    async def _async_build_automation_input_bundle(
        self,
        *,
        reference_time: datetime,
        house_forecast: dict[str, Any],
        raw_forecast: dict[str, Any],
    ) -> AutomationInputBundle | None:
        if house_forecast.get("status") != "available":
            return None

        solar_forecast = await self._async_get_canonical_solar_forecast(
            reference_time=reference_time
        )
        if solar_forecast is None:
            solar_forecast = build_solar_forecast_response(
                raw_forecast["solar"],
                granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
                forecast_days=MAX_FORECAST_DAYS,
            )
        return AutomationInputBundle(
            original_house_forecast=deepcopy(house_forecast),
            solar_forecast=_build_corrected_solar_forecast_view(solar_forecast),
            grid_price_forecast=build_grid_price_forecast_response(
                raw_forecast["grid"],
                granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
                forecast_days=MAX_FORECAST_DAYS,
            ),
            when_active_hourly_energy_kwh_by_appliance_id=(
                self._resolve_when_active_hourly_energy_kwh_by_appliance_id()
            ),
            runtime_hours_by_appliance_id_by_local_date=(
                await self._async_resolve_runtime_hours_by_appliance_id_by_local_date(
                    reference_time=reference_time
                )
            ),
        )

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

    async def _async_get_battery_forecast_snapshot(self) -> dict[str, Any] | None:
        """Return the battery forecast snapshot for the solar bias inspector.

        Goes through the forecast pipeline rather than reading the cache
        directly, so the inspector does not depend on another consumer having
        called get_forecast() first. Reuses the pipeline cache when it is warm.
        """
        request_now = dt_util.now()
        canonical_solar_forecast = await self._async_get_canonical_solar_forecast(
            reference_time=request_now
        )
        if canonical_solar_forecast is None:
            canonical_solar_forecast = {"status": "unavailable", "points": []}
        canonical_house_forecast = await self._async_get_canonical_house_forecast(
            reference_time=request_now
        )
        if canonical_house_forecast is None:
            return None

        return await self._async_get_battery_forecast(
            solar_forecast=_build_corrected_solar_forecast_view(
                canonical_solar_forecast
            ),
            house_forecast=canonical_house_forecast,
            started_at=request_now,
        )

    def _get_adjusted_house_forecast_snapshot(self) -> dict[str, Any] | None:
        """Return the house forecast the battery simulation ran against.

        The inspector draws house demand beside the battery and grid bands the
        simulation produced, so it has to read the same series the simulation
        did: the adjusted forecast, whose nonDeferrable already carries the
        scheduled appliance demand. The original snapshot would name a
        different house — its nonDeferrable excludes the deferrable consumers,
        and its own forecast of them need not fall in the slots the planner
        scheduled them for — and the two stacks would not balance.

        Reads the pipeline the caller has already built through
        _async_get_battery_forecast_snapshot; there is no adjusted forecast to
        speak of before that.
        """
        pipeline = self._cached_appliance_forecast_pipeline
        if pipeline is None:
            return None
        return pipeline.adjusted_house_forecast

    def _build_forecast_schedule_documents(
        self,
        *,
        schedule_document: ScheduleDocument,
    ) -> _ForecastScheduleDocuments:
        # The single place ``execution_enabled`` gates the forecast, for both
        # domains at once.
        #
        # With execution off Helman actuates nothing — the executor returns
        # before it touches either the inverter or an appliance -- so the
        # forecast projects the unmanaged house: no scheduled inverter action,
        # and no scheduled appliance run either. The card's schedule strips go
        # on showing the plan; the curves show what will happen while it is not
        # being executed, and the two are read as plan against reality.
        #
        # Gating both documents here rather than deeper down is what keeps that
        # honest. Emptying only the inverter side — which is what the overlay
        # builder used to do on its own -- left the battery unmanaged while the
        # house forecast still carried appliance runs that could not happen, a
        # trajectory that was neither the plan nor the reality. It also keeps
        # both forecast cache signatures correct for free: they are derived from
        # these documents, so an execution toggle changes them without either
        # signature having to know the flag exists.
        if not schedule_document.execution_enabled:
            unmanaged = ScheduleDocument(execution_enabled=False, slots={})
            return _ForecastScheduleDocuments(
                forecast_schedule_document=unmanaged,
                projection_schedule_document=unmanaged,
            )
        return _ForecastScheduleDocuments(
            forecast_schedule_document=self._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            ),
            projection_schedule_document=schedule_document,
        )

    async def _async_gather_compute_inputs(
        self,
        *,
        started_at: datetime,
        live_state: Any = _LIVE_STATE_UNSET,
        include_condition_flags: bool = False,
    ) -> ComputeInputs:
        """Read the run-invariant live values a forecast rebuild needs.

        Runs on the event loop (``hass.states`` + recorder), once per run, so
        the compute path can stay pure. A caller that has already read the live
        battery state passes it in via ``live_state`` to avoid a second read.
        ``include_condition_flags`` evaluates optimizer execution conditions —
        only the automation pipeline needs them; forecast/projection paths skip
        the work. See :class:`ComputeInputs`.
        """
        entity_config = read_battery_entity_config(self._active_config)
        battery_live_state = None
        battery_actual_history: list[dict[str, Any]] = []
        if entity_config is not None:
            battery_live_state = (
                read_battery_live_state(self._hass, entity_config)
                if live_state is _LIVE_STATE_UNSET
                else live_state
            )
            if battery_live_state is not None:
                battery_actual_history = await self._async_build_battery_actual_history(
                    entity_config=entity_config,
                    started_at=started_at,
                )
        custom_condition_results = (
            await self._async_evaluate_optimizer_conditions()
            if include_condition_flags
            else {}
        )
        return ComputeInputs(
            battery_live_state=battery_live_state,
            battery_actual_history=battery_actual_history,
            vehicle_remaining_capacity_kwh_by_vehicle_id=(
                read_vehicle_remaining_capacity_kwh_by_vehicle_id(
                    self._hass, self._appliances_registry
                )
            ),
            condition_met_by_optimizer_id=_condition_met_map(custom_condition_results),
            custom_condition_results_by_optimizer_id=custom_condition_results,
            appliance_active_by_id=self._read_appliance_active_by_id(),
        )

    def _read_appliance_active_by_id(self) -> dict[str, bool]:
        """Which appliances are running right now, from live state.

        Uses the same entity/active-state pair the recorder runtime query uses
        (:func:`_resolve_runtime_entity_and_states`), so "running" means the
        same thing to the optimizer as the delivered hours it plans against.
        An appliance whose entity is missing or unavailable counts as not
        running — the pin it feeds may only ever preserve a run, so failing
        this way loses smoothness, never control.
        """
        active_by_id: dict[str, bool] = {}
        for appliance in self._iter_automation_candidate_appliances():
            entity_id, active_states = _resolve_runtime_entity_and_states(appliance)
            if entity_id is None:
                continue
            state = self._hass.states.get(entity_id)
            raw_state = getattr(state, "state", None)
            active_by_id[appliance.id] = raw_state in active_states
        return active_by_id

    async def _async_evaluate_optimizer_conditions(
        self,
    ) -> dict[str, tuple[CustomConditionGroupResult, ...]]:
        """Evaluate every condition group's ``custom`` conditions against live state.

        Runs on the event loop (conditions read ``hass.states``) so the result
        can be frozen into ``ComputeInputs`` for the pure optimizer loop. The
        value is one :class:`CustomConditionGroupResult` per group, in config
        order, each holding one result per configured ``custom`` entry plus the
        group aggregate — the AND over its entries, ``True`` for a group with no
        custom conditions. An optimizer id absent from the map means "not
        evaluated", which counts as met.

        Fail-closed, now per entry: an entry that could not be built or that
        raised while evaluating is ``met=False, errored=True``, so it still drags
        the group aggregate false while staying distinguishable from a condition
        that plainly evaluated to false.
        """
        automation_config = read_automation_config(self._active_config)
        if automation_config is None:
            self._prune_optimizer_condition_checkers(active_keys=set())
            return {}

        results: dict[str, tuple[CustomConditionGroupResult, ...]] = {}
        active_keys: set[tuple[str, int]] = set()
        for optimizer in automation_config.optimizers:
            group_results: list[CustomConditionGroupResult] = []
            for group in optimizer.conditions:
                if not group.custom:
                    # No custom conditions is unconditionally met — and must not
                    # build a checker, which would evaluate an empty AND anyway.
                    group_results.append(
                        CustomConditionGroupResult(index=group.index, met=True)
                    )
                    continue
                key = (optimizer.id, group.index)
                active_keys.add(key)
                checkers = await self._ensure_optimizer_condition_checkers(key, group)
                entries = tuple(
                    self._evaluate_optimizer_condition(checker, key, entry_index)
                    for entry_index, checker in enumerate(checkers)
                )
                group_results.append(
                    CustomConditionGroupResult(
                        index=group.index,
                        # The AND over the entries, exactly what the single
                        # combined checker used to evaluate.
                        met=all(entry.met for entry in entries),
                        errored=any(entry.errored for entry in entries),
                        entries=entries,
                    )
                )
            results[optimizer.id] = tuple(group_results)
        self._prune_optimizer_condition_checkers(active_keys=active_keys)
        return results

    async def _ensure_optimizer_condition_checkers(
        self, key: tuple[str, int], group: "ConditionGroup"
    ) -> tuple[Any, ...]:
        """One checker per ``custom`` entry, cached until the group's config changes."""
        cached = self._optimizer_condition_checkers.get(key)
        if cached is not None and cached[0] == group.custom:
            return cached[1]
        if cached is not None:
            self._unload_optimizer_condition_checkers(cached[1])
        checkers = tuple(
            [
                await self._build_optimizer_condition_checker(
                    key=key,
                    entry_index=entry_index,
                    condition_config=[entry],
                )
                for entry_index, entry in enumerate(group.custom)
            ]
        )
        self._optimizer_condition_checkers[key] = (group.custom, checkers)
        return checkers

    async def _build_optimizer_condition_checker(
        self,
        *,
        key: tuple[str, int],
        entry_index: int,
        condition_config: list[dict[str, Any]],
    ) -> Any:
        from homeassistant.helpers import condition as ha_condition
        from homeassistant.helpers import config_validation as cv

        label = f"optimizer:{key[0]}#{key[1]}[{entry_index}]"
        try:
            validated = []
            for entry in condition_config:
                # cv.CONDITION_SCHEMA coerces built-in literals (e.g. a ``time``
                # condition's "18:00:00" -> datetime.time). async_validate alone
                # only coerces state/numeric_state, so a bare ``time`` literal
                # would survive as a str and HA would misread it as an entity id.
                # async_validate_condition_config then resolves platform/async
                # conditions (device, etc.).
                coerced = cv.CONDITION_SCHEMA(dict(entry))
                validated.append(
                    await ha_condition.async_validate_condition_config(
                        self._hass, coerced
                    )
                )
            return await ha_condition.async_conditions_from_config(
                self._hass, validated, _LOGGER, label
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build custom conditions for %s; treating as not met",
                label,
            )
            return None

    def _evaluate_optimizer_condition(
        self, checker: Any, key: tuple[str, int], entry_index: int
    ) -> CustomConditionResult:
        """Evaluate one ``custom`` entry. Build/eval failure is met=False + errored."""
        if checker is None:
            return CustomConditionResult(met=False, errored=True)
        try:
            return CustomConditionResult(met=bool(checker.async_check()))
        except Exception:
            _LOGGER.debug(
                "Custom condition %d for optimizer %s group %d could not be "
                "evaluated; treating as not met",
                entry_index,
                key[0],
                key[1],
                exc_info=True,
            )
            return CustomConditionResult(met=False, errored=True)

    def _prune_optimizer_condition_checkers(
        self, *, active_keys: set[tuple[str, int]]
    ) -> None:
        for key in list(self._optimizer_condition_checkers):
            if key in active_keys:
                continue
            _config, checkers = self._optimizer_condition_checkers.pop(key)
            self._unload_optimizer_condition_checkers(checkers)

    @classmethod
    def _unload_optimizer_condition_checkers(cls, checkers: tuple[Any, ...]) -> None:
        for checker in checkers:
            cls._unload_optimizer_condition_checker(checker)

    @staticmethod
    def _unload_optimizer_condition_checker(checker: Any) -> None:
        if checker is None:
            return
        try:
            checker.async_unload()
        except Exception:
            _LOGGER.debug("Failed to unload condition checker", exc_info=True)

    async def _async_build_battery_actual_history(
        self, *, entity_config: Any, started_at: datetime
    ) -> list[dict[str, Any]]:
        # Deferred import: keeps the recorder-history module out of coordinator's
        # top-level imports so test harnesses that stub the battery builder (and
        # only partially stub recorder_hourly_series) still import the coordinator.
        from .battery_actual_history_builder import build_battery_actual_history

        try:
            return await build_battery_actual_history(
                self._hass,
                entity_config.capacity_entity_id,
                started_at,
                interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build battery actual history for %s",
                entity_config.capacity_entity_id,
            )
            return []

    async def _async_build_forecast_rebuild(
        self,
        *,
        solar_forecast: dict[str, Any],
        original_house_forecast: dict[str, Any],
        started_at: datetime,
        forecast_schedule_document: ScheduleDocument,
        projection_schedule_document: ScheduleDocument,
        when_active_hourly_energy_kwh_by_appliance_id: dict[str, float | None] | None,
        grid_price_forecast: dict[str, Any] | None = None,
        compute_inputs: ComputeInputs | None = None,
    ) -> _ForecastRebuildSnapshot:
        """Async wrapper: gather I/O (unless supplied), then run the pure core."""
        if compute_inputs is None:
            compute_inputs = await self._async_gather_compute_inputs(
                started_at=started_at
            )
        return self._build_forecast_rebuild_pure(
            solar_forecast=solar_forecast,
            original_house_forecast=original_house_forecast,
            started_at=started_at,
            forecast_schedule_document=forecast_schedule_document,
            projection_schedule_document=projection_schedule_document,
            when_active_hourly_energy_kwh_by_appliance_id=(
                when_active_hourly_energy_kwh_by_appliance_id
            ),
            grid_price_forecast=grid_price_forecast,
            compute_inputs=compute_inputs,
        )

    def _build_battery_forecast_sync(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        forecast_days: int,
        schedule_overlay: ScheduleForecastOverlay | None,
        live_state: Any,
        actual_history: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Synchronous battery-forecast seam used by the pure rebuild core.

        The live battery state and recorder history are pre-gathered, so this
        never touches ``hass`` or the recorder.
        """
        return BatteryCapacityForecastBuilder(self._active_config).build_with_history(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
            forecast_days=forecast_days,
            schedule_overlay=schedule_overlay,
            live_state=live_state,
            actual_history=actual_history,
        )

    def _build_forecast_rebuild_pure(
        self,
        *,
        solar_forecast: dict[str, Any],
        original_house_forecast: dict[str, Any],
        started_at: datetime,
        forecast_schedule_document: ScheduleDocument,
        projection_schedule_document: ScheduleDocument,
        when_active_hourly_energy_kwh_by_appliance_id: dict[str, float | None] | None,
        compute_inputs: ComputeInputs,
        grid_price_forecast: dict[str, Any] | None = None,
    ) -> _ForecastRebuildSnapshot:
        """Pure, synchronous forecast rebuild.

        Never touches ``hass`` or the recorder — every live value comes from
        ``compute_inputs`` — so it is safe to run in an executor.
        """
        input_bundle = build_projection_input_bundle(
            solar_forecast=solar_forecast,
            house_forecast=original_house_forecast,
            reference_time=started_at,
        )
        projection_plan = build_appliance_projection_plan(
            generated_at=started_at.isoformat(),
            registry=self._appliances_registry,
            schedule_document=projection_schedule_document,
            inputs=input_bundle,
            hass=None,
            reference_time=started_at,
            when_active_hourly_energy_kwh_by_appliance_id=(
                when_active_hourly_energy_kwh_by_appliance_id
            ),
            vehicle_remaining_capacity_kwh_by_vehicle_id=(
                compute_inputs.vehicle_remaining_capacity_kwh_by_vehicle_id
            ),
        )
        adjusted_house_forecast = build_adjusted_house_forecast(
            house_forecast=original_house_forecast,
            demand_points=projection_plan.demand_points,
        )
        schedule_overlay = self._build_battery_forecast_schedule_overlay(
            schedule_document=forecast_schedule_document,
            reference_time=started_at,
        )
        battery_forecast = self._build_battery_forecast_sync(
            solar_forecast=solar_forecast,
            house_forecast=adjusted_house_forecast,
            started_at=started_at,
            forecast_days=MAX_FORECAST_DAYS,
            schedule_overlay=schedule_overlay,
            live_state=compute_inputs.battery_live_state,
            actual_history=compute_inputs.battery_actual_history,
        )
        grid_forecast = (
            None
            if grid_price_forecast is None
            else _build_grid_forecast_snapshot_with_prices(
                battery_forecast=battery_forecast,
                grid_price_forecast=grid_price_forecast,
            )
        )
        return _ForecastRebuildSnapshot(
            adjusted_house_forecast=adjusted_house_forecast,
            battery_forecast=battery_forecast,
            projection_plan=projection_plan,
            grid_forecast=grid_forecast,
            schedule_overlay=schedule_overlay,
        )

    async def async_resolve_day_contexts(
        self,
        *,
        snapshot: OptimizationSnapshot,
        reference_time: datetime,
    ) -> dict[date, DayContext]:
        """Build, freeze, and return the per-calendar-day contexts (A3/A4).

        Computed once per automation run from the initial (baseline) snapshot.
        Volatile fields are recomputed live; classification and the day-min
        window are pinned via the freeze store so a rule cannot flip mid-day.
        """
        automation_config = read_automation_config(self._active_config)
        if automation_config is None:
            day_context_config = AutomationConfig().day_context
        else:
            day_context_config = automation_config.day_context

        battery_series = snapshot.battery_forecast.get("series")
        if not isinstance(battery_series, list):
            battery_series = []
        battery_state = snapshot.context.battery_state
        battery_max_soc = battery_state.max_soc if battery_state is not None else None

        frozen_overrides = await self._day_context_store.async_load()
        day_contexts = build_day_contexts(
            battery_series=battery_series,
            export_price_points=snapshot.context.export_price_forecast.get("points", []),
            import_price_points=snapshot.context.import_price_forecast.get("points", []),
            battery_max_soc=battery_max_soc,
            deficit_below_ratio=day_context_config.deficit_below_ratio,
            surplus_above_ratio=day_context_config.surplus_above_ratio,
            frozen_overrides=frozen_overrides,
        )
        await self._day_context_store.async_freeze_and_prune(
            computed={
                local_date: FrozenDayContext(
                    classification=day_context.classification,
                    day_min_window=day_context.day_min_window,
                )
                for local_date, day_context in day_contexts.items()
            },
            today=dt_util.as_local(reference_time).date(),
        )
        return day_contexts

    async def _build_automation_snapshot_from_schedule_locked(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        day_contexts: dict[date, DayContext] | None = None,
        compute_inputs: ComputeInputs | None = None,
    ) -> OptimizationSnapshot:
        """Async wrapper: gather the run-invariant live inputs once (unless the
        caller already has them), then build the snapshot with the pure core."""
        if compute_inputs is None:
            compute_inputs = await self._async_gather_compute_inputs(
                started_at=reference_time,
                include_condition_flags=True,
            )
        return self._build_automation_snapshot_from_schedule_pure(
            schedule_document=schedule_document,
            input_bundle=input_bundle,
            reference_time=reference_time,
            day_contexts=day_contexts,
            compute_inputs=compute_inputs,
        )

    def _build_automation_snapshot_from_schedule_pure(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        day_contexts: dict[date, DayContext] | None = None,
        compute_inputs: ComputeInputs,
    ) -> OptimizationSnapshot:
        """Pure, synchronous snapshot build.

        Every live value comes from ``compute_inputs`` and every helper it calls
        is hass-free, so this is safe to run in an executor.
        """
        # Resource accounting sees only committed actions: candidate actions
        # (placed by optimizers whose execution condition is not met) are
        # stripped here so their demand/battery draw frees up for downstream
        # optimizers. They remain in ``snapshot.schedule`` for display and
        # execution/promotion.
        schedule_documents = self._build_forecast_schedule_documents(
            schedule_document=strip_candidate_actions(schedule_document)
        )
        rebuild = self._build_forecast_rebuild_pure(
            solar_forecast=input_bundle.solar_forecast,
            original_house_forecast=input_bundle.original_house_forecast,
            started_at=reference_time,
            forecast_schedule_document=schedule_documents.forecast_schedule_document,
            projection_schedule_document=schedule_documents.projection_schedule_document,
            when_active_hourly_energy_kwh_by_appliance_id=(
                input_bundle.when_active_hourly_energy_kwh_by_appliance_id
            ),
            grid_price_forecast=input_bundle.grid_price_forecast,
            compute_inputs=compute_inputs,
        )
        if rebuild.grid_forecast is None:
            raise RuntimeError("Automation snapshot rebuild is missing grid forecast")

        battery_state = compute_inputs.battery_live_state

        battery_settings = read_battery_forecast_settings(self._active_config)
        battery_max_charge_power_kw = (
            battery_settings.max_charge_power_w / 1000
            if battery_settings.max_charge_power_w is not None
            else None
        )
        battery_max_discharge_power_kw = (
            battery_settings.max_discharge_power_w / 1000
            if battery_settings.max_discharge_power_w is not None
            else None
        )
        battery_usable_capacity_kwh = (
            battery_state.nominal_capacity_kwh if battery_state is not None else None
        )

        return OptimizationSnapshot(
            schedule=deepcopy(schedule_document),
            adjusted_house_forecast=deepcopy(rebuild.adjusted_house_forecast),
            battery_forecast=deepcopy(rebuild.battery_forecast),
            grid_forecast=deepcopy(rebuild.grid_forecast),
            # Not deepcopied: a frozen dataclass of frozen slots, and the
            # optimizers only read it.
            schedule_overlay=rebuild.schedule_overlay,
            context=OptimizationContext(
                now=reference_time,
                battery_state=battery_state,
                solar_forecast=deepcopy(input_bundle.solar_forecast),
                import_price_forecast=_build_price_channel_snapshot(
                    grid_price_forecast=input_bundle.grid_price_forecast,
                    unit_field="importPriceUnit",
                    current_price_field="currentImportPrice",
                    points_field="importPricePoints",
                ),
                export_price_forecast=_build_price_channel_snapshot(
                    grid_price_forecast=input_bundle.grid_price_forecast,
                    unit_field="exportPriceUnit",
                    current_price_field="currentExportPrice",
                    points_field="exportPricePoints",
                ),
                appliance_registry=self._appliances_registry,
                when_active_hourly_energy_kwh_by_appliance_id=deepcopy(
                    input_bundle.when_active_hourly_energy_kwh_by_appliance_id
                ),
                battery_max_charge_power_kw=battery_max_charge_power_kw,
                battery_usable_capacity_kwh=battery_usable_capacity_kwh,
                battery_charge_efficiency=battery_settings.charge_efficiency,
                battery_max_discharge_power_kw=battery_max_discharge_power_kw,
                battery_discharge_efficiency=battery_settings.discharge_efficiency,
                runtime_hours_by_appliance_id_by_local_date=deepcopy(
                    input_bundle.runtime_hours_by_appliance_id_by_local_date
                ),
                day_contexts=dict(day_contexts) if day_contexts else {},
                condition_met_by_optimizer_id=dict(
                    compute_inputs.condition_met_by_optimizer_id
                ),
                custom_condition_results_by_optimizer_id=dict(
                    compute_inputs.custom_condition_results_by_optimizer_id
                ),
                appliance_active_by_id=dict(compute_inputs.appliance_active_by_id),
            ),
        )

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
        # Candidate actions (placed by optimizers whose execution condition is
        # not met) are kept in the stored schedule for display/promotion but must
        # not consume resources. Strip them here so the per-appliance projection,
        # the adjusted house forecast, and the battery/grid simulation this
        # pipeline builds all exclude their demand — matching the candidate-free
        # view the automation optimization snapshot already accounts against.
        schedule_document = strip_candidate_actions(schedule_document)
        schedule_documents = self._build_forecast_schedule_documents(
            schedule_document=schedule_document
        )
        forecast_schedule_document = schedule_documents.forecast_schedule_document
        projection_schedule_document = schedule_documents.projection_schedule_document
        # Read the live battery state once per run and reuse it for both the
        # effective-signature cache key and the forecast rebuild's gather.
        battery_entity_config = read_battery_entity_config(self._active_config)
        run_live_state = (
            read_battery_live_state(self._hass, battery_entity_config)
            if battery_entity_config is not None
            else None
        )
        schedule_signature = self._build_battery_forecast_schedule_signature(
            forecast_schedule_document
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
                live_state=run_live_state,
            )
        )
        if self._has_valid_battery_forecast_cache(
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
            schedule_signature=schedule_signature,
            appliance_schedule_signature=appliance_schedule_signature,
            schedule_effective_signature=schedule_effective_signature,
        ):
            if self._cached_appliance_forecast_pipeline is None:
                raise RuntimeError("Forecast pipeline cache is missing shared snapshot")
            return self._cached_appliance_forecast_pipeline

        history_hourly_energy_kwh_by_appliance_id = (
            self._build_history_projection_hourly_energy_by_appliance_id(
                schedule_document=projection_schedule_document,
            )
        )
        compute_inputs = await self._async_gather_compute_inputs(
            started_at=started_at,
            live_state=run_live_state,
        )
        rebuild = await self._async_build_forecast_rebuild(
            solar_forecast=solar_forecast,
            original_house_forecast=house_forecast,
            started_at=started_at,
            forecast_schedule_document=forecast_schedule_document,
            projection_schedule_document=projection_schedule_document,
            when_active_hourly_energy_kwh_by_appliance_id=(
                history_hourly_energy_kwh_by_appliance_id
            ),
            compute_inputs=compute_inputs,
        )
        pipeline = _ApplianceForecastPipelineSnapshot(
            started_at=started_at,
            original_house_forecast=deepcopy(house_forecast),
            adjusted_house_forecast=rebuild.adjusted_house_forecast,
            projection_plan=rebuild.projection_plan,
            battery_forecast=rebuild.battery_forecast,
        )
        self._store_battery_forecast_cache(
            pipeline=pipeline,
            solar_forecast=solar_forecast,
            house_forecast=house_forecast,
            started_at=started_at,
            schedule_signature=schedule_signature,
            appliance_schedule_signature=appliance_schedule_signature,
            schedule_effective_signature=schedule_effective_signature,
        )
        self._record_battery_forecast_history(
            rebuild.battery_forecast, started_at=started_at
        )
        return pipeline

    def _record_battery_forecast_history(
        self, battery_forecast: dict[str, Any] | None, *, started_at: datetime
    ) -> None:
        """Archive today's forecast SoC and net grid slots before they elapse.

        Only a fresh build reaches here, so the archive keeps the last forecast
        made for each slot while it was still ahead of the clock.
        """
        if self._battery_forecast_history is None:
            return
        try:
            self._battery_forecast_history.record_snapshot(
                battery_forecast,
                local_now=dt_util.as_local(started_at),
                timezone=ZoneInfo(str(self._hass.config.time_zone)),
            )
        except Exception:
            _LOGGER.exception("Failed to record battery forecast history")

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

    @staticmethod
    def _build_battery_forecast_schedule_signature(
        schedule_document: ScheduleDocument,
    ) -> _BatteryForecastScheduleSignature:
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
        control_config = self._read_schedule_control_config()
        if control_config is None:
            return schedule_document

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
        live_state: Any = _LIVE_STATE_UNSET,
    ) -> tuple[str, str, int | None, str, str] | None:
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

        if live_state is _LIVE_STATE_UNSET:
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
        schedule_signature: _BatteryForecastScheduleSignature,
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
        schedule_signature: _BatteryForecastScheduleSignature,
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

    def _build_history_projection_hourly_energy_by_appliance_id(
        self,
        *,
        schedule_document: ScheduleDocument,
    ) -> dict[str, float | None]:
        """Stored estimates for the scheduled ``history_average`` appliances.

        Synchronous, and that is the point: this feeds the appliance projection
        rebuild, which ``get_forecast`` awaits on the websocket path. It used to
        issue two 30-day recorder queries per appliance right here, so a card
        refresh — or a slot edit, which invalidates the pipeline cache — could
        block for seconds on a cold read. The nightly job owns that read now.

        ``None`` for an appliance with no stored estimate, which is the value
        the projection already reads as "use the configured hourly energy".
        """
        return {
            appliance.id: self._appliance_energy_estimates.get(appliance.id)
            for appliance in self._iter_projected_history_appliances(
                schedule_document=schedule_document
            )
        }

    def _resolve_when_active_hourly_energy_kwh_by_appliance_id(
        self,
    ) -> dict[str, float]:
        """Per-appliance when-active demand for the automation input bundle.

        Every candidate appliance gets an entry, ``history_average`` or not:
        optimizers and conditions read this map by appliance id and a missing key
        is indistinguishable from an unavailable rail. An appliance on a fixed
        strategy, or one whose estimate has not been trained, answers with its
        configured ``hourly_energy_kwh``.
        """
        return {
            appliance.id: self._resolve_when_active_hourly_energy(appliance)
            for appliance in self._iter_automation_candidate_appliances()
        }

    def _resolve_when_active_hourly_energy(
        self,
        appliance: GenericApplianceRuntime | ClimateApplianceRuntime,
    ) -> float:
        if not appliance.uses_history_average:
            return appliance.hourly_energy_kwh
        estimate = self._appliance_energy_estimates.get(appliance.id)
        if estimate is None or estimate <= 0:
            return appliance.hourly_energy_kwh
        return estimate

    async def _async_resolve_runtime_hours_by_appliance_id_by_local_date(
        self,
        *,
        reference_time: datetime,
    ) -> dict[str, dict[date, float]]:
        """Resolve recorder runtime hours per appliance per local date (A2).

        Only resolved for appliances referenced by an enabled ``appliance_runtime``
        optimizer; every other appliance (and the recorder) is left untouched.
        The lookback window covers the largest configured
        ``max_consecutive_skips`` (plus one day) so the consecutive-skip guard
        can be evaluated, plus today-so-far for the current-day budget.

        Every local date in the lookback window is seeded to ``0.0`` before the
        recorder data is merged in, so a day the appliance never ran is present
        as an explicit zero rather than absent — the consecutive-skip guard
        walks back day by day and must be able to see fully-idle days.
        """
        requirements = self._resolve_runtime_history_requirements()
        if requirements is None:
            return {}
        lookback_days, referenced_appliance_ids = requirements

        local_now = dt_util.as_local(reference_time)
        local_today_start = local_now.replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        local_start = local_today_start - timedelta(days=lookback_days)
        window_dates = _iter_local_dates(local_start.date(), local_now.date())

        runtime_by_appliance: dict[str, dict[date, float]] = {}
        for appliance in self._iter_automation_candidate_appliances():
            if appliance.id not in referenced_appliance_ids:
                continue
            entity_id, active_states = _resolve_runtime_entity_and_states(appliance)
            if entity_id is None:
                continue
            try:
                queried = await query_active_hours_by_local_date(
                    self._hass,
                    entity_id=entity_id,
                    active_states=active_states,
                    local_start=local_start,
                    local_end=local_now,
                )
            except Exception:
                _LOGGER.exception(
                    "Error resolving automation runtime history for appliance %r",
                    appliance.id,
                )
                runtime_by_appliance[appliance.id] = {}
                continue
            runtime_by_appliance[appliance.id] = {
                **{local_date: 0.0 for local_date in window_dates},
                **queried,
            }
        return runtime_by_appliance

    def _resolve_runtime_history_requirements(
        self,
    ) -> tuple[int, set[str]] | None:
        """Return ``(lookback_days, appliance_ids)`` for appliance_runtime rules.

        ``appliance_ids`` are the appliances referenced by an enabled
        ``appliance_runtime`` optimizer — the only appliances whose recorder history
        needs resolving. Returns ``None`` when no such optimizer references a
        valid appliance.

        **The appliance lives on ``target``, not on ``params``.** It is identity,
        which a condition group may never override, and every other reader takes
        it from there (``config.target_key``, ``base.py:67``,
        ``conditions/types.py:309``). Reading ``params`` found nothing, so this
        returned ``None``, the runtime map came back empty, and every appliance's
        ``delivered_hours`` was 0 for every day — a daily minimum that never
        counted what had already run, and a consecutive-skip guard walking back
        over days that all looked idle.
        """
        automation_config = read_automation_config(self._active_config)
        if automation_config is None or not automation_config.enabled:
            return None
        max_consecutive_skips = 0
        appliance_ids: set[str] = set()
        for optimizer in automation_config.execution_optimizers:
            if optimizer.kind != "appliance_runtime":
                continue
            appliance_id = optimizer.target.get("appliance_id")
            if isinstance(appliance_id, str) and appliance_id:
                appliance_ids.add(appliance_id)
            skip = optimizer.params.get("skip")
            if isinstance(skip, Mapping):
                raw = skip.get("max_consecutive_skips")
                if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
                    max_consecutive_skips = max(max_consecutive_skips, raw)
        if not appliance_ids:
            return None
        return max_consecutive_skips + 1, appliance_ids

    def _iter_automation_candidate_appliances(
        self,
    ) -> list[GenericApplianceRuntime | ClimateApplianceRuntime]:
        return [
            appliance
            for appliance in self._appliances_registry.appliances
            if isinstance(appliance, (GenericApplianceRuntime, ClimateApplianceRuntime))
        ]

    def _iter_projected_history_appliances(
        self,
        *,
        schedule_document: ScheduleDocument,
    ) -> list[GenericApplianceRuntime | ClimateApplianceRuntime]:
        projected: list[GenericApplianceRuntime | ClimateApplianceRuntime] = []
        seen_appliance_ids: set[str] = set()

        for domains in schedule_document.slots.values():
            for appliance_id, action in domains.appliances.items():
                if appliance_id in seen_appliance_ids:
                    continue

                appliance = self._appliances_registry.get_appliance(appliance_id)
                if not self._is_projected_history_action_active(
                    appliance=appliance,
                    action=action,
                ):
                    continue
                if appliance.history_energy_entity_id is None:
                    continue

                seen_appliance_ids.add(appliance_id)
                projected.append(appliance)

        return projected

    @staticmethod
    def _is_projected_history_action_active(
        *,
        appliance,
        action: object,
    ) -> bool:
        if not isinstance(action, Mapping):
            return False
        if isinstance(appliance, GenericApplianceRuntime):
            return appliance.uses_history_average and action.get("on") is True
        if isinstance(appliance, ClimateApplianceRuntime):
            mode = action.get("mode")
            return (
                appliance.uses_history_average
                and isinstance(mode, str)
                and mode in {"heat", "cool"}
            )
        return False

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
        points = solar_forecast.get("adjustedPoints")
        if not isinstance(points, list):
            points = solar_forecast.get("correctedPoints")
        if not isinstance(points, list):
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
            self._create_tracked_refresh_task(
                self._async_refresh_forecast(
                    reason="slot_refresh",
                    reference_time=_now,
                )
            )

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

    async def _async_reality_check_and_maybe_replan(
        self, reference_time: datetime
    ) -> bool:
        """Pre-execution reality check. Returns True if execution should defer.

        Called by the executor before it applies the current slot. When the
        plan is older than the freshness window, re-evaluate all conditions and
        compare the map to the one the plan was built from. If anything differs,
        trigger a re-plan (which re-stamps condition_met in sync with reality)
        and tell the executor to skip this cycle — the re-plan reconciles the
        executor again, and by then the plan is fresh so it executes as-is. No
        per-slot gating; execution always trusts the plan's condition_met.
        """
        plan_at = self._last_automation_plan_at
        if plan_at is None:
            return False
        # Fresh plan: trust it. This also breaks the re-plan -> execute loop,
        # since a just-built plan is always inside the window.
        age = (reference_time - plan_at).total_seconds()
        if age < AUTOMATION_CONDITION_PLAN_FRESHNESS_SECONDS:
            return False
        try:
            current_map = _condition_met_map(
                await self._async_evaluate_optimizer_conditions()
            )
        except Exception:
            _LOGGER.debug(
                "Reality-check condition eval failed; executing plan as-is",
                exc_info=True,
            )
            return False
        # Compare the *derived* per-optimizer eligibility, not the raw per-group
        # tuples. Comparing tuples would re-plan (and defer one execution cycle)
        # whenever any group flipped, even when the OR result — and so the plan —
        # is unchanged: group 0 flipping false->true while group 1 already
        # matched changes nothing the executor can see.
        if _any_group_met_by_optimizer(current_map) == _any_group_met_by_optimizer(
            self._last_plan_condition_map
        ):
            return False
        # A condition result differs from the plan. Re-plan first (no forecast
        # refresh — presence/temperature don't move the forecast), then defer.
        _LOGGER.debug(
            "Pre-execution reality check: conditions changed vs plan; re-planning"
        )
        await self._automation_triggers.request_debounced(reason="condition_changed")
        return True

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

    @staticmethod
    def _collect_source_ratio_entity_ids(tree: dict) -> dict[str, str]:
        """Return {source_power_sensor_id → ratio_sensor_entity_id} for top-level sources.

        Derived from the tree so the tick can create and fill source-ratio history buffers
        without waiting for the sensor platform to register the ratio sensor entity objects.
        """
        ids: dict[str, str] = {}
        for node in tree.get("sources", []):
            power_id = node.get("powerSensorId")
            ratio_id = node.get("ratioSensorId")
            if power_id and ratio_id:
                ids[power_id] = ratio_id
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
        # The smoothing windows belong to the tree they were filled from: a rebuild
        # can drop or re-parent a node, and a stale window would then smooth the
        # new node's remainder with readings from a different set of children.
        self._unmeasured_raw_history = {}

        # Create deques for all power sensors (real + virtual unmeasured) plus virtual totals
        self._power_history = {
            eid: deque(maxlen=history_buckets) for eid in self._power_sensor_ids
        }
        self._power_history[CONSUMPTION_TOTAL_ENTITY_ID] = deque(maxlen=history_buckets)
        self._power_history[PRODUCTION_TOTAL_ENTITY_ID] = deque(maxlen=history_buckets)
        # Add deques for source ratio sensors so their history is included in get_history().
        # Derive the ratio entity IDs from the tree (NOT from _source_ratio_sensors, which the
        # sensor platform only populates via set_sensors AFTER async_setup has already built these
        # buffers). Without this the ratio history is absent from get_history() and the card paints
        # every past consumer bucket with its fallback colour instead of the source colours.
        # Mark them virtual: their values are computed by _tick Step 3, so the Step 1 real-sensor
        # read loop must not also append them (that would double-append per tick and desync them).
        self._source_ratio_entity_ids = self._collect_source_ratio_entity_ids(tree)
        for ratio_entity_id in self._source_ratio_entity_ids.values():
            self._power_history[ratio_entity_id] = deque(maxlen=history_buckets)
            self._virtual_sensor_ids.add(ratio_entity_id)

    def _start_tick(self) -> None:
        """Start the periodic tick using HA's time-interval tracker."""
        if self._unsub_tick is not None:
            return
        bucket_duration: int = self._active_config.get("history_bucket_duration", 5)
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

        # Step 3: Compute global source ratios, record their history, and update ratio sensors.
        # Driven by the tree-derived ratio entity IDs (not the sensor objects) so ratio history is
        # recorded from the first tick, even before the sensor platform registers the ratio sensor
        # entities. The sensor objects, when present, are used only to publish the displayed value.
        if self._source_ratio_entity_ids:
            normalized = {
                src: self._normalize_source_value(
                    self._power_history[src][-1] if self._power_history.get(src) else 0.0,
                    self._source_value_types.get(src, "default"),
                )
                for src in self._source_sensor_ids
                if src in self._power_history
            }
            total_source = sum(normalized.values())
            for src_eid, ratio_entity_id in self._source_ratio_entity_ids.items():
                ratio_pct = (normalized.get(src_eid, 0.0) / total_source * 100.0) if total_source > 0 else 0.0
                if ratio_entity_id in self._power_history:
                    self._power_history[ratio_entity_id].append(ratio_pct)
                sensor = self._source_ratio_sensors.get(src_eid)
                if sensor is not None:
                    sensor.update_value(ratio_pct)

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
                    result[node["id"]] = self._smooth_unmeasured(
                        node["id"], parent_power - measured_sum
                    )
            self._traverse_for_unmeasured(children, result)

    def _smooth_unmeasured(self, node_id: str, raw_watts: float) -> float:
        """Median of the last few raw remainders, floored at zero.

        The remainder is a difference between readings taken at different
        moments: the house meter reports several times a second, each circuit
        meter only every 7-18 s. Its jitter is therefore of the same order as
        the remainder itself once the circuits cover most of the house, and
        flooring the raw difference pinned the published value to a hard 0 for
        a large share of the time — the card then dropped the row entirely.
        Taking the median first lets the symmetric skew cancel out; a house
        whose circuits genuinely account for everything still settles on 0.
        """
        bucket_duration = self._active_config.get("history_bucket_duration", 5) or 1
        maxlen = max(1, round(_UNMEASURED_SMOOTHING_WINDOW_S / bucket_duration))
        window = self._unmeasured_raw_history.get(node_id)
        if window is None or window.maxlen != maxlen:
            window = deque(window or (), maxlen=maxlen)
            self._unmeasured_raw_history[node_id] = window
        window.append(raw_watts)
        return max(0.0, median(window))

    async def async_unload(self) -> None:
        """Clean up event listeners and stop the tick."""
        self._stop_tick()
        self._stop_forecast_refresh()
        await self._async_cancel_refresh_tasks()
        training_batch = getattr(self, "_training_batch", None)
        if training_batch is not None:
            training_batch.cancel()
            self._training_batch = None
        await self._automation_triggers.async_shutdown()
        self._prune_optimizer_condition_checkers(active_keys=set())
        await self._schedule_executor.async_unload()
        self._invalidate_battery_forecast_cache()

        self._battery_time_to_full = None
        self._battery_time_to_empty = None
        self._unmeasured_sensors = {}
        self._unmeasured_raw_history = {}
        self._consumption_total_sensor = None
        self._production_total_sensor = None
        self._source_ratio_sensors = {}
        self._source_ratio_entity_ids = {}
        self._solar_forecast_sensors = []
        self._async_add_entities = None
        self._unmeasured_sensor_factory = None
        self._entry = None
        self._removing_entity_ids.clear()
        self._power_history.clear()
        self._last_automation_run_result = None
        self._explanation_book.clear()

        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()

        if self._unsub_energy is not None:
            self._unsub_energy()
            self._unsub_energy = None

    def _create_tracked_refresh_task(
        self,
        awaitable,
    ) -> asyncio.Task[Any]:
        task = self._create_task(awaitable)
        self._refresh_tasks.add(task)
        task.add_done_callback(self._refresh_tasks.discard)
        return task

    async def _async_cancel_refresh_tasks(self) -> None:
        tasks = tuple(self._refresh_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._refresh_tasks.clear()


def _condition_met_map(
    results: dict[str, tuple[CustomConditionGroupResult, ...]],
) -> dict[str, tuple[bool, ...]]:
    """Fold per-entry custom results to the per-group bool the optimizers gate on."""
    return {
        optimizer_id: tuple(group.met for group in groups)
        for optimizer_id, groups in results.items()
    }


def _any_group_met_by_optimizer(
    condition_map: dict[str, tuple[bool, ...]],
) -> dict[str, bool]:
    """Fold a per-group condition map to the per-optimizer OR outcome."""
    return {
        optimizer_id: any(met_by_group)
        for optimizer_id, met_by_group in condition_map.items()
    }
