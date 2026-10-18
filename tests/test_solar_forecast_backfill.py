import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch
from zoneinfo import ZoneInfo


from custom_components.helman import solar_forecast_backfill as mod  # noqa: E402

TZ = ZoneInfo("Europe/Prague")


def _utc(local_iso: str) -> datetime:
    return datetime.fromisoformat(local_iso).astimezone(timezone.utc)


def _publication(published_local: str, curve: dict[str, float], *, changed=None):
    """A recorded state carrying the whole day's curve as it stood then.

    ``last_changed`` defaults to an *earlier* instant than ``last_updated``,
    which is what Home Assistant records for an attribute-only update -- the
    republished curve under an unchanged day total. Reading the earlier stamp
    would date a revision before it was published.
    """
    updated = datetime.fromisoformat(published_local)
    return SimpleNamespace(
        state="55.3",
        attributes={"wh_period_15m": dict(curve)},
        last_updated=updated,
        last_changed=changed if changed is not None else updated - timedelta(hours=6),
    )


class PublicationSelectionTests(unittest.TestCase):
    """The rule that makes a back-filled row the measurement, not a copy of it."""

    def test_a_slot_takes_the_last_publication_that_predates_it(self):
        # The 2026-08-27 numbers from #178: the same 11:00 slot read four ways.
        states = [
            _publication("2026-08-27T00:00:00+02:00", {"2026-08-27T11:00:00+02:00": 1244.25}),
            _publication("2026-08-27T07:47:00+02:00", {"2026-08-27T11:00:00+02:00": 1091.25}),
            _publication("2026-08-27T10:02:00+02:00", {"2026-08-27T11:00:00+02:00": 1301.0}),
            _publication("2026-08-27T13:32:00+02:00", {"2026-08-27T11:00:00+02:00": 1593.0}),
        ]
        publications = mod._publications(states, TZ)

        samples = mod._slot_samples(
            publications,
            utc_start=_utc("2026-08-27T11:00:00+02:00"),
            utc_end=_utc("2026-08-27T11:15:00+02:00"),
        )

        # 10:02 is the last publication before the slot ran. Reading the entity
        # today would give 1593; the retired trainer took 1244. Neither is what
        # was knowable at 11:00.
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0][1], 1301.0)

    def test_a_slot_no_publication_covers_is_omitted(self):
        """The source had not published that day yet, so nothing was believed."""
        states = [
            _publication(
                "2026-08-26T21:00:00+02:00", {"2026-08-26T23:00:00+02:00": 0.0}
            )
        ]
        publications = mod._publications(states, TZ)

        samples = mod._slot_samples(
            publications,
            utc_start=_utc("2026-08-27T05:00:00+02:00"),
            utc_end=_utc("2026-08-27T06:00:00+02:00"),
        )

        self.assertEqual(samples, [])

    def test_a_publication_is_dated_by_last_updated(self):
        """An attribute-only republication leaves ``last_changed`` behind.

        The curve moves while the headline state -- a rounded day total --
        does not, so ``last_changed`` still points hours earlier. Dating the
        publication by it would let a curve published *after* a slot win the
        "last publication before this slot" test.
        """
        states = [
            _publication("2026-08-27T13:32:00+02:00", {"2026-08-27T11:00:00+02:00": 1593.0}),
        ]
        publications = mod._publications(states, TZ)

        self.assertEqual(len(publications), 1)
        self.assertEqual(
            publications[0][0],
            _utc("2026-08-27T13:32:00+02:00"),
        )

        # And so it does not win a slot that ran before it.
        self.assertEqual(
            mod._slot_samples(
                publications,
                utc_start=_utc("2026-08-27T11:00:00+02:00"),
                utc_end=_utc("2026-08-27T11:15:00+02:00"),
            ),
            [],
        )

    def test_states_without_a_usable_curve_are_skipped(self):
        states = [
            SimpleNamespace(attributes=None, last_changed=datetime.now(TZ)),
            SimpleNamespace(attributes={}, last_changed=datetime.now(TZ)),
            SimpleNamespace(
                attributes={"wh_period_15m": {"not-a-timestamp": 1.0}},
                last_changed=datetime.now(TZ),
            ),
            _publication("2026-08-27T07:47:00+02:00", {"2026-08-27T11:00:00+02:00": 900.0}),
        ]

        self.assertEqual(len(mod._publications(states, TZ)), 1)


