"""The battery-forecast back-fill: the factor, the metadata split, the done-marker.

P1 retired ``BatteryForecastHistoryStore`` and published five entities in its
place, leaving its ``.storage`` file orphaned -- frozen, unread, unpruned. This
module writes those ninety days into the five entities' hourly statistics once,
so a purged inspector day draws a battery/grid forecast beside its actuals.

The one thing that is silent when wrong is the factor. The four Wh entities each
publish *one 15-minute slot's* energy, and
``statistics_day._forecast_wh_points`` recovers an hour's forecast as
``mean * _KWH_TO_WH * _SLOTS_PER_HOUR``. So the mean this back-fill writes for an
hour is that hour's slot values summed over four -- a sum-instead-of-mean or a
kWh/Wh slip is a constant factor on every back-filled day and no error. The
round trip is pinned against what ``statistics_day`` actually reads back.

``socPct`` is a percentage, not an energy: its hourly figure is the plain mean
of the hour's slots and its unit class is ``unitless``, not ``energy``.

Faked at the boundary -- ``async_import_statistics``,
``_first_hour_home_assistant_owns`` and ``Store`` -- so the module under test is
really exercised, in the style of ``test_solar_forecast_slot_history.py``.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from custom_components.helman import battery_forecast_backfill as mod  # noqa: E402
from custom_components.helman.solar_bias_correction import statistics_day  # noqa: E402

TZ = ZoneInfo("Europe/Prague")
HASS = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))

SOC = mod.BATTERY_SOC_FORECAST_CURRENT_ENTITY
GRID_NET = mod.GRID_NET_FORECAST_CURRENT_ENTITY
GRID_EXPORT = mod.GRID_EXPORT_FORECAST_CURRENT_ENTITY

#: Every hour Home Assistant owns is at or after this; the archive's days are all
#: older, so nothing is excluded unless a test moves it.
FAR_FUTURE = datetime(2027, 1, 1, tzinfo=timezone.utc)


class _FakeStore:
    """Stands in for both the source file and the done-marker.

    ``_SOURCES`` and ``_MARKER`` below are rebound per test; the fake dispatches
    on the storage key it was constructed with.
    """

    _SOURCES: dict[str, object] = {}
    _MARKER: dict[str, object] = {}

    def __init__(self, hass, version, key) -> None:
        self._key = key

    async def async_load(self):
        if self._key == mod._SOURCE_STORAGE_KEY:
            value = _FakeStore._SOURCES.get(self._key, "__missing__")
            if value == "__missing__":
                return None
            if isinstance(value, Exception):
                raise value
            return value
        return _FakeStore._MARKER.get(self._key)

    async def async_save(self, document):
        _FakeStore._MARKER[self._key] = document


def _run(days, *, first_owned=FAR_FUTURE, marker=None):
    """Run the back-fill against ``days`` and return every imported row.

    Returns ``(imports, marker_document)`` where ``imports`` is a list of
    ``(metadata, [rows])`` in call order.
    """
    imports: list[tuple[dict, list[dict]]] = []
    _FakeStore._SOURCES = (
        {mod._SOURCE_STORAGE_KEY: {"days": days}} if days is not None else {}
    )
    _FakeStore._MARKER = dict(marker or {})

    async def _fake_first_owned(hass, entity_id):
        return first_owned

    with patch.object(mod, "storage", SimpleNamespace(Store=_FakeStore)), patch.object(
        mod, "_first_hour_home_assistant_owns", _fake_first_owned
    ), patch.object(
        mod,
        "async_import_statistics",
        lambda hass, metadata, rows: imports.append(
            (dict(metadata), [dict(r) for r in rows])
        ),
    ), patch.object(
        mod, "_CHUNK_PAUSE_SECONDS", 0
    ):
        asyncio.run(mod.async_backfill_battery_forecast_statistics(HASS))

    return imports, _FakeStore._MARKER.get(mod._STORAGE_KEY)


def _rows_for(imports, entity_id):
    return {
        row["start"]: row
        for metadata, rows in imports
        if metadata["statistic_id"] == entity_id
        for row in rows
    }


def _meta_for(imports, entity_id):
    for metadata, _rows in imports:
        if metadata["statistic_id"] == entity_id:
            return metadata
    raise AssertionError(f"no import for {entity_id}")


class TestTheFactor(unittest.TestCase):
    """The round trip: a known slot map out one side, the same hour's Wh the other."""

    def test_an_hours_forecast_energy_is_the_sum_of_its_four_archived_slots(self):
        slots = {
            "07:00": {"gridNetWh": 100.0},
            "07:15": {"gridNetWh": 200.0},
            "07:30": {"gridNetWh": 300.0},
            "07:45": {"gridNetWh": 400.0},
        }
        imports, _marker = _run({"2026-05-20": slots})

        rows = _rows_for(imports, GRID_NET)
        # 2026-05-20 07:00 Prague (CEST) is 05:00 UTC.
        hour_utc = datetime(2026, 5, 20, 5, 0, tzinfo=timezone.utc)
        self.assertEqual(set(rows), {hour_utc})
        written_mean_wh = rows[hour_utc]["mean"]

        # What the span read hands back: the energy class's kWh, so Wh / 1000.
        mean_kwh = written_mean_wh / statistics_day._KWH_TO_WH
        point = statistics_day._forecast_wh_points(
            {hour_utc: {"mean": mean_kwh}}, date(2026, 5, 20)
        )[0]

        self.assertEqual(point["wh"], 100.0 + 200.0 + 300.0 + 400.0)
        # And the pin the other way: a bare mean would have quartered it.
        self.assertEqual(written_mean_wh, (100.0 + 200.0 + 300.0 + 400.0) / 4)
        self.assertEqual(rows[hour_utc]["min"], 100.0)
        self.assertEqual(rows[hour_utc]["max"], 400.0)

    def test_an_hour_missing_two_slots_still_round_trips_to_the_recorded_sum(self):
        # batteryNetWh landed after the first release; days archived before it
        # simply lack the key, and a slot without a key is no sample, not a zero.
        slots = {
            "07:00": {"gridExportWh": 120.0},
            "07:15": {"gridExportWh": 80.0},
            "07:30": {"socPct": 55.0},  # no gridExportWh here
            "07:45": {},
        }
        imports, _marker = _run({"2026-05-20": slots})

        rows = _rows_for(imports, GRID_EXPORT)
        hour_utc = datetime(2026, 5, 20, 5, 0, tzinfo=timezone.utc)
        mean_kwh = rows[hour_utc]["mean"] / statistics_day._KWH_TO_WH
        point = statistics_day._forecast_wh_points(
            {hour_utc: {"mean": mean_kwh}}, date(2026, 5, 20)
        )[0]

        # Only the two slots that carried the key contribute.
        self.assertEqual(point["wh"], 200.0)


