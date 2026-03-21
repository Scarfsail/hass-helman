from __future__ import annotations

import asyncio
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

    try:
        import homeassistant.core  # type: ignore  # noqa: F401
        import homeassistant.helpers.event  # type: ignore  # noqa: F401
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

        helpers_pkg = sys.modules.get("homeassistant.helpers")
        if helpers_pkg is None:
            helpers_pkg = types.ModuleType("homeassistant.helpers")
            sys.modules["homeassistant.helpers"] = helpers_pkg

        event_mod = sys.modules.get("homeassistant.helpers.event")
        if event_mod is None:
            event_mod = types.ModuleType("homeassistant.helpers.event")
            sys.modules["homeassistant.helpers.event"] = event_mod
        event_mod.async_track_time_interval = (
            lambda hass, callback, interval: lambda: None
        )

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

from custom_components.helman.battery_state import BatteryLiveState  # noqa: E402
from custom_components.helman.const import (  # noqa: E402
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleExecutionUnavailableError,
    ScheduleNotConfiguredError,
)
from custom_components.helman.scheduling.schedule_executor import (  # noqa: E402
    ScheduleExecutor,
    ScheduleExecutorDependencies,
)


class FakeState:
    def __init__(self, state: str, *, options: list[str]) -> None:
        self.state = state
        self.attributes = {"options": options}


class FakeStates:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states

    def get(self, entity_id: str) -> FakeState | None:
        return self._states.get(entity_id)


class FakeServices:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict, bool]] = []
        self.error: Exception | None = None

    async def async_call(
        self,
        domain: str,
        service: str,
        data: dict,
        *,
        blocking: bool,
    ) -> None:
        if self.error is not None:
            raise self.error
        self.calls.append((domain, service, data, blocking))


class FakeHass:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self.states = FakeStates(states)
        self.services = FakeServices()

    def async_create_task(self, coro):
        return asyncio.create_task(coro)


class FakeScheduleStore:
    def __init__(self, document: ScheduleDocument) -> None:
        self.document = document
        self.saved_documents: list[ScheduleDocument] = []

    def load(self) -> ScheduleDocument:
        return self.document

    async def save(self, document: ScheduleDocument) -> None:
        self.document = document
        self.saved_documents.append(document)


def _build_control_config(entity_id: str) -> ScheduleControlConfig:
    return ScheduleControlConfig(
        mode_entity_id=entity_id,
        normal_option="Normal",
        charge_to_target_soc_option="Charge To Target",
        discharge_to_target_soc_option="Discharge To Target",
        stop_charging_option="Stop Charging",
        stop_discharging_option="Stop Discharging",
    )


def _build_battery_state(*, current_soc: float) -> BatteryLiveState:
    return BatteryLiveState(
        current_remaining_energy_kwh=5.0,
        current_soc=current_soc,
        min_soc=10.0,
        max_soc=100.0,
        nominal_capacity_kwh=10.0,
        min_energy_kwh=1.0,
        max_energy_kwh=10.0,
    )


def _build_mode_options() -> list[str]:
    return [
        "Normal",
        "Charge To Target",
        "Discharge To Target",
        "Stop Charging",
        "Stop Discharging",
    ]


def _build_executor(
    *,
    entity_id: str,
    state: FakeState | None,
    document: ScheduleDocument,
    control_config: ScheduleControlConfig | None = None,
    battery_state: BatteryLiveState | None = None,
) -> tuple[ScheduleExecutor, FakeHass, FakeScheduleStore]:
    states = {} if state is None else {entity_id: state}
    hass = FakeHass(states)
    store = FakeScheduleStore(document)
    executor = ScheduleExecutor(
        hass,
        ScheduleExecutorDependencies(
            schedule_lock=asyncio.Lock(),
            load_schedule_document=store.load,
            save_schedule_document=store.save,
            read_schedule_control_config=lambda: control_config
            or _build_control_config(entity_id),
            read_battery_state=lambda: battery_state,
        ),
    )
    return executor, hass, store


class ScheduleExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconcile_uses_input_select_service_for_stop_charging(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls,
            [
                (
                    "input_select",
                    "select_option",
                    {
                        "entity_id": "input_select.mode",
                        "option": "Stop Charging",
                    },
                    True,
                )
            ],
        )
        self.assertEqual(executor.runtime.last_applied_option, "Stop Charging")

    async def test_reconcile_uses_select_service_for_stop_discharging(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="select.mode",
            state=FakeState(
                "Normal",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_DISCHARGING
                    )
                },
            ),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls,
            [
                (
                    "select",
                    "select_option",
                    {
                        "entity_id": "select.mode",
                        "option": "Stop Discharging",
                    },
                    True,
                )
            ],
        )

    async def test_reconcile_restores_normal_for_implicit_slot(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Stop Charging",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(execution_enabled=True, slots={}),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls[0][2]["option"],
            "Normal",
        )
        self.assertEqual(executor.runtime.last_applied_action.kind, "normal")
        self.assertEqual(
            executor.runtime.execution_status.active_slot_id,
            CURRENT_SLOT_ID,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.executed_action.kind,
            "normal",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "scheduled",
        )

    async def test_reconcile_skips_idempotent_write(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Stop Charging",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(hass.services.calls, [])
        self.assertEqual(executor.runtime.last_applied_option, "Stop Charging")

    async def test_reconcile_executes_charge_target_option_when_target_not_reached(
        self,
    ) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=_build_mode_options(),
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
            battery_state=_build_battery_state(current_soc=72),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls[0][2]["option"],
            "Charge To Target",
        )
        self.assertEqual(
            executor.runtime.last_applied_action,
            ScheduleAction(
                kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                target_soc=80,
            ),
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "scheduled",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )

    async def test_reconcile_executes_stop_discharging_when_charge_target_reached(
        self,
    ) -> None:
        executor, hass, store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Charge To Target",
                options=_build_mode_options(),
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
            battery_state=_build_battery_state(current_soc=80),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls[0][2]["option"],
            "Stop Discharging",
        )
        self.assertEqual(executor.runtime.last_active_slot_id, CURRENT_SLOT_ID)
        self.assertEqual(
            executor.runtime.last_applied_action.kind,
            SCHEDULE_ACTION_STOP_DISCHARGING,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.executed_action.kind,
            SCHEDULE_ACTION_STOP_DISCHARGING,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "target_soc_reached",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )
        self.assertEqual(store.saved_documents, [])

    async def test_reconcile_executes_discharge_target_option_when_target_not_reached(
        self,
    ) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=_build_mode_options(),
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
                        target_soc=30,
                    )
                },
            ),
            battery_state=_build_battery_state(current_soc=40),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls[0][2]["option"],
            "Discharge To Target",
        )
        self.assertEqual(
            executor.runtime.last_applied_action,
            ScheduleAction(
                kind=SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
                target_soc=30,
            ),
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "scheduled",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )

    async def test_reconcile_executes_stop_charging_when_discharge_target_reached(
        self,
    ) -> None:
        executor, hass, store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Discharge To Target",
                options=_build_mode_options(),
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
                        target_soc=30,
                    )
                },
            ),
            battery_state=_build_battery_state(current_soc=30),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls[0][2]["option"],
            "Stop Charging",
        )
        self.assertEqual(
            executor.runtime.last_applied_action.kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.executed_action.kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "target_soc_reached",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )
        self.assertEqual(store.saved_documents, [])

    async def test_reconcile_raises_when_active_target_battery_state_is_unavailable(
        self,
    ) -> None:
        executor, _hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=_build_mode_options(),
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
        )

        with self.assertRaises(ScheduleExecutionUnavailableError):
            await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_id,
            CURRENT_SLOT_ID,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "error",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.error_code,
            "execution_unavailable",
        )

    async def test_reconcile_raises_when_target_option_is_missing_and_target_not_reached(
        self,
    ) -> None:
        executor, _hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=_build_mode_options(),
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
            control_config=ScheduleControlConfig(
                mode_entity_id="input_select.mode",
                normal_option="Normal",
                charge_to_target_soc_option=None,
                discharge_to_target_soc_option="Discharge To Target",
                stop_charging_option="Stop Charging",
                stop_discharging_option="Stop Discharging",
            ),
            battery_state=_build_battery_state(current_soc=70),
        )

        with self.assertRaises(ScheduleNotConfiguredError):
            await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "error",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.error_code,
            "not_configured",
        )

    async def test_reconcile_allows_missing_target_option_when_charge_target_reached(
        self,
    ) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Charge To Target",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                        target_soc=80,
                    )
                },
            ),
            control_config=ScheduleControlConfig(
                mode_entity_id="input_select.mode",
                normal_option="Normal",
                charge_to_target_soc_option=None,
                discharge_to_target_soc_option="Discharge To Target",
                stop_charging_option="Stop Charging",
                stop_discharging_option="Stop Discharging",
            ),
            battery_state=_build_battery_state(current_soc=80),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            hass.services.calls[0][2]["option"],
            "Stop Discharging",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )

    async def test_reconcile_raises_when_mode_entity_is_missing(self) -> None:
        executor, _hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=None,
            document=ScheduleDocument(execution_enabled=True, slots={}),
        )

        with self.assertRaises(ScheduleExecutionUnavailableError):
            await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "error",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.error_code,
            "execution_unavailable",
        )

    async def test_reconcile_records_error_status_when_mode_write_fails(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
        )
        hass.services.error = RuntimeError("boom")

        with self.assertRaises(ScheduleExecutionUnavailableError):
            await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(
            executor.runtime.execution_status.active_slot_id,
            CURRENT_SLOT_ID,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "error",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.executed_action.kind,
            SCHEDULE_ACTION_STOP_CHARGING,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "scheduled",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.error_code,
            "execution_unavailable",
        )

    async def test_safe_reconcile_swallow_errors_for_background_paths(self) -> None:
        hass = FakeHass(
            {
                "input_select.mode": FakeState(
                    "Normal",
                    options=["Normal", "Stop Charging", "Stop Discharging"],
                )
            }
        )
        store = FakeScheduleStore(ScheduleDocument(execution_enabled=True, slots={}))
        executor = ScheduleExecutor(
            hass,
            ScheduleExecutorDependencies(
                schedule_lock=asyncio.Lock(),
                load_schedule_document=store.load,
                save_schedule_document=store.save,
                read_schedule_control_config=lambda: None,
                read_battery_state=lambda: None,
            ),
        )

        await executor.async_reconcile_safely(
            reason="test",
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(hass.services.calls, [])
        self.assertIsNotNone(executor.runtime.last_error)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_id,
            CURRENT_SLOT_ID,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "error",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.error_code,
            "not_configured",
        )


if __name__ == "__main__":
    unittest.main()
