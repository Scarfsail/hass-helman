from __future__ import annotations

import asyncio
import sys
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from custom_components.helman.solar_bias_correction import (  # noqa: E402
    forecast_slot_history as mod,
)

TZ = ZoneInfo("Europe/Prague")
HASS = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))


def _state(local_iso: str, value):
    return SimpleNamespace(state=value, last_changed=datetime.fromisoformat(local_iso))


def _read(states, first: date, last: date | None = None):
    """Run the reader against a stubbed recorder returning ``states``."""

    class _Recorder:
        @staticmethod
        async def async_add_executor_job(func):
            return {mod.SOLAR_FORECAST_CURRENT_ENTITY: states}

    with patch.object(mod, "get_instance", lambda hass: _Recorder()):
        return asyncio.run(
            mod.load_forecast_slots_for_window(
                HASS, first_date=first, last_date=last or first
            )
        )


class SlotSamplingTests(unittest.TestCase):
    def test_a_boundary_write_belongs_to_the_slot_it_opens(self):
        """The refresh fires at the boundary and the write lands a moment later.

        Sampling exactly at the boundary would hold the *previous* slot's value
        and shift the whole curve one slot early — every slot scored against its
        neighbour's forecast.
        """
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "1000"),
                _state("2026-04-24T09:15:00.380+02:00", "2000"),
            ],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        # 1000 W over a quarter hour is 250 Wh.
        self.assertEqual(slots["09:00"], 250.0)
        self.assertEqual(slots["09:15"], 500.0)

    def test_a_mid_slot_republication_does_not_displace_the_slot_in_progress(self):
        """The provider revises the running slot hours into the day.

        That revision is the measurement being retired: the slot keeps what was
        believed when it began.
        """
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "1000"),
                _state("2026-04-24T09:07:30+02:00", "9999"),
                _state("2026-04-24T09:15:00.380+02:00", "2000"),
            ],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertEqual(slots["09:00"], 250.0)
        self.assertEqual(slots["09:15"], 500.0)

    def test_a_flat_stretch_keeps_every_slot(self):
        """Home Assistant records a row only when the value moves.

        Two slots forecast alike share one row, and treating the second as
        missing would blank most of the night and every overcast hour.
        """
        days = _read(
            [_state("2026-04-24T09:00:00.412+02:00", "1000")],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertEqual(slots["09:00"], 250.0)
        self.assertEqual(slots["09:15"], 250.0)
        self.assertEqual(slots["23:45"], 250.0)

    def test_slots_before_the_first_write_are_absent(self):
        """Helman started mid-day: nothing was believed about the morning."""
        days = _read(
            [_state("2026-04-24T09:00:00.412+02:00", "1000")],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertNotIn("08:45", slots)
        self.assertEqual(min(slots), "09:00")

    def test_unparseable_states_are_skipped(self):
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "unavailable"),
                _state("2026-04-24T09:15:00.380+02:00", None),
                _state("2026-04-24T09:30:00.400+02:00", "2000"),
            ],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertNotIn("09:00", slots)
        self.assertEqual(slots["09:30"], 500.0)


class WindowTests(unittest.TestCase):
    def test_one_read_serves_every_day_in_the_window(self):
        days = _read(
            [
                _state("2026-04-23T09:00:00.412+02:00", "1000"),
                _state("2026-04-24T09:00:00.380+02:00", "2000"),
            ],
            date(2026, 4, 23),
            date(2026, 4, 24),
        )

        self.assertEqual(sorted(days), ["2026-04-23", "2026-04-24"])
        self.assertEqual(days["2026-04-23"]["09:00"], 250.0)
        self.assertEqual(days["2026-04-24"]["09:00"], 500.0)
        # The value holds across midnight rather than restarting the day empty.
        self.assertEqual(days["2026-04-24"]["00:00"], 250.0)

    def test_a_window_with_no_history_is_empty(self):
        self.assertEqual(_read([], date(2026, 4, 24)), {})

    def test_an_inverted_window_is_empty(self):
        self.assertEqual(
            _read([_state("2026-04-24T09:00:00+02:00", "1000")], date(2026, 4, 24), date(2026, 4, 23)),
            {},
        )

    def test_no_recorder_instance_is_not_an_error(self):
        with patch.object(mod, "get_instance", lambda hass: None):
            days = asyncio.run(
                mod.load_forecast_slots_for_window(
                    HASS, first_date=date(2026, 4, 24), last_date=date(2026, 4, 24)
                )
            )
        self.assertEqual(days, {})


class SingleDayTests(unittest.TestCase):
    def test_the_day_helper_returns_that_day_alone(self):
        class _Recorder:
            @staticmethod
            async def async_add_executor_job(func):
                return {
                    mod.SOLAR_FORECAST_CURRENT_ENTITY: [
                        _state("2026-04-24T09:00:00.412+02:00", "1000")
                    ]
                }

        with patch.object(mod, "get_instance", lambda hass: _Recorder()):
            slots = asyncio.run(mod.load_forecast_slots_for_day(HASS, date(2026, 4, 24)))

        self.assertEqual(slots["09:00"], 250.0)

    def test_a_day_with_nothing_recorded_is_empty(self):
        class _Recorder:
            @staticmethod
            async def async_add_executor_job(func):
                return {}

        with patch.object(mod, "get_instance", lambda hass: _Recorder()):
            slots = asyncio.run(mod.load_forecast_slots_for_day(HASS, date(2026, 4, 24)))

        self.assertEqual(slots, {})


if __name__ == "__main__":
    unittest.main()
