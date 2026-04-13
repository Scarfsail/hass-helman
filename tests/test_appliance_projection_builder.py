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
        util_pkg.dt = dt_mod

    dt_mod = sys.modules["homeassistant.util.dt"]
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util"].dt = dt_mod
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
    ev_charger_module = importlib.import_module(
        "custom_components.helman.appliances.ev_charger"
    )
    projection_builder_module = importlib.import_module(
        "custom_components.helman.appliances.projection_builder"
    )
    schedule_module = importlib.import_module(
        "custom_components.helman.scheduling.schedule"
    )
    state_module = importlib.import_module("custom_components.helman.appliances.state")
finally:
    _restore_modules(_previous_modules)

build_appliance_projection_plan = projection_builder_module.build_appliance_projection_plan
build_appliances_runtime_registry = config_module.build_appliances_runtime_registry
build_projection_input_bundle = projection_builder_module.build_projection_input_bundle
build_when_active_demand_slices = projection_builder_module.build_when_active_demand_slices
get_when_active_demand_profile = projection_builder_module.get_when_active_demand_profile
AppliancesRuntimeRegistry = state_module.AppliancesRuntimeRegistry
EvChargerApplianceRuntime = ev_charger_module.EvChargerApplianceRuntime
EvChargerEcoGearRuntime = ev_charger_module.EvChargerEcoGearRuntime
EvChargerUseModeRuntime = ev_charger_module.EvChargerUseModeRuntime
EvVehicleRuntime = ev_charger_module.EvVehicleRuntime
format_slot_id = schedule_module.format_slot_id
ScheduleDocument = schedule_module.ScheduleDocument
ScheduleDomains = schedule_module.ScheduleDomains


