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

from custom_components.helman.forecast_aggregation import (
    aggregate_averaged_points,
    aggregate_battery_history_entries,
    aggregate_battery_series,
    aggregate_grid_flow_series,
    aggregate_house_entries,
    aggregate_summed_points,
    get_aggregation_group_size,
)


class ForecastAggregationTests(unittest.TestCase):
    def test_get_aggregation_group_size_requires_whole_multiple(self):
        self.assertEqual(
            get_aggregation_group_size(
                source_granularity_minutes=15,
                target_granularity_minutes=60,
            ),
            4,
        )

        with self.assertRaises(ValueError):
            get_aggregation_group_size(
                source_granularity_minutes=60,
                target_granularity_minutes=15,
            )

    def test_aggregate_summed_points_rejects_partial_trailing_group(self):
        with self.assertRaises(ValueError):
            aggregate_summed_points(
                [
                    {"timestamp": "2026-03-20T10:00:00+01:00", "value": 120.0},
                    {"timestamp": "2026-03-20T10:15:00+01:00", "value": 180.0},
                    {"timestamp": "2026-03-20T10:30:00+01:00", "value": 240.0},
                ],
                group_size=2,
            )

    def test_aggregate_summed_points_sums_energy_values(self):
        points = [
            {"timestamp": "2026-03-20T10:00:00+01:00", "value": 120.0},
            {"timestamp": "2026-03-20T10:15:00+01:00", "value": 180.0},
        ]

        self.assertEqual(
            aggregate_summed_points(points, group_size=2),
            [{"timestamp": "2026-03-20T10:00:00+01:00", "value": 300.0}],
        )

    def test_aggregate_averaged_points_averages_price_values(self):
        points = [
            {"timestamp": "2026-03-20T10:00:00+01:00", "value": 80.0},
            {"timestamp": "2026-03-20T10:15:00+01:00", "value": 120.0},
        ]

        self.assertEqual(
            aggregate_averaged_points(points, group_size=2),
            [{"timestamp": "2026-03-20T10:00:00+01:00", "value": 100.0}],
        )

    def test_aggregate_house_entries_sums_energy_bands(self):
        entries = [
            {
                "timestamp": "2026-03-20T10:00:00+01:00",
                "nonDeferrable": {"value": 0.4, "lower": 0.3, "upper": 0.5},
                "deferrableConsumers": [
                    {
                        "entityId": "sensor.washer_energy",
                        "label": "Washer",
                        "value": 0.1,
                        "lower": 0.05,
                        "upper": 0.15,
                    }
                ],
            },
            {
                "timestamp": "2026-03-20T10:15:00+01:00",
                "nonDeferrable": {"value": 0.6, "lower": 0.4, "upper": 0.8},
                "deferrableConsumers": [
                    {
                        "entityId": "sensor.washer_energy",
                        "label": "Washer",
                        "value": 0.2,
                        "lower": 0.1,
                        "upper": 0.3,
                    }
                ],
            },
        ]

        self.assertEqual(
            aggregate_house_entries(entries, group_size=2),
            [
                {
                    "timestamp": "2026-03-20T10:00:00+01:00",
                    "nonDeferrable": {"value": 1.0, "lower": 0.7, "upper": 1.3},
                    "deferrableConsumers": [
                        {
                            "entityId": "sensor.washer_energy",
                            "label": "Washer",
                            "value": 0.3,
                            "lower": 0.15,
                            "upper": 0.45,
                        }
                    ],
                }
            ],
        )

    def test_aggregate_battery_series_keeps_last_soc_and_remaining_energy(self):
        entries = [
            {
                "timestamp": "2026-03-20T10:00:00+01:00",
                "durationHours": 0.25,
                "solarKwh": 0.6,
                "baselineHouseKwh": 0.2,
                "netKwh": 0.4,
                "chargedKwh": 0.4,
                "dischargedKwh": 0.0,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.0,
                "remainingEnergyKwh": 6.2,
                "socPct": 62.0,
                "baselineRemainingEnergyKwh": 6.0,
                "baselineSocPct": 60.0,
                "hitMinSoc": False,
                "hitMaxSoc": False,
                "limitedByChargePower": False,
                "limitedByDischargePower": False,
            },
            {
                "timestamp": "2026-03-20T10:15:00+01:00",
                "durationHours": 0.25,
                "solarKwh": 0.4,
                "baselineHouseKwh": 0.3,
                "netKwh": 0.1,
                "chargedKwh": 0.1,
                "dischargedKwh": 0.0,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.0,
                "remainingEnergyKwh": 6.3,
                "socPct": 63.0,
                "baselineRemainingEnergyKwh": 6.1,
                "baselineSocPct": 61.0,
                "hitMinSoc": False,
                "hitMaxSoc": False,
                "limitedByChargePower": False,
                "limitedByDischargePower": False,
            },
        ]

        self.assertEqual(
            aggregate_battery_series(entries, group_size=2),
            [
                {
                    "timestamp": "2026-03-20T10:00:00+01:00",
                    "durationHours": 0.5,
                    "solarKwh": 1.0,
                    "baselineHouseKwh": 0.5,
                    "netKwh": 0.5,
                    "chargedKwh": 0.5,
                    "dischargedKwh": 0.0,
                    "importedFromGridKwh": 0.0,
                    "exportedToGridKwh": 0.0,
                    "remainingEnergyKwh": 6.3,
                    "socPct": 63.0,
                    "baselineRemainingEnergyKwh": 6.1,
                    "baselineSocPct": 61.0,
                    "hitMinSoc": False,
                    "hitMaxSoc": False,
                    "limitedByChargePower": False,
                    "limitedByDischargePower": False,
                }
            ],
        )

    def test_aggregate_battery_series_ors_boolean_flags(self):
        entries = [
            {
                "timestamp": "2026-03-20T10:00:00+01:00",
                "durationHours": 0.25,
                "solarKwh": 0.1,
                "baselineHouseKwh": 0.3,
                "netKwh": -0.2,
                "chargedKwh": 0.0,
                "dischargedKwh": 0.2,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.0,
                "remainingEnergyKwh": 5.8,
                "socPct": 58.0,
                "hitMinSoc": False,
                "hitMaxSoc": False,
                "limitedByChargePower": False,
                "limitedByDischargePower": True,
            },
            {
                "timestamp": "2026-03-20T10:15:00+01:00",
                "durationHours": 0.25,
                "solarKwh": 0.2,
                "baselineHouseKwh": 0.2,
                "netKwh": 0.0,
                "chargedKwh": 0.0,
                "dischargedKwh": 0.0,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.0,
                "remainingEnergyKwh": 5.8,
                "socPct": 58.0,
                "hitMinSoc": True,
                "hitMaxSoc": False,
                "limitedByChargePower": True,
                "limitedByDischargePower": False,
            },
        ]

        aggregated = aggregate_battery_series(entries, group_size=2)

        self.assertTrue(aggregated[0]["hitMinSoc"])
        self.assertFalse(aggregated[0]["hitMaxSoc"])
        self.assertTrue(aggregated[0]["limitedByChargePower"])
        self.assertTrue(aggregated[0]["limitedByDischargePower"])

    def test_aggregate_battery_history_entries_keeps_first_start_and_last_soc(self):
        entries = [
            {
                "timestamp": "2026-03-20T10:00:00+01:00",
                "startSocPct": 40.0,
                "socPct": 41.25,
            },
            {
                "timestamp": "2026-03-20T10:15:00+01:00",
                "startSocPct": 41.25,
                "socPct": 42.5,
            },
        ]

        self.assertEqual(
            aggregate_battery_history_entries(entries, group_size=2),
            [
                {
                    "timestamp": "2026-03-20T10:00:00+01:00",
                    "startSocPct": 40.0,
                    "socPct": 42.5,
                }
            ],
        )

    def test_aggregate_grid_flow_series_sums_flow_fields(self):
        entries = [
            {
                "timestamp": "2026-03-20T10:00:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
                "availableSurplusKwh": 0.3,
                "baselineImportedFromGridKwh": 0.3,
                "baselineExportedToGridKwh": 0.1,
            },
            {
                "timestamp": "2026-03-20T10:15:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.4,
                "exportedToGridKwh": 0.1,
                "availableSurplusKwh": 0.2,
                "baselineImportedFromGridKwh": 0.5,
                "baselineExportedToGridKwh": 0.0,
            },
        ]

        self.assertEqual(
            aggregate_grid_flow_series(entries, group_size=2),
            [
                {
                    "timestamp": "2026-03-20T10:00:00+01:00",
                    "durationHours": 0.5,
                    "importedFromGridKwh": 0.6,
                    "exportedToGridKwh": 0.1,
                    "availableSurplusKwh": 0.5,
                    "baselineImportedFromGridKwh": 0.8,
                    "baselineExportedToGridKwh": 0.1,
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
