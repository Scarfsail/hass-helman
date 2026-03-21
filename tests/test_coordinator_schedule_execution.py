from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path


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
            return types.SimpleNamespace(
                async_listen_updates=lambda callback: lambda: None
            )

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

        dt_mod = sys.modules.get("homeassistant.util.dt")
        if dt_mod is None:
            dt_mod = types.ModuleType("homeassistant.util.dt")
            sys.modules["homeassistant.util.dt"] = dt_mod
        dt_mod.parse_datetime = datetime.fromisoformat
        dt_mod.as_local = lambda value: value
        dt_mod.now = lambda: REFERENCE_TIME
        util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.const import SCHEDULE_ACTION_STOP_CHARGING  # noqa: E402
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleDocument,
    ScheduleExecutionUnavailableError,
    ScheduleSlot,
)
from custom_components.helman.scheduling.runtime_status import (  # noqa: E402
    ActiveSlotRuntimeStatus,
    ScheduleExecutionStatus,
)


class FakeHass:
    pass


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


class CoordinatorScheduleExecutionTests(unittest.IsolatedAsyncioTestCase):
    def _build_coordinator(self, *, schedule_document: dict) -> tuple[HelmanCoordinator, FakeStorage, FakeExecutor]:
        storage = FakeStorage(schedule_document=schedule_document)
        coordinator = HelmanCoordinator(FakeHass(), storage)
        executor = FakeExecutor()
        coordinator._schedule_executor = executor
        return coordinator, storage, executor

    async def test_enable_persists_flag_and_reconciles(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
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
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            },
        )
        self.assertEqual(executor.events[:2], ["start", "reconcile:enable_request"])

    async def test_enable_failure_rolls_back_flag(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            }
        )
        executor.reconcile_error = ScheduleExecutionUnavailableError("boom")

        with self.assertRaises(ScheduleExecutionUnavailableError):
            await coordinator.set_schedule_execution(
                enabled=True,
                reference_time=REFERENCE_TIME,
            )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": False,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            },
        )
        self.assertEqual(
            executor.events,
            ["start", "reconcile:enable_request", "stop"],
        )

    async def test_disable_restores_normal_before_persisting_false(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
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
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            },
        )
        self.assertEqual(
            executor.events,
            ["stop", "restore:disable_request"],
        )

    async def test_disable_failure_keeps_enabled_true(self) -> None:
        coordinator, storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            }
        )
        executor.restore_error = ScheduleExecutionUnavailableError("boom")

        with self.assertRaises(ScheduleExecutionUnavailableError):
            await coordinator.set_schedule_execution(
                enabled=False,
                reference_time=REFERENCE_TIME,
            )

        self.assertEqual(
            storage.schedule_document,
            {
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            },
        )
        self.assertEqual(
            executor.events,
            [
                "stop",
                "restore:disable_request",
                "start",
                "safe_reconcile:disable_restore_failed",
            ],
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
                "slots": {
                    CURRENT_SLOT_ID: {"kind": SCHEDULE_ACTION_STOP_CHARGING},
                },
            },
        )
        self.assertEqual(
            executor.events,
            ["start", "safe_reconcile:schedule_updated"],
        )

    async def test_get_schedule_attaches_runtime_only_to_current_slot(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": "charge_to_target_soc", "targetSoc": 80},
                },
            }
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus(
                status="applied",
                executed_action=ScheduleAction(kind="stop_discharging"),
                reason="target_soc_reached",
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        next_slot = next(
            slot
            for slot in schedule["slots"]
            if slot["id"] == "2026-03-20T21:15:00+01:00"
        )

        self.assertEqual(current_slot["action"]["kind"], "charge_to_target_soc")
        self.assertEqual(current_slot["action"]["targetSoc"], 80)
        self.assertEqual(
            current_slot["runtime"],
            {
                "status": "applied",
                "executedAction": {"kind": "stop_discharging"},
                "reason": "target_soc_reached",
            },
        )
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
            active_slot_runtime=ActiveSlotRuntimeStatus(
                status="applied",
                executed_action=ScheduleAction(kind="normal"),
                reason="scheduled",
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        self.assertEqual(current_slot["action"]["kind"], "normal")
        self.assertEqual(
            current_slot["runtime"],
            {
                "status": "applied",
                "executedAction": {"kind": "normal"},
                "reason": "scheduled",
            },
        )

    async def test_get_schedule_omits_runtime_when_execution_disabled(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={"executionEnabled": False, "slots": {}}
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus(
                status="applied",
                executed_action=ScheduleAction(kind="normal"),
                reason="scheduled",
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        self.assertNotIn("runtime", current_slot)
        self.assertEqual(executor.get_status_calls, 0)

    async def test_get_schedule_returns_error_runtime_for_current_slot(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={
                "executionEnabled": True,
                "slots": {
                    CURRENT_SLOT_ID: {"kind": "charge_to_target_soc", "targetSoc": 80},
                },
            }
        )
        executor.execution_status = ScheduleExecutionStatus(
            active_slot_id=CURRENT_SLOT_ID,
            active_slot_runtime=ActiveSlotRuntimeStatus(
                status="error",
                error_code="execution_unavailable",
            ),
        )

        schedule = await coordinator.get_schedule(reference_time=REFERENCE_TIME)

        current_slot = next(
            slot for slot in schedule["slots"] if slot["id"] == CURRENT_SLOT_ID
        )
        self.assertEqual(
            current_slot["runtime"],
            {
                "status": "error",
                "errorCode": "execution_unavailable",
            },
        )

    async def test_config_save_reconciles_when_execution_enabled(self) -> None:
        coordinator, _storage, executor = self._build_coordinator(
            schedule_document={"executionEnabled": True, "slots": {}}
        )
        events: list[str] = []
        coordinator.invalidate_tree = lambda: events.append("tree")
        coordinator.invalidate_forecast = lambda: events.append("forecast")

        await coordinator.async_handle_config_saved()

        self.assertEqual(events, ["tree", "forecast"])
        self.assertEqual(
            executor.events,
            ["reset_runtime", "start", "safe_reconcile:config_saved"],
        )


if __name__ == "__main__":
    unittest.main()
