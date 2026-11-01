"""Tests for the shared statistics back-fill core."""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.components.recorder.models import (
    StatisticData,
    StatisticMeanType,
    StatisticMetaData,
)

from custom_components.helman import statistics_backfill as mod


class TestBackfillCursorStore(unittest.IsolatedAsyncioTestCase):
    """Cursor store loading, querying, and recording."""

    async def test_async_load_handles_empty_or_invalid_document(self):
        stored: dict[str, Any] = {}

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = doc

        hass = SimpleNamespace()
        with patch("homeassistant.helpers.storage.Store", _FakeStore):
            store = mod.BackfillCursorStore(hass, "test_key")

            # No document stored yet
            await store.async_load()
            self.assertFalse(store.done_for("sensor.source"))
            self.assertIsNone(store.oldest_hour_for("sensor.source"))

            # Non-dict stored data resets to empty
            stored["test_key"] = "invalid_string"
            await store.async_load()
            self.assertFalse(store.done_for("sensor.source"))

            # Mismatched version resets to empty
            stored["test_key"] = {"version": 999, "source": "sensor.source", "done": True}
            await store.async_load()
            self.assertFalse(store.done_for("sensor.source"))

    async def test_done_for_and_oldest_hour_for_require_matching_source(self):
        cursor_dt = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        stored = {
            "test_key": {
                "version": 1,
                "source": "sensor.active_source",
                "oldest_hour": cursor_dt.isoformat(),
                "done": True,
            }
        }

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = doc

        hass = SimpleNamespace()
        with patch("homeassistant.helpers.storage.Store", _FakeStore):
            store = mod.BackfillCursorStore(hass, "test_key")
            await store.async_load()

            # Matches source
            self.assertTrue(store.done_for("sensor.active_source"))
            self.assertEqual(store.oldest_hour_for("sensor.active_source"), cursor_dt)

            # Different source entity id
            self.assertFalse(store.done_for("sensor.other_source"))
            self.assertIsNone(store.oldest_hour_for("sensor.other_source"))

    async def test_oldest_hour_invalid_format_returns_none(self):
        stored = {
            "test_key": {
                "version": 1,
                "source": "sensor.source",
                "oldest_hour": "not-a-datetime",
                "done": False,
            }
        }

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = doc

        hass = SimpleNamespace()
        with patch("homeassistant.helpers.storage.Store", _FakeStore):
            store = mod.BackfillCursorStore(hass, "test_key")
            await store.async_load()
            self.assertIsNone(store.oldest_hour)
            self.assertIsNone(store.oldest_hour_for("sensor.source"))

    async def test_async_record_saves_exact_payload_shape(self):
        saved: dict[str, Any] = {}

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return None

            async def async_save(self, doc):
                saved[self.key] = doc

        hass = SimpleNamespace()
        cursor = datetime(2026, 4, 15, 8, 0, tzinfo=timezone.utc)
        with patch("homeassistant.helpers.storage.Store", _FakeStore):
            store = mod.BackfillCursorStore(hass, "test_key")
            await store.async_record(
                source_entity_id="sensor.source",
                oldest_hour=cursor,
                done=True,
            )

        self.assertEqual(
            saved["test_key"],
            {
                "version": 1,
                "source": "sensor.source",
                "oldest_hour": cursor.isoformat(),
                "done": True,
            },
        )

        with patch("homeassistant.helpers.storage.Store", _FakeStore):
            store = mod.BackfillCursorStore(hass, "test_key")
            await store.async_record(
                source_entity_id="sensor.source",
                oldest_hour=None,
                done=False,
            )

        self.assertEqual(
            saved["test_key"],
            {
                "version": 1,
                "source": "sensor.source",
                "oldest_hour": None,
                "done": False,
            },
        )


