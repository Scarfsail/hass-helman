from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

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
    helpers_pkg.__path__ = []  # mark as package so sub-imports work
    sys.modules["homeassistant.helpers"] = helpers_pkg
    entity_platform_mod = types.ModuleType("homeassistant.helpers.entity_platform")
    entity_platform_mod.AddEntitiesCallback = object
    sys.modules["homeassistant.helpers.entity_platform"] = entity_platform_mod

    # ``automation.day_context_store`` (pulled in transitively) does
    # ``from homeassistant.helpers import storage``; provide a lightweight stub.
    storage_helper_mod = types.ModuleType("homeassistant.helpers.storage")

    class _HelperStore:
        def __init__(self, hass, version, key) -> None:
            self._data = None

        async def async_load(self):
            return self._data

        async def async_save(self, data) -> None:
            self._data = data

    storage_helper_mod.Store = _HelperStore
    sys.modules["homeassistant.helpers.storage"] = storage_helper_mod
    helpers_pkg.storage = storage_helper_mod

    return importlib.import_module("custom_components.helman.sensor")


class _FakeEntry:
    entry_id = "entry-1"


class ForecastSensorEntityTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_setup_entry_registers_forecast_entities_with_coordinator(
        self,
    ) -> None:
        sensor_module = _load_sensor_module()
        coordinator = SimpleNamespace(
            get_device_tree=AsyncMock(return_value={"sources": [], "consumers": []}),
            collect_qualifying_nodes=Mock(return_value={}),
            config={},
            set_sensors=Mock(),
            set_entity_factory=Mock(),
            register_house_consumption_forecast_current_sensor=Mock(),
        )
        hass = SimpleNamespace(data={"helman": {"coordinator": coordinator}})
        added_entities: list[object] = []

        await sensor_module.async_setup_entry(
            hass,
            _FakeEntry(),
            added_entities.extend,
        )

        forecast_sensors = coordinator.set_sensors.call_args.kwargs["forecast_sensors"]
        self.assertEqual(len(forecast_sensors), 9)
        self.assertEqual(
            forecast_sensors[0].entity_id,
            "sensor.helman_energy_production_today",
        )
        self.assertEqual(
            forecast_sensors[-1].entity_id,
            "sensor.helman_energy_production_today_remaining",
        )
        # Last 9 added entities should be the forecast sensors
        self.assertEqual(
            [entity.entity_id for entity in added_entities[-10:-1]],
            [entity.entity_id for entity in forecast_sensors],
        )
        # Last added entity should be the house consumption forecast current sensor
        self.assertEqual(
            added_entities[-1].entity_id,
            "sensor.helman_house_consumption_forecast_current",
        )

    async def test_forecast_entities_use_kwh_and_translation_keys(self) -> None:
        sensor_module = _load_sensor_module()

        class FakeCoordinator:
            def get_solar_forecast_day_total(self, day_offset: int):
                return 2.0 if day_offset == 0 else None

            def get_solar_forecast_today_remaining(self):
                return 1.25

        today_entity = sensor_module.HelmanSolarForecastEnergySensor(
            FakeCoordinator(),
            _FakeEntry(),
            "today",
            day_offset=0,
        )
        remaining_entity = sensor_module.HelmanSolarForecastRemainingSensor(
            FakeCoordinator(),
            _FakeEntry(),
        )

        self.assertEqual(today_entity._attr_native_unit_of_measurement, "kWh")
        self.assertEqual(today_entity._attr_translation_key, "energy_production_today")
        self.assertTrue(today_entity._attr_has_entity_name)
        self.assertEqual(
            remaining_entity._attr_native_unit_of_measurement,
            "kWh",
        )
        self.assertEqual(
            remaining_entity._attr_translation_key,
            "energy_production_today_remaining",
        )
        self.assertTrue(remaining_entity._attr_has_entity_name)

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

        self.assertEqual(coordinator.get_solar_forecast_day_total(0), 2.0)
        self.assertEqual(coordinator.get_solar_forecast_day_total(1), 2.0)

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
            self.assertEqual(coordinator.get_solar_forecast_today_remaining(), 2.25)

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

    async def test_sparse_day_offsets_and_today_remaining_use_shared_snapshot(self) -> None:
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
                {"timestamp": "2026-03-24T09:15:00+01:00", "value": 3250.0},
            ]
        }

        with patch.object(
            coordinator_module.dt_util,
            "now",
            return_value=REFERENCE_TIME.replace(hour=9, minute=15),
        ):
            self.assertEqual(coordinator.get_solar_forecast_day_total(0), 2.0)
            self.assertEqual(coordinator.get_solar_forecast_day_total(1), 2.0)
            self.assertIsNone(coordinator.get_solar_forecast_day_total(2))
            self.assertIsNone(coordinator.get_solar_forecast_day_total(3))
            self.assertEqual(coordinator.get_solar_forecast_day_total(4), 3.25)
            self.assertIsNone(coordinator.get_solar_forecast_day_total(5))
            self.assertIsNone(coordinator.get_solar_forecast_day_total(6))
            self.assertIsNone(coordinator.get_solar_forecast_day_total(7))
            self.assertEqual(coordinator.get_solar_forecast_today_remaining(), 1.5)


if __name__ == "__main__":
    unittest.main()
