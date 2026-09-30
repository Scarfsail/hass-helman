"""A device's usage record: its days, its runs, and the power it runs at."""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def _install_package_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]


_install_package_stubs()

device_stats = importlib.import_module("custom_components.helman.training.device_stats")
recorder_module = importlib.import_module(
    "custom_components.helman.recorder_hourly_series"
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
        power_states=power,
        running=running,
        on_kwh_per_hour=on_kwh_per_hour,
    )


def _floor(power) -> float:
    return device_stats._standby_floor(
        device_stats.power_pieces(power, "default", DAY_START, DAY_END)
    )


class DailyTests(unittest.TestCase):
    def test_daily_figures_count_the_zero_days(self) -> None:
        """Two kWh on the first day, nothing on the second, one on the third."""
        segments = [
            (_at(10), _at(12), 2.0),
            (_at(22, day=22), _at(23, day=22), 1.0),
        ]

        record = device_stats.member_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=3),
            local_tz=UTC,
            member_energy=segments,
            on_kwh_per_hour=None,
        )

        self.assertEqual(
            record["daily_kwh"],
            {"mean": 1.0, "median": 1.0, "min": 0.0, "max": 2.0, "days": 3},
        )

    def test_only_complete_local_days_count(self) -> None:
        # The window opens at 06:00, so the first day is not a complete one.
        record = device_stats.member_record(
            window_start=_at(6),
            window_end=DAY_START + timedelta(days=3),
            local_tz=UTC,
            member_energy=[(_at(10), _at(12), 2.0), (_at(22, day=22), _at(23, day=22), 1.0)],
            on_kwh_per_hour=None,
        )

        self.assertEqual(record["daily_kwh"]["days"], 2)
        self.assertEqual(record["daily_kwh"]["max"], 1.0)

    def test_a_segment_across_midnight_is_shared_by_both_days(self) -> None:
        record = device_stats.member_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=2),
            local_tz=UTC,
            member_energy=[(_at(23), _at(1, day=21), 2.0)],
            on_kwh_per_hour=None,
        )

        self.assertEqual(record["daily_kwh"]["min"], 1.0)
        self.assertEqual(record["daily_kwh"]["max"], 1.0)

    def test_runs_per_day_count_only_the_days_the_recorder_still_holds(self) -> None:
        # A three-day window whose power history was purged before the last
        # day: one run in that day is one run a day, not a third of one.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=3),
            daily_kwh=[],
            power_states=_power(
                (0, _at(0, day=22)), (1000, _at(10, day=22)), (0, _at(11, day=22))
            ),
        )

        self.assertEqual(record["runs_per_day"], 1.0)

    def test_an_unavailable_stretch_is_not_counted_as_idle_time(self) -> None:
        # Two days of window, one of them unavailable: one run in the day
        # observed is one run a day.
        record = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_START + timedelta(days=2),
            daily_kwh=[],
            power_states=_power(
                (0, _at(0)),
                (1000, _at(10)),
                (0, _at(11)),
                ("unavailable", _at(0, day=21)),
            ),
        )

        self.assertEqual(record["runs_per_day"], 1.0)

    def test_without_a_power_sensor_only_the_days_and_the_signal_figure(self) -> None:
        plain = device_stats.metered_record(
            window_start=DAY_START, window_end=DAY_END, daily_kwh=[1.0, 2.0]
        )
        signalled = device_stats.metered_record(
            window_start=DAY_START,
            window_end=DAY_END,
            daily_kwh=[1.0, 2.0],
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


class MemberRecordTests(unittest.TestCase):
    def test_a_meterless_childs_record_is_its_member_energy(self) -> None:
        """A runs alone at 2 kW, then with B at 1 kW beside it."""

        def _switch(*changes):
            return [SimpleNamespace(state=state, last_updated=_at(hour)) for state, hour in changes]

        meter = [
            SimpleNamespace(
                state=str(value),
                attributes={"unit_of_measurement": "kWh"},
                last_updated=_at(hour),
            )
            for value, hour in ((0.0, 0), (0.0, 10), (2.0, 11), (5.0, 12), (5.0, 23))
        ]
        fit = recorder_module._estimate_shared_meter_hourly_energy_kwh(
            {
                "a": (_switch(("off", 0), ("on", 10), ("off", 12)), ("on",)),
                "b": (_switch(("off", 0), ("on", 11), ("off", 12)), ("on",)),
            },
            meter,
            DAY_START,
            DAY_END,
            "kWh",
        )

        records = {
            key: device_stats.member_record(
                window_start=DAY_START,
                window_end=DAY_END,
                local_tz=UTC,
                member_energy=fit.member_energy[key],
                on_kwh_per_hour=fit.estimates[key],
            )
            for key in ("a", "b")
        }

        for key, record in records.items():
            with self.subTest(member=key):
                self.assertEqual(record["running_kw"], fit.estimates[key])
                self.assertEqual(record["on_kwh_per_hour"], fit.estimates[key])
                self.assertAlmostEqual(
                    record["daily_kwh"]["mean"],
                    sum(kwh for _start, _end, kwh in fit.member_energy[key]),
                )
        # A's two segments touch, so they are one run of two hours.
        self.assertEqual(records["a"]["run_minutes"]["median"], 120.0)
        self.assertEqual(records["b"]["run_minutes"]["median"], 60.0)
        self.assertEqual(records["a"]["run_kwh"]["median"], 4.0)
        self.assertEqual(records["b"]["run_kwh"]["median"], 1.0)


if __name__ == "__main__":
    unittest.main()