class TestFirstCompiledHour(unittest.IsolatedAsyncioTestCase):
    """The 3-step month -> day -> hour probe for compiler boundary."""

    async def test_3_step_probe_locates_oldest_hour(self):
        target = "sensor.helman_mirror"
        now = datetime(2026, 5, 25, 12, 34, tzinfo=timezone.utc)
        month_ts = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc).timestamp()
        day_ts = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc).timestamp()
        hour_ts = datetime(2026, 3, 10, 8, 0, tzinfo=timezone.utc).timestamp()

        def _fake_stats_during_period(hass, start, end, entity_ids, period, units, types):
            if period == "month":
                return {target: [{"start": month_ts}]}
            if period == "day":
                return {target: [{"start": day_ts}]}
            if period == "hour":
                return {target: [{"start": hour_ts}]}
            return {}

        fake_recorder = SimpleNamespace(
            async_add_executor_job=lambda func: asyncio.sleep(0, result=func())
        )

        with patch("custom_components.helman.statistics_backfill.dt_util.now", return_value=now), patch(
            "custom_components.helman.statistics_backfill.span_mod.get_instance",
            return_value=fake_recorder,
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.statistics_during_period",
            side_effect=_fake_stats_during_period,
        ):
            first_hour = await mod.first_compiled_hour(SimpleNamespace(), target)
            self.assertEqual(
                first_hour, datetime(2026, 3, 10, 8, 0, tzinfo=timezone.utc)
            )

            # _first_hour_home_assistant_owns delegates to first_compiled_hour
            first_owns = await mod._first_hour_home_assistant_owns(SimpleNamespace(), target)
            self.assertEqual(first_owns, first_hour)

    async def test_probe_returns_current_hour_when_no_month_rows(self):
        target = "sensor.helman_mirror"
        now = datetime(2026, 5, 25, 12, 34, tzinfo=timezone.utc)
        current_hour = datetime(2026, 5, 25, 12, 0, tzinfo=timezone.utc)

        fake_recorder = SimpleNamespace(
            async_add_executor_job=lambda func: asyncio.sleep(0, result=func())
        )

        with patch("custom_components.helman.statistics_backfill.dt_util.now", return_value=now), patch(
            "custom_components.helman.statistics_backfill.span_mod.get_instance",
            return_value=fake_recorder,
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.statistics_during_period",
            return_value={},
        ):
            first_hour = await mod.first_compiled_hour(SimpleNamespace(), target)
            self.assertEqual(first_hour, current_hour)

    async def test_probe_falls_back_to_month_if_day_rows_empty(self):
        target = "sensor.helman_mirror"
        now = datetime(2026, 5, 25, 12, 34, tzinfo=timezone.utc)
        month_dt = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)

        def _fake_stats_during_period(hass, start, end, entity_ids, period, units, types):
            if period == "month":
                return {target: [{"start": month_dt.timestamp()}]}
            return {}

        fake_recorder = SimpleNamespace(
            async_add_executor_job=lambda func: asyncio.sleep(0, result=func())
        )

        with patch("custom_components.helman.statistics_backfill.dt_util.now", return_value=now), patch(
            "custom_components.helman.statistics_backfill.span_mod.get_instance",
            return_value=fake_recorder,
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.statistics_during_period",
            side_effect=_fake_stats_during_period,
        ):
            first_hour = await mod.first_compiled_hour(SimpleNamespace(), target)
            self.assertEqual(first_hour, month_dt)

    async def test_probe_falls_back_to_day_if_hour_rows_empty(self):
        target = "sensor.helman_mirror"
        now = datetime(2026, 5, 25, 12, 34, tzinfo=timezone.utc)
        month_dt = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)
        day_dt = datetime(2026, 3, 15, 0, 0, tzinfo=timezone.utc)

        def _fake_stats_during_period(hass, start, end, entity_ids, period, units, types):
            if period == "month":
                return {target: [{"start": month_dt.timestamp()}]}
            if period == "day":
                return {target: [{"start": day_dt.timestamp()}]}
            return {}

        fake_recorder = SimpleNamespace(
            async_add_executor_job=lambda func: asyncio.sleep(0, result=func())
        )

        with patch("custom_components.helman.statistics_backfill.dt_util.now", return_value=now), patch(
            "custom_components.helman.statistics_backfill.span_mod.get_instance",
            return_value=fake_recorder,
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.statistics_during_period",
            side_effect=_fake_stats_during_period,
        ):
            first_hour = await mod.first_compiled_hour(SimpleNamespace(), target)
            self.assertEqual(first_hour, day_dt)

    async def test_probe_clamps_future_timestamp_to_current_hour(self):
        target = "sensor.helman_mirror"
        now = datetime(2026, 5, 25, 12, 34, tzinfo=timezone.utc)
        current_hour = datetime(2026, 5, 25, 12, 0, tzinfo=timezone.utc)
        future_ts = (current_hour + timedelta(hours=5)).timestamp()

        def _fake_stats_during_period(hass, start, end, entity_ids, period, units, types):
            return {target: [{"start": future_ts}]}

        fake_recorder = SimpleNamespace(
            async_add_executor_job=lambda func: asyncio.sleep(0, result=func())
        )

        with patch("custom_components.helman.statistics_backfill.dt_util.now", return_value=now), patch(
            "custom_components.helman.statistics_backfill.span_mod.get_instance",
            return_value=fake_recorder,
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.statistics_during_period",
            side_effect=_fake_stats_during_period,
        ):
            first_hour = await mod.first_compiled_hour(SimpleNamespace(), target)
            self.assertEqual(first_hour, current_hour)

    async def test_probe_handles_exception_by_returning_current_hour(self):
        target = "sensor.helman_mirror"
        now = datetime(2026, 5, 25, 12, 34, tzinfo=timezone.utc)
        current_hour = datetime(2026, 5, 25, 12, 0, tzinfo=timezone.utc)

        with patch("custom_components.helman.statistics_backfill.dt_util.now", return_value=now), patch(
            "custom_components.helman.statistics_backfill.span_mod.get_instance",
            side_effect=RuntimeError("Database failure"),
        ):
            first_hour = await mod.first_compiled_hour(SimpleNamespace(), target)
            self.assertEqual(first_hour, current_hour)


