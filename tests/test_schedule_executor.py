from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:15:00+01:00"
AFTER_NEXT_SLOT_BOUNDARY = datetime.fromisoformat("2026-03-20T21:16:00+01:00")


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
from custom_components.helman.appliances.ev_charger import (  # noqa: E402
    EvChargerApplianceRuntime,
    EvVehicleRuntime,
)
from custom_components.helman.appliances.execution import AppliancesExecutor  # noqa: E402
from custom_components.helman.appliances.state import AppliancesRuntimeRegistry  # noqa: E402
from custom_components.helman.const import (  # noqa: E402
    SCHEDULE_ACTION_EMPTY,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from custom_components.helman.scheduling import (  # noqa: E402
    schedule_executor as schedule_executor_module,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleExecutionUnavailableError,
    ScheduleNotConfiguredError,
    build_controllable_actions,
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
        # When set, every call parks until the event fires -- a stalled or slow
        # service. ``entered`` fires once a call is parked.
        self.release: asyncio.Event | None = None
        self.entered = asyncio.Event()

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
        if self.release is not None:
            self.entered.set()
            await self.release.wait()


class FakeHass:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self.states = FakeStates(states)
        self.services = FakeServices()
        self.created_tasks = 0

    def async_create_background_task(self, coro, name):
        self.created_tasks += 1
        return asyncio.create_task(coro, name=name)


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
        stop_export_option="Stop Export",
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
        "Stop Export",
    ]


def _build_executor(
    *,
    entity_id: str,
    state: FakeState | None,
    document: ScheduleDocument,
    control_config: ScheduleControlConfig | None = None,
    battery_state: BatteryLiveState | None = None,
    check_reality_and_maybe_replan=None,
    registry: AppliancesRuntimeRegistry | None = None,
    extra_states: dict[str, FakeState] | None = None,
    now=None,
) -> tuple[ScheduleExecutor, FakeHass, FakeScheduleStore]:
    states = {} if state is None else {entity_id: state}
    states.update(extra_states or {})
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
            read_appliances_registry=lambda: registry or AppliancesRuntimeRegistry(),
            check_reality_and_maybe_replan=check_reality_and_maybe_replan,
        ),
        now=now,
    )
    return executor, hass, store


def _build_ev_registry() -> AppliancesRuntimeRegistry:
    return AppliancesRuntimeRegistry.from_appliances(
        [
            EvChargerApplianceRuntime(
                id="garage-ev",
                name="Garage EV",
                max_charging_power_kw=11.0,
                charge_entity_id="switch.ev_charge",
                use_mode_entity_id="select.ev_use_mode",
                eco_gear_entity_id="select.ev_eco_gear",
                use_mode_configs=(),
                eco_gear_configs=(),
                vehicles=(
                    EvVehicleRuntime(
                        id="kona",
                        name="Kona",
                        soc_entity_id="sensor.kona_soc",
                        charge_limit_entity_id=None,
                        battery_capacity_kwh=64.0,
                        max_charging_power_kw=11.0,
                    ),
                ),
            )
        ]
    )


