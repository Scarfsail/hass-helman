from __future__ import annotations
from tests._fakes import make_coordinator

import importlib
import unittest
import pytest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")

coordinator_module = importlib.import_module("custom_components.helman.forecast.service")


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    from homeassistant.util import dt as dt_util
    monkeypatch.setattr(dt_util, "now", lambda: REFERENCE_TIME)


class CoordinatorGridForecastTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_forecast_derives_top_level_grid_from_battery_forecast(self):
        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace()
        coordinator._storage = SimpleNamespace(config={})
        coordinator._active_config = {}
        coordinator.forecast._cached_forecast = {"status": "available"}
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )

        adjusted_house_forecast = {"status": "available", "generatedAt": "2026-03-20T21:16:00+01:00"}
        canonical_battery_forecast = {
            "status": "available",
            "startedAt": "2026-03-20T21:16:00+01:00",
            "sourceGranularityMinutes": 15,
            "series": [
                {
                    "timestamp": "2026-03-20T21:16:00+01:00",
                    "durationHours": 14 / 60,
                    "importedFromGridKwh": 0.1,
                    "exportedToGridKwh": 0.0,
                }
            ],
        }
        coordinator.forecast._async_current_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                original_house_forecast=adjusted_house_forecast,
                adjusted_house_forecast=adjusted_house_forecast,
                battery_forecast=canonical_battery_forecast,
            )
        )
        canonical_solar = {"canonical": "solar"}
        coordinator.forecast._async_get_canonical_solar_forecast = AsyncMock(
            return_value=canonical_solar
        )

        builder_instance = SimpleNamespace(
            build=Mock(
                return_value={
                    "export": {"status": "available", "currentPrice": 2.5},
                    "import": {"status": "available", "currentPrice": 7.0},
                }
            ),
            build_export_price_snapshot=Mock(
                return_value={"status": "available", "currentPrice": 2.5}
            ),
        )
        solar_response = {"kind": "solar"}
        house_response = {"kind": "house"}
        battery_response = {"kind": "battery"}
        canonical_grid_response = {"canonical": "grid"}
        grid_flow_response = {
            "kind": "grid-flow",
            "unit": "kWh",
            "series": [],
        }
        grid_price_response = {
            "exportPriceUnit": "CZK/kWh",
            "currentExportPrice": 2.5,
            "exportPricePoints": [
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "value": 100.0,
                }
            ],
            "importPriceUnit": "CZK/kWh",
            "currentImportPrice": 7.0,
            "importPricePoints": [
                {
                    "timestamp": "2026-03-20T21:00:00+01:00",
                    "value": 200.0,
                }
            ],
        }

        with (
            patch.object(
                coordinator_module,
                "GridPriceForecastBuilder",
                return_value=builder_instance,
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value=solar_response,
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value=grid_price_response,
            ) as build_grid_price_response,
            patch.object(
                coordinator_module,
                "build_house_forecast_response",
                return_value=house_response,
            ),
            patch.object(
                coordinator_module,
                "build_battery_forecast_response",
                return_value=battery_response,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_snapshot",
                return_value=canonical_grid_response,
            ) as build_grid_snapshot,
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_response",
                return_value=grid_flow_response,
            ) as build_grid_response,
        ):
            result = await coordinator.get_forecast(forecast_days=1)

        build_grid_price_response.assert_called_once_with(
            {
                "export": {"status": "available", "currentPrice": 2.5},
                "import": {"status": "available", "currentPrice": 7.0},
            },
            forecast_days=1,
        )
        build_grid_snapshot.assert_called_once_with(canonical_battery_forecast)
        build_grid_response.assert_called_once_with(
            canonical_grid_response,
            forecast_days=1,
        )
        coordinator.forecast._async_current_pipeline.assert_awaited_once_with(REFERENCE_TIME)
        self.assertEqual(result["solar"], solar_response)
        self.assertEqual(result["house_consumption"], house_response)
        self.assertEqual(result["battery_capacity"], battery_response)
        self.assertEqual(result["grid"]["kind"], "grid-flow")
        self.assertEqual(result["grid"]["unit"], "kWh")
        self.assertEqual(result["grid"]["currentExportPrice"], 2.5)
        self.assertEqual(result["grid"]["exportPriceUnit"], "CZK/kWh")
        self.assertEqual(
            result["grid"]["exportPricePoints"],
            grid_price_response["exportPricePoints"],
        )
        self.assertEqual(result["grid"]["currentImportPrice"], 7.0)
        self.assertEqual(result["grid"]["importPriceUnit"], "CZK/kWh")
        self.assertEqual(
            result["grid"]["importPricePoints"],
            grid_price_response["importPricePoints"],
        )
        self.assertNotIn("currentPrice", result["grid"])


