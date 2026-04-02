from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_STUBBED_MODULES = (
    "custom_components",
    "custom_components.helman",
    "custom_components.helman.recorder_hourly_series",
    "homeassistant",
    "homeassistant.util",
    "homeassistant.util.dt",
)


def _install_import_stubs() -> dict[str, types.ModuleType | None]:
    previous_modules = {
        module_name: sys.modules.get(module_name) for module_name in _STUBBED_MODULES
    }
    custom_components_pkg = types.ModuleType("custom_components")
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]
    sys.modules["custom_components"] = custom_components_pkg

    helman_pkg = types.ModuleType("custom_components.helman")
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]
    sys.modules["custom_components.helman"] = helman_pkg

    recorder_slots_mod = types.ModuleType("custom_components.helman.recorder_hourly_series")
    recorder_slots_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    sys.modules[recorder_slots_mod.__name__] = recorder_slots_mod

    try:
        import homeassistant.util.dt  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        homeassistant_pkg = sys.modules.get("homeassistant")
        if homeassistant_pkg is None:
            homeassistant_pkg = types.ModuleType("homeassistant")
            sys.modules["homeassistant"] = homeassistant_pkg

        util_pkg = sys.modules.get("homeassistant.util")
        if util_pkg is None:
            util_pkg = types.ModuleType("homeassistant.util")
            sys.modules["homeassistant.util"] = util_pkg

        dt_mod = sys.modules.get("homeassistant.util.dt")
        if dt_mod is None:
            dt_mod = types.ModuleType("homeassistant.util.dt")
            sys.modules["homeassistant.util.dt"] = dt_mod

        from datetime import datetime

        dt_mod.parse_datetime = datetime.fromisoformat
        dt_mod.as_local = lambda value: value
        dt_mod.as_utc = lambda value: value
        util_pkg.dt = dt_mod
    return previous_modules


def _restore_modules(previous_modules: dict[str, types.ModuleType | None]) -> None:
    for module_name, previous_module in previous_modules.items():
        if previous_module is None:
            sys.modules.pop(module_name, None)
            continue
        sys.modules[module_name] = previous_module


_previous_modules = _install_import_stubs()
try:
    ev_charger_module = importlib.import_module(
        "custom_components.helman.appliances.ev_charger"
    )
    projection_builder_module = importlib.import_module(
        "custom_components.helman.appliances.projection_builder"
    )
    projection_response_module = importlib.import_module(
        "custom_components.helman.appliances.projection_response"
    )
    state_module = importlib.import_module("custom_components.helman.appliances.state")
finally:
    _restore_modules(_previous_modules)

ApplianceProjectionPlan = projection_builder_module.ApplianceProjectionPlan
ApplianceProjectionPlanPoint = projection_builder_module.ApplianceProjectionPlanPoint
ApplianceProjectionSeries = projection_builder_module.ApplianceProjectionSeries
AppliancesRuntimeRegistry = state_module.AppliancesRuntimeRegistry
EvChargerApplianceRuntime = ev_charger_module.EvChargerApplianceRuntime
EvVehicleRuntime = ev_charger_module.EvVehicleRuntime
build_appliance_projections_response = (
    projection_response_module.build_appliance_projections_response
)


class _FakeState:
    def __init__(self, state) -> None:
        self.state = state


class _FakeStates:
    def __init__(self, states: dict[str, _FakeState]) -> None:
        self._states = states

    def get(self, entity_id: str):
        return self._states.get(entity_id)


class _FakeHass:
    def __init__(self, states: dict[str, _FakeState]) -> None:
        self.states = _FakeStates(states)


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
                eco_gear_min_power_kw=(("6A", 1.4),),
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


if __name__ == "__main__":
    unittest.main()
