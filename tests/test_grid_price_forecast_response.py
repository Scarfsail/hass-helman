from __future__ import annotations

from homeassistant.util import dt as dt_util

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from _ha_stubs import stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


def _install_import_stubs() -> None:

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt")
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod




_install_import_stubs()

from custom_components.helman import (  # noqa: E402
    forecast_response,
    grid_price_forecast_response,
)


class GridPriceForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(forecast_response, "dt_util", dt_util)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    def test_response_shapes_export_and_import_prices_on_the_canonical_grid(self) -> None:
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
                            "timestamp": "2026-03-20T21:15:00+01:00",
                            "value": 100.0,
                        },
                        {
                            "timestamp": "2026-03-20T21:30:00+01:00",
                            "value": 100.0,
                        },
                        {
                            "timestamp": "2026-03-20T21:45:00+01:00",
                            "value": 100.0,
                        },
                        {
                            "timestamp": "2026-03-20T22:00:00+01:00",
                            "value": 120.0,
                        },
                        {
                            "timestamp": "2026-03-20T22:15:00+01:00",
                            "value": 120.0,
                        },
                        {
                            "timestamp": "2026-03-20T22:30:00+01:00",
                            "value": 120.0,
                        },
                        {
                            "timestamp": "2026-03-20T22:45:00+01:00",
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
            forecast_days=1,
        )

        self.assertEqual(response["exportPriceUnit"], "CZK/kWh")
        self.assertEqual(response["currentExportPrice"], 2.5)
        # A price is repeated onto the quarters of its hour, never split.
        self.assertEqual(
            [point["value"] for point in response["exportPricePoints"]],
            [100.0] * 4 + [120.0] * 4,
        )
        self.assertEqual(
            response["exportPricePoints"][1]["timestamp"],
            "2026-03-20T21:15:00+01:00",
        )
        self.assertEqual(response["importPriceUnit"], "CZK/kWh")
        self.assertEqual(response["currentImportPrice"], 6.5)
        # Already canonical: passed through untouched.
        self.assertEqual(
            response["importPricePoints"],
            [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 5.0},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 7.0},
                {"timestamp": "2026-03-20T21:30:00+01:00", "value": 7.0},
                {"timestamp": "2026-03-20T21:45:00+01:00", "value": 7.0},
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
            forecast_days=1,
        )

        self.assertEqual(response["currentImportPrice"], None)
        self.assertEqual(response["importPriceUnit"], None)
        self.assertEqual(response["importPricePoints"], [])


if __name__ == "__main__":
    unittest.main()