class TestSocIsNotAnEnergy(unittest.TestCase):
    def test_soc_is_the_plain_mean_of_the_hours_slots(self):
        slots = {
            "07:00": {"socPct": 50.0},
            "07:15": {"socPct": 52.0},
            "07:30": {"socPct": 54.0},
            "07:45": {"socPct": 56.0},
        }
        imports, _marker = _run({"2026-05-20": slots})

        rows = _rows_for(imports, SOC)
        hour_utc = datetime(2026, 5, 20, 5, 0, tzinfo=timezone.utc)
        self.assertEqual(rows[hour_utc]["mean"], 53.0)

    def test_the_percentage_metadata_is_unitless_and_the_energies_are_energy(self):
        slots = {"07:00": {"socPct": 50.0, "gridNetWh": 100.0}}
        imports, _marker = _run({"2026-05-20": slots})

        soc_meta = _meta_for(imports, SOC)
        self.assertEqual(soc_meta["unit_class"], "unitless")
        self.assertEqual(soc_meta["unit_of_measurement"], "%")
        self.assertEqual(soc_meta["source"], "recorder")
        self.assertEqual(soc_meta["mean_type"], mod.StatisticMeanType.ARITHMETIC)
        self.assertIs(soc_meta["has_sum"], False)

        grid_meta = _meta_for(imports, GRID_NET)
        self.assertEqual(grid_meta["unit_class"], "energy")
        self.assertEqual(grid_meta["unit_of_measurement"], "Wh")
        self.assertEqual(grid_meta["source"], "recorder")

    def test_a_signed_energy_series_keeps_its_sign(self):
        slots = {
            "07:00": {"batteryNetWh": -400.0},
            "07:15": {"batteryNetWh": -200.0},
            "07:30": {"batteryNetWh": 200.0},
            "07:45": {"batteryNetWh": 400.0},
        }
        imports, _marker = _run({"2026-05-20": slots})

        rows = _rows_for(imports, mod.BATTERY_NET_FORECAST_CURRENT_ENTITY)
        hour_utc = datetime(2026, 5, 20, 5, 0, tzinfo=timezone.utc)
        self.assertEqual(rows[hour_utc]["mean"], 0.0)
        self.assertEqual(rows[hour_utc]["min"], -400.0)
        self.assertEqual(rows[hour_utc]["max"], 400.0)


