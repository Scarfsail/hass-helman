"""A device's usage record: its days, its runs, and the power it runs at."""

from __future__ import annotations

import importlib
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo




device_stats = importlib.import_module("custom_components.helman.training.device_stats")
recorder_module = importlib.import_module(
    "custom_components.helman.shared_meter_fit"
)

UTC = timezone.utc
DAY_START = datetime(2026, 3, 20, tzinfo=UTC)
DAY_END = DAY_START + timedelta(days=1)


def _at(hour: int, minute: int = 0, second: int = 0, *, day: int = 20) -> datetime:
    return datetime(2026, 3, day, hour, minute, second, tzinfo=UTC)


def _power(*readings: tuple[str | float, datetime]) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(state=str(value), last_updated=instant)
        for value, instant in readings
    ]


def _record(power, *, running=None, on_kwh_per_hour=None):
    """A metered device's record over one UTC day, from its power alone."""
    return device_stats.metered_record(
        window_start=DAY_START,
        window_end=DAY_END,
        daily_kwh=[],
        days=[],
        power_states=power,
        running=running,
        on_kwh_per_hour=on_kwh_per_hour,
    )


def _floor(power) -> float:
    return device_stats._standby_floor(
        device_stats.power_pieces(power, "default", DAY_START, DAY_END)
    )


class DailyTests(unittest.TestCase):
    def test_a_dst_day_is_its_real_length(self) -> None:
        # Prague springs forward on 29 March: a 23-hour day, not the 24 its
        # wall clock suggests.
        prague = ZoneInfo("Europe/Prague")

        midnights = device_stats.local_midnights(
            datetime(2026, 3, 28, tzinfo=prague),
            datetime(2026, 3, 31, tzinfo=prague),
            prague,
        )

        self.assertEqual(
            [end - start for start, end in zip(midnights, midnights[1:])],
            [timedelta(hours=24), timedelta(hours=23), timedelta(hours=24)],
        )

    def test_runs_per_day_count_only_the_days_the_recorder_still_holds(self) -> None:
        # A three-day window whose power history was purged before the last
        # day: one run in that day is one run a day, not a third of one.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=3),
            daily_kwh=[0.0, 0.0, 1.0],
            days=[
                (DAY_START + timedelta(days=day), DAY_START + timedelta(days=day + 1))
                for day in range(3)
            ],
            power_states=_power(
                (0, _at(0, day=22)), (1000, _at(10, day=22)), (0, _at(11, day=22))
            ),
        )

        self.assertEqual(record["runs_per_day"], 1.0)
        # Nor are the purged days zero-run days.
        self.assertEqual(record["daily_runs"], {"min": 1, "max": 1})

    def test_an_unavailable_stretch_is_not_counted_as_idle_time(self) -> None:
        # Two days of window, one of them unavailable: one run in the day
        # observed is one run a day.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=2),
            daily_kwh=[],
            days=[],
            power_states=_power(
                (0, _at(0)),
                (1000, _at(10)),
                (0, _at(11)),
                ("unavailable", _at(0, day=21)),
            ),
        )

        self.assertEqual(record["runs_per_day"], 1.0)

    def test_daily_runs_leave_out_runs_clipped_by_the_window(self) -> None:
        # One whole run a day, plus a run already on when the window opens
        # and one still on when it closes.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=2),
            daily_kwh=[1.0, 1.0],
            days=[(DAY_START, DAY_END), (DAY_END, DAY_END + timedelta(days=1))],
            power_states=_power(
                (1000, DAY_START),
                (0, _at(1)),
                (1000, _at(10)),
                (0, _at(11)),
                (1000, _at(10, day=21)),
                (0, _at(11, day=21)),
                (1000, _at(23, day=21)),
            ),
        )

        self.assertEqual(record["daily_runs"], {"min": 1, "max": 1})

    def test_daily_runs_leave_out_a_day_the_power_sensor_was_offline(self) -> None:
        # One run a day, but the power sensor is unavailable all of the
        # middle day while the meter keeps reading.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=3),
            daily_kwh=[1.0, 1.0, 1.0],
            days=[
                (DAY_START + timedelta(days=day), DAY_START + timedelta(days=day + 1))
                for day in range(3)
            ],
            power_states=_power(
                (0, _at(0)),
                (1000, _at(10)),
                (0, _at(11)),
                ("unavailable", _at(0, day=21)),
                (0, _at(0, day=22)),
                (1000, _at(10, day=22)),
                (0, _at(11, day=22)),
            ),
        )

        self.assertEqual(record["runs_per_day"], 1.0)
        self.assertEqual(record["daily_runs"], {"min": 1, "max": 1})

    def test_daily_runs_leave_out_a_day_the_running_signal_was_unavailable(
        self,
    ) -> None:
        # One run on each outer day, but the running signal is unavailable
        # all of the middle day while the power sensor keeps reading.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=3),
            daily_kwh=[1.0, 1.0, 1.0],
            days=[
                (DAY_START + timedelta(days=day), DAY_START + timedelta(days=day + 1))
                for day in range(3)
            ],
            power_states=_power(
                (0, _at(0)),
                (1000, _at(10)),
                (0, _at(11)),
                (1000, _at(10, day=21)),
                (0, _at(11, day=21)),
                (1000, _at(10, day=22)),
                (0, _at(11, day=22)),
            ),
            running=[(_at(10), _at(11)), (_at(10, day=22), _at(11, day=22))],
            observed=[(DAY_START, _at(0, day=21)), (_at(0, day=22), _at(0, day=23))],
        )

        self.assertEqual(record["runs_per_day"], 0.6667)
        self.assertEqual(record["daily_runs"], {"min": 1, "max": 1})

    def test_without_a_power_sensor_only_the_days_and_the_signal_figure(self) -> None:
        plain = device_stats.metered_record(
            window_start=DAY_START, window_end=DAY_END, daily_kwh=[1.0, 2.0], days=[]
        )
        signalled = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_END,
            daily_kwh=[1.0, 2.0],
            days=[],
            on_kwh_per_hour=0.5,
        )

        self.assertEqual(set(plain), {"daily_kwh"})
        self.assertEqual(set(signalled), {"daily_kwh", "on_kwh_per_hour"})
        self.assertEqual(signalled["on_kwh_per_hour"], 0.5)