def _valid_config() -> dict:
    return {
        "appliances": [
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "Garage EV",
                "limits": {"max_charging_power_kw": 11.0},
                "controls": {
                    "charge": {
                        "entity_id": "switch.ev_nabijeni",
                    },
                    "use_mode": {
                        "entity_id": "select.solax_ev_charger_charger_use_mode",
                        "values": {
                            "Fast": {"behavior": "fixed_max_power"},
                            "ECO": {"behavior": "surplus_aware"},
                        },
                    },
                    "eco_gear": {
                        "entity_id": "select.solax_ev_charger_eco_gear",
                        "values": {
                            "6A": {"min_power_kw": 1.4},
                            "10A": {"min_power_kw": 2.3},
                        },
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {"soc_entity_id": "sensor.kona_ev_battery_level"},
                        "limits": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    },
                    {
                        "id": "tesla",
                        "name": "Tesla",
                        "telemetry": {"soc_entity_id": "sensor.tesla_soc"},
                        "limits": {
                            "battery_capacity_kwh": 82.0,
                            "max_charging_power_kw": 7.4,
                        },
                    },
                ],
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


def _generic_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "generic",
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {
            "switch": {"entity_id": "switch.dishwasher"},
        },
        "projection": {
            "strategy": strategy,
            "hourly_energy_kwh": 1.2,
        },
    }
    if strategy == "history_average":
        appliance["projection"]["history_average"] = {
            "energy_entity_id": "sensor.dishwasher_energy_total",
            "lookback_days": 30,
        }
    return appliance


def _climate_appliance(*, strategy: str = "fixed") -> dict:
    appliance = {
        "kind": "climate",
        "id": "living-room-hvac",
        "name": "Living Room HVAC",
        "controls": {
            "climate": {"entity_id": "climate.living_room"},
        },
        "projection": {
            "strategy": strategy,
            "hourly_energy_kwh": 1.5,
        },
    }
    if strategy == "history_average":
        appliance["projection"]["history_average"] = {
            "energy_entity_id": "sensor.living_room_hvac_energy_total",
            "lookback_days": 30,
        }
    return appliance


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
            hass=None,
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

        self.assertEqual(len(plan.demand_points), 2)
        self.assertEqual(plan.demand_points[0].slot_id, "2026-03-20T21:00:00+01:00")
        self.assertEqual(plan.demand_points[0].energy_kwh, 0.9867)
        self.assertEqual(plan.demand_points[1].slot_id, "2026-03-20T21:15:00+01:00")
        self.assertEqual(plan.demand_points[1].energy_kwh, 1.85)

    def test_fixed_max_power_behavior_does_not_depend_on_mode_name(self) -> None:
        config = _valid_config()
        config["appliances"][0]["controls"]["use_mode"]["values"] = {
            "Boost": {"behavior": "fixed_max_power"},
            "Solar": {"behavior": "surplus_aware"},
        }
        registry = build_appliances_runtime_registry(config)
        inputs = build_projection_input_bundle(
            solar_forecast=_make_solar_forecast(),
            house_forecast=_make_house_forecast(),
            reference_time=REFERENCE_TIME,
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "tesla",
                                "useMode": "Boost",
                            }
                        }
                    )
                }
            ),
            inputs=inputs,
        )

        self.assertEqual(
            [(point.slot_id, point.energy_kwh) for point in plan.demand_points],
            [
                ("2026-03-20T21:00:00+01:00", 0.9867),
                ("2026-03-20T21:15:00+01:00", 1.85),
            ],
        )

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
            hass=None,
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

        self.assertEqual(
            [(point.slot_id, point.energy_kwh) for point in plan.demand_points],
            [
                ("2026-03-20T21:30:00+01:00", 2.1),
                ("2026-03-20T21:45:00+01:00", 2.0),
            ],
        )

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
            hass=None,
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
            hass=None,
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

    def test_generic_fixed_projection_prorates_slot_duration(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_generic_appliance()]}
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"dishwasher": {"on": True}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(
            [(point.slot_id, point.energy_kwh, point.projection_method) for point in plan.appliances_by_id["dishwasher"].points],
            [("2026-03-20T21:00:00+01:00", 0.46, "fixed")],
        )
        self.assertEqual(
            [(point.slot_id, point.energy_kwh) for point in plan.demand_points],
            [
                ("2026-03-20T21:00:00+01:00", 0.16),
                ("2026-03-20T21:15:00+01:00", 0.3),
            ],
        )

    def test_generic_history_projection_prefers_estimate(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_generic_appliance(strategy="history_average")]}
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"dishwasher": {"on": True}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={"dishwasher": 0.8},
        )

        series = plan.appliances_by_id["dishwasher"].points
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0].energy_kwh, 0.3067)
        self.assertEqual(series[0].projection_method, "history_average")

    def test_resolved_input_demand_profile_matches_projection_plan_demand_points(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_generic_appliance(strategy="history_average")]}
        )
        appliance = registry.appliances[0]

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"dishwasher": {"on": True}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={"dishwasher": 0.8},
        )

        demand_profile = get_when_active_demand_profile(
            appliance=appliance,
            resolved_hourly_energy_kwh=0.8,
        )
        self.assertIsNotNone(demand_profile)
        self.assertEqual(demand_profile.projection_method, "resolved_input")

        demand_slices = build_when_active_demand_slices(
            slot_id="2026-03-20T21:00:00+01:00",
            reference_time=REFERENCE_TIME,
            hourly_energy_kwh=demand_profile.hourly_energy_kwh,
        )

        self.assertEqual(
            [(point.slot_id, point.energy_kwh) for point in plan.demand_points],
            [
                (format_slot_id(demand_slice.bucket_start), demand_slice.energy_kwh)
                for demand_slice in demand_slices
            ],
        )

    def test_generic_history_projection_falls_back_without_estimate(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_generic_appliance(strategy="history_average")]}
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"dishwasher": {"on": True}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={"dishwasher": None},
        )

        series = plan.appliances_by_id["dishwasher"].points
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0].energy_kwh, 0.46)
        self.assertEqual(series[0].projection_method, "fixed_fallback")

    def test_climate_fixed_projection_prorates_slot_duration_and_emits_mode(self) -> None:
        registry = build_appliances_runtime_registry({"appliances": [_climate_appliance()]})

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"living-room-hvac": {"mode": "heat"}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
        )

        series = plan.appliances_by_id["living-room-hvac"].points
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0].energy_kwh, 0.575)
        self.assertEqual(series[0].mode, "heat")
        self.assertEqual(series[0].projection_method, "fixed")
        self.assertEqual(
            [(point.slot_id, point.energy_kwh) for point in plan.demand_points],
            [
                ("2026-03-20T21:00:00+01:00", 0.2),
                ("2026-03-20T21:15:00+01:00", 0.375),
            ],
        )

    def test_climate_off_produces_no_projection(self) -> None:
        registry = build_appliances_runtime_registry({"appliances": [_climate_appliance()]})

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"living-room-hvac": {"mode": "off"}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
        )

        self.assertEqual(plan.appliances_by_id, {})
        self.assertEqual(plan.demand_points, ())

    def test_climate_history_projection_prefers_estimate(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_climate_appliance(strategy="history_average")]}
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"living-room-hvac": {"mode": "cool"}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={"living-room-hvac": 0.9},
        )

        series = plan.appliances_by_id["living-room-hvac"].points
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0].energy_kwh, 0.345)
        self.assertEqual(series[0].mode, "cool")
        self.assertEqual(series[0].projection_method, "history_average")

    def test_climate_history_projection_falls_back_without_estimate(self) -> None:
        registry = build_appliances_runtime_registry(
            {"appliances": [_climate_appliance(strategy="history_average")]}
        )

        plan = build_appliance_projection_plan(
            generated_at=REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=None,
            schedule_document=ScheduleDocument(
                slots={
                    "2026-03-20T21:00:00+01:00": ScheduleDomains(
                        appliances={"living-room-hvac": {"mode": "heat"}}
                    )
                }
            ),
            inputs=None,
            reference_time=REFERENCE_TIME,
            when_active_hourly_energy_kwh_by_appliance_id={"living-room-hvac": None},
        )

        series = plan.appliances_by_id["living-room-hvac"].points
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0].energy_kwh, 0.575)
        self.assertEqual(series[0].mode, "heat")
        self.assertEqual(series[0].projection_method, "fixed_fallback")


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


