"""A recorder gap must not zero its own slots or dump its energy on the next one.

Issue #182: ``_sample_energy_observations_at_boundaries`` used to carry the
last reading forward to every boundary with no notion of it being too old to
carry. Across a recorder gap -- Home Assistant restarted, the container down,
the database locked -- every boundary inside the gap carried the same
pre-gap value, so the gap's slots each read a delta of zero and the first
slot whose *end* boundary saw a fresh reading was charged with the whole
outage's energy.

Four things earn a test here, per the issue's working agreement:

* A deliberate gap: the gap's slots are absent, not zero, and the slot right
  after it is not charged with the gap's whole energy (decision 1).
* A quiet on-change meter whose post-gap reading is unchanged keeps its real
  zero slots (decision 5).
* A gap that begins before the query window's start is still caught, which is
  the lookback query widening (decision 4).
* A resumed ``TodaySlotEnergyReader`` read judges staleness the same as a
  cold full-day read of the same data (decision 3).
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
DAY = datetime(2026, 3, 10, 0, 0, tzinfo=TZ)
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


def _replay_window(
    states: list[SimpleNamespace], start: datetime, end: datetime
) -> list[SimpleNamespace]:
    """What a real recorder hands back for a window.

    ``include_start_time_state`` replays the value in force when the window
    opens, stamped with the window start -- the erasure decision 4 works
    around. The rest of the states are the real rows inside the window.
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
    """A recorder holding one entity's states, honouring the real window bounds."""

    def __init__(self, states: list[SimpleNamespace]) -> None:
        self.states = states
        self.windows: list[tuple[datetime, datetime]] = []

    def state_changes_during_period(self, _hass, start, end, entity_id, *_args):
        self.windows.append((start, end))
        return {entity_id: _replay_window(self.states, start, end)}


class _BatchRecorder:
    """A recorder holding several entities' states, for the batched read.

    ``get_significant_states`` takes a list of entity ids and is called with
    keywords, which is the only way it differs from the singular fake above.
    """

    def __init__(self, states_by_entity: dict[str, list[SimpleNamespace]]) -> None:
        self.states_by_entity = states_by_entity
        self.windows: list[tuple[datetime, datetime]] = []

    def get_significant_states(self, _hass, start, end, *, entity_ids, **_kwargs):
        self.windows.append((start, end))
        return {
            entity_id: _replay_window(self.states_by_entity.get(entity_id, []), start, end)
            for entity_id in entity_ids
        }


def _make_hass() -> SimpleNamespace:
    return SimpleNamespace(
        states=SimpleNamespace(
            get=lambda entity_id: SimpleNamespace(
                attributes={"unit_of_measurement": "kWh"}
            )
        ),
    )


class _RecorderPatchMixin:
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

    def _batch_patches(self, recorder: _BatchRecorder):
        return (
            patch.object(
                recorder_hourly_series,
                "get_significant_states",
                recorder.get_significant_states,
            ),
            patch.object(
                recorder_hourly_series,
                "get_instance",
                lambda hass: SimpleNamespace(
                    async_add_executor_job=_inline_executor_job
                ),
            ),
        )


