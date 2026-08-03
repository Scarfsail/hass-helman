from __future__ import annotations

import importlib
import asyncio
import sys
import unittest
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from test_solar_bias_response import (
    REFERENCE_TIME,
    _install_coordinator_import_stubs,
    _restore_modules,
)


def _make_matching_house_snapshot(
    coordinator_module,
    *,
    config_fingerprint: str,
) -> dict:
    """A house snapshot that passes _has_matching_forecast_snapshot."""
    return {
        "status": "available",
        "generatedAt": REFERENCE_TIME.isoformat(),
        "model": coordinator_module.HOUSE_FORECAST_MODEL_ID,
        "actualHistory": [],
        "trainingWindowDays": 56,
        "requiredHistoryDays": 14,
        "configFingerprint": config_fingerprint,
        "sourceGranularityMinutes": (
            coordinator_module.FORECAST_CANONICAL_GRANULARITY_MINUTES
        ),
        "forecastDaysAvailable": coordinator_module.MAX_FORECAST_DAYS,
        "alignmentPaddingSlots": (
            coordinator_module.ConsumptionForecastBuilder._MAX_ALIGNMENT_PADDING_SLOTS
        ),
    }


def _make_refresh_only_coordinator(coordinator_module):
    """A coordinator carrying just the bookkeeping the refresh guard needs."""
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._create_task = asyncio.create_task
    coordinator._refresh_tasks = set()
    coordinator._forecast_refresh_task = None
    return coordinator


