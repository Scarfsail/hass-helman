from __future__ import annotations

import asyncio
import functools
import logging
from collections import OrderedDict
from collections.abc import Callable, Collection, Coroutine, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.start import async_at_started
from homeassistant.util import dt as dt_util

from .appliance_runtime_history import (
    ApplianceRuntimeHistoryReader,
)
from .appliances.climate_appliance import ClimateApplianceRuntime
from .appliances.config import build_appliances_runtime_registry
from .appliances.dto import ApplianceMetadataResponseDict, build_appliances_response
from .appliances.generic_appliance import GenericApplianceRuntime
from .appliances.projection_response import ApplianceProjectionsResponseDict
from .appliances.registry_holder import AppliancesRegistryHolder
from .automation.compute_inputs import ComputeInputs
from .automation.condition_evaluator import ConditionEvaluator
from .automation.config import (
    AutomationConfig,
    AutomationConfigError,
    read_automation_config,
)
from .automation.coverage import AutomationCoverageDict, build_automation_coverage
from .automation.day_context_store import DayContextStore
from .automation.explain import ExplanationBook, RunExplanation
from .automation.input_bundle import AutomationInputBundle
from .automation.triggers import AutomationTriggerCoordinator
from .battery_state import (
    describe_battery_entity_config_issue,
    describe_battery_live_state_issue,
    read_battery_entity_config,
    read_battery_live_state,
    read_battery_soc_bounds,
    read_battery_soc_bounds_config,
)
from .const import (
    DATA_CHANGED_KIND_PLAN,
    DATA_CHANGED_KIND_SCHEDULE,
    DATA_CHANGED_KIND_SOLAR_BIAS,
    DATA_CHANGED_KIND_TRAINING,
    DEFAULT_FORECAST_DAYS,
    EVENT_DATA_CHANGED,
    SCHEDULE_SLOT_MINUTES,
    SIGNAL_FORECAST_PUBLISHED,
    entry_signal,
)
from .consumption_forecast_builder import (
    read_house_forecast_request,
)
from .controllables.config import (
    CONTROLLABLE_ID_INVERTER,
    entity_friendly_name,
    iter_devices,
    own_meter,
    peek_controllable_id,
    read_carved_meters,
)
from .controllables.spec import (
    CONTROLLABLE_KIND_INVERTER,
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
    build_automation_snapshot,
)
from .forecast.service import _LIVE_STATE_UNSET, ForecastService
from .house_device_consumers import extract_house_device_consumers
from .live_power import LivePowerTracker
from .scheduling.actual_history import build_entity_actual_histories
from .scheduling.normal_state import (
    build_controllable_entities,
    build_controllable_entity,
    iter_controllable_sources,
)
from .scheduling.schedule import (
    ScheduleActionSetBy,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleResponseDict,
    ScheduleSlot,
    describe_schedule_control_config_issue,
    read_schedule_control_config,
)
from .scheduling.schedule_executor import ScheduleExecutor
from .scheduling.schedule_service import ScheduleService
from .solar_bias_correction.models import read_bias_config
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
#: How long a device dataset for a period still in progress is reused: the
#: card's own memo of an open period, so the backend never serves one older.
_OPEN_DATASET_TTL = timedelta(minutes=5)
#: How many periods' device datasets are kept. Report navigation touches a few
#: at a time.
_DEVICE_DATASET_CACHE_SIZE = 8
if TYPE_CHECKING:
    from .automation.pipeline import AutomationRunResult


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
        _LOGGER.debug("Could not read the live %s fingerprint", job_id, exc_info=True)
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


