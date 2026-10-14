from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

forecast_integration_module = importlib.import_module(
    "custom_components.helman.appliances.forecast_integration"
)
projection_builder_module = importlib.import_module(
    "custom_components.helman.appliances.projection_builder"
)

ApplianceDemandPoint = projection_builder_module.ApplianceDemandPoint
aggregate_appliance_demand_by_slot = (
    forecast_integration_module.aggregate_appliance_demand_by_slot
)
build_adjusted_house_forecast = forecast_integration_module.build_adjusted_house_forecast

def _make_house_forecast() -> dict:
    return {
        "status": "available",
        "generatedAt": "2026-03-20T21:05:00+01:00",
        "currentSlot": {
            "timestamp": "2026-03-20T21:00:00+01:00",
            "nonDeferrable": {"value": 0.5, "lower": 0.4, "upper": 0.6},
        },
        "series": [
            {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "nonDeferrable": {"value": 0.6, "lower": 0.5, "upper": 0.7},
            },
            {
                "timestamp": "2026-03-20T21:30:00+01:00",
                "nonDeferrable": {"value": 0.4},
            },
        ],
    }


class ApplianceForecastIntegrationTests(unittest.TestCase):
    def test_aggregate_appliance_demand_by_slot_sums_multiple_producers(self) -> None:
        aggregated = aggregate_appliance_demand_by_slot(
            [
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:00:00+01:00",
                    energy_kwh=0.8,
                    scheduled_energy_kwh=0.8,
                ),
                ApplianceDemandPoint(
                    appliance_id="pool",
                    slot_id="2026-03-20T21:00:00+01:00",
                    energy_kwh=0.3,
                    scheduled_energy_kwh=0.3,
                ),
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:15:00+01:00",
                    energy_kwh=0.5,
                    scheduled_energy_kwh=0.5,
                ),
            ]
        )

        self.assertEqual(
            aggregated,
            {
                "2026-03-20T21:00:00+01:00": 1.1,
                "2026-03-20T21:15:00+01:00": 0.5,
            },
        )

    def test_build_adjusted_house_forecast_adds_demand_to_matching_slots(self) -> None:
        adjusted = build_adjusted_house_forecast(
            house_forecast=_make_house_forecast(),
            demand_points=[
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:00:00+01:00",
                    energy_kwh=0.8,
                    scheduled_energy_kwh=0.8,
                ),
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:15:00+01:00",
                    energy_kwh=0.5,
                    scheduled_energy_kwh=0.5,
                ),
            ],
        )

        self.assertEqual(adjusted["currentSlot"]["nonDeferrable"]["value"], 1.3)
        self.assertEqual(adjusted["currentSlot"]["nonDeferrable"]["lower"], 1.2)
        self.assertEqual(adjusted["currentSlot"]["nonDeferrable"]["upper"], 1.4)
        self.assertEqual(adjusted["series"][0]["nonDeferrable"]["value"], 1.1)
        self.assertEqual(adjusted["series"][0]["nonDeferrable"]["lower"], 1.0)
        self.assertEqual(adjusted["series"][0]["nonDeferrable"]["upper"], 1.2)
        self.assertEqual(adjusted["series"][1]["nonDeferrable"]["value"], 0.4)

    def test_the_optimizer_view_ignores_the_whole_slot_figure(self) -> None:
        """``scheduled_energy_kwh`` is additive: nothing the planner reads sees it.

        The slot in progress can only take the energy still to come, so both the
        per-slot aggregate and the adjusted forecast built from it must keep
        reporting ``energy_kwh`` however much larger the whole slot was.
        """
        demand_points = [
            ApplianceDemandPoint(
                appliance_id="garage-ev",
                slot_id="2026-03-20T21:00:00+01:00",
                energy_kwh=0.3,
                scheduled_energy_kwh=0.9,
            )
        ]

        self.assertEqual(
            aggregate_appliance_demand_by_slot(demand_points),
            {"2026-03-20T21:00:00+01:00": 0.3},
        )
        adjusted = build_adjusted_house_forecast(
            house_forecast=_make_house_forecast(),
            demand_points=demand_points,
        )
        # 0.5 kWh of base plus the 0.3 kWh still to come, not the 0.9 kWh the
        # whole slot was scheduled for.
        self.assertEqual(adjusted["currentSlot"]["nonDeferrable"]["value"], 0.8)

    def test_build_adjusted_house_forecast_keeps_original_input_unchanged(self) -> None:
        house_forecast = _make_house_forecast()

        _ = build_adjusted_house_forecast(
            house_forecast=house_forecast,
            demand_points=[
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:00:00+01:00",
                    energy_kwh=0.8,
                    scheduled_energy_kwh=0.8,
                )
            ],
        )

        self.assertEqual(house_forecast["currentSlot"]["nonDeferrable"]["value"], 0.5)
        self.assertEqual(house_forecast["currentSlot"]["nonDeferrable"]["lower"], 0.4)
        self.assertEqual(house_forecast["currentSlot"]["nonDeferrable"]["upper"], 0.6)


if __name__ == "__main__":
    unittest.main()
