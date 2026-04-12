from __future__ import annotations

import asyncio
import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime
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
from custom_components.helman.automation.input_bundle import AutomationInputBundle
from custom_components.helman.automation.pipeline import AutomationRunResult, AutomationRunner
from custom_components.helman.automation.snapshot import (
    OptimizationContext,
    OptimizationSnapshot,
    snapshot_to_dict,
)
from custom_components.helman.battery_state import BatteryEntityConfig, BatteryLiveState
from custom_components.helman.const import DOMAIN, MAX_FORECAST_DAYS
from custom_components.helman.coordinator import HelmanCoordinator
from custom_components.helman import coordinator as coordinator_module
from custom_components.helman.scheduling.schedule import ScheduleDocument
from custom_components.helman.websockets import ws_debug_run_automation

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
    "homeassistant.helpers.storage",
    "homeassistant.helpers.entity_registry",
):
    sys.modules.pop(module_name, None)


def _make_schedule_document(*, execution_enabled: bool = True) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={
            CURRENT_SLOT_ID: {
                "inverter": {"kind": "stop_export"},
                "appliances": {},
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
) -> OptimizationSnapshot:
    return OptimizationSnapshot(
        schedule=_make_schedule_document() if schedule_document is None else schedule_document,
        adjusted_house_forecast={
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "series": [{"timestamp": CURRENT_SLOT_ID, "value": 3.0}],
        },
        battery_forecast={
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
            now=REFERENCE_TIME,
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
            when_active_hourly_energy_kwh_by_appliance_id={"boiler": 1.25},
        ),
    )


class _FakeCoordinator:
    def __init__(
        self,
        *,
        schedule_document: ScheduleDocument,
        bundle: AutomationInputBundle | None,
        snapshot_factory,
    ) -> None:
        self._schedule_lock = asyncio.Lock()
        self._schedule_document = schedule_document
        self._bundle = bundle
        self._snapshot_factory = snapshot_factory
        self.snapshot_calls: list[dict[str, object]] = []

    def _build_automation_working_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        return deepcopy(self._schedule_document)

    def get_automation_input_bundle(self) -> AutomationInputBundle | None:
        return None if self._bundle is None else deepcopy(self._bundle)

    async def _build_automation_snapshot_from_schedule_locked(
        self,
        *,
        schedule_document: ScheduleDocument,
        input_bundle: AutomationInputBundle,
        reference_time: datetime,
    ) -> OptimizationSnapshot:
        self.snapshot_calls.append(
            {
                "schedule_document": schedule_document,
                "input_bundle": input_bundle,
                "reference_time": reference_time,
            }
        )
        return self._snapshot_factory(schedule_document=schedule_document)


class _FakeConnection:
    def __init__(self, *, is_admin: bool) -> None:
        self.user = SimpleNamespace(is_admin=is_admin)
        self.results: list[tuple[int, dict]] = []
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
        self.assertEqual(payload["context"]["applianceRegistry"], {"appliances": []})


class AutomationRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_returns_execution_disabled_when_execution_flag_is_off(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(execution_enabled=False),
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=True),
        ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(
            result.to_dict(),
            {
                "ranAutomation": False,
                "reason": "execution_disabled",
                "snapshot": None,
            },
        )
        self.assertEqual(coordinator.snapshot_calls, [])

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

        self.assertEqual(
            result.to_dict(),
            {
                "ranAutomation": False,
                "reason": "automation_disabled",
                "snapshot": None,
            },
        )
        self.assertEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_inputs_unavailable_without_bundle(self) -> None:
        coordinator = _FakeCoordinator(
            schedule_document=_make_schedule_document(),
            bundle=None,
            snapshot_factory=_make_snapshot,
        )

        result = await AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=True),
        ).run(reference_time=REFERENCE_TIME)

        self.assertEqual(
            result.to_dict(),
            {
                "ranAutomation": False,
                "reason": "inputs_unavailable",
                "snapshot": None,
            },
        )
        self.assertEqual(coordinator.snapshot_calls, [])

    async def test_run_returns_snapshot_and_is_repeatable(self) -> None:
        schedule_document = _make_schedule_document()
        coordinator = _FakeCoordinator(
            schedule_document=schedule_document,
            bundle=_make_automation_bundle(),
            snapshot_factory=_make_snapshot,
        )
        runner = AutomationRunner(
            coordinator=coordinator,
            automation_config=AutomationConfig(enabled=True),
        )

        first = await runner.run(reference_time=REFERENCE_TIME)
        second = await runner.run(reference_time=REFERENCE_TIME)

        self.assertTrue(first.ran_automation)
        self.assertEqual(first.snapshot.schedule, schedule_document)
        self.assertEqual(second.snapshot.schedule, schedule_document)
        self.assertEqual(first.snapshot.adjusted_house_forecast["status"], "available")
        self.assertEqual(first.snapshot.battery_forecast["status"], "available")
        self.assertEqual(first.snapshot.grid_forecast["currentImportPrice"], 7.0)
        self.assertEqual(
            first.snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertEqual(len(coordinator.snapshot_calls), 2)


class CoordinatorAutomationSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_build_forecast_rebuild_uses_pinned_inputs_and_composes_grid(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._appliances_registry = AppliancesRuntimeRegistry()
        coordinator._build_battery_forecast = AsyncMock(
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
                generic_hourly_energy_kwh_by_appliance_id=pinned_inputs,
                grid_price_forecast=_make_grid_price_response(),
            )

        build_projection_plan.assert_called_once_with(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=coordinator._appliances_registry,
            schedule_document=_make_schedule_document(),
            inputs={"projection": "bundle"},
            hass=coordinator._hass,
            reference_time=REFERENCE_TIME,
            generic_hourly_energy_kwh_by_appliance_id=pinned_inputs,
        )
        coordinator._build_battery_forecast.assert_awaited_once_with(
            solar_forecast={"status": "available", "points": []},
            house_forecast=adjusted_house_forecast,
            started_at=REFERENCE_TIME,
            forecast_days=MAX_FORECAST_DAYS,
            schedule_overlay={"overlay": True},
        )
        self.assertEqual(result.adjusted_house_forecast, adjusted_house_forecast)
        self.assertEqual(result.grid_forecast["currentImportPrice"], 7.0)
        self.assertEqual(
            result.grid_forecast["series"][0]["importedFromGridKwh"],
            1.4,
        )

    async def test_build_automation_snapshot_locked_populates_context_from_bundle(self) -> None:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        coordinator._appliances_registry = AppliancesRuntimeRegistry()
        coordinator._async_build_forecast_rebuild = AsyncMock(
            return_value=coordinator_module._ForecastRebuildSnapshot(
                adjusted_house_forecast={"status": "available"},
                battery_forecast={"status": "available"},
                projection_plan=SimpleNamespace(generated_at=REFERENCE_TIME.isoformat()),
                grid_forecast={"status": "available", "currentImportPrice": 7.0},
            )
        )

        with (
            patch.object(
                coordinator,
                "_build_forecast_schedule_documents",
                return_value=coordinator_module._ForecastScheduleDocuments(
                    forecast_schedule_document=_make_schedule_document(),
                    projection_schedule_document=_make_schedule_document(),
                    schedule_execution_enabled=True,
                ),
            ),
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                return_value=BatteryLiveState(
                    current_remaining_energy_kwh=7.5,
                    current_soc=50.0,
                    min_soc=10.0,
                    max_soc=90.0,
                    nominal_capacity_kwh=15.0,
                    min_energy_kwh=1.5,
                    max_energy_kwh=13.5,
                ),
            ),
        ):
            snapshot = await coordinator._build_automation_snapshot_from_schedule_locked(
                schedule_document=_make_schedule_document(),
                input_bundle=_make_automation_bundle(),
                reference_time=REFERENCE_TIME,
            )

        self.assertEqual(snapshot.schedule, _make_schedule_document())
        self.assertEqual(snapshot.context.import_price_forecast["currentPrice"], 7.0)
        self.assertEqual(snapshot.context.export_price_forecast["currentPrice"], 2.5)
        self.assertEqual(
            snapshot.context.when_active_hourly_energy_kwh_by_appliance_id,
            {"boiler": 1.25},
        )
        self.assertEqual(snapshot.context.battery_state.current_soc, 50.0)


class DebugAutomationWebsocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_debug_run_automation_returns_serialized_result(self) -> None:
        coordinator = SimpleNamespace(
            run_automation=AsyncMock(
                return_value=AutomationRunResult.completed(snapshot=_make_snapshot())
            )
        )
        connection = _FakeConnection(is_admin=True)

        await ws_debug_run_automation(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/__debug_run_automation"},
        )

        coordinator.run_automation.assert_awaited_once_with()
        self.assertEqual(connection.errors, [])
        self.assertTrue(connection.results[0][1]["ranAutomation"])
        self.assertIn("scheduleSlots", connection.results[0][1]["snapshot"])

    async def test_debug_run_automation_requires_admin(self) -> None:
        coordinator = SimpleNamespace(run_automation=AsyncMock())
        connection = _FakeConnection(is_admin=False)

        await ws_debug_run_automation(
            _FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/__debug_run_automation"},
        )

        coordinator.run_automation.assert_not_awaited()
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )


if __name__ == "__main__":
    unittest.main()
