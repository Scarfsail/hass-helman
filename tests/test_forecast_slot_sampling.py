"""The slot-resolution rule shared by the house and battery forecast readers.

Extracted from ``forecast_slot_history`` (whose module docstring is the full
account of why): a current-slot forecast sensor is written at the *end* of a
rebuild that fires on the slot beat, so a slot's forecast lands a fraction of a
second after the slot start. Taking "the last row at or before ``slot_start``"
drew the whole curve one slot late; the rule here is "the first row *inside* the
slot, else whatever was standing".
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
    (
        "custom_components.helman.solar_bias_correction",
        ROOT / "custom_components" / "helman" / "solar_bias_correction",
    ),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

from custom_components.helman.solar_bias_correction.forecast_slot_sampling import (  # noqa: E402
    resolve_forecast_slot_values,
)

TZ = timezone(timedelta(hours=2))
DAY = datetime(2026, 5, 10, tzinfo=TZ)
SLOT_STARTS = [DAY + timedelta(minutes=15 * i) for i in range(96)]


def _at(hhmm: str, *, after_seconds: float = 0.0) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return DAY.replace(hour=hour, minute=minute) + timedelta(seconds=after_seconds)


class ResolveForecastSlotValuesTests(unittest.TestCase):
    def _by_label(self, result):
        return {start.strftime("%H:%M"): value for start, value in result.items()}

    def test_a_write_just_after_the_beat_is_its_own_slots_value(self):
        timeline = [
            (_at("10:00", after_seconds=0.3), 40.0),
            (_at("10:15", after_seconds=0.4), 55.0),
        ]
        by_label = self._by_label(
            resolve_forecast_slot_values(timeline, SLOT_STARTS, slot_minutes=15)
        )
        self.assertEqual(by_label["10:00"], 40.0)
        self.assertEqual(by_label["10:15"], 55.0)
        # Held forward past the last write.
        self.assertEqual(by_label["23:45"], 55.0)
        # Nothing before the first write.
        self.assertNotIn("09:45", by_label)

    def test_a_write_exactly_on_the_boundary_still_belongs_to_the_slot(self):
        timeline = [(_at("10:00"), 40.0), (_at("10:15"), 55.0)]
        by_label = self._by_label(
            resolve_forecast_slot_values(timeline, SLOT_STARTS, slot_minutes=15)
        )
        self.assertEqual(by_label["10:00"], 40.0)
        self.assertEqual(by_label["10:15"], 55.0)

    def test_a_later_write_in_the_same_slot_is_a_revision_and_passed_over(self):
        timeline = [
            (_at("10:15", after_seconds=0.4), 40.0),
            (_at("10:15", after_seconds=300), 99.0),
        ]
        by_label = self._by_label(
            resolve_forecast_slot_values(timeline, SLOT_STARTS, slot_minutes=15)
        )
        self.assertEqual(by_label["10:15"], 40.0)
        # The revision still updates what stands for the next empty slot.
        self.assertEqual(by_label["10:30"], 99.0)

    def test_a_none_row_clears_the_standing_value_rather_than_being_skipped(self):
        # forecast_slot_history's contract: a gap must not mint forecast data.
        timeline = [
            (_at("10:00", after_seconds=0.3), 40.0),
            (_at("10:40"), None),
        ]
        by_label = self._by_label(
            resolve_forecast_slot_values(timeline, SLOT_STARTS, slot_minutes=15)
        )
        self.assertEqual(by_label["10:00"], 40.0)
        # 40.0 still stands across the empty slot before the None.
        self.assertEqual(by_label["10:15"], 40.0)
        # The None falls in 10:30's window and clears the hold; from there on
        # nothing is emitted -- a skip would have held 40.0 to midnight.
        self.assertNotIn("10:30", by_label)
        self.assertNotIn("23:45", by_label)

    def test_first_numeric_row_inside_the_slot_wins_even_after_a_none(self):
        timeline = [
            (_at("10:00", after_seconds=0.3), 40.0),
            (_at("10:15", after_seconds=0.1), None),
            (_at("10:15", after_seconds=5), 60.0),
        ]
        by_label = self._by_label(
            resolve_forecast_slot_values(timeline, SLOT_STARTS, slot_minutes=15)
        )
        self.assertEqual(by_label["10:15"], 60.0)

    def test_a_dropout_straddling_a_boundary_blanks_the_slot_it_straddles(self):
        # The cost the sampler's docstring owns up to: a sub-second dropout
        # whose restoring row lands in the next slot leaves the straddled slot
        # with nothing standing and no numeric row of its own, so it is blanked
        # even though the forecast held for all but a fraction of it.
        timeline = [
            (_at("10:00", after_seconds=0.3), 40.0),
            (_at("10:29", after_seconds=59.9), None),
            (_at("10:30", after_seconds=0.2), 40.0),
        ]
        by_label = self._by_label(
            resolve_forecast_slot_values(timeline, SLOT_STARTS, slot_minutes=15)
        )
        self.assertEqual(by_label["10:00"], 40.0)
        self.assertNotIn("10:15", by_label)
        # The restore starts a fresh hold in its own slot.
        self.assertEqual(by_label["10:30"], 40.0)

    def test_empty_timeline_yields_nothing(self):
        self.assertEqual(
            resolve_forecast_slot_values([], SLOT_STARTS, slot_minutes=15), {}
        )


if __name__ == "__main__":
    unittest.main()
