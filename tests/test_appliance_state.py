from __future__ import annotations

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

from custom_components.helman.appliances import (
    AppliancesRuntimeRegistry,
    build_appliances_response,
    build_appliances_runtime_registry,
)


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


class ApplianceStateTests(unittest.TestCase):
    def test_empty_registry_builds_empty_response(self) -> None:
        self.assertEqual(
            build_appliances_response(AppliancesRuntimeRegistry()),
            {"appliances": []},
        )

    def test_response_matches_metadata_only_shape(self) -> None:
        registry = build_appliances_runtime_registry(_valid_config())

        self.assertEqual(
            build_appliances_response(registry),
            {
                "appliances": [
                    {
                        "id": "garage-ev",
                        "name": "Garage EV",
                        "kind": "ev_charger",
                        "metadata": {
                            "maxChargingPowerKw": 11.0,
                            "scheduleCapabilities": {
                                "chargeToggle": True,
                                "useModes": ["Fast", "ECO"],
                                "ecoGears": ["6A", "10A", "16A"],
                                "requiresVehicleSelection": True,
                            },
                        },
                        "controls": {
                            "charge": {"entityId": "switch.ev_nabijeni"},
                            "useMode": {
                                "entityId": "select.solax_ev_charger_charger_use_mode"
                            },
                            "ecoGear": {"entityId": "select.solax_ev_charger_eco_gear"},
                        },
                        "vehicles": [
                            {
                                "id": "kona",
                                "name": "Kona",
                                "telemetry": {
                                    "socEntityId": "sensor.kona_ev_battery_level",
                                    "chargeLimitEntityId": "number.kona_ac_charging_limit",
                                },
                                "metadata": {
                                    "batteryCapacityKwh": 64.0,
                                    "maxChargingPowerKw": 11.0,
                                },
                            }
                        ],
                    }
                ]
            },
        )

    def test_vehicle_and_eco_gear_order_is_preserved(self) -> None:
        config = _valid_config()
        config["appliances"][0]["vehicles"].append(
            {
                "id": "enyaq",
                "name": "Enyaq",
                "telemetry": {
                    "soc_entity_id": "sensor.enyaq_soc",
                },
                "limits": {
                    "battery_capacity_kwh": 82.0,
                    "max_charging_power_kw": 11.0,
                },
            }
        )
        config["appliances"][0]["controls"]["eco_gear"]["values"] = {
            "16A": {"min_power_kw": 3.7},
            "6A": {"min_power_kw": 1.4},
            "10A": {"min_power_kw": 2.3},
        }

        registry = build_appliances_runtime_registry(config)
        response = build_appliances_response(registry)

        self.assertEqual(
            [vehicle["id"] for vehicle in response["appliances"][0]["vehicles"]],
            ["kona", "enyaq"],
        )
        self.assertEqual(
            response["appliances"][0]["metadata"]["scheduleCapabilities"]["ecoGears"],
            ["16A", "6A", "10A"],
        )

    def test_optional_charge_limit_telemetry_is_omitted(self) -> None:
        config = _valid_config()
        del config["appliances"][0]["vehicles"][0]["telemetry"]["charge_limit_entity_id"]

        registry = build_appliances_runtime_registry(config)
        response = build_appliances_response(registry)

        telemetry = response["appliances"][0]["vehicles"][0]["telemetry"]
        self.assertEqual(telemetry, {"socEntityId": "sensor.kona_ev_battery_level"})

    def test_saved_config_does_not_change_active_registry_until_rebuild(self) -> None:
        original_registry = build_appliances_runtime_registry(_valid_config())
        updated = _valid_config()
        updated["appliances"][0]["name"] = "Updated EV"

        active_response = build_appliances_response(original_registry)
        rebuilt_response = build_appliances_response(
            build_appliances_runtime_registry(updated)
        )

        self.assertEqual(active_response["appliances"][0]["name"], "Garage EV")
        self.assertEqual(rebuilt_response["appliances"][0]["name"], "Updated EV")


if __name__ == "__main__":
    unittest.main()
