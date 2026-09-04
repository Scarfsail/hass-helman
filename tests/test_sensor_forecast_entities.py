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
        {
            "DURATION": "duration",
            "POWER": "power",
            "ENERGY": "energy",
            "BATTERY": "battery",
        },
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

    device_registry_mod = types.ModuleType("homeassistant.helpers.device_registry")
    device_registry_mod.DeviceEntryType = type("DeviceEntryType", (), {"SERVICE": "service"})
    device_registry_mod.DeviceInfo = dict
    sys.modules["homeassistant.helpers.device_registry"] = device_registry_mod

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
            register_solar_forecast_current_sensors=Mock(),
            register_battery_forecast_current_sensors=Mock(),
            register_grid_import_price_sensor=Mock(),
            register_grid_export_price_sensor=Mock(),
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
            "sensor.helman_solar_forecast_today",
        )
        self.assertEqual(
            forecast_sensors[-1].entity_id,
            "sensor.helman_solar_forecast_today_remaining",
        )
        # The forecast sensors, then the ten coordinator-pushed singletons that
        # follow them: the house consumption forecast, the two current-slot solar
        # forecasts, the five current-slot battery forecasts, and the two price
        # sensors.
        self.assertEqual(
            [entity.entity_id for entity in added_entities[-19:-10]],
            [entity.entity_id for entity in forecast_sensors],
        )
        self.assertEqual(
            [entity.entity_id for entity in added_entities[-10:]],
            [
                "sensor.helman_house_consumption_forecast_current",
                "sensor.helman_solar_forecast_current",
                "sensor.helman_solar_forecast_current_corrected",
                "sensor.helman_battery_soc_forecast_current",
                "sensor.helman_battery_net_forecast_current",
                "sensor.helman_grid_net_forecast_current",
                "sensor.helman_grid_import_forecast_current",
                "sensor.helman_grid_export_forecast_current",
                "sensor.helman_grid_import_price",
                "sensor.helman_grid_export_price",
            ],
        )
        coordinator.register_grid_import_price_sensor.assert_called_once()
        # Raw and corrected, both published on the slot-aligned beat.
        (registered,) = coordinator.register_solar_forecast_current_sensors.call_args.args
        self.assertEqual(
            [s.entity_id for s in registered],
            [
                "sensor.helman_solar_forecast_current",
                "sensor.helman_solar_forecast_current_corrected",
            ],
        )
        # The five battery forecast series, on that same beat.
        (battery_registered,) = (
            coordinator.register_battery_forecast_current_sensors.call_args.args
        )
        self.assertEqual(
            [s.entity_id for s in battery_registered],
            [
                "sensor.helman_battery_soc_forecast_current",
                "sensor.helman_battery_net_forecast_current",
                "sensor.helman_grid_net_forecast_current",
                "sensor.helman_grid_import_forecast_current",
                "sensor.helman_grid_export_forecast_current",
            ],
        )
        coordinator.register_grid_export_price_sensor.assert_called_once()

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
        self.assertEqual(today_entity._attr_translation_key, "solar_forecast_today")
        self.assertTrue(today_entity._attr_has_entity_name)
        self.assertEqual(
            remaining_entity._attr_native_unit_of_measurement,
            "kWh",
        )
        self.assertEqual(
            remaining_entity._attr_translation_key,
            "solar_forecast_today_remaining",
        )
        self.assertTrue(remaining_entity._attr_has_entity_name)

    async def test_current_slot_entities_publish_wh_with_no_device_class(self) -> None:
        # The device class is off deliberately, and the reason is easy to undo
        # by accident: Home Assistant allows SensorDeviceClass.ENERGY only with
        # TOTAL or TOTAL_INCREASING, which describe a cumulative meter. This
        # value rises and falls with the sun, so declaring one would have the
        # recorder read every decrease as a meter reset. Statistics survive the
        # omission because they are gated on state_class, and the recorder
        # derives the unit class from "Wh" alone.
        sensor_module = _load_sensor_module()

        for entity, key in (
            (
                sensor_module.HelmanSolarForecastCurrentSensor(
                    SimpleNamespace(), _FakeEntry()
                ),
                "solar_forecast_current",
            ),
            (
                sensor_module.HelmanSolarForecastCurrentCorrectedSensor(
                    SimpleNamespace(), _FakeEntry()
                ),
                "solar_forecast_current_corrected",
            ),
        ):
            with self.subTest(key=key):
                self.assertEqual(entity._attr_native_unit_of_measurement, "Wh")
                # The source publishes slot energies at two decimals, and the
                # trainer reads its past from this entity, so the published
                # figure must not be rounded harder than the source's own.
                entity._read = lambda: 1244.25
                self.assertEqual(entity.native_value, 1244.25)
                self.assertIsNone(getattr(entity, "_attr_device_class", None))
                self.assertEqual(
                    entity._attr_state_class,
                    sensor_module.SensorStateClass.MEASUREMENT,
                )
                self.assertEqual(entity._attr_translation_key, key)
                self.assertTrue(entity._attr_has_entity_name)

    async def test_current_slot_forecast_entities_force_update(self) -> None:
        # Every current-slot forecast entity must write a recorder row on each
        # slot beat, changed or not: Home Assistant records nothing for an
        # unchanged value, so a flat series -- the grid net forecast pinned at
        # 0.0 through an evening -- would leave no row for any slot in the
        # stretch, and resolve_forecast_slot_values would have to reconstruct
        # them from a held value that any dropout clears. force_update is what
        # makes these entities the per-slot archive their docstrings claim.
        sensor_module = _load_sensor_module()

        coordinator = SimpleNamespace(
            get_battery_forecast_current=lambda: {},
            get_house_consumption_forecast_current_w=lambda: None,
        )
        classes = (
            sensor_module.HelmanHouseConsumptionForecastCurrentSensor,
            sensor_module.HelmanSolarForecastCurrentSensor,
            sensor_module.HelmanSolarForecastCurrentCorrectedSensor,
            sensor_module.HelmanBatterySocForecastCurrentSensor,
            sensor_module.HelmanBatteryNetForecastCurrentSensor,
            sensor_module.HelmanGridNetForecastCurrentSensor,
            sensor_module.HelmanGridImportForecastCurrentSensor,
            sensor_module.HelmanGridExportForecastCurrentSensor,
        )
        self.assertEqual(len(classes), 8)
        for cls in classes:
            with self.subTest(cls=cls.__name__):
                entity = cls(coordinator, _FakeEntry())
                self.assertTrue(entity._attr_force_update)

    async def test_battery_forecast_current_entities_shapes(self) -> None:
        # Four Wh series with no device class, for the reason the solar base
        # class documents; one BATTERY percentage. All MEASUREMENT, and each
        # reads its own key off the one coordinator accessor.
        sensor_module = _load_sensor_module()

        coordinator = SimpleNamespace(
            get_battery_forecast_current=lambda: {
                "socPct": 54.0,
                "gridNetWh": -123.456,
                "gridImportWh": 200.0,
                "gridExportWh": 76.544,
                "batteryNetWh": 312.5,
            }
        )
        cases = [
            (sensor_module.HelmanBatterySocForecastCurrentSensor,
             "battery_soc_forecast_current", "%", "battery", 54.0),
            (sensor_module.HelmanBatteryNetForecastCurrentSensor,
             "battery_net_forecast_current", "Wh", None, 312.5),
            (sensor_module.HelmanGridNetForecastCurrentSensor,
             "grid_net_forecast_current", "Wh", None, -123.46),
            (sensor_module.HelmanGridImportForecastCurrentSensor,
             "grid_import_forecast_current", "Wh", None, 200.0),
            (sensor_module.HelmanGridExportForecastCurrentSensor,
             "grid_export_forecast_current", "Wh", None, 76.54),
        ]
        for cls, key, unit, device_class, expected in cases:
            with self.subTest(key=key):
                entity = cls(coordinator, _FakeEntry())
                self.assertEqual(entity.entity_id, f"sensor.helman_{key}")
                self.assertEqual(entity._attr_translation_key, key)
                self.assertEqual(entity._attr_native_unit_of_measurement, unit)
                self.assertEqual(
                    getattr(entity, "_attr_device_class", None), device_class
                )
                self.assertEqual(
                    entity._attr_state_class,
                    sensor_module.SensorStateClass.MEASUREMENT,
                )
                self.assertTrue(entity._attr_has_entity_name)
                self.assertTrue(entity.available)
                self.assertEqual(entity.native_value, expected)

    async def test_battery_forecast_current_entity_is_unavailable_without_its_key(
        self,
    ) -> None:
        # A snapshot slot that predates the grid split carries no gridImportWh,
        # so that sensor reports unavailable rather than zero.
        sensor_module = _load_sensor_module()
        coordinator = SimpleNamespace(
            get_battery_forecast_current=lambda: {"socPct": 40.0}
        )
        entity = sensor_module.HelmanGridImportForecastCurrentSensor(
            coordinator, _FakeEntry()
        )
        self.assertFalse(entity.available)
        self.assertIsNone(entity.native_value)

        none_entity = sensor_module.HelmanBatterySocForecastCurrentSensor(
            SimpleNamespace(get_battery_forecast_current=lambda: None), _FakeEntry()
        )
        self.assertFalse(none_entity.available)

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

    async def test_grid_import_price_entity_shape(self) -> None:
        sensor_module = _load_sensor_module()

        class FakeCoordinator:
            price = 4.25
            unit = "CZK/kWh"

            def get_grid_import_price_current(self):
                return self.price

            def get_grid_import_price_unit(self):
                return self.unit

        coordinator = FakeCoordinator()
        entity = sensor_module.HelmanGridImportPriceSensor(coordinator, _FakeEntry())

        self.assertEqual(entity.entity_id, "sensor.helman_grid_import_price")
        self.assertEqual(entity.native_value, 4.25)
        self.assertEqual(entity.native_unit_of_measurement, "CZK/kWh")
        self.assertTrue(entity.available)
        self.assertEqual(entity._attr_state_class, "measurement")
        # A price is a rate, not an accumulating cost: MONETARY would tell the
        # energy dashboard to sum it.
        self.assertFalse(hasattr(entity, "_attr_device_class"))

        # Unconfigured, or a config the builder could not price: unavailable
        # rather than a stale rate the recorder would archive as still current.
        coordinator.price = None
        coordinator.unit = None
        self.assertFalse(entity.available)
        self.assertIsNone(entity.native_value)
        self.assertIsNone(entity.native_unit_of_measurement)

    async def test_coordinator_absorbs_the_import_price_from_the_snapshot(self) -> None:
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

        coordinator._absorb_grid_import_price(
            {"import": {"status": "available", "unit": "CZK/kWh", "currentPrice": 4.25}}
        )
        self.assertEqual(coordinator.get_grid_import_price_current(), 4.25)
        self.assertEqual(coordinator.get_grid_import_price_unit(), "CZK/kWh")

        # A channel that stopped being priced clears the value: a price that is
        # no longer computed is not a price that has not moved.
        coordinator._absorb_grid_import_price({"import": {"status": "not_configured"}})
        self.assertIsNone(coordinator.get_grid_import_price_current())
        self.assertIsNone(coordinator.get_grid_import_price_unit())

    async def test_grid_export_price_entity_shape(self) -> None:
        sensor_module = _load_sensor_module()

        class FakeCoordinator:
            price = 1.85
            unit = "CZK/kWh"

            def get_grid_export_price_current(self):
                return self.price

            def get_grid_export_price_unit(self):
                return self.unit

        coordinator = FakeCoordinator()
        entity = sensor_module.HelmanGridExportPriceSensor(coordinator, _FakeEntry())

        self.assertEqual(entity.entity_id, "sensor.helman_grid_export_price")
        self.assertEqual(entity.native_value, 1.85)
        self.assertEqual(entity.native_unit_of_measurement, "CZK/kWh")
        self.assertTrue(entity.available)
        # MEASUREMENT is the whole point of this entity: it is what makes the
        # recorder compile long-term statistics, which the configured
        # sell-price entity does not declare and so never gets.
        self.assertEqual(entity._attr_state_class, "measurement")
        self.assertFalse(hasattr(entity, "_attr_device_class"))

        coordinator.price = None
        coordinator.unit = None
        self.assertFalse(entity.available)
        self.assertIsNone(entity.native_value)
        self.assertIsNone(entity.native_unit_of_measurement)

    async def test_coordinator_absorbs_the_export_price_from_the_snapshot(self) -> None:
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

        coordinator._absorb_grid_export_price(
            {"export": {"status": "available", "unit": "CZK/kWh", "currentPrice": 1.85}}
        )
        self.assertEqual(coordinator.get_grid_export_price_current(), 1.85)
        self.assertEqual(coordinator.get_grid_export_price_unit(), "CZK/kWh")

        # "partial" grades the *forecast* -- a sell-price entity that publishes
        # a price but no forward points. The price is exactly what this mirror
        # asks for, so it is taken; refusing it would leave the whole series
        # empty on any setup whose spot integration publishes no attributes.
        coordinator._absorb_grid_export_price(
            {"export": {"status": "partial", "unit": "CZK/kWh", "currentPrice": 2.5}}
        )
        self.assertEqual(coordinator.get_grid_export_price_current(), 2.5)

        # A channel with no price at all clears the value rather than holding
        # the last one: the recorder must not archive a stale rate as current.
        coordinator._absorb_grid_export_price({"export": {"status": "unavailable"}})
        self.assertIsNone(coordinator.get_grid_export_price_current())
        self.assertIsNone(coordinator.get_grid_export_price_unit())

    async def test_current_slot_solar_forecast_is_published_as_power(self) -> None:
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
        coordinator._hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague")
        )
        # REFERENCE_TIME is 21:16, so 21:15 is the slot in progress. The
        # neighbouring slots carry values that would be obvious if picked.
        coordinator._cached_solar_forecast = {
            "rawPoints": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 999.0},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 250.0},
                {"timestamp": "2026-03-20T21:30:00+01:00", "value": 999.0},
            ],
            "correctedPoints": [
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 300.0},
            ],
        }
        now = coordinator_module.dt_util.now
        try:
            coordinator_module.dt_util.now = lambda: REFERENCE_TIME
            # The snapshot's points are already the slot's Wh, so the entity
            # publishes the figure the inspector draws rather than an encoding
            # of it.
            self.assertEqual(
                coordinator.get_solar_forecast_current_wh(corrected=False), 250.0
            )
            self.assertEqual(
                coordinator.get_solar_forecast_current_wh(corrected=True), 300.0
            )

            # No profile applied means no corrected series; the corrected sensor
            # reports the raw number rather than going unavailable, because "not
            # corrected yet" is honestly the same value.
            coordinator._cached_solar_forecast.pop("correctedPoints")
            self.assertEqual(
                coordinator.get_solar_forecast_current_wh(corrected=True), 250.0
            )

            # A snapshot that does not cover the current slot reports nothing
            # rather than the nearest slot it does have.
            coordinator._cached_solar_forecast = {
                "rawPoints": [
                    {"timestamp": "2026-03-20T23:00:00+01:00", "value": 250.0}
                ]
            }
            self.assertIsNone(
                coordinator.get_solar_forecast_current_wh(corrected=False)
            )
            coordinator._cached_solar_forecast = None
            self.assertIsNone(
                coordinator.get_solar_forecast_current_wh(corrected=False)
            )
        finally:
            coordinator_module.dt_util.now = now

    async def test_the_backfill_waits_for_a_unit_before_it_writes_metadata(self) -> None:
        # The first import writes the mirror's statistics metadata. Writing it
        # with a null unit leaves the archived series claiming no unit while the
        # sensor's own states carry one -- a disagreement the recorder surfaces
        # and that nothing here would ever correct. Price and unit are read
        # independently off the snapshot, so a source publishing a bare number
        # has one without the other.
        previous_modules = _install_coordinator_import_stubs()
        try:
            sys.modules.pop("custom_components.helman.coordinator", None)
            coordinator_module = importlib.import_module(
                "custom_components.helman.coordinator"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

        # The starter lazily imports the back-fill module; stand in for it so
        # the import does not drag the whole integration into this stubbed
        # environment. What is under test is the gate, not the walk.
        backfill_stub = types.ModuleType(
            "custom_components.helman.grid_export_price_backfill"
        )

        async def _never_runs(*args, **kwargs):
            return None

        backfill_stub.async_backfill_grid_export_price_statistics = _never_runs
        sys.modules["custom_components.helman.grid_export_price_backfill"] = backfill_stub
        self.addCleanup(
            sys.modules.pop,
            "custom_components.helman.grid_export_price_backfill",
            None,
        )

        started: list[object] = []
        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._grid_export_price_backfill_started = False
        coordinator._get_grid_sell_price_entity_id = lambda: "sensor.spot_sell_price"
        coordinator._hass = SimpleNamespace(
            async_create_background_task=lambda coro, name: (
                coro.close(), started.append(name)
            )[1],
        )

        # A price with no unit: nothing starts.
        coordinator._absorb_grid_export_price(
            {"export": {"status": "partial", "currentPrice": 2.5}}
        )
        coordinator._maybe_start_grid_export_price_backfill()
        self.assertEqual(started, [])
        self.assertFalse(coordinator._grid_export_price_backfill_started)

        # The next beat carries both, and the walk begins.
        coordinator._absorb_grid_export_price(
            {"export": {"status": "partial", "unit": "CZK/kWh", "currentPrice": 2.5}}
        )
        coordinator._maybe_start_grid_export_price_backfill()
        self.assertEqual(len(started), 1)


if __name__ == "__main__":
    unittest.main()