#: The kinds whose runtime history and live running state automation reads: the
#: ones an ``appliance_runtime`` optimizer can drive. An EV charger's ``charge``
#: switch would answer the same question, but nothing plans against it yet.


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
        self._create_task = getattr(
            self._hass, "async_create_task", asyncio.create_task
        )
        self._refresh_tasks: set[asyncio.Task[Any]] = set()
        self._day_context_store = DayContextStore(hass)
        # Per-slot condition explanations, accumulated in memory and keyed by
        # (target lane, date). Deliberately not persisted: the plan is rebuilt
        # from `build_horizon_start(now)` every 15 minutes, so the record
        # regenerates on its own within minutes of a restart, and writing it out
        # would cost ~96 whole-file rewrites/day of a 100-300 KB JSON.
        self._explanation_book = ExplanationBook()
        self.conditions = ConditionEvaluator(hass)
        self._automation_triggers = AutomationTriggerCoordinator(
            create_task=self._create_task,
            run_callback=self._async_run_automation_trigger_request,
        )
        self._appliances_registry = AppliancesRegistryHolder(
            self._hass, lambda: self._active_config
        )
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
            read_house_fingerprint=lambda: (
                read_house_forecast_request(self._active_config).config_fingerprint
            ),
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
        self._last_schedule_control_config_issue: str | None = None
        self._last_schedule_battery_state_issue: str | None = None
        self.forecast = ForecastService(
            hass,
            storage,
            entry,
            config_provider=lambda: self._active_config,
            schedule=self.schedule,
            registry=self._appliances_registry,
            training=self.training,
            conditions=self.conditions,
            slot_history=self._slot_history,
            battery_boundary_history=self._battery_boundary_history,
            appliance_runtime_history=self._appliance_runtime_history,
            bias_provider=lambda: self._solar_bias_service,
            publish=lambda reason: async_dispatcher_send(
                self._hass, self._forecast_published_signal, reason
            ),
            request_replan=self._automation_triggers.request_debounced,
        )

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
        return self._explanation_book.get(controllable_id=controllable_id, date=date)

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
        return self.conditions.get_trace(
            optimizer_id=optimizer_id, group_index=group_index
        )

    def _record_automation_run(self, result: AutomationRunResult) -> None:
        # Record the condition map + time this plan was built from, so the
        # condition-check poll can detect a flip and trigger a fast re-plan.
        if result.ran_automation and result.snapshot is not None:
            self.conditions.record_plan(
                result.snapshot.context.now,
                result.snapshot.context.condition_met_by_optimizer_id,
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
            lambda unique_id: (
                unique_id.startswith(prefixes) and unique_id not in wanted_ids
            ),
        )

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
        self.forecast.load_stored_snapshots()
        # The house profile is checked against the very same fingerprint (the
        # training request reads it off the same forecast request), so the
        # profile and the snapshot can never disagree about what is stale.
        self.training.adopt_house_consumption()
        reference_time = dt_util.now()
        self.forecast._start_forecast_refresh()

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
            new_sensors = {
                node_id: factory(node_id, *wanted[node_id]) for node_id in to_add
            }
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

    async def async_device_report(
        self, report: str, query: ReportQuery
    ) -> dict[str, Any]:
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

        local_start = datetime.combine(
            query.start_date, datetime.min.time(), tzinfo=local_tz
        )
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

    def _get_grid_import_price_config(self):
        return self.forecast._get_grid_import_price_config()

    def grid_price_snapshot(
        self, reference_time: datetime | None = None
    ) -> dict[str, Any]:
        return self.forecast.grid_price_snapshot(reference_time)

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
        return await self.forecast.canonical_solar_forecast(
            reference_time=reference_time
        )

    async def battery_forecast(self) -> dict[str, Any] | None:
        return await self.forecast.battery_forecast()

    def house_forecast_snapshot(self) -> dict[str, Any] | None:
        return self.forecast.house_forecast_snapshot()

    def house_forecast_composition(self) -> dict[str, Any] | None:
        return self.forecast.house_forecast_composition()

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

    async def get_forecast(self, *, forecast_days: int = DEFAULT_FORECAST_DAYS) -> dict:
        return await self.forecast.get_forecast(forecast_days=forecast_days)

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
                if (action := spec.action_from_state(runtime, entry["state"]))
                is not None
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
        return self.forecast.get_raw_solar_forecast_points()

    def get_corrected_solar_forecast_points(self) -> list[dict[str, Any]]:
        return self.forecast.get_corrected_solar_forecast_points()

    def get_solar_forecast_day_total(self, day_offset: int) -> float | None:
        return self.forecast.get_solar_forecast_day_total(day_offset)

    def get_solar_forecast_current_wh(self, *, corrected: bool) -> float | None:
        return self.forecast.get_solar_forecast_current_wh(corrected=corrected)

    def get_battery_forecast_current(self) -> dict[str, float] | None:
        return self.forecast.get_battery_forecast_current()

    def get_grid_import_price_current(self) -> float | None:
        return self.forecast.get_grid_import_price_current()

    def get_grid_import_price_unit(self) -> str | None:
        return self.forecast.get_grid_import_price_unit()

    def get_grid_export_price_current(self) -> float | None:
        return self.forecast.get_grid_export_price_current()

    def get_grid_export_price_unit(self) -> str | None:
        return self.forecast.get_grid_export_price_unit()

    def get_grid_export_price_schedule(self) -> dict[str, float]:
        return self.forecast.get_grid_export_price_schedule()

    def get_house_consumption_forecast_current_w(self) -> float | None:
        return self.forecast.get_house_consumption_forecast_current_w()

    def get_solar_forecast_today_remaining(self) -> float | None:
        return self.forecast.get_solar_forecast_today_remaining()

    async def get_appliance_projections(self) -> ApplianceProjectionsResponseDict:
        return await self.forecast.get_appliance_projections()

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
            forecast=self.forecast,
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
        return self.forecast.get_automation_input_bundle()

    async def _async_refresh_forecast(
        self, *, reason: str, reference_time: datetime | None = None
    ) -> None:
        if reference_time is None:
            await self.forecast._async_refresh_forecast(reason=reason)
        else:
            await self.forecast._async_refresh_forecast(
                reason=reason, reference_time=reference_time
            )

    async def gather_compute_inputs(
        self,
        *,
        started_at: datetime,
        live_state: Any = _LIVE_STATE_UNSET,
        include_condition_flags: bool = False,
    ) -> ComputeInputs:
        return await self.forecast.gather_compute_inputs(
            started_at=started_at,
            live_state=live_state,
            include_condition_flags=include_condition_flags,
        )

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

    def _iter_automation_candidate_appliances(
        self,
    ) -> list[GenericApplianceRuntime | ClimateApplianceRuntime]:
        return self.forecast._iter_automation_candidate_appliances()

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
        if not self.conditions.plan_is_stale(reference_time):
            return False
        try:
            needs_replan = await self.conditions.needs_replan(
                reference_time, read_automation_config(self._active_config)
            )
        except Exception:
            _LOGGER.debug(
                "Reality-check condition eval failed; executing plan as-is",
                exc_info=True,
            )
            return False
        if not needs_replan:
            return False
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
        await self.forecast.async_unload()
        await self._async_cancel_refresh_tasks()
        training_batch = self._training_batch
        if training_batch is not None:
            training_batch.cancel()
            self._training_batch = None
        await self._automation_triggers.async_shutdown()
        self.conditions.async_unload()
        await self.schedule.async_unload()

        self._async_add_entities = None
        self._dynamic_sensor_factories = {}
        self._dynamic_sensors = {}
        self._removing_entity_ids.clear()
        self._explanation_book.clear()

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