def _registry_with_charge_limit() -> AppliancesRuntimeRegistry:
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
                    EvChargerUseModeRuntime(id="Fast", behavior="fixed_max_power"),
                    EvChargerUseModeRuntime(id="ECO", behavior="surplus_aware"),
                ),
                eco_gear_configs=(
                    EvChargerEcoGearRuntime(id="6A", min_power_kw=1.4),
                ),
                vehicles=(
                    EvVehicleRuntime(
                        id="kona",
                        name="Kona",
                        soc_entity_id="sensor.kona_soc",
                        charge_limit_entity_id="number.kona_charge_limit",
                        battery_capacity_kwh=64.0,
                        max_charging_power_kw=11.0,
                    ),
                ),
            )
        ]
    )


# Reference time exactly on a canonical slot boundary to avoid partial-first-slice maths.
_SOC_REFERENCE_TIME = datetime.fromisoformat("2026-03-20T10:00:00+01:00")


def _make_house_forecast_for_soc_test() -> dict:
    """Covers canonical slots 10:00–12:45 (13 slots)."""
    series_timestamps = [
        f"2026-03-20T{h:02d}:{m:02d}:00+01:00"
        for h, m in [
            (10, 15), (10, 30), (10, 45),
            (11, 0), (11, 15), (11, 30), (11, 45),
            (12, 0), (12, 15), (12, 30), (12, 45),
        ]
    ]
    return {
        "status": "available",
        "currentSlot": {
            "timestamp": "2026-03-20T10:00:00+01:00",
            "nonDeferrable": {"value": 0.1},
        },
        "series": [
            {"timestamp": ts, "nonDeferrable": {"value": 0.1}}
            for ts in series_timestamps
        ],
    }


def _make_solar_forecast_for_soc_test() -> dict:
    """2000 Wh per canonical slot = 8 kWh/h solar, enough for ECO surplus tests."""
    point_timestamps = [
        f"2026-03-20T{h:02d}:{m:02d}:00+01:00"
        for h, m in [
            (10, 0), (10, 15), (10, 30), (10, 45),
            (11, 0), (11, 15), (11, 30), (11, 45),
            (12, 0), (12, 15), (12, 30), (12, 45),
        ]
    ]
    return {
        "status": "available",
        "points": [{"timestamp": ts, "value": 2000.0} for ts in point_timestamps],
    }


def _six_hour_schedule(vehicle_id: str, mode: str, extra: dict | None = None) -> ScheduleDocument:
    """Six consecutive 30-min schedule slots starting at 10:00 (= 3 hours total)."""
    action: dict = {"charge": True, "vehicleId": vehicle_id, "useMode": mode}
    if extra:
        action.update(extra)
    slot_starts = [
        f"2026-03-20T{h:02d}:{m:02d}:00+01:00"
        for h, m in [
            (10, 0), (10, 30), (11, 0), (11, 30), (12, 0), (12, 30),
        ]
    ]
    return ScheduleDocument(
        slots={slot_id: ScheduleDomains(appliances={"garage-ev": action}) for slot_id in slot_starts}
    )


