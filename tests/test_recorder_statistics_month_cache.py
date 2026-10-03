"""The closed-month row cache inside ``query_hourly_statistics``.

A year view used to read every hourly row of the year on every open, though
only the open month can still change. Closed UTC months now come from memory and
only the rest is read. The cache holds raw rows, never energy: the unwrap
carries a running segment maximum across the whole series, so a cached read has
to hand the unchanged post-processing exactly the rows a single read would have.
That is what these tests pin down, against a fake ``statistics_during_period``
that serves only the rows inside the window it is asked for.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

span_module = importlib.import_module("custom_components.helman.recorder_statistics_span")

PRAGUE = ZoneInfo("Europe/Prague")
UTC = timezone.utc
METER = "sensor.house_energy"
SOC = "sensor.batt_soc"
#: The clock: late May, so January to April are closed and May is open.
NOW = datetime(2026, 5, 25, 10, 0, tzinfo=PRAGUE)


def _local(*args) -> datetime:
    return datetime(*args, tzinfo=PRAGUE)


def _utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


class FakeRecorder:
    """``statistics_during_period`` over in-memory rows, and its executor."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.jobs = 0
        self.rows: dict[str, dict[str, list[dict]]] = {"hour": {}, "5minute": {}}

    def __call__(self, hass, start_time, end_time, statistic_ids, period, units, types_):
        self.calls.append({"start": start_time, "end": end_time, "period": period})
        lower, upper = start_time.timestamp(), end_time.timestamp()
        result = {}
        for statistic_id, rows in self.rows.get(period, {}).items():
            inside = [row for row in rows if lower <= row["start"] < upper]
            # The real reader leaves an id with no rows in the window out.
            if statistic_id in statistic_ids and inside:
                result[statistic_id] = inside
        return result

    async def run_job(self, func, *args):
        self.jobs += 1
        await asyncio.sleep(0)
        return func(*args)

    def hourly_calls(self) -> list[tuple[datetime, datetime]]:
        return [(call["start"], call["end"]) for call in self.calls if call["period"] == "hour"]


async def _executor(func, *args):
    await asyncio.sleep(0)
    return func(*args)


def _hass() -> SimpleNamespace:
    return SimpleNamespace(data={}, async_add_executor_job=_executor)


def _meter_rows(first: datetime, last: datetime, readings) -> list[dict]:
    """Hourly ``state`` rows from ``first`` to ``last`` (UTC hour starts)."""
    rows, cursor = [], first
    while cursor <= last:
        start = cursor.timestamp()
        rows.append({"start": start, "end": start + 3600.0, "state": readings(cursor)})
        cursor += timedelta(hours=1)
    return rows


class MonthCacheTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.recorder = FakeRecorder()
        self.now = NOW
        for patcher in (
            patch.object(span_module, "statistics_during_period", self.recorder),
            patch.object(
                span_module,
                "get_instance",
                lambda hass: SimpleNamespace(async_add_executor_job=self.recorder.run_job),
            ),
            patch("homeassistant.util.dt.now", side_effect=lambda: self.now),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def read(self, hass, ids, start: datetime, end: datetime, tail_start=None):
        return await span_module.query_hourly_statistics(
            hass, ids, local_start=start, local_end=end, tail_start=tail_start
        )

    def cached_months(self, hass, statistic_id: str) -> list[datetime]:
        return [
            month for sid, month in span_module._month_rows_cache(hass) if sid == statistic_id
        ]

    def assertSameSpan(self, first, second) -> None:
        self.assertEqual(first.rows, second.rows)
        self.assertEqual(first.energy_kwh, second.energy_kwh)
        self.assertEqual(first.compiled_until, second.compiled_until)


class TestYearReadTwice(MonthCacheTestCase):
    async def test_the_second_read_queries_only_the_edges(self):
        self.recorder.rows["hour"][METER] = _meter_rows(
            _utc(2025, 12, 31, 0), _utc(2026, 5, 25, 7), lambda hour: hour.timestamp() / 3600
        )
        hass = _hass()
        start, end = _local(2026, 1, 1), _local(2026, 5, 26)

        await self.read(hass, [METER, SOC], start, end)
        # Cold: one read of the whole padded window, in one recorder job.
        padded_start = start.astimezone(UTC) - timedelta(hours=1)
        self.assertEqual(self.recorder.hourly_calls(), [(padded_start, end.astimezone(UTC))])
        self.assertEqual(self.recorder.jobs, 1)
        # January to April are whole and closed; an empty id is cached too.
        closed = [_utc(2026, month, 1) for month in (1, 2, 3, 4)]
        self.assertEqual(self.cached_months(hass, METER), closed)
        self.assertEqual(self.cached_months(hass, SOC), closed)

        self.recorder.calls.clear()
        await self.read(hass, [METER, SOC], start, end)
        # Warm: the two hours before January, and the open month, still in one job.
        self.assertEqual(
            self.recorder.hourly_calls(),
            [(padded_start, _utc(2026, 1, 1)), (_utc(2026, 5, 1), end.astimezone(UTC))],
        )
        self.assertEqual(self.recorder.jobs, 2)

    async def test_a_month_cached_for_some_ids_only_is_read_again(self):
        self.recorder.rows["hour"][METER] = _meter_rows(
            _utc(2026, 1, 31, 0), _utc(2026, 3, 2, 0), lambda hour: hour.timestamp() / 3600
        )
        hass = _hass()
        await self.read(hass, [METER], _local(2026, 2, 1), _local(2026, 3, 2))
        self.assertEqual(self.cached_months(hass, METER), [_utc(2026, 2, 1)])

        self.recorder.calls.clear()
        await self.read(hass, [METER, SOC], _local(2026, 2, 1), _local(2026, 3, 2))
        self.assertEqual(len(self.recorder.hourly_calls()), 1)
        self.assertEqual(self.cached_months(hass, SOC), [_utc(2026, 2, 1)])


class TestCachedIsUncached(MonthCacheTestCase):
    """G3: a cached read returns exactly what a cold one does."""

    def setUp(self) -> None:
        super().setUp()

        # A meter that resets in February's first hour, its predecessor in
        # January's rows, and blinks low for April's first hour alone.
        def reading(hour: datetime) -> float:
            if hour < _utc(2026, 2, 1):
                return 1000.0 + (hour - _utc(2025, 12, 1)).total_seconds() / 3600
            if hour == _utc(2026, 4, 1):
                return 3.0
            return 0.5 + (hour - _utc(2026, 2, 1)).total_seconds() / 3600

        self.recorder.rows["hour"][METER] = _meter_rows(
            _utc(2025, 12, 1), _utc(2026, 5, 25, 6), reading
        )
        self.recorder.rows["hour"][SOC] = [
            {**row, "min": 10.0, "max": 90.0, "mean": 50.0}
            for row in _meter_rows(_utc(2026, 2, 10), _utc(2026, 4, 10), lambda hour: None)
        ]
        # The tail fills the hours the hourly table has not compiled yet.
        last = _utc(2026, 5, 25, 7)
        self.recorder.rows["5minute"][METER] = [
            {"start": (last + timedelta(minutes=5 * i)).timestamp(), "state": 5000.0 + i}
            for i in range(12)
        ]
        self.start, self.end = _local(2026, 1, 1), _local(2026, 5, 26)
        self.tail_start = _local(2026, 5, 25)

    async def read_year(self, hass):
        return await self.read(hass, [METER, SOC], self.start, self.end, self.tail_start)

    async def test_a_warm_year_read_is_the_cold_one(self):
        hass = _hass()
        cold = await self.read_year(hass)
        warm = await self.read_year(hass)

        self.assertSameSpan(cold, warm)
        # The reset and the blink were both really in the series.
        energy = cold.energy_kwh[METER]
        self.assertAlmostEqual(energy[_utc(2026, 2, 1)], 0.5)
        self.assertAlmostEqual(energy[_utc(2026, 4, 1, 1)] + energy.get(_utc(2026, 4, 1), 0.0), 2.0)
        self.assertEqual(cold.rows[SOC][_utc(2026, 3, 1)]["mean"], 50.0)
        self.assertIn(_utc(2026, 5, 25, 7), energy)

    async def test_a_read_stitched_from_cached_and_fresh_months_is_the_cold_one(self):
        cold = await self.read_year(_hass())

        hass = _hass()
        # Warm February and March alone first, so the year read is a fresh
        # range, two cached months, and a fresh range again.
        await self.read(hass, [METER, SOC], _local(2026, 2, 1), _local(2026, 4, 2))
        self.assertEqual(
            self.cached_months(hass, METER), [_utc(2026, 2, 1), _utc(2026, 3, 1)]
        )
        self.recorder.calls.clear()
        stitched = await self.read_year(hass)

        padded_start = self.start.astimezone(UTC) - timedelta(hours=1)
        self.assertEqual(
            self.recorder.hourly_calls(),
            [(padded_start, _utc(2026, 2, 1)), (_utc(2026, 4, 1), self.end.astimezone(UTC))],
        )
        self.assertSameSpan(cold, stitched)


class TestOpenMonths(MonthCacheTestCase):
    async def test_a_month_inside_its_margin_is_not_cached(self):
        self.recorder.rows["hour"][METER] = _meter_rows(
            _utc(2026, 3, 31, 0), _utc(2026, 4, 30, 23), lambda hour: hour.timestamp() / 3600
        )
        hass = _hass()
        start, end = _local(2026, 4, 1), _local(2026, 5, 2)

        # April ended at midnight UTC; a day's margin has not passed yet.
        self.now = _utc(2026, 5, 1, 23, 59)
        await self.read(hass, [METER], start, end)
        self.assertEqual(self.cached_months(hass, METER), [])

        self.now = _utc(2026, 5, 2, 0, 0)
        await self.read(hass, [METER], start, end)
        self.assertEqual(self.cached_months(hass, METER), [_utc(2026, 4, 1)])

    async def test_partial_months_at_the_edges_are_not_cached(self):
        hass = _hass()
        await self.read(hass, [METER], _local(2026, 1, 15), _local(2026, 3, 15))
        self.assertEqual(self.cached_months(hass, METER), [_utc(2026, 2, 1)])


class TestInvalidationAndCap(MonthCacheTestCase):
    async def test_forgetting_an_id_drops_only_its_months(self):
        hass = _hass()
        await self.read(hass, [METER, SOC], _local(2026, 1, 1), _local(2026, 4, 1))
        self.assertTrue(self.cached_months(hass, METER))

        span_module.forget_cached_month_rows(hass, SOC)

        self.assertEqual(self.cached_months(hass, SOC), [])
        self.assertEqual(
            self.cached_months(hass, METER), [_utc(2026, 1, 1), _utc(2026, 2, 1)]
        )

    async def test_a_read_in_flight_when_an_id_is_forgotten_caches_nothing(self):
        # A backfill can commit and forget while a read is between its query and
        # its store; what that read saw may predate the import, so it is
        # returned but not kept.
        hass = _hass()
        read_rows = self.recorder.run_job

        async def _forget_meanwhile(func, *args):
            result = await read_rows(func, *args)
            span_module.forget_cached_month_rows(hass, SOC)
            return result

        self.recorder.run_job = _forget_meanwhile
        await self.read(hass, [METER, SOC], _local(2026, 1, 1), _local(2026, 4, 1))

        self.assertEqual(span_module._month_rows_cache(hass), {})
        self.assertEqual(span_module.month_rows_generation(hass), 1)

    async def test_unload_clears_the_cache(self):
        hass = _hass()
        await self.read(hass, [METER], _local(2026, 1, 1), _local(2026, 4, 1))
        span_module.clear_month_rows_cache(hass)
        self.assertEqual(self.cached_months(hass, METER), [])

    async def test_the_cache_keeps_only_the_most_recently_used_id_months(self):
        hass = _hass()
        with patch.object(span_module, "_MONTH_ROWS_CACHE_SIZE", 5):
            await self.read(hass, [METER, SOC], _local(2026, 1, 1), _local(2026, 3, 2))
            # Touch January's pair, then add March and April's.
            await self.read(hass, [METER, SOC], _local(2026, 1, 1), _local(2026, 2, 2))
            await self.read(hass, [METER, SOC], _local(2026, 3, 1), _local(2026, 5, 2))

        cache = span_module._month_rows_cache(hass)
        self.assertEqual(len(cache), 5)
        # February's pair was the least recently used, then January's first.
        self.assertNotIn((METER, _utc(2026, 2, 1)), cache)
        self.assertNotIn((SOC, _utc(2026, 2, 1)), cache)
        self.assertNotIn((METER, _utc(2026, 1, 1)), cache)
        self.assertIn((SOC, _utc(2026, 1, 1)), cache)
        self.assertIn((METER, _utc(2026, 4, 1)), cache)


if __name__ == "__main__":
    unittest.main()
