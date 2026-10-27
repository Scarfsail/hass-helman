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


def _make_snapshot(*, schedule_adjusted: bool = True) -> dict:
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
                "setBy": "automation",
                "optimizer": "charge_from_grid",
                "hitMinSoc": True,
                "hitMaxSoc": False,
                "limitedByChargePower": False,
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
    snapshot["scheduleAdjusted"] = schedule_adjusted
    snapshot["scheduleAdjustmentCoverageUntil"] = "2026-03-20T23:00:00+01:00"
    return snapshot


class GridFlowForecastResponseTests(unittest.TestCase):
    def test_quarter_hour_response_keeps_canonical_entries(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(),
            forecast_days=1,
        )

        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertAlmostEqual(response["series"][0]["durationHours"], 10 / 60, places=4)
        self.assertAlmostEqual(response["series"][0]["availableSurplusKwh"], 0.1, places=4)
    def test_schedule_metadata_remains_available(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(schedule_adjusted=False), forecast_days=1,
        )
        self.assertFalse(response["scheduleAdjusted"])
        self.assertIn("availableSurplusKwh", response["series"][0])
        self.assertNotIn("baseline", response["series"][0])

    def test_cause_fields_are_copied_only_where_present(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(), forecast_days=1,
        )
        self.assertEqual(
            {
                key: response["series"][1][key]
                for key in (
                    "setBy",
                    "optimizer",
                    "hitMinSoc",
                    "hitMaxSoc",
                    "limitedByChargePower",
                )
            },
            {
                "setBy": "automation",
                "optimizer": "charge_from_grid",
                "hitMinSoc": True,
                "hitMaxSoc": False,
                "limitedByChargePower": False,
            },
        )
        self.assertNotIn("setBy", response["series"][0])
        self.assertNotIn("hitMinSoc", response["series"][0])


if __name__ == "__main__":
    unittest.main()
