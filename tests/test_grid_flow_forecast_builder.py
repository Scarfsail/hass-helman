from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]


_install_import_stubs()

from custom_components.helman.grid_flow_forecast_builder import (  # noqa: E402
    build_grid_flow_forecast_snapshot,
)


class GridFlowForecastBuilderTests(unittest.TestCase):
    def test_projects_grid_flow_and_baseline_series_from_battery_snapshot(self) -> None:
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
                }
            ],
            "baselineSeries": [
                {
                    "timestamp": "2026-03-20T21:20:00+01:00",
                    "durationHours": 10 / 60,
                    "importedFromGridKwh": 0.3,
                    "exportedToGridKwh": 0.1,
                    "availableSurplusKwh": 0.25,
                    "remainingEnergyKwh": 4.9,
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
                }
            ],
        )
        self.assertEqual(
            response["baselineSeries"],
            [
                {
                    "timestamp": "2026-03-20T21:20:00+01:00",
                    "durationHours": 10 / 60,
                    "importedFromGridKwh": 0.3,
                    "exportedToGridKwh": 0.1,
                }
            ],
        )
        self.assertNotIn("currentSoc", response)
        self.assertNotIn("actualHistory", response)

    def test_omits_baseline_series_without_schedule_context(self) -> None:
        response = build_grid_flow_forecast_snapshot(
            {
                "status": "available",
                "generatedAt": "2026-03-20T21:20:30+01:00",
                "startedAt": "2026-03-20T21:20:00+01:00",
                "series": [
                    {
                        "timestamp": "2026-03-20T21:20:00+01:00",
                        "durationHours": 10 / 60,
                        "importedFromGridKwh": 0.0,
                        "exportedToGridKwh": 0.1,
                        "availableSurplusKwh": 0.1,
                    }
                ],
            }
        )

        self.assertNotIn("baselineSeries", response)


if __name__ == "__main__":
    unittest.main()
