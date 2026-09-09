"""Several days of one meter, read a chunk at a time instead of a day at a time.

Issue #241 (finding F7): the solar trainer read every day of its window with its
own recorder round-trip. The chunked read has to be indistinguishable from those
per-day reads -- same deltas, day for day, across counter resets, quiet stretches
and a DST fall-back day -- while asking the recorder once per chunk rather than
once per day.
"""

from __future__ import annotations

import math
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
PRAGUE = ZoneInfo("Europe/Prague")
UTC = timezone.utc
METER = "sensor.solar_total_energy"


def _install_import_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg


_install_import_stubs()

from custom_components.helman import recorder_hourly_series  # noqa: E402


class _FakeState:
    def __init__(self, value: float, when: datetime) -> None:
        self.state = str(value)
        self.last_updated = when
        self.last_changed = when
        self.attributes = {"unit_of_measurement": "kWh"}


class _Recorder:
    """One meter's raw states, and a count of every read of them.

    The modelled meter ticks every five minutes, is quiet through one night,
    and is replaced part-way through the window -- the counter drops back to
    zero and climbs again -- so a read that got the unwrap or the staleness
    lookback wrong would show it.
    """

    def __init__(self, *, first_day: datetime, days: int) -> None:
        self.reads: list[tuple[datetime, datetime]] = []
        self.states: list[_FakeState] = []
        total = 500.0
        cursor = first_day.astimezone(UTC)
        end = (first_day + timedelta(days=days)).astimezone(UTC)
        while cursor < end:
            local = cursor.astimezone(PRAGUE)
            quiet_night = local.date().day % 4 == 0 and local.hour < 5
            if not quiet_night:
                if local.date().day == first_day.day + 3 and local.hour == 11:
                    # The meter was swapped: the counter restarts near zero.
                    total = 0.0
                self.states.append(_FakeState(round(total, 4), cursor))
            # The meter keeps creeping overnight, so the row stamped exactly on
            # a day boundary carries a different reading from the one before it
            # and a window that took the wrong side of the boundary would show.
            total += 0.05 if 7 <= local.hour <= 18 else 0.002
            cursor += timedelta(minutes=5)

    async def async_add_executor_job(self, func, *args):
        return func(*args)

    def state_changes_during_period(
        self, hass, start_time, end_time, entity_id, *args, **kwargs
    ):
        self.reads.append((start_time, end_time))
        if entity_id != METER:
            return {}
        within = [
            state
            for state in self.states
            if start_time < state.last_updated < end_time
        ]
        before = [
            state for state in self.states if state.last_updated < start_time
        ]
        if before:
            # What ``include_start_time_state`` does: the row before the window,
            # restamped to the window start.
            within.insert(0, _FakeState(float(before[-1].state), start_time))
        return {METER: within} if within else {}


def _day_windows(first_day: datetime, days: int) -> list[tuple[datetime, datetime]]:
    return [
        (first_day + timedelta(days=offset), first_day + timedelta(days=offset + 1))
        for offset in range(days)
    ]


