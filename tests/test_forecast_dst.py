"""Tests that forecast hour arithmetic works correctly across DST transitions.

The battery forecast builder computes hourly timestamps via timedelta addition
and looks them up in a map built from the house consumption forecast series.
During DST spring-forward, wall-clock arithmetic can produce non-existent
local times (e.g. 02:00 when clocks jump to 03:00).  These "gap times" break
dict lookups because Python's datetime.__eq__ treats them as incomparable with
properly-normalized times, even when they represent the same UTC instant.

The fix uses UTC-based arithmetic: convert to UTC, add hours, convert back
to local.  This avoids gap times entirely.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc

# DST transition: CET → CEST on 2026-03-29 at 02:00 (clocks jump to 03:00)
# Using a reference time one week before.
BEFORE_DST = datetime(2026, 3, 22, 17, 16, 0, tzinfo=TZ)
SPRING_FORWARD_DAY_START = datetime(2026, 3, 29, 0, 0, 0, tzinfo=TZ)
SPRING_FORWARD_DAY_END = datetime(2026, 3, 30, 0, 0, 0, tzinfo=TZ)
FALL_BACK_DAY_START = datetime(2026, 10, 25, 0, 0, 0, tzinfo=TZ)
FALL_BACK_DAY_END = datetime(2026, 10, 26, 0, 0, 0, tzinfo=TZ)


# Mirrors HA's dt_util.as_local / as_utc, including the == short-circuit
# that causes the bug when used with gap times of the same ZoneInfo.
def _as_local(v: datetime) -> datetime:
    if v.tzinfo == TZ:
        return v
    return v.astimezone(TZ)


def _as_utc(v: datetime) -> datetime:
    if v.tzinfo == UTC:
        return v
    return v.astimezone(UTC)


def _build_house_series_timestamps(
    local_now: datetime, horizon: int = 168
) -> list[str]:
    """Simulate what ConsumptionForecastBuilder produces for series timestamps.

    Uses UTC arithmetic (the fixed version).
    """
    forecast_start = (local_now + timedelta(hours=1)).replace(
        minute=0, second=0, microsecond=0
    )
    forecast_start_utc = forecast_start.astimezone(UTC)

    timestamps: list[str] = []
    for i in range(horizon):
        forecast_dt = forecast_start_utc + timedelta(hours=i)
        local_dt = forecast_dt.astimezone(TZ)
        timestamps.append(local_dt.isoformat())

    return timestamps


def _build_house_series_timestamps_wall_clock(
    local_now: datetime, horizon: int = 168
) -> list[str]:
    """Simulate what ConsumptionForecastBuilder produced BEFORE the fix.

    Uses wall-clock arithmetic (buggy during DST transitions).
    """
    forecast_start = (local_now + timedelta(hours=1)).replace(
        minute=0, second=0, microsecond=0
    )

    timestamps: list[str] = []
    for i in range(horizon):
        forecast_dt = forecast_start + timedelta(hours=i)
        timestamps.append(forecast_dt.isoformat())

    return timestamps


def _build_local_slot_starts_until(
    local_start: datetime,
    local_end: datetime,
    *,
    interval_minutes: int,
) -> list[datetime]:
    timestamps: list[datetime] = []
    cursor_utc = _as_utc(local_start)
    end_utc = _as_utc(local_end)
    while cursor_utc < end_utc:
        timestamps.append(_as_local(cursor_utc))
        cursor_utc += timedelta(minutes=interval_minutes)

    return timestamps


def _build_house_series_map(timestamps: list[str]) -> dict[datetime, float]:
    """Replicate BatteryCapacityForecastBuilder._build_house_series_map logic.

    Parses ISO timestamps → as_local → replace to hour start → dict key.
    This is the same pipeline the real builder uses.
    """
    by_hour: dict[datetime, float] = {}
    for ts in timestamps:
        parsed = datetime.fromisoformat(ts)
        local = _as_local(parsed)
        hour_key = local.replace(minute=0, second=0, microsecond=0)
        by_hour[hour_key] = 0.75
    return by_hour


class ForecastDstTests(unittest.TestCase):
    """Tests for hour arithmetic across DST spring-forward transitions."""

    def test_gap_time_not_equal_to_normalized(self):
        """Python refuses to compare DST gap times as equal to normalized times."""
        base = datetime(2026, 3, 22, 18, 0, 0, tzinfo=TZ)
        gap_time = base + timedelta(hours=152)  # 02:00 March 29 (doesn't exist)

        # Parse ISO and normalize (what _build_house_series_map does)
        parsed = datetime.fromisoformat(gap_time.isoformat())
        normalized = parsed.astimezone(TZ)

        self.assertEqual(gap_time.isoformat(), "2026-03-29T02:00:00+01:00")
        self.assertEqual(normalized.isoformat(), "2026-03-29T03:00:00+02:00")

        # They represent the same UTC instant...
        self.assertEqual(hash(gap_time), hash(normalized))
        # ...but Python says they're NOT equal (gap time is "ambiguous")
        self.assertNotEqual(gap_time, normalized)
        # ...so dict lookup fails
        self.assertIsNone({normalized: "found"}.get(gap_time))

    def test_utc_roundtrip_normalizes_gap_time(self):
        """UTC round-trip converts gap time to valid local time."""
        base = datetime(2026, 3, 22, 18, 0, 0, tzinfo=TZ)
        gap_time = base + timedelta(hours=152)

        fixed = gap_time.astimezone(UTC).astimezone(TZ)

        self.assertEqual(fixed.isoformat(), "2026-03-29T03:00:00+02:00")
        # Now they're properly equal
        parsed = datetime.fromisoformat(gap_time.isoformat()).astimezone(TZ)
        self.assertEqual(fixed, parsed)

    def test_astimezone_same_tz_is_noop(self):
        """astimezone short-circuits when target tzinfo is the same object."""
        base = datetime(2026, 3, 22, 18, 0, 0, tzinfo=TZ)
        gap_time = base + timedelta(hours=152)

        result = gap_time.astimezone(gap_time.tzinfo)

        # Returns the same object — NOT normalized
        self.assertIs(result, gap_time)
        self.assertEqual(result.isoformat(), "2026-03-29T02:00:00+01:00")

    def test_wall_clock_series_has_duplicate_hours(self):
        """Wall-clock arithmetic produces two entries for the same hour at DST."""
        timestamps = _build_house_series_timestamps_wall_clock(BEFORE_DST)

        # Parse and normalize all timestamps
        normalized = []
        for ts in timestamps:
            dt = datetime.fromisoformat(ts).astimezone(TZ)
            normalized.append(dt.replace(minute=0, second=0, microsecond=0))

        self.assertEqual(len(timestamps), 168)
        # Two timestamps collapse to the same hour → only 167 unique
        self.assertEqual(len(set(normalized)), 167)

    def test_utc_series_has_unique_hours(self):
        """UTC arithmetic produces 168 unique hours even across DST."""
        timestamps = _build_house_series_timestamps(BEFORE_DST)

        normalized = []
        for ts in timestamps:
            dt = datetime.fromisoformat(ts).astimezone(TZ)
            normalized.append(dt.replace(minute=0, second=0, microsecond=0))

        self.assertEqual(len(timestamps), 168)
        self.assertEqual(len(set(normalized)), 168)

    def test_battery_utc_hours_match_house_series_map(self):
        """UTC-based hour lookups must all succeed against the house series map."""
        timestamps = _build_house_series_timestamps(BEFORE_DST)
        house_map = _build_house_series_map(timestamps)

        # Battery builder's hour computation (UTC arithmetic — the fix)
        current_hour_start = BEFORE_DST.replace(minute=0, second=0, microsecond=0)
        next_hour_utc = _as_utc(current_hour_start) + timedelta(hours=1)

        missing = []
        for slot_index in range(1, 168):
            hour_start = _as_local(
                next_hour_utc + timedelta(hours=slot_index - 1)
            )

            if house_map.get(hour_start) is None:
                missing.append(
                    f"slot_index={slot_index} hour_start={hour_start.isoformat()}"
                )

        self.assertEqual(missing, [], f"Missing hours in house series map: {missing}")

    def test_battery_wall_clock_hours_fail_with_house_series_map(self):
        """Demonstrates the bug: wall-clock arithmetic fails during DST."""
        timestamps = _build_house_series_timestamps(BEFORE_DST)
        house_map = _build_house_series_map(timestamps)

        # OLD (buggy) hour computation: wall-clock arithmetic
        current_hour_start = BEFORE_DST.replace(minute=0, second=0, microsecond=0)
        next_hour_start = current_hour_start + timedelta(hours=1)

        missing = []
        for slot_index in range(1, 168):
            hour_start = next_hour_start + timedelta(hours=slot_index - 1)

            if house_map.get(hour_start) is None:
                missing.append(
                    f"slot_index={slot_index} hour_start={hour_start.isoformat()}"
                )

        # This MUST fail — the gap time at slot 153 doesn't match
        self.assertGreater(len(missing), 0, "Expected failures due to DST gap")
        self.assertIn("slot_index=153", missing[0])

    def test_utc_quarter_hour_slots_skip_spring_forward_gap(self):
        """UTC-based quarter-hour stepping skips nonexistent local spring slots."""
        slots = _build_local_slot_starts_until(
            SPRING_FORWARD_DAY_START,
            SPRING_FORWARD_DAY_END,
            interval_minutes=15,
        )

        self.assertEqual(len(slots), 92)
        self.assertEqual(slots[7].isoformat(), "2026-03-29T01:45:00+01:00")
        self.assertEqual(slots[8].isoformat(), "2026-03-29T03:00:00+02:00")
        self.assertTrue(
            all(
                not (
                    slot.date() == SPRING_FORWARD_DAY_START.date() and slot.hour == 2
                )
                for slot in slots
            )
        )
        self.assertEqual(len({slot.isoformat() for slot in slots}), 92)

    def test_utc_quarter_hour_slots_include_fall_back_repeat(self):
        """UTC-based quarter-hour stepping preserves both fall-back offsets."""
        slots = _build_local_slot_starts_until(
            FALL_BACK_DAY_START,
            FALL_BACK_DAY_END,
            interval_minutes=15,
        )

        self.assertEqual(len(slots), 100)
        self.assertEqual([_as_utc(slot) for slot in slots], sorted(_as_utc(slot) for slot in slots))

        iso_slots = {slot.isoformat() for slot in slots}
        for expected_timestamp in (
            "2026-10-25T02:00:00+02:00",
            "2026-10-25T02:15:00+02:00",
            "2026-10-25T02:30:00+02:00",
            "2026-10-25T02:45:00+02:00",
            "2026-10-25T02:00:00+01:00",
            "2026-10-25T02:15:00+01:00",
            "2026-10-25T02:30:00+01:00",
            "2026-10-25T02:45:00+01:00",
        ):
            self.assertIn(expected_timestamp, iso_slots)


if __name__ == "__main__":
    unittest.main()
