from __future__ import annotations

import ast
import asyncio
import concurrent.futures
import inspect
import sys
import types
import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"


def _install_voluptuous_stub() -> None:
    if "voluptuous" in sys.modules:
        return

    module = types.ModuleType("voluptuous")

    class Invalid(Exception):
        pass

    class _MissingType:
        pass

    _MISSING = _MissingType()

    class _Marker:
        def __init__(self, key: str, *, default: object = _MISSING) -> None:
            self.key = key
            self.default = default

    class Required(_Marker):
        pass

    class Optional(_Marker):
        pass

    def In(options):
        def validator(value):
            if value not in options:
                raise Invalid(f"Value {value!r} is not in {options!r}")
            return value

        return validator

    def Coerce(expected_type):
        def validator(value):
            try:
                return expected_type(value)
            except (TypeError, ValueError) as err:
                raise Invalid(str(err)) from err

        return validator

    class Schema:
        def __init__(self, schema, *, extra=None) -> None:
            self._schema = schema
            self._extra = extra

        def __call__(self, value):
            return _validate(self._schema, value, extra=self._extra)

    PREVENT_EXTRA = object()

    def _validate(schema, value, *, extra=None):
        if isinstance(schema, Schema):
            return schema(value)

        if isinstance(schema, dict):
            if not isinstance(value, dict):
                raise Invalid("Expected a dict")

            result = {}
            seen_keys: set[str] = set()
            for key_spec, validator in schema.items():
                if isinstance(key_spec, _Marker):
                    key = key_spec.key
                    seen_keys.add(key)
                    if key in value:
                        result[key] = _validate(validator, value[key])
                        continue
                    if isinstance(key_spec, Optional) and key_spec.default is not _MISSING:
                        result[key] = _validate(validator, key_spec.default)
                        continue
                    if isinstance(key_spec, Required):
                        raise Invalid(f"Missing required key {key!r}")
                    continue

                seen_keys.add(key_spec)
                if key_spec not in value:
                    raise Invalid(f"Missing required key {key_spec!r}")
                result[key_spec] = _validate(validator, value[key_spec])

            if extra is PREVENT_EXTRA:
                extras = set(value) - seen_keys
                if extras:
                    raise Invalid(f"Extra keys not allowed: {sorted(extras)!r}")
            return result

        if isinstance(schema, list):
            if len(schema) != 1:
                raise Invalid("List schema must contain exactly one validator")
            if not isinstance(value, list):
                raise Invalid("Expected a list")
            return [_validate(schema[0], item) for item in value]

        if isinstance(schema, type):
            if not isinstance(value, schema):
                raise Invalid(f"Expected value of type {schema.__name__}")
            return value

        if callable(schema):
            return schema(value)

        if value != schema:
            raise Invalid(f"Expected {schema!r}")
        return value

    module.Coerce = Coerce
    module.In = In
    module.Invalid = Invalid
    module.Optional = Optional
    module.PREVENT_EXTRA = PREVENT_EXTRA
    module.Required = Required
    module.Schema = Schema
    sys.modules["voluptuous"] = module


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    battery_builder_mod = types.ModuleType(
        "custom_components.helman.battery_capacity_forecast_builder"
    )
    battery_builder_mod.BatteryCapacityForecastBuilder = type(
        "BatteryCapacityForecastBuilder",
        (),
        {},
    )
    sys.modules[battery_builder_mod.__name__] = battery_builder_mod

    consumption_builder_mod = types.ModuleType(
        "custom_components.helman.consumption_forecast_builder"
    )
    consumption_builder_mod.ConsumptionForecastBuilder = type(
        "ConsumptionForecastBuilder",
        (),
        {"_make_payload": staticmethod(lambda **kwargs: kwargs)},
    )
    # Coordinator reads (min_history_days, training_window_days) via this
    # shared helper since the v14 training-section relocation.
    consumption_builder_mod.read_house_training_window_config = (
        lambda config: (14, 56)
    )
    sys.modules[consumption_builder_mod.__name__] = consumption_builder_mod

    forecast_builder_mod = types.ModuleType("custom_components.helman.forecast_builder")
    forecast_builder_mod.HelmanForecastBuilder = type(
        "HelmanForecastBuilder",
        (),
        {},
    )
    sys.modules[forecast_builder_mod.__name__] = forecast_builder_mod

    tree_builder_mod = types.ModuleType("custom_components.helman.tree_builder")
    tree_builder_mod.HelmanTreeBuilder = type("HelmanTreeBuilder", (), {})
    sys.modules[tree_builder_mod.__name__] = tree_builder_mod

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg
    homeassistant_pkg.__path__ = []

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg
    components_pkg.__path__ = []

    websocket_api_mod = sys.modules.get("homeassistant.components.websocket_api")
    if websocket_api_mod is None:
        websocket_api_mod = types.ModuleType("homeassistant.components.websocket_api")
        sys.modules["homeassistant.components.websocket_api"] = websocket_api_mod
    websocket_api_mod.ActiveConnection = type("ActiveConnection", (), {})
    websocket_api_mod.async_register_command = lambda hass, command: None
    websocket_api_mod.async_response = lambda func: func

    def websocket_command(schema):
        def decorator(func):
            func.websocket_schema = schema
            return func

        return decorator

    websocket_api_mod.websocket_command = websocket_command
    components_pkg.websocket_api = websocket_api_mod

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    recorder_mod.get_instance = lambda hass: None
    recorder_mod.__path__ = []

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}

    # The house consumption trainer splices its window's tail out of hourly
    # long-term statistics, so importing the coordinator now reaches this
    # module too. Nothing here exercises that read; it answers with nothing.
    statistics_mod = sys.modules.get("homeassistant.components.recorder.statistics")
    if statistics_mod is None:
        statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
        sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod
    statistics_mod.statistics_during_period = lambda *args, **kwargs: {}

    energy_pkg = sys.modules.get("homeassistant.components.energy")
    if energy_pkg is None:
        energy_pkg = types.ModuleType("homeassistant.components.energy")
        sys.modules["homeassistant.components.energy"] = energy_pkg
    energy_pkg.__path__ = []

    energy_data_mod = sys.modules.get("homeassistant.components.energy.data")
    if energy_data_mod is None:
        energy_data_mod = types.ModuleType("homeassistant.components.energy.data")
        sys.modules["homeassistant.components.energy.data"] = energy_data_mod

    async def async_get_manager(hass):
        return SimpleNamespace(async_listen_updates=lambda callback: lambda: None)

    energy_data_mod.async_get_manager = async_get_manager

    helpers_pkg = sys.modules.get("homeassistant.helpers")
    if helpers_pkg is None:
        helpers_pkg = types.ModuleType("homeassistant.helpers")
        sys.modules["homeassistant.helpers"] = helpers_pkg
    helpers_pkg.__path__ = []

    event_mod = sys.modules.get("homeassistant.helpers.event")
    if event_mod is None:
        event_mod = types.ModuleType("homeassistant.helpers.event")
        sys.modules["homeassistant.helpers.event"] = event_mod
    event_mod.async_track_time_change = lambda hass, callback, **kwargs: lambda: None
    event_mod.async_track_time_interval = (
        lambda hass, callback, interval: lambda: None
    )

    # Mirrors the real helper: fires at once when HA is already running, which
    # is the state a test's fake hass is always in.
    start_mod = sys.modules.get("homeassistant.helpers.start")
    if start_mod is None:
        start_mod = types.ModuleType("homeassistant.helpers.start")
        sys.modules["homeassistant.helpers.start"] = start_mod

    def _async_at_started(hass, at_start_cb):
        at_start_cb(hass)
        return lambda: None

    start_mod.async_at_started = _async_at_started
    helpers_pkg.start = start_mod
    event_mod.async_track_state_change_event = (
        lambda hass, entity_ids, action: lambda: None
    )

    debounce_mod = sys.modules.get("homeassistant.helpers.debounce")
    if debounce_mod is None:
        debounce_mod = types.ModuleType("homeassistant.helpers.debounce")
        sys.modules["homeassistant.helpers.debounce"] = debounce_mod

    class _Debouncer:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def async_call(self) -> None:
            pass

    debounce_mod.Debouncer = _Debouncer

    storage_mod = sys.modules.get("homeassistant.helpers.storage")
    if storage_mod is None:
        storage_mod = types.ModuleType("homeassistant.helpers.storage")
        sys.modules["homeassistant.helpers.storage"] = storage_mod

    class DummyStore:
        def __init__(self, hass, version, key) -> None:
            self._data = None

        async def async_load(self):
            return self._data

        async def async_save(self, data) -> None:
            self._data = data

    storage_mod.Store = DummyStore

    entity_registry_mod = sys.modules.get("homeassistant.helpers.entity_registry")
    if entity_registry_mod is None:
        entity_registry_mod = types.ModuleType(
            "homeassistant.helpers.entity_registry"
        )
        sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg
    util_pkg.__path__ = []

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    dt_mod.now = lambda: REFERENCE_TIME
    util_pkg.dt = dt_mod


_install_voluptuous_stub()
_install_import_stubs()

from custom_components.helman.appliances import AppliancesRuntimeRegistry
from custom_components.helman.automation.config import AutomationConfig
from custom_components.helman.automation.config import OptimizerInstanceConfig
from custom_components.helman.automation.spec import OPTIMIZER_BUCKET_APPLIANCE
from custom_components.helman.automation.explain import (
    PHASE_FINAL_APPLIANCE_PLACEMENT,
    ExplanationBook,
    OptimizerExplanation,
    RunExplanation,
    SlotExplanation,
)
from custom_components.helman.automation.input_bundle import AutomationInputBundle
from custom_components.helman.automation.conditions.types import (
    ConditionRailsUnavailable,
)
from custom_components.helman.automation.pipeline import (
    AutomationCleanupSummary,
    AutomationRunFailure,
    AutomationRunResult,
    AutomationRunner,
    DayContextResolver,
    OptimizerRunSummary,
    _PipelineExecutionResult,
    run_optimizer_loop_pure,
)
from custom_components.helman.automation.snapshot import (
    OptimizationContext,
    OptimizationSnapshot,
    snapshot_to_dict,
)
from custom_components.helman.automation.compute_inputs import ComputeInputs
from custom_components.helman.battery_state import BatteryEntityConfig, BatteryLiveState
from custom_components.helman.const import DOMAIN, MAX_FORECAST_DAYS, SCHEDULE_SLOT_MINUTES
from custom_components.helman.coordinator import HelmanCoordinator
from custom_components.helman import coordinator as coordinator_module
from custom_components.helman.automation import pipeline as pipeline_module
from custom_components.helman.scheduling.schedule import (
    ScheduleControlConfig,
    ScheduleDocument,
    iter_horizon_slot_ids,
    schedule_document_to_dict,
)
from custom_components.helman.websockets import (
    ws_get_schedule_explanation,
    ws_run_automation,
)

