from __future__ import annotations

import asyncio
import functools
import logging
from collections.abc import Callable, Coroutine
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from typing import Any, NamedTuple
from zoneinfo import ZoneInfo

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_change
from homeassistant.util import dt as dt_util

from ..appliance_runtime_history import (
    ApplianceRuntimeHistoryReader,
    ApplianceRuntimeRequest,
)
from ..appliances.climate_appliance import ClimateApplianceRuntime
from ..appliances.generic_appliance import GenericApplianceRuntime
from ..appliances.projection_builder import (
    ApplianceProjectionPlan,
    read_vehicle_remaining_capacity_kwh_by_vehicle_id,
)
from ..appliances.projection_response import (
    ApplianceProjectionsResponseDict,
    build_appliance_projections_response,
    build_empty_appliance_projections_response,
)
from ..appliances.registry_holder import AppliancesRegistryHolder
from ..appliances.state import AppliancesRuntimeRegistry
from ..automation.compute_inputs import (
    ComputeInputs,
    CustomConditionGroupResult,
)
from ..automation.condition_evaluator import ConditionEvaluator
from ..automation.config import (
    AutomationConfig,
    read_automation_config,
)
from ..automation.input_bundle import AutomationInputBundle
from ..automation.ownership import has_automation_owned_actions
from ..battery_forecast_response import build_battery_forecast_response
from ..battery_state import (
    read_battery_entity_config,
    read_battery_live_state,
)
from ..const import (
    BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS,
    DEFAULT_FORECAST_DAYS,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_STALE_AFTER_SECONDS,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
    SLOT_ALIGNED_REFRESH_REASON,
)
from ..consumption_forecast_builder import (
    ConsumptionForecastBuilder,
    read_house_forecast_request,
)
from ..controllables.config import (
    is_active_state,
    running_active_states,
)
from ..controllables.spec import (
    CONTROLLABLE_KIND_CLIMATE,
    CONTROLLABLE_KIND_GENERIC,
    spec_for,
)
from ..forecast_builder import SolarForecastBuilder, read_solar_forecast_entities
from ..grid_flow_forecast_builder import build_grid_flow_forecast_snapshot
from ..grid_flow_forecast_response import build_grid_flow_forecast_response
from ..grid_price_forecast_builder import (
    GridPriceForecastBuilder,
    read_grid_sell_price_entity_id,
)
from ..grid_price_forecast_response import build_grid_price_forecast_response
from ..house_forecast_response import build_house_forecast_response
from ..point_forecast_response import build_solar_forecast_response
from ..scheduling.schedule import (
    ScheduleControlConfig,
    ScheduleDocument,
    appliance_actions,
    read_schedule_control_config,
    strip_candidate_actions,
)
from ..scheduling.schedule_service import ScheduleService
from ..slot_grid import SLOT, SLOT_MINUTES, get_local_current_slot_start
from ..solar_bias_correction.response import build_bias_correction_payload
from ..solar_bias_correction.service import SolarBiasCorrectionService
from ..storage import HelmanStorage
from ..today_slot_readers import (
    TodaySlotBoundaryStateReader,
    TodaySlotEnergyReader,
)
from ..training.artifacts import TrainingArtifacts
from .assembly import (
    ApplianceScheduleSignature,
    BatteryScheduleSignature,
    EffectiveScheduleSignature,
    ForecastRebuildSnapshot,
    ForecastScheduleDocuments,
    SolarSignature,
    build_appliance_projection_schedule_signature,
    build_battery_forecast_schedule_effective_signature,
    build_battery_forecast_schedule_signature,
    build_battery_forecast_solar_signature,
    build_forecast_rebuild,
    build_forecast_schedule_documents,
    is_projected_history_action_active,
    resolve_runtime_history_requirements,
)

_LOGGER = logging.getLogger(__name__)
# Distinguish an omitted live state from an explicit unavailable reading.
_LIVE_STATE_UNSET: Any = object()
_UNAVAILABLE_ENTITY_STATES = {"unknown", "unavailable", "none"}
_BATTERY_FORECAST_CACHE_SOC_TOLERANCE = 1.0
_BATTERY_FORECAST_CACHE_ENERGY_TOLERANCE_KWH = 0.1
_FORECAST_STALE_HINT = (
    "Forecast data has not been rebuilt for over an hour. "
    "Check the Home Assistant log for forecast refresh errors."
)
_FULL_FORECAST_SLOT_HOURS = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
_FORECAST_SLOT_DURATION_TOLERANCE_HOURS = 1 / 3600
_BATTERY_FORECAST_KWH_TO_WH = 1000.0
_AUTOMATION_CANDIDATE_KINDS = (CONTROLLABLE_KIND_GENERIC, CONTROLLABLE_KIND_CLIMATE)


def _series_timestamp_at(series: list[Any], index: int) -> str:
    if not series:
        return "empty"
    entry = series[index]
    if not isinstance(entry, dict):
        return f"<{type(entry).__name__}>"
    timestamp = entry.get("timestamp")
    return timestamp if isinstance(timestamp, str) else "<no timestamp>"


def _first_series_timestamp(series: list[Any]) -> str:
    return _series_timestamp_at(series, 0)


def _last_series_timestamp(series: list[Any]) -> str:
    return _series_timestamp_at(series, -1)


def _build_house_profile_health(snapshot: dict[str, Any]) -> tuple[str, str] | None:
    last_outcome = snapshot.get("lastOutcome")
    if last_outcome == "insufficient_history":
        return (
            "house_profile_insufficient_history",
            (
                "Not enough recorder history to fit a house consumption profile: "
                f"{snapshot.get('historyDaysAvailable')} days available, "
                f"{snapshot.get('requiredHistoryDays')} required."
            ),
        )
    if last_outcome == "entity_missing":
        return (
            "house_profile_entity_missing",
            (
                "The configured house total energy entity no longer exists; "
                "the house consumption profile cannot be refitted."
            ),
        )
    if last_outcome == "training_failed":
        return (
            "house_profile_training_failed",
            (
                "House consumption profile training failed. Check the Home "
                "Assistant log."
            ),
        )
    return None


def _battery_forecast_slot_values(entry: dict[str, Any]) -> dict[str, float] | None:
    """Derive one battery-forecast slot's five archived figures from the snapshot.

    Moved here verbatim from the retired
    ``BatteryForecastHistoryStore._slot_values`` so this stays a single
    implementation of which snapshot field feeds which series, the two sign
    conventions, and the kWh -> Wh factor. :meth:`HelmanCoordinator.get_battery_forecast_current`
    is the only caller; the sensors read one key off its result rather than
    repeating any of this.

    A key is present only where its source field is. ``batteryNetWh`` and the
    two grid sides landed in later releases, so a slot without them yields no
    value for that key rather than a zero. Returns ``None`` -- not ``{}`` -- when
    the entry carries none of the five, the ``values or None`` the retired
    ``_slot_values`` ended on, so a caller can treat "no slot" and "an empty
    slot" alike.

    Net grid is positive when exporting, matching ``gridNetKwh`` elsewhere; net
    battery is positive when charging, the same "energy leaving the house's
    demand" sign the future-half filters in ``solar_bias_correction.service``
    use. The two grid sides are kept beside the net rather than instead of it:
    netting is right for the chart's one signed series and wrong for money,
    where a slot can import at one rate and export at another.
    """
    values: dict[str, float] = {}
    pct = entry.get("socPct")
    if pct is not None:
        try:
            values["socPct"] = float(pct)
        except (TypeError, ValueError):
            pass
    imported = entry.get("importedFromGridKwh")
    exported = entry.get("exportedToGridKwh")
    if imported is not None or exported is not None:
        try:
            imported_wh = float(imported or 0.0) * _BATTERY_FORECAST_KWH_TO_WH
            exported_wh = float(exported or 0.0) * _BATTERY_FORECAST_KWH_TO_WH
        except (TypeError, ValueError):
            pass
        else:
            values["gridNetWh"] = exported_wh - imported_wh
            values["gridImportWh"] = imported_wh
            values["gridExportWh"] = exported_wh
    charged = entry.get("chargedKwh")
    discharged = entry.get("dischargedKwh")
    if charged is not None or discharged is not None:
        try:
            values["batteryNetWh"] = (
                float(charged or 0.0) - float(discharged or 0.0)
            ) * _BATTERY_FORECAST_KWH_TO_WH
        except (TypeError, ValueError):
            pass
    return values or None


