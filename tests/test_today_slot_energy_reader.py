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
ENTITY_ID = "sensor.house_energy"


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

from custom_components.helman import recorder_hourly_series  # noqa: E402


async def _inline_executor_job(func, *args):
    return func(*args)


def _state(local_time: datetime, value_kwh: float) -> SimpleNamespace:
    return SimpleNamespace(
        state=str(round(value_kwh, 6)),
        attributes={"unit_of_measurement": "kWh"},
        last_updated=_FakeDtUtil.as_utc(local_time),
    )


def _replay_window(
    states: list[SimpleNamespace], start: datetime, end: datetime
) -> list[SimpleNamespace]:
    """What the recorder hands back for a window.

    The end bound is exclusive, and ``include_start_time_state`` replays the
    value in force when the window opens, stamped with the window start. Both
    matter here: the resumed read leans on the first and has to ignore the
    second.
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
    """A recorder holding one entity's day, honouring the real window bounds."""

    def __init__(self, states: list[SimpleNamespace]) -> None:
        self.states = states
        self.windows: list[tuple[datetime, datetime]] = []

    def state_changes_during_period(self, _hass, start, end, entity_id, *_args):
        self.windows.append((start, end))
        return {entity_id: _replay_window(self.states, start, end)}


def _make_hass() -> SimpleNamespace:
    return SimpleNamespace(
        states=SimpleNamespace(
            get=lambda entity_id: SimpleNamespace(
                attributes={"unit_of_measurement": "kWh"}
            )
        ),
    )


