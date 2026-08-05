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

from custom_components.helman.scheduling.normal_state import (  # noqa: E402
    build_controllable_entities,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleControlConfig,
)


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

    def test_inverter_carries_the_option_each_action_kind_selects(self) -> None:
        entities = build_controllable_entities(
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertEqual(
            entities[0]["actionOptions"],
            {
                "normal": "Normal",
                "stop_charging": "Stop Charging",
                "stop_discharging": "Stop Discharging",
                "charge_to_target_soc": "Charge To Target",
                "discharge_to_target_soc": "Discharge To Target",
                "stop_export": "Stop Export",
            },
        )

    def test_inverter_omits_action_kinds_without_a_configured_option(self) -> None:
        entities = build_controllable_entities(
            control_config=ScheduleControlConfig(
                mode_entity_id="select.inverter_mode",
                normal_option="Normal",
                stop_charging_option="Stop Charging",
                stop_discharging_option="Stop Discharging",
            ),
            registry=_registry(),
        )

        self.assertEqual(
            entities[0]["actionOptions"],
            {
                "normal": "Normal",
                "stop_charging": "Stop Charging",
                "stop_discharging": "Stop Discharging",
            },
        )

    def test_appliances_carry_no_action_options(self) -> None:
        entities = build_controllable_entities(
            control_config=_control_config(),
            registry=_registry(),
        )

        self.assertTrue(
            all("actionOptions" not in entity for entity in entities[1:])
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