def _resolve_runtime_entity_and_states(
    appliance: GenericApplianceRuntime | ClimateApplianceRuntime,
) -> tuple[str | None, tuple[str, ...]]:
    """Return the recorder entity id and active-state set defining "on" runtime.

    The kind's running signal and its active states — a switch being ``on``, a
    climate entity heating or cooling — the same pair a meterless child's share
    is split by.
    """
    signal = spec_for(appliance.kind).running_signal(appliance)
    if signal is None:
        return None, ()
    entity_id, activity = signal
    return entity_id, running_active_states(activity)


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


def _adopt_stored_solar_forecast(raw_snapshot: Any) -> dict[str, Any] | None:
    """Tolerantly adopt a persisted solar snapshot from storage.

    In canonical form, points is the series consumers use and rawPoints is the
    untouched record. If either is missing, it is populated from the other.
    """
    if not isinstance(raw_snapshot, dict):
        return None
    snapshot = deepcopy(raw_snapshot)
    points = snapshot.get("points")
    raw_points = snapshot.get("rawPoints")
    if isinstance(raw_points, list) and not isinstance(points, list):
        snapshot["points"] = deepcopy(raw_points)
    elif isinstance(points, list) and not isinstance(raw_points, list):
        snapshot["rawPoints"] = deepcopy(points)
    return snapshot


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


def _forecast_slot_start(moment: datetime) -> datetime:
    return get_local_current_slot_start(
        moment, interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES
    )


def _battery_forecast_slot_start(battery_forecast: dict[str, Any]) -> datetime | None:
    """The forecast slot a battery forecast says it started in, if it says."""
    started_at_raw = battery_forecast.get("startedAt")
    if not isinstance(started_at_raw, str):
        return None
    started_at = dt_util.parse_datetime(started_at_raw)
    return None if started_at is None else _forecast_slot_start(started_at)


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
class _PreparedForecastPipelineInputs:
    """Everything the appliance pipeline needs before it can decide to build.

    Gathered on the event loop (schedule document + live battery state), and
    cheap enough to recompute after waiting on the build lock -- which is what
    makes the recheck honest rather than a snapshot of stale signatures.
    """

    forecast_schedule_document: ScheduleDocument
    projection_schedule_document: ScheduleDocument
    live_state: Any
    schedule_signature: BatteryScheduleSignature
    appliance_schedule_signature: ApplianceScheduleSignature
    schedule_effective_signature: EffectiveScheduleSignature


@dataclass(frozen=True)
class _PipelineCacheKey:
    """What a cached pipeline was built from, compared whole on every read."""

    #: The forecast slot the read is in; stored as the slot the battery
    #: forecast says it started in, None when it carries no ``startedAt``.
    slot_start: datetime | None
    house_generated_at: str | None
    solar_signature: SolarSignature
    schedule_sig: BatteryScheduleSignature
    appliance_sig: ApplianceScheduleSignature
    effective_sig: EffectiveScheduleSignature


class _PipelineCacheEntry(NamedTuple):
    key: _PipelineCacheKey
    expires_at: datetime
    snapshot: _ApplianceForecastPipelineSnapshot


@dataclass(frozen=True)
class _ForecastRefreshResult:
    forecast_refreshed: bool
    bundle_ready: bool


@dataclass
class _BackfillJob:
    """One background statistics back-fill job and its starting state."""

    name: str
    ready: Callable[[], bool]
    start: Callable[[], Coroutine[Any, Any, None]]
    started: bool = False
    task: asyncio.Task[None] | None = None