for module_name in (
    "custom_components.helman.battery_capacity_forecast_builder",
    "custom_components.helman.consumption_forecast_builder",
    "custom_components.helman.forecast_builder",
    "custom_components.helman.tree_builder",
    "custom_components.helman.coordinator",
    "custom_components.helman.websockets",
    "homeassistant.util.dt",
    "homeassistant.util",
    "homeassistant.core",
    "homeassistant.components",
    "homeassistant.components.websocket_api",
    "homeassistant.components.energy",
    "homeassistant.components.energy.data",
    "homeassistant.helpers",
    "homeassistant.helpers.event",
    "homeassistant.helpers.debounce",
    "homeassistant.helpers.storage",
    "homeassistant.helpers.entity_registry",
):
    sys.modules.pop(module_name, None)


def _make_executor_hass() -> SimpleNamespace:
    """A hass stub that runs executor hops inline and records them.

    The forecast rebuild and the automation snapshot are pure CPU and belong on
    a worker thread; running them inline keeps the assertions readable while
    ``executor_hops`` still proves the hop happened.
    """
    executor_hops: list[object] = []

    async def async_add_executor_job(func, *args):
        executor_hops.append(func)
        return func(*args)

    return SimpleNamespace(
        async_add_executor_job=async_add_executor_job,
        executor_hops=executor_hops,
    )


def _make_schedule_document(*, execution_enabled: bool = True) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={
            CURRENT_SLOT_ID: {
                "inverter": {"kind": "stop_export"},
            }
        },
    )


def _make_grid_price_response() -> dict[str, object]:
    return {
        "exportPriceUnit": "CZK/kWh",
        "currentExportPrice": 2.5,
        "exportPricePoints": [{"timestamp": CURRENT_SLOT_ID, "value": 2.5}],
        "importPriceUnit": "CZK/kWh",
        "currentImportPrice": 7.0,
        "importPricePoints": [{"timestamp": CURRENT_SLOT_ID, "value": 7.0}],
    }


def _make_automation_bundle() -> AutomationInputBundle:
    return AutomationInputBundle(
        original_house_forecast={
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [],
        },
        solar_forecast={
            "status": "available",
            "points": [{"timestamp": CURRENT_SLOT_ID, "value": 0.8}],
        },
        grid_price_forecast=_make_grid_price_response(),
        when_active_hourly_energy_kwh_by_appliance_id={"boiler": 1.25},
    )


def _make_snapshot(
    *,
    schedule_document: ScheduleDocument | None = None,
    input_bundle: AutomationInputBundle | None = None,
    reference_time: datetime | None = None,
) -> OptimizationSnapshot:
    return OptimizationSnapshot(
        schedule=_make_schedule_document() if schedule_document is None else schedule_document,
        adjusted_house_forecast={
            "status": "available",
            "generatedAt": (
                REFERENCE_TIME if reference_time is None else reference_time
            ).isoformat(),
            "series": [{"timestamp": CURRENT_SLOT_ID, "value": 3.0}],
        },
        battery_forecast={
            "status": "available",
            "generatedAt": (
                REFERENCE_TIME if reference_time is None else reference_time
            ).isoformat(),
            "startedAt": (
                REFERENCE_TIME if reference_time is None else reference_time
            ).isoformat(),
            "sourceGranularityMinutes": 15,
            "series": [
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "durationHours": 0.25,
                    "importedFromGridKwh": 1.4,
                    "exportedToGridKwh": 0.2,
                }
            ],
        },
        grid_forecast={
            "status": "available",
            "currentImportPrice": 7.0,
            "currentExportPrice": 2.5,
            "series": [
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "durationHours": 0.25,
                    "importedFromGridKwh": 1.4,
                    "exportedToGridKwh": 0.2,
                }
            ],
        },
        context=OptimizationContext(
            now=REFERENCE_TIME if reference_time is None else reference_time,
            battery_state=BatteryLiveState(
                current_remaining_energy_kwh=7.5,
                current_soc=50.0,
                min_soc=10.0,
                max_soc=90.0,
                nominal_capacity_kwh=15.0,
                min_energy_kwh=1.5,
                max_energy_kwh=13.5,
            ),
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 7.0,
                "points": [],
            },
            export_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 2.5,
                "points": [],
            },
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id=(
                {"boiler": 1.25}
                if input_bundle is None
                else deepcopy(
                    input_bundle.when_active_hourly_energy_kwh_by_appliance_id
                )
            ),
        ),
    )


def _make_optimizer_instance(
    *,
    optimizer_id: str = "avoid-negative-export",
    kind: str = "export_price",
    enabled: bool = True,
    params: dict[str, object] | None = None,
    target: dict[str, object] | None = None,
) -> OptimizerInstanceConfig:
    return OptimizerInstanceConfig(
        id=optimizer_id,
        kind=kind,
        enabled=enabled,
        # The config reader stamps the spec's ``controllable_id`` default, so a
        # hand-built instance has to carry it too -- it is the schedule lane
        # every trace and explanation record is filed under.
        target=target or {"controllable_id": "inverter"},
        params={
            "when_price_below": 0.0,
            "action": "stop_export",
        }
        if params is None
        else params,
    )


def _make_automation_config(
    *optimizers: OptimizerInstanceConfig,
    enabled: bool = True,
) -> AutomationConfig:
    """Partition hand-built optimizers into the two config buckets.

    Preserves each optimizer's relative position within its own bucket. The
    tests in this file that care about cross-bucket execution order (the
    pending-appliance-demand fix, #116) already list system-kind optimizers
    before appliance-kind ones, matching the order ``AutomationRunner`` derives
    from ``AutomationConfig`` (system bucket, then appliance bucket).
    """
    appliance = tuple(
        optimizer
        for optimizer in optimizers
        if optimizer.spec.bucket == OPTIMIZER_BUCKET_APPLIANCE
    )
    system = tuple(
        optimizer
        for optimizer in optimizers
        if optimizer.spec.bucket != OPTIMIZER_BUCKET_APPLIANCE
    )
    return AutomationConfig(
        enabled=enabled,
        appliance_optimizers=appliance,
        system_optimizers=system,
    )


class _FakeCoordinator:
    def __init__(
        self,
        *,
        schedule_document: ScheduleDocument,
        bundle: AutomationInputBundle | None,
        snapshot_factory,
        persist_changed: bool = False,
        control_config: ScheduleControlConfig | None = None,
    ) -> None:
        self._schedule_lock = asyncio.Lock()
        self._schedule_document = schedule_document
        self._bundle = bundle
        self._snapshot_factory = snapshot_factory
        self._persist_changed = persist_changed
        self._control_config = control_config
        self._appliances_registry = AppliancesRuntimeRegistry()
        self._hass = SimpleNamespace(
            async_add_executor_job=self._async_add_executor_job
        )
        self.snapshot_calls: list[dict[str, object]] = []
        self.persist_calls: list[dict[str, object]] = []
        self.saved_documents: list[ScheduleDocument] = []
        self.post_write_calls: list[tuple[str, datetime, bool]] = []
        self.recorded_explanations: list[object] = []
        #: The hysteresis store, faked: what the previous run left behind, and
        #: what this run asked to write back (#264).
        self.day_context_bands: dict = {}
        self.persisted_day_context_bands: list = []

    def record_run_explanation(self, explanation) -> None:
        self.recorded_explanations.append(explanation)

    def _build_automation_working_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        return deepcopy(self._schedule_document)

    async def _load_pruned_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        return deepcopy(self._schedule_document)

    def get_automation_input_bundle(self) -> AutomationInputBundle | None:
        return None if self._bundle is None else deepcopy(self._bundle)

    async def async_load_day_context_bands(self) -> dict:
        return dict(self.day_context_bands)

    async def async_persist_day_context_bands(
        self,
        *,
        emitted,
        reference_time: datetime,
        optimizer_ids,
    ) -> None:
        self.persisted_day_context_bands.append(
            (dict(emitted), reference_time, set(optimizer_ids))
        )

    async def _async_gather_compute_inputs(
        self, *, started_at: datetime, live_state=None, include_condition_flags=False
    ):
        return None

    @staticmethod
    async def _async_add_executor_job(func, *args):
        # Tests run the pure loop inline; production hands it to a worker thread.
        return func(*args)

    def _build_automation_snapshot_from_schedule_pure(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        day_contexts: dict | None = None,
        compute_inputs=None,
    ) -> OptimizationSnapshot:
        self.snapshot_calls.append(
            {
                "schedule_document": schedule_document,
                "input_bundle": input_bundle,
                "reference_time": reference_time,
            }
        )
        return self._snapshot_factory(
            schedule_document=schedule_document,
            input_bundle=input_bundle,
            reference_time=reference_time,
        )

    async def _build_automation_snapshot_from_schedule_locked(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
        day_contexts: dict | None = None,
        compute_inputs=None,
    ) -> OptimizationSnapshot:
        return self._build_automation_snapshot_from_schedule_pure(
            schedule_document=schedule_document,
            input_bundle=input_bundle,
            reference_time=reference_time,
            day_contexts=day_contexts,
            compute_inputs=compute_inputs,
        )

    async def _persist_automation_result_locked(
        self,
        *,
        automation_result: ScheduleDocument,
        reference_time: datetime | None = None,
    ) -> bool:
        self.persist_calls.append(
            {
                "automation_result": automation_result,
                "reference_time": reference_time,
            }
        )
        return self._persist_changed

    async def _save_schedule_document(self, schedule_document: ScheduleDocument) -> None:
        self.saved_documents.append(deepcopy(schedule_document))
        self._schedule_document = deepcopy(schedule_document)

    async def _async_run_post_schedule_write_side_effects(
        self,
        *,
        reason: str,
        reference_time: datetime,
    ) -> None:
        self.post_write_calls.append(
            (reason, reference_time, self._schedule_lock.locked())
        )

    def _read_schedule_control_config(self) -> ScheduleControlConfig | None:
        return self._control_config


class _FakeConnection:
    def __init__(self, *, is_admin: bool) -> None:
        self.user = SimpleNamespace(is_admin=is_admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: dict) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class _FakeHass:
    def __init__(self, coordinator) -> None:
        self.data = {DOMAIN: {"coordinator": coordinator}}


