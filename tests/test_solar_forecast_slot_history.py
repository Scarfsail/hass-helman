from __future__ import annotations

import asyncio
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from custom_components.helman import solar_forecast_backfill as backfill_mod  # noqa: E402
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
                _state("2026-04-24T09:00:00.412+02:00", "250"),
                _state("2026-04-24T09:15:00.380+02:00", "500"),
            ],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertEqual(slots["09:00"], 250.0)
        self.assertEqual(slots["09:15"], 500.0)

    def test_a_mid_slot_republication_does_not_displace_the_slot_in_progress(self):
        """The provider revises the running slot hours into the day.

        That revision is the measurement being retired: the slot keeps what was
        believed when it began.
        """
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "250"),
                _state("2026-04-24T09:07:30+02:00", "9999"),
                _state("2026-04-24T09:15:00.380+02:00", "500"),
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
            [_state("2026-04-24T09:00:00.412+02:00", "250")],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertEqual(slots["09:00"], 250.0)
        self.assertEqual(slots["09:15"], 250.0)
        self.assertEqual(slots["23:45"], 250.0)

    def test_slots_before_the_first_write_are_absent(self):
        """Helman started mid-day: nothing was believed about the morning."""
        days = _read(
            [_state("2026-04-24T09:00:00.412+02:00", "250")],
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
                _state("2026-04-24T09:30:00.400+02:00", "500"),
            ],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertNotIn("09:00", slots)
        self.assertEqual(slots["09:30"], 500.0)


    def test_an_unavailable_row_ends_the_hold(self):
        """Otherwise an outage mints forecast the trainer then fits to.

        Home Assistant writes an ``unavailable`` when the integration stops, so
        carrying 09:00's value across the rest of the day would put a number on
        every slot nothing was ever believed about.
        """
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "250"),
                _state("2026-04-24T09:20:00+02:00", "unavailable"),
                _state("2026-04-24T14:00:00.380+02:00", "500"),
            ],
            date(2026, 4, 24),
        )

        slots = days["2026-04-24"]
        self.assertEqual(slots["09:00"], 250.0)
        # 09:15 holds only the unavailable, so nothing was published for it.
        for missing in ("09:15", "09:30", "11:00", "13:45"):
            self.assertNotIn(missing, slots)
        self.assertEqual(slots["14:00"], 500.0)

    def test_a_restart_blip_inside_a_slot_still_resolves_it(self):
        """An unavailable followed a second later by the value is not a gap.

        The slot takes its first *numeric* row, so only a slot whose every row
        is non-numeric goes missing.
        """
        days = _read(
            [
                _state("2026-04-24T09:15:00+02:00", "unavailable"),
                _state("2026-04-24T09:15:01+02:00", "500"),
            ],
            date(2026, 4, 24),
        )

        self.assertEqual(days["2026-04-24"]["09:15"], 500.0)

    def test_a_slow_boundary_write_still_belongs_to_its_slot(self):
        """The publish happens at the end of a long rebuild, not at the tick.

        A fixed sampling offset would hand this slot the previous slot's value
        and lag the whole training series by one slot, silently.
        """
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "250"),
                _state("2026-04-24T09:17:40+02:00", "500"),
            ],
            date(2026, 4, 24),
        )

        self.assertEqual(days["2026-04-24"]["09:15"], 500.0)

    def test_a_mid_slot_republication_does_not_win_over_the_boundary_write(self):
        days = _read(
            [
                _state("2026-04-24T09:00:00.412+02:00", "250"),
                _state("2026-04-24T09:02:53+02:00", "9999"),
            ],
            date(2026, 4, 24),
        )

        self.assertEqual(days["2026-04-24"]["09:00"], 250.0)


class WindowTests(unittest.TestCase):
    def test_one_read_serves_every_day_in_the_window(self):
        days = _read(
            [
                _state("2026-04-23T09:00:00.412+02:00", "250"),
                _state("2026-04-24T09:00:00.380+02:00", "500"),
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
            _read([_state("2026-04-24T09:00:00+02:00", "250")], date(2026, 4, 24), date(2026, 4, 23)),
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
                        _state("2026-04-24T09:00:00.412+02:00", "250")
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


class HourlyStatisticsConversionTests(unittest.TestCase):
    """``forecast_slots_from_hourly_statistics``: the tail's rows as a slot map.

    The one number that is silently wrong when it is wrong -- a constant factor
    on every tail day's forecast, absorbed by the fit, mispricing every future
    slot -- so the ``_KWH_TO_WH`` half is pinned against
    ``solar_forecast_backfill``'s own row builder rather than a hand-written
    mean. Both the training-window splice and the inspector's statistics day
    read through this one function.
    """

    def test_the_hours_forecast_is_recovered_from_the_row_the_backfill_writes(self):

        hour = datetime(2026, 5, 1, 11, 0, tzinfo=TZ).astimezone(timezone.utc)
        slots = [1000.0, 1400.0, 1800.0, 1200.0]
        rows = backfill_mod._hourly_rows(
            [
                (hour + timedelta(minutes=15 * index), value)
                for index, value in enumerate(slots)
            ],
            utc_start=hour,
            utc_end=hour + timedelta(hours=1),
        )

        # The span read asks for the energy class in kWh and the sensor records
        # Wh, so this is what actually reaches the reader.
        recovered = mod.forecast_slots_from_hourly_statistics(
            {hour: {"mean": rows[0]["mean"] / 1000.0}}, local_tz=TZ
        )

        day = recovered["2026-05-01"]
        self.assertEqual(sorted(day), ["11:00", "11:15", "11:30", "11:45"])
        # The hour's forecast energy is the four slots summed -- the energy the
        # source published for that hour, not a quarter of it and not four times.
        self.assertAlmostEqual(sum(day.values()), sum(slots), places=3)
        # Each slot carries a quarter of the hour: a weight, not a claim about
        # how the hour was shaped.
        for value in day.values():
            self.assertAlmostEqual(value, sum(slots) / 4.0, places=3)

    def test_a_repeated_local_hour_is_added_not_overwritten(self):

        # Two distinct UTC hours that share the 02:00 local wall clock on the
        # autumn fall-back day: both really happened and both are kept.
        first = datetime(2025, 10, 26, 0, 0, tzinfo=timezone.utc)
        second = datetime(2025, 10, 26, 1, 0, tzinfo=timezone.utc)

        recovered = mod.forecast_slots_from_hourly_statistics(
            {first: {"mean": 0.3}, second: {"mean": 0.5}}, local_tz=TZ
        )

        day = recovered["2025-10-26"]
        self.assertEqual(day["02:00"], 800.0)

    def test_a_row_without_a_mean_is_skipped(self):
        hour = datetime.fromisoformat("2026-05-01T09:00:00+00:00")
        recovered = mod.forecast_slots_from_hourly_statistics(
            {hour: {"mean": None}}, local_tz=TZ
        )
        self.assertEqual(recovered, {})


if __name__ == "__main__":
    unittest.main()
