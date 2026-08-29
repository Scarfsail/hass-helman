"""The house training window is spliced out of both recorder tables.

Raw states are what ``purge_keep_days`` deletes; hourly long-term statistics are
not. On a stock recorder a ``training_window_days: 56`` therefore reads eight
days and the fit records ``insufficient_history`` while the other forty-eight
days sit unread in another table (issue #173).

So every test here stubs **both** sources and makes them disagree on purpose --
deep statistics, shallow states -- because that is the only configuration the
bug lives in and no fixture has it by default. The recorder is faked at
``statistics_during_period`` and ``state_changes_during_period`` themselves, so
the modules under test are really exercised: the splice, the probe that decides
where it falls, and the UTC key normalisation that keeps a 25-hour day intact
across it.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]


def _install_package_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg


_install_package_stubs()

span_mod = importlib.import_module("custom_components.helman.recorder_statistics_span")
series_mod = importlib.import_module("custom_components.helman.recorder_hourly_series")
house_module = importlib.import_module(
    "custom_components.helman.training.house_consumption"
)
history_mod = importlib.import_module("homeassistant.components.recorder.history")

PRAGUE = ZoneInfo("Europe/Prague")
#: The clock every test runs against.
NOW = datetime(2026, 8, 27, 10, 0, tzinfo=PRAGUE)
HOUSE_METER = "sensor.house_total"

#: What ``training_window_days: 56`` asks for, and what the recorder's two
#: tables actually hold on the instance issue #173 was written from.
WINDOW_DAYS = 56
RAW_STATE_DAYS = 8
STATISTICS_DAYS = 195


class _FakeRecorder:
    """One recorder, two tables, and a count of every read of either.

    Both tables are generated rather than listed: a meter reading is a running
    total, and writing 4680 of them out by hand would say nothing a rule does
    not. Each entity's statistics and raw states are independent series with
    their own per-hour increment, so a spliced hour can be traced back to the
    table it came from by its value alone.
    """

    def __init__(self) -> None:
        #: ``{entity_id: (first_hour_local, per_hour_kwh)}`` for each table.
        self.statistics: dict[str, tuple[datetime, float]] = {}
        self.raw_states: dict[str, tuple[datetime, float]] = {}
        self.statistics_calls: list[set[str]] = []

    async def async_add_executor_job(self, func, *args):
        return func(*args)

    # -- the long-term statistics table ---------------------------------

    def statistics_during_period(
        self, hass, start_time, end_time, statistic_ids, period, units, types_
    ):
        self.statistics_calls.append(set(statistic_ids or ()))
        result = {}
        for entity_id in statistic_ids or ():
            source = self.statistics.get(entity_id)
            if source is None:
                continue
            rows = [
                {
                    "start": hour.timestamp(),
                    "end": (hour + timedelta(hours=1)).timestamp(),
                    "state": value,
                }
                for hour, value in self._readings(source, end_time or NOW)
                if start_time <= hour and (end_time is None or hour < end_time)
            ]
            if rows:
                result[entity_id] = rows
        return result

    # -- the raw states table -------------------------------------------

    def state_changes_during_period(
        self, hass, start_time, end_time, entity_id, *args, **kwargs
    ):
        source = self.raw_states.get(entity_id)
        if source is None:
            return {}
        readings = self._readings(source, end_time or NOW)
        limit = kwargs.get("limit")

        # ``include_start_time_state`` is what gives the window's first hour a
        # left-hand reading to be differenced against, so the fake has to honour
        # it or every splice would look like it lost an hour.
        states = [
            _FakeState(value, hour)
            for hour, value in readings
            if start_time <= hour and (end_time is None or hour <= end_time)
        ]
        carried = [hour for hour, _ in readings if hour < start_time]
        if carried and kwargs.get("include_start_time_state", args[-1] if args else False):
            hour = carried[-1]
            value = dict(readings)[hour]
            states.insert(0, _FakeState(value, hour))
        if limit is not None:
            states = states[:limit]
        return {entity_id: states} if states else {}

    @staticmethod
    def _readings(
        source: tuple[datetime, float], until: datetime
    ) -> list[tuple[datetime, float]]:
        """Hourly readings of a cumulative meter, one per real hour.

        Stepped in UTC rather than by adding local days, so a fall-back day gets
        its twenty-five readings instead of twenty-four -- the same thing the
        readers under test have to get right.
        """
        first_hour, per_hour = source
        cursor = first_hour.astimezone(timezone.utc)
        end = until.astimezone(timezone.utc)
        readings: list[tuple[datetime, float]] = []
        # A meter's absolute value is arbitrary; only its differences are read.
        total = 1000.0
        while cursor <= end:
            readings.append((cursor, total))
            total += per_hour
            cursor += timedelta(hours=1)
        return readings


class _FakeState:
    def __init__(self, value: float, when: datetime) -> None:
        self.state = str(value)
        self.last_updated = when
        self.last_changed = when
        self.attributes = {"unit_of_measurement": "kWh"}


def _hours_ago(days: int, *, hour: int = 0) -> datetime:
    """Local midnight ``days`` before today, offset by ``hour``."""
    return (NOW.replace(hour=0, minute=0, second=0, microsecond=0)
            - timedelta(days=days)) + timedelta(hours=hour)


def _make_hass():
    async def _executor_job(func, *args):
        return func(*args)

    return SimpleNamespace(
        states=SimpleNamespace(get=lambda entity_id: None),
        async_add_executor_job=_executor_job,
    )


def _with_recorder(recorder: _FakeRecorder):
    """Point both readers at the fake recorder for the duration of a block."""
    return [
        patch.object(span_mod, "statistics_during_period", recorder.statistics_during_period),
        patch.object(span_mod, "get_instance", lambda hass: recorder),
        patch.object(series_mod, "get_instance", lambda hass: recorder),
        patch.object(
            series_mod, "state_changes_during_period", recorder.state_changes_during_period
        ),
        # The oldest-state probe imports this at call time, so it has to be
        # patched where it is looked up rather than where the reader bound it.
        patch.object(
            history_mod, "state_changes_during_period", recorder.state_changes_during_period
        ),
    ]


async def _spliced(recorder: _FakeRecorder, entity_ids, *, local_start, local_end=None):
    patches = _with_recorder(recorder)
    for item in patches:
        item.start()
    try:
        return await span_mod.query_spliced_hourly_energy(
            _make_hass(),
            entity_ids,
            local_start=local_start,
            local_end=local_end or NOW.replace(minute=0, second=0, microsecond=0),
        )
    finally:
        for item in patches:
            item.stop()


class SplicedWindowTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_purged_window_is_filled_from_statistics(self) -> None:
        """The bug itself: 8 days of states, 195 of statistics, 56 asked for."""
        recorder = _FakeRecorder()
        recorder.statistics[HOUSE_METER] = (_hours_ago(STATISTICS_DAYS), 5.0)
        recorder.raw_states[HOUSE_METER] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)

        spliced = await _spliced(
            recorder, [HOUSE_METER], local_start=_hours_ago(WINDOW_DAYS)
        )

        hours = spliced[HOUSE_METER]
        # Every hour from the window's start to the current hour, from whichever
        # table holds it: 56 whole days plus today's ten completed hours.
        self.assertEqual(len(hours), WINDOW_DAYS * 24 + 10)
        self.assertEqual(min(hours), _hours_ago(WINDOW_DAYS).astimezone(timezone.utc))

    async def test_the_window_only_reaches_as_far_as_the_recorder_does(self) -> None:
        """Statistics shallower than the window do not invent the difference."""
        recorder = _FakeRecorder()
        recorder.statistics[HOUSE_METER] = (_hours_ago(20), 5.0)
        recorder.raw_states[HOUSE_METER] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)

        spliced = await _spliced(
            recorder, [HOUSE_METER], local_start=_hours_ago(WINDOW_DAYS)
        )

        oldest = min(spliced[HOUSE_METER])
        self.assertEqual(oldest.astimezone(PRAGUE), _hours_ago(20) + timedelta(hours=1))

    async def test_the_splice_hour_is_counted_once_from_the_raw_states(self) -> None:
        """Both tables cover the whole window, deliberately disagreeing.

        The statistics say 5 kWh an hour and the raw states say 1, so every hour
        names the table it came from. Raw states win where both have the hour,
        and no hour may be counted twice -- which is the failure a splice makes
        silently rather than loudly.
        """
        recorder = _FakeRecorder()
        recorder.statistics[HOUSE_METER] = (_hours_ago(STATISTICS_DAYS), 5.0)
        recorder.raw_states[HOUSE_METER] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)

        spliced = await _spliced(
            recorder, [HOUSE_METER], local_start=_hours_ago(WINDOW_DAYS)
        )

        hours = spliced[HOUSE_METER]
        # Raw states begin part-way through their first day, so the day they
        # begin on belongs to statistics and the handover is the midnight after.
        splice = _hours_ago(RAW_STATE_DAYS - 1)
        from_raw = sorted(hour for hour, kwh in hours.items() if kwh == 1.0)
        from_statistics = [hour for hour, kwh in hours.items() if kwh == 5.0]
        self.assertEqual(len(from_raw) + len(from_statistics), len(hours))
        self.assertEqual(from_raw[0].astimezone(PRAGUE), splice)
        self.assertTrue(all(hour.astimezone(PRAGUE) < splice for hour in from_statistics))
        # Contiguous and gapless across the seam: consecutive hours throughout.
        ordered = sorted(hours)
        self.assertEqual(
            ordered[-1] - ordered[0], timedelta(hours=len(ordered) - 1)
        )

    async def test_statistics_alone_serve_an_entity_with_no_raw_states(self) -> None:
        recorder = _FakeRecorder()
        recorder.statistics[HOUSE_METER] = (_hours_ago(STATISTICS_DAYS), 5.0)

        spliced = await _spliced(
            recorder, [HOUSE_METER], local_start=_hours_ago(WINDOW_DAYS)
        )

        hours = spliced[HOUSE_METER]
        self.assertEqual(len(hours), WINDOW_DAYS * 24 + 10)
        self.assertEqual(set(hours.values()), {5.0})

    async def test_raw_states_alone_serve_an_entity_with_no_statistics(self) -> None:
        """A meter with no ``state_class`` has no tail, and behaves as before."""
        recorder = _FakeRecorder()
        recorder.raw_states[HOUSE_METER] = (_hours_ago(WINDOW_DAYS, hour=6), 1.0)

        spliced = await _spliced(
            recorder, [HOUSE_METER], local_start=_hours_ago(WINDOW_DAYS)
        )

        hours = spliced[HOUSE_METER]
        self.assertEqual(set(hours.values()), {1.0})
        self.assertEqual(
            min(hours).astimezone(PRAGUE), _hours_ago(WINDOW_DAYS - 1)
        )

    async def test_a_fall_back_day_keeps_all_twenty_five_hours(self) -> None:
        """25 local hours survive the splice from whichever side they fall on.

        The repeated local hour is exactly what folding the two sources onto
        local wall-clock keys would collapse into one, so the day is read twice:
        once with the splice after it (statistics serve it) and once with the
        splice before it (raw states do).
        """
        fall_back = datetime(2026, 10, 25, tzinfo=PRAGUE)
        window_start = datetime(2026, 10, 23, tzinfo=PRAGUE)
        window_end = datetime(2026, 10, 27, tzinfo=PRAGUE)

        for label, raw_first_state in [
            ("served by statistics", fall_back + timedelta(hours=6)),
            ("served by raw states", window_start + timedelta(hours=6)),
        ]:
            with self.subTest(label):
                recorder = _FakeRecorder()
                recorder.statistics[HOUSE_METER] = (window_start - timedelta(days=5), 5.0)
                recorder.raw_states[HOUSE_METER] = (raw_first_state, 1.0)

                spliced = await _spliced(
                    recorder,
                    [HOUSE_METER],
                    local_start=window_start,
                    local_end=window_end,
                )

                on_the_day = [
                    hour
                    for hour in spliced[HOUSE_METER]
                    if hour.astimezone(PRAGUE).date() == fall_back.date()
                ]
                self.assertEqual(len(on_the_day), 25)
                self.assertEqual(len(spliced[HOUSE_METER]), 4 * 24 + 1)

    async def test_the_tail_is_one_read_for_every_entity_together(self) -> None:
        recorder = _FakeRecorder()
        consumers = [f"sensor.consumer_{index}" for index in range(5)]
        for entity_id in [HOUSE_METER, *consumers]:
            recorder.statistics[entity_id] = (_hours_ago(STATISTICS_DAYS), 5.0)
            recorder.raw_states[entity_id] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)

        spliced = await _spliced(
            recorder, [HOUSE_METER, *consumers], local_start=_hours_ago(WINDOW_DAYS)
        )

        self.assertEqual(len(spliced), 6)
        self.assertEqual(len(recorder.statistics_calls), 1)
        self.assertEqual(recorder.statistics_calls[0], {HOUSE_METER, *consumers})


class _FakeStore:
    def __init__(self) -> None:
        self.section: dict | None = None

    async def async_record_house_consumption(
        self, *, data, fingerprint, trained_at, last_outcome
    ) -> None:
        self.section = {"data": data, "last_outcome": last_outcome}

    async def async_record_house_consumption_failure(
        self, *, last_outcome, error_reason
    ) -> None:
        self.section = {"last_outcome": last_outcome, "error_reason": error_reason}


class HouseTrainingOnASplicedWindowTests(unittest.IsolatedAsyncioTestCase):
    """The trainer's own answer, end to end, on the two-table recorder."""

    def _make_job(self, recorder: _FakeRecorder, *, store, consumers=()):
        hass = SimpleNamespace(
            states=SimpleNamespace(
                get=lambda entity_id: SimpleNamespace(
                    attributes={"unit_of_measurement": "kWh"}
                )
            ),
            async_add_executor_job=recorder.async_add_executor_job,
        )
        request = house_module.HouseTrainingRequest(
            total_energy_entity_id=HOUSE_METER,
            training_window_days=WINDOW_DAYS,
            min_history_days=14,
            consumers_config=[
                {"energy_entity_id": entity_id, "label": entity_id}
                for entity_id in consumers
            ],
            config_fingerprint="fp-1",
        )

        async def _noop() -> None:
            return None

        return house_module.HouseConsumptionTrainingJob(
            hass,
            store,
            read_request=lambda: request,
            on_trained=_noop,
        )

    async def _train(self, recorder: _FakeRecorder, *, store, consumers=()):
        job = self._make_job(recorder, store=store, consumers=consumers)
        patches = [*_with_recorder(recorder), patch.object(house_module.dt_util, "now", lambda: NOW)]
        for item in patches:
            item.start()
        try:
            return await job.async_train()
        finally:
            for item in patches:
                item.stop()

    async def test_a_purged_window_no_longer_reads_as_insufficient_history(self) -> None:
        """The acceptance case: eight days of states, 195 of statistics."""
        recorder = _FakeRecorder()
        recorder.statistics[HOUSE_METER] = (_hours_ago(STATISTICS_DAYS), 5.0)
        recorder.raw_states[HOUSE_METER] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)
        store = _FakeStore()

        outcome = await self._train(recorder, store=store)

        self.assertEqual(outcome, "profile_trained")
        self.assertEqual(store.section["data"]["history_days"], WINDOW_DAYS)

    async def test_raw_states_alone_still_report_their_own_depth(self) -> None:
        """Nothing about ``insufficient_history`` changes -- only what it sees."""
        recorder = _FakeRecorder()
        recorder.raw_states[HOUSE_METER] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)
        store = _FakeStore()

        outcome = await self._train(recorder, store=store)

        self.assertEqual(outcome, "insufficient_history")
        self.assertEqual(store.section["data"]["history_days"], RAW_STATE_DAYS - 1)

    async def test_one_training_run_costs_one_statistics_read(self) -> None:
        """The tail's cost must not grow with the number of consumers."""
        counts = []
        for consumer_count in (0, 5):
            recorder = _FakeRecorder()
            consumers = [f"sensor.consumer_{index}" for index in range(consumer_count)]
            for entity_id in [HOUSE_METER, *consumers]:
                recorder.statistics[entity_id] = (_hours_ago(STATISTICS_DAYS), 5.0)
                recorder.raw_states[entity_id] = (_hours_ago(RAW_STATE_DAYS, hour=6), 1.0)

            await self._train(recorder, store=_FakeStore(), consumers=consumers)
            counts.append(len(recorder.statistics_calls))

        self.assertEqual(counts, [1, 1])


if __name__ == "__main__":
    unittest.main()
