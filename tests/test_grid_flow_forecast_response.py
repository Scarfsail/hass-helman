from __future__ import annotations

from homeassistant.util import dt as dt_util

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from _ha_stubs import stub_ha_dt, stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


from custom_components.helman import grid_flow_forecast_response  # noqa: E402


def _make_snapshot(*, include_baseline: bool = True, schedule_adjusted: bool = True) -> dict:
    snapshot = {
        "status": "partial",
        "generatedAt": "2026-03-20T21:20:30+01:00",
        "startedAt": "2026-03-20T21:20:00+01:00",
        "unit": "kWh",
        "sourceGranularityMinutes": 15,
        "partialReason": "solar_forecast_ended",
        "coverageUntil": "2026-03-20T23:00:00+01:00",
        "series": [
            {
                "timestamp": "2026-03-20T21:20:00+01:00",
                "durationHours": 10 / 60,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.0,
                "availableSurplusKwh": 0.1,
            },
            {
                "timestamp": "2026-03-20T21:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
                "availableSurplusKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
                "availableSurplusKwh": 0.1,
            },
            {
                "timestamp": "2026-03-20T22:00:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.3,
                "exportedToGridKwh": 0.0,
                "availableSurplusKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:15:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.1,
                "exportedToGridKwh": 0.0,
                "availableSurplusKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.2,
                "availableSurplusKwh": 0.2,
            },
            {
                "timestamp": "2026-03-20T22:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
                "availableSurplusKwh": 0.1,
            },
        ],
    }
    if include_baseline:
        snapshot["scheduleAdjusted"] = schedule_adjusted
        snapshot["scheduleAdjustmentCoverageUntil"] = "2026-03-20T23:00:00+01:00"
        snapshot["baselineSeries"] = [
            {
                "timestamp": "2026-03-20T21:20:00+01:00",
                "durationHours": 10 / 60,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
            },
            {
                "timestamp": "2026-03-20T22:00:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.4,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:15:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.1,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.2,
            },
            {
                "timestamp": "2026-03-20T22:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
            },
        ]
    return snapshot


class GridFlowForecastResponseTests(unittest.TestCase):
    def test_quarter_hour_response_keeps_canonical_entries_and_nested_baseline(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(),
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "quarter_hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertAlmostEqual(response["series"][0]["durationHours"], 10 / 60, places=4)
        self.assertAlmostEqual(response["series"][0]["availableSurplusKwh"], 0.1, places=4)
        self.assertEqual(
            response["series"][0]["baseline"],
            {
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
        )

    def test_scheduler_context_without_adjustment_still_emits_baseline(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(schedule_adjusted=False),
            forecast_days=1,
        )

        self.assertFalse(response["scheduleAdjusted"])
        self.assertIn("baseline", response["series"][0])
        self.assertIn("availableSurplusKwh", response["series"][0])
        self.assertEqual(
            response["series"][1]["baseline"],
            {
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
        )

    def test_response_omits_baseline_without_schedule_context(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(include_baseline=False),
            forecast_days=1,
        )

        self.assertNotIn("scheduleAdjusted", response)
        self.assertNotIn("baseline", response["series"][0])
        self.assertIn("availableSurplusKwh", response["series"][0])


if __name__ == "__main__":
    unittest.main()
