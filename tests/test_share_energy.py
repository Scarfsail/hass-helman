"""Share energy: a meterless child's share power, accumulated into kWh.

The live tracker sends each share's energy over the tick, and the sensor adds
it to a total it keeps across restarts. The tracker is the real one on the
AC-breaker tree from ``test_share_power``, so the wiring between the split and
the sensor is what is tested.
"""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.components.sensor import SensorExtraStoredData
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.restore_state import RestoreEntity

from custom_components.helman import live_power as live_power_module
from custom_components.helman import sensor as sensor_module
from custom_components.helman.const import SIGNAL_LIVE_TICK, entry_signal
from tests._fakes import FakeConfigEntry, FakeHass, capture_signal, make_coordinator
from tests.test_share_power import (
    BREAKER_POWER,
    HEATER_POWER,
    HOUSE,
    ROOMS,
    _make_tracker,
)

ENERGY = "sensor.helman_share_energy_klima_bartik"
NOW = datetime(2026, 11, 1, 12, 0, 0, tzinfo=timezone.utc)


def _states(**extra: str) -> dict[str, str]:
    return {
        HOUSE: "3000",
        BREAKER_POWER: "1000",
        **{f"climate.{room}": "heat" if room == "bartik" else "off" for room in ROOMS},
        **extra,
    }


class TrackerShareEnergyTests(unittest.TestCase):
    def _tracker(self, **extra: str):
        c = _make_tracker(_states(**extra), metered_child=HEATER_POWER in extra)
        c._source_sensor_ids = []
        c._tick_seconds = 2.0
        return c

    def _sent(self, **extra: str) -> dict:
        c = self._tracker(**extra)
        c._energy_since = NOW - timedelta(seconds=2)
        sent = capture_signal(c._hass, SIGNAL_LIVE_TICK)
        c._tick(NOW)
        return sent[0]

    def test_each_share_sends_its_energy_over_the_tick(self) -> None:
        sent = self._sent()

        # 1,000 W for a 2 s tick, and 0 W for the children that are off.
        self.assertAlmostEqual(sent[ENERGY], 1000 * 2 / 3_600_000)
        self.assertEqual(sent["sensor.helman_share_energy_klima_obyvak"], 0.0)

    def test_energy_spans_the_real_time_since_the_last_tick_across_a_restart(self) -> None:
        c = self._tracker()
        sent = capture_signal(c._hass, SIGNAL_LIVE_TICK)
        with patch.object(live_power_module, "async_track_time_interval"):
            c._start_tick()
            started = c._energy_since
            # A tree rebuild restarts the timer, but keeps the interval open.
            c._stop_tick()
            c._start_tick()
        self.assertEqual(c._energy_since, started)

        # The tracker's config ticks every second.
        c._tick(started + timedelta(seconds=2.5))
        # A stall far longer than a tick is capped at three ticks.
        c._tick(started + timedelta(seconds=2.5 + 600))

        self.assertAlmostEqual(sent[0][ENERGY], 1000 * 2.5 / 3_600_000)
        self.assertAlmostEqual(sent[1][ENERGY], 1000 * 3 / 3_600_000)

    def test_an_unavailable_share_sends_no_energy(self) -> None:
        sent = self._sent(**{HEATER_POWER: "unavailable"})

        self.assertIsNone(sent["sensor.helman_share_power_klima_bartik"])
        self.assertNotIn(ENERGY, sent)


