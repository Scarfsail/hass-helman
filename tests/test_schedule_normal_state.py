from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


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
    OverrideScheduleActuator,
    ScheduleActuator,
)
from custom_components.helman.scheduling.normal_state import (  # noqa: E402
    async_restore_normal_state,
    build_controllable_entities,
    build_non_normal_entities,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleControlConfig,
)


class FakeState:
    def __init__(self, state: str) -> None:
        self.state = state


class FakeStates:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states

    def get(self, entity_id: str) -> FakeState | None:
        return self._states.get(entity_id)


class FakeServices:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states
        self.calls: list[tuple[str, str, dict]] = []
        self.failing_entity_ids: set[str] = set()

    async def async_call(
        self,
        domain: str,
        service: str,
        data: dict,
        *,
        blocking: bool,
    ) -> None:
        entity_id = data["entity_id"]
        if entity_id in self.failing_entity_ids:
            raise RuntimeError(f"{entity_id} refused")
        self.calls.append((domain, service, data))
        if service == "turn_off":
            self._states[entity_id].state = "off"
        elif service == "set_hvac_mode":
            self._states[entity_id].state = data["hvac_mode"]
        elif service == "select_option":
            self._states[entity_id].state = data["option"]


class FakeHass:
    def __init__(self, states: dict[str, FakeState]) -> None:
        self._states = states
        self.states = FakeStates(states)
        self.services = FakeServices(states)


class FakeRegistry:
    def __init__(self, appliances: tuple) -> None:
        self.appliances = appliances


class FakeClimateAppliance:
    kind = "climate"

    def __init__(self, *, name: str, entity_id: str, stop_hvac_mode: str = "off") -> None:
        self.name = name
        self.climate_entity_id = entity_id
        self.stop_hvac_mode = stop_hvac_mode


class FakeSwitchAppliance:
    kind = "generic"

    def __init__(self, *, name: str, entity_id: str) -> None:
        self.name = name
        self.switch_entity_id = entity_id


class FakeEvAppliance:
    kind = "ev_charger"

    def __init__(self, *, name: str, entity_id: str) -> None:
        self.name = name
        self.charge_entity_id = entity_id


def _control_config() -> ScheduleControlConfig:
    return ScheduleControlConfig(
        mode_entity_id="select.inverter_mode",
        normal_option="Normal",
        charge_to_target_soc_option="Charge To Target",
        discharge_to_target_soc_option="Discharge To Target",
        stop_charging_option="Stop Charging",
        stop_discharging_option="Stop Discharging",
        stop_export_option="Stop Export",
    )


def _registry() -> FakeRegistry:
    return FakeRegistry(
        (
            FakeClimateAppliance(name="AC", entity_id="climate.ac"),
            FakeSwitchAppliance(name="Boiler", entity_id="switch.boiler"),
            FakeEvAppliance(name="Car", entity_id="switch.ev_charging"),
        )
    )