class TestTimeWeightedMean(unittest.TestCase):
    """Duration-weighted arithmetic mean calculation."""

    def test_single_value_across_full_window(self):
        start = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        end = start + timedelta(hours=1)
        mean = mod._time_weighted_mean([(start, 50.0)], start=start, end=end)
        self.assertAlmostEqual(mean, 50.0)

    def test_weighted_across_multiple_steps(self):
        start = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        end = start + timedelta(hours=1)
        # 15 minutes at 10.0, 45 minutes at 20.0
        # mean = (10.0 * 15 + 20.0 * 45) / 60 = (150 + 900) / 60 = 1050 / 60 = 17.5
        samples = [
            (start, 10.0),
            (start + timedelta(minutes=15), 20.0),
        ]
        mean = mod._time_weighted_mean(samples, start=start, end=end)
        self.assertAlmostEqual(mean, 17.5)

    def test_first_reading_arrives_late_shortens_period(self):
        start = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        end = start + timedelta(hours=1)
        # Reading arrives at 10:45 with 100.0. The period is shortened to [10:45, 11:00).
        # Mean should be 100.0, not 25.0.
        samples = [(start + timedelta(minutes=45), 100.0)]
        mean = mod._time_weighted_mean(samples, start=start, end=end)
        self.assertAlmostEqual(mean, 100.0)


class TestTimeWeightedHourlyRows(unittest.TestCase):
    """Hourly row building with carry_in=True and carry_in=False."""

    def test_carry_in_false_only_uses_samples_in_hour(self):
        utc_start = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        utc_end = datetime(2026, 5, 20, 12, 0, tzinfo=timezone.utc)
        samples = [
            # Sample prior to start is ignored
            (utc_start - timedelta(minutes=10), 999.0),
            # Hour 10 has samples
            (utc_start + timedelta(minutes=15), 100.0),
            (utc_start + timedelta(minutes=45), 200.0),
            # Hour 11 has no samples
        ]
        rows = mod.time_weighted_hourly_rows(samples, utc_start, utc_end, carry_in=False)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["start"], utc_start)
        self.assertAlmostEqual(rows[0]["min"], 100.0)
        self.assertAlmostEqual(rows[0]["max"], 200.0)
        # Period shortened to 10:15..11:00 (45 mins). 30 mins at 100.0, 15 mins at 200.0
        # (100 * 30 + 200 * 15) / 45 = (3000 + 3000) / 45 = 6000 / 45 = 133.333333
        self.assertAlmostEqual(rows[0]["mean"], 6000 / 45)

    def test_carry_in_true_carries_reading_into_subsequent_hours(self):
        utc_start = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        utc_end = datetime(2026, 5, 20, 12, 0, tzinfo=timezone.utc)
        samples = [
            # Standing reading in force when hour 10 opens
            (utc_start - timedelta(minutes=30), 2.5),
        ]
        rows = mod.time_weighted_hourly_rows(samples, utc_start, utc_end, carry_in=True)
        # Both hour 10 and hour 11 receive rows carried forward from 2.5
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["start"], utc_start)
        self.assertAlmostEqual(rows[0]["mean"], 2.5)
        self.assertEqual(rows[1]["start"], utc_start + timedelta(hours=1))
        self.assertAlmostEqual(rows[1]["mean"], 2.5)


