"""Regression tests for the unmeasured remainder published to the card.

The remainder is ``house meter - sum(circuit meters)``. Those meters are not
sampled together: the house meter reports several times a second while each
circuit meter reports every 7-18 s. Once the circuits cover most of the house,
the resulting skew is as large as the remainder itself, so flooring the raw
difference at zero published a hard 0 a large share of the time — and the card
drops the unmeasured row below 1 W, so it kept blinking out of the breakdown.

The coordinator therefore smooths the raw difference before flooring it.
"""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from types import SimpleNamespace

_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
except Exception:  # pragma: no cover - environment guard
    coordinator_module = None

HOUSE = "sensor.house_power"
CIRCUIT_A = "sensor.circuit_a_power"
CIRCUIT_B = "sensor.circuit_b_power"

TREE = {
    "sources": [],
    "consumers": [
        {
            "id": "house",
            "powerSensorId": HOUSE,
            "valueType": "default",
            "children": [
                {"id": CIRCUIT_A, "powerSensorId": CIRCUIT_A, "valueType": "default",
                 "children": []},
                {"id": CIRCUIT_B, "powerSensorId": CIRCUIT_B, "valueType": "default",
                 "children": []},
                {"id": "house_unmeasured", "powerSensorId": "sensor.helman_house_unmeasured_power",
                 "isUnmeasured": True, "valueType": "default", "children": []},
            ],
        },
    ],
}


class _FakeStates:
    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping

    def get(self, entity_id: str):
        raw = self.mapping.get(entity_id)
        if raw is None:
            return None
        return SimpleNamespace(state=raw)


def _make_coordinator(states: dict[str, str]):
    c = object.__new__(coordinator_module.HelmanCoordinator)
    c._active_config = {"history_buckets": 60, "history_bucket_duration": 1}
    c._hass = SimpleNamespace(states=_FakeStates(states))
    c._cached_tree = TREE
    c._unmeasured_raw_history = {}
    return c


@unittest.skipIf(coordinator_module is None, "homeassistant not importable in this environment")
class UnmeasuredSmoothingTests(unittest.TestCase):
    def test_meter_jitter_no_longer_blanks_the_remainder(self):
        # A 100 W remainder under a house meter that jitters +-150 W: every other
        # raw reading is negative, which used to publish 0.
        states = {CIRCUIT_A: "3000", CIRCUIT_B: "900"}
        c = _make_coordinator(states)
        cycle = [150, -150, 100, -100, 50, -50, 0]
        jitter = [cycle[i % len(cycle)] for i in range(25)]

        published: list[float] = []
        for offset in jitter:
            states[HOUSE] = str(4000 + offset)
            published.append(c._compute_all_unmeasured_powers()["house"])

        # Warm-up aside, the row stays on screen and reports the real remainder.
        settled = published[len(jitter) // 2:]
        self.assertTrue(all(value >= 1.0 for value in settled), settled)
        for value in settled:
            self.assertAlmostEqual(value, 100.0, delta=30.0)

    def test_fully_metered_house_still_reports_zero(self):
        # Nothing left over: smoothing must not invent a remainder.
        states = {HOUSE: "3900", CIRCUIT_A: "3000", CIRCUIT_B: "900"}
        c = _make_coordinator(states)
        for _ in range(20):
            value = c._compute_all_unmeasured_powers()["house"]
        self.assertEqual(value, 0.0)

    def test_sustained_step_is_followed(self):
        # A real change (a 2 kW load nobody meters) must reach the sensor, not be
        # smoothed away: within the window length the value tracks the new level.
        states = {HOUSE: "3900", CIRCUIT_A: "3000", CIRCUIT_B: "900"}
        c = _make_coordinator(states)
        for _ in range(20):
            c._compute_all_unmeasured_powers()

        states[HOUSE] = "5900"
        for _ in range(15):  # _UNMEASURED_SMOOTHING_WINDOW_S at a 1 s tick
            value = c._compute_all_unmeasured_powers()["house"]
        self.assertAlmostEqual(value, 2000.0, delta=1.0)

    def test_window_is_reset_when_the_tree_is_rebuilt(self):
        # A rebuild can re-parent a node; its old readings describe other children.
        states = {HOUSE: "4000", CIRCUIT_A: "3000", CIRCUIT_B: "900"}
        c = _make_coordinator(states)
        c._power_sensor_ids = [HOUSE, CIRCUIT_A, CIRCUIT_B]
        c._source_ratio_entity_ids = {}
        for _ in range(10):
            c._compute_all_unmeasured_powers()
        self.assertTrue(c._unmeasured_raw_history)

        c._init_buffers(TREE)
        self.assertEqual(c._unmeasured_raw_history, {})


if __name__ == "__main__":
    unittest.main()
