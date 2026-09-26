from __future__ import annotations

import asyncio
import re
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELMAN_ROOT = ROOT / "custom_components" / "helman"


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
    helman_pkg.__path__ = [str(HELMAN_ROOT)]

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [str(HELMAN_ROOT / "scheduling")]

    try:
        import homeassistant.core  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        homeassistant_pkg = sys.modules.get("homeassistant")
        if homeassistant_pkg is None:
            homeassistant_pkg = types.ModuleType("homeassistant")
            sys.modules["homeassistant"] = homeassistant_pkg

        core_mod = types.ModuleType("homeassistant.core")
        core_mod.HomeAssistant = type("HomeAssistant", (), {})
        core_mod.callback = lambda func: func
        sys.modules["homeassistant.core"] = core_mod


_install_import_stubs()

from custom_components.helman.scheduling.actuation import (  # noqa: E402
    ScheduleActuator,
    ScheduleExecutionDisabledError,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleExecutionUnavailableError,
)


class FakeStates:
    def __init__(self, states: dict[str, object]) -> None:
        self._states = states

    def get(self, entity_id: str) -> object | None:
        return self._states.get(entity_id)


class FakeServices:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict, bool]] = []
        # When set, every call parks until the event fires -- a stalled service.
        self.release: asyncio.Event | None = None

    async def async_call(
        self,
        domain: str,
        service: str,
        data: dict,
        *,
        blocking: bool,
    ) -> None:
        self.calls.append((domain, service, data, blocking))
        if self.release is not None:
            await self.release.wait()


class FakeHass:
    def __init__(self, states: dict[str, object] | None = None) -> None:
        self.states = FakeStates(states or {})
        self.services = FakeServices()


class ScheduleActuatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_open_gate_forwards_the_service_call(self) -> None:
        hass = FakeHass()
        actuator = ScheduleActuator(hass, is_execution_enabled=lambda: True)

        await actuator.async_call("switch", "turn_off", {"entity_id": "switch.ac"})

        self.assertEqual(
            hass.services.calls,
            [("switch", "turn_off", {"entity_id": "switch.ac"}, True)],
        )

    async def test_closed_gate_makes_no_service_call(self) -> None:
        hass = FakeHass()
        actuator = ScheduleActuator(hass, is_execution_enabled=lambda: False)

        with self.assertRaises(ScheduleExecutionDisabledError):
            await actuator.async_call(
                "switch", "turn_off", {"entity_id": "switch.ac"}
            )

        self.assertEqual(hass.services.calls, [])

    async def test_gate_fails_closed_when_the_flag_cannot_be_read(self) -> None:
        hass = FakeHass()

        def _explode() -> bool:
            raise RuntimeError("storage is gone")

        actuator = ScheduleActuator(hass, is_execution_enabled=_explode)

        with self.assertLogs(
            "custom_components.helman.scheduling.actuation", level="ERROR"
        ):
            with self.assertRaises(ScheduleExecutionDisabledError):
                await actuator.async_call(
                    "climate", "set_hvac_mode", {"entity_id": "climate.ac"}
                )

        self.assertEqual(hass.services.calls, [])

    async def test_gate_is_read_fresh_on_every_call(self) -> None:
        hass = FakeHass()
        enabled = True
        actuator = ScheduleActuator(hass, is_execution_enabled=lambda: enabled)

        await actuator.async_call("switch", "turn_on", {"entity_id": "switch.ac"})
        enabled = False
        with self.assertRaises(ScheduleExecutionDisabledError):
            await actuator.async_call(
                "switch", "turn_off", {"entity_id": "switch.ac"}
            )

        self.assertEqual(len(hass.services.calls), 1)

    async def test_stalled_call_times_out_naming_service_entity_and_duration(
        self,
    ) -> None:
        hass = FakeHass()
        hass.services.release = asyncio.Event()
        actuator = ScheduleActuator(
            hass,
            is_execution_enabled=lambda: True,
            service_call_timeout_seconds=0.01,
        )

        with self.assertRaises(ScheduleExecutionUnavailableError) as raised:
            await actuator.async_call(
                "switch", "turn_on", {"entity_id": "switch.ev_charge"}
            )

        message = str(raised.exception)
        self.assertIn("switch.turn_on", message)
        self.assertIn("switch.ev_charge", message)
        self.assertIn("0.01 seconds", message)
        self.assertIsInstance(raised.exception.__cause__, TimeoutError)
        # Still a blocking call, just a bounded one.
        self.assertTrue(hass.services.calls[0][3])

    async def test_integration_timeout_is_not_reported_as_helmans_timeout(
        self,
    ) -> None:
        hass = FakeHass()

        async def _integration_times_out(*args, **kwargs) -> None:
            raise TimeoutError("cloud API timed out")

        hass.services.async_call = _integration_times_out
        actuator = ScheduleActuator(hass, is_execution_enabled=lambda: True)

        with self.assertRaisesRegex(TimeoutError, "cloud API timed out"):
            await actuator.async_call(
                "switch", "turn_on", {"entity_id": "switch.ev_charge"}
            )

    async def test_cancellation_propagates_out_of_a_stalled_call(self) -> None:
        hass = FakeHass()
        hass.services.release = asyncio.Event()
        actuator = ScheduleActuator(hass, is_execution_enabled=lambda: True)

        task = asyncio.create_task(
            actuator.async_call(
                "select", "select_option", {"entity_id": "select.ev_mode"}
            )
        )
        await asyncio.sleep(0)
        task.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await task

    def test_reads_are_allowed_while_the_gate_is_closed(self) -> None:
        state = object()
        hass = FakeHass({"switch.ac": state})
        actuator = ScheduleActuator(hass, is_execution_enabled=lambda: False)

        self.assertIs(actuator.read_state("switch.ac"), state)


class ActuationChokePointTests(unittest.TestCase):
    """The gate is only strong if nothing can route around it."""

    def test_only_the_actuation_module_calls_hass_services(self) -> None:
        pattern = re.compile(r"services\s*\.\s*async_call")
        offenders = [
            str(path.relative_to(ROOT))
            for path in HELMAN_ROOT.rglob("*.py")
            if path.name != "actuation.py"
            and "__pycache__" not in path.parts
            and pattern.search(path.read_text())
        ]

        self.assertEqual(
            offenders,
            [],
            "Hardware writes must go through ScheduleActuator so that "
            "disabling execution is guaranteed to touch nothing.",
        )
