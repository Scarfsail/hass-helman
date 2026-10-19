"""Regression tests for the source-ratio history buffers filled by the tick.

The Lovelace card colours each consumer's past history bars by attributing the
consumer's power to the sources (solar/battery/grid) using the *recorded* source
ratio history returned by ``get_history()``. Two properties must hold:

1. The ratio history must be **present** in ``get_history()`` at all. The ratio
   deques are created in ``LivePowerTracker._init_buffers`` (run during the
   coordinator's ``async_setup``), but the ratio *sensor entities* are only added later, by
   the sensor platform. So the buffers must be derived from the device tree —
   otherwise the ratio history is missing entirely and the card paints every
   past consumer bucket with its fallback colour instead of the source colour.

2. The ratio deques must advance in lockstep with the power deques (one append
   per tick), so ``applyHistory`` reads an aligned ratio for each bucket.
"""

from __future__ import annotations

from custom_components.helman.tree_builder import TreeIndex
from custom_components.helman.const import SIGNAL_LIVE_TICK
from tests._fakes import FakeHass, capture_signal, make_live_tracker

import unittest
from datetime import datetime
from types import SimpleNamespace

HOUSE = "sensor.house_power"
SOLAR = "sensor.solar_power"
GRID = "sensor.grid_power"
SOLAR_RATIO = "sensor.helman_solar_source_ratio"
GRID_RATIO = "sensor.helman_grid_source_ratio"

# The device tree exactly as get_device_tree would return it: source nodes carry
# their ratioSensorId, which is what _init_buffers derives the ratio buffers from.
TREE = {
    "sources": [
        {"id": SOLAR, "powerSensorId": SOLAR, "sourceType": "solar",
         "valueType": "positive", "ratioSensorId": SOLAR_RATIO, "children": []},
        {"id": GRID, "powerSensorId": GRID, "sourceType": "grid",
         "valueType": "default", "ratioSensorId": GRID_RATIO, "children": []},
    ],
    "consumers": [
        {"id": "house", "powerSensorId": HOUSE, "valueType": "default", "children": []},
    ],
}


class _FakeStates:
    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def get(self, entity_id: str):
        raw = self._mapping.get(entity_id)
        if raw is None:
            return None
        return SimpleNamespace(state=raw)


def _make_tracker(states: dict[str, str]):
    hass = FakeHass()
    hass.states = _FakeStates(states)
    c = make_live_tracker(
        hass, {"visualization": {"history_buckets": 5, "history_bucket_duration": 1}}
    )
    c._compute_derived_powers = lambda: ({}, {})
    c._compute_consumption_total = lambda: 1000.0
    c._compute_production_total = lambda: 1000.0
    return c


class RatioHistoryTests(unittest.TestCase):
    def test_ratio_history_is_present_and_aligned_without_registered_sensors(self):
        # Solar carries the whole 1 kW house load; grid contributes nothing. The ratio
        # sensor entities are NOT registered yet (the startup ordering that broke this).
        c = _make_tracker({HOUSE: "1000", SOLAR: "1000", GRID: "0"})
        c._init_buffers(TREE, TreeIndex.from_tree(TREE))

        ticks = 3  # fewer than history_buckets (5) so any desync would show as length skew
        for _ in range(ticks):
            c._tick(datetime(2026, 7, 11, 12, 0, 0))

        history = c.get_history()["entity_history"]

        # (1) The ratio history must exist at all — this is the bug the card hit.
        self.assertIn(SOLAR_RATIO, history)
        self.assertIn(GRID_RATIO, history)

        # (2) One append per tick, aligned with the consumer power buffer.
        self.assertEqual(len(history[HOUSE]), ticks)
        self.assertEqual(len(history[SOLAR_RATIO]), ticks)
        self.assertEqual(len(history[GRID_RATIO]), ticks)

        # Pure computed ratios: all solar, no grid, no interleaved zeros.
        self.assertEqual(history[SOLAR_RATIO], [100.0, 100.0, 100.0])
        self.assertEqual(history[GRID_RATIO], [0.0, 0.0, 0.0])

    def test_the_tick_sends_each_ratio_under_its_entity_id(self):
        c = _make_tracker({HOUSE: "1000", SOLAR: "1000", GRID: "0"})
        c._init_buffers(TREE, TreeIndex.from_tree(TREE))
        sent = capture_signal(c._hass, SIGNAL_LIVE_TICK)

        c._tick(datetime(2026, 7, 11, 12, 0, 0))

        self.assertEqual(sent[0][SOLAR_RATIO], 100.0)
        self.assertEqual(sent[0][GRID_RATIO], 0.0)

    def test_ratio_sensors_are_marked_virtual(self):
        c = _make_tracker({HOUSE: "1000", SOLAR: "1000", GRID: "0"})
        c._init_buffers(TREE, TreeIndex.from_tree(TREE))
        # The derived ratio sensors must be excluded from the Step 1 read loop.
        self.assertIn(SOLAR_RATIO, c._virtual_sensor_ids)
        self.assertIn(GRID_RATIO, c._virtual_sensor_ids)


if __name__ == "__main__":
    unittest.main()