class SnapshotSerializationTests(unittest.TestCase):
    def test_snapshot_to_dict_returns_stable_shape(self) -> None:
        payload = snapshot_to_dict(_make_snapshot())

        self.assertTrue(payload["scheduleDocument"]["executionEnabled"])
        self.assertGreater(len(payload["scheduleSlots"]), 0)
        self.assertEqual(payload["adjustedHouseForecast"]["status"], "available")
        self.assertEqual(payload["batteryForecast"]["status"], "available")
        self.assertEqual(payload["gridForecast"]["currentImportPrice"], 7.0)
        self.assertEqual(payload["context"]["now"], REFERENCE_TIME.isoformat())
        self.assertEqual(payload["context"]["batteryState"]["currentSoc"], 50.0)
        self.assertEqual(
            payload["context"]["whenActiveHourlyEnergyKwhByApplianceId"],
            {"boiler": 1.25},
        )

    def test_snapshot_to_dict_carries_both_halves_of_the_battery_params(self) -> None:
        # Only the charge side used to be surfaced; an optimizer re-simulating
        # the battery needs the discharge side too.
        context = _make_snapshot().context
        payload = snapshot_to_dict(
            replace(
                _make_snapshot(),
                context=replace(
                    context,
                    battery_max_discharge_power_kw=4.0,
                    battery_discharge_efficiency=0.93,
                ),
            )
        )

        self.assertEqual(payload["context"]["batteryMaxDischargePowerKw"], 4.0)
        self.assertEqual(payload["context"]["batteryDischargeEfficiency"], 0.93)

    def test_snapshot_to_dict_omits_the_simulation_overlay(self) -> None:
        # It is a simulation input, not a view: serialising it would restate
        # `scheduleDocument` at canonical resolution for a consumer that has it.
        payload = snapshot_to_dict(_make_snapshot())

        self.assertNotIn("scheduleOverlay", payload)
        self.assertNotIn("scheduleOverlay", payload["context"])

    def test_snapshot_to_dict_hides_internal_battery_available_surplus_field(self) -> None:
        snapshot = _make_snapshot()
        snapshot.battery_forecast["series"][0]["availableSurplusKwh"] = 0.2
        snapshot.battery_forecast["baselineSeries"] = [
            {
                "timestamp": CURRENT_SLOT_ID,
                "durationHours": 0.25,
                "availableSurplusKwh": 0.3,
                "importedFromGridKwh": 1.0,
                "exportedToGridKwh": 0.0,
            }
        ]

        payload = snapshot_to_dict(snapshot)

        self.assertNotIn("availableSurplusKwh", payload["batteryForecast"]["series"][0])
        self.assertNotIn(
            "availableSurplusKwh",
            payload["batteryForecast"]["baselineSeries"][0],
        )
        self.assertEqual(payload["context"]["applianceRegistry"], {"appliances": []})


class AutomationRunResultSerializationTests(unittest.TestCase):
    def test_to_dict_preserves_envelope_while_adding_observability_fields(self) -> None:
        payload = AutomationRunResult.completed(
            snapshot=_make_snapshot(),
            optimizers=(
                OptimizerRunSummary(
                    id="avoid-negative-export",
                    kind="export_price",
                    status="ok",
                    slots_written=2,
                    duration_ms=17,
                ),
            ),
            duration_ms=41,
        ).to_dict()

        self.assertTrue(payload["ranAutomation"])
        self.assertIn("scheduleSlots", payload["snapshot"])
        self.assertEqual(
            payload["optimizers"],
            [
                {
                    "id": "avoid-negative-export",
                    "kind": "export_price",
                    "status": "ok",
                    "slotsWritten": 2,
                    "durationMs": 17,
                }
            ],
        )
        self.assertEqual(payload["durationMs"], 41)

    def test_to_dict_includes_failure_payload(self) -> None:
        payload = AutomationRunResult.failed(
            reason="runner_failed",
            failure=AutomationRunFailure(
                stage="final_persist",
                message="disk full",
            ),
        ).to_dict()

        self.assertFalse(payload["ranAutomation"])
        self.assertEqual(payload["reason"], "runner_failed")
        self.assertEqual(payload["message"], "disk full")
        self.assertEqual(
            payload["failure"],
            {
                "stage": "final_persist",
                "message": "disk full",
                "unexpected": True,
            },
        )


class AutomationRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_plans_normally_when_execution_flag_is_off(self) -> None:
        # execution_enabled gates only the apply step: optimizers still run and
        # persist their plan so the card and the inspectors can display it.
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(execution_enabled=False),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        payload = result.to_dict()
        self.assertTrue(payload["ranAutomation"])
        self.assertIsNotNone(payload["snapshot"])
        self.assertEqual(len(payload["optimizers"]), 1)
        self.assertIsInstance(payload["durationMs"], int)
        self.assertNotEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_automation_disabled_when_config_disabled(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        payload = result.to_dict()
        self.assertFalse(payload["ranAutomation"])
        self.assertEqual(payload["reason"], "automation_disabled")
        self.assertIsNone(payload["snapshot"])
        self.assertEqual(payload["optimizers"], [])
        self.assertIsInstance(payload["durationMs"], int)
        self.assertEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_inputs_unavailable_without_bundle(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=None,
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        payload = result.to_dict()
        self.assertFalse(payload["ranAutomation"])
        self.assertEqual(payload["reason"], "inputs_unavailable")
        self.assertIsNone(payload["snapshot"])
        self.assertEqual(payload["optimizers"], [])
        self.assertIsInstance(payload["durationMs"], int)
        self.assertEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_runner_failed_when_initial_snapshot_build_raises(
        self,
    ) -> None:
        def _raise_snapshot(**kwargs):
            raise RuntimeError("snapshot boom")

        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_raise_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="initial_snapshot",
                message="snapshot boom",
            ),
        )
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_returns_runner_failed_when_cleanup_persist_raises(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        coordinator._save_schedule_document = AsyncMock(
            side_effect=RuntimeError("cleanup write failed")
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="cleanup_persist",
                message="cleanup write failed",
            ),
        )
        self.assertEqual(coordinator.saved_documents, [])
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_returns_snapshot_and_is_repeatable(self) -> None:
        schedule_document = _make_schedule_document()
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        runner = AutomationRunner(
            coordinator=coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            first = await runner.run(reference_time=REFERENCE_TIME)
            second = await runner.run(reference_time=REFERENCE_TIME)

        self.assertTrue(first.ran_automation)
        self.assertEqual(
            schedule_document_to_dict(first.snapshot.schedule),
            schedule_document_to_dict(schedule_document),
        )
        self.assertEqual(
            schedule_document_to_dict(second.snapshot.schedule),
            schedule_document_to_dict(schedule_document),
        )
        self.assertEqual(first.snapshot.adjusted_house_forecast["status"], "available")
        self.assertEqual(first.snapshot.battery_forecast["status"], "available")
        self.assertEqual(first.snapshot.grid_forecast["currentImportPrice"], 7.0)
        self.assertEqual(len(first.optimizers), 1)
        self.assertEqual(first.optimizers[0].status, "ok")
        self.assertGreaterEqual(first.duration_ms, 0)
        self.assertEqual(
            first.snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertEqual(len(coordinator.snapshot_calls), 4)
        self.assertEqual(len(coordinator.persist_calls), 2)
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_builds_snapshot_from_stripped_working_schedule(self) -> None:
        next_slot_id = "2026-03-20T21:30:00+01:00"
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                    "boiler": {"on": True, "setBy": "user"},
                },
                next_slot_id: {
                    "inverter": {"kind": "normal"},
                },
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "boiler": {"on": True, "setBy": "user"},
                    },
                    next_slot_id: {
                        "inverter": {"kind": "normal"},
                    },
                },
            },
        )
        self.assertEqual(
            schedule_document_to_dict(coordinator.snapshot_calls[0]["schedule_document"]),
            schedule_document_to_dict(result.snapshot.schedule),
        )
        self.assertEqual(
            schedule_document_to_dict(coordinator.snapshot_calls[1]["schedule_document"]),
            schedule_document_to_dict(result.snapshot.schedule),
        )

    async def test_run_cleans_up_automation_owned_actions_when_automation_disabled(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "cleanup_only")
        self.assertEqual(
            result.cleanup,
            AutomationCleanupSummary(
                reason="automation_disabled",
                actions_stripped=1,
            ),
        )
        self.assertEqual(len(coordinator.saved_documents), 1)
        self.assertEqual(
            schedule_document_to_dict(coordinator.saved_documents[0]),
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )
        self.assertEqual(
            coordinator.post_write_calls,
            [("automation_updated", REFERENCE_TIME, False)],
        )

    async def test_run_skips_cleanup_write_when_disabled_schedule_is_already_clean(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "automation_disabled")
        self.assertIsNone(result.cleanup)
        self.assertEqual(coordinator.saved_documents, [])
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_persists_single_optimizer_result_and_runs_side_effects_on_change(
        self,
    ) -> None:
        optimized_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
            persist_changed=True,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(optimized_schedule)
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(len(coordinator.persist_calls), 1)
        self.assertEqual(
            schedule_document_to_dict(
                coordinator.persist_calls[0]["automation_result"]
            ),
            schedule_document_to_dict(optimized_schedule),
        )
        self.assertEqual(
            coordinator.post_write_calls,
            [("automation_updated", REFERENCE_TIME, False)],
        )
        self.assertEqual(len(coordinator.snapshot_calls), 2)
        self.assertEqual(
            result.optimizers,
            (
                OptimizerRunSummary(
                    id="avoid-negative-export",
                    kind="export_price",
                    status="ok",
                    slots_written=1,
                    duration_ms=result.optimizers[0].duration_ms,
                ),
            ),
        )
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            schedule_document_to_dict(optimized_schedule),
        )

    async def test_run_multi_optimizer_rebuilds_snapshot_between_steps(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        first_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "one":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(first_schedule))
                )

            def _second_optimize(snapshot, current_config, trace=None):
                self.assertEqual(
                    schedule_document_to_dict(snapshot.schedule),
                    schedule_document_to_dict(first_schedule),
                )
                return deepcopy(snapshot.schedule)

            return SimpleNamespace(optimize=Mock(side_effect=_second_optimize))

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=_build_optimizer_side_effect,
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.snapshot_calls), 3)
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            schedule_document_to_dict(first_schedule),
        )

    async def test_run_multi_optimizer_reuses_same_pinned_input_bundle_for_every_rebuild(
        self,
    ) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=lambda config, *, control_config, appliance_registry: SimpleNamespace(
                optimize=Mock(
                    side_effect=lambda snapshot, current_config, trace=None: deepcopy(
                        snapshot.schedule
                    )
                )
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.snapshot_calls), 3)
        self.assertIs(
            coordinator.snapshot_calls[0]["input_bundle"],
            coordinator.snapshot_calls[1]["input_bundle"],
        )
        self.assertIs(
            coordinator.snapshot_calls[1]["input_bundle"],
            coordinator.snapshot_calls[2]["input_bundle"],
        )
        self.assertEqual(
            coordinator.snapshot_calls[0]["input_bundle"].original_house_forecast,
            coordinator.snapshot_calls[2]["input_bundle"].original_house_forecast,
        )

    async def test_run_multi_optimizer_later_result_wins_before_persist(self) -> None:
        first_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        final_schedule = ScheduleDocument(execution_enabled=True)
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
            persist_changed=True,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=[
                SimpleNamespace(optimize=Mock(return_value=deepcopy(first_schedule))),
                SimpleNamespace(optimize=Mock(return_value=deepcopy(final_schedule))),
            ],
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.persist_calls), 1)
        self.assertEqual(
            schedule_document_to_dict(
                coordinator.persist_calls[0]["automation_result"]
            ),
            schedule_document_to_dict(final_schedule),
        )
        self.assertEqual(
            schedule_document_to_dict(result.snapshot.schedule),
            schedule_document_to_dict(final_schedule),
        )

    async def test_run_fails_and_persists_nothing_when_appliance_rails_unavailable(
        self,
    ) -> None:
        """#272 (P2 of #270): with no baseline to fall back to, a
        ``ConditionRailsUnavailable`` for an appliance escalates to the
        existing run-failure path rather than restoring that appliance's lane
        and continuing — persisting it empty would silently erase a required
        appliance schedule on a transient forecast gap. The previous complete
        schedule is left standing.
        """
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(
                    side_effect=ConditionRailsUnavailable(
                        "boiler",
                        "when-active demand is unavailable",
                    )
                )
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(
                        optimizer_id="run-boiler-on-surplus",
                        kind="appliance_runtime",
                        target={"controllable_id": "boiler"},
                        params={},
                    )
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(len(result.optimizers), 1)
        self.assertEqual(result.optimizers[0].status, "failed")
        self.assertEqual(result.optimizers[0].error, "when-active demand is unavailable")
        # Nothing persisted: the previous good record stands.
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])
        # The "optimizer_skipped" note stays visible on the failed run's trace.
        step = result.trace.to_dict()["steps"][0]
        self.assertEqual(step["notes"][0]["code"], "optimizer_skipped")

    async def test_run_returns_failure_when_optimizer_raises(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=RuntimeError("boom"))
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(result.message, "boom")
        self.assertEqual(len(result.optimizers), 1)
        self.assertEqual(result.optimizers[0].status, "failed")
        self.assertEqual(result.optimizers[0].error, "boom")
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_returns_failure_when_optimizer_construction_raises(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=ValueError("bad target"),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(result.message, "bad target")
        self.assertEqual(len(result.optimizers), 1)
        self.assertEqual(result.optimizers[0].status, "failed")
        self.assertEqual(result.optimizers[0].error, "bad target")
        self.assertEqual(len(coordinator.snapshot_calls), 1)
        self.assertIsNotNone(result.snapshot)
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_returns_runner_failed_when_final_persist_raises(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        coordinator._persist_automation_result_locked = AsyncMock(
            side_effect=RuntimeError("persist boom")
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule))
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="final_persist",
                message="persist boom",
            ),
        )
        self.assertIsNotNone(result.snapshot)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok"])
        self.assertEqual(coordinator.post_write_calls, [])

    async def test_run_returns_runner_failed_when_post_write_side_effects_raise(
        self,
    ) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
            persist_changed=True,
        )
        coordinator._async_run_post_schedule_write_side_effects = AsyncMock(
            side_effect=RuntimeError("side effects boom")
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule))
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="post_write_side_effects",
                message="side effects boom",
            ),
        )
        self.assertIsNotNone(result.snapshot)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok"])

    async def test_run_preserves_cleanup_metadata_when_cleanup_post_write_fails(
        self,
    ) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        coordinator._async_run_post_schedule_write_side_effects = AsyncMock(
            side_effect=RuntimeError("cleanup side effects boom")
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=False),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="post_write_side_effects",
                message="cleanup side effects boom",
            ),
        )
        self.assertEqual(
            result.cleanup,
            AutomationCleanupSummary(
                reason="automation_disabled",
                actions_stripped=1,
            ),
        )

    async def test_run_does_not_persist_when_later_optimizer_raises(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        first_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_export", "setBy": "automation"},
                }
            },
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=[
                SimpleNamespace(optimize=Mock(return_value=deepcopy(first_schedule))),
                SimpleNamespace(optimize=Mock(side_effect=RuntimeError("boom after first"))),
            ],
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(result.message, "boom after first")
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "failed"])
        self.assertEqual(result.optimizers[1].error, "boom after first")
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])
        self.assertEqual(len(coordinator.snapshot_calls), 2)

    async def test_run_rebuilds_even_when_optimizer_returns_unchanged_document(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=lambda config, *, control_config, appliance_registry: SimpleNamespace(
                optimize=Mock(
                    side_effect=lambda snapshot, current_config, trace=None: deepcopy(
                        snapshot.schedule
                    )
                )
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(optimizer_id="one"),
                    _make_optimizer_instance(optimizer_id="two"),
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        self.assertEqual(len(coordinator.snapshot_calls), 3)
        self.assertEqual(len(coordinator.persist_calls), 1)


class AutomationRunnerTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_run_attaches_trace_with_expected_shape(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertIsNotNone(result.trace)
        payload = result.to_dict()
        self.assertIn("trace", payload)
        trace = payload["trace"]
        expected_len = len(iter_horizon_slot_ids(REFERENCE_TIME))
        self.assertEqual(len(trace["slotIds"]), expected_len)
        for rail in trace["staticRails"].values():
            self.assertEqual(len(rail), expected_len)
        # #272 (P2 of #270): house demand is not run-invariant once the run is
        # phased, so it left the static rails entirely -- staticRails carries
        # only prices and solar, and houseKwh lives on each step instead.
        self.assertEqual(
            set(trace["staticRails"]), {"importPrice", "exportPrice", "solarKwh"}
        )
        self.assertEqual(len(trace["steps"]), 1)
        step = trace["steps"][0]
        self.assertEqual(step["optimizerId"], "avoid-negative-export")
        self.assertEqual(step["status"], "ok")
        self.assertEqual(len(step["railsIn"]["availableSurplusKwh"]), expected_len)
        self.assertIn("houseKwh", step["railsIn"])
        self.assertEqual(len(trace["railsFinal"]["batterySocPct"]), expected_len)
        self.assertIn("houseKwh", trace["railsFinal"])

    async def test_validator_never_fails_the_run_on_an_unbacked_write(self) -> None:
        # The mocked optimizer writes the boiler on without emitting an
        # `applied` decision for it, so the step is flagged incomplete — yet the
        # run still completes (observability must never fail the run).
        written_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(written_schedule)
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        step = result.to_dict()["trace"]["steps"][0]
        self.assertFalse(step["complete"])

    async def test_appliance_write_records_serialize_before_and_after(self) -> None:
        # An optimizer that turns the boiler on for the current slot -> the
        # framework write diff must record the appliance dict, not null.
        written_schedule = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(written_schedule)
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(
                        optimizer_id="run-boiler",
                        kind="appliance_runtime",
                        params={"appliance_id": "boiler", "action": "on"},
                        target={"controllable_id": "boiler"},
                    )
                ),
            ).run(reference_time=REFERENCE_TIME)

        writes = result.to_dict()["trace"]["steps"][0]["writes"]
        boiler_writes = [w for w in writes if w["domain"] == "boiler"]
        self.assertEqual(len(boiler_writes), 1)
        self.assertIsNone(boiler_writes[0]["before"])
        self.assertEqual(
            boiler_writes[0]["after"], {"on": True, "setBy": "automation"}
        )

    async def test_completed_run_hands_the_coordinator_a_run_explanation(
        self,
    ) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(len(coordinator.recorded_explanations), 1)
        explanation = coordinator.recorded_explanations[0]
        self.assertEqual(explanation.run_at, REFERENCE_TIME)
        self.assertEqual(
            list(explanation.slot_ids), iter_horizon_slot_ids(REFERENCE_TIME)
        )
        self.assertEqual(
            [optimizer.optimizer_id for optimizer in explanation.optimizers],
            ["avoid-negative-export"],
        )

    async def test_the_run_explanation_carries_each_step_s_lane(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=lambda snapshot, config, trace=None: deepcopy(snapshot.schedule)
            ),
        ):
            await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(),
                    _make_optimizer_instance(
                        optimizer_id="run-boiler",
                        kind="appliance_runtime",
                        params={"appliance_id": "boiler", "action": "on"},
                        target={"controllable_id": "boiler"},
                    ),
                ),
            ).run(reference_time=REFERENCE_TIME)

        explanation = coordinator.recorded_explanations[0]
        # Only phases 2 and 3 are traced (#272, P2 of #270): the system
        # optimizer ("inverter") is phase 2, the appliance one ("boiler")
        # runs again in phase 3 — its phase-1 pass is untraced.
        self.assertEqual(
            [optimizer.controllable_id for optimizer in explanation.optimizers],
            ["inverter", "boiler"],
        )
        self.assertEqual(
            [optimizer.phase for optimizer in explanation.optimizers], [2, 3]
        )

    async def test_a_failed_run_records_no_explanation(self) -> None:
        # The previous good record must stand: a run that blew up mid-loop has
        # nothing trustworthy to say about the slots it never reached.
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=RuntimeError("boom"))
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertEqual(coordinator.recorded_explanations, [])

    async def test_optimizer_failure_still_attaches_partial_trace(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(side_effect=RuntimeError("boom"))
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(_make_optimizer_instance()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(result.reason, "optimizer_failed")
        self.assertIsNotNone(result.trace)
        payload = result.to_dict()
        self.assertIn("trace", payload)
        self.assertEqual(len(payload["trace"]["steps"]), 1)
        self.assertEqual(payload["trace"]["steps"][0]["status"], "failed")

    async def test_surplus_skip_collapses_column_to_skipped_note_on_the_failed_trace(
        self,
    ) -> None:
        """#272 (P2 of #270): the run fails (see the persists-nothing test
        above), but the trace it reports still carries the collapsed
        single-note column for the appliance whose rails were unavailable —
        the "optimizer_skipped" visibility the issue asks to keep.
        """
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "boiler": {"on": True, "setBy": "automation"},
                }
            },
        )
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        with patch.object(
            pipeline_module,
            "build_optimizer",
            return_value=SimpleNamespace(
                optimize=Mock(
                    side_effect=ConditionRailsUnavailable(
                        "boiler",
                        "when-active demand is unavailable",
                    )
                )
            ),
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(
                    _make_optimizer_instance(
                        optimizer_id="run-boiler-on-surplus",
                        kind="appliance_runtime",
                        target={"controllable_id": "boiler"},
                        params={},
                    )
                ),
            ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "optimizer_failed")
        self.assertIsNotNone(result.trace)
        step = result.to_dict()["trace"]["steps"][0]
        self.assertEqual(step["status"], "skipped")
        self.assertTrue(step["complete"])
        self.assertTrue(
            any(note["code"] == "optimizer_skipped" for note in step["notes"])
        )
        # the note's horizon-wide decision stands in for the whole column
        self.assertEqual(len(step["decisions"]), 1)


class CoordinatorAutomationSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def test_unusable_battery_rebuild_aborts_runner_before_persistence(self) -> None:
        snapshot_coordinator = object.__new__(HelmanCoordinator)
        snapshot_coordinator._build_forecast_schedule_documents = Mock(
            return_value=coordinator_module._ForecastScheduleDocuments(
                forecast_schedule_document=_make_schedule_document(),
                projection_schedule_document=_make_schedule_document(),
            )
        )
        snapshot_coordinator._build_forecast_rebuild_pure = Mock(
            return_value=coordinator_module._ForecastRebuildSnapshot(
                adjusted_house_forecast={
                    "status": "available",
                    "currentSlot": {"timestamp": CURRENT_SLOT_ID},
                },
                battery_forecast={"status": "unavailable", "series": []},
                projection_plan=SimpleNamespace(),
                grid_forecast={"status": "unavailable", "series": []},
            )
        )

        def build_snapshot(**kwargs):
            return snapshot_coordinator._build_automation_snapshot_from_schedule_pure(
                **kwargs, compute_inputs=ComputeInputs()
            )

        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=_make_automation_bundle(),
            snapshot_factory=build_snapshot,
        )
        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=_make_automation_config(_make_optimizer_instance()),
        ).run(reference_time=REFERENCE_TIME)

        self.assertFalse(result.ran_automation)
        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(result.failure.stage, "initial_snapshot")
        self.assertIn("status='unavailable'", result.failure.message)
        self.assertIn(CURRENT_SLOT_ID, result.failure.message)
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.optimizers, ())
        self.assertEqual(coordinator.persist_calls, [])
        self.assertEqual(coordinator.post_write_calls, [])

    def test_snapshot_rejects_unusable_battery_forecast_with_house_anchor(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._build_forecast_schedule_documents = Mock(
            return_value=coordinator_module._ForecastScheduleDocuments(
                forecast_schedule_document=_make_schedule_document(),
                projection_schedule_document=_make_schedule_document(),
            )
        )
        for status in ("unavailable", "not_configured", "insufficient_history", None):
            for anchor_field in ("currentSlot", "currentHour", None):
                with self.subTest(status=status, anchor_field=anchor_field):
                    house_forecast = {"status": "available"}
                    if anchor_field is not None:
                        house_forecast[anchor_field] = {"timestamp": CURRENT_SLOT_ID}
                    coordinator._build_forecast_rebuild_pure = Mock(
                        return_value=coordinator_module._ForecastRebuildSnapshot(
                            adjusted_house_forecast=house_forecast,
                            battery_forecast={"status": status},
                            projection_plan=SimpleNamespace(),
                            # Grid composition still returns a payload when the
                            # battery forecast cannot provide usable rails.
                            grid_forecast={"status": "unavailable", "series": []},
                        )
                    )

                    with self.assertRaises(RuntimeError) as raised:
                        coordinator._build_automation_snapshot_from_schedule_pure(
                            schedule_document=_make_schedule_document(),
                            input_bundle=_make_automation_bundle(),
                            reference_time=REFERENCE_TIME,
                            compute_inputs=ComputeInputs(),
                        )

                    message = str(raised.exception)
                    self.assertIn("unusable battery forecast", message)
                    self.assertIn(f"status={status!r}", message)
                    anchor = CURRENT_SLOT_ID if anchor_field is not None else None
                    self.assertIn(f"house_anchor={anchor!r}", message)

    async def test_async_build_forecast_rebuild_uses_pinned_inputs_and_composes_grid(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = _make_executor_hass()
        coordinator._active_config = {}
        coordinator._appliances_registry = AppliancesRuntimeRegistry()
        coordinator._build_battery_forecast_sync = Mock(
            return_value={
                "status": "available",
                "generatedAt": REFERENCE_TIME.isoformat(),
                "startedAt": REFERENCE_TIME.isoformat(),
                "sourceGranularityMinutes": 15,
                "series": [
                    {
                        "timestamp": CURRENT_SLOT_ID,
                        "durationHours": 0.25,
                        "importedFromGridKwh": 1.4,
                        "exportedToGridKwh": 0.2,
                    }
                ],
            }
        )
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value={"overlay": True}
        )
        projection_plan = SimpleNamespace(
            generated_at=REFERENCE_TIME.isoformat(),
            appliances_by_id={},
            demand_points=(),
        )
        pinned_inputs = {"boiler": 1.25}
        original_house_forecast = {
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [],
        }
        adjusted_house_forecast = {
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [{"timestamp": CURRENT_SLOT_ID, "value": 3.0}],
        }

        with (
            patch.object(
                coordinator_module,
                "build_projection_input_bundle",
                return_value={"projection": "bundle"},
            ),
            patch.object(
                coordinator_module,
                "build_appliance_projection_plan",
                return_value=projection_plan,
            ) as build_projection_plan,
            patch.object(
                coordinator_module,
                "build_adjusted_house_forecast",
                return_value=adjusted_house_forecast,
            ),
        ):
            result = await coordinator._async_build_forecast_rebuild(
                solar_forecast={"status": "available", "points": []},
                original_house_forecast=original_house_forecast,
                started_at=REFERENCE_TIME,
                forecast_schedule_document=_make_schedule_document(),
                projection_schedule_document=_make_schedule_document(),
                when_active_hourly_energy_kwh_by_appliance_id=pinned_inputs,
                grid_price_forecast=_make_grid_price_response(),
            )

        build_projection_plan.assert_called_once_with(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=coordinator._appliances_registry,
            schedule_document=_make_schedule_document(),
            inputs={"projection": "bundle"},
            hass=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id=pinned_inputs,
            vehicle_remaining_capacity_kwh_by_vehicle_id={},
        )
        coordinator._build_battery_forecast_sync.assert_called_once_with(
            solar_forecast={"status": "available", "points": []},
            house_forecast=adjusted_house_forecast,
            started_at=REFERENCE_TIME,
            forecast_days=MAX_FORECAST_DAYS,
            schedule_overlay={"overlay": True},
            live_state=None,
            actual_history=[],
        )
        self.assertEqual(result.adjusted_house_forecast, adjusted_house_forecast)
        self.assertEqual(result.grid_forecast["currentImportPrice"], 7.0)
        self.assertEqual(
            result.grid_forecast["series"][0]["importedFromGridKwh"],
            1.4,
        )
        # The simulation is pure CPU: it goes to the executor, not the loop.
        self.assertEqual(len(coordinator._hass.executor_hops), 1)
        self.assertEqual(
            coordinator._hass.executor_hops[0].func,
            coordinator._build_forecast_rebuild_pure,
        )

    async def test_build_automation_snapshot_locked_populates_context_from_bundle(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = _make_executor_hass()
        coordinator._active_config = {}
        coordinator._appliances_registry = AppliancesRuntimeRegistry()
        # The async wrapper gathers the run-invariant inputs once, then delegates
        # to the pure snapshot builder (which reads the battery state from the
        # gathered ComputeInputs and calls the pure rebuild core).
        coordinator._build_forecast_rebuild_pure = Mock(
            return_value=coordinator_module._ForecastRebuildSnapshot(
                adjusted_house_forecast={"status": "available"},
                battery_forecast={"status": "available"},
                projection_plan=SimpleNamespace(generated_at=REFERENCE_TIME.isoformat()),
                grid_forecast={"status": "available", "currentImportPrice": 7.0},
            )
        )
        coordinator._async_gather_compute_inputs = AsyncMock(
            return_value=ComputeInputs(
                battery_live_state=BatteryLiveState(
                    current_remaining_energy_kwh=7.5,
                    current_soc=50.0,
                    min_soc=10.0,
                    max_soc=90.0,
                    nominal_capacity_kwh=15.0,
                    min_energy_kwh=1.5,
                    max_energy_kwh=13.5,
                ),
            )
        )

        with patch.object(
            coordinator,
            "_build_forecast_schedule_documents",
            return_value=coordinator_module._ForecastScheduleDocuments(
                forecast_schedule_document=_make_schedule_document(),
                projection_schedule_document=_make_schedule_document(),
            ),
        ):
            for status in ("available", "partial"):
                with self.subTest(status=status):
                    coordinator._build_forecast_rebuild_pure.return_value.battery_forecast[
                        "status"
                    ] = status
                    snapshot = await coordinator._build_automation_snapshot_from_schedule_locked(
                        schedule_document=_make_schedule_document(),
                        input_bundle=_make_automation_bundle(),
                        reference_time=REFERENCE_TIME,
                    )
                    self.assertEqual(snapshot.battery_forecast["status"], status)

        self.assertEqual(snapshot.schedule, _make_schedule_document())
        self.assertEqual(snapshot.context.import_price_forecast["currentPrice"], 7.0)
        self.assertEqual(snapshot.context.export_price_forecast["currentPrice"], 2.5)
        self.assertEqual(
            snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertEqual(snapshot.context.battery_state.current_soc, 50.0)
        # One executor hop per snapshot build (two statuses were exercised).
        self.assertEqual(len(coordinator._hass.executor_hops), 2)
        self.assertEqual(
            {hop.func for hop in coordinator._hass.executor_hops},
            {coordinator._build_automation_snapshot_from_schedule_pure},
        )


class CoordinatorRunAutomationFailureTests(unittest.IsolatedAsyncioTestCase):
    """What ``run_automation`` returns when the runner escapes.

    An exception that gets past the runner must still come back as a structured
    ``runner_failed`` result rather than propagating to the caller.
    """

    async def test_run_automation_returns_runner_failed_when_runner_escapes(
        self,
    ) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._active_config = {}
        # Recording a run also announces the new plan on the bus, so every run
        # path -- including the escaped-failure one -- needs a bus to fire on.
        coordinator._hass = SimpleNamespace(
            bus=SimpleNamespace(async_fire=lambda event_type, event_data=None: None)
        )

        class _FailingRunner:
            def __init__(self, *, coordinator, automation_config) -> None:
                pass

            async def run(self, *, reference_time=None, run_reason=None):
                raise RuntimeError("escaped runner failure")

        with (
            patch.object(coordinator_module, "read_automation_config", return_value=None),
            patch.object(pipeline_module, "AutomationRunner", _FailingRunner),
        ):
            result = await coordinator.run_automation(
                reference_time=REFERENCE_TIME,
                reason="trigger",
            )

        self.assertEqual(result.reason, "runner_failed")
        self.assertEqual(
            result.failure,
            AutomationRunFailure(
                stage="coordinator",
                message="escaped runner failure",
            ),
        )
        self.assertIsInstance(result.duration_ms, int)


class RunAutomationWebsocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_automation_returns_serialized_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.completed(snapshot=_make_snapshot())
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_run_automation(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        coordinator.run_automation.assert_awaited_once_with(reason="websocket")
        self.assertEqual(connection.errors, [])
        self.assertTrue(connection.results[0][1]["ranAutomation"])
        self.assertIn("scheduleSlots", connection.results[0][1]["snapshot"])
        self.assertIn("optimizers", connection.results[0][1])
        self.assertIn("durationMs", connection.results[0][1])

    async def test_run_automation_returns_skipped_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.skipped(reason="execution_disabled")
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_run_automation(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        self.assertFalse(connection.results[0][1]["ranAutomation"])
        self.assertEqual(connection.results[0][1]["reason"], "execution_disabled")

    async def test_run_automation_returns_failed_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.failed(
                    reason="runner_failed",
                    failure=AutomationRunFailure(
                        stage="final_persist",
                        message="disk full",
                    ),
                )
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_run_automation(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        self.assertFalse(connection.results[0][1]["ranAutomation"])
        self.assertEqual(connection.results[0][1]["reason"], "runner_failed")
        self.assertEqual(
            connection.results[0][1]["failure"],
            {
                "stage": "final_persist",
                "message": "disk full",
                "unexpected": True,
            },
        )

    async def test_run_automation_requires_admin(self) -> None:
        coordinator = SimpleNamespace(run_automation=AsyncMock())
        connection = _FakeConnection(is_admin=False)

        await ws_run_automation(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/run_automation"},
        )

        coordinator.run_automation.assert_not_awaited()
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )


class ScheduleExplanationWebsocketTests(unittest.IsolatedAsyncioTestCase):
    """`helman/get_schedule_explanation` — the per-lane, per-day "why", read by
    the daily editor's explanation panel.
    """

    MESSAGE = {
        "id": 1,
        "type": "helman/get_schedule_explanation",
        "controllable_id": "inverter",
        "date": "2026-07-31",
    }

    def _book_with_a_run(self) -> ExplanationBook:
        run_at = datetime(2026, 7, 31, 8, 0, tzinfo=timezone(timedelta(hours=2)))
        slot_ids = tuple(
            (run_at + timedelta(minutes=30 * index)).isoformat()
            for index in range(2)
        )
        book = ExplanationBook()
        book.record(
            RunExplanation(
                run_at=run_at,
                slot_ids=slot_ids,
                optimizers=(
                    OptimizerExplanation(
                        optimizer_id="avoid-negative-export",
                        kind="export_price",
                        controllable_id="inverter",
                        slots=tuple(
                            SlotExplanation(
                                slot_id=slot_id,
                                verdict="execute",
                                winning_optimizer="avoid-negative-export",
                            )
                            for slot_id in slot_ids
                        ),
                    ),
                ),
            )
        )
        return book

    async def test_returns_the_record_for_the_requested_lane_and_date(self) -> None:
        book = self._book_with_a_run()
        coordinator = SimpleNamespace(
            get_schedule_explanation=Mock(
                side_effect=lambda *, controllable_id, date: book.get(
                    controllable_id=controllable_id, date=date
                )
            )
        )
        connection = _FakeConnection(is_admin=True)

        ws_get_schedule_explanation(
            _FakeHass(coordinator), connection, dict(self.MESSAGE)
        )

        coordinator.get_schedule_explanation.assert_called_once_with(
            controllable_id="inverter", date="2026-07-31"
        )
        self.assertEqual(connection.errors, [])
        payload = connection.results[0][1]
        self.assertEqual(payload["controllableId"], "inverter")
        self.assertEqual(payload["date"], "2026-07-31")
        self.assertEqual(len(payload["slotIds"]), 2)
        self.assertEqual(payload["runAt"], "2026-07-31T08:00:00+02:00")
        optimizer = payload["optimizers"][0]
        self.assertEqual(optimizer["optimizerId"], "avoid-negative-export")
        self.assertEqual(optimizer["kind"], "export_price")
        self.assertEqual(optimizer["controllableId"], "inverter")
        self.assertEqual(optimizer["status"], "ok")
        self.assertEqual(optimizer["verdict"], [["execute", 2]])
        self.assertEqual(
            optimizer["winningOptimizer"],
            {"0": "avoid-negative-export", "1": "avoid-negative-export"},
        )
        self.assertEqual(
            optimizer["runAt"], [["2026-07-31T08:00:00+02:00", 2]]
        )

    async def test_returns_null_when_nothing_is_recorded(self) -> None:
        coordinator = SimpleNamespace(
            get_schedule_explanation=Mock(return_value=None)
        )
        connection = _FakeConnection(is_admin=True)

        ws_get_schedule_explanation(
            _FakeHass(coordinator),
            connection,
            {**self.MESSAGE, "controllable_id": "appliance:nobody"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, None)])

    async def test_requires_admin(self) -> None:
        coordinator = SimpleNamespace(get_schedule_explanation=Mock())
        connection = _FakeConnection(is_admin=False)

        ws_get_schedule_explanation(
            _FakeHass(coordinator), connection, dict(self.MESSAGE)
        )

        coordinator.get_schedule_explanation.assert_not_called()
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    async def test_returns_not_loaded_when_the_coordinator_is_missing(self) -> None:
        connection = _FakeConnection(is_admin=True)

        ws_get_schedule_explanation(
            SimpleNamespace(data={DOMAIN: {}}), connection, dict(self.MESSAGE)
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "not_loaded", "Helman coordinator not available")],
        )

    def test_the_request_schema_rejects_a_bad_date_and_an_empty_lane(self) -> None:
        import voluptuous as vol

        schema = vol.Schema(ws_get_schedule_explanation.websocket_schema)
        with self.assertRaises(vol.Invalid):
            schema({**self.MESSAGE, "date": "31.7.2026"})
        with self.assertRaises(vol.Invalid):
            schema({**self.MESSAGE, "controllable_id": ""})
        self.assertEqual(schema(dict(self.MESSAGE))["date"], "2026-07-31")


class _RecordingOptimizer:
    """Deterministic fake optimizer: records the snapshots it is handed and
    returns a fixed schedule document. Lets the pure loop be exercised without
    any real optimizer internals (or hass)."""

    def __init__(self, result_document: ScheduleDocument) -> None:
        self._result_document = result_document
        self.seen_snapshots: list[OptimizationSnapshot] = []

    def optimize(self, snapshot, config, trace):
        self.seen_snapshots.append(snapshot)
        return self._result_document


def _summary_signature(summary: OptimizerRunSummary) -> dict[str, object]:
    # Drop the wall-clock duration, which legitimately differs run to run.
    return {
        key: value
        for key, value in summary.to_dict().items()
        if key != "durationMs"
    }


def _run_pure_loop(build_snapshot) -> _PipelineExecutionResult:
    optimizers = [
        _make_optimizer_instance(optimizer_id="a"),
        _make_optimizer_instance(optimizer_id="b"),
    ]
    with patch.object(
        pipeline_module,
        "build_optimizer",
        return_value=_RecordingOptimizer(_make_schedule_document()),
    ):
        return run_optimizer_loop_pure(
            appliance_optimizers=(),
            system_optimizers=optimizers,
            schedule_document=_make_schedule_document(),
            initial_snapshot=_make_snapshot(),
            reference_time=REFERENCE_TIME,
            control_config=None,
            appliance_registry=AppliancesRuntimeRegistry(),
            build_snapshot=build_snapshot,
        )


#: A midday timestamp, so the local date is the same whatever timezone
#: ``dt_util`` is configured with when this module runs alone.
_DAY_CONTEXT_DATE = REFERENCE_TIME.date()
_DAY_CONTEXT_NOON = datetime.fromisoformat("2026-03-20T12:00:00+01:00")


def _day_context_snapshot(*, house_kwh_per_slot: float) -> OptimizationSnapshot:
    """A snapshot the day-context builder can actually classify.

    Solar is fixed; the house figure is what the two optimizers disagree about,
    because one of them is re-planning the lane the other one reads as demand.
    """
    base = _make_snapshot()
    points = [
        {
            "timestamp": (_DAY_CONTEXT_NOON + timedelta(minutes=15 * index)).isoformat(),
            "value": 2.0,
        }
        for index in range(4)
    ]
    return replace(
        base,
        battery_forecast={
            **base.battery_forecast,
            "series": [
                {
                    "timestamp": (
                        _DAY_CONTEXT_NOON + timedelta(minutes=15 * index)
                    ).isoformat(),
                    "solarKwh": 2.5,
                    "baselineHouseKwh": house_kwh_per_slot,
                }
                for index in range(4)
            ],
        },
        context=replace(
            base.context,
            export_price_forecast={
                **base.context.export_price_forecast,
                "points": points,
            },
            import_price_forecast={
                **base.context.import_price_forecast,
                "points": points,
            },
        ),
    )


class PerOptimizerDayContextTests(unittest.TestCase):
    """Two optimizers, one calendar day, two bands — by design (#264).

    Under the phased pipeline (#272, P2 of #270), phase 1's appliance reads
    the bare initial house view; ``charge_hold`` (phase 2) reads whatever
    phase 1's own rebuild produced. The classification follows each of those
    views rather than being computed once up front.
    """

    def test_each_optimizer_sees_the_band_of_its_own_house_view(self) -> None:
        charge_hold = _make_optimizer_instance(
            optimizer_id="charge-hold", kind="charge_hold"
        )
        filtration = _make_optimizer_instance(
            optimizer_id="pool-filtration",
            kind="appliance_runtime",
            target={"controllable_id": "pool"},
        )
        pool_snapshots: list[OptimizationSnapshot] = []

        def _build_optimizer(config, **kwargs):
            if config.id == "pool-filtration":
                optimizer = _RecordingOptimizer(_make_schedule_document())
                original_optimize = optimizer.optimize

                def _optimize(snapshot, cfg, trace):
                    pool_snapshots.append(snapshot)
                    return original_optimize(snapshot, cfg, trace)

                optimizer.optimize = _optimize
                return optimizer
            return _RecordingOptimizer(_make_schedule_document())

        resolver = DayContextResolver(
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            solar_actual_history=[],
            house_actual_history=[],
            previous_bands={},
        )
        with patch.object(
            pipeline_module, "build_optimizer", side_effect=_build_optimizer
        ):
            result = run_optimizer_loop_pure(
                appliance_optimizers=(filtration,),
                system_optimizers=(charge_hold,),
                schedule_document=_make_schedule_document(),
                # Phase 1's filtration sees this bare initial view directly.
                initial_snapshot=_day_context_snapshot(house_kwh_per_slot=3.0),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                # Every rebuild after phase 1's own step (feeding phase 2's
                # charge-hold, and phase 3's re-plan of filtration) sees this.
                build_snapshot=lambda document: _day_context_snapshot(
                    house_kwh_per_slot=5.0
                ),
                resolve_day_contexts=resolver,
            )

        # pool_snapshots[0] is phase 1 (untraced, the bare initial view);
        # pool_snapshots[1] is phase 3 (traced, after phase 2's rebuild).
        self.assertEqual(len(pool_snapshots), 2)
        phase1_context = pool_snapshots[0]
        # 10 kWh of solar against 12 kWh of house (phase 1), then against 20
        # kWh (phase 2/3): the same shape as the day in #264, where the
        # appliance's own load sat in the denominator deciding whether it
        # could run.
        self.assertEqual(
            phase1_context.context.day_contexts[_DAY_CONTEXT_DATE].classification,
            "tight",
        )
        self.assertEqual(
            phase1_context.context.day_contexts[
                _DAY_CONTEXT_DATE
            ].denominator_optimizer_id,
            "pool-filtration",
        )
        # Phase 1 emits no day band -- only phase 2 (charge-hold) and phase 3
        # (filtration, re-planning against the phase-2 rebuild) do.
        self.assertEqual(
            result.emitted_day_bands,
            {
                (_DAY_CONTEXT_DATE, "charge-hold"): "deficit",
                (_DAY_CONTEXT_DATE, "pool-filtration"): "deficit",
            },
        )
        # The canonical reading the run reports (#272, P2 of #270): the final
        # plan, whole house, appliances placed -- not phase 1's bare initial
        # view. Phase 1 alone reads "tight" (see above); the final snapshot
        # reads "deficit", the same band phase 2 and phase 3 actually saw.
        self.assertEqual(
            result.snapshot.context.day_contexts[_DAY_CONTEXT_DATE].classification,
            "deficit",
        )

    def test_the_previous_band_of_the_same_optimizer_damps_the_new_one(self) -> None:
        """Hysteresis is keyed by optimizer, not only by day.

        A ratio of 0.667 is below the deficit threshold outright, so only the
        band this same optimizer emitted last run can hold it at tight.
        """
        optimizers = [
            _make_optimizer_instance(optimizer_id="charge-hold", kind="charge_hold")
        ]
        resolver = DayContextResolver(
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            solar_actual_history=[],
            house_actual_history=[],
            previous_bands={(_DAY_CONTEXT_DATE, "charge-hold"): "tight"},
        )
        seen: list[_RecordingOptimizer] = []

        def _build_optimizer(config, **kwargs):
            optimizer = _RecordingOptimizer(_make_schedule_document())
            seen.append(optimizer)
            return optimizer

        with patch.object(
            pipeline_module, "build_optimizer", side_effect=_build_optimizer
        ):
            result = run_optimizer_loop_pure(
                appliance_optimizers=(),
                system_optimizers=optimizers,
                schedule_document=_make_schedule_document(),
                initial_snapshot=_day_context_snapshot(house_kwh_per_slot=3.75),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=lambda document: _day_context_snapshot(
                    house_kwh_per_slot=3.75
                ),
                resolve_day_contexts=resolver,
            )

        self.assertEqual(
            seen[0].seen_snapshots[0].context.day_contexts[
                _DAY_CONTEXT_DATE
            ].classification,
            "tight",
        )
        self.assertEqual(
            result.emitted_day_bands,
            {(_DAY_CONTEXT_DATE, "charge-hold"): "tight"},
        )


class RunOptimizerLoopPurityTests(unittest.TestCase):
    """The optimizer loop is offloaded to an executor thread, so it must be a
    pure function of its inputs: no ``hass`` access, no ``await``."""

    def test_source_has_no_await_and_no_hass_reference(self) -> None:
        func = ast.parse(inspect.getsource(run_optimizer_loop_pure)).body[0]
        self.assertFalse(
            any(isinstance(node, ast.Await) for node in ast.walk(func)),
            "run_optimizer_loop_pure must not await",
        )
        referenced = {
            node.id for node in ast.walk(func) if isinstance(node, ast.Name)
        } | {
            node.attr for node in ast.walk(func) if isinstance(node, ast.Attribute)
        }
        self.assertFalse(
            any("hass" in name.lower() for name in referenced),
            "run_optimizer_loop_pure must not touch hass",
        )

    def test_runs_in_worker_thread_without_hass(self) -> None:
        rebuilt_documents: list[ScheduleDocument] = []

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            rebuilt_documents.append(document)
            return _make_snapshot(schedule_document=document)

        # Run in a real worker thread with no event loop and no hass in scope —
        # if the loop reached for either it would fail here.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(_run_pure_loop, build_snapshot).result()

        self.assertIsInstance(result, _PipelineExecutionResult)
        self.assertEqual([summary.status for summary in result.optimizers], ["ok", "ok"])
        # The snapshot is rebuilt once per optimizer via the injected pure builder.
        self.assertEqual(len(rebuilt_documents), 2)


class OptimizerLoopExecutorEquivalenceTests(unittest.IsolatedAsyncioTestCase):
    """Moving the loop across the executor boundary must not change its result."""

    async def test_executor_hop_matches_inline(self) -> None:
        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        inline_result = _run_pure_loop(build_snapshot)

        loop = asyncio.get_running_loop()
        executor_result = await loop.run_in_executor(
            None, lambda: _run_pure_loop(build_snapshot)
        )

        self.assertEqual(
            inline_result.working_schedule_document,
            executor_result.working_schedule_document,
        )
        self.assertEqual(
            [_summary_signature(s) for s in inline_result.optimizers],
            [_summary_signature(s) for s in executor_result.optimizers],
        )
        self.assertEqual(
            inline_result.trace.to_dict(),
            executor_result.trace.to_dict(),
        )


if __name__ == "__main__":
    unittest.main()


def _make_appliance_optimizer_instance(
    *,
    optimizer_id: str,
    controllable_id: str,
) -> OptimizerInstanceConfig:
    return _make_optimizer_instance(
        optimizer_id=optimizer_id,
        kind="appliance_runtime",
        target={"controllable_id": controllable_id},
        params={"daily_minimum": {"hours": 1.0}},
    )


class PhasedRunTests(unittest.IsolatedAsyncioTestCase):
    """#272 (P2 of #270): the three-phase replacement for the old
    baseline-restore machinery (#116's original fix).

    Phase 1 (appliance, untraced) plans every appliance against no inverter
    action. Phase 2 (system, traced) reads the whole phase-1 appliance demand.
    Phase 3 (appliance, traced) re-plans each appliance against earlier
    phase-3 appliances plus the phase-2 inverter plan.
    """

    APPLIANCE_ACTION = {"on": True, "setBy": "automation"}
    INVERTER_ACTION = {"kind": "stop_charging", "setBy": "automation"}

    def _baseline_document(self) -> ScheduleDocument:
        return ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": dict(self.INVERTER_ACTION),
                    "pool-filtration": dict(self.APPLIANCE_ACTION),
                }
            },
        )

    def _optimizers(self) -> tuple[OptimizerInstanceConfig, ...]:
        return (
            _make_optimizer_instance(optimizer_id="charge-hold", kind="charge_hold"),
            _make_appliance_optimizer_instance(
                optimizer_id="pool", controllable_id="pool-filtration"
            ),
        )

    async def test_cold_start_sizes_charge_hold_against_full_appliance_demand(
        self,
    ) -> None:
        """The #116 assertion, now with no baseline present (G1's cold-start
        fix): with nothing stored from a previous run at all, phase 1 still
        places the appliance for real before ``charge_hold`` (phase 2) ever
        reads the house.
        """
        coordinator = _FakeCoordinator(
            # No prior plan whatsoever -- true cold start.
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        appliance_plan = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "pool-filtration": dict(self.APPLIANCE_ACTION),
                }
            },
        )
        charge_hold_seen: list[OptimizationSnapshot] = []

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "pool":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(appliance_plan))
                )

            def _charge_hold_optimize(snapshot, current_config, trace=None):
                charge_hold_seen.append(snapshot)
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_charge_hold_optimize))

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=_build_optimizer_side_effect,
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(*self._optimizers()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        self.assertEqual(len(charge_hold_seen), 1)
        slot = schedule_document_to_dict(charge_hold_seen[0].schedule)["slots"][
            CURRENT_SLOT_ID
        ]
        self.assertEqual(slot.get("pool-filtration"), self.APPLIANCE_ACTION)

    async def test_run_output_is_independent_of_the_prior_plan(self) -> None:
        """G1's determinism acceptance for #272: holding every other input
        fixed (forecasts, prices, live state, day-context bands, appliance
        runtime history) and varying only the automation-owned content of the
        schedule already on disk -- present, different, or absent entirely --
        must produce a byte-identical finished document. The prior plan is
        stripped before phase 1 ever runs and never read again, so nothing
        about it can leak into a decision.

        This must not be confused with history-dependent variation (a
        different hysteresis band, a different appliance runtime history),
        which stays legitimate -- only the *prior plan's content* is varied
        here, nothing else.
        """
        pool_plan = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"pool-filtration": dict(self.APPLIANCE_ACTION)}},
        )

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "pool":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(pool_plan))
                )

            def _charge_hold_optimize(snapshot, current_config, trace=None):
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_charge_hold_optimize))

        other_slot_id = "2026-03-20T21:15:00+01:00"
        prior_plans = (
            # Absent: true cold start, nothing on disk at all.
            ScheduleDocument(execution_enabled=True),
            # Present: a prior plan occupying the exact lanes this run will
            # write, at the exact slot this run will choose.
            self._baseline_document(),
            # Different: a prior plan occupying the same lanes, but at a
            # different slot than this run will choose.
            ScheduleDocument(
                execution_enabled=True,
                slots={
                    other_slot_id: {
                        "inverter": dict(self.INVERTER_ACTION),
                        "pool-filtration": dict(self.APPLIANCE_ACTION),
                    }
                },
            ),
        )

        outputs: list[dict] = []
        for prior_plan in prior_plans:
            coordinator = _FakeCoordinator(
                schedule_document=prior_plan,
                bundle=_make_automation_bundle(),
                snapshot_factory=_make_snapshot,
            )
            with patch.object(
                pipeline_module,
                "build_optimizer",
                side_effect=_build_optimizer_side_effect,
            ):
                result = await AutomationRunner(
                    coordinator=coordinator,
                    automation_config=_make_automation_config(*self._optimizers()),
                ).run(reference_time=REFERENCE_TIME)
            self.assertTrue(result.ran_automation)
            outputs.append(schedule_document_to_dict(result.snapshot.schedule))

        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0], outputs[2])

    def test_phase1_appliance_sees_earlier_appliances_and_no_inverter_action(
        self,
    ) -> None:
        pool = _make_appliance_optimizer_instance(
            optimizer_id="pool", controllable_id="pool-filtration"
        )
        washer = _make_appliance_optimizer_instance(
            optimizer_id="washer", controllable_id="washer"
        )
        charge_hold = _make_optimizer_instance(
            optimizer_id="charge-hold", kind="charge_hold"
        )
        pool_plan = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"pool-filtration": dict(self.APPLIANCE_ACTION)}},
        )
        seen_by_id: dict[str, OptimizationSnapshot] = {}

        def _build_optimizer(config, **kwargs):
            def _optimize(snapshot, current_config, trace=None):
                seen_by_id[current_config.id] = snapshot
                if current_config.id == "pool":
                    return deepcopy(pool_plan)
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_optimize))

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(pool, washer),
                system_optimizers=(charge_hold,),
                schedule_document=self._baseline_document(),
                initial_snapshot=build_snapshot(self._baseline_document()),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
            )

        washer_phase1_slot = schedule_document_to_dict(
            seen_by_id["washer"].schedule
        )["slots"].get(CURRENT_SLOT_ID, {})
        # Washer (second appliance, phase 1) sees pool's fresh phase-1 write...
        self.assertEqual(
            washer_phase1_slot.get("pool-filtration"), self.APPLIANCE_ACTION
        )
        # ...but no inverter action at all: phase 2 has not run yet.
        self.assertNotIn("inverter", washer_phase1_slot)

    async def test_phase3_appliance_sees_the_phase2_inverter_plan(self) -> None:
        """Phase 3 placements are computed against the phase-2 inverter lane:
        a ``charge_hold``-written action is visible to the appliance
        optimizer re-planning in phase 3 (earlier appliances + phase-2
        inverter plan)."""
        coordinator = _FakeCoordinator(
            schedule_document=ScheduleDocument(execution_enabled=True),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        charge_hold_write = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"inverter": dict(self.INVERTER_ACTION)}},
        )
        phase3_seen: list[OptimizationSnapshot] = []

        def _build_optimizer_side_effect(config, *, control_config, appliance_registry):
            if config.id == "charge-hold":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(charge_hold_write))
                )

            def _pool_optimize(snapshot, current_config, trace=None):
                phase3_seen.append(snapshot)
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_pool_optimize))

        with patch.object(
            pipeline_module,
            "build_optimizer",
            side_effect=_build_optimizer_side_effect,
        ):
            result = await AutomationRunner(
                coordinator=coordinator,
                automation_config=_make_automation_config(*self._optimizers()),
            ).run(reference_time=REFERENCE_TIME)

        self.assertTrue(result.ran_automation)
        # phase3_seen[0] is phase 1 (no inverter yet), phase3_seen[1] is phase 3.
        self.assertEqual(len(phase3_seen), 2)
        phase1_slot = schedule_document_to_dict(phase3_seen[0].schedule)["slots"].get(
            CURRENT_SLOT_ID, {}
        )
        phase3_slot = schedule_document_to_dict(phase3_seen[1].schedule)["slots"].get(
            CURRENT_SLOT_ID, {}
        )
        self.assertNotIn("inverter", phase1_slot)
        self.assertEqual(phase3_slot.get("inverter"), self.INVERTER_ACTION)
        # Phase 1's provisional run must not leak into the reported result:
        # each configured optimizer (system and appliance alike) appears
        # exactly once, as its authoritative (phase-2 or phase-3) summary.
        self.assertEqual(
            sorted(summary.id for summary in result.optimizers),
            ["charge-hold", "pool"],
        )

    def test_same_lane_composes_in_bucket_order_in_both_appliance_phases(self) -> None:
        """Two optimizers targeting one appliance lane: the later one sees the
        earlier one's writes in that lane, in both phase 1 and phase 3."""
        first = _make_appliance_optimizer_instance(
            optimizer_id="first", controllable_id="boiler"
        )
        second = _make_appliance_optimizer_instance(
            optimizer_id="second", controllable_id="boiler"
        )
        first_write = ScheduleDocument(
            execution_enabled=True,
            slots={CURRENT_SLOT_ID: {"boiler": {"on": True, "setBy": "automation"}}},
        )
        seen_before_second: list[dict] = []

        def _build_optimizer(config, **kwargs):
            if config.id == "first":
                return SimpleNamespace(
                    optimize=Mock(return_value=deepcopy(first_write))
                )

            def _second_optimize(snapshot, current_config, trace=None):
                seen_before_second.append(
                    schedule_document_to_dict(snapshot.schedule)["slots"].get(
                        CURRENT_SLOT_ID, {}
                    )
                )
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_second_optimize))

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(first, second),
                system_optimizers=(),
                schedule_document=ScheduleDocument(execution_enabled=True),
                initial_snapshot=build_snapshot(ScheduleDocument(execution_enabled=True)),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
            )

        # Once from phase 1, once from phase 3 -- both see "first"'s write.
        self.assertEqual(len(seen_before_second), 2)
        for slot in seen_before_second:
            self.assertEqual(slot.get("boiler"), {"on": True, "setBy": "automation"})

    def test_house_kwh_differs_between_phase2_and_phase3_when_phase3_moves_it(
        self,
    ) -> None:
        """``houseKwh`` is captured per step (#272, P2 of #270), not once for
        the whole run: phase 2's step shows the phase-1 estimate it actually
        read, and a phase-3 step shows a different figure once phase 3 moves
        the appliance's load out of the slot phase 1 put it in.
        """
        charge_hold = _make_optimizer_instance(
            optimizer_id="charge-hold", kind="charge_hold"
        )
        boiler = _make_appliance_optimizer_instance(
            optimizer_id="boiler", controllable_id="boiler"
        )
        boiler_action = {"on": True, "setBy": "automation"}
        other_slot_id = "2026-03-20T21:15:00+01:00"

        def _build_optimizer(config, **kwargs):
            if config.id == "boiler":
                calls = {"count": 0}

                def _boiler_optimize(snapshot, current_config, trace=None):
                    calls["count"] += 1
                    slot_id = CURRENT_SLOT_ID if calls["count"] == 1 else other_slot_id
                    return ScheduleDocument(
                        execution_enabled=True,
                        slots={slot_id: {"boiler": dict(boiler_action)}},
                    )

                return SimpleNamespace(optimize=Mock(side_effect=_boiler_optimize))

            # charge_hold: reads, writes nothing.
            def _charge_hold_optimize(snapshot, current_config, trace=None):
                return snapshot.schedule

            return SimpleNamespace(optimize=Mock(side_effect=_charge_hold_optimize))

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            # houseKwh at CURRENT_SLOT_ID depends on whether the boiler's
            # automation-owned action is present there in this document --
            # exactly what a real forecast rebuild would reflect.
            slot_actions = document.slots.get(CURRENT_SLOT_ID, {})
            boiler_present = slot_actions.get("boiler", {}).get("setBy") == "automation"
            house_kwh = 3.0 + (2.0 if boiler_present else 0.0)
            base = _make_snapshot(schedule_document=document)
            return replace(
                base,
                battery_forecast={
                    **base.battery_forecast,
                    "series": [
                        {
                            "timestamp": CURRENT_SLOT_ID,
                            "durationHours": 0.25,
                            "importedFromGridKwh": 1.4,
                            "exportedToGridKwh": 0.2,
                            "baselineHouseKwh": house_kwh,
                        }
                    ],
                },
            )

        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            result = pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(boiler,),
                system_optimizers=(charge_hold,),
                schedule_document=ScheduleDocument(execution_enabled=True),
                initial_snapshot=build_snapshot(ScheduleDocument(execution_enabled=True)),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
            )

        trace = result.trace.to_dict()
        steps_by_id = {step["optimizerId"]: step for step in trace["steps"]}
        # Phase 2 (charge-hold) reads the phase-1 estimate: boiler present at
        # CURRENT_SLOT_ID -> houseKwh includes it.
        charge_hold_house_kwh = steps_by_id["charge-hold"]["railsIn"]["houseKwh"][0]
        # Phase 3 (boiler) reads the house after the phase-3 strip cleared
        # phase 1's placement: boiler absent from CURRENT_SLOT_ID until this
        # very step writes it (to a different slot) -> houseKwh excludes it.
        boiler_house_kwh = steps_by_id["boiler"]["railsIn"]["houseKwh"][0]
        self.assertEqual(charge_hold_house_kwh, 5.0)
        self.assertEqual(boiler_house_kwh, 3.0)
        self.assertNotEqual(charge_hold_house_kwh, boiler_house_kwh)