class PowerRunTests(unittest.TestCase):
    def test_runs_clipped_by_either_edge_are_dropped(self) -> None:
        record = _record(
            _power(
                (1000, DAY_START),
                (0, _at(1)),
                (1000, _at(10)),
                (0, _at(11)),
                (1000, _at(23)),
            )
        )

        self.assertEqual(record["runs_per_day"], 1.0)
        self.assertEqual(record["run_minutes"], {"median": 60.0, "min": 60.0, "max": 60.0})
        self.assertEqual(record["run_kwh"], {"median": 1.0, "min": 1.0, "max": 1.0})
        # The clipped runs still drew at that power.
        self.assertEqual(record["running_kw"], 1.0)

    def test_a_boiler_on_for_three_hours_heating_for_one(self) -> None:
        """``on_kwh_per_hour`` keeps the idle on-time; ``running_kw`` does not."""
        switch = [
            SimpleNamespace(state="off", last_updated=DAY_START),
            SimpleNamespace(state="on", last_updated=_at(10)),
            SimpleNamespace(state="off", last_updated=_at(13)),
        ]
        meter = [
            SimpleNamespace(
                state=str(value),
                attributes={"unit_of_measurement": "kWh"},
                last_updated=instant,
            )
            for value, instant in ((0.0, DAY_START), (0.0, _at(10)), (2.0, _at(11)), (2.0, DAY_END))
        ]
        on_kwh_per_hour = recorder_module._estimate_shared_meter_hourly_energy_kwh(
            {"boiler": (switch, ("on",))}, meter, DAY_START, DAY_END, "kWh"
        ).estimates["boiler"]
        running = recorder_module._build_active_state_intervals(
            states=switch, window_start=DAY_START, window_end=DAY_END, active_states=("on",)
        )

        record = _record(
            _power((0, DAY_START), (2000, _at(10)), (0, _at(11))),
            running=running,
            on_kwh_per_hour=on_kwh_per_hour,
        )

        self.assertEqual(record["running_kw"], 2.0)
        self.assertAlmostEqual(
            record["on_kwh_per_hour"] / record["running_kw"], 1 / 3, places=3
        )

    def test_a_breaker_always_on_runs_only_while_it_draws(self) -> None:
        """Its switch never goes off; 5 W standby, 500 W loads twice a day."""
        record = _record(
            _power(
                (5, DAY_START),
                (500, _at(2)),
                (5, _at(3)),
                (500, _at(14)),
                (5, _at(16)),
            ),
            running=[(DAY_START, DAY_END)],
        )

        self.assertEqual(record["runs_per_day"], 2.0)
        self.assertEqual(record["run_minutes"], {"median": 90.0, "min": 60.0, "max": 120.0})
        # 1.5 kWh over 3 running hours, not over the 24 the switch was on.
        self.assertEqual(record["running_kw"], 0.5)

    def test_a_rare_runner_is_detected_above_its_standby(self) -> None:
        """30 minutes at 1 kW in a day of 3 W: p95 is the standby itself."""
        power = _power((3, DAY_START), (1000, _at(12)), (3, _at(12, 30)))

        record = _record(power)

        self.assertAlmostEqual(_floor(power), 3.0)
        self.assertEqual(record["runs_per_day"], 1.0)
        self.assertEqual(record["run_minutes"]["median"], 30.0)
        self.assertEqual(record["running_kw"], 1.0)

    def test_a_near_constant_runner_is_detected_above_its_one_idle_hour(self) -> None:
        """1 kW for all but seventy minutes: the one idle hour sets the floor."""
        power = _power((3, DAY_START), (1000, _at(1)), (3, _at(23, 50)))

        record = _record(power)

        self.assertAlmostEqual(_floor(power), 3.0)
        self.assertEqual(record["runs_per_day"], 1.0)
        self.assertEqual(record["run_minutes"]["median"], 1370.0)
        self.assertEqual(record["running_kw"], 1.0)

    def test_zero_held_all_night_from_one_sample_is_a_zero_floor(self) -> None:
        power = _power((0, DAY_START), (800, _at(12)), (0, _at(13)))

        self.assertEqual(_floor(power), 0.0)
        self.assertEqual(_record(power)["run_kwh"]["median"], 0.8)

    def test_a_brief_dip_to_zero_does_not_pull_the_floor_down(self) -> None:
        """20 W at night; the 30 s dip sits in a loaded hour and is merged."""
        power = _power(
            (20, DAY_START),
            (1000, _at(10)),
            (0, _at(10, 30)),
            (1000, _at(10, 30, 30)),
            (20, _at(12)),
        )

        record = _record(power)

        self.assertAlmostEqual(_floor(power), 20.0)
        self.assertEqual(record["runs_per_day"], 1.0)
        self.assertEqual(record["run_minutes"]["median"], 120.0)

    def test_an_unavailable_stretch_is_a_gap_not_carried_power(self) -> None:
        record = _record(
            _power(
                (0, DAY_START),
                (1000, _at(10)),
                ("unavailable", _at(10, 30)),
                (1000, _at(11)),
                (0, _at(11, 30)),
            )
        )

        # Two half-hour runs, and 1 kWh between them rather than 1.5, over
        # the 23.5 h observed.
        self.assertEqual(record["runs_per_day"], round(2 / (23.5 / 24), 4))
        self.assertEqual(record["run_kwh"], {"median": 0.5, "min": 0.5, "max": 0.5})

    def test_short_off_gaps_merge_and_sub_minute_runs_drop(self) -> None:
        record = _record(
            _power(
                (0, DAY_START),
                (1000, _at(10)),
                (0, _at(10, 20)),
                (1000, _at(10, 21)),
                (0, _at(10, 40)),
                # A 30 s blip.
                (1000, _at(12)),
                (0, _at(12, 0, 30)),
            )
        )

        self.assertEqual(record["runs_per_day"], 1.0)
        self.assertEqual(record["run_minutes"]["median"], 40.0)
        self.assertEqual(record["run_kwh"]["median"], 0.65)


if __name__ == "__main__":
    unittest.main()


def test_numeric_reader_keeps_its_finite_only_contract():
    assert device_stats._read_float(True) == 1.0
    for value in (float("nan"), float("inf"), "-inf", "unknown", None):
        assert device_stats._read_float(value) is None
