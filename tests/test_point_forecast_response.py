from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


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
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


class _FakeDtUtil:
    @staticmethod
    def as_local(value: datetime) -> datetime:
        if value.tzinfo == TZ:
            return value
        return value.astimezone(TZ)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)

    @staticmethod
    def parse_datetime(value: str) -> datetime:
        return datetime.fromisoformat(value)


_install_import_stubs()

from custom_components.helman import point_forecast_response  # noqa: E402


class PointForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(point_forecast_response, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    def test_solar_half_hour_response_aggregates_points_and_history(self) -> None:
        response = point_forecast_response.build_solar_forecast_response(
            {
                "status": "available",
                "unit": "Wh",
                "remainingTodayEnergyEntityId": "sensor.remaining_today_energy",
                "points": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "value": 400.0,
                    },
                    {
                        "timestamp": "2026-03-20T22:00:00+01:00",
                        "value": 800.0,
                    },
                ],
                "actualHistory": [
                    {
                        "timestamp": "2026-03-20T19:00:00+01:00",
                        "value": 200.0,
                    },
                    {
                        "timestamp": "2026-03-20T20:00:00+01:00",
                        "value": 400.0,
                    },
                ],
            },
            granularity=30,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "half_hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["points"], [
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 200.0},
            {"timestamp": "2026-03-20T21:30:00+01:00", "value": 200.0},
            {"timestamp": "2026-03-20T22:00:00+01:00", "value": 400.0},
            {"timestamp": "2026-03-20T22:30:00+01:00", "value": 400.0},
        ])
        self.assertEqual(response["actualHistory"], [
            {"timestamp": "2026-03-20T19:00:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T19:30:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T20:00:00+01:00", "value": 200.0},
            {"timestamp": "2026-03-20T20:30:00+01:00", "value": 200.0},
        ])

    def test_grid_half_hour_response_repeats_hourly_prices(self) -> None:
        response = point_forecast_response.build_grid_forecast_response(
            {
                "status": "available",
                "unit": "CZK/kWh",
                "currentSellPrice": 2.5,
                "points": [
                    {
                        "timestamp": "2026-03-20T21:00:00+01:00",
                        "value": 100.0,
                    },
                    {
                        "timestamp": "2026-03-20T22:00:00+01:00",
                        "value": 120.0,
                    },
                ],
            },
            granularity=30,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "half_hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["currentSellPrice"], 2.5)
        self.assertEqual(response["points"], [
            {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T21:30:00+01:00", "value": 100.0},
            {"timestamp": "2026-03-20T22:00:00+01:00", "value": 120.0},
            {"timestamp": "2026-03-20T22:30:00+01:00", "value": 120.0},
        ])


if __name__ == "__main__":
    unittest.main()
