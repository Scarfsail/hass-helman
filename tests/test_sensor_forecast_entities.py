from __future__ import annotations
import sys
import types
from homeassistant.helpers.dispatcher import async_dispatcher_send

from custom_components.helman.const import (
    SIGNAL_FORECAST_PUBLISHED,
    SIGNAL_LIVE_TICK,
    SLOT_ALIGNED_REFRESH_REASON,
    entry_signal,
)
from tests._fakes import FakeConfigEntry, FakeHass, make_coordinator

import importlib
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from datetime import datetime

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")

def _load_coordinator_module():
    return importlib.import_module("custom_components.helman.coordinator")

def _load_sensor_module():
    return importlib.import_module("custom_components.helman.sensor")


class _FakeEntry:
    entry_id = "entry-1"


class ForecastSensorEntityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from homeassistant.util import dt as dt_util

        patcher = patch.object(dt_util, "now", return_value=REFERENCE_TIME)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_async_setup_entry_tolerates_null_energy_nodes(self):
        sensor_module = _load_sensor_module()
        for nodes in (None, {"battery": None}, {"battery": {"entities": None}}):
            coordinator = SimpleNamespace(
                get_device_tree=AsyncMock(
                    return_value={"sources": [], "consumers": []}
                ),
                config={"energy_nodes": nodes},
                set_entity_factory=Mock(),
            )
            entities = []
            await sensor_module.async_setup_entry(
                SimpleNamespace(), FakeConfigEntry(runtime_data=coordinator), entities.extend
            )
            self.assertTrue(entities)

    async def test_async_setup_entry_adds_the_forecast_and_price_entities(
        self,
    ) -> None:
        sensor_module = _load_sensor_module()
        coordinator = SimpleNamespace(
            get_device_tree=AsyncMock(return_value={"sources": [], "consumers": []}),
            config={},
            set_entity_factory=Mock(),
        )
        added_entities: list[object] = []

        await sensor_module.async_setup_entry(
            SimpleNamespace(),
            FakeConfigEntry(runtime_data=coordinator),
            added_entities.extend,
        )

        # The nine day-total forecast sensors, then the ten that read the
        # current slot or rate: the house consumption forecast, the two
        # current-slot solar forecasts, the five current-slot battery
        # forecasts, and the two price sensors.
        self.assertEqual(
            [entity.entity_id for entity in added_entities[-19:]],
            [
                "sensor.helman_solar_forecast_today",
                "sensor.helman_solar_forecast_tomorrow",
                *(f"sensor.helman_solar_forecast_d{day}" for day in range(2, 8)),
                "sensor.helman_solar_forecast_today_remaining",
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
        # Every one of them is written by the forecast publish signal.
        self.assertTrue(
            all(
                isinstance(entity, sensor_module._HelmanPublishedSensor)
                for entity in added_entities[-19:]
            )
        )
        # The tree-sized sensors are the coordinator's to add.
        async_add_entities, factories = coordinator.set_entity_factory.call_args.args
        self.assertEqual(set(factories), {"unmeasured", "share"})

    async def _added(self, entity):
        """``entity`` as the platform leaves it: on a hass and subscribed."""
        entity.hass = self._hass
        entity.async_write_ha_state = Mock()
        await entity.async_added_to_hass()
        return entity

    async def test_the_publish_signal_writes_on_every_reason_but_the_battery_beat(
        self,
    ) -> None:
        sensor_module = _load_sensor_module()
        self._hass = FakeHass()
        entry = FakeConfigEntry()
        coordinator = SimpleNamespace()
        published = [
            await self._added(sensor_module.HelmanSolarForecastCurrentSensor(coordinator, entry)),
            await self._added(sensor_module.HelmanGridImportPriceSensor(coordinator, entry)),
        ]
        battery = await self._added(
            sensor_module.HelmanBatterySocForecastCurrentSensor(coordinator, entry)
        )
        signal = entry_signal(SIGNAL_FORECAST_PUBLISHED, entry.entry_id)

        async_dispatcher_send(self._hass, signal, "startup")
        self.assertEqual([e.async_write_ha_state.call_count for e in published], [1, 1])
        battery.async_write_ha_state.assert_not_called()

        async_dispatcher_send(self._hass, signal, SLOT_ALIGNED_REFRESH_REASON)
        self.assertEqual([e.async_write_ha_state.call_count for e in published], [2, 2])
        battery.async_write_ha_state.assert_called_once_with()

        # Another entry's publish is not this entity's.
        async_dispatcher_send(
            self._hass, entry_signal(SIGNAL_FORECAST_PUBLISHED, "other"), "startup"
        )
        self.assertEqual([e.async_write_ha_state.call_count for e in published], [2, 2])

    async def test_the_live_tick_hands_each_sensor_its_own_value(self) -> None:
        sensor_module = _load_sensor_module()
        self._hass = FakeHass()
        entry = FakeConfigEntry()
        total = await self._added(sensor_module.HelmanConsumptionTotalSensor(entry))
        phase = await self._added(sensor_module.HelmanHousePhasePowerSensor(entry, 2))
        ratio = await self._added(sensor_module.HelmanSourceRatioSensor(entry, "solar"))
        eta = await self._added(
            sensor_module.HelmanBatteryTimeSensor(entry, [], "charging")
        )
        share = await self._added(
            sensor_module.HelmanSharePowerSensor(
                entry, "klima", "sensor.helman_share_power_klima", "Klima"
            )
        )
        # A rename in the registry does not detach a sensor from its value.
        total.entity_id = "sensor.my_total"

        async_dispatcher_send(
            self._hass,
            entry_signal(SIGNAL_LIVE_TICK, entry.entry_id),
            {
                "sensor.helman_consumer_total_power": 1234.4,
                "sensor.helman_house_consumption_power_l2": None,
                "sensor.helman_solar_source_ratio": 33.333,
                "sensor.helman_battery_time_to_full": (42.26, "2026-03-20T22:00:00", 100),
            },
        )

        self.assertEqual(total.native_value, 1234)
        self.assertFalse(phase.available)
        self.assertEqual(ratio.native_value, 33.3)
        self.assertEqual(eta.native_value, 42.3)
        self.assertEqual(eta.extra_state_attributes["target_soc"], 100)
        # No value for it in this tick: left alone, not written.
        share.async_write_ha_state.assert_not_called()

    async def test_a_raising_live_sensor_does_not_stop_the_others(self) -> None:
        sensor_module = _load_sensor_module()
        self._hass = FakeHass()
        entry = FakeConfigEntry()
        first = await self._added(sensor_module.HelmanConsumptionTotalSensor(entry))
        second = await self._added(sensor_module.HelmanProductionTotalSensor(entry))
        first.async_write_ha_state.side_effect = RuntimeError("write failed")

        with self.assertLogs("homeassistant.helpers.dispatcher", "ERROR"):
            async_dispatcher_send(
                self._hass,
                entry_signal(SIGNAL_LIVE_TICK, entry.entry_id),
                {
                    "sensor.helman_consumer_total_power": 100.0,
                    "sensor.helman_house_supply_power": 200.0,
                },
            )

        second.async_write_ha_state.assert_called_once_with()
        self.assertEqual(second.native_value, 200)

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
        coordinator_module = _load_coordinator_module()

        coordinator = make_coordinator()
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
        coordinator_module = _load_coordinator_module()

        coordinator = make_coordinator()
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
        coordinator_module = _load_coordinator_module()

        coordinator = make_coordinator()
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
        coordinator_module = _load_coordinator_module()

        coordinator = make_coordinator()

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
            schedule: dict = {"2026-09-09T10:00:00+02:00": 1.85}

            def get_grid_export_price_current(self):
                return self.price

            def get_grid_export_price_unit(self):
                return self.unit

            def get_grid_export_price_schedule(self):
                return dict(self.schedule)

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
        self.assertIsNone(entity.native_value)
        self.assertIsNone(entity.native_unit_of_measurement)
        # Still available: Home Assistant merges `extra_state_attributes` into
        # a state only while the entity is available, so gating on the price
        # alone would drop tomorrow's published prices exactly when today's
        # price went missing.
        self.assertTrue(entity.available)

        coordinator.schedule = {}
        self.assertFalse(entity.available)

    async def test_grid_export_price_entity_publishes_the_owned_schedule(self) -> None:
        sensor_module = _load_sensor_module()

        class FakeCoordinator:
            schedule: dict = {
                "2026-09-09T10:00:00+02:00": 1.85,
                "2026-09-09T11:00:00+02:00": 0.0,
                "2026-09-10T02:00:00+02:00": -0.4,
            }

            def get_grid_export_price_current(self):
                return 1.85

            def get_grid_export_price_unit(self):
                return "CZK/kWh"

            def get_grid_export_price_schedule(self):
                return dict(self.schedule)

        coordinator = FakeCoordinator()
        entity = sensor_module.HelmanGridExportPriceSensor(coordinator, _FakeEntry())

        # The source's own key text, verbatim, and its own numbers -- zero and
        # negative included.
        self.assertEqual(
            entity.extra_state_attributes,
            {
                "2026-09-09T10:00:00+02:00": 1.85,
                "2026-09-09T11:00:00+02:00": 0.0,
                "2026-09-10T02:00:00+02:00": -0.4,
            },
        )

        # The whole map is republished on every read, so a timestamp the source
        # dropped -- or a provider the configuration replaced -- leaves nothing
        # of itself behind beside the new schedule.
        coordinator.schedule = {"2026-09-10T02:00:00+02:00": 2.2}
        self.assertEqual(
            entity.extra_state_attributes,
            {"2026-09-10T02:00:00+02:00": 2.2},
        )

        coordinator.schedule = {}
        self.assertEqual(entity.extra_state_attributes, {})

    async def test_coordinator_absorbs_the_export_price_from_the_snapshot(self) -> None:
        coordinator_module = _load_coordinator_module()

        coordinator = make_coordinator()

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

        # The unit is the source's, not the reading's. A source that went
        # `unknown` while its attribute map still holds tomorrow's prices keeps
        # the mirror available, and an available mirror publishing a schedule
        # without a unit would say something the source never did.
        coordinator._absorb_grid_export_price(
            {
                "export": {
                    "status": "partial",
                    "unit": "CZK/kWh",
                    "schedule": {"2026-09-10T01:00:00+02:00": 3.1},
                }
            }
        )
        self.assertIsNone(coordinator.get_grid_export_price_current())
        self.assertEqual(coordinator.get_grid_export_price_unit(), "CZK/kWh")

    async def test_coordinator_owns_the_export_schedule_from_one_ingestion(self) -> None:
        coordinator_module = _load_coordinator_module()
        coordinator = make_coordinator()

        coordinator._absorb_grid_export_price(
            {
                "export": {
                    "status": "available",
                    "unit": "CZK/kWh",
                    "currentPrice": 1.85,
                    "schedule": {
                        "2026-09-09T10:00:00+02:00": 1.85,
                        "2026-09-09T11:00:00+02:00": 0.0,
                    },
                }
            }
        )
        self.assertEqual(
            coordinator.get_grid_export_price_schedule(),
            {
                "2026-09-09T10:00:00+02:00": 1.85,
                "2026-09-09T11:00:00+02:00": 0.0,
            },
        )

        # An attribute-only update: the price has not moved, the schedule has,
        # and the owned channel must move with it or the sensor would keep
        # publishing yesterday's attributes.
        coordinator._absorb_grid_export_price(
            {
                "export": {
                    "status": "available",
                    "unit": "CZK/kWh",
                    "currentPrice": 1.85,
                    "schedule": {
                        "2026-09-09T10:00:00+02:00": 2.4,
                        "2026-09-10T02:00:00+02:00": -0.4,
                    },
                }
            }
        )
        self.assertEqual(coordinator.get_grid_export_price_current(), 1.85)
        # Replaced whole: the 11:00 entry the source dropped is gone, not kept.
        self.assertEqual(
            coordinator.get_grid_export_price_schedule(),
            {
                "2026-09-09T10:00:00+02:00": 2.4,
                "2026-09-10T02:00:00+02:00": -0.4,
            },
        )

        # The current price can go missing while the schedule stands -- a spot
        # provider that stops publishing a state keeps publishing tomorrow --
        # and neither answer is allowed to stand in for the other.
        coordinator._absorb_grid_export_price(
            {
                "export": {
                    "status": "partial",
                    "unit": "CZK/kWh",
                    "schedule": {"2026-09-10T02:00:00+02:00": -0.4},
                }
            }
        )
        self.assertIsNone(coordinator.get_grid_export_price_current())
        self.assertEqual(
            coordinator.get_grid_export_price_schedule(),
            {"2026-09-10T02:00:00+02:00": -0.4},
        )

        # A source or configuration change: nothing of the old provider's
        # schedule survives into the new one's.
        coordinator._absorb_grid_export_price({"export": {"status": "not_configured"}})
        self.assertIsNone(coordinator.get_grid_export_price_current())
        self.assertEqual(coordinator.get_grid_export_price_schedule(), {})

        # The accessor hands out a copy: a consumer cannot edit the owned map.
        coordinator._absorb_grid_export_price(
            {"export": {"schedule": {"2026-09-10T02:00:00+02:00": 1.0}}}
        )
        coordinator.get_grid_export_price_schedule().clear()
        self.assertEqual(
            coordinator.get_grid_export_price_schedule(),
            {"2026-09-10T02:00:00+02:00": 1.0},
        )

    async def test_only_ingestion_reads_the_configured_sell_price_entity(self) -> None:
        coordinator_module = _load_coordinator_module()
        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        coordinator._grid_export_price_channel = None

        channel = {
            "status": "available",
            "unit": "CZK/kWh",
            "currentPrice": 1.85,
            "points": [],
            "schedule": {"2026-09-09T10:00:00+02:00": 1.85},
        }
        source_reads = Mock(return_value=channel)

        with patch.object(
            coordinator_module,
            "GridPriceForecastBuilder",
            return_value=SimpleNamespace(
                build_export_price_snapshot=source_reads
            ),
        ):
            # The cold read is an ingestion, and it is the last one: every
            # consumer afterwards is served from the owned channel.
            self.assertIs(coordinator._get_grid_export_price_channel(), channel)
            self.assertIs(coordinator._get_grid_export_price_channel(), channel)
            self.assertIs(coordinator._get_grid_export_price_channel(), channel)
            self.assertEqual(source_reads.call_count, 1)

            # Ingestion, and only ingestion, goes back to the source.
            coordinator._ingest_grid_export_price()
            self.assertEqual(source_reads.call_count, 2)

        self.assertEqual(coordinator.get_grid_export_price_current(), 1.85)
        self.assertEqual(coordinator.get_grid_export_price_unit(), "CZK/kWh")
        self.assertEqual(
            coordinator.get_grid_export_price_schedule(),
            {"2026-09-09T10:00:00+02:00": 1.85},
        )

    async def test_current_slot_solar_forecast_is_published_as_power(self) -> None:
        coordinator_module = _load_coordinator_module()

        coordinator = make_coordinator()
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
        coordinator_module = _load_coordinator_module()

        async def _never_runs(*args, **kwargs):
            return None

        patcher = patch(
            "custom_components.helman.grid_export_price_backfill."
            "async_backfill_grid_export_price_statistics",
            _never_runs,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        started: list[object] = []
        coordinator = make_coordinator()
        job = next(
            j
            for j in coordinator._backfill_jobs
            if j.name == "helman_grid_export_price_backfill"
        )
        coordinator._get_grid_sell_price_entity_id = lambda: "sensor.spot_sell_price"
        coordinator._hass.async_create_background_task = (
            lambda coro, name: (coro.close(), started.append(name))[1]
        )

        # A price with no unit: nothing starts.
        coordinator._absorb_grid_export_price(
            {"export": {"status": "partial", "currentPrice": 2.5}}
        )
        coordinator._maybe_start_backfill_jobs()
        self.assertEqual(started, [])
        self.assertFalse(job.started)

        # The next beat carries both, and the walk begins.
        coordinator._absorb_grid_export_price(
            {"export": {"status": "partial", "unit": "CZK/kWh", "currentPrice": 2.5}}
        )
        coordinator._maybe_start_backfill_jobs()
        self.assertEqual(len(started), 1)
        self.assertTrue(job.started)
        self.assertEqual(started[0], "helman_grid_export_price_backfill")



if __name__ == "__main__":
    unittest.main()
