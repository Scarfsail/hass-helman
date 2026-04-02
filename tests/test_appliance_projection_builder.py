from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
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
    config_module = importlib.import_module("custom_components.helman.appliances.config")
    projection_builder_module = importlib.import_module(
        "custom_components.helman.appliances.projection_builder"
    )
    schedule_module = importlib.import_module(
        "custom_components.helman.scheduling.schedule"
    )
finally:
    _restore_modules(_previous_modules)

build_appliance_projection_plan = projection_builder_module.build_appliance_projection_plan
build_appliances_runtime_registry = config_module.build_appliances_runtime_registry
build_projection_input_bundle = projection_builder_module.build_projection_input_bundle
ScheduleDocument = schedule_module.ScheduleDocument
ScheduleDomains = schedule_module.ScheduleDomains


def _valid_config() -> dict:
    return {
        "appliances": [
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "Garage EV",
                "metadata": {"max_charging_power_kw": 11.0},
                "control": {
                    "charge_entity_id": "switch.ev_nabijeni",
                    "use_mode_entity_id": "select.solax_ev_charger_charger_use_mode",
                    "eco_gear_entity_id": "select.solax_ev_charger_eco_gear",
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {"soc_entity_id": "sensor.kona_ev_battery_level"},
                        "metadata": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    },
                    {
                        "id": "tesla",
                        "name": "Tesla",
                        "telemetry": {"soc_entity_id": "sensor.tesla_soc"},
                        "metadata": {
                            "battery_capacity_kwh": 82.0,
                            "max_charging_power_kw": 7.4,
                        },
                    },
                ],
                "projection": {
                    "modes": {
                        "Fast": {"behavior": "fixed_power"},
                        "ECO": {
                            "behavior": "surplus_aware",
                            "eco_gear_min_power_kw": {"6A": 1.4, "10A": 2.3},
                        },
                    }
                },
            }
        ]
    }


def _make_house_forecast() -> dict:
    return {
        "status": "available",
        "generatedAt": "2026-03-20T21:05:00+01:00",
        "currentSlot": {
            "timestamp": "2026-03-20T21:00:00+01:00",
            "nonDeferrable": {"value": 0.5},
        },
        "series": [
            {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "nonDeferrable": {"value": 0.6},
            },
            {
                "timestamp": "2026-03-20T21:30:00+01:00",
                "nonDeferrable": {"value": 0.4},
            },
            {
                "timestamp": "2026-03-20T21:45:00+01:00",
                "nonDeferrable": {"value": 0.5},
            },
        ],
    }


def _make_solar_forecast() -> dict:
    return {
        "status": "available",
        "points": [
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 1000.0},
            {"timestamp": "2026-03-20T21:15:00+01:00", "value": 1000.0},
            {"timestamp": "2026-03-20T21:30:00+01:00", "value": 2500.0},
            {"timestamp": "2026-03-20T21:45:00+01:00", "value": 2500.0},
        ],
    }


class ApplianceProjectionBuilderTests(unittest.TestCase):
    def test_fast_projection_uses_effective_power_cap(self) -> None:
        registry = build_appliances_runtime_registry(_valid_config())
        inputs = build_projection_input_bundle(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            reference_time=REFERENCE_TIME,
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "tesla",
                                "useMode": "Fast",
                            }
                        }
                    )
                }
            ),
            inputs=inputs,
        )

        self.assertEqual(len(plan.demand_points), 1)
        self.assertEqual(plan.demand_points[0].slot_id, "2026-03-20T21:00:00+01:00")
        self.assertEqual(plan.demand_points[0].energy_kwh, 2.8367)

    def test_eco_projection_uses_original_house_baseline(self) -> None:
        registry = build_appliances_runtime_registry(_valid_config())
        inputs = build_projection_input_bundle(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            reference_time=REFERENCE_TIME,
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:30:00+01:00": ScheduleDomains(
                        appliances={
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "ECO",
                                "ecoGear": "6A",
                            }
                        }
                    )
                }
            ),
            inputs=inputs,
        )

        self.assertEqual(plan.demand_points[0].energy_kwh, 4.1)

    def test_charge_false_produces_no_projection(self) -> None:
        registry = build_appliances_runtime_registry(_valid_config())
        inputs = build_projection_input_bundle(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            reference_time=REFERENCE_TIME,
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"garage-ev": {"charge": False}}
                    )
                }
            ),
            inputs=inputs,
        )

        self.assertEqual(plan.appliances_by_id, {})
        self.assertEqual(plan.demand_points, ())

    def test_projection_keeps_vehicle_identity_per_slot(self) -> None:
        registry = build_appliances_runtime_registry(_valid_config())
        inputs = build_projection_input_bundle(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            reference_time=REFERENCE_TIME,
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                            }
                        }
                    ),
                    "2026-03-20T21:30:00+01:00": ScheduleDomains(
                        appliances={
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "tesla",
                                "useMode": "Fast",
                            }
                        }
                    ),
                }
            ),
            inputs=inputs,
        )

        series = plan.appliances_by_id["garage-ev"].points
        self.assertEqual([point.vehicle_id for point in series], ["kona", "tesla"])


if __name__ == "__main__":
    unittest.main()
