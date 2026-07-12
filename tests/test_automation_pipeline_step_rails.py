"""Unit tests for the per-step mutable rail capture (inspector before/after).

The automation inspector renders each optimizer's effect as a before->after
delta, so ``_capture_step_rails`` must surface every system parameter an
optimizer can move: surplus, SoC, and the effective grid import/export energy.
"""

from __future__ import annotations

import unittest
import zoneinfo
from types import SimpleNamespace

from homeassistant.util import dt as dt_util

from custom_components.helman.automation import pipeline as P

_SLOT_ID = "2026-03-20T21:00:00+01:00"


class CaptureStepRailsTest(unittest.TestCase):
    def setUp(self) -> None:
        dt_util.set_default_time_zone(zoneinfo.ZoneInfo("Europe/Prague"))

    def _snapshot(self) -> SimpleNamespace:
        return SimpleNamespace(
            grid_forecast={
                "series": [
                    {"timestamp": _SLOT_ID, "availableSurplusKwh": 2.0},
                ]
            },
            battery_forecast={
                "series": [
                    {
                        "timestamp": _SLOT_ID,
                        "socPct": 55.0,
                        "importedFromGridKwh": 0.3,
                        "exportedToGridKwh": 1.1,
                    },
                ]
            },
        )

    def test_captures_all_mutable_parameters(self) -> None:
        rails = P._capture_step_rails(self._snapshot(), (_SLOT_ID,))
        self.assertEqual(
            rails,
            {
                "availableSurplusKwh": [2.0],
                "batterySocPct": [55.0],
                "importedFromGridKwh": [0.3],
                "exportedToGridKwh": [1.1],
            },
        )

    def test_slots_without_coverage_are_none(self) -> None:
        # A later slot with no forecast bucket stays None on every rail.
        later = "2026-03-20T21:30:00+01:00"
        rails = P._capture_step_rails(self._snapshot(), (_SLOT_ID, later))
        for key in (
            "availableSurplusKwh",
            "batterySocPct",
            "importedFromGridKwh",
            "exportedToGridKwh",
        ):
            self.assertIsNone(rails[key][1], key)


if __name__ == "__main__":
    unittest.main()
