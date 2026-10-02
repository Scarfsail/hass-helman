"""``helman/device_report``: validation, the coordinator entry point and the read.

Runs the real websocket handler, the real coordinator method, the real span
read and the real dataset. The recorder is faked at ``statistics_during_period``
-- the one call the span read makes -- so the windows it is asked for are what
these tests assert on, and the price reader is answered empty: rates are the
dataset tests' business.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import voluptuous as vol  # noqa: E402

coordinator_module = importlib.import_module("custom_components.helman.coordinator")
websockets_module = importlib.import_module("custom_components.helman.websockets")
span_module = importlib.import_module("custom_components.helman.recorder_statistics_span")
span_history_module = importlib.import_module("custom_components.helman.span_history")
model = importlib.import_module("custom_components.helman.span_history_model")
const = importlib.import_module("custom_components.helman.const")

PRAGUE = ZoneInfo("Europe/Prague")
HOUSE_METER = "sensor.house_energy"
WASHER = "sensor.washer_energy"
METERS = model.SpanMeters(
    solar="sensor.solar_total",
    grid_import="sensor.grid_import",
    grid_export="sensor.grid_export",
    house=HOUSE_METER,
    battery_charge="sensor.batt_charge",
    battery_discharge="sensor.batt_discharge",
)
TREE = {
    "consumers": [
        {
            "id": "house",
            "displayName": "",
            "icon": "mdi:home",
            "children": [
                {
                    "id": WASHER,
                    "displayName": "Washer",
                    "icon": None,
                    "energyEntityId": WASHER,
                    "isEstimated": False,
                    "isUnmeasured": False,
                    "children": [],
                }
            ],
        }
    ]
}


class FakeConnection:
    def __init__(self) -> None:
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class FakeService:
    def __init__(self, meters: model.SpanMeters = METERS) -> None:
        self.meters = meters

    def energy_meter_entity_ids(self) -> model.SpanMeters:
        return self.meters

    def grid_import_price_config(self):
        return None

    async def async_resolve_span_currency(self, import_price_config):
        return "CZK"

    async def async_history_floor(self, local_now):
        return date(2026, 1, 1)


class FakeRecorder:
    """``statistics_during_period``, serving cumulative ``state`` rows per period."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.rows: dict[str, dict[str, list[dict]]] = {"hour": {}, "5minute": {}}

    def hourly(self, statistic_id: str, first: datetime, last: datetime) -> None:
        """One kWh per hour from ``first`` to ``last`` (hour starts, inclusive)."""
        rows = []
        cursor, total = first, 100.0
        while cursor <= last:
            start = cursor.timestamp()
            rows.append({"start": start, "end": start + 3600.0, "state": total})
            cursor += timedelta(hours=1)
            total += 1.0
        self.rows["hour"][statistic_id] = rows

    def __call__(self, hass, start_time, end_time, statistic_ids, period, units, types_):
        self.calls.append({"start": start_time, "end": end_time, "period": period})
        lower, upper = start_time.timestamp(), end_time.timestamp()
        return {
            statistic_id: [row for row in rows if lower <= row["start"] < upper]
            for statistic_id, rows in self.rows.get(period, {}).items()
            if statistic_id in statistic_ids
        }

    def last(self, hass, number_of_stats, statistic_id, convert_units, types_):
        """``get_last_statistics``: the newest hourly row, whatever its window."""
        rows = self.rows["hour"].get(statistic_id) or []
        return {statistic_id: rows[-number_of_stats:]} if rows else {}

    def tail_calls(self) -> list[dict]:
        return [call for call in self.calls if call["period"] == "5minute"]


async def _executor(func, *args):
    await asyncio.sleep(0)
    return func(*args)


class DeviceReportTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.recorder = FakeRecorder()
        self.coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        self.coordinator._cached_tree = TREE
        self.coordinator._solar_bias_service = FakeService()
        self.hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            data={const.DOMAIN: {"coordinator": self.coordinator}},
        )
        self.coordinator._hass = self.hass
        empty_prices = {
            const.GRID_IMPORT_PRICE_ENTITY_ID: span_module.PriceHistory(by_slot={}),
            const.GRID_EXPORT_PRICE_ENTITY_ID: span_module.PriceHistory(by_slot={}),
        }
        for patcher in (
            patch.object(span_module, "statistics_during_period", self.recorder),
            patch(
                "homeassistant.components.recorder.statistics.get_last_statistics",
                self.recorder.last,
            ),
            patch.object(
                span_module,
                "get_instance",
                lambda hass: SimpleNamespace(async_add_executor_job=_executor),
            ),
            patch.object(
                span_history_module,
                "query_price_history",
                AsyncMock(return_value=empty_prices),
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def request(self, now: datetime, start: str, end: str, report: str = "ranking"):
        connection = FakeConnection()
        msg = {
            "id": 7,
            "type": "helman/device_report",
            "report": report,
            "start_date": start,
            "end_date": end,
        }
        with patch("homeassistant.util.dt.now", return_value=now):
            await websockets_module.ws_get_device_report.__wrapped__(
                self.hass, connection, msg
            )
        return connection

    async def report(self, now: datetime, start: str, end: str) -> dict:
        connection = await self.request(now, start, end)
        self.assertEqual(connection.errors, [])
        return connection.results[0][1]


def _local(*args) -> datetime:
    return datetime(*args, tzinfo=PRAGUE)


class TestValidation(DeviceReportTestCase):
    NOW = _local(2026, 9, 15, 14, 0)

    async def test_bad_dates_are_rejected(self):
        for start, end in (("2026-13-01", "2026-09-01"), ("20260901", "2026-09-02")):
            with self.subTest(start=start):
                connection = await self.request(self.NOW, start, end)
                self.assertEqual(connection.errors[0][1], "invalid_date")

    async def test_more_than_366_days_is_rejected(self):
        connection = await self.request(self.NOW, "2025-01-01", "2026-01-02")
        self.assertEqual(connection.errors[0][1], "invalid_date")
        payload = await self.report(self.NOW, "2025-01-01", "2026-01-01")
        self.assertEqual(payload["start_date"], "2025-01-01")

    async def test_start_after_end_is_rejected(self):
        connection = await self.request(self.NOW, "2026-09-10", "2026-09-01")
        self.assertEqual(connection.errors[0][1], "invalid_date")

    def test_an_unknown_report_is_rejected_by_the_schema(self):
        schema = websockets_module.ws_get_device_report._ws_schema
        message = {
            "id": 1,
            "type": "helman/device_report",
            "report": "ranking",
            "start_date": "2026-09-01",
            "end_date": "2026-09-30",
        }
        self.assertEqual(schema(dict(message))["report"], "ranking")
        with self.assertRaises(vol.Invalid):
            schema({**message, "report": "nope"})

    async def test_a_future_end_date_is_clamped_to_today(self):
        payload = await self.report(self.NOW, "2026-09-10", "2026-12-31")
        self.assertEqual(payload["end_date"], "2026-09-15")


class TestPayload(DeviceReportTestCase):
    async def test_the_ranking_shape(self):
        now = _local(2026, 9, 15, 14, 0)
        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 9, 23), _local(2026, 9, 10, 23))
        self.recorder.hourly(WASHER, _local(2026, 9, 9, 23), _local(2026, 9, 10, 23))
        payload = await self.report(now, "2026-09-10", "2026-09-10")

        self.assertEqual(payload["report"], "ranking")
        self.assertEqual(
            payload["meters"], {"grid": True, "solar": True, "battery": True, "house": True}
        )
        self.assertEqual(payload["as_of"], now.isoformat())
        self.assertEqual(payload["range"], {"minDate": "2026-01-01", "maxDate": "2026-09-15"})
        self.assertEqual(payload["currency"], "CZK")
        self.assertTrue(payload["complete"])
        rows = {row["id"]: row for row in payload["nodes"]}
        self.assertEqual(payload["nodes"][0]["id"], "house")
        self.assertEqual(rows["house"]["kwh"], 24.0)
        self.assertEqual(rows[WASHER]["kwh"], 24.0)
        self.assertEqual(rows["house"]["children"], [WASHER, "house_unmeasured"])
        # No grid meter read anything, so nothing is attributed.
        self.assertEqual(rows[WASHER]["sources"]["unattributed"], 24.0)
        self.assertEqual(rows[WASHER]["coverage"], 1.0)

    async def test_complete_follows_the_recorder_not_the_clock(self):
        now = _local(2026, 9, 16, 0, 20)
        # The 23:00 hour is not compiled yet at 00:20.
        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 14, 23), _local(2026, 9, 15, 22))
        payload = await self.report(now, "2026-09-15", "2026-09-15")
        self.assertFalse(payload["complete"])

        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 14, 23), _local(2026, 9, 15, 23))
        payload = await self.report(now, "2026-09-15", "2026-09-15")
        self.assertTrue(payload["complete"])

    async def test_an_hour_skipped_by_an_outage_does_not_keep_it_incomplete(self):
        now = _local(2026, 9, 16, 9, 0)
        # Home Assistant was down from 22:00 to 01:00: the period's last hour
        # never gets a row, but the recorder has moved past it.
        rows = self.recorder.rows["hour"]
        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 16, 1), _local(2026, 9, 16, 7))
        after = rows[HOUSE_METER]
        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 14, 23), _local(2026, 9, 15, 21))
        rows[HOUSE_METER] = rows[HOUSE_METER] + after
        payload = await self.report(now, "2026-09-15", "2026-09-15")
        self.assertTrue(payload["complete"])

    async def test_a_failed_statistics_read_is_an_error_not_an_empty_report(self):
        now = _local(2026, 9, 16, 9, 0)
        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 14, 23), _local(2026, 9, 16, 7))

        def _explode(*args):
            raise RuntimeError("statistics read failed")

        with patch.object(span_module, "statistics_during_period", _explode):
            connection = await self.request(now, "2026-09-15", "2026-09-15")
        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors[0][1], "internal_error")

    async def test_an_open_period_is_incomplete(self):
        now = _local(2026, 9, 15, 14, 0)
        self.recorder.hourly(HOUSE_METER, _local(2026, 9, 14, 23), _local(2026, 9, 15, 12))
        payload = await self.report(now, "2026-09-15", "2026-09-15")
        self.assertFalse(payload["complete"])