class HourlyRowTests(unittest.TestCase):
    def test_an_hour_of_slots_becomes_one_time_weighted_row(self):
        start = _utc("2026-08-27T11:00:00+02:00")
        samples = [
            (start, 1000.0),
            (start + timedelta(minutes=15), 2000.0),
            (start + timedelta(minutes=30), 3000.0),
            (start + timedelta(minutes=45), 4000.0),
        ]

        rows = mod._hourly_rows(
            samples, utc_start=start, utc_end=start + timedelta(hours=1)
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["start"], start)
        # Four equal quarters, so the weighted mean is the plain mean.
        self.assertEqual(rows[0]["mean"], 2500.0)
        self.assertEqual(rows[0]["min"], 1000.0)
        self.assertEqual(rows[0]["max"], 4000.0)

    def test_an_hour_holding_only_its_last_slot_reports_that_slot(self):
        """Not a quarter of it -- the recorder shortens the period instead."""
        start = _utc("2026-08-27T11:00:00+02:00")
        samples = [(start + timedelta(minutes=45), 4000.0)]

        rows = mod._hourly_rows(
            samples, utc_start=start, utc_end=start + timedelta(hours=1)
        )

        self.assertEqual(rows[0]["mean"], 4000.0)

    def test_an_hour_with_no_slots_is_omitted(self):
        """A hole in the source's history stays a hole rather than being filled."""
        start = _utc("2026-08-27T11:00:00+02:00")
        samples = [(start + timedelta(hours=2), 4000.0)]

        rows = mod._hourly_rows(
            samples, utc_start=start, utc_end=start + timedelta(hours=3)
        )

        self.assertEqual([row["start"] for row in rows], [start + timedelta(hours=2)])


class MetadataTests(unittest.TestCase):
    def test_metadata_names_the_recorder_and_the_energy_unit_class(self):
        meta = mod._metadata("sensor.helman_solar_forecast_current")

        # An entity-id-shaped series belongs to the recorder's own table, and
        # async_import_statistics rejects any other source.
        self.assertEqual(meta["source"], "recorder")
        self.assertEqual(meta["statistic_id"], "sensor.helman_solar_forecast_current")
        self.assertEqual(meta["unit_of_measurement"], "Wh")
        # Stated rather than inferred: the target entity carries no device
        # class, so nothing would derive this for the imported rows.
        self.assertEqual(meta["unit_class"], "energy")
        self.assertIs(meta["has_sum"], False)


class TestSolarForecastBackfillWalk(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_mid_walk_resumes_from_stored_cursor(self):
        stored: dict[str, Any] = {}

        class _FakeStore:
            def __init__(self, hass, version, key):
                self.key = key

            async def async_load(self):
                return stored.get(self.key)

            async def async_save(self, doc):
                stored[self.key] = doc

        start_cursor = datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc)
        calls: list[tuple[datetime, datetime]] = []
        call_count = 0

        async def _chunk_with_cancel(hass, source, *, utc_start, utc_end, timezone):
            nonlocal call_count
            calls.append((utc_start, utc_end))
            call_count += 1
            if call_count == 2:
                raise asyncio.CancelledError()
            return [
                mod.StatisticData(
                    start=utc_start,
                    mean=100.0,
                    min=100.0,
                    max=100.0,
                )
            ]

        hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))

        with patch("homeassistant.helpers.storage.Store", _FakeStore), patch(
            "custom_components.helman.statistics_backfill.first_compiled_hour",
            AsyncMock(return_value=start_cursor),
        ), patch(
            "custom_components.helman.statistics_backfill.span_mod.async_forget_imported_statistics",
            AsyncMock(),
        ), patch.object(
            mod, "_chunk_statistics", _chunk_with_cancel
        ), patch.object(
            mod, "async_import_statistics", Mock()
        ), patch.object(
            mod, "_CHUNK_PAUSE_SECONDS", 0
        ):
            with self.assertRaises(asyncio.CancelledError):
                await mod.async_backfill_solar_forecast_statistics(
                    hass, source_entity_id="sensor.solar_source"
                )

        stored_doc = stored[mod._STORAGE_KEY]
        self.assertFalse(stored_doc["done"])
        recorded_cursor = datetime.fromisoformat(stored_doc["oldest_hour"])
        self.assertEqual(recorded_cursor, start_cursor - mod._CHUNK)

        # Now resume without cancellation (resumed chunk has data, subsequent chunk is exhausted)
        resume_calls = 0

        async def _chunk_resume(hass, source, *, utc_start, utc_end, timezone):
            nonlocal resume_calls
            calls.append((utc_start, utc_end))
            resume_calls += 1
            if resume_calls == 1:
                return [
                    mod.StatisticData(
                        start=utc_start,
                        mean=100.0,
                        min=100.0,
                        max=100.0,
                    )
                ]
            return None

        calls.clear()
        with patch("homeassistant.helpers.storage.Store", _FakeStore), patch(
            "custom_components.helman.statistics_backfill.span_mod.async_forget_imported_statistics",
            AsyncMock(),
        ), patch.object(
            mod, "_chunk_statistics", _chunk_resume
        ), patch.object(
            mod, "async_import_statistics", Mock()
        ), patch.object(
            mod, "_CHUNK_PAUSE_SECONDS", 0
        ):
            await mod.async_backfill_solar_forecast_statistics(
                hass, source_entity_id="sensor.solar_source"
            )

        # Resumed from the stored cursor
        self.assertEqual(calls[0][1], recorded_cursor)
        # Done is latched because chunk 1 had data and this chunk is exhausted
        self.assertTrue(stored[mod._STORAGE_KEY]["done"])


if __name__ == "__main__":
    unittest.main()