class EvChargerProjectionSoCCapTests(unittest.TestCase):
    """Verify that projection energy is capped when vehicle reaches target SoC."""

    def _inputs(self):
        return build_projection_input_bundle(
            solar_forecast=_make_solar_forecast_for_soc_test(),
            house_forecast=_make_house_forecast_for_soc_test(),
            reference_time=_SOC_REFERENCE_TIME,
        )

    def test_fast_mode_energy_capped_at_target_soc(self) -> None:
        # 50% current SoC, 90% target → 25.6 kWh remaining
        # Fast mode: 11 kW charger → 2.75 kWh per 15-min slice, 5.5 kWh per 30-min slot
        # 25.6 / 5.5 = 4.65 slots → slots 1-4 full (22 kWh), slot 5 partial (3.6 kWh), slot 6 zero
        registry = _registry_with_charge_limit()
        hass = _FakeHass({
            "sensor.kona_soc": _FakeState("50"),
            "number.kona_charge_limit": _FakeState("90"),
        })

        plan = build_appliance_projection_plan(
            generated_at=_SOC_REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=hass,
            schedule_document=_six_hour_schedule("kona", "Fast"),
            inputs=self._inputs(),
        )

        series = plan.appliances_by_id["garage-ev"].points
        # Only 5 slots should appear (slot 6 has zero capacity left)
        self.assertEqual(len(series), 5)
        self.assertEqual(series[0].energy_kwh, 5.5)
        self.assertEqual(series[1].energy_kwh, 5.5)
        self.assertEqual(series[2].energy_kwh, 5.5)
        self.assertEqual(series[3].energy_kwh, 5.5)
        self.assertEqual(series[4].energy_kwh, round(25.6 - 22.0, 4))  # 3.6

        total = sum(p.energy_kwh for p in series)
        self.assertAlmostEqual(total, 25.6, places=4)

    def test_fast_mode_demand_points_stop_at_target_soc(self) -> None:
        # 10 demand points expected: 8 full (2.75 kWh) + 1 partial (2.75) + 1 partial (0.85)
        registry = _registry_with_charge_limit()
        hass = _FakeHass({
            "sensor.kona_soc": _FakeState("50"),
            "number.kona_charge_limit": _FakeState("90"),
        })

        plan = build_appliance_projection_plan(
            generated_at=_SOC_REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=hass,
            schedule_document=_six_hour_schedule("kona", "Fast"),
            inputs=self._inputs(),
        )

        demand = plan.demand_points
        # Slots 1-4 produce 2 canonical demand points each = 8, slot 5 adds 2 more = 10
        self.assertEqual(len(demand), 10)
        for dp in demand[:9]:
            self.assertEqual(dp.energy_kwh, 2.75)
        self.assertEqual(demand[9].energy_kwh, round(25.6 - 22.0 - 2.75, 4))  # 0.85

    def test_vehicle_already_at_target_produces_no_projection(self) -> None:
        registry = _registry_with_charge_limit()
        hass = _FakeHass({
            "sensor.kona_soc": _FakeState("90"),
            "number.kona_charge_limit": _FakeState("90"),
        })

        plan = build_appliance_projection_plan(
            generated_at=_SOC_REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=hass,
            schedule_document=_six_hour_schedule("kona", "Fast"),
            inputs=self._inputs(),
        )

        self.assertEqual(plan.appliances_by_id, {})
        self.assertEqual(plan.demand_points, ())

    def test_unavailable_soc_disables_capping(self) -> None:
        # When SoC entity is unavailable, projection runs uncapped (all 6 slots)
        registry = _registry_with_charge_limit()
        hass = _FakeHass({
            "sensor.kona_soc": _FakeState("unavailable"),
            "number.kona_charge_limit": _FakeState("90"),
        })

        plan = build_appliance_projection_plan(
            generated_at=_SOC_REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=hass,
            schedule_document=_six_hour_schedule("kona", "Fast"),
            inputs=self._inputs(),
        )

        series = plan.appliances_by_id["garage-ev"].points
        self.assertEqual(len(series), 6)

    def test_no_charge_limit_entity_caps_at_100_pct(self) -> None:
        # Vehicle with no charge_limit_entity_id: caps at 100%
        registry = AppliancesRuntimeRegistry.from_appliances(
            [
                EvChargerApplianceRuntime(
                    id="garage-ev",
                    name="Garage EV",
                    max_charging_power_kw=11.0,
                    charge_entity_id="switch.ev_nabijeni",
                    use_mode_entity_id="select.use_mode",
                    eco_gear_entity_id="select.eco_gear",
                    use_mode_configs=(
                        EvChargerUseModeRuntime(id="Fast", behavior="fixed_max_power"),
                    ),
                    eco_gear_configs=(
                        EvChargerEcoGearRuntime(id="6A", min_power_kw=1.4),
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
        # At 95% SoC with 64 kWh battery → only 3.2 kWh remaining to 100%
        # Fast mode 11 kW → 2.75 kWh per canonical slot → first slot partial, rest zero
        hass = _FakeHass({"sensor.kona_soc": _FakeState("95")})

        plan = build_appliance_projection_plan(
            generated_at=_SOC_REFERENCE_TIME.isoformat(),
            registry=registry,
            hass=hass,
            schedule_document=_six_hour_schedule("kona", "Fast"),
            inputs=self._inputs(),
        )

        series = plan.appliances_by_id["garage-ev"].points
        self.assertEqual(len(series), 1)
        total = sum(p.energy_kwh for p in series)
        self.assertAlmostEqual(total, 3.2, places=4)


if __name__ == "__main__":
    unittest.main()
