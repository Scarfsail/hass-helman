from __future__ import annotations

import importlib
import asyncio
import sys
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from test_solar_bias_response import (
    REFERENCE_TIME,
    _install_coordinator_import_stubs,
    _restore_modules,
)


class CoordinatorSolarForecastCacheTests(unittest.IsolatedAsyncioTestCase):
    def _load_coordinator_module(self):
        previous_modules = _install_coordinator_import_stubs()
        try:
            sys.modules.pop("custom_components.helman.coordinator", None)
            return (
                importlib.import_module("custom_components.helman.coordinator"),
                previous_modules,
            )
        except Exception:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_solar_source_state_change_triggers_debounced_refresh(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._cached_solar_forecast = {"status": "available"}
            coordinator._async_refresh_forecast_and_request_automation = AsyncMock()
            coordinator._hass = SimpleNamespace(async_create_task=asyncio.create_task)

            class _CoalescingDebouncer:
                def __init__(self):
                    self._pending = False

                async def async_call(self):
                    if self._pending:
                        return
                    self._pending = True
                    await asyncio.sleep(0.01)
                    self._pending = False
                    await coordinator._async_invalidate_and_refresh_solar()

            coordinator._solar_invalidation_debouncer = _CoalescingDebouncer()

            for index in range(5):
                coordinator._on_solar_forecast_source_state_changed(
                    SimpleNamespace(
                        data={
                            "old_state": SimpleNamespace(
                                state="100",
                                attributes={"wh_period": {"08:00": index}},
                            ),
                            "new_state": SimpleNamespace(
                                state="100",
                                attributes={"wh_period": {"08:00": index + 1}},
                            ),
                        }
                    )
                )
            coordinator._on_solar_bias_changed(SimpleNamespace(data={}))
            await asyncio.sleep(0.05)

            self.assertIsNone(coordinator._cached_solar_forecast)
            coordinator._async_refresh_forecast_and_request_automation.assert_awaited_once_with(
                reason="solar_invalidation"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_solar_source_state_change_ignores_attribute_only_updates(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._schedule_solar_invalidation = Mock()

            coordinator._on_solar_forecast_source_state_changed(
                SimpleNamespace(
                    data={
                        "old_state": SimpleNamespace(
                            state="100",
                            attributes={"wh_period": {"08:00": 1}},
                        ),
                        "new_state": SimpleNamespace(
                            state="100",
                            attributes={"wh_period": {"08:00": 1}},
                        ),
                    }
                )
            )

            coordinator._schedule_solar_invalidation.assert_not_called()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_solar_bias_status_change_event_triggers_refresh(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._cached_solar_forecast = {"status": "available"}
            coordinator._async_refresh_forecast_and_request_automation = AsyncMock()
            coordinator._hass = SimpleNamespace(async_create_task=asyncio.create_task)

            class _ImmediateDebouncer:
                async def async_call(self):
                    await coordinator._async_invalidate_and_refresh_solar()

            coordinator._solar_invalidation_debouncer = _ImmediateDebouncer()
            coordinator._on_solar_bias_changed(
                SimpleNamespace(
                    data={"status": "applied", "effectiveVariant": "adjusted"}
                )
            )
            await asyncio.sleep(0)

            self.assertIsNone(coordinator._cached_solar_forecast)
            coordinator._async_refresh_forecast_and_request_automation.assert_awaited_once_with(
                reason="solar_invalidation"
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_refresh_forecast_persists_canonical_solar_snapshot(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = None
            coordinator._cached_solar_forecast = None
            coordinator._solar_forecast_sensors = []
            coordinator._invalidate_battery_forecast_cache = Mock()
            coordinator._async_refresh_automation_input_bundle = AsyncMock(
                return_value=True
            )
            coordinator._storage = SimpleNamespace(async_save_snapshots=AsyncMock())

            house_snapshot = {"status": "available", "currentSlot": {"timestamp": "2026-05-03T09:45:00+02:00"}}
            solar_snapshot = {
                "status": "available",
                "resolution": "15m",
                "horizonHours": 336,
                "points": [
                    {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1200.0}
                ],
                "rawPoints": [
                    {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1500.0}
                ],
                "generatedAt": "2026-05-03T09:45:00+02:00",
            }

            builder_instance = SimpleNamespace(build=AsyncMock(return_value=house_snapshot))
            coordinator._async_build_canonical_solar_forecast = AsyncMock(
                return_value=solar_snapshot
            )

            with patch.object(
                coordinator_module,
                "ConsumptionForecastBuilder",
                return_value=builder_instance,
            ):
                await coordinator._async_refresh_forecast(reference_time=REFERENCE_TIME)

            self.assertEqual(coordinator._cached_forecast, house_snapshot)
            self.assertEqual(coordinator._cached_solar_forecast, solar_snapshot)
            coordinator._storage.async_save_snapshots.assert_awaited_once_with(
                house_snapshot=house_snapshot,
                solar_snapshot=solar_snapshot,
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_refresh_forecast_republishes_registered_forecast_entities(
        self,
    ) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = None
            coordinator._cached_solar_forecast = None
            coordinator._invalidate_battery_forecast_cache = Mock()
            coordinator._async_refresh_automation_input_bundle = AsyncMock(
                return_value=True
            )
            coordinator._storage = SimpleNamespace(async_save_snapshots=AsyncMock())
            forecast_entity = SimpleNamespace(
                hass=object(),
                entity_id="sensor.helman_energy_production_today",
                async_write_ha_state=Mock(),
            )
            coordinator._solar_forecast_sensors = [forecast_entity]

            builder_instance = SimpleNamespace(
                build=AsyncMock(return_value={"status": "available"})
            )
            coordinator._async_build_canonical_solar_forecast = AsyncMock(
                return_value={"status": "available", "points": [], "rawPoints": []}
            )

            with patch.object(
                coordinator_module,
                "ConsumptionForecastBuilder",
                return_value=builder_instance,
            ):
                await coordinator._async_refresh_forecast(reference_time=REFERENCE_TIME)

            forecast_entity.async_write_ha_state.assert_called_once_with()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_refresh_forecast_skips_unadded_forecast_entities(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = None
            coordinator._cached_solar_forecast = None
            coordinator._invalidate_battery_forecast_cache = Mock()
            coordinator._async_refresh_automation_input_bundle = AsyncMock(
                return_value=True
            )
            coordinator._storage = SimpleNamespace(async_save_snapshots=AsyncMock())
            forecast_entity = SimpleNamespace(
                hass=None,
                entity_id="sensor.helman_energy_production_today",
                async_write_ha_state=Mock(),
            )
            coordinator._solar_forecast_sensors = [forecast_entity]

            builder_instance = SimpleNamespace(
                build=AsyncMock(return_value={"status": "available"})
            )
            coordinator._async_build_canonical_solar_forecast = AsyncMock(
                return_value={"status": "available", "points": [], "rawPoints": []}
            )

            with patch.object(
                coordinator_module,
                "ConsumptionForecastBuilder",
                return_value=builder_instance,
            ):
                await coordinator._async_refresh_forecast(reference_time=REFERENCE_TIME)

            forecast_entity.async_write_ha_state.assert_not_called()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_get_forecast_uses_shared_refresh_path_when_solar_cache_missing(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = {"status": "available"}
            coordinator._cached_solar_forecast = None
            coordinator._storage = SimpleNamespace(config={})
            coordinator._read_house_forecast_config = Mock(
                return_value=("sensor.house_total", 56, 14, "fp")
            )
            coordinator._has_compatible_forecast_snapshot = Mock(return_value=True)
            coordinator._async_refresh_forecast_and_request_automation = AsyncMock()
            coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
                return_value=SimpleNamespace(
                    adjusted_house_forecast={"status": "available"},
                    battery_forecast={"status": "available", "series": []},
                )
            )

            async def _populate_solar_cache(*, reason: str, reference_time=None) -> None:
                coordinator._cached_solar_forecast = {
                    "status": "available",
                    "resolution": "15m",
                    "horizonHours": 336,
                    "points": [
                        {"timestamp": "2026-05-03T10:00:00+02:00", "value": 900.5}
                    ],
                    "rawPoints": [
                        {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}
                    ],
                }

            coordinator._async_refresh_forecast_and_request_automation = AsyncMock(
                side_effect=_populate_solar_cache
            )
            builder_instance = SimpleNamespace(
                build=AsyncMock(
                    return_value={
                        "grid": {
                            "export": {"status": "available", "currentPrice": 2.5},
                            "import": {"status": "available", "currentPrice": 7.0},
                        }
                    }
                )
            )

            with (
                patch.object(
                    coordinator_module,
                    "HelmanForecastBuilder",
                    return_value=builder_instance,
                    create=True,
                ),
                patch.object(
                    coordinator_module,
                    "build_solar_forecast_response",
                    side_effect=lambda snapshot, **kwargs: snapshot,
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
                await coordinator.get_forecast(granularity=60, forecast_days=7)

            coordinator._async_refresh_forecast_and_request_automation.assert_awaited_once()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_get_canonical_solar_forecast_refresh_path_republishes_entities(
        self,
    ) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            forecast_entity = SimpleNamespace(
                hass=object(),
                entity_id="sensor.helman_energy_production_tomorrow",
                async_write_ha_state=Mock(),
            )
            coordinator._cached_solar_forecast = None
            coordinator._solar_forecast_sensors = [forecast_entity]
            coordinator._has_current_slot_solar_forecast = (
                coordinator_module.HelmanCoordinator._has_current_slot_solar_forecast
            )

            async def _refresh(*, reason: str, reference_time=None) -> None:
                coordinator._cached_solar_forecast = {
                    "status": "available",
                    "resolution": "15m",
                    "horizonHours": 336,
                    "generatedAt": REFERENCE_TIME.isoformat(),
                    "points": [
                        {"timestamp": "2026-05-03T10:00:00+02:00", "value": 900.0}
                    ],
                    "rawPoints": [],
                }
                coordinator._publish_solar_forecast_entities()

            coordinator._async_refresh_forecast_and_request_automation = AsyncMock(
                side_effect=_refresh
            )

            result = await coordinator._async_get_canonical_solar_forecast(
                reference_time=REFERENCE_TIME
            )

            self.assertIsNotNone(result)
            forecast_entity.async_write_ha_state.assert_called_once_with()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_get_forecast_uses_cached_corrected_points_without_rebuilding_solar_snapshot(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = {"status": "available"}
            coordinator._cached_solar_forecast = {
                "status": "available",
                "resolution": "15m",
                "horizonHours": 336,
                "generatedAt": REFERENCE_TIME.isoformat(),
                "points": [
                    {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}
                ],
                "rawPoints": [
                    {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}
                ],
                "correctedPoints": [
                    {"timestamp": "2026-05-03T10:00:00+02:00", "value": 900.5}
                ],
                "biasCorrection": {
                    "status": "applied",
                    "effectiveVariant": "adjusted",
                    "explainability": {},
                },
            }
            coordinator._storage = SimpleNamespace(config={})
            coordinator._read_house_forecast_config = Mock(
                return_value=("sensor.house_total", 56, 14, "fp")
            )
            coordinator._has_compatible_forecast_snapshot = Mock(return_value=True)
            coordinator._async_refresh_forecast_and_request_automation = AsyncMock()
            coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
                return_value=SimpleNamespace(
                    adjusted_house_forecast={"status": "available"},
                    battery_forecast={"status": "available", "series": []},
                )
            )

            builder_instance = SimpleNamespace(
                build=AsyncMock(
                    return_value={
                        "grid": {
                            "export": {"status": "available", "currentPrice": 2.5},
                            "import": {"status": "available", "currentPrice": 7.0},
                        }
                    }
                )
            )

            def fake_solar_response(snapshot, **kwargs):
                response = deepcopy(snapshot)
                corrected_points = kwargs.get("corrected_points")
                if corrected_points:
                    response["adjustedPoints"] = deepcopy(corrected_points)
                response.pop("rawPoints", None)
                response.pop("correctedPoints", None)
                return response

            with (
                patch.object(
                    coordinator_module,
                    "HelmanForecastBuilder",
                    return_value=builder_instance,
                    create=True,
                ),
                patch.object(
                    coordinator_module,
                    "build_solar_forecast_response",
                    side_effect=fake_solar_response,
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
                        "exportPriceUnit": None,
                        "currentExportPrice": None,
                        "exportPricePoints": [],
                        "importPriceUnit": None,
                        "currentImportPrice": None,
                        "importPricePoints": [],
                    },
                    create=True,
                ),
            ):
                result = await coordinator.get_forecast(granularity=60, forecast_days=7)

            self.assertEqual(result["solar"]["points"][0]["value"], 1250.25)
            self.assertEqual(result["solar"]["adjustedPoints"][0]["value"], 900.5)
            self.assertEqual(
                result["solar"]["biasCorrection"]["effectiveVariant"],
                "adjusted",
            )
            self.assertNotIn("rawPoints", result["solar"])
            coordinator._async_refresh_forecast_and_request_automation.assert_not_awaited()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_build_canonical_solar_forecast_keeps_raw_points_and_corrected_points_separate(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}

            raw_points = [
                {"timestamp": "2026-05-05T10:00:00+02:00", "value": 1000.0},
            ]
            adjusted_points = [
                {"timestamp": "2026-05-05T10:00:00+02:00", "value": 750.0},
            ]

            builder_instance = SimpleNamespace(
                build=AsyncMock(
                    return_value={
                        "solar": {"status": "available", "points": raw_points}
                    }
                )
            )
            bias_result = SimpleNamespace(
                status="applied",
                effective_variant="adjusted",
                adjusted_points=adjusted_points,
                explainability=None,
            )
            coordinator._solar_bias_service = SimpleNamespace(
                build_adjustment_result=Mock(return_value=bias_result)
            )

            with (
                patch.object(
                    coordinator_module,
                    "HelmanForecastBuilder",
                    return_value=builder_instance,
                    create=True,
                ),
                patch.object(
                    coordinator_module,
                    "build_solar_forecast_response",
                    return_value={"status": "available", "points": raw_points},
                    create=True,
                ),
            ):
                snapshot = await coordinator._async_build_canonical_solar_forecast(
                    reference_time=REFERENCE_TIME
                )

            self.assertEqual(snapshot["points"], raw_points)
            self.assertEqual(snapshot["rawPoints"], raw_points)
            self.assertEqual(snapshot["correctedPoints"], adjusted_points)
            self.assertEqual(snapshot["biasCorrection"]["status"], "applied")
            self.assertEqual(
                snapshot["biasCorrection"]["effectiveVariant"],
                "adjusted",
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)


if __name__ == "__main__":
    unittest.main()