class ShareEnergySensorTests(unittest.IsolatedAsyncioTestCase):
    async def _added(
        self,
        *,
        restored: float | None,
        start: list | None = None,
        sensor=None,
    ):
        self.hass = FakeHass()
        self.entry = FakeConfigEntry()
        if sensor is None:
            sensor = sensor_module.HelmanShareEnergySensor(
                self.entry, "klima-bartik", "Bartík"
            )
        sensor.hass = self.hass
        sensor.async_write_ha_state = Mock()
        last = None if restored is None else SensorExtraStoredData(restored, "kWh")
        # The starting total each attempt finds; by default the restored one.
        self.start = AsyncMock(side_effect=start or [restored])
        with (
            patch.object(RestoreEntity, "async_added_to_hass", AsyncMock()),
            patch.object(
                sensor_module.HelmanShareEnergySensor,
                "async_get_last_sensor_data",
                AsyncMock(return_value=last),
            ),
            patch.object(sensor_module, "async_initial_share_energy_total", self.start),
            patch.object(
                sensor_module.HelmanShareEnergySensor, "_START_RETRY_SECONDS", 0
            ),
        ):
            await sensor.async_added_to_hass()
            for _ in range(5):
                await asyncio.sleep(0)
        return sensor

    def _tick(self, values: dict) -> None:
        async_dispatcher_send(
            self.hass, entry_signal(SIGNAL_LIVE_TICK, self.entry.entry_id), values
        )

    async def test_identity(self) -> None:
        sensor = await self._added(restored=0.0)

        self.assertEqual(sensor.entity_id, ENERGY)
        self.assertEqual(sensor.unique_id, "helman-entry_share_energy_klima-bartik")
        self.assertEqual(sensor.name, "Share energy — Bartík")
        self.assertEqual(sensor.state_class, "total_increasing")
        self.assertEqual(sensor.device_class, "energy")
        self.assertEqual(sensor.native_unit_of_measurement, "kWh")

    async def test_tick_energy_accumulates_into_the_total(self) -> None:
        sensor = await self._added(restored=1.0)

        for _ in range(36):
            self._tick({ENERGY: 1000 * 10 / 3_600_000})

        # 1 kW for 360 s is 0.1 kWh.
        self.assertAlmostEqual(sensor._total, 1.1)
        self.assertEqual(sensor.native_value, 1.1)

    async def test_ticks_without_its_energy_add_nothing(self) -> None:
        sensor = await self._added(restored=1.0)

        self._tick({"sensor.helman_share_power_klima_bartik": None})

        self.assertEqual(sensor._total, 1.0)
        self.assertTrue(sensor.available)

    async def test_the_restored_total_is_handed_to_the_start_and_its_answer_published(
        self,
    ) -> None:
        # The recorder held a later total than the restore file.
        sensor = await self._added(restored=4.25, start=[4.5])

        self.start.assert_awaited_once_with(
            self.hass,
            restored=4.25,
            source_entity_id="sensor.helman_share_power_klima_bartik",
            target_entity_id=ENERGY,
            store_key="helman-entry_share_energy_klima-bartik",
        )
        self.assertEqual(sensor.native_value, 4.5)
        sensor.async_write_ha_state.assert_called_once()

    async def test_the_unrounded_total_is_restored(self) -> None:
        sensor = await self._added(restored=1.0)
        self._tick({ENERGY: 0.004})

        self.assertEqual(sensor.native_value, 1.0)
        self.assertEqual(sensor.extra_restore_state_data.native_value, 1.004)

    async def test_a_rename_keeps_the_total_held_in_memory(self) -> None:
        sensor = await self._added(restored=2.0)
        self._tick({ENERGY: 0.5})

        # Home Assistant re-adds the same object under the new id, with nothing
        # restored there.
        sensor = await self._added(restored=None, sensor=sensor)

        self.assertEqual(sensor.native_value, 2.5)
        self.start.assert_not_called()

    async def test_the_total_never_decreases(self) -> None:
        sensor = await self._added(restored=2.0)
        published = []
        sensor.async_write_ha_state = Mock(
            side_effect=lambda: published.append(sensor.native_value)
        )

        for watts in (0.0, 1500.0, 0.0, 300.0, 2000.0, 0.0):
            self._tick({ENERGY: watts * 60 / 3_600_000})

        self.assertEqual(published, sorted(published))
        self.assertGreater(sensor._total, 2.0)

    async def test_unavailable_until_the_total_is_known_and_retried_after_a_failure(
        self,
    ) -> None:
        # The first attempt fails, and the sensor is removed during the retry.
        sensor = await self._added(restored=None, start=[None, asyncio.CancelledError()])

        self.assertFalse(sensor.available)
        self.assertEqual(self.start.await_count, 2)
        # Ticks before the total is known are dropped.
        self._tick({ENERGY: 0.5})
        self.assertIsNone(sensor.native_value)

    async def test_a_failed_start_is_retried_until_it_publishes(self) -> None:
        sensor = await self._added(restored=None, start=[None, None, 7.5])

        self.assertEqual(self.start.await_count, 3)
        self.assertTrue(sensor.available)
        self.assertEqual(sensor.native_value, 7.5)
        sensor.async_write_ha_state.assert_called_once()

        self._tick({ENERGY: 0.25})
        self.assertEqual(sensor.native_value, 7.75)


class ShareEntityLifecycleTests(unittest.TestCase):
    def test_a_share_energy_sensor_comes_and_goes_with_its_share_power_sensor(self) -> None:
        coordinator = make_coordinator(_hass=FakeHass())
        added: list = []
        coordinator._async_add_entities = added.extend
        entry = FakeConfigEntry()
        coordinator._dynamic_sensor_factories = {
            "share": lambda node_id, entity_id, name: [
                sensor_module.HelmanSharePowerSensor(entry, node_id, entity_id, name),
                sensor_module.HelmanShareEnergySensor(entry, node_id, name),
            ]
        }
        coordinator._tree_index = SimpleNamespace(
            qualifying_nodes={},
            share_devices={
                "klima-bartik": ("sensor.helman_share_power_klima_bartik", "Bartík")
            },
        )
        registry = Mock()
        with patch(
            "custom_components.helman.coordinator.er.async_get", return_value=registry
        ):
            coordinator._sync_derived_sensors()
            self.assertEqual(
                [entity.entity_id for entity in added],
                ["sensor.helman_share_power_klima_bartik", ENERGY],
            )

            coordinator._tree_index = SimpleNamespace(qualifying_nodes={}, share_devices={})
            coordinator._sync_derived_sensors()

        self.assertEqual(
            [c.args[0] for c in registry.async_remove.call_args_list],
            ["sensor.helman_share_power_klima_bartik", ENERGY],
        )


if __name__ == "__main__":
    unittest.main()