class ForecastService:
    """Own forecast snapshots, pipeline, price channels and refresh lifecycle."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HelmanStorage,
        entry: ConfigEntry,
        *,
        config_provider: Callable[[], dict[str, Any]],
        schedule: ScheduleService,
        registry: AppliancesRegistryHolder,
        training: TrainingArtifacts,
        conditions: ConditionEvaluator,
        slot_history: TodaySlotEnergyReader,
        battery_boundary_history: TodaySlotBoundaryStateReader,
        appliance_runtime_history: ApplianceRuntimeHistoryReader,
        bias_provider: Callable[[], SolarBiasCorrectionService | None],
        publish: Callable[[str], None],
        request_replan: Callable[..., Coroutine[Any, Any, None]],
    ) -> None:
        self._hass = hass
        self._storage = storage
        self._entry = entry
        self._config_provider = config_provider
        self.schedule = schedule
        self._appliances_registry = registry
        self.training = training
        self.conditions = conditions
        self._slot_history = slot_history
        self._battery_boundary_history = battery_boundary_history
        self._appliance_runtime_history = appliance_runtime_history
        self._bias_provider = bias_provider
        self._publish = publish
        self._request_replan = request_replan
        self._unloaded = False
        self._cached_forecast: dict | None = None
        self._grid_import_price_current: float | None = None
        self._grid_import_price_unit: str | None = None
        self._grid_export_price_current: float | None = None
        self._grid_export_price_unit: str | None = None
        self._grid_export_price_channel: dict[str, Any] | None = None
        self._grid_export_price_schedule: dict[str, float] = {}
        self._backfill_jobs: list[_BackfillJob] = [
            _BackfillJob(
                name="helman_solar_forecast_backfill",
                ready=lambda: (
                    self.get_solar_forecast_current_wh(corrected=False) is not None
                    and bool(self._get_solar_forecast_source_entity_id())
                ),
                start=self._start_solar_forecast_backfill,
            ),
            _BackfillJob(
                name="helman_battery_forecast_backfill",
                ready=lambda: self.get_battery_forecast_current() is not None,
                start=self._start_battery_forecast_backfill,
            ),
            _BackfillJob(
                name="helman_grid_export_price_backfill",
                ready=lambda: (
                    self._grid_export_price_current is not None
                    and self._grid_export_price_unit is not None
                    and bool(self._get_grid_sell_price_entity_id())
                ),
                start=self._start_grid_export_price_backfill,
            ),
        ]
        self._cached_solar_forecast: dict[str, Any] | None = None
        self._grid_price_snapshot_cache: tuple[datetime, dict[str, Any]] | None = None
        self._pipeline_cache: _PipelineCacheEntry | None = None
        self._appliance_forecast_pipeline_lock = asyncio.Lock()
        self._forecast_cache_revision = 0
        self._battery_forecast_current_miss: tuple[str, str] | None = None
        self._battery_forecast_current_slot: tuple[str, dict[str, float]] | None = None
        self._create_task = getattr(hass, "async_create_task", asyncio.create_task)
        self._refresh_tasks: set[asyncio.Task[Any]] = set()
        self._automation_input_bundle: AutomationInputBundle | None = None
        self._unsub_forecast_refresh: Callable[[], None] | None = None
        self._forecast_refresh_task: asyncio.Task[Any] | None = None

    @property
    def _active_config(self) -> dict[str, Any]:
        return self._config_provider()

    @property
    def _solar_bias_service(self) -> SolarBiasCorrectionService | None:
        return self._bias_provider()

    def load_stored_snapshots(self) -> None:
        self._cached_forecast = self._storage.forecast_snapshot
        self._cached_solar_forecast = _adopt_stored_solar_forecast(
            self._storage.solar_forecast_snapshot
        )
        request = read_house_forecast_request(self._active_config)
        if not self._has_matching_forecast_snapshot(
            total_energy_entity_id=request.total_energy_entity_id,
            training_window_days=request.training_window_days,
            min_history_days=request.min_history_days,
            config_fingerprint=request.config_fingerprint,
        ):
            self._cached_forecast = None

    def publish_forecast_entities(self, *, reason: str) -> None:
        if self._unloaded:
            return
        self._publish(reason)
        self._maybe_start_backfill_jobs()

    def _read_schedule_control_config(self) -> ScheduleControlConfig | None:
        return read_schedule_control_config(self._active_config)

    def _automation_config_or_disabled(self) -> AutomationConfig:
        return read_automation_config(self._active_config) or AutomationConfig(
            enabled=False
        )

    def _create_tracked_refresh_task(self, awaitable) -> asyncio.Task[Any]:
        task = self._create_task(awaitable)
        self._refresh_tasks.add(task)
        task.add_done_callback(self._refresh_tasks.discard)
        return task

    async def async_unload(self) -> None:
        self._unloaded = True
        self._stop_forecast_refresh()
        tasks = tuple(self._refresh_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._refresh_tasks.clear()
        backfill_tasks = []
        for job in self._backfill_jobs:
            if job.task is not None:
                job.task.cancel()
                backfill_tasks.append(job.task)
                job.task = None
        if backfill_tasks:
            await asyncio.gather(*backfill_tasks, return_exceptions=True)
        self._invalidate_pipeline_cache()

    def _get_grid_sell_price_entity_id(self) -> str | None:
        return read_grid_sell_price_entity_id(self._active_config)

    def _get_grid_import_price_config(self):
        """The validated import-price window table, or None when unconfigured.

        Invalid config comes back as None: the inspector asking for a price rail
        is no place to raise, and the config editor already reports the error.
        """
        from ..grid_price_forecast_builder import (
            GridImportPriceConfigError,
            read_grid_import_price_config,
        )

        try:
            return read_grid_import_price_config(self._active_config)
        except GridImportPriceConfigError:
            return None

    def grid_price_snapshot(
        self, reference_time: datetime | None = None
    ) -> dict[str, Any]:
        """Both price channels as of reference_time, points running forward from here.

        Built on demand rather than read off the last refresh, for the same
        reason ``async_get_forecast`` builds its own: the points and the "price
        now" are derived at a reference time, and a caller mid-quarter-hour must
        not be handed the previous refresh's slot.

        Held for the rest of the slot it was built in, though. The inspector
        calls this once per day opened, and a full build materializes the whole
        forecast horizon at canonical granularity — work that would otherwise
        repeat on every day-pill click. Within one slot the answer cannot
        change, so the freshness the docstring above demands is exactly what
        the cache key preserves.
        """
        effective_reference_time = reference_time or dt_util.now()
        slot_start = get_local_current_slot_start(
            effective_reference_time,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        cached = self._grid_price_snapshot_cache
        if cached is not None and cached[0] == slot_start:
            return cached[1]
        snapshot = GridPriceForecastBuilder(
            self._hass,
            self._active_config,
        ).build(
            reference_time=effective_reference_time,
            export_snapshot=self._get_grid_export_price_channel(),
        )
        self._grid_price_snapshot_cache = (slot_start, snapshot)
        return snapshot

    async def canonical_solar_forecast(
        self, *, reference_time: datetime
    ) -> dict[str, Any] | None:
        return await self._async_get_canonical_solar_forecast(
            reference_time=reference_time
        )

    async def battery_forecast(self) -> dict[str, Any] | None:
        """The battery forecast snapshot, for the solar bias inspector.

        Goes through the pipeline rather than reading the cache directly, so
        the inspector does not depend on another consumer having called
        get_forecast() first. Reuses the pipeline cache when it is warm.
        """
        pipeline = await self._async_current_pipeline(dt_util.now())
        return pipeline.battery_forecast

    def house_forecast_snapshot(self) -> dict[str, Any] | None:
        return self._get_adjusted_house_forecast_snapshot()

    def house_forecast_composition(self) -> dict[str, Any] | None:
        return self._get_house_forecast_composition()

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
            forecast_days=MAX_FORECAST_DAYS,
        )
        raw_points = snapshot.get("points", []) or []
        # rawPoints is the untouched record of what the forecaster said, so it
        # stays independent of ``points``, which consumers are handed live. The
        # points are flat {timestamp, value} dicts, so a per-point dict() is a
        # full copy at a fraction of deepcopy's cost.
        snapshot["rawPoints"] = [dict(point) for point in raw_points]
        solar_bias_service = self._solar_bias_service
        if solar_bias_service is not None:
            bias_result = solar_bias_service.build_adjustment_result(
                raw_points,
                reference_time,
            )
            if bias_result is not None:
                snapshot["biasCorrection"] = build_bias_correction_payload(bias_result)
                if bias_result.effective_variant == "adjusted":
                    # The adjuster mints new point dicts per call and the
                    # service keeps no reference to them.
                    snapshot["correctedPoints"] = bias_result.adjusted_points
        snapshot["generatedAt"] = reference_time.isoformat()
        return snapshot

    async def get_forecast(
        self,
        *,
        forecast_days: int = DEFAULT_FORECAST_DAYS,
    ) -> dict:
        """Return the current forecast response, on the canonical 15-min grid.

        Increment 2 makes schedule state part of battery forecast dependencies
        while keeping the external battery response unchanged.
        """
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
        # The import half is built per request, not read off the refresh: its
        # points and the "price now" they carry are derived at the reference
        # time, and a card asking mid-quarter-hour must not be told the last
        # refresh's slot. The export half is the owned ingestion result rather
        # than a second read of the source -- it carries the source's own
        # timestamps, which no reference time reshapes. Only the grid half:
        # HelmanForecastBuilder would also run the solar half's same-day
        raw_grid_price_forecast = self.grid_price_snapshot(request_now)
        pipeline = await self._async_current_pipeline(request_now)
        result["house_consumption"] = build_house_forecast_response(
            pipeline.adjusted_house_forecast,
            forecast_days=forecast_days,
        )
        # Read off the canonical snapshot the pipeline was built from, not the
        # adjusted view it derives from it: the adjusted copy is rebuilt per
        # build, and a cache hit means the same canonical generatedAt.
        canonical_house_forecast = pipeline.original_house_forecast
        result["house_consumption"]["staleness"] = _build_forecast_staleness(
            canonical_house_forecast.get("generatedAt"),
            reference_time=request_now,
            override=_build_house_profile_health(canonical_house_forecast),
        )
        canonical_battery_forecast = pipeline.battery_forecast
        grid_price_response = build_grid_price_forecast_response(
            raw_grid_price_forecast,
            forecast_days=forecast_days,
        )
        canonical_grid_flow_forecast = build_grid_flow_forecast_snapshot(
            canonical_battery_forecast
        )
        grid_flow_response = build_grid_flow_forecast_response(
            canonical_grid_flow_forecast,
            forecast_days=forecast_days,
        )
        result["grid"] = {**grid_flow_response, **grid_price_response}
        result["battery_capacity"] = build_battery_forecast_response(
            canonical_battery_forecast,
            forecast_days=forecast_days,
        )
        return result

    def _absorb_grid_import_price(self, grid_price_snapshot: Any) -> None:
        """Take the current import rate off a freshly built price snapshot.

        An unavailable or unconfigured channel clears the value rather than
        holding the last one: a price that stopped being computed is not the
        same as a price that has not moved, and the recorder must not archive
        a stale rate as though it still applied.
        """
        channel = (
            grid_price_snapshot.get("import")
            if isinstance(grid_price_snapshot, dict)
            else None
        )
        if not isinstance(channel, dict) or channel.get("status") != "available":
            self._grid_import_price_current = None
            self._grid_import_price_unit = None
            return

        raw_price = channel.get("currentPrice")
        if isinstance(raw_price, bool) or not isinstance(raw_price, (int, float)):
            self._grid_import_price_current = None
            self._grid_import_price_unit = None
            return

        unit = channel.get("unit")
        self._grid_import_price_current = float(raw_price)
        self._grid_import_price_unit = unit if isinstance(unit, str) and unit else None

    def _absorb_grid_export_price(self, grid_price_snapshot: Any) -> None:
        """Adopt the export half of a freshly built price snapshot."""
        channel = (
            grid_price_snapshot.get("export")
            if isinstance(grid_price_snapshot, dict)
            else None
        )
        self._absorb_grid_export_price_channel(channel)

    def _absorb_grid_export_price_channel(self, channel: Any) -> None:
        """Adopt one ingestion result as the owned export channel, whole.

        Current price, unit and schedule are replaced together, from the same
        reading: a schedule kept from a previous provider or a price left
        behind by a source that has gone quiet would be a mixed-source answer.

        The channel's ``status`` is deliberately not gated on. It grades the
        *forecast* -- "partial" means the sell-price entity published a price
        but no forward points, or forward points but no price. Each half is
        therefore taken on its own: a numeric ``currentPrice`` whatever the
        status says, and anything else clears the price without clearing the
        schedule, because a rate that stopped being published is not a rate
        that has not moved and the recorder must not archive a stale one as
        though it still applied.
        """
        channel = channel if isinstance(channel, dict) else {}
        self._grid_export_price_channel = channel

        raw_schedule = channel.get("schedule")
        self._grid_export_price_schedule = (
            {
                key: float(value)
                for key, value in raw_schedule.items()
                if isinstance(key, str)
                and not isinstance(value, bool)
                and isinstance(value, (int, float))
            }
            if isinstance(raw_schedule, dict)
            else {}
        )

        # The unit is a property of the source, not of the current reading, so
        # it survives a reading that carries no price: the mirror stays
        # available while it holds a schedule, and publishing that schedule
        # without a unit would be the one thing the source never said.
        unit = channel.get("unit")
        self._grid_export_price_unit = unit if isinstance(unit, str) and unit else None

        raw_price = channel.get("currentPrice")
        if isinstance(raw_price, bool) or not isinstance(raw_price, (int, float)):
            self._grid_export_price_current = None
            return

        self._grid_export_price_current = float(raw_price)

    def _ingest_grid_export_price(self) -> dict[str, Any]:
        """Read the configured sell-price entity and own what comes back.

        The single external boundary for the export channel. Every other path
        -- the per-request forecast, the inspector's price rail, the automation
        bundle the optimizers run on, the published sensor -- is served from
        the result this stores, so a consumer can never disagree with the
        sensor or pick up a source the configuration has since changed.
        """
        channel = GridPriceForecastBuilder(
            self._hass,
            self._active_config,
        ).build_export_price_snapshot()
        self._absorb_grid_export_price_channel(channel)
        # The held snapshot embeds the channel this replaces. Its key is the
        # slot, which cannot see an ingestion inside the slot it was built in,
        # so a source publishing tomorrow's prices mid-slot would otherwise not
        # reach the inspector until the next one.
        self._grid_price_snapshot_cache = None
        return channel

    def _get_grid_export_price_channel(self) -> dict[str, Any]:
        """The owned export channel, ingesting once if nothing has yet.

        Refreshed on the forecast beat; read here between beats. The lazy first
        ingestion is for the cold window before the startup refresh has run,
        where the alternative is telling a card the export price is unknown
        when the source is sitting right there with it.
        """
        channel = self._grid_export_price_channel
        if channel is None:
            return self._ingest_grid_export_price()
        return channel

    def _maybe_start_backfill_jobs(self) -> None:
        """Start any ready one-shot statistics back-fill jobs on the publish beat."""
        if self._unloaded:
            return
        for job in self._backfill_jobs:
            if job.started or not job.ready():
                continue
            job.started = True
            job.task = self._hass.async_create_background_task(
                job.start(),
                job.name,
            )

    def _start_solar_forecast_backfill(self) -> Coroutine[Any, Any, None]:
        from ..solar_forecast_backfill import async_backfill_solar_forecast_statistics

        source_entity_id = self._get_solar_forecast_source_entity_id()
        assert source_entity_id is not None
        return async_backfill_solar_forecast_statistics(
            self._hass, source_entity_id=source_entity_id
        )

    def _get_solar_forecast_source_entity_id(self) -> str | None:
        entities = read_solar_forecast_entities(self._active_config)
        return entities[0] if entities else None

    def _start_battery_forecast_backfill(self) -> Coroutine[Any, Any, None]:
        from ..battery_forecast_backfill import (
            async_backfill_battery_forecast_statistics,
        )

        return async_backfill_battery_forecast_statistics(self._hass)

    def _start_grid_export_price_backfill(self) -> Coroutine[Any, Any, None]:
        from ..grid_export_price_backfill import (
            async_backfill_grid_export_price_statistics,
        )

        source_entity_id = self._get_grid_sell_price_entity_id()
        assert source_entity_id is not None
        return async_backfill_grid_export_price_statistics(
            self._hass,
            source_entity_id=source_entity_id,
            unit_of_measurement=self._grid_export_price_unit,
        )

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
        cached_solar_forecast = self._cached_solar_forecast
        if isinstance(cached_solar_forecast, dict):
            return cached_solar_forecast
        return None

    def _canonical_house_forecast(self) -> dict[str, Any]:
        """The cached house snapshot, however old it is.

        Like the solar half, a pure cache read. Without a snapshot -- before the
        first refresh, with nothing persisted -- the answer is a placeholder
        payload reporting unavailable. A snapshot held here always answers the
        current config: setup drops a persisted one that does not (a config
        save reloads the entry), and every refresh builds against the config
        this coordinator was set up with.
        """
        if self._cached_forecast is not None:
            return self._cached_forecast
        request = read_house_forecast_request(self._active_config)
        return ConsumptionForecastBuilder._make_payload(
            status="not_configured"
            if request.total_energy_entity_id is None
            else "unavailable",
            training_window_days=request.training_window_days,
            min_history_days=request.min_history_days,
            config_fingerprint=request.config_fingerprint,
            source_granularity_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days_available=MAX_FORECAST_DAYS,
            trained_at=self.training.house_profile_trained_at,
            last_outcome=self.training.house_profile_last_outcome,
        )

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
        buckets = _bucket_points_by_local_day(
            self.get_corrected_solar_forecast_points()
        )
        target_day = (dt_util.now().date() + timedelta(days=day_offset)).isoformat()
        values = buckets.get(target_day)
        if not values:
            return None
        return round(sum(values) / 1000.0, 4)

    def get_solar_forecast_current_wh(self, *, corrected: bool) -> float | None:
        """The current slot's forecast energy in Wh, or None.

        Reads the canonical snapshot's own series -- ``rawPoints`` for the
        pre-correction curve, ``correctedPoints`` for the adjusted one. When no
        profile is being applied there is no corrected series, and the corrected
        sensor reports the raw value rather than going unavailable: "no
        correction yet" is honestly the same number, and a gap in the chart
        would read as missing data instead.

        The snapshot's points are already the slot's Wh, so nothing is
        converted here: the entity publishes the figure the inspector draws.
        """
        snapshot = self._cached_solar_forecast
        if not isinstance(snapshot, dict):
            return None
        points = None
        if corrected:
            points = snapshot.get("correctedPoints")
        if not points:
            points = snapshot.get("rawPoints") or snapshot.get("points")
        if not isinstance(points, list) or not points:
            return None

        timezone = ZoneInfo(str(self._hass.config.time_zone))
        slot_start = get_local_current_slot_start(
            dt_util.as_local(dt_util.now()), interval_minutes=SLOT_MINUTES
        )
        for point in points:
            if not isinstance(point, dict):
                continue
            raw_ts = point.get("timestamp")
            if not isinstance(raw_ts, str):
                continue
            try:
                ts = datetime.fromisoformat(raw_ts)
            except ValueError:
                continue
            ts = ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
            if ts != slot_start:
                continue
            try:
                return float(point.get("value"))
            except (TypeError, ValueError):
                return None
        return None

    def get_battery_forecast_current(self) -> dict[str, float] | None:
        """The current 15-minute slot's forecast SoC, grid and battery energy.

        The figures ``BatteryForecastHistoryStore`` used to archive, read
        straight off the snapshot the rest of the system already acts on
        (the cached pipeline's ``battery_forecast``) — the same
        move :meth:`get_solar_forecast_current_wh` makes for the solar forecast,
        so the five published entities' recorder history becomes that archive.

        Returns a map keyed ``socPct`` / ``gridNetWh`` / ``gridImportWh`` /
        ``gridExportWh`` / ``batteryNetWh``. A key is absent when the snapshot
        slot omits its source field — the two grid sides and ``batteryNetWh``
        arrived in later releases — so a sensor for that key reports unavailable
        rather than zero. ``None`` when the pipeline is cold, when it carries no
        slot for the clock's current quarter hour, or when the slot it carries is
        a partial and this slot has no full-slot answer to fall back on (below).

        The snapshot's first series entry is stamped at build time. On the
        slot-aligned rebuild that is the slot boundary itself — the timer fires
        up to half a second late and ``_start_forecast_refresh`` snaps the
        reference time back — so ``durationHours`` is a full slot carrying the
        whole slot's energy; an off-beat rebuild stamps it partway through, so
        ``durationHours`` is short and the four Wh figures are scaled down to
        that fraction. This accessor **refuses** such a partial entry, returning
        ``None`` — because Home Assistant writes a sensor's state by routes this
        integration does not gate (``async_add_entities`` on setup, the
        ``homeassistant.update_entity`` service, an entity-registry rename), each
        reading this accessor directly, and a half-size energy that then stood
        for the rest of the slot would drag hour N's compiled ``mean`` low —
        exactly the error the raw states would outlive.

        Refusing it is not the same as having nothing, though, and until #204 it
        was treated as if it were: a slot the beat had already served whole went
        unavailable for whatever remained of its quarter hour as soon as an
        off-beat rebuild landed. So the full-slot map is remembered under its
        slot's key (``_battery_forecast_current_slot``) and served again when the
        entry for that *same* slot turns out to be a partial. That is not a stale
        read — it is the identical figure the slot-aligned rebuild published, for
        the slot still in progress, and what a partial adds is a rescaling of the
        slot's remainder rather than new knowledge about the slot. The memo
        expires by its key alone: a map recorded under a slot that has passed can
        never match, so the first off-beat rebuild in a slot the beat has not yet
        filled is still refused, and still says so.

        The fallback is confined to this one branch. A cold pipeline, a snapshot
        with no series, or a series carrying no entry for this slot all still
        return ``None`` — those mean the system genuinely has nothing, which is
        worth seeing rather than papering over with a value from earlier in the
        slot.

        The ``slot_refresh`` gate on the five sensors' publish signal is
        the other half of the guard and stops a different thing: an off-beat
        rebuild that still produced a *full* first slot re-writing that value
        mid-slot. Neither is the whole guard; the ``socPct`` level is dropped
        with the four energies because a partial entry's SoC is the projection
        for the shortened interval's end, not the slot's, and returning it alone
        would publish one of the five off the shared beat.
        """
        timezone = ZoneInfo(str(self._hass.config.time_zone))
        slot_start = get_local_current_slot_start(
            dt_util.as_local(dt_util.now()), interval_minutes=SLOT_MINUTES
        )
        slot_end = slot_start + SLOT
        slot_key = slot_start.isoformat()

        def refuse(reason: str, message: str, *args: object) -> None:
            """Say once per slot why the five current-slot entities are down.

            Every branch below leaves all five reporting unavailable, and until
            #204 every one of them did it in silence — a dead stretch showed up
            in the recorder with nothing in the log to explain it. The dedupe
            key is (reason, slot) so a stretch spanning several slots still
            reports each slot it covers, and a reason that changes mid-slot is
            not swallowed by the one before it.
            """
            token = (reason, slot_key)
            if self._battery_forecast_current_miss == token:
                return
            self._battery_forecast_current_miss = token
            _LOGGER.info(
                "Battery forecast current-slot values unavailable "
                "(slot=%s, reason=%s): " + message,
                slot_key,
                reason,
                *args,
            )

        pipeline = self._cached_pipeline()
        if pipeline is None:
            refuse(
                "pipeline_cold", "the appliance forecast pipeline has no snapshot yet"
            )
            return None
        snapshot = getattr(pipeline, "battery_forecast", None)
        if not isinstance(snapshot, dict):
            refuse(
                "no_battery_forecast",
                "the pipeline snapshot carries no battery_forecast dict (got %s)",
                type(snapshot).__name__,
            )
            return None
        series = snapshot.get("series")
        if not isinstance(series, list):
            refuse(
                "no_series",
                "the battery forecast carries no series (status=%r, got %s)",
                snapshot.get("status"),
                type(series).__name__,
            )
            return None
        for entry in series:
            if not isinstance(entry, dict):
                continue
            raw_ts = entry.get("timestamp")
            if not isinstance(raw_ts, str):
                continue
            try:
                ts = datetime.fromisoformat(raw_ts)
            except ValueError:
                continue
            ts = ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
            if slot_start <= ts < slot_end:
                duration_hours = entry.get("durationHours")
                if (
                    isinstance(duration_hours, (int, float))
                    and not isinstance(duration_hours, bool)
                    and duration_hours
                    < _FULL_FORECAST_SLOT_HOURS
                    - _FORECAST_SLOT_DURATION_TOLERANCE_HOURS
                ):
                    # A build-time partial first entry: its four energies are
                    # scaled to the slot's remainder. Refuse the whole entry so
                    # no write path can publish a partial value. An entry with no
                    # ``durationHours`` at all (older snapshots, some tests) is
                    # taken at face value.
                    memo = self._battery_forecast_current_slot
                    if memo is not None and memo[0] == slot_key:
                        # This slot has already been served its whole-slot
                        # figures, by the rebuild the beat started. Serve them
                        # again rather than nothing: the partial in front of us
                        # is a fresh scaling of the slot's *remainder*, not new
                        # knowledge about the slot, and the published contract
                        # for these five is what was believed at the slot's
                        # start. Not a refusal, so nothing is logged.
                        return dict(memo[1])
                    refuse(
                        "partial_slot",
                        "the snapshot's entry for this slot is a build-time "
                        "partial (durationHours=%s, a full slot is %s) and no "
                        "slot-aligned rebuild has filled this slot yet — an "
                        "off-beat rebuild stamped it mid-slot, so the five stay "
                        "down until the next slot-aligned rebuild",
                        duration_hours,
                        _FULL_FORECAST_SLOT_HOURS,
                    )
                    return None
                values = _battery_forecast_slot_values(entry)
                if values is not None:
                    # Only a slot that actually carried figures is worth
                    # remembering; an entry with none of the five is "no slot"
                    # and memoing it would answer a later partial with the same
                    # ``None`` while suppressing the reason.
                    # A copy, so the memo owns its map: the accessor runs on
                    # every state read of the five entities and a caller that
                    # mutated what it was handed would otherwise corrupt the
                    # slot's answer for the rest of the quarter hour.
                    self._battery_forecast_current_slot = (slot_key, dict(values))
                return values
        refuse(
            "slot_not_in_series",
            "no series entry covers this slot (series has %d entries, "
            "first=%s, last=%s)",
            len(series),
            _first_series_timestamp(series),
            _last_series_timestamp(series),
        )
        return None

    def get_grid_import_price_current(self) -> float | None:
        """The import rate in force right now, or None when unconfigured."""
        return self._grid_import_price_current

    def get_grid_import_price_unit(self) -> str | None:
        """The configured currency-per-energy unit of the import price."""
        return self._grid_import_price_unit

    def get_grid_export_price_current(self) -> float | None:
        """The export rate in force right now, or None when unconfigured."""
        return self._grid_export_price_current

    def get_grid_export_price_unit(self) -> str | None:
        """The mirrored sell-price entity's own currency-per-energy unit."""
        return self._grid_export_price_unit

    def get_grid_export_price_schedule(self) -> dict[str, float]:
        """The ingested timestamp-keyed export prices, under the source's keys.

        A copy, and the whole map: the sensor republishes it wholesale on every
        ingestion so a timestamp the source dropped disappears with it.
        """
        return dict(self._grid_export_price_schedule or {})

    def get_house_consumption_forecast_current_w(self) -> float | None:
        # Report the same house demand the battery and grid forecasts are built
        # from: the adjusted forecast, whose nonDeferrable already folds in the
        # scheduled deferrable appliances (pool, car charging, ...). The raw
        # deferrableConsumers band is the model's probabilistic account of those
        # same appliances and must not be added on top, or the recorded history
        # this sensor feeds would double-count them against solar in the
        # inspector. Fall back to the unadjusted base load only while the
        # appliance pipeline is cold — never to base + deferrableConsumers.
        pipeline = self._cached_pipeline()
        forecast: dict[str, Any] | None = None
        if pipeline is not None and isinstance(pipeline.adjusted_house_forecast, dict):
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
            slot_end = slot_start + SLOT
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
        self._appliances_registry.refresh()
        pipeline = await self._async_current_pipeline(dt_util.now())
        plan = pipeline.projection_plan
        if not plan.appliances_by_id:
            return build_empty_appliance_projections_response(
                generated_at=plan.generated_at
            )
        return build_appliance_projections_response(
            plan=plan,
            registry=self._appliances_registry.current,
            hass=self._hass,
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
        if self._unloaded:
            return
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
            reference_time=request_now, reason=reason
        )
        if self._unloaded:
            return

        automation_config = self._automation_config_or_disabled()

        schedule_document = await self.schedule.read(request_now)

        if not (
            automation_config.enabled_appliance_optimizers
            or automation_config.enabled_system_optimizers
        ):
            if not has_automation_owned_actions(schedule_document):
                return
        elif not (refresh_result.forecast_refreshed and refresh_result.bundle_ready):
            return

        await self._request_replan(
            reason=reason,
            reference_time=request_now,
        )

    async def _async_build_forecast_snapshots(
        self, *, reference_time: datetime | None = None, reason: str
    ) -> _ForecastRefreshResult:
        """Build new forecast snapshots, cache them, and persist them.

        ``reason`` only reaches :meth:`_publish_solar_forecast_entities`; the
        battery/grid current-slot forecast sensors publish on the slot-aligned
        rebuild alone.
        """
        request_now = reference_time or dt_util.now()
        if self._unloaded:
            return _ForecastRefreshResult(False, False)
        try:
            builder = ConsumptionForecastBuilder(
                self._hass, self._active_config, self._slot_history
            )
            house_snapshot = await builder.build(
                reference_time=request_now,
                profile=self.training.house_profile,
                trained_at=self.training.house_profile_trained_at,
                last_outcome=self.training.house_profile_last_outcome,
                forecast_days=MAX_FORECAST_DAYS,
            )
            if self._unloaded:
                return _ForecastRefreshResult(False, False)
            # One SolarForecastBuilder.build() per refresh: its solar half
            # feeds the canonical snapshot.
            raw_solar_forecast = await SolarForecastBuilder(
                self._hass,
                self._active_config,
                self._slot_history,
            ).build(reference_time=request_now)
            if self._unloaded:
                return _ForecastRefreshResult(False, False)
            # The refresh beat is the export channel's ingestion beat: read
            # the source once here, then serve the same result to the
            # snapshot, the automation bundle and the published sensor.
            self._ingest_grid_export_price()
            grid_price_snapshot = self.grid_price_snapshot(request_now)
            solar_snapshot = self._build_canonical_solar_forecast(
                raw_solar_forecast,
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
            self._invalidate_pipeline_cache()
            await self._storage.async_save_snapshots(
                house_snapshot=house_snapshot,
                solar_snapshot=solar_snapshot,
            )
            if self._unloaded:
                return _ForecastRefreshResult(False, False)
            # Warm the appliance pipeline before publishing so the house
            # consumption sensor reports the adjusted (base + scheduled) demand,
            # keeping the recorded history it feeds aligned with the battery and
            # grid forecasts. Best-effort: a house forecast that is not
            # available leaves the pipeline cold and the sensor falls back to
            # the base load, and a pipeline failure never blocks the refresh.
            if house_snapshot.get("status") == "available":
                try:
                    await self._async_current_pipeline(
                        request_now, in_flight=(house_snapshot, solar_snapshot)
                    )
                except Exception:
                    _LOGGER.exception("Failed to warm appliance forecast pipeline")
            # The builder is the one authority on what a price is, so the
            # published sensor republishes what it just computed rather than
            # deriving the rate a second time.
            self._absorb_grid_import_price(grid_price_snapshot)
            self._absorb_grid_export_price(grid_price_snapshot)
            self.publish_forecast_entities(reason=reason)
        except Exception:
            _LOGGER.exception("Error refreshing house consumption forecast")
            return _ForecastRefreshResult(
                forecast_refreshed=False,
                bundle_ready=False,
            )

        bundle_ready = await self._async_refresh_automation_input_bundle(
            reference_time=request_now,
            house_forecast=house_snapshot,
            raw_forecast=raw_solar_forecast,
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
        return new_snapshot.get("status") == "unavailable" and not new_snapshot.get(
            "points"
        )

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

        if bundle is not None and not self._unloaded:
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
            raw_solar = (
                raw_forecast.get("solar")
                if isinstance(raw_forecast, dict) and "solar" in raw_forecast
                else raw_forecast
            )
            if isinstance(raw_solar, dict):
                solar_forecast = build_solar_forecast_response(
                    raw_solar,
                    forecast_days=MAX_FORECAST_DAYS,
                )
            else:
                solar_forecast = {"status": "unavailable", "points": []}
        return AutomationInputBundle(
            original_house_forecast=deepcopy(house_forecast),
            solar_forecast=_build_corrected_solar_forecast_view(solar_forecast),
            grid_price_forecast=self.grid_price_snapshot(reference_time),
            when_active_hourly_energy_kwh_by_appliance_id=(
                self._resolve_when_active_hourly_energy_kwh_by_appliance_id()
            ),
            runtime_hours_by_appliance_id_by_local_date=(
                await self._async_resolve_runtime_hours_by_appliance_id_by_local_date(
                    reference_time=reference_time
                )
            ),
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
        battery_forecast(); there is no adjusted forecast to
        speak of before that.
        """
        pipeline = self._cached_pipeline()
        if pipeline is None:
            return None
        return pipeline.adjusted_house_forecast

    def _get_house_forecast_composition(self) -> dict[str, Any] | None:
        """What the adjusted house forecast is made of: the base, and each appliance.

        The inspector itemises a future slot the way it itemises a past one, and
        the adjusted forecast alone cannot say who is in it — its nonDeferrable is
        one scalar with every scheduled appliance already folded in. The two
        halves that produced it are still on the pipeline, so they are handed over
        untouched: the original house forecast, and the plan's per-appliance
        demand points.

        Synchronous and cache-only, exactly like
        _get_adjusted_house_forecast_snapshot: awaiting a pipeline getter here
        would let opening a day in the inspector kick off a full appliance and
        battery forecast rebuild. Cold cache yields None and the card degrades to
        a plain forecast figure.
        """
        pipeline = self._cached_pipeline()
        if pipeline is None:
            return None
        return {
            "original_house_forecast": pipeline.original_house_forecast,
            "demand_points": pipeline.projection_plan.demand_points,
        }

    def _build_forecast_schedule_documents(
        self,
        *,
        schedule_document: ScheduleDocument,
    ) -> ForecastScheduleDocuments:
        return build_forecast_schedule_documents(
            schedule_document, self._read_schedule_control_config()
        )

    async def gather_compute_inputs(
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

        Lock-free: never takes the schedule lock, so the automation runner may
        call it while holding that lock for its whole run.
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
            appliances_registry=self._appliances_registry.current,
            battery_actual_history=battery_actual_history,
            vehicle_remaining_capacity_kwh_by_vehicle_id=(
                read_vehicle_remaining_capacity_kwh_by_vehicle_id(
                    self._hass, self._appliances_registry.current
                )
            ),
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
            active_by_id[appliance.id] = is_active_state(
                getattr(state, "state", None), active_states
            )
        return active_by_id

    async def _async_evaluate_optimizer_conditions(
        self,
    ) -> dict[str, tuple[CustomConditionGroupResult, ...]]:
        return await self.conditions.evaluate(
            read_automation_config(self._active_config)
        )

    async def _async_build_battery_actual_history(
        self, *, entity_config: Any, started_at: datetime
    ) -> list[dict[str, Any]]:
        # Deferred import: keeps the recorder-history module out of coordinator's
        # top-level imports so test harnesses that stub the battery builder (and
        # only partially stub today_slot_readers) still import the coordinator.
        from ..battery_actual_history_builder import build_battery_actual_history

        try:
            return await build_battery_actual_history(
                self._battery_boundary_history,
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
    ) -> ForecastRebuildSnapshot:
        """Async wrapper: gather I/O (unless supplied), then run the pure core.

        The core is the appliance projection plus the whole battery/grid
        simulation over the forecast horizon — the same class of CPU work the
        optimizer loop already hands to the executor. Every live value it needs
        is captured in ``compute_inputs`` here on the loop, so the hop is safe.
        """
        if compute_inputs is None:
            compute_inputs = await self.gather_compute_inputs(started_at=started_at)
        return await self._hass.async_add_executor_job(
            functools.partial(
                build_forecast_rebuild,
                config=self._active_config,
                appliances_registry=self._pinned_appliances_registry(compute_inputs),
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
        )

    def _pinned_appliances_registry(
        self, compute_inputs: ComputeInputs
    ) -> AppliancesRuntimeRegistry:
        """The registry this run computes against.

        Taken from the inputs pinned on the event loop, so a rebind of
        ``_appliances_registry.current`` mid-build cannot make one half of a run
        disagree with the other. The attribute is the fallback for a caller
        that built its inputs without one.
        """
        return compute_inputs.appliances_registry or self._appliances_registry.current

    async def _async_current_pipeline(
        self,
        now: datetime,
        *,
        in_flight: tuple[dict[str, Any], dict[str, Any] | None] | None = None,
    ) -> _ApplianceForecastPipelineSnapshot:
        """Serve the shared appliance/battery pipeline, building it at most once.

        The one read path. Readers build against the canonical house and solar
        snapshots; the refresh warming the pipeline hands over the (house,
        solar) snapshots it has just built as ``in_flight`` instead.

        The cache check, the history gather and the rebuild used to run without
        any coordination, so every caller that arrived while a build was in
        flight saw the same miss and started its own gather and simulation. The
        build lock closes that window: the first misser builds, the others wait
        and then recheck the cache it filled. The recheck compares a key built
        from freshly prepared inputs, so a waiter whose inputs are *not*
        compatible with what the winner built (different slot, schedule,
        snapshot generation or drifted battery state) still builds its own
        rather than adopting the wrong result. Waiting is cancellation-safe: a
        cancelled waiter releases its place in the lock queue and never touches
        the build another waiter is still waiting for.

        Readers acquire the canonical snapshots and corrected solar view under
        the lock, so a waiting reader sees a refresh published while it waited.
        The preparation is inside the lock too. It is what the check reads, and
        a waiter that prepared before the winner published would be deciding
        against a schedule and a battery state that have since moved.
        """
        if in_flight is not None:
            house_forecast, solar_snapshot = in_flight
            solar_forecast = (
                _build_corrected_solar_forecast_view(solar_snapshot)
                if isinstance(solar_snapshot, dict)
                else {"status": "unavailable", "points": []}
            )
        if self._unloaded:
            raise RuntimeError("Forecast service is unloaded")
        async with self._appliance_forecast_pipeline_lock:
            if self._unloaded:
                raise RuntimeError("Forecast service is unloaded")
            if in_flight is None:
                house_forecast = self._canonical_house_forecast()
                solar_snapshot = self._cached_solar_forecast
                solar_forecast = (
                    _build_corrected_solar_forecast_view(solar_snapshot)
                    if isinstance(solar_snapshot, dict)
                    else {"status": "unavailable", "points": []}
                )
            prepared = await self._async_prepare_forecast_pipeline_inputs(
                started_at=now
            )
            if self._unloaded:
                raise RuntimeError("Forecast service is unloaded")
            key = _PipelineCacheKey(
                slot_start=_forecast_slot_start(now),
                house_generated_at=house_forecast.get("generatedAt"),
                solar_signature=build_battery_forecast_solar_signature(solar_forecast),
                schedule_sig=prepared.schedule_signature,
                appliance_sig=prepared.appliance_schedule_signature,
                effective_sig=prepared.schedule_effective_signature,
            )
            entry = self._pipeline_cache
            if (
                entry is not None
                and entry.key == key
                and dt_util.as_utc(now) < dt_util.as_utc(entry.expires_at)
                and self._has_compatible_battery_forecast_live_state(
                    entry.snapshot.battery_forecast, prepared.live_state
                )
            ):
                return entry.snapshot
            return await self._async_build_appliance_forecast_pipeline(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=now,
                prepared=prepared,
                key=key,
            )

    def _cached_pipeline(self) -> _ApplianceForecastPipelineSnapshot | None:
        """The pipeline last cached, for the readers that serve it as it is."""
        entry = self._pipeline_cache
        return None if entry is None else entry.snapshot

    async def _async_prepare_forecast_pipeline_inputs(
        self,
        *,
        started_at: datetime,
    ) -> _PreparedForecastPipelineInputs:
        """Load the schedule and live state, and derive the cache signatures."""
        schedule_document = await self.schedule.read(started_at)
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
        return _PreparedForecastPipelineInputs(
            forecast_schedule_document=forecast_schedule_document,
            projection_schedule_document=projection_schedule_document,
            live_state=run_live_state,
            schedule_signature=build_battery_forecast_schedule_signature(
                forecast_schedule_document
            ),
            appliance_schedule_signature=(
                build_appliance_projection_schedule_signature(
                    projection_schedule_document
                )
            ),
            schedule_effective_signature=(
                build_battery_forecast_schedule_effective_signature(
                    forecast_schedule_document,
                    reference_time=started_at,
                    battery_entity_config=battery_entity_config,
                    live_state=run_live_state,
                )
            ),
        )

    async def _async_build_appliance_forecast_pipeline(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        prepared: _PreparedForecastPipelineInputs,
        key: _PipelineCacheKey,
    ) -> _ApplianceForecastPipelineSnapshot:
        history_hourly_energy_kwh_by_appliance_id = (
            self._build_history_projection_hourly_energy_by_appliance_id(
                schedule_document=prepared.projection_schedule_document,
            )
        )
        # Taken before the awaits: anything that invalidates the cache while the
        # history gather or the simulation is in flight makes this build's result
        # obsolete, and an obsolete build must not overwrite the newer state.
        # The revision alone is not enough, because the snapshots this build was
        # handed were read by the caller long before it got here: see
        # :meth:`_cache_holds_newer_pipeline`.
        revision = self._forecast_cache_revision
        compute_inputs = await self.gather_compute_inputs(
            started_at=started_at,
            live_state=prepared.live_state,
        )
        if self._unloaded:
            raise RuntimeError("Forecast service is unloaded")
        rebuild = await self._async_build_forecast_rebuild(
            solar_forecast=solar_forecast,
            original_house_forecast=house_forecast,
            started_at=started_at,
            forecast_schedule_document=prepared.forecast_schedule_document,
            projection_schedule_document=prepared.projection_schedule_document,
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
        if (
            not self._unloaded
            and revision == self._forecast_cache_revision
            and not (
                self._cache_holds_newer_pipeline(
                    house_forecast=house_forecast, started_at=started_at
                )
            )
        ):
            # Keyed on the slot the battery forecast itself says it started in:
            # one without a ``startedAt`` -- every status short of a simulated
            # one -- then matches no read and is rebuilt by the next reader.
            self._pipeline_cache = _PipelineCacheEntry(
                key=replace(
                    key,
                    slot_start=_battery_forecast_slot_start(pipeline.battery_forecast),
                ),
                expires_at=dt_util.as_local(
                    dt_util.as_utc(started_at)
                    + timedelta(seconds=BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS)
                ),
                snapshot=pipeline,
            )
        else:
            # The caller asked for exactly these inputs, so it still gets what it
            # asked for; the cache keeps the newer state and the next reader
            # rebuilds against it.
            _LOGGER.debug(
                "Appliance forecast pipeline was superseded while building; "
                "serving the build without caching it"
            )
        return pipeline

    def _invalidate_pipeline_cache(self) -> None:
        self._forecast_cache_revision += 1
        self._pipeline_cache = None

    def _cache_holds_newer_pipeline(
        self,
        *,
        house_forecast: dict[str, Any],
        started_at: datetime,
    ) -> bool:
        """Whether the cache already holds a pipeline this build would set back.

        A caller reads the canonical house and solar snapshots and only then
        works its way here, so a build can be handed superseded snapshots and
        still find the cache revision untouched: the refresh that published the
        newer snapshots invalidated the cache and then filled it again, all
        before this build sampled the revision. Storing at that point would put
        the older forecast back, and the readers that serve it without a
        signature -- the current battery forecast, the adjusted house forecast,
        the house composition -- would publish it for the rest of the slot.
        """
        entry = self._pipeline_cache
        if entry is None:
            return False
        if dt_util.as_utc(entry.snapshot.started_at) > dt_util.as_utc(started_at):
            return True
        cached_generated_at = dt_util.parse_datetime(entry.key.house_generated_at or "")
        generated_at = dt_util.parse_datetime(house_forecast.get("generatedAt") or "")
        return (
            cached_generated_at is not None
            and generated_at is not None
            and cached_generated_at > generated_at
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
            appliance.id: self.training.appliance_energy_estimates.get(appliance.id)
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
        if not appliance.projection.uses_history_average:
            return appliance.projection.hourly_energy_kwh
        estimate = self.training.appliance_energy_estimates.get(appliance.id)
        if estimate is None or estimate <= 0:
            return appliance.projection.hourly_energy_kwh
        return estimate

    async def _async_resolve_runtime_hours_by_appliance_id_by_local_date(
        self,
        *,
        reference_time: datetime,
    ) -> dict[str, dict[date, float]]:
        """Resolve recorder runtime hours per appliance per local date (A2).

        Only resolved for appliances referenced by an enabled ``appliance_runtime``
        optimizer; every other appliance (and the recorder) is left untouched.
        Each appliance gets its own lookback -- its largest configured
        ``max_consecutive_skips`` plus one day, so the consecutive-skip guard can
        be evaluated -- plus today-so-far for the current-day budget. One
        appliance configured to tolerate a fortnight of skips no longer widens
        every other appliance's window to match.

        The reader batches the reads and keeps the days that have settled, so
        the queries follow the number of distinct windows rather than the number
        of appliances; see :class:`ApplianceRuntimeHistoryReader`.

        The reader fills every local date in the appliance's own window,
        explicit zeros included, so a day the appliance never ran is present
        rather than absent — the consecutive-skip guard walks back day by day
        and must be able to see fully-idle days. An appliance whose read failed
        comes back empty instead, exactly as it did when each appliance was read
        on its own, so a failure never masquerades as a run of idle days.
        """
        lookback_days_by_appliance_id = resolve_runtime_history_requirements(
            self._automation_config_or_disabled()
        )
        if lookback_days_by_appliance_id is None:
            return {}

        requests: list[ApplianceRuntimeRequest] = []
        for appliance in self._iter_automation_candidate_appliances():
            lookback_days = lookback_days_by_appliance_id.get(appliance.id)
            if lookback_days is None:
                continue
            entity_id, active_states = _resolve_runtime_entity_and_states(appliance)
            if entity_id is None:
                continue
            requests.append(
                ApplianceRuntimeRequest(
                    key=appliance.id,
                    entity_id=entity_id,
                    active_states=active_states,
                    lookback_days=lookback_days,
                )
            )
        if not requests:
            return {}

        reader = self._appliance_runtime_history
        try:
            queried = await reader.async_query_active_hours_by_local_date(
                requests,
                reference_time=reference_time,
            )
        except Exception:
            _LOGGER.exception("Error resolving automation runtime history")
            return {request.key: {} for request in requests}

        return {request.key: queried.get(request.key) or {} for request in requests}

    def _iter_automation_candidate_appliances(
        self,
    ) -> list[GenericApplianceRuntime | ClimateApplianceRuntime]:
        return [
            appliance
            for appliance in self._appliances_registry.current.appliances
            if appliance.kind in _AUTOMATION_CANDIDATE_KINDS
        ]

    def _iter_projected_history_appliances(
        self,
        *,
        schedule_document: ScheduleDocument,
    ) -> list[GenericApplianceRuntime | ClimateApplianceRuntime]:
        projected: list[GenericApplianceRuntime | ClimateApplianceRuntime] = []
        seen_appliance_ids: set[str] = set()

        for slot_actions in schedule_document.slots.values():
            for appliance_id, action in appliance_actions(slot_actions).items():
                if appliance_id in seen_appliance_ids:
                    continue

                appliance = self._appliances_registry.current.get_appliance(
                    appliance_id
                )
                if not is_projected_history_action_active(
                    appliance=appliance,
                    action=action,
                ):
                    continue
                if appliance.projection.history_energy_entity_id is None:
                    continue

                seen_appliance_ids.add(appliance_id)
                projected.append(appliance)

        return projected

    def _has_compatible_battery_forecast_live_state(
        self, battery_forecast: dict[str, Any], live_state: Any
    ) -> bool:
        if live_state is None:
            return True

        current_soc = battery_forecast.get("currentSoc")
        current_remaining_energy_kwh = battery_forecast.get("currentRemainingEnergyKwh")
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

    def _start_forecast_refresh(self) -> None:
        """Start the slot-aligned house forecast refresh schedule."""
        if self._unsub_forecast_refresh is not None:
            return

        @callback
        def _on_forecast_interval(fired_at: datetime) -> None:
            # Home Assistant does not fire this on the boundary. It draws a
            # microsecond offset in [50ms, 500ms] once, when the listener is
            # attached, schedules every firing at boundary + that offset, and
            # then hands the callback the real clock -- so ``fired_at`` is
            # always past the boundary, by the same amount for the whole
            # session. Snap it back, or every rebuild this starts stamps its
            # first slot short by that offset and the battery/grid current-slot
            # sensors -- whose guard refuses a short first slot -- spend the
            # session unavailable. See #204.
            self._create_tracked_refresh_task(
                self._async_refresh_forecast(
                    reason=SLOT_ALIGNED_REFRESH_REASON,
                    reference_time=get_local_current_slot_start(
                        dt_util.as_local(fired_at),
                        interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
                    ),
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