class CoordinatorOwnedExportPriceChannelTests(unittest.TestCase):
    def _make_coordinator(self):
        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        coordinator.forecast._grid_price_snapshot_cache = None
        coordinator.forecast._grid_export_price_channel = None
        coordinator.forecast._grid_export_price_schedule = {}
        return coordinator

    def test_grid_price_snapshot_is_served_from_the_owned_export_channel(self) -> None:
        coordinator = self._make_coordinator()
        owned_channel = {
            "status": "available",
            "unit": "CZK/kWh",
            "currentPrice": 2.5,
            "points": [],
            "schedule": {"2026-03-20T21:00:00+01:00": 2.5},
        }
        coordinator.forecast._grid_export_price_channel = owned_channel

        build = Mock(return_value={"export": owned_channel, "import": {}})
        source_read = Mock()
        with patch.object(
                coordinator_module,
                "GridPriceForecastBuilder",
                return_value=SimpleNamespace(
                    build=build,
                    build_export_price_snapshot=source_read,
                ),
            ):
                snapshot = coordinator.grid_price_snapshot()

        # The inspector's price rail is a transform of the owned channel, not a
        # second read of the configured entity.
        source_read.assert_not_called()
        self.assertIs(build.call_args.kwargs["export_snapshot"], owned_channel)
        self.assertIs(snapshot["export"], owned_channel)

    def test_the_refresh_beat_re_ingests_and_owns_what_it_reads(self) -> None:
        coordinator = self._make_coordinator()
        first = {
            "status": "available",
            "unit": "CZK/kWh",
            "currentPrice": 2.5,
            "points": [],
            "schedule": {"2026-03-20T21:00:00+01:00": 2.5},
        }
        # Same price, different schedule: an attribute-only source update still
        # has to reach the owned channel, or the sensor's published attributes
        # would never move.
        second = {
            "status": "available",
            "unit": "CZK/kWh",
            "currentPrice": 2.5,
            "points": [],
            "schedule": {"2026-03-21T00:00:00+01:00": -0.4},
        }
        source_read = Mock(side_effect=[first, second])

        with patch.object(
            coordinator_module,
            "GridPriceForecastBuilder",
            return_value=SimpleNamespace(build_export_price_snapshot=source_read),
        ):
            coordinator.forecast._ingest_grid_export_price()
            self.assertEqual(
                coordinator.get_grid_export_price_schedule(),
                {"2026-03-20T21:00:00+01:00": 2.5},
            )

            coordinator.forecast._ingest_grid_export_price()

        self.assertEqual(coordinator.get_grid_export_price_current(), 2.5)
        self.assertEqual(
            coordinator.get_grid_export_price_schedule(),
            {"2026-03-21T00:00:00+01:00": -0.4},
        )
        self.assertIs(coordinator.forecast._get_grid_export_price_channel(), second)


class GridForecastMergeTests(unittest.TestCase):
    def test_combining_grid_flow_and_price_responses_does_not_mutate_sources(self) -> None:
        flow = {"slots": [{"t": 0}], "exportPriceUnit": "old"}
        price = {
            "exportPriceUnit": "EUR",
            "currentExportPrice": 1.0,
            "exportPricePoints": [{"t": 1}],
            "importPriceUnit": "EUR",
            "currentImportPrice": 2.0,
            "importPricePoints": [{"t": 2}],
        }
        merged = {**flow, **price}
        # Overwrites must not bleed back into source dicts
        merged["exportPriceUnit"] = "MUTATED"
        self.assertEqual(price["exportPriceUnit"], "EUR")
        # Slots from the flow response are passed through
        self.assertIs(merged["slots"], flow["slots"])


if __name__ == "__main__":
    unittest.main()
