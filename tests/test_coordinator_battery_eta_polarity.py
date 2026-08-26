"""Battery ETAs honour the configured power polarity.

The ETA pair is the one power reading in the coordinator that does not go
through ``value_type``: it works off the raw history buffer and splits it by
sign. That makes it the single place where an inverted battery sensor fails
*silently* -- no exception, no ``unavailable``, just time-to-full and
time-to-empty confidently reporting each other's value. A tree-level fix cannot
reach it, so it is tested on its own.
"""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from datetime import datetime
from types import SimpleNamespace

_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
except Exception:  # pragma: no cover - environment guard
    coordinator_module = None

BATTERY = "sensor.battery_power"
HOUSE = "sensor.house_power"

TREE = {
    "sources": [
        {"id": BATTERY, "powerSensorId": BATTERY, "sourceType": "battery",
         "valueType": "negative", "children": []},
    ],
    "consumers": [
        {"id": "house", "powerSensorId": HOUSE, "valueType": "default", "children": []},
    ],
}


class _FakeEtaSensor:
    def __init__(self) -> None:
        self.minutes: int | None = None

    def update_value(self, minutes, target_time, target_soc) -> None:
        self.minutes = minutes


class _FakeStates:
    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def get(self, entity_id: str):
        raw = self._mapping.get(entity_id)
        return None if raw is None else SimpleNamespace(state=raw)


def _make_coordinator(battery_power: str, polarity: str | None):
    entities = {"power": BATTERY}
    if polarity is not None:
        entities["power_polarity"] = polarity

    c = object.__new__(coordinator_module.HelmanCoordinator)
    c._active_config = {
        "history_buckets": 5,
        "history_bucket_duration": 1,
        "power_devices": {"battery": {"entities": entities}},
    }
    c._hass = SimpleNamespace(states=_FakeStates({BATTERY: battery_power, HOUSE: "1000"}))
    c._power_sensor_ids = [BATTERY, HOUSE]
    c._source_sensor_ids = [BATTERY]
    c._source_value_types = {BATTERY: "negative"}
    c._source_ratio_sensors = {}
    c._source_ratio_entity_ids = {}
    c._consumption_total_sensor = None
    c._production_total_sensor = None
    c._unmeasured_sensors = {}
    c._cached_tree = TREE
    c._compute_all_unmeasured_powers = lambda: {}
    c._compute_consumption_total = lambda: 1000.0
    c._compute_production_total = lambda: 1000.0

    c._battery_time_to_full = _FakeEtaSensor()
    c._battery_time_to_empty = _FakeEtaSensor()
    # Record the average each ETA was handed, so the assertion is about which
    # branch fired rather than about the SoC arithmetic behind it.
    c.charging_avg_seen: list[float] = []
    c.discharging_avg_seen: list[float] = []
    c._compute_charging_eta = lambda avg: (c.charging_avg_seen.append(avg), (60, "", 100))[1]
    c._compute_discharging_eta = lambda avg: (c.discharging_avg_seen.append(avg), (90, "", 10))[1]

    c._init_buffers(TREE)
    return c


def _run(battery_power: str, polarity: str | None):
    c = _make_coordinator(battery_power, polarity)
    for _ in range(3):
        c._tick(datetime(2026, 8, 25, 12, 0, 0))
    return c


@unittest.skipIf(coordinator_module is None, "homeassistant not importable in this environment")
class BatteryEtaPolarityTests(unittest.TestCase):
    def test_default_polarity_reads_positive_as_charging(self):
        c = _run("2000", None)
        self.assertEqual(c.charging_avg_seen, [2000.0, 2000.0, 2000.0])
        self.assertEqual(c.discharging_avg_seen, [])
        self.assertEqual(c._battery_time_to_full.minutes, 60)
        self.assertIsNone(c._battery_time_to_empty.minutes)

    def test_default_polarity_reads_negative_as_discharging(self):
        c = _run("-1500", None)
        self.assertEqual(c.discharging_avg_seen, [1500.0, 1500.0, 1500.0])
        self.assertEqual(c.charging_avg_seen, [])
        self.assertEqual(c._battery_time_to_empty.minutes, 90)

    def test_inverted_polarity_reads_positive_as_discharging(self):
        """The silent-swap case: same reading, opposite meaning."""
        c = _run("2000", "positive_is_discharging")
        self.assertEqual(c.discharging_avg_seen, [2000.0, 2000.0, 2000.0])
        self.assertEqual(c.charging_avg_seen, [])
        self.assertEqual(c._battery_time_to_empty.minutes, 90)
        self.assertIsNone(c._battery_time_to_full.minutes)

    def test_inverted_polarity_reads_negative_as_charging(self):
        c = _run("-1500", "positive_is_discharging")
        self.assertEqual(c.charging_avg_seen, [1500.0, 1500.0, 1500.0])
        self.assertEqual(c.discharging_avg_seen, [])
        self.assertEqual(c._battery_time_to_full.minutes, 60)

    def test_explicit_default_matches_absent_key(self):
        absent = _run("2000", None)
        explicit = _run("2000", "positive_is_charging")
        self.assertEqual(explicit.charging_avg_seen, absent.charging_avg_seen)
        self.assertEqual(explicit.discharging_avg_seen, absent.discharging_avg_seen)


if __name__ == "__main__":
    unittest.main()
