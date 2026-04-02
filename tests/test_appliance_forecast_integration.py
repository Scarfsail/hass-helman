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
    "homeassistant.components",
    "homeassistant.components.recorder",
    "homeassistant.components.recorder.history",
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

        components_pkg = sys.modules.get("homeassistant.components")
        if components_pkg is None:
            components_pkg = types.ModuleType("homeassistant.components")
            sys.modules["homeassistant.components"] = components_pkg

        recorder_pkg = sys.modules.get("homeassistant.components.recorder")
        if recorder_pkg is None:
            recorder_pkg = types.ModuleType("homeassistant.components.recorder")
            recorder_pkg.get_instance = lambda hass: None
            sys.modules["homeassistant.components.recorder"] = recorder_pkg

        history_pkg = sys.modules.get("homeassistant.components.recorder.history")
        if history_pkg is None:
            history_pkg = types.ModuleType("homeassistant.components.recorder.history")
            history_pkg.state_changes_during_period = lambda *args, **kwargs: {}
            sys.modules["homeassistant.components.recorder.history"] = history_pkg

        util_pkg = sys.modules.get("homeassistant.util")
        if util_pkg is None:
            util_pkg = types.ModuleType("homeassistant.util")
            sys.modules["homeassistant.util"] = util_pkg

        dt_mod = sys.modules.get("homeassistant.util.dt")
        if dt_mod is None:
            from datetime import datetime

            dt_mod = types.ModuleType("homeassistant.util.dt")
            dt_mod.parse_datetime = datetime.fromisoformat
            dt_mod.as_local = lambda value: value
            dt_mod.as_utc = lambda value: value
            sys.modules["homeassistant.util.dt"] = dt_mod

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
    forecast_integration_module = importlib.import_module(
        "custom_components.helman.appliances.forecast_integration"
    )
    projection_builder_module = importlib.import_module(
        "custom_components.helman.appliances.projection_builder"
    )
finally:
    _restore_modules(_previous_modules)
    for module_name in (
        "custom_components.helman.appliances.forecast_integration",
        "custom_components.helman.appliances.projection_builder",
        "custom_components.helman.appliances",
    ):
        sys.modules.pop(module_name, None)

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
                ),
                ApplianceDemandPoint(
                    appliance_id="pool",
                    slot_id="2026-03-20T21:00:00+01:00",
                    energy_kwh=0.3,
                ),
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:15:00+01:00",
                    energy_kwh=0.5,
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
                ),
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:15:00+01:00",
                    energy_kwh=0.5,
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

    def test_build_adjusted_house_forecast_keeps_original_input_unchanged(self) -> None:
        house_forecast = _make_house_forecast()

        _ = build_adjusted_house_forecast(
            house_forecast=house_forecast,
            demand_points=[
                ApplianceDemandPoint(
                    appliance_id="garage-ev",
                    slot_id="2026-03-20T21:00:00+01:00",
                    energy_kwh=0.8,
                )
            ],
        )

        self.assertEqual(house_forecast["currentSlot"]["nonDeferrable"]["value"], 0.5)
        self.assertEqual(house_forecast["currentSlot"]["nonDeferrable"]["lower"], 0.4)
        self.assertEqual(house_forecast["currentSlot"]["nonDeferrable"]["upper"], 0.6)


if __name__ == "__main__":
    unittest.main()
