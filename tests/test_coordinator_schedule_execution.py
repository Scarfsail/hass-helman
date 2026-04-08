from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"


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

    try:
        import homeassistant.components.energy.data  # type: ignore  # noqa: F401
        import homeassistant.core  # type: ignore  # noqa: F401
        import homeassistant.helpers.event  # type: ignore  # noqa: F401
        import homeassistant.helpers.storage  # type: ignore  # noqa: F401
        import homeassistant.util.dt  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
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
            return types.SimpleNamespace(
                async_listen_updates=lambda callback: lambda: None
            )

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
        event_mod.async_track_time_change = (
            lambda hass, callback, **kwargs: lambda: None
        )
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


_install_import_stubs()

from custom_components.helman.const import (  # noqa: E402
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_SLOT_MINUTES,
)
from custom_components.helman.appliances import build_appliances_runtime_registry  # noqa: E402
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleActionError,
    ScheduleDocument,
    ScheduleExecutionUnavailableError,
    ScheduleSlot,
)
from custom_components.helman.scheduling.runtime_status import (  # noqa: E402
    ActiveSlotRuntimeStatus,
    ScheduleExecutionStatus,
)


def _domains_payload(kind: str, target_soc: int | None = None) -> dict:
    inverter = {"kind": kind}
    if target_soc is not None:
        inverter["targetSoc"] = target_soc
    return {
        "inverter": inverter,
        "appliances": {},
    }


def _valid_appliances_config() -> dict:
    return {
        "appliances": [
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "Garage EV",
                "limits": {"max_charging_power_kw": 11.0},
                "controls": {
                    "charge": {
                        "entity_id": "switch.ev_nabijeni",
                    },
                    "use_mode": {
                        "entity_id": "select.solax_ev_charger_charger_use_mode",
                        "values": {
                            "Fast": {"behavior": "fixed_max_power"},
                            "ECO": {"behavior": "surplus_aware"},
                        },
                    },
                    "eco_gear": {
                        "entity_id": "select.solax_ev_charger_eco_gear",
                        "values": {
                            "6A": {"min_power_kw": 1.4},
                        },
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {
                            "soc_entity_id": "sensor.kona_ev_battery_level",
                        },
                        "limits": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    }
                ],
            }
        ]
    }


def _valid_climate_config() -> dict:
    return {
        "appliances": [
            {
                "kind": "climate",
                "id": "living-room-hvac",
                "name": "Living Room HVAC",
                "controls": {
                    "climate": {
                        "entity_id": "climate.living_room",
                    }
                },
                "projection": {
                    "strategy": "fixed",
                    "hourly_energy_kwh": 1.5,
                },
            }
        ]
    }


def _cleanup_stubbed_modules() -> None:
    for module_name in (
        "custom_components",
        "custom_components.helman",
        "custom_components.helman.appliances",
        "custom_components.helman.scheduling",
        "custom_components.helman.coordinator",
        "custom_components.helman.battery_capacity_forecast_builder",
        "custom_components.helman.consumption_forecast_builder",
        "custom_components.helman.forecast_builder",
        "custom_components.helman.tree_builder",
        "homeassistant",
        "homeassistant.core",
        "homeassistant.components",
        "homeassistant.components.recorder",
        "homeassistant.components.recorder.history",
        "homeassistant.components.energy",
        "homeassistant.components.energy.data",
        "homeassistant.helpers",
        "homeassistant.helpers.event",
        "homeassistant.helpers.storage",
        "homeassistant.helpers.entity_registry",
        "homeassistant.util",
        "homeassistant.util.dt",
    ):
        sys.modules.pop(module_name, None)


_cleanup_stubbed_modules()


class FakeState:
    def __init__(self, state: str, *, attributes: dict | None = None) -> None:
        self.state = state
        self.attributes = attributes or {}


class FakeStates:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states

    def get(self, entity_id: str) -> FakeState | None:
        return self._states.get(entity_id)


class FakeHass:
    def __init__(self, states: dict[str, FakeState] | None = None) -> None:
        self.states = FakeStates(states or {})


class FakeStorage:
    def __init__(
        self,
        *,
        schedule_document: dict,
        config: dict | None = None,
        forecast_snapshot: dict | None = None,
    ) -> None:
        self.config = config or {}
        self.schedule_document = schedule_document
        self.forecast_snapshot = forecast_snapshot
        self.saved_schedule_documents: list[dict] = []

    async def async_save_schedule_document(self, schedule_document: dict) -> None:
        self.schedule_document = schedule_document
        self.saved_schedule_documents.append(schedule_document)


