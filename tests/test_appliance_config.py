from __future__ import annotations

import copy
import sys
import unittest
import types
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


_install_import_stubs()

from custom_components.helman.appliances.config import build_appliances_runtime_registry


def _valid_config() -> dict:
    return {
        "appliances": [
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "Garage EV",
                "limits": {
                    "max_charging_power_kw": 11.0,
                },
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
                            "10A": {"min_power_kw": 2.3},
                            "16A": {"min_power_kw": 3.7},
                        },
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {
                            "soc_entity_id": "sensor.kona_ev_battery_level",
                            "charge_limit_entity_id": "number.kona_ac_charging_limit",
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


def _generic_appliance() -> dict:
    return {
        "kind": "generic",
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {
            "switch": {
                "entity_id": "switch.dishwasher",
            }
        },
        "projection": {
            "strategy": "history_average",
            "hourly_energy_kwh": 1.2,
            "history_average": {
                "energy_entity_id": "sensor.dishwasher_energy_total",
                "lookback_days": 21,
            },
        },
    }


def _climate_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "climate",
        "id": "living-room-hvac",
        "name": "Living Room HVAC",
        "controls": {
            "climate": {
                "entity_id": "climate.living_room",
            }
        },
        "projection": {
            "strategy": strategy,
            "hourly_energy_kwh": 1.5,
        },
    }
    if strategy == "history_average":
        appliance["projection"]["history_average"] = {
            "energy_entity_id": "sensor.living_room_hvac_energy_total",
            "lookback_days": 14,
        }
    return appliance


class ApplianceConfigTests(unittest.TestCase):
    def test_missing_appliances_key_returns_empty_registry(self) -> None:
        registry = build_appliances_runtime_registry({})
        self.assertEqual(registry.appliances, ())

    def test_valid_config_builds_registry(self) -> None:
        registry = build_appliances_runtime_registry(_valid_config())

        self.assertEqual(len(registry.appliances), 1)
        appliance = registry.appliances[0]
        self.assertEqual(appliance.id, "garage-ev")
        self.assertEqual(appliance.name, "Garage EV")
        self.assertEqual(appliance.kind, "ev_charger")
        self.assertIsNone(appliance.icon)
        self.assertEqual(appliance.vehicles[0].id, "kona")
        self.assertEqual(appliance.eco_gears, ("6A", "10A", "16A"))

    def test_invalid_appliance_is_ignored_with_error_log(self) -> None:
        config = _valid_config()
        invalid = copy.deepcopy(config["appliances"][0])
        invalid["id"] = "broken-ev"
        invalid["controls"]["charge"]["entity_id"] = "select.not_a_switch"
        config["appliances"].append(invalid)

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR") as captured:
            registry = build_appliances_runtime_registry(config)

        self.assertEqual([appliance.id for appliance in registry.appliances], ["garage-ev"])
        self.assertEqual(len(captured.output), 1)
        self.assertIn("broken-ev", captured.output[0])
        self.assertIn("controls.charge.entity_id", captured.output[0])

    def test_duplicate_appliance_id_is_ignored(self) -> None:
        config = _valid_config()
        duplicate = copy.deepcopy(config["appliances"][0])
        duplicate["name"] = "Duplicate EV"
        config["appliances"].append(duplicate)

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR") as captured:
            registry = build_appliances_runtime_registry(config)

        self.assertEqual([appliance.name for appliance in registry.appliances], ["Garage EV"])
        self.assertIn("duplicate appliance id", captured.output[0])

    def test_duplicate_vehicle_id_invalidates_only_that_appliance(self) -> None:
        config = _valid_config()
        config["appliances"][0]["vehicles"].append(
            copy.deepcopy(config["appliances"][0]["vehicles"][0])
        )

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR"):
            registry = build_appliances_runtime_registry(config)

        self.assertEqual(registry.appliances, ())

    def test_unknown_extra_keys_are_ignored(self) -> None:
        config = _valid_config()
        config["appliances"][0]["unsupported"] = True
        config["appliances"][0]["vehicles"][0]["limits"]["future_field"] = "ok"

        registry = build_appliances_runtime_registry(config)

        self.assertEqual([appliance.id for appliance in registry.appliances], ["garage-ev"])

    def test_wrong_entity_domain_is_rejected(self) -> None:
        config = _valid_config()
        config["appliances"][0]["vehicles"][0]["telemetry"]["soc_entity_id"] = "number.not_sensor"

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR") as captured:
            registry = build_appliances_runtime_registry(config)

        self.assertEqual(registry.appliances, ())
        self.assertIn("soc_entity_id", captured.output[0])

    def test_input_select_domains_are_accepted_for_ev_select_controls(self) -> None:
        config = _valid_config()
        config["appliances"][0]["controls"]["use_mode"]["entity_id"] = "input_select.ev_use_mode"
        config["appliances"][0]["controls"]["eco_gear"]["entity_id"] = "input_select.ev_eco_gear"

        registry = build_appliances_runtime_registry(config)

        self.assertEqual([appliance.id for appliance in registry.appliances], ["garage-ev"])

    def test_preserves_appliance_order(self) -> None:
        config = _valid_config()
        second = copy.deepcopy(config["appliances"][0])
        second["id"] = "driveway-ev"
        second["name"] = "Driveway EV"
        second["vehicles"][0]["id"] = "tesla"
        second["vehicles"][0]["name"] = "Tesla"
        config["appliances"].append(second)

        registry = build_appliances_runtime_registry(config)

        self.assertEqual(
            [appliance.id for appliance in registry.appliances],
            ["garage-ev", "driveway-ev"],
        )

    def test_valid_generic_config_builds_registry(self) -> None:
        registry = build_appliances_runtime_registry({"appliances": [_generic_appliance()]})

        self.assertEqual(len(registry.appliances), 1)
        appliance = registry.appliances[0]
        self.assertEqual(appliance.id, "dishwasher")
        self.assertEqual(appliance.kind, "generic")
        self.assertIsNone(appliance.icon)
        self.assertEqual(appliance.switch_entity_id, "switch.dishwasher")
        self.assertEqual(appliance.projection_strategy, "history_average")
        self.assertEqual(
            appliance.history_energy_entity_id,
            "sensor.dishwasher_energy_total",
        )
        self.assertEqual(appliance.history_lookback_days, 21)

    def test_valid_climate_config_builds_registry(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_climate_appliance(strategy="history_average")]}
        )

        self.assertEqual(len(registry.appliances), 1)
        appliance = registry.appliances[0]
        self.assertEqual(appliance.id, "living-room-hvac")
        self.assertEqual(appliance.kind, "climate")
        self.assertEqual(appliance.climate_entity_id, "climate.living_room")
        self.assertEqual(appliance.projection_strategy, "history_average")
        self.assertEqual(
            appliance.history_energy_entity_id,
            "sensor.living_room_hvac_energy_total",
        )
        self.assertEqual(appliance.history_lookback_days, 14)

    def test_ev_icon_is_preserved(self) -> None:
        config = _valid_config()
        config["appliances"][0]["icon"] = "hass:car-electric"

        registry = build_appliances_runtime_registry(config)

        self.assertEqual(registry.appliances[0].icon, "hass:car-electric")

    def test_generic_icon_is_preserved(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [{**_generic_appliance(), "icon": "phu:socket-eu"}]}
        )

        self.assertEqual(registry.appliances[0].icon, "phu:socket-eu")

    def test_blank_ev_icon_is_rejected(self) -> None:
        config = _valid_config()
        config["appliances"][0]["icon"] = "   "

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR") as captured:
            registry = build_appliances_runtime_registry(config)

        self.assertEqual(registry.appliances, ())
        self.assertIn(".icon", captured.output[0])

    def test_invalid_generic_history_strategy_is_ignored_with_error_log(self) -> None:
        invalid = _generic_appliance()
        del invalid["projection"]["history_average"]

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR") as captured:
            registry = build_appliances_runtime_registry({"appliances": [invalid]})

        self.assertEqual(registry.appliances, ())
        self.assertIn("history_average is required", captured.output[0])

    def test_invalid_climate_domain_is_ignored_with_error_log(self) -> None:
        invalid = _climate_appliance()
        invalid["controls"]["climate"]["entity_id"] = "switch.not_a_climate"

        with self.assertLogs("custom_components.helman.appliances.config", level="ERROR") as captured:
            registry = build_appliances_runtime_registry({"appliances": [invalid]})

        self.assertEqual(registry.appliances, ())
        self.assertIn("controls.climate.entity_id", captured.output[0])


if __name__ == "__main__":
    unittest.main()
