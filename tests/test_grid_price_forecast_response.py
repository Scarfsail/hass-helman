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

from custom_components.helman import (  # noqa: E402
    grid_price_forecast_response,
    point_forecast_response,
)


class GridPriceForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(point_forecast_response, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    def test_half_hour_response_shapes_export_and_import_prices(self) -> None:
        response = grid_price_forecast_response.build_grid_price_forecast_response(
            {
                "export": {
                    "status": "available",
                    "unit": "CZK/kWh",
                    "currentPrice": 2.5,
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
                "import": {
                    "status": "available",
                    "unit": "CZK/kWh",
                    "currentPrice": 6.5,
                    "points": [
                        {
                            "timestamp": "2026-03-20T21:00:00+01:00",
                            "value": 5.0,
                        },
                        {
                            "timestamp": "2026-03-20T21:15:00+01:00",
                            "value": 7.0,
                        },
                        {
                            "timestamp": "2026-03-20T21:30:00+01:00",
                            "value": 7.0,
                        },
                        {
                            "timestamp": "2026-03-20T21:45:00+01:00",
                            "value": 7.0,
                        },
                    ],
                },
            },
            granularity=30,
            forecast_days=1,
        )

        self.assertEqual(response["exportPriceUnit"], "CZK/kWh")
        self.assertEqual(response["currentExportPrice"], 2.5)
        self.assertEqual(
            response["exportPricePoints"],
            [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 100.0},
                {"timestamp": "2026-03-20T21:30:00+01:00", "value": 100.0},
                {"timestamp": "2026-03-20T22:00:00+01:00", "value": 120.0},
                {"timestamp": "2026-03-20T22:30:00+01:00", "value": 120.0},
            ],
        )
        self.assertEqual(response["importPriceUnit"], "CZK/kWh")
        self.assertEqual(response["currentImportPrice"], 6.5)
        self.assertEqual(
            response["importPricePoints"],
            [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 6.0},
                {"timestamp": "2026-03-20T21:30:00+01:00", "value": 7.0},
            ],
        )

    def test_response_returns_empty_import_fields_when_not_configured(self) -> None:
        response = grid_price_forecast_response.build_grid_price_forecast_response(
            {
                "export": {
                    "status": "available",
                    "unit": "CZK/kWh",
                    "currentPrice": 2.5,
                    "points": [
                        {
                            "timestamp": "2026-03-20T21:00:00+01:00",
                            "value": 100.0,
                        }
                    ],
                },
                "import": {
                    "status": "not_configured",
                    "unit": None,
                    "currentPrice": None,
                    "points": [],
                },
            },
            granularity=60,
            forecast_days=1,
        )

        self.assertEqual(response["currentImportPrice"], None)
        self.assertEqual(response["importPriceUnit"], None)
        self.assertEqual(response["importPricePoints"], [])


if __name__ == "__main__":
    unittest.main()