def _climbing_states(
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
        states.append(_state(cursor, value))
        cursor += step
        value += increment
    return states


class TodaySlotEnergyReaderTests(unittest.IsolatedAsyncioTestCase):
    """Reading only the new slots must produce exactly the full-day answer."""

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

    async def _read_incremental(
        self, reader, recorder: _Recorder, reference_time: datetime
    ) -> dict[datetime, float]:
        read_patch, instance_patch = self._patches(recorder)
        with read_patch, instance_patch:
            return await reader.async_query_slot_energy_changes(
                ENTITY_ID,
                reference_time,
                interval_minutes=15,
            )

    async def _read_full_day(
        self, recorder: _Recorder, reference_time: datetime
    ) -> dict[datetime, float]:
        """The oracle: the untouched whole-day query."""
        read_patch, instance_patch = self._patches(recorder)
        with read_patch, instance_patch:
            return await recorder_hourly_series.query_slot_energy_changes(
                _make_hass(),
                ENTITY_ID,
                reference_time,
                interval_minutes=15,
            )

    @staticmethod
    def _eventful_day() -> list[SimpleNamespace]:
        """A day with every shape the unwrap has to survive.

        Yesterday's reading is still in force at midnight, the daily counter
        resets there, a dip comes back mid-afternoon, the counter really resets
        in the evening, and the sensor goes quiet for an hour after that.
        """
        states = [_state(DAY - timedelta(minutes=5), 18.0)]
        states += _climbing_states(
            start=DAY,
            end=DAY + timedelta(hours=13, minutes=5),
            step=timedelta(minutes=5),
            first_value=0.0,
            increment=0.02,
        )
        # A dip that comes back: the counter never really reset.
        pre_dip = float(states[-1].state)
        states.append(_state(DAY + timedelta(hours=13, minutes=7), 0.0))
        states.append(_state(DAY + timedelta(hours=13, minutes=12), pre_dip))
        states += _climbing_states(
            start=DAY + timedelta(hours=13, minutes=15),
            end=DAY + timedelta(hours=18),
            step=timedelta(minutes=5),
            first_value=pre_dip + 0.02,
            increment=0.02,
        )
        # A real reset: the device restarted and the counter began again.
        states += _climbing_states(
            start=DAY + timedelta(hours=18),
            end=DAY + timedelta(hours=20),
            step=timedelta(minutes=5),
            first_value=0.0,
            increment=0.02,
        )
        last_before_gap = float(states[-1].state)
        # An hour of silence, then reporting resumes.
        states += _climbing_states(
            start=DAY + timedelta(hours=21),
            end=DAY + timedelta(hours=24),
            step=timedelta(minutes=5),
            first_value=last_before_gap + 0.02,
            increment=0.02,
        )
        return states

    async def test_reading_slot_by_slot_matches_one_full_day_read(self) -> None:
        """The backbone: refresh every quarter hour through a whole day and
        compare each answer with the whole-day read of the same states."""
        states = self._eventful_day()
        warm_recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())

        reference_time = DAY + timedelta(minutes=15)
        while reference_time < DAY + timedelta(days=1):
            incremental = await self._read_incremental(
                reader, warm_recorder, reference_time
            )
            full_day = await self._read_full_day(_Recorder(states), reference_time)
            self.assertEqual(
                incremental,
                full_day,
                f"incremental read diverged at {reference_time.isoformat()}",
            )
            reference_time += timedelta(minutes=15)

    async def test_the_late_evening_refresh_reads_only_the_unsettled_tail(self) -> None:
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())

        reference_time = DAY + timedelta(minutes=15)
        while reference_time <= DAY + timedelta(hours=23, minutes=45):
            await self._read_incremental(reader, recorder, reference_time)
            reference_time += timedelta(minutes=15)

        # First read of the day: the whole day, once -- widened back by the
        # 15-minute grid's 30-minute staleness limit (decision 4) so a carry
        # spanning the window start can still be judged on its true age.
        self.assertEqual(
            recorder.windows[0],
            (
                _FakeDtUtil.as_utc(DAY - timedelta(minutes=30)),
                _FakeDtUtil.as_utc(DAY + timedelta(minutes=15)),
            ),
        )
        # Last read of the day: not the 95 completed slots, only the ones the
        # rebound window still leaves open plus the quarter hour since the
        # previous refresh.
        last_start, last_end = recorder.windows[-1]
        self.assertEqual(last_end, _FakeDtUtil.as_utc(DAY + timedelta(hours=23, minutes=45)))
        self.assertEqual(last_start, _FakeDtUtil.as_utc(DAY + timedelta(hours=22, minutes=45)))
        self.assertEqual((last_end - last_start), timedelta(hours=1))

    async def test_a_midnight_reset_is_carried_into_the_resumed_read(self) -> None:
        """Trap 1: the unwrap offset is stateful.

        A daily energy sensor resets at midnight, so every day's frozen prefix
        already carries an offset. A resumed read that restarted the unwrap at
        zero would read every later slot against the wrong baseline.
        """
        states = self._eventful_day()
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())

        for hours in (1, 2, 3):
            await self._read_incremental(
                reader, recorder, DAY + timedelta(hours=hours)
            )

        frozen = reader._frozen_by_entity[ENTITY_ID]
        self.assertEqual(frozen.unwrap_state.offset_kwh, 18.0)

        warm = await self._read_incremental(
            reader, recorder, DAY + timedelta(hours=4)
        )
        cold = await self._read_full_day(
            _Recorder(states), DAY + timedelta(hours=4)
        )
        self.assertEqual(warm, cold)
        # Every slot but the newest carries the same 0.06 kWh, so nothing was
        # lost to the reset. The newest is short only because the recorder's
        # end bound is exclusive, exactly as it is on the full-day read.
        values = [round(value, 4) for _, value in sorted(warm.items())]
        self.assertEqual(set(values[:-1]), {0.06})

    async def test_a_dip_inside_the_provisional_window_is_never_frozen_as_a_reset(
        self,
    ) -> None:
        """Trap 2: a drop is unclassifiable until the rebound window passes.

        The dip lands just past the 23:15 boundary, so at the 23:30 refresh it
        reads as a reset — nothing has come back yet — and the boundary behind
        it must not be frozen on the strength of that. The rebound arrives at
        23:35, and by the 23:45 refresh the slot has to resolve to the dip never
        having happened.
        """
        states = _climbing_states(
            start=DAY,
            end=DAY + timedelta(hours=23, minutes=14),
            step=timedelta(minutes=4),
            first_value=0.0,
            increment=0.01,
        )
        pre_dip = float(states[-1].state)
        states.append(_state(DAY + timedelta(hours=23, minutes=14), 0.0))
        # The dip reports twice before it comes back, so at the 23:30 refresh it
        # is not merely the newest reading — it looks like a settled reset.
        states.append(_state(DAY + timedelta(hours=23, minutes=20), 0.01))
        states.append(_state(DAY + timedelta(hours=23, minutes=35), pre_dip))
        states.append(_state(DAY + timedelta(hours=23, minutes=39), pre_dip + 0.01))
        states.append(_state(DAY + timedelta(hours=23, minutes=43), pre_dip + 0.02))

        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())
        for hours, minutes in ((23, 0), (23, 15), (23, 30), (23, 45)):
            reference_time = DAY + timedelta(hours=hours, minutes=minutes)
            warm = await self._read_incremental(reader, recorder, reference_time)
            cold = await self._read_full_day(_Recorder(states), reference_time)
            self.assertEqual(
                warm, cold, f"diverged at {reference_time.isoformat()}"
            )

        # The dip left no trace: the slot it fell in is ordinary consumption,
        # not a phantom reset's worth of energy.
        self.assertAlmostEqual(pre_dip, 3.48, places=6)
        dip_slot = _FakeDtUtil.as_utc(DAY + timedelta(hours=23, minutes=0))
        self.assertAlmostEqual(warm[dip_slot], 0.03, places=6)

    async def test_a_real_reset_near_the_end_of_the_window_resolves_once_it_can(
        self,
    ) -> None:
        """The counterpart: the same drop at the same place, nothing rebounds.

        It has to end up a reset — the two must not be confused — and the slot
        it falls in has to hold the energy measured on both sides of it.
        """
        states = _climbing_states(
            start=DAY,
            end=DAY + timedelta(hours=23, minutes=14),
            step=timedelta(minutes=4),
            first_value=0.0,
            increment=0.01,
        )
        pre_reset = float(states[-1].state)
        states += _climbing_states(
            start=DAY + timedelta(hours=23, minutes=14),
            end=DAY + timedelta(hours=23, minutes=48),
            step=timedelta(minutes=4),
            first_value=0.0,
            increment=0.01,
        )

        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())
        for hours, minutes in ((23, 0), (23, 15), (23, 30), (23, 45)):
            reference_time = DAY + timedelta(hours=hours, minutes=minutes)
            warm = await self._read_incremental(reader, recorder, reference_time)
            cold = await self._read_full_day(_Recorder(states), reference_time)
            self.assertEqual(
                warm, cold, f"diverged at {reference_time.isoformat()}"
            )

        # The slot the reset falls in holds what the old counter measured in it
        # and none of the 3.48 kWh it had accumulated before it.
        self.assertAlmostEqual(pre_reset, 3.48, places=6)
        reset_slot = _FakeDtUtil.as_utc(DAY + timedelta(hours=23, minutes=0))
        self.assertAlmostEqual(warm[reset_slot], 0.03, places=6)

    async def test_a_new_local_day_drops_the_previous_days_prefix(self) -> None:
        states = self._eventful_day() + _climbing_states(
            start=DAY + timedelta(days=1),
            end=DAY + timedelta(days=1, hours=2),
            step=timedelta(minutes=5),
            first_value=0.0,
            increment=0.02,
        )
        recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())

        await self._read_incremental(reader, recorder, DAY + timedelta(hours=23))
        warm = await self._read_incremental(
            reader, recorder, DAY + timedelta(days=1, hours=1)
        )
        cold = await self._read_full_day(
            _Recorder(states), DAY + timedelta(days=1, hours=1)
        )

        self.assertEqual(warm, cold)
        self.assertEqual(
            reader._frozen_by_entity[ENTITY_ID].local_date,
            (DAY + timedelta(days=1)).date(),
        )
        # The new day is read from its own midnight, not resumed from the old
        # day's frozen boundary -- widened back by the staleness limit, same
        # as the first read of any day (a fresh day is a cold read too).
        self.assertEqual(
            recorder.windows[-1][0],
            _FakeDtUtil.as_utc(DAY + timedelta(days=1) - timedelta(minutes=30)),
        )


if __name__ == "__main__":
    unittest.main()
