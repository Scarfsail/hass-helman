"""Regression tests for the source-ratio history buffers filled by the tick.

The Lovelace card colours each consumer's past history bars by attributing the
consumer's power to the sources (solar/battery/grid) using the *recorded* source
ratio history returned by ``get_history()``. Two properties must hold:

1. The ratio history must be **present** in ``get_history()`` at all. The ratio
   deques are created in ``_init_buffers`` (run during the coordinator's
   ``async_setup``), but the ratio *sensor entity objects* are only registered
   later, when the sensor platform calls ``set_sensors``. So the buffers must be
   derived from the device tree, not from ``_source_ratio_sensors`` — otherwise
   the ratio history is missing entirely and the card paints every past consumer
   bucket with its fallback colour instead of the source colour.

2. The ratio deques must advance in lockstep with the power deques (one append
   per tick), so ``applyHistory`` reads an aligned ratio for each bucket.
"""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from collections import deque
from datetime import datetime
from types import SimpleNamespace

# The coordinator pulls in the full Home Assistant import graph. Import it directly
# (the integration is exercised inside an HA test environment); skip cleanly when
# Home Assistant is not importable so this file never breaks unrelated collection.
_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
except Exception as exc:  # pragma: no cover - environment guard
    coordinator_module = None
    _IMPORT_ERROR = exc

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


class _FakeRatioSensor:
    def __init__(self, entity_id: str) -> None:
        self.entity_id = entity_id
        self.last_value: float | None = None

    def update_value(self, value: float) -> None:
        self.last_value = value


class _FakeStates:
    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def get(self, entity_id: str):
        raw = self._mapping.get(entity_id)
        if raw is None:
            return None
        return SimpleNamespace(state=raw)


def _make_coordinator(states: dict[str, str]):
    c = object.__new__(coordinator_module.HelmanCoordinator)
    c._active_config = {"history_buckets": 5, "history_bucket_duration": 1}
    c._hass = SimpleNamespace(states=_FakeStates(states))
    c._power_sensor_ids = [HOUSE, SOLAR, GRID]
    c._source_sensor_ids = [SOLAR, GRID]
    c._source_value_types = {SOLAR: "positive", GRID: "default"}
    # Startup ordering: async_setup builds the buffers BEFORE the sensor platform
    # registers the ratio sensor entities, so this dict is empty at _init_buffers time.
    c._source_ratio_sensors = {}
    c._source_ratio_entity_ids = {}
    c._battery_time_to_full = None
    c._battery_time_to_empty = None
    c._consumption_total_sensor = None
    c._production_total_sensor = None
    c._unmeasured_sensors = {}
    c._cached_tree = TREE
    c._compute_all_unmeasured_powers = lambda: {}
    c._compute_consumption_total = lambda: 1000.0
    c._compute_production_total = lambda: 1000.0
    return c


@unittest.skipIf(coordinator_module is None, "homeassistant not importable in this environment")
class RatioHistoryTests(unittest.TestCase):
    def test_ratio_history_is_present_and_aligned_without_registered_sensors(self):
        # Solar carries the whole 1 kW house load; grid contributes nothing. The ratio
        # sensor entities are NOT registered yet (the startup ordering that broke this).
        c = _make_coordinator({HOUSE: "1000", SOLAR: "1000", GRID: "0"})
        c._init_buffers(TREE)

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

    def test_ratio_sensor_entities_still_updated_when_registered(self):
        c = _make_coordinator({HOUSE: "1000", SOLAR: "1000", GRID: "0"})
        c._init_buffers(TREE)
        # Sensor platform registers the ratio entities after buffers were built.
        solar_sensor = _FakeRatioSensor(SOLAR_RATIO)
        grid_sensor = _FakeRatioSensor(GRID_RATIO)
        c._source_ratio_sensors = {SOLAR: solar_sensor, GRID: grid_sensor}

        c._tick(datetime(2026, 7, 11, 12, 0, 0))

        self.assertEqual(solar_sensor.last_value, 100.0)
        self.assertEqual(grid_sensor.last_value, 0.0)

    def test_ratio_sensors_are_marked_virtual(self):
        c = _make_coordinator({HOUSE: "1000", SOLAR: "1000", GRID: "0"})
        c._init_buffers(TREE)
        # The derived ratio sensors must be excluded from the Step 1 read loop.
        self.assertIn(SOLAR_RATIO, c._virtual_sensor_ids)
        self.assertIn(GRID_RATIO, c._virtual_sensor_ids)


if __name__ == "__main__":
    unittest.main()