class GapDropsRatherThanZeroesTests(_RecorderPatchMixin, unittest.IsolatedAsyncioTestCase):
    """The core case: a two-hour recorder outage in the middle of a normal day."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    @staticmethod
    def _day_with_a_gap() -> list[SimpleNamespace]:
        """100 kWh at 09:00, nothing until 11:07, 104 kWh by then -- the
        example from the issue, plus ordinary readings either side of it."""
        states = _climbing_states(
            start=DAY,
            end=DAY + timedelta(hours=9),
            step=timedelta(minutes=15),
            first_value=90.0,
            increment=0.25,
        )
        states.append(_state(DAY + timedelta(hours=9), 100.0))
        # Nothing recorded for just over two hours.
        states.append(_state(DAY + timedelta(hours=11, minutes=7), 104.0))
        states += _climbing_states(
            start=DAY + timedelta(hours=11, minutes=15),
            end=DAY + timedelta(hours=12),
            step=timedelta(minutes=15),
            first_value=104.3,
            increment=0.3,
        )
        return states

    async def test_the_gaps_slots_are_absent_and_the_next_slot_is_not_overcharged(
        self,
    ) -> None:
        states = self._day_with_a_gap()
        recorder = _Recorder(states)
        read_patch, instance_patch = self._patches(recorder)

        with read_patch, instance_patch:
            changes = await recorder_hourly_series.query_cumulative_slot_energy_changes(
                _make_hass(),
                ENTITY_ID,
                local_start=DAY,
                local_end=DAY + timedelta(hours=12),
                interval_minutes=15,
            )

        # 09:00 to 09:30 are still inside the 30-minute staleness limit -- a
        # meter quiet for half an hour is not yet a gap -- so those boundaries
        # still carry 100.0 and their slots read as real, if uneventful,
        # zero-delta slots.
        for offset_minutes in (0, 15):
            slot_start = _FakeDtUtil.as_utc(
                DAY + timedelta(hours=9, minutes=offset_minutes)
            )
            self.assertIn(slot_start, changes)
            self.assertAlmostEqual(changes[slot_start], 0.0, places=6)

        # From 09:45 the carry is older than the limit and the meter did
        # move (104.0 != 100.0 at the next real reading), so every boundary
        # from there through 11:00 is stale and its slot is absent -- not a
        # zero, and not merged into one big delta either.
        for offset_minutes in (45, 60, 75, 90, 105, 120):
            slot_start = _FakeDtUtil.as_utc(
                DAY + timedelta(hours=9, minutes=offset_minutes)
            )
            self.assertNotIn(
                slot_start,
                changes,
                f"09:{offset_minutes:02d} slot should be absent, not a zero delta",
            )

        # The slot the fresh 11:07 reading lands in -- 11:00-11:15 -- must not
        # be charged with the whole outage's 4 kWh; its start boundary (11:00)
        # has no sample, so it drops out like the rest of the gap.
        overcharged_slot = _FakeDtUtil.as_utc(DAY + timedelta(hours=11))
        self.assertNotIn(overcharged_slot, changes)
        self.assertNotIn(4.0, changes.values())

        # And the ordinary slots either side of the gap read normally.
        before_gap = _FakeDtUtil.as_utc(DAY + timedelta(hours=8, minutes=30))
        self.assertAlmostEqual(changes[before_gap], 0.25, places=6)
        after_gap = _FakeDtUtil.as_utc(DAY + timedelta(hours=11, minutes=15))
        self.assertAlmostEqual(changes[after_gap], 0.3, places=6)


class QuietOnChangeMeterTests(_RecorderPatchMixin, unittest.IsolatedAsyncioTestCase):
    """Decision 5: staleness alone must not condemn a genuinely quiet meter."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    async def test_a_quiet_stretch_with_no_change_keeps_its_zero_slots(self) -> None:
        # An on-change meter: it reports at 09:00, says nothing for two hours
        # because the house drew nothing, and reports the SAME value at 11:07.
        states = [
            _state(DAY + timedelta(hours=8, minutes=45), 49.75),
            _state(DAY + timedelta(hours=9), 50.0),
            _state(DAY + timedelta(hours=11, minutes=7), 50.0),
            _state(DAY + timedelta(hours=11, minutes=15), 50.1),
        ]
        recorder = _Recorder(states)
        read_patch, instance_patch = self._patches(recorder)

        with read_patch, instance_patch:
            changes = await recorder_hourly_series.query_cumulative_slot_energy_changes(
                _make_hass(),
                ENTITY_ID,
                local_start=DAY,
                local_end=DAY + timedelta(hours=12),
                interval_minutes=15,
            )

        # Every slot from 09:00 to 11:00 is a real, unchanged zero -- not
        # dropped, because the meter's next reading confirmed nothing moved.
        for index in range(8):
            slot_start = _FakeDtUtil.as_utc(
                DAY + timedelta(hours=9, minutes=15 * index)
            )
            self.assertIn(slot_start, changes, f"slot {index} should still be present")
            self.assertAlmostEqual(changes[slot_start], 0.0, places=6)


