from __future__ import annotations

import asyncio
import functools
import logging
from collections import OrderedDict
from collections.abc import Callable, Collection, Coroutine, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any, NamedTuple
from zoneinfo import ZoneInfo

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.start import async_at_started
from homeassistant.util import dt as dt_util

from .appliance_runtime_history import (
    ApplianceRuntimeHistoryReader,
    ApplianceRuntimeRequest,
)
from .appliances.climate_appliance import ClimateApplianceRuntime
from .appliances.config import build_appliances_runtime_registry
from .appliances.dto import ApplianceMetadataResponseDict, build_appliances_response
from .appliances.generic_appliance import GenericApplianceRuntime
from .appliances.projection_builder import (
    ApplianceProjectionPlan,
    read_vehicle_remaining_capacity_kwh_by_vehicle_id,
)
from .appliances.projection_response import (
    ApplianceProjectionsResponseDict,
    build_appliance_projections_response,
    build_empty_appliance_projections_response,
)
from .appliances.registry_holder import AppliancesRegistryHolder
from .appliances.state import AppliancesRuntimeRegistry
from .automation.compute_inputs import (
    ComputeInputs,
    CustomConditionGroupResult,
    CustomConditionResult,
)
from .automation.compute_inputs import condition_met_map as _condition_met_map
from .automation.condition_trace import (
    ConditionTrace,
    evaluate_traced,
    extract_entity_ids,
    read_entity_params,
    stamp_params,
)
from .automation.config import (
    AutomationConfig,
    AutomationConfigError,
    ConditionGroup,
    read_automation_config,
)
from .automation.coverage import AutomationCoverageDict, build_automation_coverage
from .automation.day_context_store import DayContextStore
from .automation.explain import ExplanationBook, RunExplanation
from .automation.input_bundle import AutomationInputBundle
from .automation.ownership import has_automation_owned_actions
from .automation.triggers import AutomationTriggerCoordinator
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
    AUTOMATION_CONDITION_PLAN_FRESHNESS_SECONDS,
    BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS,
    DATA_CHANGED_KIND_PLAN,
    DATA_CHANGED_KIND_SCHEDULE,
    DATA_CHANGED_KIND_SOLAR_BIAS,
    DATA_CHANGED_KIND_TRAINING,
    DEFAULT_FORECAST_DAYS,
    EVENT_DATA_CHANGED,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_STALE_AFTER_SECONDS,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
    SCHEDULE_SLOT_MINUTES,
    SIGNAL_FORECAST_PUBLISHED,
    SLOT_ALIGNED_REFRESH_REASON,
    entry_signal,
)
from .consumption_forecast_builder import (
    ConsumptionForecastBuilder,
    read_house_forecast_request,
)
from .controllables.config import (
    CONTROLLABLE_ID_INVERTER,
    entity_friendly_name,
    is_active_state,
    iter_devices,
    own_meter,
    peek_controllable_id,
    read_carved_meters,
    running_active_states,
)
from .controllables.spec import (
    CONTROLLABLE_KIND_CLIMATE,
    CONTROLLABLE_KIND_GENERIC,
    CONTROLLABLE_KIND_INVERTER,
    spec_for,
)
from .device_reports.dataset import (
    DeviceDataset,
    build_device_dataset,
    dataset_statistic_ids,
    find_house_node,
)
from .device_reports.reports import ReportQuery, build_report
from .entity import remove_stale_entities
from .forecast.assembly import (
    ApplianceScheduleSignature,
    BatteryScheduleSignature,
    EffectiveScheduleSignature,
    ForecastRebuildSnapshot,
    ForecastScheduleDocuments,
    SolarSignature,
    build_appliance_projection_schedule_signature,
    build_automation_snapshot,
    build_battery_forecast_schedule_effective_signature,
    build_battery_forecast_schedule_signature,
    build_battery_forecast_solar_signature,
    build_forecast_rebuild,
    build_forecast_schedule_documents,
    is_projected_history_action_active,
    resolve_runtime_history_requirements,
)
from .forecast_builder import SolarForecastBuilder, read_solar_forecast_entities
from .grid_flow_forecast_builder import build_grid_flow_forecast_snapshot
from .grid_flow_forecast_response import build_grid_flow_forecast_response
from .grid_price_forecast_builder import (
    GridPriceForecastBuilder,
    read_grid_sell_price_entity_id,
)
from .grid_price_forecast_response import build_grid_price_forecast_response
from .house_device_consumers import extract_house_device_consumers
from .house_forecast_response import build_house_forecast_response
from .live_power import LivePowerTracker
from .point_forecast_response import build_solar_forecast_response
from .scheduling.actual_history import build_entity_actual_histories
from .scheduling.normal_state import (
    build_controllable_entity,
    build_controllable_entities,
    iter_controllable_sources,
)
from .scheduling.schedule import (
    ScheduleActionSetBy,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleResponseDict,
    ScheduleSlot,
    appliance_actions,
    describe_schedule_control_config_issue,
    read_schedule_control_config,
    strip_candidate_actions,
)
from .scheduling.schedule_executor import ScheduleExecutor
from .scheduling.schedule_service import ScheduleService
from .slot_grid import SLOT, SLOT_MINUTES, get_local_current_slot_start
from .solar_bias_correction.models import read_bias_config
from .solar_bias_correction.response import build_bias_correction_payload
from .solar_bias_correction.service import SolarBiasCorrectionService
from .solar_bias_correction.service import health_for as solar_bias_health_for
from .solar_inspector.service import SolarInspector
from .span_history_model import SpanMeters, read_span_meters, recorder_tail_start
from .storage import HelmanStorage
from .today_slot_readers import (
    TodaySlotBoundaryStateReader,
    TodaySlotEnergyReader,
)
from .training.appliance_energy import health_for as appliance_energy_health_for
from .training.appliance_energy import read_appliance_energy_training_request
from .training.artifacts import TrainingArtifacts
from .training.batch import TrainingBatch
from .training.house_consumption import HouseTrainingRequest
from .training.house_consumption import health_for as house_consumption_health_for
from .training.solar_bias import SolarBiasTrainingJob
from .tree_builder import HelmanTreeBuilder, TreeIndex
from .vendors import resolve_vendor_config

_LOGGER = logging.getLogger(__name__)
# Sentinel distinguishing "battery live state not supplied" from "supplied as
# None" (None legitimately means the battery is unavailable). Lets a caller that
# has already read the live state once per run pass it through instead of the
# callee re-reading hass.states.
_LIVE_STATE_UNSET: Any = object()
_UNAVAILABLE_ENTITY_STATES = {"unknown", "unavailable", "none"}
#: How long a device dataset for a period still in progress is reused: the
#: card's own memo of an open period, so the backend never serves one older.
_OPEN_DATASET_TTL = timedelta(minutes=5)
#: How many periods' device datasets are kept. Report navigation touches a few
#: at a time.
_DEVICE_DATASET_CACHE_SIZE = 8
_BATTERY_FORECAST_CACHE_SOC_TOLERANCE = 1.0
_BATTERY_FORECAST_CACHE_ENERGY_TOLERANCE_KWH = 0.1
_FORECAST_STALE_HINT = (
    "Forecast data has not been rebuilt for over an hour. "
    "Check the Home Assistant log for forecast refresh errors."
)
#: A full canonical forecast slot, in hours. The snapshot's first series entry
#: is stamped at build time; off the slot-aligned beat it covers only the slot's
#: remainder, carrying ``durationHours`` short of this with its four energies
#: scaled down to match.
_FULL_FORECAST_SLOT_HOURS = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60

#: How far short of a full slot a first entry may fall and still count as whole.
#: One second. The slot-aligned rebuild is snapped to the boundary, so this only
#: absorbs clock and event-loop slop; the partial entries the guard exists to
#: refuse are stamped *minutes* in, not milliseconds. The tolerance this
#: replaced was 3.6us -- smaller than the scheduler's own minimum jitter, so it
#: refused the aligned rebuild too, and the sensors only ever published because
#: ``simulate_slot`` rounds ``durationHours`` to four places. See #204.
_FORECAST_SLOT_DURATION_TOLERANCE_HOURS = 1 / 3600

