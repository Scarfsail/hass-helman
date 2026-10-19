"""Battery ETAs honour the configured power polarity.

The ETA pair is the one power reading in the live tick that does not go
through ``value_type``: it works off the raw history buffer and splits it by
sign. That makes it the single place where an inverted battery sensor fails
*silently* -- no exception, no ``unavailable``, just time-to-full and
time-to-empty confidently reporting each other's value. A tree-level fix cannot
reach it, so it is tested on its own.
"""

from __future__ import annotations

from custom_components.helman.tree_builder import TreeIndex
from custom_components.helman.const import (
    BATTERY_TIME_TO_EMPTY_ENTITY_ID,
    BATTERY_TIME_TO_FULL_ENTITY_ID,
    SIGNAL_LIVE_TICK,
)
from tests._fakes import FakeHass, capture_signal, make_live_tracker

import unittest
from datetime import datetime
from types import SimpleNamespace

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


class _FakeStates:
    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def get(self, entity_id: str):
        raw = self._mapping.get(entity_id)
        return None if raw is None else SimpleNamespace(state=raw)


def _make_tracker(battery_power: str, polarity: str | None):
    entities = {"power": BATTERY}
    if polarity is not None:
        entities["power_polarity"] = polarity

    hass = FakeHass()
    hass.states = _FakeStates({BATTERY: battery_power, HOUSE: "1000"})
    c = make_live_tracker(
        hass,
        {
            "visualization": {"history_buckets": 5, "history_bucket_duration": 1},
            "energy_nodes": {"battery": {"entities": entities}},
        },
    )
    c._compute_derived_powers = lambda: ({}, {})
    c._compute_consumption_total = lambda: 1000.0
    c._compute_production_total = lambda: 1000.0

    c.sent = capture_signal(c._hass, SIGNAL_LIVE_TICK)
    # Record the average each ETA was handed, so the assertion is about which
    # branch fired rather than about the SoC arithmetic behind it.
    c.charging_avg_seen: list[float] = []
    c.discharging_avg_seen: list[float] = []
    c._compute_charging_eta = lambda avg: (c.charging_avg_seen.append(avg), (60, "", 100))[1]
    c._compute_discharging_eta = lambda avg: (c.discharging_avg_seen.append(avg), (90, "", 10))[1]

    c._init_buffers(TREE, TreeIndex.from_tree(TREE))
    return c


def _minutes(c, entity_id: str):
    """The minutes the last tick sent for one ETA sensor."""
    return c.sent[-1][entity_id][0]


def _run(battery_power: str, polarity: str | None):
    c = _make_tracker(battery_power, polarity)
    for _ in range(3):
        c._tick(datetime(2026, 8, 25, 12, 0, 0))
    return c


class BatteryEtaPolarityTests(unittest.TestCase):
    def test_default_polarity_reads_positive_as_charging(self):
        c = _run("2000", None)
        self.assertEqual(c.charging_avg_seen, [2000.0, 2000.0, 2000.0])
        self.assertEqual(c.discharging_avg_seen, [])
        self.assertEqual(_minutes(c, BATTERY_TIME_TO_FULL_ENTITY_ID), 60)
        self.assertIsNone(_minutes(c, BATTERY_TIME_TO_EMPTY_ENTITY_ID))

    def test_default_polarity_reads_negative_as_discharging(self):
        c = _run("-1500", None)
        self.assertEqual(c.discharging_avg_seen, [1500.0, 1500.0, 1500.0])
        self.assertEqual(c.charging_avg_seen, [])
        self.assertEqual(_minutes(c, BATTERY_TIME_TO_EMPTY_ENTITY_ID), 90)

    def test_inverted_polarity_reads_positive_as_discharging(self):
        """The silent-swap case: same reading, opposite meaning."""
        c = _run("2000", "positive_is_discharging")
        self.assertEqual(c.discharging_avg_seen, [2000.0, 2000.0, 2000.0])
        self.assertEqual(c.charging_avg_seen, [])
        self.assertEqual(_minutes(c, BATTERY_TIME_TO_EMPTY_ENTITY_ID), 90)
        self.assertIsNone(_minutes(c, BATTERY_TIME_TO_FULL_ENTITY_ID))

    def test_inverted_polarity_reads_negative_as_charging(self):
        c = _run("-1500", "positive_is_discharging")
        self.assertEqual(c.charging_avg_seen, [1500.0, 1500.0, 1500.0])
        self.assertEqual(c.discharging_avg_seen, [])
        self.assertEqual(_minutes(c, BATTERY_TIME_TO_FULL_ENTITY_ID), 60)

    def test_explicit_default_matches_absent_key(self):
        absent = _run("2000", None)
        explicit = _run("2000", "positive_is_charging")
        self.assertEqual(explicit.charging_avg_seen, absent.charging_avg_seen)
        self.assertEqual(explicit.discharging_avg_seen, absent.discharging_avg_seen)


if __name__ == "__main__":
    unittest.main()


def test_tick_tolerates_null_energy_nodes_and_battery():
    for nodes in (None, {"battery": None}, {"battery": {"entities": None}}):
        tracker = _make_tracker("2000", None)
        tracker._read_config()["energy_nodes"] = nodes
        tracker._tick(datetime(2026, 8, 25, 12, 0, 0))
        assert tracker.charging_avg_seen == []
        assert tracker.discharging_avg_seen == []


def test_a_raising_eta_still_sends_the_other_live_values():
    tracker = _make_tracker("2000", None)

    def boom(_avg):
        raise RuntimeError("odd battery state")

    tracker._compute_charging_eta = boom
    tracker._tick(datetime(2026, 8, 25, 12, 0, 0))

    (values,) = tracker.sent
    assert values["sensor.helman_consumer_total_power"] == 1000.0
    assert BATTERY_TIME_TO_FULL_ENTITY_ID not in values
