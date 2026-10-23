from __future__ import annotations
from tests._fakes import make_coordinator

import importlib
import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, Mock, patch

from _ha_stubs import (
    stub_ha_dt,
    stub_module,
)

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")


class SolarBiasResponseTests(unittest.TestCase):
    @staticmethod
    def _import_response_module():
        return importlib.import_module(
            "custom_components.helman.solar_bias_correction.response"
        )

    @staticmethod
    def _import_models_module():
        return importlib.import_module(
            "custom_components.helman.solar_bias_correction.models"
        )

    def test_payload_reports_an_applied_correction_with_its_explainability(self) -> None:
        """The shape the card reads off ``solar.biasCorrection``."""
        response_module = self._import_response_module()
        models = self._import_models_module()
        adjustment_result = models.SolarBiasAdjustmentResult(
            status="applied",
            effective_variant="adjusted",
            adjusted_points=[],
            explainability=models.SolarBiasExplainability(
                fallback_reason=None,
                trained_at="2026-03-20T03:00:00+01:00",
                usable_days=5,
                dropped_days=1,
                omitted_slot_count=2,
                factor_min=0.5,
                factor_max=1.5,
                factor_median=1.0,
                error=None,
            ),
        )

        payload = response_module.build_bias_correction_payload(adjustment_result)

        self.assertEqual(
            payload,
            {
                "status": "applied",
                "effectiveVariant": "adjusted",
                "explainability": {
                    "fallbackReason": None,
                    "trainedAt": "2026-03-20T03:00:00+01:00",
                    "usableDays": 5,
                    "droppedDays": 1,
                    "omittedSlotCount": 2,
                    "factorSummary": {
                        "min": 0.5,
                        "max": 1.5,
                        "median": 1.0,
                    },
                },
            },
        )

    def test_payload_surfaces_the_fallback_reason_and_error_when_training_failed(
        self,
    ) -> None:
        response_module = self._import_response_module()
        models = self._import_models_module()
        adjustment_result = models.SolarBiasAdjustmentResult(
            status="training_failed",
            effective_variant="raw",
            adjusted_points=[],
            explainability=models.SolarBiasExplainability(
                fallback_reason="profile_unavailable",
                trained_at="2026-03-20T03:00:00+01:00",
                usable_days=0,
                dropped_days=3,
                omitted_slot_count=0,
                factor_min=None,
                factor_max=None,
                factor_median=None,
                error="boom",
            ),
        )

        payload = response_module.build_bias_correction_payload(adjustment_result)

        self.assertEqual(payload["status"], "training_failed")
        self.assertEqual(payload["effectiveVariant"], "raw")
        self.assertEqual(
            payload["explainability"]["fallbackReason"], "profile_unavailable"
        )
        self.assertEqual(payload["explainability"]["error"], "boom")

    def test_payload_omits_error_when_there_was_none(self) -> None:
        """``error`` is only present when there is one to report."""
        response_module = self._import_response_module()
        models = self._import_models_module()
        adjustment_result = models.SolarBiasAdjustmentResult(
            status="applied",
            effective_variant="adjusted",
            adjusted_points=[],
            explainability=models.SolarBiasExplainability(
                fallback_reason=None,
                trained_at=None,
                usable_days=1,
                dropped_days=0,
                omitted_slot_count=0,
                factor_min=None,
                factor_max=None,
                factor_median=None,
                error=None,
            ),
        )

        payload = response_module.build_bias_correction_payload(adjustment_result)

        self.assertNotIn("error", payload["explainability"])

    def test_payload_falls_back_to_zeroes_without_explainability(self) -> None:
        response_module = self._import_response_module()
        models = self._import_models_module()
        adjustment_result = models.SolarBiasAdjustmentResult(
            status="unavailable",
            effective_variant="raw",
            adjusted_points=[],
            explainability=None,
        )

        payload = response_module.build_bias_correction_payload(adjustment_result)

        self.assertEqual(
            payload["explainability"],
            {
                "fallbackReason": None,
                "trainedAt": None,
                "usableDays": 0,
                "droppedDays": 0,
                "omittedSlotCount": 0,
                "factorSummary": {"min": None, "max": None, "median": None},
            },
        )


class CoordinatorSolarBiasResponseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from homeassistant.util import dt as dt_util

        patcher = patch.object(dt_util, "now", return_value=REFERENCE_TIME)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_get_forecast_uses_cached_adjusted_solar_points_when_bias_snapshot_exists(self) -> None:
        coordinator_module = importlib.import_module(
            "custom_components.helman.forecast.service"
        )

        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace()
        coordinator._storage = SimpleNamespace(config={})
        coordinator._active_config = {}
        coordinator.forecast._cached_forecast = {"status": "available"}
        coordinator.forecast._cached_solar_forecast = {
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 20.0},
            ],
            "rawPoints": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
        }
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )
        coordinator.forecast._async_refresh_forecast = AsyncMock()

        adjusted_house_forecast = {
            "status": "available",
            "generatedAt": "2026-03-20T21:16:00+01:00",
        }
        canonical_battery_forecast = {
            "status": "available",
            "startedAt": "2026-03-20T21:16:00+01:00",
            "sourceGranularityMinutes": 15,
            "series": [],
        }
        # The real read path down to the build, so what the pipeline is handed
        # from the cached snapshots is what gets asserted.
        coordinator.forecast._async_prepare_forecast_pipeline_inputs = AsyncMock(
            return_value=SimpleNamespace(
                schedule_signature=(),
                appliance_schedule_signature=(),
                schedule_effective_signature=None,
            )
        )
        coordinator.forecast._async_build_appliance_forecast_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                original_house_forecast=coordinator.forecast._cached_forecast,
                adjusted_house_forecast=adjusted_house_forecast,
                battery_forecast=canonical_battery_forecast,
            )
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
        solar_response = {"kind": "solar-with-bias"}
        house_response = {"kind": "house"}
        battery_response = {"kind": "battery"}
        grid_flow_response = {"kind": "grid-flow"}
        grid_price_response = {
            "exportPriceUnit": "CZK/kWh",
            "currentExportPrice": 2.5,
            "exportPricePoints": [],
            "importPriceUnit": "CZK/kWh",
            "currentImportPrice": 7.0,
            "importPricePoints": [],
        }
        with (
            patch.object(
                coordinator_module,
                "GridPriceForecastBuilder",
                return_value=builder_instance,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value=solar_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_house_forecast_response",
                return_value=house_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_battery_forecast_response",
                return_value=battery_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_snapshot",
                return_value={"canonical": "grid"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_response",
                return_value=grid_flow_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value=grid_price_response,
                create=True,
            ),
        ):
            result = await coordinator.get_forecast(forecast_days=1)

        coordinator.forecast._async_refresh_forecast.assert_not_awaited()
        coordinator.forecast._async_build_appliance_forecast_pipeline.assert_awaited_once_with(
            solar_forecast={
                "status": "available",
                "generatedAt": REFERENCE_TIME.isoformat(),
                "points": [
                    {"timestamp": "2026-03-20T21:00:00+01:00", "value": 20.0},
                ],
                "rawPoints": [
                    {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
                ],
            },
            house_forecast=coordinator.forecast._cached_forecast,
            started_at=REFERENCE_TIME,
            prepared=ANY,
            key=ANY,
        )
        self.assertEqual(result["solar"], solar_response)
        self.assertEqual(result["house_consumption"], house_response)
        self.assertEqual(result["battery_capacity"], battery_response)

    async def test_get_forecast_falls_back_to_cached_raw_points_without_bias_snapshot(self) -> None:
        coordinator_module = importlib.import_module(
            "custom_components.helman.forecast.service"
        )

        coordinator = make_coordinator()
        coordinator._hass = SimpleNamespace()
        coordinator._storage = SimpleNamespace(config={})
        coordinator._active_config = {}
        coordinator.forecast._cached_forecast = {"status": "available"}
        coordinator.forecast._cached_solar_forecast = {
            "status": "available",
            "generatedAt": REFERENCE_TIME.isoformat(),
            "points": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
            "rawPoints": [
                {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
            ],
        }
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )
        coordinator.forecast._async_refresh_forecast = AsyncMock()
        # The real read path down to the build, so what the pipeline is handed
        # from the cached snapshots is what gets asserted.
        coordinator.forecast._async_prepare_forecast_pipeline_inputs = AsyncMock(
            return_value=SimpleNamespace(
                schedule_signature=(),
                appliance_schedule_signature=(),
                schedule_effective_signature=None,
            )
        )
        coordinator.forecast._async_build_appliance_forecast_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                original_house_forecast=coordinator.forecast._cached_forecast,
                adjusted_house_forecast={"status": "available"},
                battery_forecast={"status": "available", "series": []},
            )
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
        solar_response = {"kind": "raw-solar"}

        with (
            patch.object(
                coordinator_module,
                "GridPriceForecastBuilder",
                return_value=builder_instance,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value=solar_response,
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_house_forecast_response",
                return_value={"kind": "house"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_battery_forecast_response",
                return_value={"kind": "battery"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_snapshot",
                return_value={"canonical": "grid"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_flow_forecast_response",
                return_value={"kind": "grid-flow"},
                create=True,
            ),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value={
                    "exportPriceUnit": "CZK/kWh",
                    "currentExportPrice": 2.5,
                    "exportPricePoints": [],
                    "importPriceUnit": "CZK/kWh",
                    "currentImportPrice": 7.0,
                    "importPricePoints": [],
                },
                create=True,
            ),
        ):
            result = await coordinator.get_forecast(forecast_days=1)

        coordinator.forecast._async_refresh_forecast.assert_not_awaited()
        coordinator.forecast._async_build_appliance_forecast_pipeline.assert_awaited_once_with(
            solar_forecast={
                "status": "available",
                "generatedAt": REFERENCE_TIME.isoformat(),
                "points": [
                    {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
                ],
                "rawPoints": [
                    {"timestamp": "2026-03-20T21:00:00+01:00", "value": 10.0},
                ],
            },
            house_forecast=coordinator.forecast._cached_forecast,
            started_at=REFERENCE_TIME,
            prepared=ANY,
            key=ANY,
        )
        self.assertEqual(result["solar"], solar_response)


if __name__ == "__main__":
    unittest.main()