async def _start_with_captured_ticks(executor: ScheduleExecutor) -> list:
    """Start the executor with its interval captured, so a test fires ticks."""
    ticks: list = []
    with patch.object(
        schedule_executor_module,
        "async_track_time_interval",
        side_effect=lambda hass, cb, interval: ticks.append(cb) or (lambda: None),
    ):
        await executor.async_start()
    return ticks


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

    async def test_reconcile_touches_nothing_while_execution_is_disabled(self) -> None:
        # The restart-while-disabled guarantee: a plan is present and the
        # executor keeps ticking, but no service call is ever made.
        check = AsyncMock(return_value=False)
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Stop Charging",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=False,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
            check_reality_and_maybe_replan=check,
        )

        for _ in range(3):
            await executor.async_reconcile(
                reason="interval", reference_time=REFERENCE_TIME
            )

        self.assertEqual(hass.services.calls, [])
        self.assertIsNone(executor.runtime.last_applied_option)
        # The reality check still runs, so the plan stays in sync with reality.
        self.assertEqual(check.await_count, 3)

    async def test_reconcile_defers_when_reality_check_requests_replan(self) -> None:
        check = AsyncMock(return_value=True)
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
            check_reality_and_maybe_replan=check,
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        # Reality check deferred: a re-plan was triggered, nothing executed.
        check.assert_awaited_once()
        self.assertEqual(hass.services.calls, [])

    async def test_reconcile_executes_when_reality_check_allows(self) -> None:
        check = AsyncMock(return_value=False)
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
            check_reality_and_maybe_replan=check,
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        check.assert_awaited_once()
        self.assertEqual(executor.runtime.last_applied_option, "Stop Charging")

    async def test_reconcile_skips_candidate_inverter_action(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_CHARGING,
                        set_by="automation",
                        condition_met=False,
                    )
                },
            ),
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        # Candidate action is stripped from the committed view -> not applied.
        self.assertEqual(hass.services.calls, [])
        self.assertEqual(
            executor.runtime.last_applied_action.kind, SCHEDULE_ACTION_EMPTY
        )

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

    async def test_reconcile_uses_select_service_for_stop_export(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="select.mode",
            state=FakeState(
                "Normal",
                options=["Normal", "Stop Charging", "Stop Discharging", "Stop Export"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_EXPORT)},
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
                        "option": "Stop Export",
                    },
                    True,
                )
            ],
        )
        self.assertEqual(executor.runtime.last_applied_option, "Stop Export")

    async def test_reconcile_leaves_implicit_empty_slot_untouched(self) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Stop Charging",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(execution_enabled=True, slots={}),
            control_config=None,
        )

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(hass.services.calls, [])
        self.assertEqual(executor.runtime.last_applied_action.kind, SCHEDULE_ACTION_EMPTY)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_id,
            CURRENT_SLOT_ID,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.executed_action.kind,
            SCHEDULE_ACTION_EMPTY,
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.inverter.action_kind,
            "noop",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.inverter.outcome,
            "skipped",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.status,
            "applied",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.reason,
            "scheduled",
        )

    async def test_reconcile_restores_normal_when_empty_slot_follows_override(
        self,
    ) -> None:
        executor, hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Stop Charging",
                options=["Normal", "Stop Charging", "Stop Discharging"],
            ),
            document=ScheduleDocument(execution_enabled=True, slots={}),
        )
        executor.runtime.last_applied_action = ScheduleAction(
            kind=SCHEDULE_ACTION_STOP_CHARGING
        )
        executor.runtime.last_active_slot_id = "2026-03-20T20:30:00+01:00"
        executor.runtime.last_runtime_action_kind = "apply"

        await executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)

        self.assertEqual(hass.services.calls[0][2]["option"], "Normal")
        self.assertEqual(executor.runtime.last_applied_action.kind, SCHEDULE_ACTION_NORMAL)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.inverter.action_kind,
            "slot_stop",
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.executed_action.kind,
            SCHEDULE_ACTION_NORMAL,
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

    async def test_reconcile_raises_when_stop_export_option_is_missing(self) -> None:
        executor, _hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=FakeState(
                "Normal",
                options=["Normal", "Stop Charging", "Stop Discharging", "Stop Export"],
            ),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_EXPORT)},
            ),
            control_config=ScheduleControlConfig(
                mode_entity_id="input_select.mode",
                normal_option="Normal",
                charge_to_target_soc_option="Charge To Target",
                discharge_to_target_soc_option="Discharge To Target",
                stop_charging_option="Stop Charging",
                stop_discharging_option="Stop Discharging",
                stop_export_option=None,
            ),
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

    async def test_reconcile_raises_when_mode_entity_is_missing(self) -> None:
        executor, _hass, _store = _build_executor(
            entity_id="input_select.mode",
            state=None,
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
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

    async def test_background_request_logs_failures_instead_of_raising(self) -> None:
        hass = FakeHass(
            {
                "input_select.mode": FakeState(
                    "Normal",
                    options=["Normal", "Stop Charging", "Stop Discharging"],
                )
            }
        )
        store = FakeScheduleStore(
            ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            )
        )
        executor = ScheduleExecutor(
            hass,
            ScheduleExecutorDependencies(
                schedule_lock=asyncio.Lock(),
                load_schedule_document=store.load,
                save_schedule_document=store.save,
                read_schedule_control_config=lambda: None,
                read_battery_state=lambda: None,
                read_appliances_registry=lambda: AppliancesRuntimeRegistry(),
            ),
            now=lambda: REFERENCE_TIME,
        )

        await _start_with_captured_ticks(executor)
        with self.assertLogs(
            "custom_components.helman.scheduling.schedule_executor",
            level="WARNING",
        ) as captured:
            executor.request_reconcile(reason="test")
            await executor._worker_task

        self.assertEqual(hass.services.calls, [])
        self.assertIsNotNone(executor.runtime.last_error)
        self.assertEqual(len(captured.output), 1)
        self.assertIn("during test", captured.output[0])
        self.assertIn("active_slot_id=", captured.output[0])
        self.assertIn("not_configured", captured.output[0])
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


class ScheduleExecutorConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    """Slow or stalled hardware must not block reads, saves or the queue."""

    async def asyncTearDown(self) -> None:
        executor = getattr(self, "_executor", None)
        if executor is not None:
            await executor.async_unload()

    def _build(self, **kwargs) -> tuple[ScheduleExecutor, FakeHass, FakeScheduleStore]:
        kwargs.setdefault("entity_id", "input_select.mode")
        kwargs.setdefault(
            "state", FakeState("Normal", options=_build_mode_options())
        )
        executor, hass, store = _build_executor(**kwargs)
        self._executor = executor
        return executor, hass, store

    @staticmethod
    async def _wait(awaitable) -> None:
        await asyncio.wait_for(awaitable, timeout=1)

    async def _assert_schedule_lock_is_free(
        self, executor: ScheduleExecutor, store: FakeScheduleStore
    ) -> None:
        lock = executor._dependencies.schedule_lock
        self.assertFalse(lock.locked())
        # A read and a save both get through while the hardware call is parked.
        async with asyncio.timeout(1):
            async with lock:
                document = store.load()
                await store.save(document)

    async def test_reads_and_saves_proceed_while_reconcile_hardware_is_blocked(
        self,
    ) -> None:
        executor, hass, store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
        )
        hass.services.release = asyncio.Event()

        attempt = asyncio.create_task(
            executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)
        )
        await self._wait(hass.services.entered.wait())

        await self._assert_schedule_lock_is_free(executor, store)

        hass.services.release.set()
        await self._wait(attempt)
        self.assertEqual(executor.runtime.last_applied_option, "Stop Charging")

    async def test_restore_releases_the_schedule_lock_and_serializes_with_reconcile(
        self,
    ) -> None:
        executor, hass, store = self._build(
            state=FakeState("Stop Charging", options=_build_mode_options()),
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(
                        kind=SCHEDULE_ACTION_STOP_DISCHARGING
                    )
                },
            ),
            now=lambda: REFERENCE_TIME,
        )
        hass.services.release = asyncio.Event()

        restore = asyncio.create_task(executor.async_restore_normal(reason="test"))
        await self._wait(hass.services.entered.wait())
        await self._assert_schedule_lock_is_free(executor, store)

        reconcile = asyncio.create_task(
            executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)
        )
        for _ in range(5):
            await asyncio.sleep(0)
        # The reconcile waits for the restore's hardware command to finish.
        self.assertEqual(len(hass.services.calls), 1)

        hass.services.release.set()
        await self._wait(asyncio.gather(restore, reconcile))
        self.assertEqual(
            [call[2]["option"] for call in hass.services.calls],
            ["Normal", "Stop Discharging"],
        )

    async def test_requests_coalesce_while_a_service_call_is_stalled(self) -> None:
        check = AsyncMock(return_value=False)
        executor, hass, _store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
            check_reality_and_maybe_replan=check,
            now=lambda: REFERENCE_TIME,
        )
        hass.services.release = asyncio.Event()
        ticks = await _start_with_captured_ticks(executor)

        executor.request_reconcile(reason="startup")
        await self._wait(hass.services.entered.wait())
        for _ in range(5):
            ticks[0](REFERENCE_TIME)
        for _ in range(3):
            executor.request_reconcile(reason="schedule_updated")
        enable = asyncio.create_task(
            executor.async_reconcile_and_wait(reason="enable_request")
        )
        await asyncio.sleep(0)

        # One running attempt, one merged follow-up; no task per request.
        self.assertEqual(hass.created_tasks, 1)
        self.assertEqual(len(hass.services.calls), 1)
        self.assertIsNotNone(executor._pending_request)
        self.assertEqual(len(executor._pending_request.waiters), 1)

        hass.services.release.set()
        await self._wait(enable)
        await self._wait(executor._worker_task)

        self.assertEqual(check.await_count, 2)
        self.assertIsNone(executor._pending_request)

    async def test_failure_is_logged_when_every_waiter_has_gone(self) -> None:
        executor, hass, _store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
            now=lambda: REFERENCE_TIME,
        )
        # The service stalls until the actuator's bound expires.
        hass.services.release = asyncio.Event()
        executor._actuator._service_call_timeout_seconds = 0.05
        await _start_with_captured_ticks(executor)
        with self.assertLogs(
            "custom_components.helman.scheduling.schedule_executor", level="WARNING"
        ) as captured:
            waiter = asyncio.create_task(
                executor.async_reconcile_and_wait(reason="enable_request")
            )
            await self._wait(hass.services.entered.wait())
            # The caller goes away (a websocket client disconnecting).
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
            await self._wait(executor._worker_task)

        self.assertIn("enable_request", captured.output[0])

    async def test_requests_coalesce_while_an_ev_never_turns_on_then_retry_succeeds(
        self,
    ) -> None:
        executor, hass, _store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: build_controllable_actions(
                        appliances={"garage-ev": {"charge": True, "vehicleId": "kona"}}
                    )
                },
            ),
            registry=_build_ev_registry(),
            extra_states={"switch.ev_charge": FakeState("off", options=[])},
            now=lambda: REFERENCE_TIME,
        )
        polling = asyncio.Event()
        stop_polling = asyncio.Event()

        async def _gated_sleep(_delay: float) -> None:
            polling.set()
            await stop_polling.wait()
            await asyncio.sleep(0)

        executor._appliances_executor = AppliancesExecutor(
            executor._actuator,
            charge_on_wait_seconds=0.01,
            sleep=_gated_sleep,
        )
        ticks = await _start_with_captured_ticks(executor)

        executor.request_reconcile(reason="startup")
        await self._wait(polling.wait())
        for _ in range(5):
            ticks[0](REFERENCE_TIME)
            executor.request_reconcile(reason="schedule_updated")

        self.assertEqual(hass.created_tasks, 1)
        self.assertIsNotNone(executor._pending_request)

        with self.assertLogs(
            "custom_components.helman.scheduling.schedule_executor",
            level="WARNING",
        ):
            stop_polling.set()
            await self._wait(executor._worker_task)

        # The first attempt and the one merged follow-up both retried turn_on:
        # a failed apply keeps no memory, so it stays retryable.
        self.assertEqual(
            [call[:2] for call in hass.services.calls],
            [("switch", "turn_on"), ("switch", "turn_on")],
        )
        runtime = executor.runtime.execution_status.active_slot_runtime
        self.assertEqual(runtime.appliances["garage-ev"].outcome, "failed")
        self.assertIn(
            "Timed out waiting for EV charge entity",
            runtime.appliances["garage-ev"].message,
        )
        self.assertNotIn("garage-ev", executor.runtime.appliance_memories)

        # The charger comes up; the next request succeeds and is remembered.
        hass.states._states["switch.ev_charge"].state = "on"
        executor.request_reconcile(reason="interval")
        await self._wait(executor._worker_task)

        self.assertIn("garage-ev", executor.runtime.appliance_memories)
        self.assertEqual(
            executor.runtime.execution_status.active_slot_runtime.appliances[
                "garage-ev"
            ].outcome,
            "success",
        )

    async def test_follow_up_applies_the_slot_current_when_it_starts(self) -> None:
        clock = [REFERENCE_TIME]
        executor, hass, store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
            now=lambda: clock[0],
        )
        hass.services.release = asyncio.Event()
        await _start_with_captured_ticks(executor)

        executor.request_reconcile(reason="startup")
        await self._wait(hass.services.entered.wait())
        # A schedule edit lands while the attempt is blocked, and a follow-up is
        # queued before the slot boundary.
        async with executor._dependencies.schedule_lock:
            await store.save(
                ScheduleDocument(
                    execution_enabled=True,
                    slots={
                        CURRENT_SLOT_ID: ScheduleAction(
                            kind=SCHEDULE_ACTION_STOP_CHARGING
                        ),
                        NEXT_SLOT_ID: ScheduleAction(
                            kind=SCHEDULE_ACTION_STOP_DISCHARGING
                        ),
                    },
                )
            )
        executor.request_reconcile(reason="schedule_updated")
        clock[0] = AFTER_NEXT_SLOT_BOUNDARY

        hass.services.release.set()
        await self._wait(executor._worker_task)

        self.assertEqual(
            [call[2]["option"] for call in hass.services.calls],
            ["Stop Charging", "Stop Discharging"],
        )
        self.assertEqual(
            executor.runtime.execution_status.active_slot_id,
            NEXT_SLOT_ID,
        )

    async def test_disabling_mid_attempt_suppresses_the_remaining_writes(
        self,
    ) -> None:
        executor, hass, store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: build_controllable_actions(
                        inverter=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                        appliances={"garage-ev": {"charge": True, "vehicleId": "kona"}},
                    )
                },
            ),
            registry=_build_ev_registry(),
            extra_states={"switch.ev_charge": FakeState("off", options=[])},
        )
        hass.services.release = asyncio.Event()

        attempt = asyncio.create_task(
            executor.async_reconcile(reason="test", reference_time=REFERENCE_TIME)
        )
        await self._wait(hass.services.entered.wait())
        await store.save(
            ScheduleDocument(execution_enabled=False, slots=store.document.slots)
        )
        hass.services.release.set()

        with self.assertRaises(ScheduleExecutionUnavailableError):
            await self._wait(attempt)
        # The inverter write was already in flight; the EV write after it hit
        # the closed gate.
        self.assertEqual(
            [call[:2] for call in hass.services.calls],
            [("input_select", "select_option")],
        )

    async def test_waiting_request_raises_the_attempt_error_without_logging(
        self,
    ) -> None:
        executor, _hass, _store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
            now=lambda: REFERENCE_TIME,
        )
        executor._dependencies = ScheduleExecutorDependencies(
            **{
                **executor._dependencies.__dict__,
                "read_schedule_control_config": lambda: None,
            }
        )
        await _start_with_captured_ticks(executor)

        with self.assertNoLogs(
            "custom_components.helman.scheduling.schedule_executor",
            level="WARNING",
        ):
            with self.assertRaises(ScheduleNotConfiguredError):
                await self._wait(
                    executor.async_reconcile_and_wait(reason="enable_request")
                )

    async def test_unload_cancels_the_worker_and_pending_follow_up(self) -> None:
        executor, hass, _store = self._build(
            document=ScheduleDocument(
                execution_enabled=True,
                slots={
                    CURRENT_SLOT_ID: ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING)
                },
            ),
            now=lambda: REFERENCE_TIME,
        )
        hass.services.release = asyncio.Event()
        unsubscribed: list[bool] = []
        with patch.object(
            schedule_executor_module,
            "async_track_time_interval",
            side_effect=lambda hass, cb, interval: lambda: unsubscribed.append(True),
        ) as track_interval:
            await executor.async_start()
            executor.request_reconcile(reason="startup")
            await self._wait(hass.services.entered.wait())
            worker = executor._worker_task
            waiter = asyncio.create_task(
                executor.async_reconcile_and_wait(reason="enable_request")
            )
            await asyncio.sleep(0)

            await executor.async_unload()

            self.assertTrue(worker.cancelled())
            self.assertIsNone(executor._worker_task)
            self.assertIsNone(executor._pending_request)
            self.assertEqual(unsubscribed, [True])
            # Not a cancellation of the caller: a reconcile that never ran.
            with self.assertRaisesRegex(ScheduleExecutionUnavailableError, "stopped"):
                await waiter

            # A startup callback racing the unload cannot bring the interval
            # back, and requests after unload start nothing.
            await executor.async_start()
            executor.request_reconcile(reason="interval")
            self.assertEqual(track_interval.call_count, 1)
            self.assertEqual(hass.created_tasks, 1)


if __name__ == "__main__":
    unittest.main()
