from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

from _fakes import FakeHass as _FakeHass, FakeState as _FakeState

ROOT = Path(__file__).resolve().parents[1]

climate_appliance_module = importlib.import_module(
    "custom_components.helman.appliances.climate_appliance"
)
ev_charger_module = importlib.import_module(
    "custom_components.helman.appliances.ev_charger"
)
generic_appliance_module = importlib.import_module(
    "custom_components.helman.appliances.generic_appliance"
)
projection_builder_module = importlib.import_module(
    "custom_components.helman.appliances.projection_builder"
)
projection_response_module = importlib.import_module(
    "custom_components.helman.appliances.projection_response"
)
state_module = importlib.import_module("custom_components.helman.appliances.state")
ProjectionConfig = importlib.import_module(
    "custom_components.helman.appliances._read"
).ProjectionConfig

ApplianceProjectionPlan = projection_builder_module.ApplianceProjectionPlan
ApplianceProjectionPlanPoint = projection_builder_module.ApplianceProjectionPlanPoint
ApplianceProjectionSeries = projection_builder_module.ApplianceProjectionSeries
AppliancesRuntimeRegistry = state_module.AppliancesRuntimeRegistry
ClimateApplianceRuntime = climate_appliance_module.ClimateApplianceRuntime
EvChargerApplianceRuntime = ev_charger_module.EvChargerApplianceRuntime
EvChargerEcoGearRuntime = ev_charger_module.EvChargerEcoGearRuntime
EvChargerUseModeRuntime = ev_charger_module.EvChargerUseModeRuntime
EvVehicleRuntime = ev_charger_module.EvVehicleRuntime
GenericApplianceRuntime = generic_appliance_module.GenericApplianceRuntime
build_appliance_projections_response = (
    projection_response_module.build_appliance_projections_response
)


def _registry() -> AppliancesRuntimeRegistry:
    return AppliancesRuntimeRegistry.from_appliances(
        [
            EvChargerApplianceRuntime(
                id="garage-ev",
                name="Garage EV",
                max_charging_power_kw=11.0,
                charge_entity_id="switch.ev_nabijeni",
                use_mode_entity_id="select.use_mode",
                eco_gear_entity_id="select.eco_gear",
                use_mode_configs=(
                    EvChargerUseModeRuntime(
                        id="Fast",
                        behavior="fixed_max_power",
                    ),
                    EvChargerUseModeRuntime(
                        id="ECO",
                        behavior="surplus_aware",
                    ),
                ),
                eco_gear_configs=(
                    EvChargerEcoGearRuntime(
                        id="6A",
                        min_power_kw=1.4,
                    ),
                ),
                vehicles=(
                    EvVehicleRuntime(
                        id="kona",
                        name="Kona",
                        soc_entity_id="sensor.kona_soc",
                        charge_limit_entity_id=None,
                        battery_capacity_kwh=64.0,
                        max_charging_power_kw=11.0,
                    ),
                ),
            )
        ]
    )


def _generic_registry() -> AppliancesRuntimeRegistry:
    return AppliancesRuntimeRegistry.from_appliances(
        [
            GenericApplianceRuntime(
                id="dishwasher",
                name="Dishwasher",
                switch_entity_id="switch.dishwasher",
                projection=ProjectionConfig(strategy="fixed", hourly_energy_kwh=0.9),
            )
        ]
    )


def _climate_registry() -> AppliancesRuntimeRegistry:
    return AppliancesRuntimeRegistry.from_appliances(
        [
            ClimateApplianceRuntime(
                id="living-room-hvac",
                name="Living Room HVAC",
                climate_entity_id="climate.living_room",
                projection=ProjectionConfig(strategy="fixed", hourly_energy_kwh=1.5),
            )
        ]
    )