class TestTailWindow(DeviceReportTestCase):
    async def test_a_period_ending_today_reads_the_last_three_hours(self):
        await self.report(_local(2026, 9, 15, 14, 0), "2026-09-01", "2026-09-15")
        (tail,) = self.recorder.tail_calls()
        self.assertEqual(tail["start"], _local(2026, 9, 15, 11, 0).astimezone(timezone.utc))

    async def test_yesterdays_period_just_after_midnight_reads_its_last_three_hours(self):
        await self.report(_local(2026, 9, 16, 0, 20), "2026-09-15", "2026-09-15")
        (tail,) = self.recorder.tail_calls()
        self.assertEqual(tail["start"], _local(2026, 9, 15, 21, 0).astimezone(timezone.utc))
        self.assertEqual(tail["end"], _local(2026, 9, 16, 0, 0).astimezone(timezone.utc))

    async def test_a_period_that_ended_over_three_hours_ago_reads_no_tail(self):
        await self.report(_local(2026, 9, 16, 4, 0), "2026-09-15", "2026-09-15")
        self.assertEqual(self.recorder.tail_calls(), [])

    async def test_a_dst_change_day_reads_three_elapsed_hours(self):
        # 03:00 CET on the fall-back day: three elapsed hours back is 01:00 CEST,
        # not the wall clock's 00:00.
        now = datetime(2026, 10, 25, 3, 0, tzinfo=PRAGUE, fold=1)
        self.assertEqual(now.utcoffset(), timedelta(hours=1))
        await self.report(now, "2026-10-25", "2026-10-25")
        (tail,) = self.recorder.tail_calls()
        self.assertEqual(tail["start"], now.astimezone(timezone.utc) - timedelta(hours=3))
        self.assertEqual(tail["start"], datetime(2026, 10, 24, 23, 0, tzinfo=timezone.utc))


class TestUnavailable(DeviceReportTestCase):
    NOW = _local(2026, 9, 15, 14, 0)

    async def test_without_a_house_node(self):
        self.coordinator._cached_tree = {"consumers": []}
        payload = await self.report(self.NOW, "2026-09-01", "2026-09-10")
        self.assertEqual(payload, {"unavailable": "no_house_node"})
        self.assertEqual(self.recorder.calls, [])

    async def test_without_a_house_meter(self):
        self.coordinator._solar_bias_service = FakeService(METERS._replace(house=None))
        payload = await self.report(self.NOW, "2026-09-01", "2026-09-10")
        self.assertEqual(payload, {"unavailable": "no_house_meter"})
        self.assertEqual(self.recorder.calls, [])



class TestTariffSampling(unittest.TestCase):
    def test_a_fractional_offset_hour_is_sampled_from_its_own_minute(self):
        from custom_components.helman.grid_price_forecast_builder import (
            FixedGridImportPriceWindow,
        )

        windows = (
            FixedGridImportPriceWindow(start_minutes=0, end_minutes=8 * 60, price=1.0),
            FixedGridImportPriceWindow(start_minutes=8 * 60, end_minutes=24 * 60, price=3.0),
        )
        kolkata = ZoneInfo("Asia/Kolkata")
        # A statistics hour starting 07:30 local: half at the night rate, half at the day rate.
        rate = span_history_module._config_import_rate(
            windows, datetime(2026, 9, 15, 7, 30, tzinfo=kolkata)
        )
        self.assertAlmostEqual(rate, 2.0)

if __name__ == "__main__":
    unittest.main()