class FakeExecutor:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.start_calls = 0
        self.stop_calls = 0
        self.unload_calls = 0
        self.reset_runtime_calls = 0
        self.reconcile_calls: list[tuple[str, datetime | None]] = []
        self.safe_reconcile_calls: list[tuple[str, datetime | None]] = []
        self.restore_calls: list[str] = []
        self.reconcile_error: Exception | None = None
        self.restore_error: Exception | None = None
        self.execution_status = ScheduleExecutionStatus()
        self.get_status_calls = 0

    async def async_start(self) -> None:
        self.events.append("start")
        self.start_calls += 1

    async def async_stop(self) -> None:
        self.events.append("stop")
        self.stop_calls += 1

    async def async_unload(self) -> None:
        self.events.append("unload")
        self.unload_calls += 1

    async def async_reconcile(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        self.events.append(f"reconcile:{reason}")
        self.reconcile_calls.append((reason, reference_time))
        if self.reconcile_error is not None:
            raise self.reconcile_error

    async def async_reconcile_safely(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        self.events.append(f"safe_reconcile:{reason}")
        self.safe_reconcile_calls.append((reason, reference_time))

    async def async_restore_normal(self, *, reason: str) -> None:
        self.events.append(f"restore:{reason}")
        self.restore_calls.append(reason)
        if self.restore_error is not None:
            raise self.restore_error

    def get_execution_status(self) -> ScheduleExecutionStatus:
        self.events.append("get_execution_status")
        self.get_status_calls += 1
        return self.execution_status

    def reset_runtime(self) -> None:
        self.events.append("reset_runtime")
        self.reset_runtime_calls += 1

    def clear_appliance_memories(self) -> None:
        self.events.append("clear_appliance_memories")


class CoordinatorScheduleExecutionTests(unittest.IsolatedAsyncioTestCase):
    def _build_coordinator(
        self,
        *,
        schedule_document: dict,
        inject_slot_minutes: bool = True,
    ) -> tuple[HelmanCoordinator, FakeStorage, FakeExecutor]:
        persisted_schedule_document = dict(schedule_document)
        if inject_slot_minutes and "slotMinutes" not in persisted_schedule_document:
            persisted_schedule_document["slotMinutes"] = SCHEDULE_SLOT_MINUTES

        storage = FakeStorage(schedule_document=persisted_schedule_document)
        coordinator = HelmanCoordinator(FakeHass(), storage)
        executor = FakeExecutor()
        coordinator._schedule_executor = executor
        return coordinator, storage, executor

    async def test_normalize_schedule_document_resets_legacy_schedule_without_slot_minutes(
        self,
    ) -> None:
        coordinator, storage, _ = self._build_coordinator(
            inject_slot_minutes=False,
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )

        await coordinator._async_normalize_schedule_document()

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )

    async def test_get_appliances_uses_live_climate_capabilities(self) -> None:
        storage = FakeStorage(
            schedule_document={
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
            config=_valid_climate_config(),
        )
        coordinator = HelmanCoordinator(
            FakeHass(
                {
                    "climate.living_room": FakeState(
                        "heat",
                        attributes={"hvac_modes": ["off", "heat"]},
                    )
                }
            ),
            storage,
        )
        coordinator._active_config = storage.config
        coordinator._appliances_registry = build_appliances_runtime_registry(storage.config)

        response = await coordinator.get_appliances()

        self.assertEqual(
            response["appliances"][0]["metadata"]["scheduleCapabilities"]["modes"],
            ["heat"],
        )

    async def test_set_schedule_rejects_climate_mode_missing_from_live_capabilities(
        self,
    ) -> None:
        storage = FakeStorage(
            schedule_document={
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
            config=_valid_climate_config(),
        )
        coordinator = HelmanCoordinator(
            FakeHass(
                {
                    "climate.living_room": FakeState(
                        "heat",
                        attributes={"hvac_modes": ["off", "heat"]},
                    )
                }
            ),
            storage,
        )
        coordinator._active_config = storage.config
        coordinator._appliances_registry = build_appliances_runtime_registry(storage.config)

        with self.assertRaises(ScheduleActionError):
            await coordinator.set_schedule(
                slots=[
                    ScheduleSlot(
                        id=CURRENT_SLOT_ID,
                        domains={
                            "inverter": {"kind": "normal"},
                            "appliances": {"living-room-hvac": {"mode": "cool"}},
                        },
                    )
                ],
                reference_time=REFERENCE_TIME,
            )

    async def test_normalize_schedule_document_resets_incompatible_slot_minutes(
        self,
    ) -> None:
        coordinator, storage, _ = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES * 2,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )

        with self.assertLogs("custom_components.helman.coordinator", level="WARNING"):
            await coordinator._async_normalize_schedule_document()

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )

    async def test_normalize_schedule_document_resets_invalid_persisted_schedule(
        self,
    ) -> None:
        coordinator, storage, _ = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slotMinutes": "bad",
                "slots": {},
            }
        )

        with self.assertLogs("custom_components.helman.coordinator", level="WARNING"):
            await coordinator._async_normalize_schedule_document()

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )

    async def test_normalize_schedule_document_prunes_stale_appliance_action(self) -> None:
        coordinator, storage, _ = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "normal"},
                        "appliances": {
                            "missing-ev": {
                                "charge": True,
                                "vehicleId": "ghost",
                                "useMode": "Fast",
                            }
                        },
                    }
                },
            }
        )

        coordinator._appliances_registry = build_appliances_runtime_registry(
            _valid_appliances_config()
        )

        await coordinator._async_normalize_schedule_document()

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )

    async def test_enable_persists_flag_and_reconciles(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )

        enabled = await coordinator.set_schedule_execution(
            enabled=True,
            reference_time=REFERENCE_TIME,
        )

        self.assertTrue(enabled)
        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            },
        )
        self.assertEqual(executor.events[:2], ["start", "reconcile:enable_request"])

    async def test_enable_invalidates_battery_forecast_cache(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )
        invalidate_cache = Mock()
        coordinator._invalidate_battery_forecast_cache = invalidate_cache

        await coordinator.set_schedule_execution(
            enabled=True,
            reference_time=REFERENCE_TIME,
        )

        invalidate_cache.assert_called_once_with()

    async def test_enable_failure_rolls_back_flag(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )
        executor.reconcile_error = ScheduleExecutionUnavailableError("boom")

        with self.assertLogs(
            "custom_components.helman.coordinator", level="WARNING"
        ) as captured:
            with self.assertRaises(ScheduleExecutionUnavailableError):
                await coordinator.set_schedule_execution(
                    enabled=True,
                    reference_time=REFERENCE_TIME,
                )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            },
        )
        self.assertEqual(
            executor.events,
            ["start", "reconcile:enable_request", "stop"],
        )
        self.assertEqual(len(captured.output), 1)
        self.assertIn("Failed to enable schedule execution", captured.output[0])
        self.assertIn("execution_unavailable", captured.output[0])

    async def test_enable_failure_while_already_enabled_logs_without_rollback(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )
        executor.reconcile_error = ScheduleExecutionUnavailableError("boom")

        with self.assertLogs(
            "custom_components.helman.coordinator", level="WARNING"
        ) as captured:
            with self.assertRaises(ScheduleExecutionUnavailableError):
                await coordinator.set_schedule_execution(
                    enabled=True,
                    reference_time=REFERENCE_TIME,
                )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            },
        )
        self.assertEqual(executor.events, ["start", "reconcile:enable_request"])
        self.assertEqual(len(captured.output), 1)
        self.assertIn(
            "Failed to reconcile already-enabled schedule execution",
            captured.output[0],
        )
        self.assertIn("execution_unavailable", captured.output[0])

    async def test_disable_restores_normal_before_persisting_false(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )

        enabled = await coordinator.set_schedule_execution(
            enabled=False,
            reference_time=REFERENCE_TIME,
        )

        self.assertFalse(enabled)
        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            },
        )
        self.assertEqual(
            executor.events,
            ["restore:disable_request", "stop"],
        )

    async def test_disable_invalidates_battery_forecast_cache(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )
        invalidate_cache = Mock()
        coordinator._invalidate_battery_forecast_cache = invalidate_cache

        await coordinator.set_schedule_execution(
            enabled=False,
            reference_time=REFERENCE_TIME,
        )

        invalidate_cache.assert_called_once_with()

    async def test_disable_failure_keeps_enabled_true(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            }
        )
        executor.restore_error = ScheduleExecutionUnavailableError("boom")

        with self.assertLogs(
            "custom_components.helman.coordinator", level="WARNING"
        ) as captured:
            with self.assertRaises(ScheduleExecutionUnavailableError):
                await coordinator.set_schedule_execution(
                    enabled=False,
                    reference_time=REFERENCE_TIME,
                )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            },
        )
        self.assertEqual(
            executor.events,
            [
                "restore:disable_request",
                "clear_appliance_memories",
                "start",
                "safe_reconcile:disable_restore_failed",
            ],
        )
        self.assertEqual(len(captured.output), 1)
        self.assertIn(
            "Failed to disable schedule execution while restoring normal mode",
            captured.output[0],
        )
        self.assertIn("execution_unavailable", captured.output[0])

    async def test_schedule_executor_battery_state_logs_detailed_issue_once(self) -> None:
        storage = FakeStorage(
            schedule_document={"executionEnabled": False, "slots": {}},
            config={
                "power_devices": {
                    "battery": {
                        "entities": {
                            "remaining_energy": "sensor.battery_remaining_energy",
                            "capacity": "sensor.battery_soc",
                            "min_soc": "sensor.battery_min_soc",
                            "max_soc": "sensor.battery_max_soc",
                        }
                    }
                }
            },
        )
        coordinator = HelmanCoordinator(
            FakeHass(
                {
                    "sensor.battery_remaining_energy": FakeState(
                        "5.0",
                        attributes={"unit_of_measurement": "kWh"},
                    ),
                    "sensor.battery_soc": FakeState("55"),
                    "sensor.battery_min_soc": FakeState("unknown"),
                    "sensor.battery_max_soc": FakeState("100"),
                }
            ),
            storage,
        )

        with self.assertLogs(
            "custom_components.helman.coordinator", level="WARNING"
        ) as captured:
            self.assertIsNone(coordinator._read_schedule_executor_battery_state())
            self.assertIsNone(coordinator._read_schedule_executor_battery_state())

        self.assertEqual(len(captured.output), 1)
        self.assertIn("sensor.battery_min_soc", captured.output[0])
        self.assertIn("'unknown'", captured.output[0])
        self.assertIn("Schedule execution battery state unavailable", captured.output[0])

    async def test_schedule_executor_control_config_logs_missing_fields_once(self) -> None:
        storage = FakeStorage(
            schedule_document={"executionEnabled": False, "slots": {}},
            config={},
        )
        coordinator = HelmanCoordinator(FakeHass(), storage)

        with self.assertLogs(
            "custom_components.helman.coordinator", level="WARNING"
        ) as captured:
            self.assertIsNone(coordinator._read_schedule_executor_control_config())
            self.assertIsNone(coordinator._read_schedule_executor_control_config())

        self.assertEqual(len(captured.output), 1)
        self.assertIn("scheduler.control.mode_entity_id", captured.output[0])
        self.assertIn(
            "scheduler.control.action_option_map.normal",
            captured.output[0],
        )

    async def test_set_schedule_reconciles_safely_when_execution_enabled(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                )
            ],
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": True,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload(SCHEDULE_ACTION_STOP_CHARGING),
                },
            },
        )
        self.assertEqual(
            executor.events,
            ["start", "safe_reconcile:schedule_updated"],
        )

    async def test_set_schedule_invalidates_battery_forecast_cache(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )
        invalidate_cache = Mock()
        coordinator._invalidate_battery_forecast_cache = invalidate_cache

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                )
            ],
            reference_time=REFERENCE_TIME,
        )

        invalidate_cache.assert_called_once_with()

    async def test_set_schedule_normalizes_appliance_actions_using_active_registry(
        self,
    ) -> None:
        coordinator, storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )
        coordinator._appliances_registry = build_appliances_runtime_registry(
            _valid_appliances_config()
        )

        await coordinator.set_schedule(
            slots=[
                ScheduleSlot(
                    id=CURRENT_SLOT_ID,
                    domains={
                        "inverter": {"kind": "normal"},
                        "appliances": {
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                                "ecoGear": "6A",
                            }
                        },
                    },
                )
            ],
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "normal"},
                        "appliances": {
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                            }
                        },
                    }
                },
            },
        )

    async def test_set_schedule_rejects_unknown_vehicle_in_active_registry(self) -> None:
        coordinator, _storage, _executor = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )
        coordinator._appliances_registry = build_appliances_runtime_registry(
            _valid_appliances_config()
        )

        with self.assertRaises(ScheduleActionError):
            await coordinator.set_schedule(
                slots=[
                    ScheduleSlot(
                        id=CURRENT_SLOT_ID,
                        domains={
                            "inverter": {"kind": "normal"},
                            "appliances": {
                                "garage-ev": {
                                    "charge": True,
                                    "vehicleId": "ghost",
                                    "useMode": "Fast",
                                }
                            },
                        },
                    )
                ],
                reference_time=REFERENCE_TIME,
            )

    async def test_get_schedule_prunes_stale_appliance_action_on_read(self) -> None:
        coordinator, storage, _executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "normal"},
                        "appliances": {
                            "missing-ev": {
                                "charge": True,
                                "vehicleId": "ghost",
                                "useMode": "Fast",
                            }
                        },
                    }
                },
            }
        )
        coordinator._appliances_registry = build_appliances_runtime_registry(
            _valid_appliances_config()
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)
        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )

        self.assertEqual(current_slot["domains"]["appliances"], {})
        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {},
            },
        )

    async def test_get_schedule_attaches_runtime_only_to_current_slot(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload("charge_to_target_soc", 80),
                },
            }
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus.from_inverter(
                action_kind="apply",
                outcome="success",
                executed_action=ScheduleAction(kind="stop_discharging"),
                reason="target_soc_reached",
                reconciled_at=CURRENT_SLOT_ID,
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        next_slot = schedule["slots"][1]

        self.assertEqual(current_slot["domains"]["inverter"]["kind"], "charge_to_target_soc")
        self.assertEqual(current_slot["domains"]["inverter"]["targetSoc"], 80)
        self.assertEqual(
            schedule["runtime"],
            {
                "activeSlotId": CURRENT_SLOT_ID,
                "reconciledAt": CURRENT_SLOT_ID,
                "inverter": {
                    "actionKind": "apply",
                    "outcome": "success",
                    "executedAction": {"kind": "stop_discharging"},
                    "reason": "target_soc_reached",
                },
                "appliances": {},
            },
        )
        self.assertNotEqual(next_slot["id"], CURRENT_SLOT_ID)
        self.assertNotIn("runtime", next_slot)
        self.assertEqual(executor.get_status_calls, 1)

    async def test_get_schedule_attaches_runtime_to_implicit_current_normal_slot(
        self,
    ) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus.from_inverter(
                action_kind="apply",
                outcome="success",
                executed_action=ScheduleAction(kind="normal"),
                reason="scheduled",
                reconciled_at=CURRENT_SLOT_ID,
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        self.assertEqual(current_slot["domains"]["inverter"]["kind"], "normal")
        self.assertEqual(
            schedule["runtime"],
            {
                "activeSlotId": CURRENT_SLOT_ID,
                "reconciledAt": CURRENT_SLOT_ID,
                "inverter": {
                    "actionKind": "apply",
                    "outcome": "success",
                    "executedAction": {"kind": "normal"},
                    "reason": "scheduled",
                },
                "appliances": {},
            },
        )

    async def test_get_schedule_omits_runtime_when_execution_disabled(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus.from_inverter(
                action_kind="apply",
                outcome="success",
                executed_action=ScheduleAction(kind="normal"),
                reason="scheduled",
                reconciled_at=CURRENT_SLOT_ID,
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        self.assertNotIn("runtime", current_slot)
        self.assertNotIn("runtime", schedule)
        self.assertEqual(executor.get_status_calls, 0)

    async def test_get_schedule_returns_error_runtime_for_current_slot(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: _domains_payload("charge_to_target_soc", 80),
                },
            }
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus.from_inverter(
                action_kind="apply",
                outcome="failed",
                error_code="execution_unavailable",
                reconciled_at=CURRENT_SLOT_ID,
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        self.assertEqual(current_slot["domains"]["inverter"]["kind"], "charge_to_target_soc")
        self.assertEqual(
            schedule["runtime"],
            {
                "activeSlotId": CURRENT_SLOT_ID,
                "reconciledAt": CURRENT_SLOT_ID,
                "inverter": {
                    "actionKind": "apply",
                    "outcome": "failed",
                    "errorCode": "execution_unavailable",
                },
                "appliances": {},
            },
        )



if __name__ == "__main__":
    unittest.main()
