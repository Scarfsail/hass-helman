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
        import_mock.assert_called_once()

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