class LookbackCatchesAPreWindowGapTests(_RecorderPatchMixin, unittest.IsolatedAsyncioTestCase):
    """Decision 4: a gap starting before the query window is still caught."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    async def test_a_gap_beginning_before_the_window_start_is_still_distrusted(
        self,
    ) -> None:
        # The outage starts an hour before the queried window and only ends
        # inside it. Without the lookback, the recorder's own replay of the
        # pre-window state would stamp the carry as fresh at the window start.
        window_start = DAY + timedelta(hours=10)
        states = [
            _state(DAY + timedelta(hours=9), 100.0),
            # Nothing again until well inside the window.
            _state(DAY + timedelta(hours=10, minutes=40), 106.0),
            _state(DAY + timedelta(hours=10, minutes=45), 106.3),
        ]
        recorder = _Recorder(states)
        read_patch, instance_patch = self._patches(recorder)

        with read_patch, instance_patch:
            changes = await recorder_hourly_series.query_cumulative_slot_energy_changes(
                _make_hass(),
                ENTITY_ID,
                local_start=window_start,
                local_end=window_start + timedelta(hours=1),
                interval_minutes=15,
            )

        # The query itself must have reached back for the pre-window reading.
        self.assertEqual(recorder.windows[0][0], _FakeDtUtil.as_utc(window_start) - timedelta(minutes=30))

        # 10:00, 10:15 and 10:30 are all still inside the outage at their own
        # boundary and must not read as zero-delta slots.
        for local_slot_start in (
            window_start,
            window_start + timedelta(minutes=15),
            window_start + timedelta(minutes=30),
        ):
            slot_start = _FakeDtUtil.as_utc(local_slot_start)
            self.assertNotIn(slot_start, changes)


class ResumedReadMatchesColdReadTests(_RecorderPatchMixin, unittest.IsolatedAsyncioTestCase):
    """Decision 3: a resumed TodaySlotEnergyReader read must judge staleness
    exactly as a fresh, cold read of the same data would."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    @staticmethod
    def _day_with_a_gap() -> list[SimpleNamespace]:
        states = _climbing_states(
            start=DAY,
            end=DAY + timedelta(hours=9),
            step=timedelta(minutes=15),
            first_value=90.0,
            increment=0.25,
        )
        states.append(_state(DAY + timedelta(hours=9), 100.0))
        states.append(_state(DAY + timedelta(hours=11, minutes=7), 104.0))
        states += _climbing_states(
            start=DAY + timedelta(hours=11, minutes=15),
            end=DAY + timedelta(hours=13),
            step=timedelta(minutes=15),
            first_value=104.3,
            increment=0.3,
        )
        return states

    async def test_reading_through_the_gap_slot_by_slot_matches_the_cold_read(
        self,
    ) -> None:
        states = self._day_with_a_gap()
        warm_recorder = _Recorder(states)
        reader = recorder_hourly_series.TodaySlotEnergyReader(_make_hass())

        reference_time = DAY + timedelta(minutes=15)
        while reference_time <= DAY + timedelta(hours=13):
            read_patch, instance_patch = self._patches(warm_recorder)
            with read_patch, instance_patch:
                incremental = await reader.async_query_slot_energy_changes(
                    ENTITY_ID,
                    reference_time,
                    interval_minutes=15,
                )

            cold_recorder = _Recorder(states)
            read_patch, instance_patch = self._patches(cold_recorder)
            with read_patch, instance_patch:
                cold = await recorder_hourly_series.query_slot_energy_changes(
                    _make_hass(),
                    ENTITY_ID,
                    reference_time,
                    interval_minutes=15,
                )

            self.assertEqual(
                incremental,
                cold,
                f"resumed read diverged from the cold read at {reference_time.isoformat()}",
            )
            reference_time += timedelta(minutes=15)

        # And the gap really did drop out of the final answer rather than
        # reading as a string of zeros.
        gap_slot = _FakeDtUtil.as_utc(DAY + timedelta(hours=9, minutes=30))
        self.assertNotIn(gap_slot, incremental)


