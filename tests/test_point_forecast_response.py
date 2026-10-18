from __future__ import annotations

from homeassistant.util import dt as dt_util

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from _ha_stubs import stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


def _install_import_stubs() -> None:
    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt")
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman import point_forecast_response  # noqa: E402


class PointForecastResponseTests(unittest.TestCase):
    def test_solar_response_excludes_metadata_from_cached_pre_upgrade_snapshot(self) -> None:
        response = point_forecast_response.build_solar_forecast_response(
            {
                "status": "available",
                "unit": "Wh",
                "resolution": "quarter_hour",
                "horizonHours": 24,
                "points": [],
            },
            forecast_days=1,
        )

        self.assertEqual(response["status"], "available")
        self.assertNotIn("resolution", response)
        self.assertNotIn("horizonHours", response)

    def test_solar_response_passes_through_ingestion_normalised_points(self) -> None:
        canonical_points = [
            {"timestamp": f"2026-03-20T21:{minute:02d}:00+01:00", "value": 100.0}
            for minute in (0, 15, 30, 45)
        ] + [
            {"timestamp": f"2026-03-20T22:{minute:02d}:00+01:00", "value": 200.0}
            for minute in (0, 15, 30, 45)
        ]
        history = [
            {"timestamp": "2026-03-20T19:00:00+01:00", "value": 50.0},
            {"timestamp": "2026-03-20T20:00:00+01:00", "value": 100.0},
        ]
        response = point_forecast_response.build_solar_forecast_response(
            {
                "status": "available",
                "unit": "Wh",
                "remainingTodayEnergyEntityId": "sensor.remaining_today_energy",
                "points": canonical_points,
                "actualHistory": history,
            },
            forecast_days=1,
        )

        self.assertEqual(response["points"], canonical_points)
        self.assertEqual(response["actualHistory"], history)

    def test_solar_response_keeps_raw_and_corrected_points_separate(self) -> None:
        raw_points = [
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T21:15:00+01:00", "value": 200.0},
        ]
        corrected_points = [
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 150.0},
            {"timestamp": "2026-03-20T21:15:00+01:00", "value": 50.0},
        ]
        response = point_forecast_response.build_solar_forecast_response(
            {
                "status": "available",
                "unit": "Wh",
                "points": raw_points,
                "rawPoints": raw_points,
                "correctedPoints": corrected_points,
            },
            corrected_points=corrected_points,
            forecast_days=1,
        )

        self.assertEqual(
            [point["timestamp"] for point in response["points"]],
            [point["timestamp"] for point in response["adjustedPoints"]],
        )
        self.assertEqual(
            [point["value"] for point in response["points"]],
            [100.0, 200.0],
        )
        self.assertEqual(
            [point["value"] for point in response["adjustedPoints"]],
            [150.0, 50.0],
        )
        self.assertNotIn("rawPoints", response)
        self.assertNotIn("correctedPoints", response)

    def test_gappy_actual_history_is_not_mis_split(self) -> None:
        """A gappy series without adjacent 15-minute intervals must not be mis-split."""
        snapshot = {
            "status": "available",
            "unit": "Wh",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
            ],
            "actualHistory": [
                {"timestamp": "2026-03-20T10:00:00+01:00", "value": 50.0},
                {"timestamp": "2026-03-20T11:00:00+01:00", "value": 80.0},
            ],
        }
        response = point_forecast_response.build_solar_forecast_response(
            snapshot,
            forecast_days=1,
        )
        self.assertEqual(response["actualHistory"], [
            {"timestamp": "2026-03-20T10:00:00+01:00", "value": 50.0},
            {"timestamp": "2026-03-20T11:00:00+01:00", "value": 80.0},
        ])


if __name__ == "__main__":
    unittest.main()