class ApplianceGroupExpansionTests(unittest.TestCase):
    """#291: one ``appliance_runtime`` config naming an ordered group expands in
    the pipeline into one single-target step per member, in priority order.

    The optimizer here is a stand-in for the real ranking: a slot carries enough
    surplus for ``capacity`` appliances, and each member places itself only if
    the snapshot it received leaves room. That is exactly what the rebuilt
    snapshot gives the real optimizer — earlier members' placements already
    consumed the surplus — so the stand-in keeps the test on the pipeline.
    """

    ACTION = {"on": True, "setBy": "automation"}
    STALE_SLOT_ID = "2026-03-20T21:15:00+01:00"

    def _group(self) -> OptimizerInstanceConfig:
        return OptimizerInstanceConfig(
            id="acs",
            kind="appliance_runtime",
            target={
                "controllables": (
                    {"controllable_id": "ac-living"},
                    {"controllable_id": "ac-bedroom"},
                )
            },
            params={"window": {"start": "08:00", "end": "18:00"}},
        )

    def _run(self, *, capacity: int, schedule_document: ScheduleDocument | None = None):
        seen: list[tuple[str, OptimizationSnapshot]] = []
        resolver_calls: list[str | None] = []

        def _build_optimizer(config, **kwargs):
            def _optimize(snapshot, current_config, trace=None):
                lane = current_config.target["controllable_id"]
                seen.append((lane, snapshot))
                slots = deepcopy(snapshot.schedule.slots)
                current = slots.setdefault(CURRENT_SLOT_ID, {})
                if len(current) >= capacity:
                    return snapshot.schedule
                current[lane] = dict(self.ACTION)
                return ScheduleDocument(execution_enabled=True, slots=slots)

            return SimpleNamespace(optimize=Mock(side_effect=_optimize))

        def _resolve_day_contexts(snapshot, *, optimizer_id):
            resolver_calls.append(optimizer_id)
            # A fresh object per call, so identity says which call a member saw.
            return {
                REFERENCE_TIME.date(): SimpleNamespace(
                    classification=f"call-{len(resolver_calls)}"
                )
            }

        def build_snapshot(document: ScheduleDocument) -> OptimizationSnapshot:
            return _make_snapshot(schedule_document=document)

        document = schedule_document or ScheduleDocument(execution_enabled=True)
        with patch.object(pipeline_module, "build_optimizer", side_effect=_build_optimizer):
            result = pipeline_module.run_optimizer_loop_pure(
                appliance_optimizers=(self._group(),),
                system_optimizers=(),
                schedule_document=document,
                initial_snapshot=build_snapshot(document),
                reference_time=REFERENCE_TIME,
                control_config=None,
                appliance_registry=AppliancesRuntimeRegistry(),
                build_snapshot=build_snapshot,
                resolve_day_contexts=_resolve_day_contexts,
            )
        return result, seen, resolver_calls

    def test_members_run_in_order_as_one_step_each_on_their_own_lane(self) -> None:
        result, seen, _calls = self._run(capacity=2)

        # Phase 1 then phase 3, each walking the group in priority order.
        self.assertEqual(
            [lane for lane, _snapshot in seen],
            ["ac-living", "ac-bedroom", "ac-living", "ac-bedroom"],
        )
        self.assertEqual(
            [
                (step.optimizer_id, step.controllable_id, step.phase)
                for step in result.trace.optimizer_explanations()
            ],
            [
                ("acs", "ac-living", PHASE_FINAL_APPLIANCE_PLACEMENT),
                ("acs", "ac-bedroom", PHASE_FINAL_APPLIANCE_PLACEMENT),
            ],
        )
        # One summary per configured optimizer, not per lane.
        self.assertEqual(
            [(summary.id, summary.status, summary.slots_written) for summary in result.optimizers],
            [("acs", "ok", 2)],
        )
        slot = schedule_document_to_dict(result.working_schedule_document)["slots"][
            CURRENT_SLOT_ID
        ]
        self.assertEqual(slot, {"ac-living": self.ACTION, "ac-bedroom": self.ACTION})

    def test_the_second_member_plans_against_the_first_members_placements(self) -> None:
        """Surplus for one unit: only the top-priority member is placed."""
        result, seen, _calls = self._run(capacity=1)

        phase3_bedroom_snapshot = seen[3][1]
        self.assertEqual(
            schedule_document_to_dict(phase3_bedroom_snapshot.schedule)["slots"][
                CURRENT_SLOT_ID
            ],
            {"ac-living": self.ACTION},
        )
        slot = schedule_document_to_dict(result.working_schedule_document)["slots"][
            CURRENT_SLOT_ID
        ]
        self.assertEqual(slot, {"ac-living": self.ACTION})

    def test_the_group_shares_one_day_classification(self) -> None:
        result, seen, resolver_calls = self._run(capacity=2)

        # Once per phase for the group -- not once per member -- plus the
        # run-wide reading.
        self.assertEqual(resolver_calls, ["acs", "acs", None])
        for first, second in ((seen[0], seen[1]), (seen[2], seen[3])):
            self.assertIs(
                first[1].context.day_contexts, second[1].context.day_contexts
            )
        self.assertEqual(
            result.emitted_day_bands, {(REFERENCE_TIME.date(), "acs"): "call-2"}
        )

    def test_every_members_stale_lane_is_stripped_before_the_final_placement(
        self,
    ) -> None:
        stale = ScheduleDocument(
            execution_enabled=True,
            slots={
                self.STALE_SLOT_ID: {
                    "ac-living": dict(self.ACTION),
                    "ac-bedroom": dict(self.ACTION),
                }
            },
        )

        result, _seen, _calls = self._run(capacity=1, schedule_document=stale)

        slots = schedule_document_to_dict(result.working_schedule_document)["slots"]
        self.assertNotIn("ac-bedroom", slots.get(self.STALE_SLOT_ID, {}))
        self.assertNotIn("ac-living", slots.get(self.STALE_SLOT_ID, {}))
        self.assertEqual(slots[CURRENT_SLOT_ID], {"ac-living": self.ACTION})
