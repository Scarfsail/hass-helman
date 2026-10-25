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
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

from custom_components.helman.forecast_builder import (
    SolarForecastBuilder,
    solar_slot_map,
)
from custom_components.helman.slot_grid import SLOT

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

    def test_solar_points_fall_back_maps_96_values_to_100_slots(self):
        """A 24-hour solar source on fall-back day covers all 100 slots without gap."""
        wh_period_15m = {
            f"2026-10-25T{slot // 4:02d}:{(slot % 4) * 15:02d}:00+02:00": float(slot * 10)
            for slot in range(96)
        }
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=SimpleNamespace(
                get=lambda _id: SimpleNamespace(attributes={"wh_period_15m": wh_period_15m})
            ),
        )
        builder = SolarForecastBuilder(hass, {}, SimpleNamespace(async_query_slot_energy_changes=AsyncMock()))
        points = builder._extract_solar_points("sensor.solar_today", date(2026, 10, 25))

        self.assertEqual(len(points), 100)
        # Fold 0 gets source value for 02:00
        self.assertEqual(points[8][0].fold, 0)
        self.assertEqual(points[8][1]["value"], 80.0)
        # Fold 1 is zeroed to prevent double-counting
        self.assertEqual(points[12][0].fold, 1)
        self.assertEqual(points[12][1]["value"], 0.0)
        # 03:00 unshifted
        self.assertEqual(points[16][0].fold, 0)
        self.assertEqual(points[16][1]["value"], 120.0)
        # 23:45 unshifted and covered
        self.assertEqual(points[-1][0].isoformat(), "2026-10-25T23:45:00+01:00")
        self.assertEqual(points[-1][1]["value"], 950.0)

    def test_solar_points_fall_back_hourly_fallback(self):
        """An hourly solar source on fall-back day expands to 100 slots."""
        wh_period = {
            f"2026-10-25T{hour:02d}:00:00+02:00": float(hour * 100)
            for hour in range(24)
        }
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=SimpleNamespace(
                get=lambda _id: SimpleNamespace(attributes={"wh_period": wh_period})
            ),
        )
        builder = SolarForecastBuilder(hass, {}, SimpleNamespace(async_query_slot_energy_changes=AsyncMock()))
        points = builder._extract_solar_points("sensor.solar_today", date(2026, 10, 25))

        self.assertEqual(len(points), 100)
        self.assertEqual(points[8][0].fold, 0)
        self.assertAlmostEqual(points[8][1]["value"], 200.0 / 4)
        self.assertEqual(points[12][0].fold, 1)
        self.assertEqual(points[12][1]["value"], 0.0)
        self.assertEqual(points[16][0].fold, 0)
        self.assertAlmostEqual(points[16][1]["value"], 300.0 / 4)
        self.assertEqual(points[-1][0].isoformat(), "2026-10-25T23:45:00+01:00")
        self.assertAlmostEqual(points[-1][1]["value"], 2300.0 / 4)

    def test_battery_simulation_solar_inputs_continuous_across_fall_back(self):
        """Battery simulation slot iteration across fall-back finds all solar inputs."""
        today_wh_15m = {
            f"2026-10-25T{slot // 4:02d}:{(slot % 4) * 15:02d}:00+02:00": 100.0
            for slot in range(96)
        }
        tomorrow_wh_15m = {
            f"2026-10-26T{slot // 4:02d}:{(slot % 4) * 15:02d}:00+01:00": 100.0
            for slot in range(96)
        }
        states = {
            "sensor.solar_today": SimpleNamespace(attributes={"wh_period_15m": today_wh_15m}),
            "sensor.solar_tomorrow": SimpleNamespace(attributes={"wh_period_15m": tomorrow_wh_15m}),
        }
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=SimpleNamespace(get=lambda entity_id: states.get(entity_id)),
        )
        builder = SolarForecastBuilder(hass, {}, SimpleNamespace(async_query_slot_energy_changes=AsyncMock()))

        today_points = builder._extract_solar_points("sensor.solar_today", date(2026, 10, 25))
        tomorrow_points = builder._extract_solar_points("sensor.solar_tomorrow", date(2026, 10, 26))
        all_points = [p for _, p in sorted([*today_points, *tomorrow_points], key=lambda item: item[0])]

        solar_by_slot = solar_slot_map({"points": all_points})

        # Start battery simulation at 14:00 on 2026-10-25
        started_at = datetime(2026, 10, 25, 14, 0, 0, tzinfo=TZ)
        current_slot_start = started_at
        next_slot_start = current_slot_start + timedelta(minutes=15)
        next_slot_start_utc = _as_utc(next_slot_start)

        # Simulate 120 canonical slots (reaching far into tomorrow)
        missing_slots = []
        for slot_index in range(120):
            if slot_index == 0:
                slot_key = current_slot_start
            else:
                slot_key = _as_local(next_slot_start_utc + (SLOT * (slot_index - 1)))

            if solar_by_slot.get(slot_key) is None:
                missing_slots.append(f"slot_index={slot_index} slot_key={slot_key.isoformat()}")

        self.assertEqual(missing_slots, [], f"Encountered missing solar slots: {missing_slots}")


if __name__ == "__main__":
    unittest.main()
