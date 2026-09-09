"""The incremental battery-SoC boundary reader (issue #242).

Every test compares the warm reader against a cold one over the same states:
whatever reading a boundary would have had from a full-day read, it has to keep
when only the tail was read. The rest measure what the recorder was actually
asked for.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc
DAY = datetime(2026, 5, 10, 0, 0, tzinfo=TZ)
ENTITY_ID = "sensor.battery_soc"


def _install_import_stubs() -> None:
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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


class _FakeDtUtil:
    @staticmethod
    def as_local(value: datetime) -> datetime:
        if value.tzinfo == TZ:
            return value
        return value.astimezone(TZ)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)


_install_import_stubs()

from custom_components.helman import (  # noqa: E402
    battery_actual_history_builder,
    recorder_hourly_series,
)


async def _inline_executor_job(func, *args):
    return func(*args)


def _state(local_time: datetime, value: object) -> SimpleNamespace:
    return SimpleNamespace(
        state=str(value),
        attributes={},
        last_updated=_FakeDtUtil.as_utc(local_time),
    )


def _replay_window(
    states: list[SimpleNamespace], start: datetime, end: datetime
) -> list[SimpleNamespace]:
    """What the recorder hands back for a window.

    The end bound is exclusive and ``include_start_time_state`` replays the
    reading in force when the window opens, stamped with the window start --
    which is what a resumed read leans on for its opening carry.
    """
    window = [state for state in states if start <= state.last_updated < end]
    earlier = [state for state in states if state.last_updated < start]
    if earlier:
        window.insert(
            0,
            SimpleNamespace(
                state=earlier[-1].state,
                attributes=earlier[-1].attributes,
                last_updated=start,
            ),
        )
    return window


class _Recorder:
    """One entity's history, honouring the real window bounds."""

    def __init__(self, states: list[SimpleNamespace]) -> None:
        self.states = states
        self.windows: list[tuple[datetime, datetime]] = []
        self.rows_returned = 0
        self.fail_next = False

    def state_changes_during_period(self, _hass, start, end, entity_id, *_args):
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("database is locked")
        self.windows.append((start, end))
        rows = _replay_window(self.states, start, end)
        self.rows_returned += len(rows)
        return {entity_id: rows}


def _make_hass() -> SimpleNamespace:
    return SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))


def _soc_states(
    *,
    start: datetime,
    end: datetime,
    step: timedelta,
    first_value: float,
    increment: float,
) -> list[SimpleNamespace]:
    states: list[SimpleNamespace] = []
    cursor = start
    value = first_value
    while cursor < end:
        states.append(_state(cursor, round(value, 3)))
        cursor += step
        value += increment
    return states


class TodaySlotBoundaryStateReaderTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(
            recorder_hourly_series,
            "dt_util",
            _FakeDtUtil,
        )
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    def _patches(self, recorder: _Recorder):
        return (
            patch.object(
                recorder_hourly_series,
                "state_changes_during_period",
                recorder.state_changes_during_period,
            ),
            patch.object(
                recorder_hourly_series,
                "get_instance",
                lambda hass: SimpleNamespace(
                    async_add_executor_job=_inline_executor_job
                ),
            ),
        )

    async def _read(
        self,
        reader,
        recorder: _Recorder,
        reference_time: datetime,
        *,
        interval_minutes: int = 15,
    ) -> dict[datetime, float]:
        read_patch, instance_patch = self._patches(recorder)
        with read_patch, instance_patch:
            return await reader.async_query_slot_boundary_state_values(
                ENTITY_ID,
                reference_time,
                interval_minutes=interval_minutes,
            )

    async def _read_cold(
        self,
        states: list[SimpleNamespace],
        reference_time: datetime,
        *,
        interval_minutes: int = 15,
    ) -> tuple[dict[datetime, float], _Recorder]:
        """The oracle: a reader that has never seen this day before."""
        recorder = _Recorder(states)
        values = await self._read(
            recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass()),
            recorder,
            reference_time,
            interval_minutes=interval_minutes,
        )
        return values, recorder

    @staticmethod
    def _eventful_day() -> list[SimpleNamespace]:
        """A day with everything the sampler has to survive.

        Yesterday's reading is still in force at midnight, the battery charges
        and discharges, a reading dips and comes straight back, the sensor goes
        unavailable for a stretch, and then falls quiet for an hour.
        """
        states = [_state(DAY - timedelta(minutes=7), 41.0)]
        states += _soc_states(
            start=DAY,
            end=DAY + timedelta(hours=8),
            step=timedelta(minutes=5),
            first_value=40.0,
            increment=-0.2,
        )
        states += _soc_states(
            start=DAY + timedelta(hours=8),
            end=DAY + timedelta(hours=13, minutes=5),
            step=timedelta(minutes=5),
            first_value=8.0,
            increment=1.4,
        )
        # A dip that comes straight back: a percentage that falls has fallen,
        # and nothing here may lift what follows it.
        before_dip = float(states[-1].state)
        states.append(_state(DAY + timedelta(hours=13, minutes=7), 0.0))
        states.append(_state(DAY + timedelta(hours=13, minutes=12), before_dip))
        # The sensor drops out and comes back.
        states.append(_state(DAY + timedelta(hours=14), "unavailable"))
        states.append(_state(DAY + timedelta(hours=14, minutes=20), "unknown"))
        states += _soc_states(
            start=DAY + timedelta(hours=15),
            end=DAY + timedelta(hours=20),
            step=timedelta(minutes=5),
            first_value=before_dip,
            increment=-0.3,
        )
        # An hour of silence, then reporting resumes.
        last_before_gap = float(states[-1].state)
        states += _soc_states(
            start=DAY + timedelta(hours=21),
            end=DAY + timedelta(hours=24),
            step=timedelta(minutes=5),
            first_value=last_before_gap - 0.2,
            increment=-0.1,
        )
        return states

    async def test_reading_slot_by_slot_matches_one_cold_read(self) -> None:
        """The backbone: refresh every quarter hour through a whole day and
        compare each answer with a cold read of the same states."""
        states = self._eventful_day()
        warm_recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        reference_time = DAY + timedelta(minutes=15)
        while reference_time < DAY + timedelta(days=1):
            warm = await self._read(reader, warm_recorder, reference_time)
            cold, _ = await self._read_cold(states, reference_time)
            self.assertEqual(
                warm,
                cold,
                f"incremental read diverged at {reference_time.isoformat()}",
            )
            reference_time += timedelta(minutes=15)

        # A percentage stays a percentage all day: no reset offset was ever
        # applied to it.
        self.assertLessEqual(max(warm.values()), 100.0)

    async def test_a_days_refreshes_read_the_tail_not_the_day(self) -> None:
        """The point of the whole exercise, in windows and rows."""
        states = self._eventful_day()
        warm_recorder = _Recorder(states)
        cold_recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())
        reference_time = DAY + timedelta(minutes=15)
        while reference_time <= DAY + timedelta(hours=23, minutes=45):
            await self._read(reader, warm_recorder, reference_time)
            # The comparison: a reader that keeps nothing, which is what the
            # full-day read did on every refresh.
            await self._read(
                recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass()),
                cold_recorder,
                reference_time,
            )
            reference_time += timedelta(minutes=15)

        # Same number of recorder round-trips -- one per refresh, ninety-five of
        # them. What changed is what each one asks for.
        self.assertEqual(len(warm_recorder.windows), 95)
        self.assertEqual(len(cold_recorder.windows), 95)

        # The first read of the day is the day: midnight to the end of the slot
        # in progress, which is as far as a boundary can reach.
        self.assertEqual(
            warm_recorder.windows[0],
            (
                _FakeDtUtil.as_utc(DAY),
                _FakeDtUtil.as_utc(DAY + timedelta(minutes=30)),
            ),
        )
        # The last read of the day is an hour and a quarter, not twenty-four:
        # the boundaries the write margin still leaves open -- half an hour
        # measured from the read, so back to 22:45 -- plus the rest of the slot
        # in progress.
        last_start, last_end = warm_recorder.windows[-1]
        self.assertEqual(
            (last_start, last_end),
            (
                _FakeDtUtil.as_utc(DAY + timedelta(hours=22, minutes=45)),
                _FakeDtUtil.as_utc(DAY + timedelta(days=1)),
            ),
        )
        # Every read but the first is bounded by the same rule.
        self.assertTrue(
            all(
                end - start <= timedelta(hours=1, minutes=30)
                for start, end in warm_recorder.windows[1:]
            )
        )
        # Which is the reduction the issue asked to be measured: rows, not
        # awaits. The cold sequence rereads the day 95 times.
        self.assertLess(warm_recorder.rows_returned * 8, cold_recorder.rows_returned)

    async def test_a_dip_and_rebound_is_read_as_the_reading_it_was(self) -> None:
        """SoC is a level, not a counter: no reset logic may touch it.

        The dip lands inside the 13:00 slot, which takes the first write made
        inside it, so 13:00 reads as the value in force at 13:00 and the dip
        shows up nowhere -- and nothing after it is lifted by a phantom reset.
        """
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        for hours, minutes in ((13, 0), (13, 15), (13, 30), (14, 0)):
            reference_time = DAY + timedelta(hours=hours, minutes=minutes)
            warm = await self._read(reader, recorder, reference_time)
            cold, _ = await self._read_cold(states, reference_time)
            self.assertEqual(warm, cold, f"diverged at {reference_time.isoformat()}")

        before_dip = 92.0
        # 13:00 keeps the reading written at 13:00 -- the dip is not the first
        # write in that slot -- and 13:15 lives off the rebound, at the level it
        # rebounded to. Nothing after the dip is lifted by an offset, which is
        # what a cumulative meter's reset handling would have done to it.
        self.assertAlmostEqual(
            warm[_FakeDtUtil.as_utc(DAY + timedelta(hours=13))], before_dip, places=6
        )
        self.assertAlmostEqual(
            warm[_FakeDtUtil.as_utc(DAY + timedelta(hours=13, minutes=15))],
            before_dip,
            places=6,
        )

    async def test_unavailable_readings_leave_the_last_real_one_in_force(self) -> None:
        """The dropout is at 14:00 and the sensor is back at 15:00."""
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        for minutes in range(0, 120, 15):
            reference_time = DAY + timedelta(hours=14, minutes=minutes)
            warm = await self._read(reader, recorder, reference_time)
            cold, _ = await self._read_cold(states, reference_time)
            self.assertEqual(warm, cold, f"diverged at {reference_time.isoformat()}")

        carried = warm[_FakeDtUtil.as_utc(DAY + timedelta(hours=14))]
        for minutes in (15, 30, 45):
            self.assertAlmostEqual(
                warm[_FakeDtUtil.as_utc(DAY + timedelta(hours=14, minutes=minutes))],
                carried,
                places=6,
            )

    async def test_boundaries_before_the_first_reading_stay_absent(self) -> None:
        """A battery that only started reporting at noon has no morning."""
        states = _soc_states(
            start=DAY + timedelta(hours=12),
            end=DAY + timedelta(hours=14),
            step=timedelta(minutes=5),
            first_value=55.0,
            increment=0.1,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        for hours in (11, 12, 13):
            reference_time = DAY + timedelta(hours=hours)
            warm = await self._read(reader, recorder, reference_time)
            cold, _ = await self._read_cold(states, reference_time)
            self.assertEqual(warm, cold, f"diverged at {reference_time.isoformat()}")

        self.assertNotIn(_FakeDtUtil.as_utc(DAY + timedelta(hours=11)), warm)
        self.assertIn(_FakeDtUtil.as_utc(DAY + timedelta(hours=12)), warm)

    async def test_a_write_the_recorder_commits_late_still_lands(self) -> None:
        """The margin the settle window buys, spent.

        The 11:45 reading reaches the database after the 12:00 refresh has
        already read past it. That boundary is not settled yet, so the next
        refresh picks the row up rather than serving the sample it froze.
        """
        states = _soc_states(
            start=DAY + timedelta(hours=10),
            end=DAY + timedelta(hours=11, minutes=45),
            step=timedelta(minutes=5),
            first_value=60.0,
            increment=0.1,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        early = await self._read(reader, recorder, DAY + timedelta(hours=12))
        boundary = _FakeDtUtil.as_utc(DAY + timedelta(hours=11, minutes=45))
        carried = early[boundary]

        delayed = _state(DAY + timedelta(hours=11, minutes=47), 90.0)
        recorder.states.append(delayed)
        warm = await self._read(reader, recorder, DAY + timedelta(hours=12, minutes=15))
        cold, _ = await self._read_cold(
            recorder.states, DAY + timedelta(hours=12, minutes=15)
        )

        self.assertEqual(warm, cold)
        self.assertNotEqual(warm[boundary], carried)
        self.assertAlmostEqual(warm[boundary], 90.0, places=6)

    async def test_the_settle_margin_survives_an_hourly_grid(self) -> None:
        """The margin is measured from the read, not from the open slot's end.

        ``build_battery_actual_history`` reads on an hourly grid. Measured
        against the end of the slot in progress, the thirty-minute write margin
        would already be spent by the time that slot closed, and the 13:59
        reading -- committed just after the 14:00 refresh read past it -- would
        be frozen at the stale carry for the rest of the day.
        """
        states = _soc_states(
            start=DAY + timedelta(hours=10),
            end=DAY + timedelta(hours=13),
            step=timedelta(minutes=30),
            first_value=60.0,
            increment=0.5,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        early = await self._read(
            reader, recorder, DAY + timedelta(hours=14), interval_minutes=60
        )
        boundary = _FakeDtUtil.as_utc(DAY + timedelta(hours=13))
        carried = early[boundary]

        recorder.states.append(_state(DAY + timedelta(hours=13, minutes=59), 99.0))
        warm = await self._read(
            reader, recorder, DAY + timedelta(hours=15), interval_minutes=60
        )
        cold, _ = await self._read_cold(
            recorder.states, DAY + timedelta(hours=15), interval_minutes=60
        )

        self.assertEqual(warm, cold)
        self.assertNotEqual(warm[boundary], carried)
        self.assertAlmostEqual(warm[boundary], 99.0, places=6)

    async def test_a_failed_read_freezes_nothing(self) -> None:
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        recorder.fail_next = True
        with self.assertRaises(RuntimeError):
            await self._read(reader, recorder, DAY + timedelta(hours=12))
        self.assertEqual(reader._frozen_by_entity, {})

        warm = await self._read(reader, recorder, DAY + timedelta(hours=12))
        cold, _ = await self._read_cold(states, DAY + timedelta(hours=12))
        self.assertEqual(warm, cold)
        # The retry read the day, not a tail resumed from a read that failed.
        self.assertEqual(recorder.windows[-1][0], _FakeDtUtil.as_utc(DAY))

    async def test_a_new_local_day_drops_the_previous_days_prefix(self) -> None:
        states = self._eventful_day() + _soc_states(
            start=DAY + timedelta(days=1),
            end=DAY + timedelta(days=1, hours=2),
            step=timedelta(minutes=5),
            first_value=30.0,
            increment=0.2,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        await self._read(reader, recorder, DAY + timedelta(hours=23))
        warm = await self._read(reader, recorder, DAY + timedelta(days=1, hours=1))
        cold, _ = await self._read_cold(states, DAY + timedelta(days=1, hours=1))

        self.assertEqual(warm, cold)
        self.assertEqual(
            reader._frozen_by_entity[ENTITY_ID].local_date,
            (DAY + timedelta(days=1)).date(),
        )
        self.assertEqual(
            recorder.windows[-1][0],
            _FakeDtUtil.as_utc(DAY + timedelta(days=1)),
        )

    async def test_a_clock_that_stepped_backwards_reads_the_day_again(self) -> None:
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        await self._read(reader, recorder, DAY + timedelta(hours=20))
        warm = await self._read(reader, recorder, DAY + timedelta(hours=10))
        cold, _ = await self._read_cold(states, DAY + timedelta(hours=10))

        self.assertEqual(warm, cold)
        self.assertEqual(recorder.windows[-1][0], _FakeDtUtil.as_utc(DAY))

    async def test_a_different_interval_invalidates_the_prefix(self) -> None:
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        await self._read(reader, recorder, DAY + timedelta(hours=12))
        warm = await self._read(
            reader, recorder, DAY + timedelta(hours=12), interval_minutes=60
        )
        cold, _ = await self._read_cold(
            states, DAY + timedelta(hours=12), interval_minutes=60
        )

        self.assertEqual(warm, cold)
        self.assertEqual(recorder.windows[-1][0], _FakeDtUtil.as_utc(DAY))
        self.assertEqual(reader._frozen_by_entity[ENTITY_ID].interval_minutes, 60)

    async def test_a_second_entity_keeps_its_own_prefix(self) -> None:
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())

        await self._read(reader, recorder, DAY + timedelta(hours=12))
        read_patch, instance_patch = self._patches(recorder)
        with read_patch, instance_patch:
            await reader.async_query_slot_boundary_state_values(
                "sensor.other_battery_soc",
                DAY + timedelta(hours=12),
                interval_minutes=15,
            )

        # The other entity was read from midnight; the first one's prefix is
        # untouched by it.
        self.assertEqual(recorder.windows[-1][0], _FakeDtUtil.as_utc(DAY))
        self.assertIn(ENTITY_ID, reader._frozen_by_entity)
        self.assertIn("sensor.other_battery_soc", reader._frozen_by_entity)


class DstTests(unittest.IsolatedAsyncioTestCase):
    """A short day and a long one, read incrementally."""

    def setUp(self) -> None:
        self._dt_patcher = patch.object(
            recorder_hourly_series, "dt_util", _FakeDtUtil
        )
        self._dt_patcher.start()
        self.addCleanup(self._dt_patcher.stop)

    async def _walk_day(self, day: datetime, expected_hours: int) -> None:
        day_end = _FakeDtUtil.as_local(
            _FakeDtUtil.as_utc(day) + timedelta(hours=expected_hours)
        )
        states = _soc_states(
            start=day - timedelta(minutes=10),
            end=day_end,
            step=timedelta(minutes=5),
            first_value=50.0,
            increment=0.05,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())
        tests = TodaySlotBoundaryStateReaderTests()

        cursor_utc = _FakeDtUtil.as_utc(day) + timedelta(minutes=15)
        end_utc = _FakeDtUtil.as_utc(day_end)
        while cursor_utc < end_utc:
            reference_time = _FakeDtUtil.as_local(cursor_utc)
            warm = await tests._read(reader, recorder, reference_time)
            cold, _ = await tests._read_cold(states, reference_time)
            self.assertEqual(
                warm, cold, f"diverged at {reference_time.isoformat()}"
            )
            cursor_utc += timedelta(minutes=15)

        # The last read covers the whole local day on its own grid.
        self.assertEqual(len(warm), expected_hours * 4)

    async def test_the_spring_forward_day_is_twenty_three_hours(self) -> None:
        await self._walk_day(datetime(2026, 3, 29, 0, 0, tzinfo=TZ), 23)

    async def test_the_autumn_day_is_twenty_five_hours(self) -> None:
        await self._walk_day(datetime(2026, 10, 25, 0, 0, tzinfo=TZ), 25)


class SharedReaderAcrossConsumersTests(unittest.IsolatedAsyncioTestCase):
    """Warming the forecast and gathering the automation inputs in one run.

    Both go through ``build_battery_actual_history`` with the coordinator's one
    reader, so the second of them asks the recorder for the tail alone while
    producing the same trajectory.
    """

    def setUp(self) -> None:
        for module in (recorder_hourly_series, battery_actual_history_builder):
            patcher = patch.object(module, "dt_util", _FakeDtUtil)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_the_second_consumer_reads_only_the_tail(self) -> None:
        reference_time = DAY + timedelta(hours=12, minutes=3)
        states = _soc_states(
            start=DAY - timedelta(minutes=10),
            end=DAY + timedelta(hours=12, minutes=3),
            step=timedelta(minutes=5),
            first_value=50.0,
            increment=0.05,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotBoundaryStateReader(_make_hass())
        tests = TodaySlotBoundaryStateReaderTests()
        read_patch, instance_patch = tests._patches(recorder)

        with read_patch, instance_patch:
            warming = await battery_actual_history_builder.build_battery_actual_history(
                reader,
                ENTITY_ID,
                reference_time,
                interval_minutes=15,
            )
            automation = (
                await battery_actual_history_builder.build_battery_actual_history(
                    reader,
                    ENTITY_ID,
                    reference_time,
                    interval_minutes=15,
                )
            )

        self.assertEqual(warming, automation)
        self.assertEqual(len(warming), 48)
        first_window, second_window = recorder.windows
        self.assertEqual(first_window[0], _FakeDtUtil.as_utc(DAY))
        # An hour instead of twelve hours: everything settled is already held.
        self.assertEqual(
            second_window[0],
            _FakeDtUtil.as_utc(DAY + timedelta(hours=11, minutes=15)),
        )
        self.assertEqual(second_window[1] - second_window[0], timedelta(hours=1))


if __name__ == "__main__":
    unittest.main()
