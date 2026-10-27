from __future__ import annotations

import unittest




from custom_components.helman.grid_flow_forecast_builder import (  # noqa: E402
    build_grid_flow_forecast_snapshot,
)


class GridFlowForecastBuilderTests(unittest.TestCase):
    def test_projects_grid_flow_series_from_battery_snapshot(self) -> None:
        battery_snapshot = {
            "status": "partial",
            "generatedAt": "2026-03-20T21:20:30+01:00",
            "startedAt": "2026-03-20T21:20:00+01:00",
            "unit": "kWh",
            "sourceGranularityMinutes": 15,
            "partialReason": "solar_forecast_ended",
            "coverageUntil": "2026-03-20T23:00:00+01:00",
            "scheduleAdjusted": False,
            "scheduleAdjustmentCoverageUntil": None,
            "currentSoc": 50.0,
            "actualHistory": [{"timestamp": "ignored"}],
            "series": [
                {
                    "timestamp": "2026-03-20T21:20:00+01:00",
                    "durationHours": 10 / 60,
                    "importedFromGridKwh": 0.2,
                    "exportedToGridKwh": 0.0,
                    "availableSurplusKwh": 0.15,
                    "remainingEnergyKwh": 5.1,
                    "setBy": "automation",
                    "optimizer": "charge_from_grid",
                    "hitMinSoc": False,
                    "hitMaxSoc": True,
                    "limitedByChargePower": False,
                    "limitedByDischargePower": False,
                }
            ],
        }

        response = build_grid_flow_forecast_snapshot(battery_snapshot)

        self.assertEqual(response["status"], "partial")
        self.assertEqual(response["unit"], "kWh")
        self.assertEqual(response["sourceGranularityMinutes"], 15)
        self.assertEqual(
            response["series"],
            [
                {
                    "timestamp": "2026-03-20T21:20:00+01:00",
                    "durationHours": 10 / 60,
                    "importedFromGridKwh": 0.2,
                    "exportedToGridKwh": 0.0,
                    "availableSurplusKwh": 0.15,
                    "setBy": "automation",
                    "optimizer": "charge_from_grid",
                    "hitMinSoc": False,
                    "hitMaxSoc": True,
                    "limitedByChargePower": False,
                }
            ],
        )
        self.assertNotIn("currentSoc", response)
        self.assertNotIn("actualHistory", response)



if __name__ == "__main__":
    unittest.main()