class TestMeanMetadata(unittest.TestCase):
    """Metadata builder validation."""

    def test_mean_metadata_fields(self):
        meta = mod.mean_metadata("sensor.test_target", unit="kWh", unit_class="energy")
        self.assertEqual(
            meta,
            StatisticMetaData(
                mean_type=StatisticMeanType.ARITHMETIC,
                has_sum=False,
                name=None,
                source="recorder",
                statistic_id="sensor.test_target",
                unit_class="energy",
                unit_of_measurement="kWh",
            ),
        )

    def test_mean_metadata_optional_unit_and_class(self):
        meta = mod.mean_metadata("sensor.test_price", unit="CZK/kWh", unit_class=None)
        self.assertEqual(meta["statistic_id"], "sensor.test_price")
        self.assertEqual(meta["unit_of_measurement"], "CZK/kWh")
        self.assertIsNone(meta["unit_class"])
        self.assertIs(meta["has_sum"], False)
        self.assertEqual(meta["source"], "recorder")


class TestAsyncImportAndForget(unittest.IsolatedAsyncioTestCase):
    """Import statistics and drop cached months."""

    async def test_async_import_and_forget_invokes_both(self):
        hass = SimpleNamespace()
        meta = mod.mean_metadata("sensor.test", unit="Wh", unit_class="energy")
        rows = [
            StatisticData(
                start=datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc),
                mean=50.0,
                min=50.0,
                max=50.0,
            )
        ]
        import_mock = Mock()
        forget_mock = AsyncMock()

        with patch(
            "custom_components.helman.statistics_backfill.span_mod.async_forget_imported_statistics",
            forget_mock,
        ):
            await mod.async_import_and_forget(hass, meta, rows, import_fn=import_mock)

        import_mock.assert_called_once_with(hass, meta, rows)
        forget_mock.assert_called_once_with(hass, "sensor.test")


