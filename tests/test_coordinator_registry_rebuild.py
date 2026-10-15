"""Registry rebuilds retain live history and stop at unload."""

from __future__ import annotations

from custom_components.helman.tree_builder import TreeIndex

import asyncio
import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from tests._fakes import FakeHass, FakeState, make_coordinator
from custom_components.helman import coordinator as coordinator_module
from custom_components.helman.vendors import DeviceTelemetry, PROFILES


TREE = {
    "sources": [],
    "consumers": [
        {"id": "house", "powerSensorId": "sensor.house_power", "children": [{"id": "house_unmeasured", "isUnmeasured": True, "powerSensorId": "sensor.helman_unmeasured"}]}
    ],
}


class RegistryRebuildTests(unittest.IsolatedAsyncioTestCase):
    async def test_registry_rebuild_cannot_arm_tick_after_unload(self) -> None:
        coordinator = make_coordinator(_hass=FakeHass())
        coordinator._cached_tree = TREE
        coordinator._buffer_tree = TREE
        entered = asyncio.Event()
        release = asyncio.Event()
        armed = []
        stopped = []

        async def slow_tree():
            entered.set()
            await release.wait()
            coordinator._tree_index = TreeIndex.from_tree({**TREE, "consumers": []})
            return {**TREE, "consumers": []}

        coordinator.get_device_tree = slow_tree
        coordinator._sync_derived_sensors = AsyncMock()
        coordinator._unsub_tick = lambda: stopped.append(True)
        coordinator._automation_triggers.async_shutdown = AsyncMock()
        coordinator._schedule_executor.async_unload = AsyncMock()
        with patch.object(
            coordinator_module,
            "async_track_time_interval",
            side_effect=lambda *_args: armed.append(True) or (lambda: None),
        ):
            coordinator._on_registry_updated(
                SimpleNamespace(data={"entity_id": "sensor.unrelated"})
            )
            await entered.wait()
            await coordinator.async_unload()
            release.set()
            await asyncio.sleep(0)

        self.assertEqual(stopped, [True])
        self.assertEqual(armed, [])
        self.assertIsNone(coordinator._unsub_tick)

    async def test_unrelated_registry_event_keeps_history(self) -> None:
        coordinator = make_coordinator(_hass=FakeHass())
        coordinator._cached_tree = TREE
        coordinator._power_sensor_ids = ["sensor.house_power"]
        coordinator._init_buffers(TREE, TreeIndex.from_tree(TREE))
        history = coordinator._power_history["sensor.house_power"]
        history.append(123.0)
        coordinator.get_device_tree = AsyncMock(return_value=TREE)
        coordinator._sync_derived_sensors = AsyncMock()
        coordinator._start_tick = lambda: None

        coordinator._on_registry_updated(
            SimpleNamespace(data={"entity_id": "sensor.unrelated"})
        )
        await asyncio.sleep(0)

        self.assertIs(coordinator._power_history["sensor.house_power"], history)
        self.assertEqual(list(history), [123.0])

    async def test_unchanged_tree_refreshes_renamed_inverter_telemetry(self) -> None:
        states = {
            "sensor.old_ac_l1": FakeState("100"),
            "sensor.new_ac_l1": FakeState("300"),
        }
        for phase in (1, 2, 3):
            states[f"sensor.grid_l{phase}"] = FakeState("0")
            if phase != 1:
                states[f"sensor.ac_l{phase}"] = FakeState("100")
        coordinator = make_coordinator(_hass=FakeHass(states))
        coordinator._cached_tree = TREE
        coordinator._power_sensor_ids = ["sensor.house_power"]
        profile = PROFILES["solax_inverter"]
        entities = {key: None for key in profile.telemetry}
        entities.update(
            {
                "ac_power_l1": "sensor.old_ac_l1",
                **{f"ac_power_l{phase}": f"sensor.ac_l{phase}" for phase in (2, 3)},
                **{f"grid_power_l{phase}": f"sensor.grid_l{phase}" for phase in (1, 2, 3)},
            }
        )

        def resolve_telemetry(_hass, _config):
            return {
                "inverter": DeviceTelemetry(
                    profile=profile, entry=None, entities=entities.copy()
                )
            }

        with patch.object(coordinator_module, "resolve_vendor_telemetry", side_effect=resolve_telemetry):
            coordinator._init_buffers(TREE, TreeIndex.from_tree(TREE))
            history = coordinator._power_history["sensor.house_power"]
            history.append(123.0)
            self.assertEqual(coordinator._compute_house_phase_powers()[1], 100.0)
            entities["ac_power_l1"] = "sensor.new_ac_l1"
            coordinator.get_device_tree = AsyncMock(return_value=TREE)

            coordinator._on_registry_updated(
                SimpleNamespace(data={"entity_id": "sensor.new_ac_l1"})
            )
            await asyncio.sleep(0)

        self.assertEqual(coordinator._compute_house_phase_powers()[1], 300.0)
        self.assertIs(coordinator._power_history["sensor.house_power"], history)
        self.assertEqual(list(history), [123.0])

    async def test_changed_tree_keeps_surviving_history(self) -> None:
        coordinator = make_coordinator(_hass=FakeHass())
        coordinator._cached_tree = TREE
        coordinator._power_sensor_ids = ["sensor.house_power"]
        coordinator._init_buffers(TREE, TreeIndex.from_tree(TREE))
        history = coordinator._power_history["sensor.house_power"]
        history.append(123.0)
        raw_history = deque([20.0, 30.0], maxlen=3)
        coordinator._unmeasured_raw_history["house"] = raw_history
        new_tree = {
            **TREE,
            "consumers": [
                *TREE["consumers"],
                {"id": "other", "powerSensorId": "sensor.other_power", "children": []},
            ],
        }
        coordinator._tree_index = TreeIndex.from_tree(new_tree)
        coordinator.get_device_tree = AsyncMock(return_value=new_tree)
        coordinator._sync_derived_sensors = AsyncMock()
        coordinator._start_tick = lambda: None

        await coordinator._async_rebuild_subscriptions()

        self.assertEqual(
            list(coordinator._power_history["sensor.house_power"]), [123.0]
        )
        self.assertEqual(list(coordinator._power_history["sensor.other_power"]), [])
        self.assertIs(coordinator._unmeasured_raw_history["house"], raw_history)


if __name__ == "__main__":
    unittest.main()