if TYPE_CHECKING:
    from .automation.pipeline import AutomationRunResult

#: kWh -> Wh for the battery forecast series. See _battery_forecast_slot_values.
_BATTERY_FORECAST_KWH_TO_WH = 1000.0


def _training_job_status(
    job_id: str,
    *,
    enabled: bool,
    health: str,
    last_outcome: str | None,
    error_reason: str | None,
    trained_at: str | None,
    last_attempt_at: str | None,
    artifact_in_use: bool,
    is_stale: bool | None,
    issues: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "id": job_id,
        "enabled": enabled,
        "health": health,
        "lastOutcome": last_outcome,
        "errorReason": error_reason,
        "trainedAt": trained_at,
        # ``None`` on a document written before attempts were recorded: *not
        # recorded*, never *never attempted*.
        "lastAttemptAt": last_attempt_at,
        "artifactInUse": artifact_in_use,
        # Every ``failed`` outcome is written through a preserve-on-failure
        # path, so a failed job still serving something is serving an older
        # result. No timestamps involved, so pre-upgrade documents read right.
        "usingOlderArtifact": health == "failed" and artifact_in_use,
        "isStale": is_stale,
        "issues": issues,
    }


def _stored_training_job_status(
    job_id: str,
    section: dict[str, Any] | None,
    *,
    health: str,
    artifact_in_use: bool,
    read_live_fingerprint: Callable[[], str],
    issues: list[dict[str, str]],
) -> dict[str, Any]:
    """One ``TrainingArtifactsStore`` job's status entry."""
    section = section or {}
    stored_fingerprint = section.get("fingerprint")
    is_stale: bool | None
    try:
        live_fingerprint = read_live_fingerprint()
    except Exception:
        _LOGGER.debug(
            "Could not read the live %s fingerprint", job_id, exc_info=True
        )
        is_stale = None
    else:
        # Nothing trained against any configuration cannot be stale.
        is_stale = (
            stored_fingerprint is not None and stored_fingerprint != live_fingerprint
        )
    return _training_job_status(
        job_id,
        # Neither job has a switch of its own: it always runs.
        enabled=True,
        health=health,
        last_outcome=section.get("last_outcome"),
        error_reason=section.get("error_reason"),
        trained_at=section.get("trained_at"),
        last_attempt_at=section.get("last_attempt_at"),
        artifact_in_use=artifact_in_use,
        is_stale=is_stale,
        issues=issues,
    )


def _series_timestamp_at(series: list[Any], index: int) -> str:
    """One end of a forecast series' covered range, for a log line.

    Only ever used to say what a series *did* hold when the slot being looked
    for was not in it (#204), so anything unreadable is named rather than
    raised on — a malformed entry is itself the answer to why the lookup missed.
    """
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


#: The kinds whose runtime history and live running state automation reads: the
#: ones an ``appliance_runtime`` optimizer can drive. An EV charger's ``charge``
#: switch would answer the same question, but nothing plans against it yet.
_AUTOMATION_CANDIDATE_KINDS = (CONTROLLABLE_KIND_GENERIC, CONTROLLABLE_KIND_CLIMATE)


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


@dataclass(frozen=True)
class _CachedDeviceDataset:
    """One period's device dataset, and what it was built from and when."""

    #: The device tree object the dataset was built from. A tree change replaces
    #: the coordinator's tree object, so identity alone says the entry is stale.
    tree: dict
    dataset: DeviceDataset
    fetched_at: datetime
    #: The month-row cache's generation when the read began. A backfill into
    #: past statistics moves it on, and the rows behind the dataset with it.
    generation: int


@dataclass
class _BackfillJob:
    """One background statistics back-fill job and its starting state."""

    name: str
    ready: Callable[[], bool]
    start: Callable[[], Coroutine[Any, Any, None]]
    started: bool = False
    task: asyncio.Task[None] | None = None