@contextmanager
def _patched_forecast_response_builders(coordinator_module):
    """Stand in for every response builder get_forecast calls.

    The payload shaping is covered by the response-builder tests; here only
    what get_forecast itself decides is under test.
    """
    with ExitStack() as stack:
        for name, kwargs in (
            (
                "GridPriceForecastBuilder",
                {
                    "return_value": SimpleNamespace(
                        build=Mock(
                            return_value={
                                "export": {
                                    "status": "available",
                                    "currentPrice": 2.5,
                                },
                                "import": {
                                    "status": "available",
                                    "currentPrice": 7.0,
                                },
                            }
                        )
                    )
                },
            ),
            (
                "build_solar_forecast_response",
                {"side_effect": lambda snapshot, **kwargs: deepcopy(snapshot)},
            ),
            (
                "build_house_forecast_response",
                {"side_effect": lambda snapshot, **kwargs: {"kind": "house"}},
            ),
            ("build_battery_forecast_response", {"return_value": {"kind": "battery"}}),
            ("build_grid_flow_forecast_snapshot", {"return_value": {"kind": "grid"}}),
            (
                "build_grid_flow_forecast_response",
                {"return_value": {"kind": "grid-flow"}},
            ),
            (
                "build_grid_price_forecast_response",
                {
                    "return_value": {
                        "exportPriceUnit": "CZK/kWh",
                        "currentExportPrice": 2.5,
                        "exportPricePoints": [],
                        "importPriceUnit": "CZK/kWh",
                        "currentImportPrice": 7.0,
                        "importPricePoints": [],
                    }
                },
            ),
        ):
            stack.enter_context(
                patch.object(coordinator_module, name, create=True, **kwargs)
            )
        yield


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
            # Restore the module table, but let the failure speak: swallowing it
            # here turns a missing stub into a baffling unpack error in every
            # caller.
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)
            raise

    async def test_refresh_forecast_persists_canonical_solar_snapshot(self) -> None:
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = None
            coordinator._house_profile = None
            coordinator._house_profile_trained_at = None
            coordinator._house_profile_last_outcome = "no_training_yet"
            coordinator._slot_history = None
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
            coordinator._build_canonical_solar_forecast = Mock(
                return_value=solar_snapshot
            )
            raw_forecast_builder = SimpleNamespace(
                build=AsyncMock(return_value={"solar": {}, "grid": {}})
            )

            with (
                patch.object(
                    coordinator_module,
                    "ConsumptionForecastBuilder",
                    return_value=builder_instance,
                ),
                patch.object(
                    coordinator_module,
                    "HelmanForecastBuilder",
                    return_value=raw_forecast_builder,
                ),
            ):
                await coordinator._async_build_forecast_snapshots(
                    reference_time=REFERENCE_TIME
                )

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
            coordinator._house_profile = None
            coordinator._house_profile_trained_at = None
            coordinator._house_profile_last_outcome = "no_training_yet"
            coordinator._slot_history = None
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
            coordinator._build_canonical_solar_forecast = Mock(
                return_value={"status": "available", "points": [], "rawPoints": []}
            )
            raw_forecast_builder = SimpleNamespace(
                build=AsyncMock(return_value={"solar": {}, "grid": {}})
            )

            with (
                patch.object(
                    coordinator_module,
                    "ConsumptionForecastBuilder",
                    return_value=builder_instance,
                ),
                patch.object(
                    coordinator_module,
                    "HelmanForecastBuilder",
                    return_value=raw_forecast_builder,
                ),
            ):
                await coordinator._async_build_forecast_snapshots(
                    reference_time=REFERENCE_TIME
                )

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
            coordinator._house_profile = None
            coordinator._house_profile_trained_at = None
            coordinator._house_profile_last_outcome = "no_training_yet"
            coordinator._slot_history = None
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
            coordinator._build_canonical_solar_forecast = Mock(
                return_value={"status": "available", "points": [], "rawPoints": []}
            )
            raw_forecast_builder = SimpleNamespace(
                build=AsyncMock(return_value={"solar": {}, "grid": {}})
            )

            with (
                patch.object(
                    coordinator_module,
                    "ConsumptionForecastBuilder",
                    return_value=builder_instance,
                ),
                patch.object(
                    coordinator_module,
                    "HelmanForecastBuilder",
                    return_value=raw_forecast_builder,
                ),
            ):
                await coordinator._async_build_forecast_snapshots(
                    reference_time=REFERENCE_TIME
                )

            forecast_entity.async_write_ha_state.assert_not_called()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_get_forecast_serves_previous_slot_snapshots_without_rebuilding(
        self,
    ) -> None:
        """A read never rebuilds, however old either cached snapshot is.

        The whole point of P1: opening a card in a new 15-minute slot used to
        run the 56-day recorder scan inline, on either the solar or the house
        path.
        """
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            # Both snapshots are from the slot before the one `REFERENCE_TIME`
            # (21:16) falls in.
            previous_slot_at = "2026-03-20T21:00:00+01:00"
            coordinator._cached_forecast = {
                "status": "available",
                "generatedAt": previous_slot_at,
                "currentSlot": {"timestamp": previous_slot_at},
            }
            coordinator._cached_solar_forecast = {
                "status": "available",
                "generatedAt": previous_slot_at,
                "points": [{"timestamp": previous_slot_at, "value": 900.5}],
                "rawPoints": [{"timestamp": previous_slot_at, "value": 1250.25}],
            }
            coordinator._storage = SimpleNamespace(config={})
            coordinator._read_house_forecast_config = Mock(
                return_value=("sensor.house_total", 56, 14, "fp")
            )
            coordinator._has_matching_forecast_snapshot = Mock(return_value=True)
            coordinator._invalidate_battery_forecast_cache = Mock()
            coordinator._async_refresh_forecast = AsyncMock()
            coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
                return_value=SimpleNamespace(
                    adjusted_house_forecast={"status": "available"},
                    battery_forecast={"status": "available", "series": []},
                )
            )

            with _patched_forecast_response_builders(coordinator_module):
                result = await coordinator.get_forecast(
                    granularity=60, forecast_days=7
                )

            coordinator._async_refresh_forecast.assert_not_awaited()
            self.assertEqual(result["solar"]["points"][0]["value"], 900.5)
            self.assertIs(coordinator._cached_forecast["status"], "available")
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_get_forecast_blanks_house_snapshot_when_fingerprint_changed(
        self,
    ) -> None:
        """A config change is not staleness: the old answer must not be served."""
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = object.__new__(coordinator_module.HelmanCoordinator)
            coordinator._hass = SimpleNamespace()
            coordinator._active_config = {}
            coordinator._cached_forecast = _make_matching_house_snapshot(
                coordinator_module,
                config_fingerprint="stale-fingerprint",
            )
            coordinator._cached_solar_forecast = None
            coordinator._storage = SimpleNamespace(config={})
            coordinator._house_profile = None
            coordinator._house_profile_trained_at = None
            coordinator._house_profile_last_outcome = "no_training_yet"
            coordinator._slot_history = None
            coordinator._read_house_forecast_config = Mock(
                return_value=("sensor.house_total", 56, 14, "new-fingerprint")
            )
            coordinator._invalidate_battery_forecast_cache = Mock()
            coordinator._async_refresh_forecast = AsyncMock()
            coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
                return_value=SimpleNamespace(
                    adjusted_house_forecast={"status": "unavailable"},
                    battery_forecast={"status": "unavailable", "series": []},
                )
            )

            with _patched_forecast_response_builders(coordinator_module):
                result = await coordinator.get_forecast(granularity=60, forecast_days=7)

            # No solar snapshot at all is "never built", not "stale": the
            # unavailable status already says so, and a banner on top of it
            # would fire on every card in the seconds after a restart.
            self.assertIs(result["solar"]["staleness"]["isStale"], False)
            self.assertIsNone(coordinator._cached_forecast)
            coordinator._invalidate_battery_forecast_cache.assert_called_once_with()
            house_forecast = (
                coordinator._async_get_appliance_forecast_pipeline.await_args.kwargs[
                    "house_forecast"
                ]
            )
            self.assertEqual(house_forecast["status"], "unavailable")

            # ...and the next refresh (a config save reloads the entry, which
            # runs the startup refresh) puts a matching snapshot back.
            rebuilt = _make_matching_house_snapshot(
                coordinator_module,
                config_fingerprint="new-fingerprint",
            )

            async def _rebuild(*, reason: str, reference_time=None) -> None:
                coordinator._cached_forecast = rebuilt

            coordinator._async_refresh_forecast = AsyncMock(side_effect=_rebuild)
            await coordinator._async_refresh_forecast(reason="startup")

            self.assertIs(
                await coordinator._async_get_canonical_house_forecast(
                    reference_time=REFERENCE_TIME
                ),
                rebuilt,
            )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_get_forecast_reports_staleness_for_both_halves(self) -> None:
        """The banner's data: under an hour is healthy, past it is a fault."""
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            for age_minutes, expected_stale in ((30, False), (61, True)):
                with self.subTest(age_minutes=age_minutes):
                    generated_at = (
                        REFERENCE_TIME - timedelta(minutes=age_minutes)
                    ).isoformat()
                    coordinator = object.__new__(
                        coordinator_module.HelmanCoordinator
                    )
                    coordinator._hass = SimpleNamespace()
                    coordinator._active_config = {}
                    coordinator._cached_forecast = {
                        "status": "available",
                        "generatedAt": generated_at,
                    }
                    coordinator._cached_solar_forecast = {
                        "status": "available",
                        "generatedAt": generated_at,
                        "points": [],
                        "rawPoints": [],
                    }
                    coordinator._storage = SimpleNamespace(config={})
                    coordinator._read_house_forecast_config = Mock(
                        return_value=("sensor.house_total", 56, 14, "fp")
                    )
                    coordinator._has_matching_forecast_snapshot = Mock(
                        return_value=True
                    )
                    coordinator._invalidate_battery_forecast_cache = Mock()
                    coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
                        return_value=SimpleNamespace(
                            adjusted_house_forecast={"status": "available"},
                            battery_forecast={"status": "available", "series": []},
                        )
                    )

                    with _patched_forecast_response_builders(coordinator_module):
                        result = await coordinator.get_forecast(
                            granularity=60, forecast_days=7
                        )

                    for half in ("solar", "house_consumption"):
                        staleness = result[half]["staleness"]
                        self.assertEqual(staleness["generatedAt"], generated_at)
                        self.assertIs(staleness["isStale"], expected_stale)
                        self.assertEqual(
                            staleness["reason"],
                            "stale_forecast" if expected_stale else None,
                        )
                        self.assertEqual(
                            staleness["hint"] is None, not expected_stale
                        )
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_second_trigger_joins_the_refresh_already_in_flight(self) -> None:
        """A bias event landing on a quarter hour must not double the work."""
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = _make_refresh_only_coordinator(coordinator_module)
            started = asyncio.Event()
            release = asyncio.Event()

            async def _slow_refresh(*, reason: str, reference_time=None) -> None:
                started.set()
                await release.wait()

            coordinator._async_run_forecast_refresh = AsyncMock(
                side_effect=_slow_refresh
            )

            first = asyncio.create_task(
                coordinator._async_refresh_forecast(reason="slot_refresh")
            )
            await started.wait()
            second = asyncio.create_task(
                coordinator._async_refresh_forecast(reason="solar_bias_changed")
            )
            await asyncio.sleep(0)
            release.set()
            await asyncio.gather(first, second)

            coordinator._async_run_forecast_refresh.assert_awaited_once()
            self.assertIsNone(coordinator._forecast_refresh_task)
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_joining_caller_survives_a_failing_refresh(self) -> None:
        """The joiner does not adopt the in-flight run's failure."""
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = _make_refresh_only_coordinator(coordinator_module)
            started = asyncio.Event()

            async def _failing_refresh(*, reason: str, reference_time=None) -> None:
                started.set()
                await asyncio.sleep(0)
                raise RuntimeError("recorder unavailable")

            coordinator._async_run_forecast_refresh = AsyncMock(
                side_effect=_failing_refresh
            )

            first = asyncio.create_task(
                coordinator._async_refresh_forecast(reason="slot_refresh")
            )
            await started.wait()
            await coordinator._async_refresh_forecast(reason="solar_bias_changed")

            with self.assertRaises(RuntimeError):
                await first
            coordinator._async_run_forecast_refresh.assert_awaited_once()
        finally:
            _restore_modules(previous_modules)
            sys.modules.pop("custom_components.helman.coordinator", None)

    async def test_solar_bias_event_rebuilds_immediately(self) -> None:
        """No 30 s debounce any more: a trained profile applies at once."""
        coordinator_module, previous_modules = self._load_coordinator_module()
        try:
            coordinator = _make_refresh_only_coordinator(coordinator_module)
            coordinator._async_refresh_forecast = AsyncMock()

            coordinator._on_solar_bias_changed(
                SimpleNamespace(
                    data={"status": "applied", "effectiveVariant": "adjusted"}
                )
            )
            await asyncio.sleep(0)

            coordinator._async_refresh_forecast.assert_awaited_once_with(
                reason="solar_bias_changed"
            )
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
            coordinator._house_profile = None
            coordinator._house_profile_trained_at = None
            coordinator._house_profile_last_outcome = "no_training_yet"
            coordinator._slot_history = None
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
                build=Mock(
                    return_value={
                        "export": {"status": "available", "currentPrice": 2.5},
                        "import": {"status": "available", "currentPrice": 7.0},
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
                    "GridPriceForecastBuilder",
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

            bias_result = SimpleNamespace(
                status="applied",
                effective_variant="adjusted",
                adjusted_points=adjusted_points,
                explainability=None,
            )
            coordinator._solar_bias_service = SimpleNamespace(
                build_adjustment_result=Mock(return_value=bias_result)
            )

            with patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value={"status": "available", "points": raw_points},
                create=True,
            ):
                snapshot = coordinator._build_canonical_solar_forecast(
                    {"status": "available", "points": raw_points},
                    reference_time=REFERENCE_TIME,
                )

            self.assertEqual(snapshot["points"], raw_points)
            self.assertEqual(snapshot["rawPoints"], raw_points)
            # rawPoints must survive anything a consumer does to the live points.
            self.assertIsNot(snapshot["rawPoints"], snapshot["points"])
            self.assertIsNot(snapshot["rawPoints"][0], snapshot["points"][0])
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
