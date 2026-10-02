"""Span buckets: day, ISO week and month keys, and period-clamped partial buckets.

Pure -- :mod:`span_buckets` imports nothing from Home Assistant.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

buckets_mod = importlib.import_module("custom_components.helman.span_buckets")

PRAGUE = ZoneInfo("Europe/Prague")
#: Long after every period below: no bucket is still running.
LATER = datetime(2027, 6, 1, tzinfo=PRAGUE)


def local(*args) -> datetime:
    return datetime(*args, tzinfo=PRAGUE)


def spans(start: datetime, end: datetime, bucket: str, now: datetime = LATER):
    return [
        (b.start_date.isoformat(), b.end_date.isoformat(), b.partial)
        for b in buckets_mod.period_buckets(start, end, bucket, now)
    ]


class TestKeys(unittest.TestCase):
    def test_a_week_starts_on_monday(self):
        # 2026-10-01 is a Thursday; its week starts on Monday 2026-09-28.
        hour = local(2026, 10, 1, 12).astimezone(timezone.utc)
        self.assertEqual(buckets_mod.bucket_key(hour, "week", PRAGUE), "2026-09-28")
        self.assertEqual(
            buckets_mod.bucket_keys(date(2026, 10, 1), date(2026, 10, 12), "week"),
            ["2026-09-28", "2026-10-05", "2026-10-12"],
        )
        for key in buckets_mod.bucket_keys(date(2026, 1, 1), date(2026, 12, 31), "week"):
            self.assertEqual(date.fromisoformat(key).weekday(), 0)

    def test_a_sunday_belongs_to_the_week_before(self):
        hour = local(2026, 10, 4, 23).astimezone(timezone.utc)
        self.assertEqual(buckets_mod.bucket_key(hour, "week", PRAGUE), "2026-09-28")

    def test_day_and_month_keys_are_unchanged(self):
        hour = local(2026, 10, 1, 0, 30).astimezone(timezone.utc)
        self.assertEqual(buckets_mod.bucket_key(hour, "day", PRAGUE), "2026-10-01")
        self.assertEqual(buckets_mod.bucket_key(hour, "month", PRAGUE), "2026-10-01")
        self.assertEqual(
            buckets_mod.bucket_keys(date(2026, 11, 20), date(2027, 1, 3), "month"),
            ["2026-11-01", "2026-12-01", "2027-01-01"],
        )


class TestPeriodBuckets(unittest.TestCase):
    def test_week_buckets_are_clamped_at_both_edges(self):
        # Thursday 2026-10-01 to Tuesday 2026-10-13, inclusive.
        self.assertEqual(
            spans(local(2026, 10, 1), local(2026, 10, 14), "week"),
            [
                ("2026-10-01", "2026-10-04", True),
                ("2026-10-05", "2026-10-11", False),
                ("2026-10-12", "2026-10-13", True),
            ],
        )

    def test_month_buckets_are_clamped_at_both_edges(self):
        self.assertEqual(
            spans(local(2026, 7, 15), local(2026, 9, 11), "month"),
            [
                ("2026-07-15", "2026-07-31", True),
                ("2026-08-01", "2026-08-31", False),
                ("2026-09-01", "2026-09-10", True),
            ],
        )

    def test_a_period_of_whole_buckets_has_no_partial_one(self):
        self.assertEqual(
            spans(local(2026, 7, 1), local(2026, 9, 1), "month"),
            [("2026-07-01", "2026-07-31", False), ("2026-08-01", "2026-08-31", False)],
        )

    def test_day_buckets_cover_the_period(self):
        self.assertEqual(
            spans(local(2026, 10, 1), local(2026, 10, 4), "day"),
            [
                ("2026-10-01", "2026-10-01", False),
                ("2026-10-02", "2026-10-02", False),
                ("2026-10-03", "2026-10-03", False),
            ],
        )

    def test_todays_bucket_is_partial(self):
        now = local(2026, 10, 3, 14, 0)
        self.assertEqual(
            spans(local(2026, 10, 1), local(2026, 10, 4), "day", now),
            [
                ("2026-10-01", "2026-10-01", False),
                ("2026-10-02", "2026-10-02", False),
                ("2026-10-03", "2026-10-03", True),
            ],
        )
        # A whole month that is still running.
        self.assertEqual(
            spans(local(2026, 10, 1), local(2026, 11, 1), "month", now),
            [("2026-10-01", "2026-10-31", True)],
        )

    def test_a_dst_week_holds_167_or_169_hours(self):
        # Clocks go forward on Sunday 2026-03-29 and back on Sunday 2026-10-25.
        (spring,) = buckets_mod.period_buckets(
            local(2026, 3, 23), local(2026, 3, 30), "week", LATER
        )
        (autumn,) = buckets_mod.period_buckets(
            local(2026, 10, 19), local(2026, 10, 26), "week", LATER
        )
        self.assertEqual(len(spring.hours), 167)
        self.assertEqual(len(autumn.hours), 169)
        self.assertFalse(spring.partial)


if __name__ == "__main__":
    unittest.main()