class TestAsyncWalkBackward(unittest.IsolatedAsyncioTestCase):
    """The walk backward loop with chunk pacing and D6 latch rule."""

    async def test_walk_exits_early_if_already_done(self):
        store = Mock(spec=mod.BackfillCursorStore)
        store.async_load = AsyncMock()
        store.done_for = Mock(return_value=True)

        read_chunk = AsyncMock()
        await mod.async_walk_backward(
            SimpleNamespace(),
            store=store,
            source_entity_id="sensor.source",
            target_entity_id="sensor.target",
            metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
            read_chunk=read_chunk,
            log_name="test",
        )

        read_chunk.assert_not_called()

    async def test_walk_d6_rule_latch_done_only_when_exhausted_and_found_any(self):
        stored: dict[str, Any] = {}

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = doc

        start_cursor = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        hass = SimpleNamespace()

        # Scenario 1: Source has no history at all (chunk returns None immediately)
        async def _empty_chunk(start, end):
            return None

        with patch("homeassistant.helpers.storage.Store", _FakeStore), patch(
            "custom_components.helman.statistics_backfill.first_compiled_hour",
            AsyncMock(return_value=start_cursor),
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.async_forget_imported_statistics",
            AsyncMock(),
        ):
            store = mod.BackfillCursorStore(hass, "test_store")
            await mod.async_walk_backward(
                hass,
                store=store,
                source_entity_id="sensor.unconfigured",
                target_entity_id="sensor.target",
                metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
                read_chunk=_empty_chunk,
                log_name="test",
                pause_seconds=0,
            )

        # done MUST be False because found_any is False (D6 rule)
        self.assertFalse(stored["test_store"]["done"])
        self.assertIsNone(stored["test_store"]["oldest_hour"])

        # Scenario 2: Source has data in chunk 1, then exhausted in chunk 2
        calls = 0

        async def _chunk_with_data(start, end):
            nonlocal calls
            calls += 1
            if calls == 1:
                return [
                    StatisticData(
                        start=start,
                        mean=10.0,
                        min=10.0,
                        max=10.0,
                    )
                ]
            return None

        stored.clear()
        import_mock = Mock()

        with patch("homeassistant.helpers.storage.Store", _FakeStore), patch(
            "custom_components.helman.statistics_backfill.first_compiled_hour",
            AsyncMock(return_value=start_cursor),
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.async_forget_imported_statistics",
            AsyncMock(),
        ):
            store = mod.BackfillCursorStore(hass, "test_store")
            await mod.async_walk_backward(
                hass,
                store=store,
                source_entity_id="sensor.configured",
                target_entity_id="sensor.target",
                metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
                read_chunk=_chunk_with_data,
                log_name="test",
                pause_seconds=0,
                import_fn=import_mock,
            )

        # done MUST be True because data was found in chunk 1 and chunk 2 was exhausted
        self.assertTrue(stored["test_store"]["done"])
        self.assertIsNotNone(stored["test_store"]["oldest_hour"])
        import_mock.assert_called_once()

    async def test_empty_walk_reprobes_from_compiled_boundary_on_next_start(self):
        stored: dict[str, Any] = {}

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = doc

        start_cursor = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        hass = SimpleNamespace()
        calls: list[tuple[datetime, datetime]] = []

        async def _empty_chunk(start, end):
            calls.append((start, end))
            return None

        with patch("homeassistant.helpers.storage.Store", _FakeStore), patch(
            "custom_components.helman.statistics_backfill.first_compiled_hour",
            AsyncMock(return_value=start_cursor),
        ):
            store = mod.BackfillCursorStore(hass, "test_store")
            await mod.async_walk_backward(
                hass,
                store=store,
                source_entity_id="sensor.unconfigured",
                target_entity_id="sensor.target",
                metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
                read_chunk=_empty_chunk,
                log_name="test",
                pause_seconds=0,
            )
            self.assertEqual(len(calls), 1)
            self.assertIsNone(stored["test_store"]["oldest_hour"])

            # Second walk resumes: because oldest_hour was None, it probes again from start_cursor
            await mod.async_walk_backward(
                hass,
                store=store,
                source_entity_id="sensor.unconfigured",
                target_entity_id="sensor.target",
                metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
                read_chunk=_empty_chunk,
                log_name="test",
                pause_seconds=0,
            )
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1], calls[0])

    async def test_walk_propagates_cancellation_error(self):
        store = Mock(spec=mod.BackfillCursorStore)
        store.async_load = AsyncMock()
        store.done_for = Mock(return_value=False)
        store.oldest_hour_for = Mock(
            return_value=datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        )
        store.async_record = AsyncMock()

        async def _cancelling_chunk(start, end):
            raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await mod.async_walk_backward(
                SimpleNamespace(),
                store=store,
                source_entity_id="sensor.source",
                target_entity_id="sensor.target",
                metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
                read_chunk=_cancelling_chunk,
                log_name="test",
                pause_seconds=0,
            )

    async def test_walk_catches_and_logs_generic_exceptions(self):
        store = Mock(spec=mod.BackfillCursorStore)
        store.async_load = AsyncMock(side_effect=RuntimeError("Disk failure"))

        # Does not raise RuntimeError
        await mod.async_walk_backward(
            SimpleNamespace(),
            store=store,
            source_entity_id="sensor.source",
            target_entity_id="sensor.target",
            metadata=mod.mean_metadata("sensor.target", unit=None, unit_class=None),
            read_chunk=AsyncMock(),
            log_name="test",
            pause_seconds=0,
        )