class TestWhatIsAndIsNotWritten(unittest.TestCase):
    def test_no_hour_home_assistant_already_compiled_is_written(self):
        days = {
            "2026-05-19": {"23:00": {"gridNetWh": 10.0}},
            "2026-05-20": {
                "06:00": {"gridNetWh": 20.0},
                "07:00": {"gridNetWh": 30.0},
            },
        }
        # HA owns 2026-05-20 05:00 UTC onward (the 07:00 Prague slot's hour).
        first_owned = datetime(2026, 5, 20, 5, 0, tzinfo=timezone.utc)
        imports, _marker = _run(days, first_owned=first_owned)

        written = sorted(_rows_for(imports, GRID_NET))
        self.assertTrue(written)
        self.assertTrue(all(hour < first_owned for hour in written))
        # The 07:00 Prague slot falls in the owned hour and is dropped; the
        # 06:00 one (04:00 UTC) and the previous evening survive.
        self.assertEqual(written[-1], datetime(2026, 5, 20, 4, 0, tzinfo=timezone.utc))

    def test_an_hour_with_no_sample_for_the_series_is_omitted(self):
        slots = {"07:00": {"socPct": 55.0}, "07:15": {"socPct": 56.0}}
        imports, _marker = _run({"2026-05-20": slots})

        # SoC has rows; the four Wh series have no sample anywhere, so no import.
        self.assertEqual(_rows_for(imports, GRID_NET), {})
        self.assertTrue(_rows_for(imports, SOC))

    def test_unparseable_days_and_slot_labels_are_skipped_not_fatal(self):
        days = {
            "not-a-date": {"07:00": {"gridNetWh": 1.0}},
            "2026-05-20": {
                "7am": {"gridNetWh": 2.0},
                "07:07": {"gridNetWh": 3.0},  # off the 15-minute grid
                "07:00": {"gridNetWh": 4.0},
            },
        }
        imports, _marker = _run(days)

        rows = _rows_for(imports, GRID_NET)
        hour_utc = datetime(2026, 5, 20, 5, 0, tzinfo=timezone.utc)
        self.assertEqual(set(rows), {hour_utc})
        self.assertEqual(rows[hour_utc]["mean"], 4.0 / 4)


class TestSourceFile(unittest.TestCase):
    def test_a_missing_source_file_is_a_no_op(self):
        imports, marker = _run(None)
        self.assertEqual(imports, [])
        self.assertIsNone(marker)

    def test_an_unreadable_source_file_is_a_no_op(self):
        _FakeStore._SOURCES = {mod._SOURCE_STORAGE_KEY: ValueError("corrupt json")}
        _FakeStore._MARKER = {}

        async def _fake_first_owned(hass, entity_id):
            return FAR_FUTURE

        with patch.object(
            mod, "storage", SimpleNamespace(Store=_FakeStore)
        ), patch.object(
            mod, "_first_hour_home_assistant_owns", _fake_first_owned
        ), patch.object(
            mod, "async_import_statistics", lambda *a: self.fail("imported from a bad file")
        ):
            asyncio.run(mod.async_backfill_battery_forecast_statistics(HASS))

    def test_an_empty_days_map_is_a_no_op(self):
        imports, marker = _run({})
        self.assertEqual(imports, [])
        self.assertIsNone(marker)


class TestDoneMarker(unittest.TestCase):
    def test_a_second_run_writes_nothing(self):
        days = {"2026-05-20": {"07:00": {"socPct": 50.0, "gridNetWh": 100.0}}}

        first_imports, marker = _run(days)
        self.assertTrue(first_imports)
        self.assertEqual(
            set(marker["done"]),
            {series.entity_id for series in mod._SERIES},
        )

        second_imports, _marker = _run(days, marker={mod._STORAGE_KEY: marker})
        self.assertEqual(second_imports, [])

    def test_a_partially_finished_run_resumes_on_the_unwritten_series(self):
        days = {"2026-05-20": {"07:00": {"socPct": 50.0, "gridNetWh": 100.0}}}
        prior = {mod._STORAGE_KEY: {"version": mod._STORAGE_VERSION, "done": [SOC]}}

        imports, marker = _run(days, marker=prior)

        touched = {metadata["statistic_id"] for metadata, _rows in imports}
        self.assertNotIn(SOC, touched)
        self.assertIn(GRID_NET, touched)
        self.assertIn(SOC, marker["done"])


class TestPacing(unittest.TestCase):
    def test_the_import_is_chunked_by_span(self):
        # Twenty days of one slot an hour: more than _CHUNK, so more than one
        # import call, and every row still lands exactly once.
        days = {
            f"2026-04-{day:02d}": {
                f"{hour:02d}:00": {"gridNetWh": float(hour)} for hour in range(24)
            }
            for day in range(1, 21)
        }
        imports, _marker = _run(days)

        grid_calls = [
            rows for metadata, rows in imports if metadata["statistic_id"] == GRID_NET
        ]
        self.assertGreater(len(grid_calls), 1)
        starts = [row["start"] for rows in grid_calls for row in rows]
        self.assertEqual(len(starts), len(set(starts)))
        self.assertEqual(starts, sorted(starts))


if __name__ == "__main__":
    unittest.main()