class ChunkedWindowReadTests(unittest.IsolatedAsyncioTestCase):
    #: A window that spans the European clock change, so one of its days is
    #: twenty-five hours long and its slot grid is not the same length as the
    #: others'.
    FIRST_DAY = datetime(2026, 10, 22, 0, 0, tzinfo=PRAGUE)
    DAYS = 12

    async def _read(self, recorder, *, windows, chunk_size=None):
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        extra = {} if chunk_size is None else {"max_windows_per_read": chunk_size}
        with patch.object(
            recorder_hourly_series,
            "state_changes_during_period",
            recorder.state_changes_during_period,
        ), patch.object(
            recorder_hourly_series, "get_instance", lambda hass: recorder
        ):
            return await recorder_hourly_series.query_cumulative_slot_energy_changes_for_windows(
                hass,
                METER,
                windows,
                interval_minutes=15,
                **extra,
            )

    async def _read_one_by_one(self, recorder, windows):
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        results = []
        with patch.object(
            recorder_hourly_series,
            "state_changes_during_period",
            recorder.state_changes_during_period,
        ), patch.object(
            recorder_hourly_series, "get_instance", lambda hass: recorder
        ):
            for local_start, local_end in windows:
                results.append(
                    await recorder_hourly_series.query_cumulative_slot_energy_changes(
                        hass,
                        METER,
                        local_start=local_start,
                        local_end=local_end,
                        interval_minutes=15,
                    )
                )
        return results

    async def test_chunked_read_matches_reading_each_day_on_its_own(self) -> None:
        windows = _day_windows(self.FIRST_DAY, self.DAYS)

        per_day_recorder = _Recorder(first_day=self.FIRST_DAY, days=self.DAYS)
        per_day = await self._read_one_by_one(per_day_recorder, windows)

        chunked_recorder = _Recorder(first_day=self.FIRST_DAY, days=self.DAYS)
        chunked = await self._read(chunked_recorder, windows=windows)

        self.assertEqual(chunked, per_day)
        # The fixture has to be worth comparing: every day carries real energy,
        # and the clock change makes one of them four slots longer than the
        # rest. The day the counter restarts is inside that span, so a chunked
        # read that let one day's unwrap leak into the next would not match.
        self.assertTrue(all(sum(values.values()) > 0.0 for values in per_day))
        # The clock-change day (index 3) is twenty-five hours long, and the
        # quiet nights leave real holes rather than zero-filled slots.
        self.assertEqual(len(per_day[3]), len(per_day[1]) + 4)
        self.assertLess(len(per_day[2]), len(per_day[1]))

    async def test_recorder_calls_scale_with_chunks_rather_than_days(self) -> None:
        windows = _day_windows(self.FIRST_DAY, self.DAYS)

        per_day_recorder = _Recorder(first_day=self.FIRST_DAY, days=self.DAYS)
        await self._read_one_by_one(per_day_recorder, windows)
        self.assertEqual(len(per_day_recorder.reads), self.DAYS)

        for chunk_size in (1, 3, 7, self.DAYS, self.DAYS * 2):
            with self.subTest(chunk_size=chunk_size):
                recorder = _Recorder(first_day=self.FIRST_DAY, days=self.DAYS)
                await self._read(recorder, windows=windows, chunk_size=chunk_size)
                self.assertEqual(
                    len(recorder.reads),
                    math.ceil(self.DAYS / min(chunk_size, self.DAYS)),
                )

    async def test_every_window_keeps_its_own_staleness_lookback(self) -> None:
        """Each day is still queried from half an hour before its own midnight."""
        recorder = _Recorder(first_day=self.FIRST_DAY, days=self.DAYS)
        windows = _day_windows(self.FIRST_DAY, self.DAYS)
        await self._read(recorder, windows=windows, chunk_size=4)

        first_start = min(start for start, _ in recorder.reads)
        self.assertEqual(
            first_start,
            windows[0][0].astimezone(UTC) - timedelta(minutes=30),
        )
        last_end = max(end for _, end in recorder.reads)
        self.assertEqual(last_end, windows[-1][1].astimezone(UTC))

    async def test_windows_with_no_slots_come_back_empty(self) -> None:
        recorder = _Recorder(first_day=self.FIRST_DAY, days=self.DAYS)
        empty = (self.FIRST_DAY, self.FIRST_DAY)
        windows = [empty, *_day_windows(self.FIRST_DAY, 2), empty]
        results = await self._read(recorder, windows=windows)

        self.assertEqual(results[0], {})
        self.assertEqual(results[-1], {})
        self.assertTrue(results[1])

    async def test_no_windows_asks_the_recorder_nothing(self) -> None:
        recorder = _Recorder(first_day=self.FIRST_DAY, days=1)
        self.assertEqual(await self._read(recorder, windows=[]), [])
        self.assertEqual(recorder.reads, [])


if __name__ == "__main__":
    unittest.main()