class TestShareEnergyBackfill(unittest.IsolatedAsyncioTestCase):
    """A share-energy sensor's starting total, and the one-time import of its hours."""

    SOURCE = "sensor.helman_share_power_klima"
    TARGET = "sensor.helman_share_energy_klima"
    STORE_KEY = "entry_share_energy_klima"
    BOUNDARY = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)

    def setUp(self) -> None:
        from homeassistant.components.recorder.db_schema import StatisticsShortTerm
        from homeassistant.core import State

        from custom_components.helman import share_energy_backfill

        self.backfill = share_energy_backfill
        self.short_term = StatisticsShortTerm
        self.make_state = lambda value, **attrs: State(self.TARGET, value, attrs)
        self.stored: dict[str, Any] = {}
        stored = self.stored

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = dict(doc)

        def hour(offset: int) -> float:
            return (self.BOUNDARY + timedelta(hours=offset)).timestamp()

        # 500 W, then a gap, 1,000 W, a row without a mean, and 2,000 W; the
        # boundary hour itself belongs to the compiler.
        self.source_rows = [
            {"start": hour(-5), "mean": 500.0},
            {"start": hour(-3), "mean": 1000.0},
            {"start": hour(-2), "mean": None},
            {"start": hour(-1), "mean": 2000.0},
            {"start": hour(0), "mean": 9999.0},
        ]
        ready = asyncio.Event()
        ready.set()
        # One parent mock, so the order of the recorder calls can be checked.
        self.calls = Mock(block_till_done=AsyncMock())
        self.recorder = SimpleNamespace(
            async_recorder_ready=ready,
            async_add_executor_job=AsyncMock(side_effect=lambda fn, *args: fn(*args)),
            async_block_till_done=self.calls.block_till_done,
            async_import_statistics=self.calls.import_short_term,
        )
        self.recorded_states: list = []
        self.probe = AsyncMock(return_value=self.BOUNDARY)
        for patcher in (
            patch("homeassistant.helpers.storage.Store", _FakeStore),
            patch.object(self.backfill, "probe_first_compiled_hour", self.probe),
            patch.object(
                self.backfill,
                "state_changes_during_period",
                side_effect=lambda *_a, **_k: {self.TARGET: self.recorded_states},
            ),
            patch.object(
                self.backfill.span_mod, "get_instance", return_value=self.recorder
            ),
            patch.object(
                self.backfill.span_mod,
                "statistics_during_period",
                side_effect=self._source_query,
            ),
            patch.object(
                self.backfill.span_mod, "async_forget_imported_statistics", AsyncMock()
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _source_query(self, *args):
        self.source_query_units = args[5]
        self.calls.source_query()
        return {self.SOURCE: self.source_rows}

    async def _run(self, import_fn, *, restored: float | None = None) -> float | None:
        return await self.backfill.async_initial_share_energy_total(
            SimpleNamespace(),
            restored=restored,
            source_entity_id=self.SOURCE,
            target_entity_id=self.TARGET,
            store_key=self.STORE_KEY,
            import_fn=import_fn,
        )

    def _at(self, offset: int) -> datetime:
        return self.BOUNDARY + timedelta(hours=offset)

    async def test_hourly_means_become_kwh_and_missing_hours_stay_gaps(self) -> None:
        import_fn = Mock()

        await self._run(import_fn)

        _hass, meta, rows = import_fn.call_args.args
        self.assertEqual(
            [row["start"] for row in rows],
            [self._at(-6), self._at(-5), self._at(-3), self._at(-1)],
        )
        self.assertEqual([row["state"] for row in rows], [0.0, 0.5, 1.5, 3.5])
        self.assertEqual(meta["statistic_id"], self.TARGET)
        self.assertIs(meta["has_sum"], True)
        self.assertEqual(meta["mean_type"], StatisticMeanType.NONE)
        self.assertEqual(meta["unit_of_measurement"], "kWh")
        self.assertEqual(meta["unit_class"], "energy")
        self.assertEqual(meta["source"], "recorder")

    async def test_the_source_means_are_requested_in_watts(self) -> None:
        await self._run(Mock())

        self.assertEqual(self.source_query_units, {"power": "W"})

    async def test_seam_climbs_state_and_sum_to_the_first_published_total(self) -> None:
        import_fn = Mock()

        total = await self._run(import_fn)

        rows = import_fn.call_args.args[2]
        self.assertEqual(total, 3.5)
        self.assertEqual(rows[0]["state"], 0.0)
        self.assertEqual(rows[0]["sum"], 0.0)
        self.assertEqual(rows[1]["sum"], 0.5)
        self.assertEqual(rows[-1]["state"], total)
        self.assertEqual(rows[-1]["sum"], total)
        self.assertTrue(all(row["start"] < self.BOUNDARY for row in rows))

    async def test_reader_retains_the_first_backfilled_hour(self) -> None:
        from custom_components.helman.recorder_statistics_span import _hourly_energy_kwh

        self.source_rows = [
            {"start": self._at(-2).timestamp(), "mean": 1000.0},
            {"start": self._at(-1).timestamp(), "mean": 2000.0},
        ]
        import_fn = Mock()

        total = await self._run(import_fn)

        rows = import_fn.call_args.args[2]
        by_hour = {row["start"]: {"state": row["state"]} for row in rows}
        energy = _hourly_energy_kwh(
            by_hour, local_start=self._at(-2), local_end=self.BOUNDARY
        )
        self.assertEqual(energy, {self._at(-2): 1.0, self._at(-1): 2.0})
        self.assertEqual(sum(energy.values()), total)
        self.assertEqual(total, 3.0)

    async def test_the_compiler_is_seeded_with_the_total_before_it_is_returned(self) -> None:
        import_fn = Mock()

        await self._run(import_fn)

        meta = import_fn.call_args.args[1]
        self.calls.import_short_term.assert_called_once_with(
            meta,
            [StatisticData(start=self.BOUNDARY, state=3.5, sum=3.5)],
            self.short_term,
        )
        # Committed before the total is returned for the sensor to publish.
        names = [call[0] for call in self.calls.mock_calls]
        self.assertEqual(names[-2:], ["import_short_term", "block_till_done"])
        (document,) = self.stored.values()
        self.assertEqual(document["total"], 3.5)

    async def test_the_seed_waits_out_the_first_owned_hours_first_period(self) -> None:
        self.probe.return_value = self.BOUNDARY
        sleep = AsyncMock()
        with (
            patch.object(
                self.backfill.dt_util,
                "utcnow",
                return_value=self.BOUNDARY + timedelta(minutes=2),
            ),
            patch.object(self.backfill.asyncio, "sleep", sleep),
        ):
            await self._run(Mock())

        sleep.assert_awaited_once_with(180.0)

    async def test_the_source_is_read_after_the_recorder_caught_up(self) -> None:
        await self._run(Mock())

        names = [call[0] for call in self.calls.mock_calls]
        self.assertEqual(names[:2], ["block_till_done", "source_query"])

    async def test_runs_once_and_returns_the_recorded_total(self) -> None:
        first_import = Mock()
        await self._run(first_import)
        second_import = Mock()

        total = await self._run(second_import)

        self.assertEqual(total, 3.5)
        second_import.assert_not_called()
        self.probe.assert_awaited_once()
        self.assertEqual(
            list(self.stored), [f"helman.share_energy_backfill.{self.STORE_KEY}"]
        )

    async def test_an_interrupted_run_resumes_from_the_recorded_boundary(self) -> None:
        total = await self._run(Mock(side_effect=RuntimeError("recorder gone")))
        self.assertIsNone(total)
        (document,) = self.stored.values()
        self.assertIsNone(document["total"])

        # The imported rows would now make the probe answer an older hour.
        self.probe.return_value = self._at(-6)
        import_fn = Mock()
        total = await self._run(import_fn)

        self.assertEqual(total, 3.5)
        self.assertEqual(len(import_fn.call_args.args[2]), 4)
        self.probe.assert_awaited_once()
        (document,) = self.stored.values()
        self.assertEqual(document["total"], 3.5)

    async def test_a_failed_probe_fails_the_attempt_without_recording_a_boundary(
        self,
    ) -> None:
        self.probe.side_effect = RuntimeError("recorder gone")
        import_fn = Mock()

        total = await self._run(import_fn)

        self.assertIsNone(total)
        self.assertEqual(self.stored, {})
        import_fn.assert_not_called()

    async def test_no_history_starts_the_sensor_at_zero_without_importing(self) -> None:
        self.source_rows.clear()
        import_fn = Mock()

        total = await self._run(import_fn)

        self.assertEqual(total, 0.0)
        import_fn.assert_not_called()

    async def test_a_known_total_continues_from_the_higher_of_restored_and_recorded(
        self,
    ) -> None:
        # The restore file lags the recorder after an unclean shutdown; a
        # removal sits on top of the last recorded total.
        self.recorded_states[:] = [self.make_state(""), self.make_state("4.5")]
        import_fn = Mock()

        self.assertEqual(await self._run(import_fn, restored=4.25), 4.5)
        self.assertEqual(await self._run(import_fn, restored=5.0), 5.0)
        self.recorded_states.clear()
        self.assertEqual(await self._run(import_fn, restored=4.25), 4.25)

        import_fn.assert_not_called()
        self.probe.assert_not_called()

    async def test_a_recorded_total_is_converted_from_the_selected_unit(self) -> None:
        # Home Assistant records the state in the unit the user selected.
        self.recorded_states[:] = [
            self.make_state("5", unit_of_measurement="bananas"),
            self.make_state("2000", unit_of_measurement="Wh"),
        ]

        self.assertEqual(await self._run(Mock(), restored=2.0), 2.0)

    async def test_a_recorded_total_alone_needs_no_backfill(self) -> None:
        # A lost restore file, with a stale back-fill total in the store.
        await self._run(Mock())
        self.recorded_states[:] = [self.make_state("9.0")]

        self.assertEqual(await self._run(Mock()), 9.0)