class BuildControllableEntitiesTests(unittest.TestCase):
    def test_lists_every_controllable_entity_with_its_resting_state(self) -> None:
        entities = build_controllable_entities(
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(
            [(entity["entityId"], entity["normalState"]) for entity in entities],
            [
                ("select.inverter_mode", "Normal"),
                ("climate.ac", "off"),
                ("switch.boiler", "off"),
                ("switch.ev_charging", "off"),
            ],
        )

    def test_omits_the_inverter_when_it_is_not_configured(self) -> None:
        entities = build_controllable_entities(
            control_config=None,
            registry=_registry(),
        )

        self.assertNotIn(
            "inverter", [entity["kind"] for entity in entities]
        )

    def test_climate_resting_state_follows_the_configured_stop_mode(self) -> None:
        registry = FakeRegistry(
            (
                FakeClimateAppliance(
                    name="AC", entity_id="climate.ac", stop_hvac_mode="fan_only"
                ),
            )
        )

        entities = build_controllable_entities(
            control_config=None,
            registry=registry,
        )

        self.assertEqual(entities[0]["normalState"], "fan_only")


class BuildNonNormalEntitiesTests(unittest.TestCase):
    def test_lists_everything_that_is_not_at_rest(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Stop Charging"),
                "climate.ac": FakeState("cool"),
                "switch.boiler": FakeState("off"),
                "switch.ev_charging": FakeState("on"),
            }
        )

        entities = build_non_normal_entities(
            actuator=ScheduleActuator(hass, is_execution_enabled=lambda: False),
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(
            [(entity["entityId"], entity["state"]) for entity in entities],
            [
                ("select.inverter_mode", "Stop Charging"),
                ("climate.ac", "cool"),
                ("switch.ev_charging", "on"),
            ],
        )

    def test_returns_nothing_when_everything_is_at_rest(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Normal"),
                "climate.ac": FakeState("off"),
                "switch.boiler": FakeState("off"),
                "switch.ev_charging": FakeState("off"),
            }
        )

        entities = build_non_normal_entities(
            actuator=ScheduleActuator(hass, is_execution_enabled=lambda: False),
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(entities, [])

    def test_unreadable_entities_are_omitted(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("unavailable"),
                "climate.ac": FakeState("unknown"),
                "switch.boiler": FakeState("on"),
            }
        )

        entities = build_non_normal_entities(
            actuator=ScheduleActuator(hass, is_execution_enabled=lambda: False),
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual([entity["entityId"] for entity in entities], ["switch.boiler"])

    def test_listing_never_actuates(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Stop Charging"),
                "climate.ac": FakeState("heat"),
                "switch.boiler": FakeState("on"),
                "switch.ev_charging": FakeState("on"),
            }
        )

        build_non_normal_entities(
            actuator=ScheduleActuator(hass, is_execution_enabled=lambda: False),
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(hass.services.calls, [])


class RestoreNormalStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_restores_inverter_and_every_running_appliance(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Stop Charging"),
                "climate.ac": FakeState("cool"),
                "switch.boiler": FakeState("off"),
                "switch.ev_charging": FakeState("on"),
            }
        )

        restored = await async_restore_normal_state(
            actuator=OverrideScheduleActuator(hass),
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(restored, 3)
        self.assertEqual(
            hass.services.calls,
            [
                (
                    "select",
                    "select_option",
                    {"entity_id": "select.inverter_mode", "option": "Normal"},
                ),
                (
                    "climate",
                    "set_hvac_mode",
                    {"entity_id": "climate.ac", "hvac_mode": "off"},
                ),
                ("switch", "turn_off", {"entity_id": "switch.ev_charging"}),
            ],
        )
        # Everything that was listed is now at rest.
        self.assertEqual(
            build_non_normal_entities(
                actuator=OverrideScheduleActuator(hass),
                control_config=_control_config(),
                registry=_registry(),
            ),
            [],
        )

    async def test_is_best_effort_and_leaves_failures_listed(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Stop Charging"),
                "climate.ac": FakeState("cool"),
                "switch.boiler": FakeState("on"),
                "switch.ev_charging": FakeState("on"),
            }
        )
        hass.services.failing_entity_ids = {"climate.ac"}

        with self.assertLogs(
            "custom_components.helman.scheduling.normal_state", level="WARNING"
        ):
            restored = await async_restore_normal_state(
                actuator=OverrideScheduleActuator(hass),
                control_config=_control_config(),
                registry=_registry(),
            )

        # The failure neither aborts the run nor rolls anything back.
        self.assertEqual(restored, 3)
        remaining = build_non_normal_entities(
            actuator=OverrideScheduleActuator(hass),
            control_config=_control_config(),
            registry=_registry(),
        )
        self.assertEqual([entity["entityId"] for entity in remaining], ["climate.ac"])

    async def test_does_nothing_when_everything_is_already_at_rest(self) -> None:
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Normal"),
                "climate.ac": FakeState("off"),
                "switch.boiler": FakeState("off"),
                "switch.ev_charging": FakeState("off"),
            }
        )

        restored = await async_restore_normal_state(
            actuator=OverrideScheduleActuator(hass),
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(restored, 0)
        self.assertEqual(hass.services.calls, [])

    async def test_a_gated_actuator_restores_nothing(self) -> None:
        # The bulk action must go through the override actuator; the normal,
        # gated one refuses while execution is disabled.
        hass = FakeHass(
            {
                "select.inverter_mode": FakeState("Stop Charging"),
                "climate.ac": FakeState("cool"),
                "switch.boiler": FakeState("on"),
                "switch.ev_charging": FakeState("off"),
            }
        )

        with self.assertLogs(
            "custom_components.helman.scheduling.normal_state", level="WARNING"
        ):
            restored = await async_restore_normal_state(
                actuator=ScheduleActuator(hass, is_execution_enabled=lambda: False),
                control_config=_control_config(),
                registry=_registry(),
            )

        self.assertEqual(restored, 0)
        self.assertEqual(hass.services.calls, [])
