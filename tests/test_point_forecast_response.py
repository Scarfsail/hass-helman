from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from _ha_stubs import install_helman_packages, stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


def _install_import_stubs() -> None:
    install_helman_packages()
    stub_module("homeassistant")
    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt")
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
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

    @staticmethod
    def parse_datetime(value: str) -> datetime:
        return datetime.fromisoformat(value)


_install_import_stubs()

from custom_components.helman import point_forecast_response  # noqa: E402


class PointForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(point_forecast_response, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    def test_solar_response_splits_an_hourly_feed_onto_the_canonical_grid(self) -> None:
        response = point_forecast_response.build_solar_forecast_response(
            {
                "status": "available",
                "unit": "Wh",
                "remainingTodayEnergyEntityId": "sensor.remaining_today_energy",
                "points": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "value": 400.0,
                    },
                    {
                        "timestamp": "2026-03-20T22:00:00+01:00",
                        "value": 800.0,
                    },
                ],
                "actualHistory": [
                    {
                        "timestamp": "2026-03-20T19:00:00+01:00",
                        "value": 200.0,
                    },
                    {
                        "timestamp": "2026-03-20T20:00:00+01:00",
                        "value": 400.0,
                    },
                ],
            },
            forecast_days=1,
        )

        # 400 Wh over the 21:00 hour is 100 Wh a quarter, 800 over 22:00 is 200.
        self.assertEqual(response["resolution"], "quarter_hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["points"], [
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T21:15:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T21:30:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T21:45:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T22:00:00+01:00", "value": 200.0},
            {"timestamp": "2026-03-20T22:15:00+01:00", "value": 200.0},
            {"timestamp": "2026-03-20T22:30:00+01:00", "value": 200.0},
            {"timestamp": "2026-03-20T22:45:00+01:00", "value": 200.0},
        ])
        self.assertEqual(
            [entry["value"] for entry in response["actualHistory"]],
            [50.0] * 4 + [100.0] * 4,
        )

    def test_solar_response_expands_raw_and_corrected_points_with_same_slots(self) -> None:
        response = point_forecast_response.build_solar_forecast_response(
            {
                "status": "available",
                "unit": "Wh",
                "points": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "value": 400.0,
                    },
                    {
                        "timestamp": "2026-03-20T22:00:00+01:00",
                        "value": 800.0,
                    },
                ],
                "rawPoints": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "value": 400.0,
                    },
                ],
                "correctedPoints": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "value": 600.0,
                    },
                ],
            },
            corrected_points=[
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "value": 600.0,
                },
                {
                    "timestamp": "2026-03-20T22:00:00+01:00",
                    "value": 200.0,
                },
            ],
            forecast_days=1,
        )

        self.assertEqual(
            [point["timestamp"] for point in response["points"]],
            [point["timestamp"] for point in response["adjustedPoints"]],
        )
        self.assertEqual(
            [point["value"] for point in response["points"]],
            [100.0] * 4 + [200.0] * 4,
        )
        self.assertEqual(
            [point["value"] for point in response["adjustedPoints"]],
            [150.0] * 4 + [50.0] * 4,
        )
        self.assertNotIn("rawPoints", response)
        self.assertNotIn("correctedPoints", response)

if __name__ == "__main__":
    unittest.main()
