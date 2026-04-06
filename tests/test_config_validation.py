from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    core_mod.HomeAssistant = type("HomeAssistant", (), {})

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-05T12:00:00+00:00")
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.config_validation import validate_config_document


def _valid_config() -> dict:
    return {
        "sources_title": "Energy Sources",
        "consumers_title": "Energy Consumers",
        "groups_title": "Group by:",
        "others_group_label": "Others",
        "show_empty_groups": False,
        "show_others_group": True,
        "history_buckets": 60,
        "history_bucket_duration": 1,
        "device_label_text": {
            "rooms": {
                "Kitchen": "KT",
            }
        },
        "power_sensor_name_cleaner_regex": r"\s+",
        "power_devices": {
            "house": {
                "entities": {
                    "power": "sensor.house_power",
                },
                "unmeasured_power_title": "Unmeasured",
                "forecast": {
                    "total_energy_entity_id": "sensor.house_energy_total",
                    "min_history_days": 14,
                    "training_window_days": 56,
                    "deferrable_consumers": [
                        {
                            "energy_entity_id": "sensor.washer_energy",
                            "label": "Washer",
                        }
                    ],
                },
            },
            "solar": {
                "entities": {
                    "power": "sensor.solar_power",
                    "today_energy": "sensor.solar_today",
                    "remaining_today_energy_forecast": "sensor.solar_remaining",
                },
                "forecast": {
                    "daily_energy_entity_ids": [
                        "sensor.solar_day_1",
                        "sensor.solar_day_2",
                    ],
                    "total_energy_entity_id": "sensor.solar_total",
                },
            },
            "battery": {
                "entities": {
                    "power": "sensor.battery_power",
                    "remaining_energy": "sensor.battery_remaining",
                    "capacity": "sensor.battery_soc",
                    "min_soc": "sensor.battery_min_soc",
                    "max_soc": "sensor.battery_max_soc",
                },
                "forecast": {
                    "charge_efficiency": 0.95,
                    "discharge_efficiency": 0.95,
                    "max_charge_power_w": 5000,
                    "max_discharge_power_w": 5000,
                },
            },
            "grid": {
                "entities": {
                    "power": "sensor.grid_power",
                },
                "forecast": {
                    "sell_price_entity_id": "sensor.grid_sell_price",
                    "import_price_unit": "CZK/kWh",
                    "import_price_windows": [
                        {"start": "00:00", "end": "06:00", "price": 2.5},
                        {"start": "06:00", "end": "00:00", "price": 3.5},
                    ],
                },
            },
        },
        "scheduler": {
            "control": {
                "mode_entity_id": "input_select.fv_mode",
                "action_option_map": {
                    "normal": "Normal",
                    "charge_to_target_soc": "Charge",
                    "discharge_to_target_soc": "Discharge",
                    "stop_charging": "Stop charging",
                    "stop_discharging": "Stop discharging",
                },
            }
        },
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
                        "entity_id": "input_select.ev_use_mode",
                        "values": {
                            "Fast": {"behavior": "fixed_max_power"},
                            "ECO": {"behavior": "surplus_aware"},
                        },
                    },
                    "eco_gear": {
                        "entity_id": "input_select.ev_eco_gear",
                        "values": {
                            "6A": {"min_power_kw": 1.4},
                            "10A": {"min_power_kw": 2.3},
                        },
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {
                            "soc_entity_id": "sensor.kona_soc",
                            "charge_limit_entity_id": "number.kona_charge_limit",
                        },
                        "limits": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    }
                ],
            }
        ],
    }


class ConfigValidationTests(unittest.TestCase):
    def test_valid_document_passes(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])

    def test_unknown_appliance_kind_is_warning_only(self) -> None:
        config = _valid_config()
        config["appliances"] = [{"kind": "heat_pump"}]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(len(report.warnings), 1)
        self.assertEqual(report.warnings[0].code, "unsupported_kind")

    def test_invalid_scheduler_control_is_error(self) -> None:
        config = _valid_config()
        config["scheduler"]["control"] = {
            "mode_entity_id": "sensor.bad_domain",
            "action_option_map": {
                "normal": "Normal",
            },
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.code == "invalid_scheduler_control" for issue in report.errors)
        )
        self.assertTrue(any(issue.code == "invalid_domain" for issue in report.errors))

    def test_invalid_grid_import_windows_are_reported(self) -> None:
        config = _valid_config()
        config["power_devices"]["grid"]["forecast"]["import_price_windows"] = [
            {"start": "00:00", "end": "05:00", "price": 2.5},
            {"start": "06:00", "end": "00:00", "price": 3.5},
        ]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.code == "invalid_import_price_config"
                and "leave a gap" in issue.message
                for issue in report.errors
            )
        )

    def test_input_select_ev_controls_are_accepted(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)

    def test_invalid_device_label_text_shape_is_reported(self) -> None:
        config = _valid_config()
        config["device_label_text"] = {"rooms": {"Kitchen": 123}}

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].path, "device_label_text.rooms.Kitchen")


if __name__ == "__main__":
    unittest.main()