BUSY_ENTITY_ID = "sensor.house_energy_busy"
QUIET_ENTITY_ID = "sensor.battery_charge_energy"


def _quiet_meter_states() -> list[SimpleNamespace]:
    """A meter that goes quiet for two hours and resumes a little higher.

    The shape #208 is about: an idle battery, no grid flow, solar before dawn.
    It resumes at 50.1 rather than at the 50.0 it left off at, because a meter
    publishes precisely *because* it moved -- which is why the equality escape
    in :func:`_is_carry_stale` cannot rescue it and something else has to.
    """
    return [
        _state(DAY + timedelta(hours=8, minutes=45), 49.75),
        _state(DAY + timedelta(hours=9), 50.0),
        _state(DAY + timedelta(hours=11, minutes=7), 50.1),
        _state(DAY + timedelta(hours=11, minutes=15), 50.2),
    ]


class QuietMeterInALiveBatchTests(_RecorderPatchMixin, unittest.IsolatedAsyncioTestCase):
    """Issue #208: a meter quiet inside a live recorder keeps its zero slots."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    async def _read(self, states_by_entity: dict[str, list[SimpleNamespace]]):
        recorder = _BatchRecorder(states_by_entity)
        read_patch, instance_patch = self._batch_patches(recorder)
        with read_patch, instance_patch:
            return await recorder_hourly_series.query_cumulative_slot_energy_changes_for_entities(
                _make_hass(),
                list(states_by_entity),
                local_start=DAY,
                local_end=DAY + timedelta(hours=12),
                interval_minutes=15,
            )

    async def test_a_meter_quiet_beside_a_busy_one_keeps_its_real_zeros(self) -> None:
        # The busy meter publishes every fifteen minutes throughout, which is
        # the batch's proof that the recorder was recording the whole time.
        batch = await self._read(
            {
                BUSY_ENTITY_ID: _climbing_states(
                    start=DAY,
                    end=DAY + timedelta(hours=12),
                    step=timedelta(minutes=15),
                    first_value=90.0,
                    increment=0.25,
                ),
                QUIET_ENTITY_ID: _quiet_meter_states(),
            }
        )

        # Every slot from 09:00 to 11:00 is a real, unchanged zero. Before the
        # fix these were dropped: the carry was older than the limit and the
        # meter's next reading differed, which is every quiet stretch there is.
        quiet = batch.by_entity[QUIET_ENTITY_ID]
        for index in range(8):
            slot_start = _FakeDtUtil.as_utc(
                DAY + timedelta(hours=9, minutes=15 * index)
            )
            self.assertIn(slot_start, quiet, f"slot {index} should still be present")
            self.assertAlmostEqual(quiet[slot_start], 0.0, places=6)

        # The busy meter is unaffected, and the movement the quiet meter did
        # make lands in the slot it belongs to rather than being spread.
        busy = batch.by_entity[BUSY_ENTITY_ID]
        self.assertAlmostEqual(
            busy[_FakeDtUtil.as_utc(DAY + timedelta(hours=10))], 0.25, places=6
        )
        self.assertAlmostEqual(
            quiet[_FakeDtUtil.as_utc(DAY + timedelta(hours=11))], 0.2, places=6
        )

        # And the trace really is the union of both meters' publishes.
        self.assertEqual(
            batch.liveness_instants, sorted(batch.liveness_instants)
        )
        self.assertIn(
            _FakeDtUtil.as_utc(DAY + timedelta(hours=10)), batch.liveness_instants
        )

    async def test_a_batch_wide_silence_still_drops_its_slots(self) -> None:
        # #182's case, which the fix must not undo: nothing was written for
        # anyone across the stretch, which is what a recorder outage looks
        # like. Both meters resume together at 11:07, the busy one carrying
        # the whole outage's 4 kWh.
        outage_start = DAY + timedelta(hours=9)
        resumed = DAY + timedelta(hours=11, minutes=7)
        batch = await self._read(
            {
                BUSY_ENTITY_ID: [
                    *_climbing_states(
                        start=DAY,
                        end=outage_start,
                        step=timedelta(minutes=15),
                        first_value=90.0,
                        increment=0.25,
                    ),
                    _state(outage_start, 100.0),
                    _state(resumed, 104.0),
                    _state(DAY + timedelta(hours=11, minutes=15), 104.3),
                ],
                QUIET_ENTITY_ID: _quiet_meter_states(),
            }
        )

        # From 09:45 -- the first boundary past the staleness limit -- through
        # 11:00, every slot is absent for both meters, and the outage's 4 kWh
        # is not dumped on the slot the fresh reading lands in.
        for entity_id in (BUSY_ENTITY_ID, QUIET_ENTITY_ID):
            changes = batch.by_entity[entity_id]
            for offset_minutes in (45, 60, 75, 90, 105, 120):
                slot_start = _FakeDtUtil.as_utc(
                    DAY + timedelta(hours=9, minutes=offset_minutes)
                )
                self.assertNotIn(
                    slot_start,
                    changes,
                    f"{entity_id} 09:{offset_minutes:02d} should be absent",
                )
        self.assertNotIn(4.0, batch.by_entity[BUSY_ENTITY_ID].values())


class SolarPathBorrowsTheBatchTraceTests(
    _RecorderPatchMixin, unittest.IsolatedAsyncioTestCase
):
    """The inspector's solar series reads alone and has to be handed a trace.

    Its meter is silent from dusk to dawn, so its own rows can never show that
    the recorder was up while it said nothing -- the singular read is exactly
    the case a batch cannot cover, and #208's 04:00-06:00 stretch is it.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    @staticmethod
    def _predawn_solar_states() -> list[SimpleNamespace]:
        """A daily solar meter: flat at 0.0 overnight, first light at 06:00."""
        return [
            _state(DAY + timedelta(hours=3, minutes=45), 0.0),
            _state(DAY + timedelta(hours=4), 0.0),
            # Nothing for two hours -- the panels are dark.
            _state(DAY + timedelta(hours=6, minutes=2), 0.004),
            _state(DAY + timedelta(hours=6, minutes=15), 0.02),
        ]

    async def _read(self, liveness_instants):
        recorder = _Recorder(self._predawn_solar_states())
        read_patch, instance_patch = self._patches(recorder)
        with read_patch, instance_patch:
            return await recorder_hourly_series.query_cumulative_slot_energy_changes(
                _make_hass(),
                ENTITY_ID,
                local_start=DAY,
                local_end=DAY + timedelta(hours=7),
                interval_minutes=15,
                liveness_instants=liveness_instants,
            )

    async def test_with_a_trace_the_pre_dawn_stretch_reads_as_zeros(self) -> None:
        # A house meter publishing every fifteen minutes all night is the
        # trace the inspector hands over from its batched read.
        changes = await self._read(
            [
                _FakeDtUtil.as_utc(DAY + timedelta(minutes=15 * index))
                for index in range(28)
            ]
        )

        for index in range(8):
            slot_start = _FakeDtUtil.as_utc(
                DAY + timedelta(hours=4, minutes=15 * index)
            )
            self.assertIn(slot_start, changes, f"04:{15 * index:02d} should be present")
            self.assertAlmostEqual(changes[slot_start], 0.0, places=6)

    async def test_without_a_trace_the_same_read_still_drops_them(self) -> None:
        # The `None` default has to leave the old judgement untouched, which is
        # what keeps every caller that has no trace behaving as it did.
        changes = await self._read(None)

        for index in range(2, 8):
            slot_start = _FakeDtUtil.as_utc(
                DAY + timedelta(hours=4, minutes=15 * index)
            )
            self.assertNotIn(slot_start, changes)


if __name__ == "__main__":
    unittest.main()