class ApplianceProjectionResponseTests(unittest.TestCase):
    def test_response_is_keyed_by_appliance_and_includes_vehicle_soc(self) -> None:
        response = build_appliance_projections_response(
            plan=ApplianceProjectionPlan(
                generated_at="2026-03-20T21:07:00+01:00",
                appliances_by_id={
                    "garage-ev": ApplianceProjectionSeries(
                        appliance_id="garage-ev",
                        points=(
                            ApplianceProjectionPlanPoint(
                                slot_id="2026-03-20T21:00:00+01:00",
                                energy_kwh=1.75,
                                mode="Fast",
                                vehicle_id="kona",
                            ),
                        ),
                    )
                },
                demand_points=(),
            ),
            registry=_registry(),
            hass=_FakeHass({"sensor.kona_soc": _FakeState("50")}),
        )

        self.assertEqual(
            response,
            {
                "generatedAt": "2026-03-20T21:07:00+01:00",
                "appliances": {
                    "garage-ev": {
                        "series": [
                            {
                                "slotId": "2026-03-20T21:00:00+01:00",
                                "energyKwh": 1.75,
                                "mode": "Fast",
                                "vehicleId": "kona",
                                "vehicleSoc": 53,
                            }
                        ]
                    }
                },
            },
        )

    def test_missing_soc_returns_null(self) -> None:
        response = build_appliance_projections_response(
            plan=ApplianceProjectionPlan(
                generated_at="2026-03-20T21:07:00+01:00",
                appliances_by_id={
                    "garage-ev": ApplianceProjectionSeries(
                        appliance_id="garage-ev",
                        points=(
                            ApplianceProjectionPlanPoint(
                                slot_id="2026-03-20T21:00:00+01:00",
                                energy_kwh=1.0,
                                mode="ECO",
                                vehicle_id="kona",
                            ),
                        ),
                    )
                },
                demand_points=(),
            ),
            registry=_registry(),
            hass=_FakeHass({"sensor.kona_soc": _FakeState("unknown")}),
        )

        self.assertIsNone(
            response["appliances"]["garage-ev"]["series"][0]["vehicleSoc"]
        )

    def test_generic_response_uses_projection_method_only(self) -> None:
        response = build_appliance_projections_response(
            plan=ApplianceProjectionPlan(
                generated_at="2026-03-20T21:07:00+01:00",
                appliances_by_id={
                    "dishwasher": ApplianceProjectionSeries(
                        appliance_id="dishwasher",
                        points=(
                            ApplianceProjectionPlanPoint(
                                slot_id="2026-03-20T21:00:00+01:00",
                                energy_kwh=0.46,
                                projection_method="fixed_fallback",
                            ),
                        ),
                    )
                },
                demand_points=(),
            ),
            registry=_generic_registry(),
            hass=_FakeHass({}),
        )

        self.assertEqual(
            response,
            {
                "generatedAt": "2026-03-20T21:07:00+01:00",
                "appliances": {
                    "dishwasher": {
                        "series": [
                            {
                                "slotId": "2026-03-20T21:00:00+01:00",
                                "energyKwh": 0.46,
                                "projectionMethod": "fixed_fallback",
                            }
                        ]
                    }
                },
            },
        )

    def test_climate_response_includes_mode_and_projection_method(self) -> None:
        response = build_appliance_projections_response(
            plan=ApplianceProjectionPlan(
                generated_at="2026-03-20T21:07:00+01:00",
                appliances_by_id={
                    "living-room-hvac": ApplianceProjectionSeries(
                        appliance_id="living-room-hvac",
                        points=(
                            ApplianceProjectionPlanPoint(
                                slot_id="2026-03-20T21:00:00+01:00",
                                energy_kwh=0.575,
                                mode="cool",
                                projection_method="history_average",
                            ),
                        ),
                    )
                },
                demand_points=(),
            ),
            registry=_climate_registry(),
            hass=_FakeHass({}),
        )

        self.assertEqual(
            response,
            {
                "generatedAt": "2026-03-20T21:07:00+01:00",
                "appliances": {
                    "living-room-hvac": {
                        "series": [
                            {
                                "slotId": "2026-03-20T21:00:00+01:00",
                                "energyKwh": 0.575,
                                "mode": "cool",
                                "projectionMethod": "history_average",
                            }
                        ]
                    }
                },
            },
        )


if __name__ == "__main__":
    unittest.main()
