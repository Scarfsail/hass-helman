from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from test_solar_bias_response import (
    REFERENCE_TIME,
    _install_coordinator_import_stubs,
    _restore_modules,
)

ROOT = Path(__file__).resolve().parents[1]


def _load_sensor_module():
    for module_name in [
        "custom_components.helman.sensor",
        "custom_components.helman.const",
        "homeassistant",
        "homeassistant.components",
        "homeassistant.components.sensor",
        "homeassistant.config_entries",
        "homeassistant.const",
        "homeassistant.core",
        "homeassistant.helpers",
        "homeassistant.helpers.entity_platform",
    ]:
        sys.modules.pop(module_name, None)

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

    homeassistant_pkg = types.ModuleType("homeassistant")
    sys.modules["homeassistant"] = homeassistant_pkg
    components_pkg = types.ModuleType("homeassistant.components")
    sys.modules["homeassistant.components"] = components_pkg

    sensor_mod = types.ModuleType("homeassistant.components.sensor")
    sensor_mod.SensorDeviceClass = type(
        "SensorDeviceClass",
        (),
        {"DURATION": "duration", "POWER": "power", "ENERGY": "energy"},
    )
    sensor_mod.SensorStateClass = type(
        "SensorStateClass",
        (),
        {"MEASUREMENT": "measurement"},
    )

    class SensorEntity:
        def __init__(self) -> None:
            self.hass = None
            self.entity_id = None

        async def async_added_to_hass(self) -> None:
            return None

        def async_write_ha_state(self) -> None:
            return None

    sensor_mod.SensorEntity = SensorEntity
    sys.modules["homeassistant.components.sensor"] = sensor_mod

    config_entries_mod = types.ModuleType("homeassistant.config_entries")
    config_entries_mod.ConfigEntry = type("ConfigEntry", (), {})
    sys.modules["homeassistant.config_entries"] = config_entries_mod

    const_mod = types.ModuleType("homeassistant.const")
    const_mod.UnitOfTime = type("UnitOfTime", (), {"MINUTES": "min"})
    sys.modules["homeassistant.const"] = const_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    sys.modules["homeassistant.core"] = core_mod

    helpers_pkg = types.ModuleType("homeassistant.helpers")
    sys.modules["homeassistant.helpers"] = helpers_pkg
    entity_platform_mod = types.ModuleType("homeassistant.helpers.entity_platform")
    entity_platform_mod.AddEntitiesCallback = object
    sys.modules["homeassistant.helpers.entity_platform"] = entity_platform_mod

    return importlib.import_module("custom_components.helman.sensor")


class _FakeEntry:
    entry_id = "entry-1"


class ForecastSensorEntityTests(unittest.IsolatedAsyncioTestCase):
    async def test_daily_entities_sum_local_day_buckets(self) -> None:
        previous_modules = _install_coordinator_import_stubs()
        try:
            sys.modules.pop("custom_components.helman.coordinator", None)
            coordinator_module = importlib.import_module(
                "custom_components.helman.coordinator"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._cached_solar_forecast = {
            "points": [
                {"timestamp": "2026-03-20T08:00:00+01:00", "value": 500.0},
                {"timestamp": "2026-03-20T12:00:00+01:00", "value": 1500.0},
                {"timestamp": "2026-03-21T10:00:00+01:00", "value": 2000.0},
            ]
        }

        self.assertEqual(coordinator.get_solar_forecast_day_total(0), 2000.0)
        self.assertEqual(coordinator.get_solar_forecast_day_total(1), 2000.0)

    async def test_today_remaining_excludes_elapsed_points(self) -> None:
        previous_modules = _install_coordinator_import_stubs()
        try:
            sys.modules.pop("custom_components.helman.coordinator", None)
            coordinator_module = importlib.import_module(
                "custom_components.helman.coordinator"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._cached_solar_forecast = {
            "points": [
                {"timestamp": "2026-03-20T08:00:00+01:00", "value": 500.0},
                {"timestamp": "2026-03-20T09:15:00+01:00", "value": 750.0},
                {"timestamp": "2026-03-20T12:00:00+01:00", "value": 1500.0},
            ]
        }

        with patch.object(
            coordinator_module.dt_util,
            "now",
            return_value=REFERENCE_TIME.replace(hour=9, minute=15),
        ):
            self.assertEqual(coordinator.get_solar_forecast_today_remaining(), 2250.0)

    async def test_missing_d4_bucket_is_unavailable(self) -> None:
        sensor_module = _load_sensor_module()

        class FakeCoordinator:
            def get_solar_forecast_day_total(self, day_offset: int):
                return None if day_offset == 4 else 0.0

            def get_solar_forecast_today_remaining(self):
                return 0.0

        entity = sensor_module.HelmanSolarForecastEnergySensor(
            FakeCoordinator(),
            _FakeEntry(),
            "d4",
            day_offset=4,
        )

        self.assertFalse(entity.available)
        self.assertIsNone(entity.native_value)


if __name__ == "__main__":
    unittest.main()
