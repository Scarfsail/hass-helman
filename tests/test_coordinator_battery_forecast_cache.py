from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")


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
    scheduling_pkg.__path__ = [str(ROOT / "custom_components" / "helman" / "scheduling")]

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
        {
            "_MAX_ALIGNMENT_PADDING_SLOTS": 3,
            "_make_payload": staticmethod(lambda **kwargs: kwargs),
        },
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

    battery_state_mod = types.ModuleType("custom_components.helman.battery_state")
    battery_state_mod.describe_battery_entity_config_issue = lambda config: None
    battery_state_mod.describe_battery_live_state_issue = (
        lambda hass, config=None: None
    )
    battery_state_mod.read_battery_entity_config = lambda config: None
    battery_state_mod.read_battery_live_state = lambda hass, config=None: None
    battery_state_mod.read_battery_soc_bounds = lambda hass, config=None: None
    battery_state_mod.read_battery_soc_bounds_config = lambda config: None
    sys.modules[battery_state_mod.__name__] = battery_state_mod

    recorder_slots_mod = types.ModuleType("custom_components.helman.recorder_hourly_series")
    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    async def _estimate_average_hourly_energy_when_switch_on(*args, **kwargs):
        return None

    async def _estimate_average_hourly_energy_when_climate_active(*args, **kwargs):
        return None

    recorder_slots_mod.estimate_average_hourly_energy_when_switch_on = (
        _estimate_average_hourly_energy_when_switch_on
    )
    recorder_slots_mod.estimate_average_hourly_energy_when_climate_active = (
        _estimate_average_hourly_energy_when_climate_active
    )
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    schedule_mod = types.ModuleType("custom_components.helman.scheduling.schedule")
    schedule_mod.ScheduleControlConfig = type("ScheduleControlConfig", (), {})

    class ScheduleDocument:
        def __init__(self, execution_enabled=False, slots=None) -> None:
            self.execution_enabled = execution_enabled
            self.slots = {} if slots is None else dict(slots)

        def __eq__(self, other) -> bool:
            return (
                isinstance(other, ScheduleDocument)
                and self.execution_enabled == other.execution_enabled
                and self.slots == other.slots
            )

    schedule_mod.ScheduleDocument = ScheduleDocument
    schedule_mod.ScheduleError = type("ScheduleError", (Exception,), {})
    schedule_mod.ScheduleResponseDict = dict
    schedule_mod.ScheduleSlot = dict
    schedule_mod.SCHEDULE_SLOT_DURATION = timedelta(minutes=30)
    schedule_mod.apply_slot_patches = lambda stored_slots, slot_patches: []
    schedule_mod.build_horizon_start = lambda reference_time: reference_time.replace(
        minute=(reference_time.minute // 30) * 30,
        second=0,
        microsecond=0,
    )
    schedule_mod.describe_schedule_control_config_issue = lambda config: None
    schedule_mod.format_slot_id = lambda slot: slot.isoformat(timespec="seconds")
    schedule_mod.parse_slot_id = datetime.fromisoformat
    schedule_mod.materialize_schedule_slots = lambda stored_slots, reference_time: []
    schedule_mod.normalize_schedule_document_for_registry = (
        lambda document, appliances_registry=None: document
    )
    schedule_mod.normalize_slot_patch_request = (
        lambda slot_patches, appliances_registry=None: slot_patches
    )
    schedule_mod.prune_expired_slots = (
        lambda stored_slots, reference_time: stored_slots
    )
    schedule_mod.read_schedule_control_config = lambda config: None
    schedule_mod.schedule_document_from_dict = (
        lambda raw_document: raw_document if raw_document is not None else ScheduleDocument()
    )
    schedule_mod.schedule_document_to_dict = lambda doc: {
        "executionEnabled": doc.execution_enabled,
        "slots": dict(doc.slots),
    }
    schedule_mod.slot_to_dict = lambda slot, runtime=None: {}
    schedule_mod.with_slot_set_by = lambda slot, set_by=None: slot
    schedule_mod.validate_slot_patch_request = (
        lambda slots, reference_time, battery_soc_bounds: None
    )
    sys.modules[schedule_mod.__name__] = schedule_mod

    runtime_status_mod = types.ModuleType(
        "custom_components.helman.scheduling.runtime_status"
    )
    runtime_status_mod.ScheduleExecutionStatus = type(
        "ScheduleExecutionStatus",
        (),
        {"active_slot_id": None, "active_slot_runtime": None},
    )
    runtime_status_mod.schedule_execution_status_to_dict = lambda execution_status: None
    sys.modules[runtime_status_mod.__name__] = runtime_status_mod

    action_resolution_mod = types.ModuleType(
        "custom_components.helman.scheduling.action_resolution"
    )

    def resolve_executed_schedule_action(*, action, current_soc):
        if (
            getattr(action, "kind", None) == "charge_to_target_soc"
            and current_soc is not None
            and getattr(action, "target_soc", None) is not None
            and current_soc >= action.target_soc
        ):
            return SimpleNamespace(
                executed_action=SimpleNamespace(
                    kind="stop_discharging",
                    target_soc=None,
                ),
                reason="target_soc_reached",
            )
        if (
            getattr(action, "kind", None) == "discharge_to_target_soc"
            and current_soc is not None
            and getattr(action, "target_soc", None) is not None
            and current_soc <= action.target_soc
        ):
            return SimpleNamespace(
                executed_action=SimpleNamespace(
                    kind="stop_charging",
                    target_soc=None,
                ),
                reason="target_soc_reached",
            )
        return SimpleNamespace(
            executed_action=SimpleNamespace(
                kind=getattr(action, "kind", None),
                target_soc=getattr(action, "target_soc", None),
            ),
            reason="scheduled",
        )

    action_resolution_mod.resolve_executed_schedule_action = (
        resolve_executed_schedule_action
    )
    sys.modules[action_resolution_mod.__name__] = action_resolution_mod

    schedule_executor_mod = types.ModuleType(
        "custom_components.helman.scheduling.schedule_executor"
    )
    schedule_executor_mod.ScheduleExecutor = type(
        "ScheduleExecutor",
        (),
        {"__init__": lambda self, hass, deps: None},
    )
    schedule_executor_mod.ScheduleExecutorDependencies = type(
        "ScheduleExecutorDependencies",
        (),
        {"__init__": lambda self, **kwargs: None},
    )
    sys.modules[schedule_executor_mod.__name__] = schedule_executor_mod

    storage_mod = types.ModuleType("custom_components.helman.storage")
    storage_mod.HelmanStorage = type("HelmanStorage", (), {})
    sys.modules[storage_mod.__name__] = storage_mod

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

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

    energy_pkg = sys.modules.get("homeassistant.components.energy")
    if energy_pkg is None:
        energy_pkg = types.ModuleType("homeassistant.components.energy")
        sys.modules["homeassistant.components.energy"] = energy_pkg

    energy_data_mod = sys.modules.get("homeassistant.components.energy.data")
    if energy_data_mod is None:
        energy_data_mod = types.ModuleType("homeassistant.components.energy.data")
        sys.modules["homeassistant.components.energy.data"] = energy_data_mod

    async def async_get_manager(hass):
        return types.SimpleNamespace(async_listen_updates=lambda callback: lambda: None)

    energy_data_mod.async_get_manager = async_get_manager

    helpers_pkg = sys.modules.get("homeassistant.helpers")
    if helpers_pkg is None:
        helpers_pkg = types.ModuleType("homeassistant.helpers")
        sys.modules["homeassistant.helpers"] = helpers_pkg

    event_mod = sys.modules.get("homeassistant.helpers.event")
    if event_mod is None:
        event_mod = types.ModuleType("homeassistant.helpers.event")
        sys.modules["homeassistant.helpers.event"] = event_mod
    event_mod.async_track_time_change = (
        lambda hass, callback, **kwargs: lambda: None
    )
    event_mod.async_track_time_interval = (
        lambda hass, callback, interval: lambda: None
    )

    entity_registry_mod = sys.modules.get("homeassistant.helpers.entity_registry")
    if entity_registry_mod is None:
        entity_registry_mod = types.ModuleType("homeassistant.helpers.entity_registry")
        sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.now = lambda: REFERENCE_TIME
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


_install_import_stubs()

import custom_components.helman.coordinator as coordinator_module  # noqa: E402
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman.scheduling.schedule import ScheduleDocument  # noqa: E402


def _cleanup_stubbed_modules() -> None:
    for module_name in (
        "custom_components",
        "custom_components.helman",
        "custom_components.helman.scheduling",
        "custom_components.helman.coordinator",
        "custom_components.helman.battery_capacity_forecast_builder",
        "custom_components.helman.consumption_forecast_builder",
        "custom_components.helman.forecast_builder",
        "custom_components.helman.tree_builder",
        "custom_components.helman.battery_state",
        "custom_components.helman.recorder_hourly_series",
        "custom_components.helman.scheduling.schedule",
        "custom_components.helman.scheduling.runtime_status",
        "custom_components.helman.scheduling.action_resolution",
        "custom_components.helman.scheduling.schedule_executor",
        "custom_components.helman.storage",
        "homeassistant",
        "homeassistant.core",
        "homeassistant.components",
        "homeassistant.components.energy",
        "homeassistant.components.energy.data",
        "homeassistant.helpers",
        "homeassistant.helpers.event",
        "homeassistant.helpers.entity_registry",
        "homeassistant.util",
        "homeassistant.util.dt",
    ):
        sys.modules.pop(module_name, None)


_cleanup_stubbed_modules()


def _make_solar_forecast() -> dict:
    return {
        "status": "available",
        "points": [
            {
                "timestamp": "2026-03-20T21:00:00+01:00",
                "value": 100.0,
            },
            {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "value": 125.0,
            },
        ],
    }


def _make_house_forecast(*, generated_at: str = "2026-03-20T21:05:00+01:00") -> dict:
    return {
        "status": "available",
        "generatedAt": generated_at,
    }


def _make_battery_forecast(
    *,
    started_at: str = "2026-03-20T21:07:00+01:00",
    current_soc: float = 50.0,
    current_remaining_energy_kwh: float = 5.0,
) -> dict:
    return {
        "status": "available",
        "startedAt": started_at,
        "currentSoc": current_soc,
        "currentRemainingEnergyKwh": current_remaining_energy_kwh,
        "series": [],
        "actualHistory": [],
    }


def _make_projection_plan() -> SimpleNamespace:
    return SimpleNamespace(
        generated_at=REFERENCE_TIME.isoformat(),
        appliances_by_id={},
        demand_points=(),
    )


def _make_schedule_action(kind: str, target_soc: int | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        inverter=SimpleNamespace(kind=kind, target_soc=target_soc),
        appliances={},
    )


def _make_schedule_document(
    *,
    execution_enabled: bool = False,
    slots: dict[str, SimpleNamespace] | None = None,
) -> ScheduleDocument:
    return ScheduleDocument(
        execution_enabled=execution_enabled,
        slots={} if slots is None else dict(slots),
    )


def _make_control_config(
    *,
    charge_to_target_soc_option: str | None = "charge_target",
    discharge_to_target_soc_option: str | None = "discharge_target",
    stop_export_option: str | None = "stop_export",
) -> SimpleNamespace:
    return SimpleNamespace(
        charge_to_target_soc_option=charge_to_target_soc_option,
        discharge_to_target_soc_option=discharge_to_target_soc_option,
        stop_export_option=stop_export_option,
    )


class CoordinatorBatteryForecastCacheTests(unittest.IsolatedAsyncioTestCase):
    def _make_coordinator(self) -> HelmanCoordinator:
        coordinator = object.__new__(HelmanCoordinator)
        coordinator._hass = object()
        coordinator._storage = SimpleNamespace(
            config={},
            schedule_document=_make_schedule_document(),
            async_save_schedule_document=AsyncMock(),
        )
        coordinator._active_config = {}
        coordinator._appliances_registry = coordinator_module.AppliancesRuntimeRegistry()
        coordinator._cached_battery_forecast = None
        coordinator._cached_battery_forecast_expires_at = None
        coordinator._cached_battery_forecast_house_generated_at = None
        coordinator._cached_battery_forecast_solar_signature = None
        coordinator._cached_battery_forecast_schedule_execution_enabled = None
        coordinator._cached_battery_forecast_schedule_signature = None
        coordinator._cached_battery_forecast_schedule_effective_signature = None
        coordinator._cached_appliance_projection_plan = None
        coordinator._cached_appliance_projection_expires_at = None
        coordinator._cached_appliance_projection_started_at = None
        coordinator._cached_appliance_projection_house_generated_at = None
        coordinator._cached_appliance_projection_solar_signature = None
        coordinator._cached_appliance_projection_schedule_signature = None
        coordinator._schedule_lock = asyncio.Lock()
        coordinator._build_battery_forecast_schedule_overlay = Mock(return_value=None)
        return coordinator

    def test_build_battery_forecast_schedule_document_filters_unconfigured_target_actions(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    60,
                ),
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config(charge_to_target_soc_option=None)
        )

        forecast_schedule_document = (
            coordinator._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            )
        )

        self.assertTrue(forecast_schedule_document.execution_enabled)
        self.assertEqual(
            forecast_schedule_document.slots,
            {
                "2026-03-20T21:30:00+01:00": schedule_document.slots[
                    "2026-03-20T21:30:00+01:00"
                ],
            },
        )

    def test_build_battery_forecast_schedule_document_keeps_unconfigured_stop_export(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_export"),
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config(stop_export_option=None)
        )

        forecast_schedule_document = (
            coordinator._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            )
        )

        self.assertTrue(forecast_schedule_document.execution_enabled)
        self.assertEqual(
            forecast_schedule_document.slots,
            {
                "2026-03-20T21:00:00+01:00": schedule_document.slots[
                    "2026-03-20T21:00:00+01:00"
                ],
                "2026-03-20T21:30:00+01:00": schedule_document.slots[
                    "2026-03-20T21:30:00+01:00"
                ],
            },
        )

    def test_build_battery_forecast_schedule_document_keeps_slots_without_control_config(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_export"),
                "2026-03-20T21:30:00+01:00": _make_schedule_action(
                    "discharge_to_target_soc",
                    20,
                ),
            },
        )
        coordinator._read_schedule_control_config = Mock(return_value=None)

        forecast_schedule_document = (
            coordinator._build_battery_forecast_schedule_document(
                schedule_document=schedule_document
            )
        )

        self.assertEqual(forecast_schedule_document, schedule_document)

    async def test_async_get_battery_forecast_reuses_cache_within_ttl(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast = build_mock

        first = await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        second = await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(first, second)
        build_mock.assert_awaited_once()

    async def test_async_get_battery_forecast_rebuilds_after_ttl_expiry(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast = build_mock

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:13:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 2)

    async def test_async_get_battery_forecast_rebuilds_when_cached_started_at_is_missing(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        expected_forecast = _make_battery_forecast()
        build_mock = AsyncMock(return_value=expected_forecast)
        coordinator._build_battery_forecast = build_mock
        coordinator._cached_battery_forecast = _make_battery_forecast(started_at=None)
        coordinator._cached_battery_forecast_expires_at = datetime.fromisoformat(
            "2026-03-20T21:12:00+01:00"
        )
        coordinator._cached_battery_forecast_house_generated_at = _make_house_forecast()[
            "generatedAt"
        ]
        coordinator._cached_battery_forecast_solar_signature = (
            coordinator._build_battery_forecast_solar_signature(_make_solar_forecast())
        )
        coordinator._cached_battery_forecast_schedule_execution_enabled = False
        coordinator._cached_battery_forecast_schedule_signature = ()
        coordinator._cached_battery_forecast_schedule_effective_signature = None

        forecast = await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )

        self.assertEqual(forecast, expected_forecast)
        build_mock.assert_awaited_once()

    async def test_async_get_battery_forecast_rebuilds_when_house_snapshot_changes(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast = build_mock

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(generated_at="2026-03-20T21:05:00+01:00"),
            started_at=REFERENCE_TIME,
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(generated_at="2026-03-20T21:10:00+01:00"),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 2)

    async def test_invalidate_battery_forecast_cache_forces_rebuild(self) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast = build_mock

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._invalidate_battery_forecast_cache()
        self.assertIsNone(coordinator._cached_battery_forecast_schedule_execution_enabled)
        self.assertIsNone(coordinator._cached_battery_forecast_schedule_signature)
        self.assertIsNone(coordinator._cached_battery_forecast_schedule_effective_signature)
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 2)

    async def test_invalidate_battery_forecast_cache_also_clears_projection_cache(self) -> None:
        coordinator = self._make_coordinator()
        coordinator._cached_appliance_projection_plan = object()
        coordinator._cached_appliance_projection_expires_at = REFERENCE_TIME
        coordinator._cached_appliance_projection_started_at = REFERENCE_TIME
        coordinator._cached_appliance_projection_house_generated_at = "2026-03-20T21:05:00+01:00"
        coordinator._cached_appliance_projection_solar_signature = ("available", ())
        coordinator._cached_appliance_projection_schedule_signature = ()

        coordinator._invalidate_battery_forecast_cache()

        self.assertIsNone(coordinator._cached_appliance_projection_plan)
        self.assertIsNone(coordinator._cached_appliance_projection_expires_at)
        self.assertIsNone(coordinator._cached_appliance_projection_started_at)
        self.assertIsNone(coordinator._cached_appliance_projection_house_generated_at)
        self.assertIsNone(coordinator._cached_appliance_projection_solar_signature)
        self.assertIsNone(coordinator._cached_appliance_projection_schedule_signature)

    async def test_async_get_appliance_projection_plan_reuses_cache_for_same_started_at(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        plan = _make_projection_plan()
        battery_forecast = _make_battery_forecast()
        coordinator._build_battery_forecast = AsyncMock(return_value=battery_forecast)

        with (
            patch.object(
                coordinator_module,
                "build_projection_input_bundle",
                return_value=object(),
            ) as build_input_bundle,
            patch.object(
                coordinator_module,
                "build_appliance_projection_plan",
                return_value=plan,
            ) as build_plan,
        ):
            first = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            second = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )

        self.assertIs(first, plan)
        self.assertIs(second, plan)
        build_input_bundle.assert_called_once()
        build_plan.assert_called_once_with(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=coordinator._appliances_registry,
            schedule_document=_make_schedule_document(),
            inputs=build_input_bundle.return_value,
            hass=coordinator._hass,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={},
        )
        coordinator._build_battery_forecast.assert_awaited_once()

    async def test_async_get_appliance_projection_plan_reuses_shared_pipeline_within_slot(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        first_plan = _make_projection_plan()
        coordinator._build_battery_forecast = AsyncMock(return_value=_make_battery_forecast())

        with (
            patch.object(
                coordinator_module,
                "build_projection_input_bundle",
                return_value=object(),
            ) as build_input_bundle,
            patch.object(
                coordinator_module,
                "build_appliance_projection_plan",
                return_value=first_plan,
            ) as build_plan,
        ):
            first = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            second = await coordinator._async_get_appliance_projection_plan(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:08:00+01:00"),
            )

        self.assertIs(first, first_plan)
        self.assertIs(second, first_plan)
        self.assertEqual(build_input_bundle.call_count, 1)
        self.assertEqual(build_plan.call_count, 1)
        coordinator._build_battery_forecast.assert_awaited_once()

    async def test_async_get_battery_forecast_rebuilds_when_schedule_slots_change(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        overlay = object()
        coordinator._build_battery_forecast = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            }
        )

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            }
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 2)

    async def test_async_get_battery_forecast_reuses_cache_when_schedule_changes_but_execution_disabled(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        coordinator._build_battery_forecast = build_mock
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=False,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = _make_schedule_document(
            execution_enabled=False,
            slots={
                "2026-03-20T21:30:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 1)

    async def test_async_get_battery_forecast_rebuilds_when_schedule_execution_changes(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        overlay = object()
        first_schedule_document = _make_schedule_document(
            execution_enabled=False,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        second_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._build_battery_forecast = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            side_effect=lambda *, schedule_document, reference_time: (
                overlay if schedule_document.execution_enabled else None
            )
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = first_schedule_document

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = second_schedule_document
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 2)
        self.assertIsNone(build_mock.await_args_list[0].kwargs["schedule_overlay"])
        self.assertIs(build_mock.await_args_list[1].kwargs["schedule_overlay"], overlay)
        coordinator._build_battery_forecast_schedule_overlay.assert_called_once_with(
            schedule_document=second_schedule_document,
            reference_time=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

    async def test_async_get_battery_forecast_reuses_cache_with_matching_schedule_state(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(return_value=_make_battery_forecast())
        overlay = object()
        first_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        second_schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action("stop_charging"),
            },
        )
        coordinator._build_battery_forecast = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = first_schedule_document

        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=REFERENCE_TIME,
        )
        coordinator._storage.schedule_document = second_schedule_document
        await coordinator._async_get_battery_forecast(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
        )

        self.assertEqual(build_mock.await_count, 1)
        coordinator._build_battery_forecast_schedule_overlay.assert_called_once_with(
            schedule_document=first_schedule_document,
            reference_time=REFERENCE_TIME,
        )

    async def test_async_get_battery_forecast_rebuilds_when_active_target_effective_action_flips(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(
            side_effect=[
                _make_battery_forecast(
                    current_soc=49.4,
                    current_remaining_energy_kwh=5.0,
                ),
                _make_battery_forecast(
                    started_at="2026-03-20T21:11:00+01:00",
                    current_soc=50.2,
                    current_remaining_energy_kwh=5.05,
                ),
            ]
        )
        overlay = object()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )
        coordinator._build_battery_forecast = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=object(),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=[
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=50.2,
                        current_remaining_energy_kwh=5.05,
                    ),
                ],
            ),
        ):
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertEqual(build_mock.await_count, 2)

    async def test_async_get_battery_forecast_rebuilds_when_active_target_slot_remains_target(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        build_mock = AsyncMock(
            side_effect=[
                _make_battery_forecast(
                    current_soc=49.4,
                    current_remaining_energy_kwh=5.0,
                ),
                _make_battery_forecast(
                    started_at="2026-03-20T21:11:00+01:00",
                    current_soc=50.6,
                    current_remaining_energy_kwh=5.2,
                ),
            ]
        )
        overlay = object()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )
        coordinator._build_battery_forecast = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=object(),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=[
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=50.6,
                        current_remaining_energy_kwh=5.2,
                    ),
                ],
            ),
        ):
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertEqual(build_mock.await_count, 2)

    async def test_async_get_battery_forecast_reuses_cache_when_active_target_signature_matches(
        self,
    ) -> None:
        coordinator = self._make_coordinator()
        forecast = _make_battery_forecast(
            current_soc=49.4,
            current_remaining_energy_kwh=5.0,
        )
        build_mock = AsyncMock(return_value=forecast)
        overlay = object()
        schedule_document = _make_schedule_document(
            execution_enabled=True,
            slots={
                "2026-03-20T21:00:00+01:00": _make_schedule_action(
                    "charge_to_target_soc",
                    50,
                ),
            },
        )
        coordinator._build_battery_forecast = build_mock
        coordinator._build_battery_forecast_schedule_overlay = Mock(
            return_value=overlay
        )
        coordinator._read_schedule_control_config = Mock(
            return_value=_make_control_config()
        )
        coordinator._storage.schedule_document = schedule_document

        with (
            patch.object(
                coordinator_module,
                "read_battery_entity_config",
                return_value=object(),
            ),
            patch.object(
                coordinator_module,
                "read_battery_live_state",
                side_effect=[
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                    SimpleNamespace(
                        current_soc=49.4,
                        current_remaining_energy_kwh=5.0,
                    ),
                ],
            ),
        ):
            first = await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=REFERENCE_TIME,
            )
            second = await coordinator._async_get_battery_forecast(
                solar_forecast=_make_solar_forecast(),
                house_forecast=_make_house_forecast(),
                started_at=datetime.fromisoformat("2026-03-20T21:11:00+01:00"),
            )

        self.assertIs(first, forecast)
        self.assertIs(second, forecast)
        self.assertEqual(build_mock.await_count, 1)


if __name__ == "__main__":
    unittest.main()
