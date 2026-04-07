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

    try:
        import homeassistant.core  # type: ignore  # noqa: F401
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

from custom_components.helman.appliances.ev_charger import (  # noqa: E402
    EvChargerApplianceRuntime,
    EvChargerEcoGearRuntime,
    EvChargerUseModeRuntime,
    EvVehicleRuntime,
)
from custom_components.helman.appliances.generic_appliance import (  # noqa: E402
    GenericApplianceRuntime,
)
from custom_components.helman.appliances.execution import (  # noqa: E402
    ApplianceExecutionMemory,
    EvChargerExecutor,
    GenericApplianceExecutor,
)


class FakeState:
    def __init__(self, state: str, *, attributes: dict | None = None) -> None:
        self.state = state
        self.attributes = attributes or {}


class FakeStates:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states

    def get(self, entity_id: str) -> FakeState | None:
        return self._states.get(entity_id)


class FakeServices:
    def __init__(self, hass: "FakeHass") -> None:
        self._hass = hass
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
        entity_id = data["entity_id"]
        if domain == "switch" and service == "turn_on":
            if self._hass.auto_turn_on:
                self._hass.states._states[entity_id].state = "on"
        elif domain == "switch" and service == "turn_off":
            self._hass.states._states[entity_id].state = "off"
        elif service == "select_option":
            self._hass.states._states[entity_id].state = data["option"]


class FakeHass:
    def __init__(self, states: dict[str, FakeState], *, auto_turn_on: bool = True) -> None:
        self.states = FakeStates(states)
        self.auto_turn_on = auto_turn_on
        self.services = FakeServices(self)


def _build_appliance() -> EvChargerApplianceRuntime:
    return EvChargerApplianceRuntime(
        id="garage-ev",
        name="Garage EV",
        max_charging_power_kw=11.0,
        charge_entity_id="switch.ev_nabijeni",
        use_mode_entity_id="select.solax_ev_charger_charger_use_mode",
        eco_gear_entity_id="select.solax_ev_charger_eco_gear",
        use_mode_configs=(
            EvChargerUseModeRuntime(
                id="Fast",
                behavior="fixed_max_power",
            ),
            EvChargerUseModeRuntime(
                id="ECO",
                behavior="surplus_aware",
            ),
        ),
        eco_gear_configs=(
            EvChargerEcoGearRuntime(
                id="6A",
                min_power_kw=1.4,
            ),
            EvChargerEcoGearRuntime(
                id="10A",
                min_power_kw=2.3,
            ),
        ),
        vehicles=(
            EvVehicleRuntime(
                id="kona",
                name="Kona",
                soc_entity_id="sensor.kona_ev_battery_level",
                charge_limit_entity_id=None,
                battery_capacity_kwh=64.0,
                max_charging_power_kw=11.0,
            ),
        ),
    )


def _build_generic_appliance() -> GenericApplianceRuntime:
    return GenericApplianceRuntime(
        id="dishwasher",
        name="Dishwasher",
        switch_entity_id="switch.dishwasher",
        projection_strategy="fixed",
        hourly_energy_kwh=1.1,
        history_energy_entity_id=None,
    )


class ApplianceExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def test_charge_true_writes_charge_then_mode_then_eco(self) -> None:
        hass = FakeHass(
            {
                "switch.ev_nabijeni": FakeState("off"),
                "select.solax_ev_charger_charger_use_mode": FakeState(
                    "Stop",
                    attributes={"options": ["Stop", "Fast", "ECO"]},
                ),
                "select.solax_ev_charger_eco_gear": FakeState(
                    "6A",
                    attributes={"options": ["6A", "10A"]},
                ),
            }
        )
        executor = EvChargerExecutor(hass, charge_on_wait_seconds=1, sleep=asyncio.sleep)

        runtime, memory = await executor.async_execute(
            appliance=_build_appliance(),
            action={
                "charge": True,
                "vehicleId": "kona",
                "useMode": "ECO",
                "ecoGear": "10A",
            },
            memory=None,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            hass.services.calls,
            [
                ("switch", "turn_on", {"entity_id": "switch.ev_nabijeni"}, True),
                (
                    "select",
                    "select_option",
                    {
                        "entity_id": "select.solax_ev_charger_charger_use_mode",
                        "option": "ECO",
                    },
                    True,
                ),
                (
                    "select",
                    "select_option",
                    {
                        "entity_id": "select.solax_ev_charger_eco_gear",
                        "option": "10A",
                    },
                    True,
                ),
            ],
        )
        self.assertEqual(runtime.action_kind, "apply")
        self.assertEqual(runtime.outcome, "success")
        self.assertTrue(memory.last_enabled)

    async def test_charge_false_turns_off_only_charge_switch(self) -> None:
        hass = FakeHass(
            {
                "switch.ev_nabijeni": FakeState("on"),
                "select.solax_ev_charger_charger_use_mode": FakeState(
                    "ECO",
                    attributes={"options": ["Stop", "Fast", "ECO"]},
                ),
                "select.solax_ev_charger_eco_gear": FakeState(
                    "10A",
                    attributes={"options": ["6A", "10A"]},
                ),
            }
        )
        executor = EvChargerExecutor(hass)

        runtime, _memory = await executor.async_execute(
            appliance=_build_appliance(),
            action={"charge": False},
            memory=None,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            hass.services.calls,
            [("switch", "turn_off", {"entity_id": "switch.ev_nabijeni"}, True)],
        )
        self.assertEqual(runtime.action_kind, "apply")
        self.assertEqual(runtime.outcome, "success")

    async def test_missing_action_after_previous_charge_emits_slot_stop(self) -> None:
        hass = FakeHass(
            {
                "switch.ev_nabijeni": FakeState("on"),
                "select.solax_ev_charger_charger_use_mode": FakeState(
                    "ECO",
                    attributes={"options": ["Stop", "Fast", "ECO"]},
                ),
                "select.solax_ev_charger_eco_gear": FakeState(
                    "10A",
                    attributes={"options": ["6A", "10A"]},
                ),
            }
        )
        executor = EvChargerExecutor(hass)

        runtime, memory = await executor.async_execute(
            appliance=_build_appliance(),
            action=None,
            memory=ApplianceExecutionMemory(
                last_active_slot_id="2026-03-20T20:30:00+01:00",
                last_action_signature=(True, "kona", "ECO", "10A"),
                last_enabled=True,
                last_runtime_action_kind="apply",
            ),
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            hass.services.calls,
            [("switch", "turn_off", {"entity_id": "switch.ev_nabijeni"}, True)],
        )
        self.assertEqual(runtime.action_kind, "slot_stop")
        self.assertEqual(runtime.outcome, "success")
        self.assertEqual(memory.last_runtime_action_kind, "slot_stop")
        self.assertFalse(memory.last_enabled)

    async def test_unchanged_same_slot_is_noop(self) -> None:
        hass = FakeHass(
            {
                "switch.ev_nabijeni": FakeState("off"),
                "select.solax_ev_charger_charger_use_mode": FakeState(
                    "Fast",
                    attributes={"options": ["Stop", "Fast", "ECO"]},
                ),
                "select.solax_ev_charger_eco_gear": FakeState(
                    "6A",
                    attributes={"options": ["6A", "10A"]},
                ),
            }
        )
        executor = EvChargerExecutor(hass)

        runtime, _memory = await executor.async_execute(
            appliance=_build_appliance(),
            action={"charge": True, "vehicleId": "kona", "useMode": "Fast"},
            memory=ApplianceExecutionMemory(
                last_active_slot_id=CURRENT_SLOT_ID,
                last_action_signature=(True, "kona", "Fast", None),
                last_enabled=True,
                last_runtime_action_kind="apply",
            ),
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(hass.services.calls, [])
        self.assertEqual(runtime.action_kind, "noop")
        self.assertEqual(runtime.outcome, "skipped")

    async def test_slot_stop_runtime_persists_within_same_slot(self) -> None:
        hass = FakeHass(
            {
                "switch.ev_nabijeni": FakeState("off"),
                "select.solax_ev_charger_charger_use_mode": FakeState(
                    "ECO",
                    attributes={"options": ["Stop", "Fast", "ECO"]},
                ),
                "select.solax_ev_charger_eco_gear": FakeState(
                    "10A",
                    attributes={"options": ["6A", "10A"]},
                ),
            }
        )
        executor = EvChargerExecutor(hass)

        runtime, memory = await executor.async_execute(
            appliance=_build_appliance(),
            action=None,
            memory=ApplianceExecutionMemory(
                last_active_slot_id=CURRENT_SLOT_ID,
                last_action_signature=None,
                last_enabled=True,
                last_runtime_action_kind="slot_stop",
            ),
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(hass.services.calls, [])
        self.assertEqual(runtime.action_kind, "slot_stop")
        self.assertEqual(runtime.outcome, "success")
        self.assertEqual(memory.last_runtime_action_kind, "slot_stop")

    async def test_generic_on_turns_on_switch(self) -> None:
        hass = FakeHass({"switch.dishwasher": FakeState("off")})
        executor = GenericApplianceExecutor(hass)

        runtime, memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action={"on": True},
            memory=None,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            hass.services.calls,
            [("switch", "turn_on", {"entity_id": "switch.dishwasher"}, True)],
        )
        self.assertEqual(runtime.action_kind, "apply")
        self.assertEqual(runtime.outcome, "success")
        self.assertTrue(memory.last_enabled)

    async def test_generic_missing_action_after_previous_on_emits_slot_stop(self) -> None:
        hass = FakeHass({"switch.dishwasher": FakeState("on")})
        executor = GenericApplianceExecutor(hass)

        runtime, memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action=None,
            memory=ApplianceExecutionMemory(
                last_active_slot_id="2026-03-20T20:30:00+01:00",
                last_action_signature=(True,),
                last_enabled=True,
                last_runtime_action_kind="apply",
            ),
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            hass.services.calls,
            [("switch", "turn_off", {"entity_id": "switch.dishwasher"}, True)],
        )
        self.assertEqual(runtime.action_kind, "slot_stop")
        self.assertEqual(runtime.outcome, "success")
        self.assertFalse(memory.last_enabled)

    async def test_generic_unchanged_same_slot_is_noop(self) -> None:
        hass = FakeHass({"switch.dishwasher": FakeState("on")})
        executor = GenericApplianceExecutor(hass)

        runtime, _memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action={"on": True},
            memory=ApplianceExecutionMemory(
                last_active_slot_id=CURRENT_SLOT_ID,
                last_action_signature=(True,),
                last_enabled=True,
                last_runtime_action_kind="apply",
            ),
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(hass.services.calls, [])
        self.assertEqual(runtime.action_kind, "noop")
        self.assertEqual(runtime.outcome, "skipped")

    async def test_generic_failed_apply_stays_retryable_within_same_slot(self) -> None:
        hass = FakeHass({"switch.dishwasher": FakeState("off")})
        hass.services.error = RuntimeError("temporary outage")
        executor = GenericApplianceExecutor(hass)

        first_runtime, first_memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action={"on": True},
            memory=None,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(first_runtime.outcome, "failed")
        self.assertIsNone(first_memory)

        hass.services.error = None
        second_runtime, second_memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action={"on": True},
            memory=first_memory,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(len(hass.services.calls), 1)
        self.assertEqual(second_runtime.outcome, "success")
        self.assertIsNotNone(second_memory)
        self.assertTrue(second_memory.last_enabled)

    async def test_generic_failed_slot_stop_retries_with_previous_memory(self) -> None:
        hass = FakeHass({"switch.dishwasher": FakeState("on")})
        hass.services.error = RuntimeError("temporary outage")
        executor = GenericApplianceExecutor(hass)
        previous_memory = ApplianceExecutionMemory(
            last_active_slot_id="2026-03-20T20:30:00+01:00",
            last_action_signature=(True,),
            last_enabled=True,
            last_runtime_action_kind="apply",
        )

        first_runtime, first_memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action=None,
            memory=previous_memory,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(first_runtime.outcome, "failed")
        self.assertEqual(first_memory, previous_memory)

        hass.services.error = None
        second_runtime, second_memory = await executor.async_execute(
            appliance=_build_generic_appliance(),
            action=None,
            memory=first_memory,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(len(hass.services.calls), 1)
        self.assertEqual(second_runtime.outcome, "success")
        self.assertIsNotNone(second_memory)
        self.assertFalse(second_memory.last_enabled)

    async def test_timeout_waiting_for_charge_on_fails_before_selects(self) -> None:
        hass = FakeHass(
            {
                "switch.ev_nabijeni": FakeState("off"),
                "select.solax_ev_charger_charger_use_mode": FakeState(
                    "Stop",
                    attributes={"options": ["Stop", "Fast", "ECO"]},
                ),
                "select.solax_ev_charger_eco_gear": FakeState(
                    "6A",
                    attributes={"options": ["6A", "10A"]},
                ),
            },
            auto_turn_on=False,
        )

        async def _sleep(_delay: float) -> None:
            return None

        executor = EvChargerExecutor(hass, charge_on_wait_seconds=0, sleep=_sleep)

        runtime, _memory = await executor.async_execute(
            appliance=_build_appliance(),
            action={"charge": True, "vehicleId": "kona", "useMode": "Fast"},
            memory=None,
            active_slot_id=CURRENT_SLOT_ID,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(len(hass.services.calls), 1)
        self.assertEqual(hass.services.calls[0][0:2], ("switch", "turn_on"))
        self.assertEqual(runtime.outcome, "failed")
        self.assertEqual(runtime.error_code, "execution_unavailable")


if __name__ == "__main__":
    unittest.main()
