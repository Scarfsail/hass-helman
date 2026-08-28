from __future__ import annotations

import asyncio
import sys
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from custom_components.helman import solar_forecast_history  # noqa: E402
from custom_components.helman.solar_forecast_history import (  # noqa: E402
    SolarForecastHistoryStore,
)

TZ = ZoneInfo("Europe/Prague")


class _FakeStore:
    """Stands in for ``homeassistant.helpers.storage.Store``."""

    def __init__(self, *args, **kwargs) -> None:
        self.saved: dict | None = None
        self.stored: dict | None = None
        self.save_count = 0

    async def async_load(self):
        return self.stored

    def async_delay_save(self, data_func, delay):
        self.saved = data_func()
        self.save_count += 1


def _make_store(stored: dict | None = None) -> SolarForecastHistoryStore:
    with patch.object(solar_forecast_history.storage, "Store", _FakeStore):
        store = SolarForecastHistoryStore(SimpleNamespace())
    store._store.stored = stored
    asyncio.run(store.async_load())
    return store


def _point(local_ts: str, value: float) -> dict:
    return {"timestamp": local_ts, "value": value}


class RecordPointsTests(unittest.TestCase):
    def test_records_the_slots_that_have_not_started(self):
        store = _make_store()

        store.record_points(
            [
                _point("2026-08-27T11:00:00+02:00", 900.0),
                _point("2026-08-27T11:15:00+02:00", 950.0),
            ],
            local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(
            store.slots_for_day(date(2026, 8, 27)),
            {"11:00": 900.0, "11:15": 950.0},
        )

    def test_an_elapsed_slot_survives_a_later_revision(self):
        """The whole point: the fit must not see a slot re-read after the fact.

        The source republishes the entire day, so the 11:00 slot arrives again
        at 13:32 carrying the provider's revised figure. That revision is
        weather being re-read, not this array's own bias, and booking it would
        be exactly the measurement being retired.
        """
        store = _make_store()

        store.record_points(
            [_point("2026-08-27T11:00:00+02:00", 900.0)],
            local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ),
            timezone=TZ,
        )
        store.record_points(
            [
                _point("2026-08-27T11:00:00+02:00", 1314.0),
                _point("2026-08-27T14:00:00+02:00", 800.0),
            ],
            local_now=datetime(2026, 8, 27, 13, 32, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(
            store.slots_for_day(date(2026, 8, 27)),
            {"11:00": 900.0, "14:00": 800.0},
        )

    def test_the_slot_just_starting_is_still_recorded(self):
        """The rebuild fires *at* the boundary, so its ``now`` is a hair past it."""
        store = _make_store()

        store.record_points(
            [_point("2026-08-27T11:00:00+02:00", 900.0)],
            local_now=datetime(2026, 8, 27, 11, 0, 0, 431000, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {"11:00": 900.0})

    def test_a_mid_slot_rebuild_leaves_the_slot_in_progress_alone(self):
        store = _make_store()

        store.record_points(
            [
                _point("2026-08-27T11:00:00+02:00", 900.0),
                _point("2026-08-27T11:15:00+02:00", 950.0),
            ],
            local_now=datetime(2026, 8, 27, 11, 7, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {"11:15": 950.0})

    def test_other_days_and_off_grid_points_are_ignored(self):
        store = _make_store()

        store.record_points(
            [
                _point("2026-08-27T12:00:00+02:00", 900.0),
                # Tomorrow: recorded on its own day, at its own horizon.
                _point("2026-08-28T12:00:00+02:00", 1000.0),
                # Not on a 15-minute boundary.
                _point("2026-08-27T12:07:00+02:00", 1100.0),
                _point("2026-08-27T12:30:30+02:00", 1200.0),
            ],
            local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {"12:00": 900.0})
        self.assertEqual(store.slots_for_day(date(2026, 8, 28)), {})

    def test_malformed_points_are_skipped(self):
        store = _make_store()

        store.record_points(
            [
                "not a point",
                {"timestamp": 12345, "value": 1.0},
                {"timestamp": "not a timestamp", "value": 1.0},
                {"timestamp": "2026-08-27T12:00:00+02:00", "value": None},
                _point("2026-08-27T12:15:00+02:00", 900.0),
            ],
            local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {"12:15": 900.0})

    def test_a_rebuild_that_changes_nothing_writes_nothing(self):
        store = _make_store()
        points = [_point("2026-08-27T12:00:00+02:00", 900.0)]

        store.record_points(
            points, local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ), timezone=TZ
        )
        store.record_points(
            points, local_now=datetime(2026, 8, 27, 11, 15, tzinfo=TZ), timezone=TZ
        )

        self.assertEqual(store._store.save_count, 1)

    def test_naive_timestamps_are_read_in_the_local_zone(self):
        store = _make_store()

        store.record_points(
            [_point("2026-08-27T12:00:00", 900.0)],
            local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ),
            timezone=TZ,
        )

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {"12:00": 900.0})

    def test_days_past_the_retention_window_are_pruned(self):
        retention = solar_forecast_history.SOLAR_FORECAST_HISTORY_RETENTION_DAYS
        today = date(2026, 8, 27)
        stale = today - timedelta(days=retention + 1)
        keep = today - timedelta(days=retention - 1)
        store = _make_store(
            {
                "days": {
                    stale.isoformat(): {"12:00": 1.0},
                    keep.isoformat(): {"12:00": 2.0},
                    "not-a-date": {"12:00": 3.0},
                }
            }
        )

        store.record_points(
            [_point("2026-08-27T12:00:00+02:00", 900.0)],
            local_now=datetime(2026, 8, 27, 11, 0, tzinfo=TZ),
            timezone=TZ,
        )

        saved_days = store._store.saved["days"]
        self.assertNotIn(stale.isoformat(), saved_days)
        self.assertNotIn("not-a-date", saved_days)
        self.assertIn(keep.isoformat(), saved_days)
        self.assertIn(today.isoformat(), saved_days)


class SlotsForDayTests(unittest.TestCase):
    def test_a_day_that_was_never_recorded_reads_empty(self):
        store = _make_store()

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {})

    def test_unparseable_stored_entries_are_dropped(self):
        store = _make_store(
            {
                "days": {
                    "2026-08-27": {
                        "12:00": 900.0,
                        "12:07": 100.0,  # not a slot boundary
                        "noon": 200.0,
                        "12:30": "nine hundred",
                    }
                }
            }
        )

        self.assertEqual(store.slots_for_day(date(2026, 8, 27)), {"12:00": 900.0})


if __name__ == "__main__":
    unittest.main()