class HelmanCoordinator:

    def __init__(
        self, hass: HomeAssistant, storage: HelmanStorage, entry: ConfigEntry
    ) -> None:
        self._hass = hass
        self._storage = storage
        self._entry = entry
        self._forecast_published_signal = entry_signal(
            SIGNAL_FORECAST_PUBLISHED, entry.entry_id
        )
        self._cached_tree: dict | None = None
        self._tree_index: TreeIndex | None = None
        self._unloaded = False
        self._device_datasets: OrderedDict[
            tuple[date, date, ZoneInfo], _CachedDeviceDataset
        ] = OrderedDict()
        self._unsub_listeners: list = []
        # The sensor platform's add callback and the factories of the entities
        # the device tree decides the number of, keyed by kind; the entities
        # built so far are kept per kind and node so a rebuild can diff them.
        self._async_add_entities: Callable | None = None
        self._dynamic_sensor_factories: Mapping[str, Callable] = {}
        self._dynamic_sensors: dict[str, dict[str, Any]] = {}
        self._removing_entity_ids: set[str] = set()
        # The hardware profiles fill the slots they own here, so nothing
        # downstream knows they exist. `async_setup` re-reads and logs.
        self._active_config: dict[str, Any] = resolve_vendor_config(
            hass, storage.config
        )[0]
        # House forecast snapshot (persisted + cached)
        self._cached_forecast: dict | None = None
        # The import rate in force right now, refreshed with the forecast
        # snapshots. Nothing else records it, so this is what the published
        # sensor hands the recorder to archive.
        self._grid_import_price_current: float | None = None
        self._grid_import_price_unit: str | None = None
        # The export rate in force right now, mirrored off the configured
        # sell-price entity on the same beat. Its own entity typically declares
        # no `state_class`, so this mirror is what gives the rate a long-term
        # statistics series to price history from.
        self._grid_export_price_current: float | None = None
        self._grid_export_price_unit: str | None = None
        #: The owned export channel: the one ingestion of the configured
        #: sell-price entity, and the only thing current price, unit,
        #: availability, the published schedule and every backend consumer are
        #: served from. None until the first ingestion.
        self._grid_export_price_channel: dict[str, Any] | None = None
        #: The source's own timestamp-keyed prices, kept verbatim so the
        #: published sensor's attributes can be compared key for key with the
        #: entity they were ingested from.
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
        #: (slot start, snapshot) for `grid_price_snapshot`'s per-slot hold.
        self._grid_price_snapshot_cache: tuple[datetime, dict[str, Any]] | None = None
        #: The appliance/battery pipeline last built, what it was built from and
        #: until when it may be served. See :meth:`_async_current_pipeline`.
        self._pipeline_cache: _PipelineCacheEntry | None = None
        #: Serializes appliance/battery pipeline builds so concurrent cache
        #: misses gather history and simulate once instead of once each. Held
        #: across the recheck as well, or the losers would race straight back
        #: into their own build. See
        #: :meth:`_async_current_pipeline`.
        self._appliance_forecast_pipeline_lock = asyncio.Lock()
        #: Bumped by every forecast-cache invalidation. A build that started
        #: before the bump publishes nothing, so a late result can never
        #: overwrite the newer state.
        self._forecast_cache_revision = 0
        # The last (reason, slot) :meth:`get_battery_forecast_current` logged a
        # refusal for. The accessor runs on every state read of the five
        # current-slot entities, so an unguarded log line there would repeat
        # some tens of times per slot; keying on the slot collapses a whole
        # dead stretch to one line per reason per slot. See #204.
        self._battery_forecast_current_miss: tuple[str, str] | None = None
        # The last full-slot value map :meth:`get_battery_forecast_current`
        # served, and the slot it belongs to. An off-beat rebuild replaces the
        # snapshot's entry for the slot in progress with a build-time partial,
        # and the accessor refuses those; this is what it answers with instead,
        # so a slot the beat already filled keeps its value for the rest of its
        # quarter hour. The slot key is the whole expiry -- a map recorded under
        # a slot that has passed can never be served. See #204.
        self._battery_forecast_current_slot: (
            tuple[str, dict[str, float]] | None
        ) = None
        self._create_task = getattr(self._hass, "async_create_task", asyncio.create_task)
        self._refresh_tasks: set[asyncio.Task[Any]] = set()
        self._automation_input_bundle: AutomationInputBundle | None = None
        self._day_context_store = DayContextStore(hass)
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
        # entry in that config — per-entry so each result stands on its own —
        # and the entities each entry reads). The entity ids are a pure function
        # of the config, so they are extracted once here beside the checker;
        # only their *states* are re-read per run.
        self._optimizer_condition_checkers: dict[
            tuple[str, int], tuple[Any, tuple[Any, ...], tuple[tuple[str, ...], ...]]
        ] = {}
        # (optimizer_id, group_index) -> the newest evaluation of that group's
        # `custom` conditions: when it ran, the config it ran, and the HA
        # condition trace it produced. Rebuilt wholesale each run, so a group
        # dropped from config leaves nothing behind.
        # Only the newest is kept, while the explanation book accumulates rows
        # across runs — a trace can therefore be newer than the row a reader
        # clicked, which is why `runAt` travels with it. Not persisted, for the
        # same reasons as the book above.
        self._condition_traces: dict[tuple[str, int], dict[str, Any]] = {}
        # Plan-freshness bookkeeping for the pre-execution reality check:
        # the condition map the current plan was built from, and when.
        self._last_automation_plan_at: datetime | None = None
        self._last_plan_condition_map: dict[str, tuple[bool, ...]] = {}
        self._automation_triggers = AutomationTriggerCoordinator(
            create_task=self._create_task,
            run_callback=self._async_run_automation_trigger_request,
        )
        self._unsub_forecast_refresh: Callable[[], None] | None = None
        self._appliances_registry = AppliancesRegistryHolder(self._hass, lambda: self._active_config)
        #: The stored schedule, its lock and its executor. See ScheduleService.
        self.schedule = ScheduleService(
            hass,
            storage,
            self._appliances_registry,
            read_battery_soc_bounds=self._read_battery_soc_bounds,
            announce_changed=lambda: self._fire_data_changed(
                DATA_CHANGED_KIND_SCHEDULE
            ),
            read_control_config=self._read_schedule_executor_control_config,
            read_battery_state=self._read_schedule_executor_battery_state,
            check_reality_and_maybe_replan=self._async_reality_check_and_maybe_replan,
        )
        self._solar_bias_store: Any = None
        self._solar_bias_service: SolarBiasCorrectionService | None = None
        self._solar_inspector: SolarInspector | None = None
        self._training_batch: TrainingBatch | None = None
        #: The training artifacts store and the house profile, appliance
        #: estimates and shared-meter weights adopted from it.
        self.training = TrainingArtifacts(
            hass,
            read_house_request=self._read_house_training_request,
            read_house_fingerprint=lambda: read_house_forecast_request(
                self._active_config
            ).config_fingerprint,
            read_appliance_request=lambda: read_appliance_energy_training_request(
                self._active_config, self._iter_automation_candidate_appliances()
            ),
            training_batch=lambda: self._training_batch,
            run_when_started=self._run_when_started,
            on_adopted=self._async_on_training_adopted,
        )
        #: The live power tick, its history buffers and the derived live values.
        self.live = LivePowerTracker(
            hass,
            entry.entry_id,
            read_config=lambda: self._active_config,
            read_shared_meter_weights=lambda: self.training.shared_meter_weights,
        )
        # Today's completed slots are immutable, so the reader keeps the ones it
        # has already resolved. It lives here because the forecast builder is
        # rebuilt on every refresh and a cache inside it would never be read.
        self._slot_history = TodaySlotEnergyReader(hass)
        # The same bargain for the battery's state of charge, whose completed
        # boundaries are equally immutable. One reader for the whole
        # integration is what lets the forecast warm-up and the automation run
        # that follows it share the day they have both already read.
        self._battery_boundary_history = TodaySlotBoundaryStateReader(hass)
        # And the same again for appliance runtime: a completed day's hours are
        # settled, so the automation's lookback is read once and only its tail
        # is asked for again.
        self._appliance_runtime_history = ApplianceRuntimeHistoryReader(hass)
        # The rebuild currently in flight, if any, so a second trigger joins it
        # instead of starting its own 56-day recorder scan.
        self._forecast_refresh_task: asyncio.Task[Any] | None = None
        self._last_schedule_control_config_issue: str | None = None
        self._last_schedule_battery_state_issue: str | None = None

    @property
    def config(self) -> dict:
        return self._active_config

    def record_run_explanation(self, explanation: RunExplanation | None) -> None:
        """Merge one successful run's condition record into the book.

        Called only from the optimizer loop's success path — a failed run never
        gets here, so the accumulated record survives it intact.
        """
        if explanation is None:
            return
        self._explanation_book.record(explanation)

    def get_schedule_explanation(
        self, *, controllable_id: str, date: str
    ) -> dict[str, Any] | None:
        """The condition record for one schedule lane on one date.

        ``controllable_id`` is the lane's identity — the controllable's own id,
        ``inverter`` included — and the result carries **every** optimizer that
        touched it, in pipeline order: the inverter lane is written by three
        optimizer kinds, so a lane click has no single optimizer to ask.
        """
        return self._explanation_book.get(
            controllable_id=controllable_id, date=date
        )

    def get_condition_trace(
        self, *, optimizer_id: str, group_index: int
    ) -> dict[str, Any] | None:
        """The last evaluation of one condition group's ``custom`` conditions.

        Home Assistant's own condition trace, over the group's ``custom`` list
        and carrying the config it ran, so the caller can render it with HA's
        trace components rather than inventing a second way to draw a condition
        tree. Beside it, keyed by the same entry root paths, the entities each
        entry read and what they said -- the part an entity platform condition
        leaves out of the trace entirely.

        ``None`` where nothing is recorded: before the first run, for a group
        with no ``custom`` conditions (nothing is evaluated, so nothing is
        traced), and for a group that has since left the config.
        """
        return self._condition_traces.get((optimizer_id, group_index))

    def _record_automation_run(self, result: AutomationRunResult) -> None:
        # Record the condition map + time this plan was built from, so the
        # condition-check poll can detect a flip and trigger a fast re-plan.
        if result.ran_automation and result.snapshot is not None:
            self._last_automation_plan_at = result.snapshot.context.now
            self._last_plan_condition_map = dict(
                result.snapshot.context.condition_met_by_optimizer_id
            )
        # Fired even when the merged result equalled the stored document and no
        # write happened: the explanation book and the derived forecasts still
        # moved, and the inspector draws those.
        self._fire_data_changed(DATA_CHANGED_KIND_PLAN)

    def set_entity_factory(
        self,
        async_add_entities: Callable,
        factories: Mapping[str, Callable],
    ) -> None:
        """Take over the entities the device tree decides the number of.

        ``factories`` maps a kind (``unmeasured``, ``share``) to the callable
        that builds one entity of it from a node. The entities are added here,
        and added and removed again by every tree rebuild.
        """
        self._async_add_entities = async_add_entities
        self._dynamic_sensor_factories = factories
        self._sync_derived_sensors()
        wanted_ids = {
            f"{self._entry.entry_id}_{kind}_power_"
            f"{node_id.removeprefix('sensor.') if kind == 'unmeasured' else node_id}"
            for kind, sensors in self._dynamic_sensors.items()
            for node_id in sensors
        }
        prefixes = tuple(
            f"{self._entry.entry_id}_{kind}_power_" for kind in ("unmeasured", "share")
        )
        remove_stale_entities(
            self._hass,
            self._entry,
            "sensor",
            lambda unique_id: unique_id.startswith(prefixes) and unique_id not in wanted_ids,
        )

    def _publish_solar_forecast_entities(self, *, reason: str) -> None:
        """Tell the forecast and price sensors to write their state now.

        The back-fill jobs start right after, on the same beat: a job's first
        statistics import must not run before its target entity has published a
        value and a unit.
        """
        async_dispatcher_send(self._hass, self._forecast_published_signal, reason)
        self._maybe_start_backfill_jobs()

    async def async_setup(self) -> None:
        """Register event listeners that invalidate the cached tree."""
        self._active_config, vendor_issues = resolve_vendor_config(
            self._hass, self._storage.config
        )
        # An unresolved entity leaves its slot unset; anything else here got
        # past save only by a hand edit. Either way, say so and start anyway.
        for issue in vendor_issues:
            _LOGGER.warning("Hardware profile (%s): %s", issue.code, issue.message)
        from .storage import SolarBiasCorrectionStore

        self._solar_bias_store = SolarBiasCorrectionStore(self._hass)
        await self._solar_bias_store.async_load()
        bias_config = read_bias_config(self._active_config)
        self._solar_bias_service = SolarBiasCorrectionService(
            self._hass,
            self._solar_bias_store,
            bias_config,
            on_status_changed=self._on_solar_bias_changed,
        )
        await self._solar_bias_service.async_setup()
        self._solar_inspector = SolarInspector(
            self._hass,
            config=self._active_config,
            live_sources=self,
            bias_service=self._solar_bias_service,
        )
        await self.training.async_load()
        # Unconditionally, outside any bias enable gate: with bias correction
        # off, a gated batch would never fit the house consumption profile and
        # the house forecast would sit at unavailable forever.
        self._training_batch = TrainingBatch(
            self._hass,
            solar_bias_job=SolarBiasTrainingJob(
                self._solar_bias_service,
                on_trained=self._async_on_solar_bias_trained,
            ),
            house_consumption_job=self.training.house_consumption_job,
            appliance_energy_job=self.training.appliance_energy_job,
            on_job_finished=functools.partial(
                self._fire_data_changed, DATA_CHANGED_KIND_TRAINING
            ),
        )
        try:
            self._training_batch.schedule(bias_config.training_time)
        except ValueError:
            _LOGGER.warning(
                "Nightly training batch not scheduled due to invalid training time: %s",
                bias_config.training_time,
            )
        self._appliances_registry.current = build_appliances_runtime_registry(
            self._active_config,
            logger=_LOGGER,
            friendly_name=functools.partial(entity_friendly_name, self._hass),
        )
        # After the registry: the stored estimates are keyed on the appliances
        # it holds, so there is nothing to adopt them against before this point.
        self.training.adopt_appliance_energy()
        self._unsub_listeners.append(
            self._hass.bus.async_listen(
                "entity_registry_updated", self._on_registry_updated
            )
        )

        # Build tree upfront to learn which power sensors to track
        self.live.track(await self.get_device_tree(), self.tree_index)

        # House forecast: load persisted snapshot and schedule recurring
        # refreshes. The persisted snapshots are served as-is however old they
        # are — a read never rebuilds, so discarding them on age would leave
        # the first card opened after a restart with nothing until the startup
        # refresh below completes. Only a snapshot that answers a *different*
        # question (entity, window, fingerprint) is thrown away.
        self._cached_forecast = self._storage.forecast_snapshot
        self._cached_solar_forecast = _adopt_stored_solar_forecast(
            self._storage.solar_forecast_snapshot
        )
        request = read_house_forecast_request(self._active_config)
        total_energy_entity_id = request.total_energy_entity_id
        training_window_days = request.training_window_days
        min_history_days = request.min_history_days
        config_fingerprint = request.config_fingerprint
        if not self._has_matching_forecast_snapshot(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            config_fingerprint=config_fingerprint,
        ):
            self._cached_forecast = None
        # The house profile is checked against the very same fingerprint (the
        # training request reads it off the same forecast request), so the
        # profile and the snapshot can never disagree about what is stale.
        self.training.adopt_house_consumption()
        reference_time = dt_util.now()
        self._start_forecast_refresh()

        await self.schedule.async_normalize()
        automation_config = self._automation_config_or_disabled()
        # Stale automation-owned actions are stripped when automation itself is
        # off. This is independent of execution_enabled: with execution off the
        # optimizers still plan, so their actions stay.
        if not (
            automation_config.enabled_appliance_optimizers
            or automation_config.enabled_system_optimizers
        ):
            await self.schedule.cleanup_automation_owned_actions(
                reference_time=reference_time,
            )
        self._schedule_startup_schedule_execution()
        self._schedule_startup_forecast_refresh()

    def _schedule_startup_schedule_execution(self) -> None:
        """Start the executor once Home Assistant has finished starting.

        Never awaited: a persisted slot whose hardware is slow or stalled must
        not hold up integration setup or Home Assistant's startup. A cold start
        therefore makes no schedule hardware writes before HA has started; a
        reload in an already-running HA starts at once, as ``async_at_started``
        fires immediately. The executor keeps running whether or not execution
        is enabled: its tick drives the pre-execution reality check, and
        whether anything is applied is decided inside the reconcile, and
        ultimately by the actuation gate.
        """
        self._run_when_started(self.schedule.async_start)

    def _schedule_startup_forecast_refresh(self) -> None:
        """Build the first forecast once Home Assistant has finished starting.

        Deferred for the same reason as the training refits (see
        ``TrainingArtifacts._schedule_refit``): the solar half reads its points
        straight off the forecast provider's daily energy entities, and on a
        cold start that integration has not registered them yet — the build
        comes back ``unavailable`` with no points a fraction of a second after
        setup. Until this fires the
        persisted snapshot is served, so the card shows the last known forecast
        rather than nothing.

        When Home Assistant is already running — a config save reloads the
        entry — ``async_at_started`` fires immediately, so **G3** is unaffected.
        """
        self._run_when_started(
            functools.partial(self._async_refresh_forecast, reason="startup")
        )

    def _run_when_started(
        self, factory: Callable[[], Coroutine[Any, Any, Any]]
    ) -> None:
        """Run ``factory()`` as a tracked task once Home Assistant has started.

        At once when it already has (a reload), as ``async_at_started`` fires
        immediately; the listener is dropped on unload either way.
        """

        @callback
        def _start(_hass: HomeAssistant) -> None:
            self._create_tracked_refresh_task(factory())

        self._unsub_listeners.append(async_at_started(self._hass, _start))

    @callback
    def _on_registry_updated(self, event) -> None:
        # Skip events triggered by our own entity removals to avoid rebuild loops.
        entity_id = event.data.get("entity_id", "")
        if entity_id in self._removing_entity_ids:
            self._removing_entity_ids.discard(entity_id)
            return
        # A rename, a disable or a new entity can change what a hardware profile
        # resolves to. Services copy their config at setup, so the change is
        # applied the way a save applies one: by reloading the entry.
        if (
            resolve_vendor_config(self._hass, self._storage.config)[0]
            != self._active_config
        ):
            self._hass.config_entries.async_schedule_reload(self._entry.entry_id)
            return
        self._cached_tree = None
        self._create_tracked_refresh_task(self._async_rebuild_subscriptions())

    @callback
    def _on_solar_bias_changed(self) -> None:
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
        if self._unloaded:
            return
        try:
            tree = await self.get_device_tree()
            if self._unloaded:
                return
            if tree == self.live.tree:
                self.live.refresh_inverter_telemetry()
                return
            self.live.track(tree, self.tree_index)
            if self._unloaded:
                return
            self._sync_derived_sensors()
        except Exception:
            logging.getLogger(__name__).exception(
                "Error rebuilding Helman subscriptions"
            )

    def _sync_derived_sensors(self) -> None:
        """Add/remove the unmeasured and share power entities to match the current tree."""
        if self._async_add_entities is None:
            return
        wanted = {
            "unmeasured": {
                node_id: (parent_sensor_id,)
                for node_id, parent_sensor_id in self.tree_index.qualifying_nodes.items()
            },
            "share": self.tree_index.share_devices,
        }
        for kind, factory in self._dynamic_sensor_factories.items():
            self._sync_node_sensors(
                self._dynamic_sensors.setdefault(kind, {}), wanted[kind], factory
            )

    def _sync_node_sensors(
        self,
        sensors: dict[str, Any],
        wanted: dict[str, tuple],
        factory: Callable,
    ) -> None:
        """Make ``sensors`` hold one entity per ``wanted`` node, built by ``factory(node_id, *args)``."""
        new_ids = set(wanted.keys())
        existing_ids = set(sensors.keys())

        # Remove stale entities from HA and entity registry
        ent_reg = er.async_get(self._hass)
        for node_id in existing_ids - new_ids:
            sensor = sensors.pop(node_id)
            entity_id = sensor.entity_id
            if entity_id:
                # Track the removal so _on_registry_updated skips the rebuild loop
                self._removing_entity_ids.add(entity_id)
                ent_reg.async_remove(entity_id)

        # Add new entities to HA
        to_add = new_ids - existing_ids
        if to_add:
            new_sensors = {node_id: factory(node_id, *wanted[node_id]) for node_id in to_add}
            sensors.update(new_sensors)
            self._async_add_entities(list(new_sensors.values()))

    @property
    def tree_index(self) -> TreeIndex:
        """Static memberships of the last built device tree."""
        assert self._tree_index is not None
        return self._tree_index

    async def get_device_tree(self) -> dict:
        """Return cached or freshly built device tree."""
        if self._cached_tree is None:
            builder = HelmanTreeBuilder(self._hass, self._active_config)
            built = await builder.build()
            self._cached_tree = built.tree
            self._tree_index = built.index
        return self._cached_tree

    async def async_device_report(self, report: str, query: ReportQuery) -> dict[str, Any]:
        """One device report over ``query``'s period, or why there can be none.

        Resolves the inputs -- the house subtree of the device tree, the six
        meters, the price windows -- reads the period once through
        :func:`~.span_history.read_span_history` and builds the dataset every
        report is a view of. ``query`` arrives validated, its end already
        clamped to today. The dataset and the report are built on the executor:
        a year of hours is seconds of Python the event loop must not wait on.
        """
        tree = await self.get_device_tree()
        if find_house_node(tree) is None:
            return {"unavailable": "no_house_node"}
        service = self._solar_inspector
        meters = read_span_meters(self._active_config)
        if meters.house is None:
            return {"unavailable": "no_house_meter"}

        local_tz = ZoneInfo(str(self._hass.config.time_zone))
        now = dt_util.now().astimezone(local_tz)
        price_config = self._get_grid_import_price_config()
        dataset = await self._async_device_dataset(
            tree, meters, query, local_tz=local_tz, now=now, price_config=price_config
        )
        # Resolved per request, not cached with the dataset: both are cheap, and
        # the navigation range moves daily.
        floor = await service.async_history_floor(now)
        price_unit = await service.async_resolve_span_currency(price_config)
        return await self._hass.async_add_executor_job(
            functools.partial(
                build_report,
                report,
                dataset,
                query,
                price_unit=price_unit,
                navigation_range={
                    "minDate": floor.isoformat(),
                    "maxDate": now.date().isoformat(),
                },
            )
        )

    async def _async_device_dataset(
        self,
        tree: dict,
        meters: SpanMeters,
        query: ReportQuery,
        *,
        local_tz: ZoneInfo,
        now: datetime,
        price_config: Any,
    ) -> DeviceDataset:
        """The dataset for ``query``'s period, reused while it still holds.

        The reports on one period are views of one dataset, so switching report
        reuses it. An entry holds while the tree is the object it was built
        from and no backfill has written into past statistics since; a complete period's then holds for good, an open one's for
        :data:`_OPEN_DATASET_TTL`.
        """
        # Deferred like the other recorder readers: test harnesses that stub
        # the recorder only partially still import the coordinator.
        from .recorder_statistics_span import (
            month_rows_generation,
            query_newest_hour_end,
        )
        from .span_history import read_span_history

        # The zone is in the key: the dates' UTC bounds and every local bucket
        # follow it, and a core time-zone change does not reload this entry.
        key = (query.start_date, query.end_date, local_tz)
        generation = month_rows_generation(self._hass)
        cached = self._device_datasets.get(key)
        if (
            cached is not None
            and cached.tree is tree
            and cached.generation == generation
            and (cached.dataset.complete or now - cached.fetched_at < _OPEN_DATASET_TTL)
        ):
            self._device_datasets.move_to_end(key)
            return cached.dataset

        local_start = datetime.combine(query.start_date, datetime.min.time(), tzinfo=local_tz)
        local_end = datetime.combine(
            query.end_date + timedelta(days=1), datetime.min.time(), tzinfo=local_tz
        )
        history = await read_span_history(
            self._hass,
            meter_ids=meters,
            extra_ids=dataset_statistic_ids(tree),
            local_start=local_start,
            local_end=local_end,
            tail_start=recorder_tail_start(local_start, local_end, now),
            import_price_windows=None if price_config is None else price_config.windows,
        )
        if history.statistics_failed:
            # The inspector degrades to an empty read; a report must not, since
            # zeros marked complete would be kept by the card for good.
            raise RuntimeError("The statistics read for the device report failed")
        if history.compiled_until.get(meters.house, local_start) < local_end:
            # The read sees only the period's own rows, so an hour the recorder
            # skipped while Home Assistant was down would keep the period
            # incomplete for good. The meter's newest row anywhere settles it.
            newest = await query_newest_hour_end(self._hass, meters.house)
            if newest is not None:
                history.compiled_until[meters.house] = newest
        dataset = await self._hass.async_add_executor_job(
            functools.partial(
                build_device_dataset, tree, history, local_tz=local_tz, now=now
            )
        )
        self._device_datasets[key] = _CachedDeviceDataset(
            tree=tree, dataset=dataset, fetched_at=now, generation=generation
        )
        self._device_datasets.move_to_end(key)
        while len(self._device_datasets) > _DEVICE_DATASET_CACHE_SIZE:
            self._device_datasets.popitem(last=False)
        return dataset

    def _get_house_deferrable_consumers(self) -> list[dict[str, Any]]:
        """The carved meters feeding the house forecast.

        One derivation, shared: the inspector splits the house actual by
        exactly the consumers the forecast is trained on, because both ask
        the ``devices`` tree the same question.
        """
        return read_carved_meters(self._active_config)

    async def _get_house_device_consumers(self) -> list[dict[str, Any]]:
        """Individually-measured house devices, from the shared device tree.

        Reuses the very tree the power card renders, so the inspector lists the
        same devices and offers the same control — including offering none where
        the card resolved no switch. See :mod:`.house_device_consumers`.
        """
        try:
            tree = await self.get_device_tree()
            if not any(node.get("id") == "house" for node in tree.get("consumers", [])):
                # The live card deliberately hides a house without a power sensor.
                # History still uses the same builder's metered relationships.
                built = await HelmanTreeBuilder(self._hass, self._active_config).build(
                    include_house_without_power=True
                )
                tree = built.tree
            return extract_house_device_consumers(tree)
        except Exception:
            _LOGGER.exception("Failed to read device tree for inspector breakdown")
            return []

    def _get_battery_soc_bounds(self) -> tuple[float, float] | None:
        bounds_config = read_battery_soc_bounds_config(self._active_config)
        if bounds_config is None:
            return None
        bounds = read_battery_soc_bounds(self._hass, bounds_config)
        if bounds is None:
            return None
        return (bounds.min_soc, bounds.max_soc)


    def _get_grid_sell_price_entity_id(self) -> str | None:
        return read_grid_sell_price_entity_id(self._active_config)

    def _get_grid_import_price_config(self):
        """The validated import-price window table, or None when unconfigured.

        Invalid config comes back as None: the inspector asking for a price rail
        is no place to raise, and the config editor already reports the error.
        """
        from .grid_price_forecast_builder import (
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

    _build_grid_price_snapshot = grid_price_snapshot

    @property
    def training_batch(self) -> TrainingBatch | None:
        return self._training_batch

    @property
    def solar_bias_service(self) -> SolarBiasCorrectionService | None:
        return self._solar_bias_service

    @property
    def solar_inspector(self) -> SolarInspector | None:
        return self._solar_inspector

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

    async def house_device_consumers(self) -> list[dict[str, Any]]:
        return await self._get_house_device_consumers()

    def battery_soc_bounds(self) -> tuple[float, float] | None:
        return self._get_battery_soc_bounds()

    def build_training_status(self) -> dict[str, Any]:
        """Every training job's status, for the config editor's Training tab.

        Total by design: a live fingerprint read that raises costs that one job
        its ``isStale`` (``None`` -- unknown, never a manufactured ``False``)
        and nothing else. Everything else comes from persistence, and showing
        that a job is broken is exactly what this is for.
        """
        batch = self._training_batch
        solar = self._solar_bias_service.get_status_payload()
        solar_health = solar_bias_health_for(solar)
        training = self.training
        house = training.store.house_consumption
        appliance = training.store.appliance_energy
        jobs = [
            {
                **_training_job_status(
                    "solar_bias",
                    enabled=solar["enabled"],
                    health=solar_health,
                    last_outcome=solar["lastOutcome"],
                    error_reason=solar["errorReason"],
                    trained_at=solar["trainedAt"],
                    last_attempt_at=solar["lastAttemptAt"],
                    artifact_in_use=solar["effectiveVariant"] == "adjusted",
                    is_stale=solar["isStale"],
                    # A wholesale failure carries the previous run's dropped days
                    # forward, because they still explain the preserved profile.
                    # They are not this attempt's, so they are not its issues.
                    issues=(
                        []
                        if solar_health == "failed"
                        else [
                            {"subject": day["date"], "reason": day["reason"]}
                            for day in solar["droppedDays"]
                        ]
                    ),
                ),
                # The Training tab's diagnostics, picked from the bias status
                # whose other fields this entry already carries.
                "details": {
                    key: solar[key]
                    for key in (
                        "minHistoryDays",
                        "usableDays",
                        "omittedSlotCount",
                        "invalidatedSlotCount",
                        "factorSummary",
                        "effectiveVariant",
                        "fallbackReason",
                    )
                },
            },
            _stored_training_job_status(
                "house_consumption",
                house,
                health=house_consumption_health_for(house),
                artifact_in_use=training.house_profile is not None,
                read_live_fingerprint=lambda: (
                    training.read_house_request().config_fingerprint
                ),
                issues=[],
            ),
            {
                **_stored_training_job_status(
                    "appliance_energy",
                    appliance,
                    health=appliance_energy_health_for(appliance),
                    # Learned weights drive the live split, and records the
                    # device detail, even when no appliance learns an estimate.
                    artifact_in_use=bool(training.appliance_energy_estimates)
                    or any(
                        weight is not None
                        for weight in training.shared_meter_weights.values()
                    )
                    or bool((appliance or {}).get("devices")),
                    read_live_fingerprint=lambda: (
                        training.read_appliance_request().fingerprint
                    ),
                    issues=[
                        {"subject": appliance_id, "reason": reason}
                        for appliance_id, reason in sorted(
                            ((appliance or {}).get("failed_appliances") or {}).items()
                        )
                    ],
                ),
                # The adopted map, not the stored document: it is what
                # projection and automation actually read. kWh per running
                # hour, keyed by controllable id.
                "estimates": dict(training.appliance_energy_estimates),
                # Every device's usage record, by deviceKey, as stored.
                "devices": dict((appliance or {}).get("devices") or {}),
            },
        ]
        return {
            "trainingTime": batch.training_time,
            "nextScheduledTrainingAt": batch.next_scheduled_at,
            "isRunning": batch.is_running,
            "currentJob": batch.current_job,
            "anyFailed": any(job["health"] == "failed" for job in jobs),
            "jobs": jobs,
        }

    def get_device_stats(self, device_key: str) -> dict[str, Any] | None:
        """One device's learned usage record, by the card's ``deviceKey``.

        Read from the store as the job left it: nothing else holds records,
        and a failed run keeps the previous ones there. The solar inspector
        keys a device by its controllable id, and a metered device's record
        lives under its meter, so such an id is resolved to that meter here;
        a meterless child's id is already its key.
        """
        section = self.training.store.appliance_energy or {}
        devices = section.get("devices") or {}
        record = devices.get(device_key)
        if record is None:
            meter = next(
                (
                    own_meter(device)
                    for device, _parent in iter_devices(self._active_config)
                    if peek_controllable_id(device) == device_key
                ),
                None,
            )
            record = devices.get(meter) if meter is not None else None
        return record if isinstance(record, dict) else None

    def _read_house_training_request(self) -> HouseTrainingRequest:
        """What the house consumption fit should answer, read live per run."""
        request = read_house_forecast_request(self._active_config)
        total_energy_entity_id = request.total_energy_entity_id
        training_window_days = request.training_window_days
        min_history_days = request.min_history_days
        config_fingerprint = request.config_fingerprint
        return HouseTrainingRequest(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            consumers_config=self._get_house_deferrable_consumers(),
            config_fingerprint=config_fingerprint,
        )

    async def _async_on_training_adopted(self, reason: str) -> None:
        """Rebuild at once once a training job's result has been adopted."""
        if self._unloaded:
            return
        await self._async_refresh_forecast(reason=reason)

    async def _async_on_solar_bias_trained(self) -> None:
        """Rebuild at once and announce that solar bias has changed."""
        if self._unloaded:
            return
        await self._async_refresh_forecast(reason="solar_bias_trained")
        self._fire_data_changed(DATA_CHANGED_KIND_SOLAR_BIAS)

    async def async_reload_training_artifacts(self) -> None:
        """Reload and adopt artifacts written by a superseded coordinator.

        A manual training request can outlive the coordinator that started it
        when a config-entry reload lands during its recorder reads. The newly
        live coordinator loaded its own store before that old run wrote, so it
        must explicitly re-read persistence once the awaited run completes.
        This reloads house consumption, appliance energy, and solar bias artifacts.
        """
        await self.training.async_reload()

        bias_store = self._solar_bias_store
        if bias_store is None and self._solar_bias_service is not None:
            bias_store = getattr(self._solar_bias_service, "_store", None)
        if bias_store is not None and hasattr(bias_store, "async_load"):
            await bias_store.async_load()

        if self._solar_bias_service is not None:
            self._solar_bias_service.load_stored_profile()

        await self._async_refresh_forecast(reason="training_artifacts_reloaded")

        if self._solar_bias_service is not None:
            self._fire_data_changed(DATA_CHANGED_KIND_SOLAR_BIAS)

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
        channel = grid_price_snapshot.get("import") if isinstance(grid_price_snapshot, dict) else None
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
        for job in self._backfill_jobs:
            if job.started or not job.ready():
                continue
            job.started = True
            job.task = self._hass.async_create_background_task(
                job.start(),
                job.name,
            )

    def _start_solar_forecast_backfill(self) -> Coroutine[Any, Any, None]:
        from .solar_forecast_backfill import async_backfill_solar_forecast_statistics

        source_entity_id = self._get_solar_forecast_source_entity_id()
        assert source_entity_id is not None
        return async_backfill_solar_forecast_statistics(
            self._hass, source_entity_id=source_entity_id
        )

    def _get_solar_forecast_source_entity_id(self) -> str | None:
        entities = read_solar_forecast_entities(self._active_config)
        return entities[0] if entities else None

    def _start_battery_forecast_backfill(self) -> Coroutine[Any, Any, None]:
        from .battery_forecast_backfill import (
            async_backfill_battery_forecast_statistics,
        )

        return async_backfill_battery_forecast_statistics(self._hass)

    def _start_grid_export_price_backfill(self) -> Coroutine[Any, Any, None]:
        from .grid_export_price_backfill import (
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

    def _read_schedule_control_config(self) -> ScheduleControlConfig | None:
        return read_schedule_control_config(self._active_config)

    def _automation_config_or_disabled(self) -> AutomationConfig:
        """The stored automation config, or a disabled one when there is none."""
        return read_automation_config(self._active_config) or AutomationConfig(
            enabled=False
        )

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

    async def async_get_entity_actual_history(
        self,
    ) -> dict[str, list[dict[str, Any]]]:
        """What each controllable entity actually did earlier today.

        The whole roster shares one reference time, so it shares one window --
        and the recorder answers a window for many entities in a single read.
        Asking per entity would queue one round-trip per controllable entity on
        the recorder's single DB thread for no gain.
        """
        control_config, registry = self._controllable_sources()
        entities = build_controllable_entities(
            control_config=control_config, registry=registry
        )
        history = await build_entity_actual_histories(
            self._hass,
            normal_states={
                entity["entityId"]: entity["normalState"] for entity in entities
            },
            reference_time=dt_util.utcnow(),
            interval_minutes=SCHEDULE_SLOT_MINUTES,
        )
        # Keep each configured instance: a control entity can serve several lanes.
        result: dict[str, list[dict[str, Any]]] = {}
        for spec, runtime in iter_controllable_sources(
            control_config=control_config, registry=registry
        ):
            entity = build_controllable_entity(spec, runtime)
            if entity is None:
                continue
            entity_id = entity["entityId"]
            controllable_id = (
                CONTROLLABLE_ID_INVERTER
                if spec.kind == CONTROLLABLE_KIND_INVERTER
                else runtime.id
            )
            result.setdefault(entity_id, []).extend(
                {
                    "controllableId": controllable_id,
                    "slot": entry["slot"],
                    "action": action,
                    "ratio": entry["ratio"],
                }
                for entry in history.get(entity_id, [])
                if (action := spec.action_from_state(runtime, entry["state"])) is not None
            )
        return result

    def _fire_data_changed(self, kind: str) -> None:
        """Announce that something the cards draw has been rewritten.

        ``async_fire`` is synchronous and non-blocking, so the schedule write
        sites may call this from inside the schedule lock without holding it a
        moment longer than the dict copy takes.

        No coalescing here on purpose: one automation run legitimately produces
        both a ``schedule`` and a ``plan`` event, and horizon pruning can add a
        third. Collapsing them belongs on the subscriber side, where a single
        debounce covers every emitter at once — including the ones fired by
        modules that never see this coordinator.
        """
        self._hass.bus.async_fire(EVENT_DATA_CHANGED, {"kind": kind})

    def _controllable_sources(self):
        """The refreshed registry and control config everything drivable is read from."""
        self._appliances_registry.refresh()
        return (
            self._read_schedule_control_config(),
            self._appliances_registry.current,
        )

    async def get_appliances(self) -> ApplianceMetadataResponseDict:
        control_config, registry = self._controllable_sources()
        return build_appliances_response(registry, control_config=control_config)

    def get_automation_coverage(self) -> AutomationCoverageDict:
        """Which automations drive each controllable.

        A stored automation section that does not parse runs nothing, so it
        covers nothing. Setup and the automation run let that error propagate;
        this read answers with an empty index instead of failing the card.
        """
        try:
            automation_config = self._automation_config_or_disabled()
        except AutomationConfigError:
            automation_config = AutomationConfig(enabled=False)
        return build_automation_coverage(automation_config)

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
            refuse("pipeline_cold", "the appliance forecast pipeline has no snapshot yet")
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
            return build_empty_appliance_projections_response(generated_at=plan.generated_at)
        return build_appliance_projections_response(
            plan=plan,
            registry=self._appliances_registry.current,
            hass=self._hass,
        )

    async def run_automation(
        self,
        *,
        reference_time: datetime | None = None,
        reason: str | None = None,
    ) -> AutomationRunResult:
        from .automation.pipeline import AutomationRunner

        result = await AutomationRunner(
            automation_config=self._automation_config_or_disabled(),
            schedule=self.schedule,
            forecast=self,
            recorder=self,
            build_snapshot=functools.partial(
                build_automation_snapshot,
                config=self._active_config,
            ),
            read_control_config=self._read_schedule_control_config,
            run_in_executor=self._hass.async_add_executor_job,
        ).run(reference_time=reference_time, run_reason=reason)
        self._record_automation_run(result)
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
    ) -> ScheduleResponseDict:
        request_now = reference_time or dt_util.now()
        response, document_changed = await self.schedule.set_slots(
            slots=slots, reference_time=request_now, set_by=set_by
        )
        if document_changed:
            await self._async_run_post_schedule_write_side_effects(
                reason="schedule_updated",
            )
            if set_by == "user":
                await self._automation_triggers.request_immediate(
                    reason="user_edit",
                    reference_time=request_now,
                )
        return response

    async def _async_run_post_schedule_write_side_effects(
        self,
        *,
        reason: str,
    ) -> None:
        # No cache invalidation here: the schedule signatures the pipeline read
        # computes cover every slot this write can have touched, so the next
        # card read rebuilds only if the plan it draws actually changed.
        self.schedule.request_reconcile(reason=reason)

    async def set_schedule_execution(
        self,
        *,
        enabled: bool,
        reference_time: datetime | None = None,
    ) -> ScheduleResponseDict:
        request_now = reference_time or dt_util.now()
        response, transitioned_on = await self.schedule.set_execution(
            enabled=enabled, reference_time=reference_time
        )
        if transitioned_on:
            await self._automation_triggers.request_immediate(
                reason="execution_enabled",
                reference_time=request_now,
            )
        return response

    # Delegates for tests/test_coordinator_schedule_execution.py, which reaches
    # these coordinator attributes and is held unchanged across the move of the
    # schedule into ScheduleService. Production code goes through
    # ``self.schedule``.

    @property
    def _schedule_executor(self) -> ScheduleExecutor:
        return self.schedule.executor

    @_schedule_executor.setter
    def _schedule_executor(self, executor: ScheduleExecutor) -> None:
        self.schedule.executor = executor

    @property
    def _schedule_execution_lock(self) -> asyncio.Lock:
        return self.schedule._execution_lock

    def _load_schedule_document(self) -> ScheduleDocument:
        return self.schedule.load()

    async def _async_normalize_schedule_document(self) -> None:
        await self.schedule.async_normalize()

    async def _persist_automation_result_locked(self, **kwargs: Any) -> bool:
        return await self.schedule.persist_automation_result(**kwargs)

    async def get_schedule(
        self, *, reference_time: datetime | None = None
    ) -> ScheduleResponseDict:
        return await self.schedule.get(reference_time=reference_time)

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
            reference_time=request_now, reason=reason
        )

        automation_config = self._automation_config_or_disabled()

        schedule_document = await self.schedule.read(request_now)

        if not (
            automation_config.enabled_appliance_optimizers
            or automation_config.enabled_system_optimizers
        ):
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
        self, *, reference_time: datetime | None = None, reason: str
    ) -> _ForecastRefreshResult:
        """Build new forecast snapshots, cache them, and persist them.

        ``reason`` only reaches :meth:`_publish_solar_forecast_entities`; the
        battery/grid current-slot forecast sensors publish on the slot-aligned
        rebuild alone.
        """
        request_now = reference_time or dt_util.now()
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
            # One SolarForecastBuilder.build() per refresh: its solar half
            # feeds the canonical snapshot.
            raw_solar_forecast = await SolarForecastBuilder(
                self._hass,
                self._active_config,
                self._slot_history,
            ).build(reference_time=request_now)
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
            self._publish_solar_forecast_entities(reason=reason)
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
        return (
            new_snapshot.get("status") == "unavailable"
            and not new_snapshot.get("points")
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

    # For the same held test file, which calls the gather by its old name.
    _async_gather_compute_inputs = gather_compute_inputs

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

        Every evaluated group also leaves its HA condition trace behind for
        :meth:`get_condition_trace`. The record is rebuilt wholesale here rather
        than pruned, so a group that has left the config simply stops being
        recorded.
        """
        automation_config = read_automation_config(self._active_config)
        if automation_config is None:
            self._prune_optimizer_condition_checkers(active_keys=set())
            self._condition_traces = {}
            return {}

        results: dict[str, tuple[CustomConditionGroupResult, ...]] = {}
        traces: dict[tuple[str, int], dict[str, Any]] = {}
        run_at = dt_util.now().isoformat()
        active_keys: set[tuple[str, int]] = set()
        for optimizer in automation_config.all_optimizers:
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
                checkers, entity_ids = await self._ensure_optimizer_condition_checkers(
                    key, group
                )
                trace: ConditionTrace = {}
                # Read before evaluating, so the reading is the one the condition
                # went on to judge rather than a state that moved in between;
                # stamped after, onto the step the evaluation left behind.
                params_by_entry = {
                    entry_index: read_entity_params(self._hass, ids)
                    for entry_index, ids in enumerate(entity_ids)
                    if ids
                }
                entries = tuple(
                    self._evaluate_optimizer_condition(
                        checker, key, entry_index, trace
                    )
                    for entry_index, checker in enumerate(checkers)
                )
                for entry_index, params in params_by_entry.items():
                    stamp_params(trace, entry_index=entry_index, params=params)
                traces[key] = {
                    "optimizerId": optimizer.id,
                    "groupIndex": group.index,
                    "runAt": run_at,
                    # The config as evaluated, so the renderer draws the tree the
                    # trace paths point into rather than a config read later.
                    "config": [dict(entry) for entry in group.custom],
                    "trace": trace,
                }
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
        self._condition_traces = traces
        return results

    async def _ensure_optimizer_condition_checkers(
        self, key: tuple[str, int], group: ConditionGroup
    ) -> tuple[tuple[Any, ...], tuple[tuple[str, ...], ...]]:
        """One checker per ``custom`` entry, and the entities each entry reads.

        Both are cached until the group's ``custom`` config changes: the entity
        ids follow from the config alone, so re-extracting them every run would
        buy nothing. Their states are what moves, and those are read at
        evaluation time.
        """
        cached = self._optimizer_condition_checkers.get(key)
        if cached is not None and cached[0] == group.custom:
            return cached[1], cached[2]
        if cached is not None:
            self._unload_optimizer_condition_checkers(cached[1])
        built = [
            await self._build_optimizer_condition_checker(
                key=key,
                entry_index=entry_index,
                condition_config=[entry],
            )
            for entry_index, entry in enumerate(group.custom)
        ]
        checkers = tuple(checker for checker, _entity_ids in built)
        entity_ids = tuple(ids for _checker, ids in built)
        self._optimizer_condition_checkers[key] = (group.custom, checkers, entity_ids)
        return checkers, entity_ids

    async def _build_optimizer_condition_checker(
        self,
        *,
        key: tuple[str, int],
        entry_index: int,
        condition_config: list[dict[str, Any]],
    ) -> tuple[Any, tuple[str, ...]]:
        """The entry's checker, and the entities its validated config reads.

        The entity ids come from the validated config rather than the raw one:
        validation is where a ``device`` condition's entity is resolved, and
        where a platform condition's ``target`` has been normalised.
        """
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
            checker = await ha_condition.async_conditions_from_config(
                self._hass, validated, _LOGGER, label
            )
            entity_ids = tuple(
                entity_id
                for entry in validated
                for entity_id in extract_entity_ids(entry)
            )
            return checker, entity_ids
        except Exception:
            _LOGGER.exception(
                "Failed to build custom conditions for %s; treating as not met",
                label,
            )
            return None, ()

    def _evaluate_optimizer_condition(
        self,
        checker: Any,
        key: tuple[str, int],
        entry_index: int,
        trace: ConditionTrace,
    ) -> CustomConditionResult:
        """Evaluate one ``custom`` entry. Build/eval failure is met=False + errored.

        What HA recorded while evaluating lands in ``trace``, the raising path
        included: whatever the entry reached before blowing up is kept, which is
        what makes an errored entry readable rather than merely flagged.
        """
        if checker is None:
            return CustomConditionResult(met=False, errored=True)
        try:
            return CustomConditionResult(
                met=bool(
                    evaluate_traced(
                        checker.async_check, entry_index=entry_index, into=trace
                    )
                )
            )
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
            _config, checkers, _entity_ids = self._optimizer_condition_checkers.pop(key)
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
        # only partially stub today_slot_readers) still import the coordinator.
        from .battery_actual_history_builder import build_battery_actual_history

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
            compute_inputs = await self.gather_compute_inputs(
                started_at=started_at
            )
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

    async def async_load_day_context_bands(self) -> dict[tuple[date, str], str]:
        """The band each (day, optimizer) pair emitted on the previous run.

        Loaded on the event loop before the optimizer loop starts, because the
        loop itself is pure and runs in a single executor hop; the bands it
        emits come back out of the loop and are persisted by the call below
        (#264).
        """
        return await self._day_context_store.async_load()

    async def async_persist_day_context_bands(
        self,
        *,
        emitted: Mapping[tuple[date, str], str],
        reference_time: datetime,
        optimizer_ids: Collection[str],
    ) -> None:
        await self._day_context_store.async_save_and_prune(
            emitted=emitted,
            today=dt_util.as_local(reference_time).date(),
            optimizer_ids=optimizer_ids,
        )

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
        async with self._appliance_forecast_pipeline_lock:
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
            key = _PipelineCacheKey(
                slot_start=_forecast_slot_start(now),
                house_generated_at=house_forecast.get("generatedAt"),
                solar_signature=build_battery_forecast_solar_signature(
                    solar_forecast
                ),
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

    # The signature builder as a coordinator attribute, for the schedule
    # execution tests that derive the read path's signature through it.
    _build_battery_forecast_schedule_signature = staticmethod(
        build_battery_forecast_schedule_signature
    )

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
        if revision == self._forecast_cache_revision and not (
            self._cache_holds_newer_pipeline(
                house_forecast=house_forecast, started_at=started_at
            )
        ):
            # Keyed on the slot the battery forecast itself says it started in:
            # one without a ``startedAt`` -- every status short of a simulated
            # one -- then matches no read and is rebuilt by the next reader.
            self._pipeline_cache = _PipelineCacheEntry(
                key=replace(
                    key,
                    slot_start=_battery_forecast_slot_start(
                        pipeline.battery_forecast
                    ),
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
        cached_generated_at = dt_util.parse_datetime(
            entry.key.house_generated_at or ""
        )
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

                appliance = self._appliances_registry.current.get_appliance(appliance_id)
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
        current_remaining_energy_kwh = battery_forecast.get(
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
        # since a just-built plan is normally inside the window. One executed
        # after a slow hardware attempt may not be, but it was built from
        # current conditions, so it re-plans only if they flip again.
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

    async def async_unload(self) -> None:
        """Clean up event listeners and stop the tick."""
        self._unloaded = True
        for unsub in self._unsub_listeners:
            unsub()
        self._unsub_listeners.clear()
        self.live.unload()
        self._stop_forecast_refresh()
        await self._async_cancel_refresh_tasks()
        training_batch = self._training_batch
        if training_batch is not None:
            training_batch.cancel()
            self._training_batch = None
        # The back-fill walks for as long as the source's history is deep, so a
        # reload can easily land mid-walk. Cancelling here keeps the reloaded
        # coordinator's walk the only one holding the cursor; the work already
        # imported stands, and the persisted cursor is where the new one starts.
        for job in self._backfill_jobs:
            if job.task is not None:
                job.task.cancel()
                job.task = None
        await self._automation_triggers.async_shutdown()
        self._prune_optimizer_condition_checkers(active_keys=set())
        await self.schedule.async_unload()
        self._invalidate_pipeline_cache()

        self._async_add_entities = None
        self._dynamic_sensor_factories = {}
        self._dynamic_sensors = {}
        self._removing_entity_ids.clear()
        self._explanation_book.clear()
        self._condition_traces.clear()

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


def _any_group_met_by_optimizer(
    condition_map: dict[str, tuple[bool, ...]],
) -> dict[str, bool]:
    """Fold a per-group condition map to the per-optimizer OR outcome."""
    return {
        optimizer_id: any(met_by_group)
        for optimizer_id, met_by_group in condition_map.items()
    }
