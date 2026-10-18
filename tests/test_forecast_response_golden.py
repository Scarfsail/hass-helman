from __future__ import annotations

from datetime import datetime, timezone
import unittest
from zoneinfo import ZoneInfo

from homeassistant.util import dt as dt_util

from _ha_stubs import stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc

core_mod = stub_module("homeassistant.core")
if not hasattr(core_mod, "HomeAssistant"):
    core_mod.HomeAssistant = type("HomeAssistant", (), {})

util_pkg = stub_module("homeassistant.util")
dt_mod = stub_module("homeassistant.util.dt")
if not hasattr(dt_mod, "as_local"):
    dt_mod.as_local = lambda value: value
if not hasattr(dt_mod, "as_utc"):
    dt_mod.as_utc = lambda value: value
if not hasattr(dt_mod, "parse_datetime"):
    dt_mod.parse_datetime = datetime.fromisoformat
util_pkg.dt = dt_mod

from custom_components.helman.battery_forecast_response import build_battery_forecast_response
from custom_components.helman.grid_flow_forecast_response import build_grid_flow_forecast_response
from custom_components.helman.house_forecast_response import build_house_forecast_response
from custom_components.helman.point_forecast_response import build_solar_forecast_response


class ForecastResponseGoldenTests(unittest.TestCase):
    def test_battery_response_golden(self) -> None:
        snapshot = {
            "status": "available",
            "startedAt": "2026-03-20T21:00:00+01:00",
            "unit": "kWh",
            "sourceGranularityMinutes": 15,
            "baselineSeries": [{"ignored": True}],
            "series": [
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "durationHours": 0.25,
                    "solarKwh": 0.25,
                    "baselineHouseKwh": 0.125,
                    "netKwh": 0.125,
                    "chargedKwh": 0.125,
                    "dischargedKwh": 0.0,
                    "importedFromGridKwh": 0.0,
                    "exportedToGridKwh": 0.0,
                    "remainingEnergyKwh": 5.0,
                    "socPct": 50.0,
                    "hitMinSoc": False,
                    "hitMaxSoc": False,
                    "limitedByChargePower": False,
                    "limitedByDischargePower": False,
                    "internalExtra": "dropped",
                }
            ],
            "actualHistory": [
                {
                    "timestamp": "2026-03-20T20:45:00+01:00",
                    "socPct": 49.0,
                }
            ],
        }
        res = build_battery_forecast_response(snapshot, forecast_days=1)
        self.assertEqual(res["status"], "available")
        self.assertEqual(res["unit"], "kWh")
        self.assertNotIn("sourceGranularityMinutes", res)
        self.assertNotIn("baselineSeries", res)
        self.assertEqual(len(res["series"]), 1)
        self.assertNotIn("internalExtra", res["series"][0])
        self.assertEqual(res["series"][0]["remainingEnergyKwh"], 5.0)
        self.assertEqual(len(res["actualHistory"]), 1)
        self.assertEqual(res["actualHistory"][0]["socPct"], 49.0)

    def test_grid_flow_response_golden(self) -> None:
        snapshot = {
            "status": "available",
            "startedAt": "2026-03-20T21:00:00+01:00",
            "unit": "kWh",
            "sourceGranularityMinutes": 15,
            "series": [
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "durationHours": 0.25,
                    "importedFromGridKwh": 0.5,
                    "exportedToGridKwh": 0.0,
                    "availableSurplusKwh": 0.1,
                    "extra": "dropped",
                }
            ],
        }
        res = build_grid_flow_forecast_response(snapshot, forecast_days=1)
        self.assertEqual(res["status"], "available")
        self.assertEqual(res["unit"], "kWh")
        self.assertNotIn("sourceGranularityMinutes", res)
        self.assertEqual(len(res["series"]), 1)
        self.assertEqual(res["series"][0]["importedFromGridKwh"], 0.5)
        self.assertEqual(res["series"][0]["availableSurplusKwh"], 0.1)
        self.assertNotIn("extra", res["series"][0])

    def test_house_response_golden(self) -> None:
        current_slot = {
            "timestamp": "2026-03-20T21:00:00+01:00",
            "nonDeferrable": {"value": 0.5},
        }
        next_slot = {
            "timestamp": "2026-03-20T21:15:00+01:00",
            "nonDeferrable": {"value": 0.6},
        }
        snapshot = {
            "status": "available",
            "generatedAt": "2026-03-20T21:00:00+01:00",
            "unit": "kWh",
            "sourceGranularityMinutes": 15,
            "currentSlot": current_slot,
            "series": [next_slot],
            "actualHistory": [
                {
                    "timestamp": "2026-03-20T20:45:00+01:00",
                    "nonDeferrable": {"value": 0.4},
                }
            ],
        }
        res = build_house_forecast_response(snapshot, forecast_days=1)
        self.assertEqual(res["status"], "available")
        self.assertEqual(res["unit"], "kWh")
        self.assertNotIn("sourceGranularityMinutes", res)
        self.assertEqual(res["currentSlot"]["timestamp"], "2026-03-20T21:00:00+01:00")
        self.assertEqual(len(res["series"]), 1)
        self.assertEqual(res["series"][0]["timestamp"], "2026-03-20T21:15:00+01:00")
        self.assertEqual(len(res["actualHistory"]), 1)

    def test_solar_response_golden(self) -> None:
        snapshot = {
            "status": "available",
            "unit": "Wh",
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 110.0},
            ],
            "actualHistory": [
                {"timestamp": "2026-03-20T20:45:00+01:00", "value": 90.0},
            ],
        }
        res = build_solar_forecast_response(snapshot, forecast_days=1)
        self.assertEqual(res["status"], "available")
        self.assertEqual(res["unit"], "Wh")
        self.assertEqual(len(res["points"]), 2)
        self.assertEqual(res["points"][0]["value"], 100.0)
        self.assertEqual(len(res["actualHistory"]), 1)
        self.assertEqual(res["actualHistory"][0]["value"], 90.0)
