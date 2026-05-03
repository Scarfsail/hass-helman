from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
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

    helpers_pkg = sys.modules.get("homeassistant.helpers")
    if helpers_pkg is None:
        helpers_pkg = types.ModuleType("homeassistant.helpers")
        sys.modules["homeassistant.helpers"] = helpers_pkg
    if not hasattr(helpers_pkg, "__path__"):
        helpers_pkg.__path__ = []

    storage_mod = sys.modules.get("homeassistant.helpers.storage")
    if storage_mod is None:
        storage_mod = types.ModuleType("homeassistant.helpers.storage")
        sys.modules["homeassistant.helpers.storage"] = storage_mod
    storage_mod.Store = type("Store", (), {})
    helpers_pkg.storage = storage_mod

    entity_registry_mod = sys.modules.get("homeassistant.helpers.entity_registry")
    if entity_registry_mod is None:
        entity_registry_mod = types.ModuleType("homeassistant.helpers.entity_registry")
        sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod
    if not hasattr(entity_registry_mod, "async_get"):
        entity_registry_mod.async_get = lambda _hass: None
    helpers_pkg.entity_registry = entity_registry_mod

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    energy_pkg = sys.modules.get("homeassistant.components.energy")
    if energy_pkg is None:
        energy_pkg = types.ModuleType("homeassistant.components.energy")
        sys.modules["homeassistant.components.energy"] = energy_pkg

    websocket_mod = sys.modules.get("homeassistant.components.energy.websocket_api")
    if websocket_mod is None:
        websocket_mod = types.ModuleType(
            "homeassistant.components.energy.websocket_api"
        )
        sys.modules["homeassistant.components.energy.websocket_api"] = websocket_mod
    async def _async_get_energy_platforms(_hass):
        return []
    websocket_mod.async_get_energy_platforms = _async_get_energy_platforms
    energy_pkg.websocket_api = websocket_mod

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
from custom_components.helman.const import STORAGE_KEY
import custom_components.helman.storage as helman_storage_module
from custom_components.helman.storage import HelmanStorage


class _FakeStore:
    loads_by_key: dict[str, object] = {}
    saves_by_key: dict[str, list[object]] = {}
    instances: list["_FakeStore"] = []

    def __init__(self, _hass, _version, key) -> None:
        self.key = key
        self._async_migrate_func = None
        type(self).instances.append(self)

    async def async_load(self):
        return deepcopy(type(self).loads_by_key.get(self.key))

    async def async_save(self, payload):
        type(self).saves_by_key.setdefault(self.key, []).append(deepcopy(payload))

    @classmethod
    def reset(cls) -> None:
        cls.loads_by_key = {}
        cls.saves_by_key = {}
        cls.instances = []


sys.modules["homeassistant.helpers.storage"].Store = _FakeStore
helman_storage_module.storage.Store = _FakeStore


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
                    "source_config_entry_id": "forecast-entry",
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
                    "stop_export": "Stop export",
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


def _generic_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "generic",
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {
            "switch": {"entity_id": "switch.dishwasher"},
        },
        "projection": {
            "strategy": strategy,
            "hourly_energy_kwh": 1.2,
        },
    }
    if strategy == "history_average":
        appliance["projection"]["history_average"] = {
            "energy_entity_id": "sensor.dishwasher_energy_total",
            "lookback_days": 30,
        }
    return appliance


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
            "lookback_days": 30,
        }
    return appliance


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

    def test_invalid_stop_export_option_type_is_error(self) -> None:
        config = _valid_config()
        config["scheduler"]["control"]["action_option_map"]["stop_export"] = 42

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "scheduler.control.action_option_map.stop_export"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

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

    def test_solar_forecast_source_config_entry_id_accepts_non_empty_string(
        self,
    ) -> None:
        config = _valid_config()
        forecast = config["power_devices"]["solar"]["forecast"]
        forecast.pop("daily_energy_entity_ids", None)
        forecast["source_config_entry_id"] = "forecast-entry"

        report = validate_config_document(config)

        self.assertTrue(report.valid)

    def test_solar_forecast_source_config_entry_id_rejects_blank_string(
        self,
    ) -> None:
        config = _valid_config()
        forecast = config["power_devices"]["solar"]["forecast"]
        forecast.pop("daily_energy_entity_ids", None)
        forecast["source_config_entry_id"] = "   "

        report = validate_config_document(config)

        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.source_config_entry_id"
                for issue in report.errors
            )
        )

    def test_solar_forecast_source_config_entry_id_rejects_non_string(self) -> None:
        config = _valid_config()
        config["power_devices"]["solar"]["forecast"]["source_config_entry_id"] = 42

        report = validate_config_document(config)

        self.assertTrue(
            any(
                issue.path == "power_devices.solar.forecast.source_config_entry_id"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_solar_validation_ignores_removed_forecast_entity_fields(self) -> None:
        config = _valid_config()
        # Use invalid entity_id format (no dot) to trigger errors if those fields are still validated
        config["power_devices"]["solar"]["forecast"]["total_energy_entity_id"] = "no_dot"
        config["power_devices"]["solar"]["entities"]["remaining_today_energy_forecast"] = "no_dot"
        report = validate_config_document(config)
        error_paths = {issue.path for issue in report.errors}
        self.assertNotIn("power_devices.solar.forecast.total_energy_entity_id", error_paths)
        self.assertNotIn("power_devices.solar.entities.remaining_today_energy_forecast", error_paths)

    def test_surplus_appliance_optimizer_passes_for_configured_generic_appliance(self) -> None:
        config = _valid_config()
        config["appliances"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "run-dishwasher-on-surplus",
                    "kind": "surplus_appliance",
                    "params": {
                        "appliance_id": "dishwasher",
                        "action": "on",
                    },
                }
            ],
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_surplus_appliance_optimizer_rejects_unknown_appliance_id(self) -> None:
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "run-unknown-on-surplus",
                    "kind": "surplus_appliance",
                    "params": {
                        "appliance_id": "missing-appliance",
                        "action": "on",
                    },
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "automation.optimizers[0].params.appliance_id"
                for issue in report.errors
            )
        )


class HelmanStorageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        _FakeStore.reset()
        storage_mod = sys.modules["homeassistant.helpers.storage"]
        storage_mod.Store = _FakeStore
        helman_storage_module.storage = storage_mod
        helman_storage_module.storage.Store = _FakeStore

    async def test_async_load_normalizes_legacy_config_in_memory_only(self) -> None:
        legacy_config = _valid_config()
        forecast = legacy_config["power_devices"]["solar"]["forecast"]
        forecast.pop("source_config_entry_id", None)
        forecast["daily_energy_entity_ids"] = [
            "sensor.solar_day_1",
            "sensor.solar_day_2",
        ]
        _FakeStore.loads_by_key[STORAGE_KEY] = legacy_config

        store = HelmanStorage(object())

        await store.async_load()

        self.assertEqual(
            store.config["power_devices"]["solar"]["forecast"],
            {},
        )
        self.assertNotIn(STORAGE_KEY, _FakeStore.saves_by_key)

    async def test_async_save_persists_normalized_config(self) -> None:
        store = HelmanStorage(object())
        config = _valid_config()
        forecast = config["power_devices"]["solar"]["forecast"]
        forecast["source_config_entry_id"] = "  forecast-entry  "
        forecast["daily_energy_entity_ids"] = ["sensor.solar_day_1"]

        await store.async_save(config)

        self.assertEqual(
            store.config["power_devices"]["solar"]["forecast"],
            {
                "source_config_entry_id": "forecast-entry",
            },
        )
        self.assertEqual(
            _FakeStore.saves_by_key[STORAGE_KEY],
            [store.config],
        )

    def test_surplus_appliance_optimizer_rejects_climate_mode_for_generic_appliance(
        self,
    ) -> None:
        config = _valid_config()
        config["appliances"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "optimizers": [
                {
                    "id": "run-dishwasher-on-surplus",
                    "kind": "surplus_appliance",
                    "params": {
                        "appliance_id": "dishwasher",
                        "action": "on",
                        "climate_mode": "heat",
                    },
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "automation.optimizers[0].params.climate_mode"
                for issue in report.errors
            )
        )

    def test_input_select_ev_controls_are_accepted(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)

    def test_valid_generic_appliance_passes(self) -> None:
        config = _valid_config()
        config["appliances"] = [_generic_appliance(strategy="history_average")]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_valid_climate_appliance_passes(self) -> None:
        config = _valid_config()
        config["appliances"] = [_climate_appliance(strategy="history_average")]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_appliance_icon_accepts_non_mdi_value(self) -> None:
        config = _valid_config()
        config["appliances"][0]["icon"] = "hass:car-electric"

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_generic_history_average_requires_energy_entity(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance(strategy="history_average")
        del appliance["projection"]["history_average"]
        config["appliances"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "appliances[0]"
                and "history_average is required" in issue.message
                for issue in report.errors
            )
        )

    def test_climate_requires_climate_domain(self) -> None:
        config = _valid_config()
        appliance = _climate_appliance()
        appliance["controls"]["climate"]["entity_id"] = "switch.not_a_climate"
        config["appliances"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "appliances[0]"
                and "controls.climate.entity_id" in issue.message
                for issue in report.errors
            )
        )

    def test_blank_appliance_icon_is_error(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["icon"] = "   "
        config["appliances"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "appliances[0]"
                and ".icon must be a non-empty string" in issue.message
                for issue in report.errors
            )
        )

    def test_invalid_device_label_text_shape_is_reported(self) -> None:
        config = _valid_config()
        config["device_label_text"] = {"rooms": {"Kitchen": 123}}

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].path, "device_label_text.rooms.Kitchen")


if __name__ == "__main__":
    unittest.main()
