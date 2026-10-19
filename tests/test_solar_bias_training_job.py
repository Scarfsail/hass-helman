"""Tests for SolarBiasTrainingJob and coordinator callback wiring (issue #579)."""

from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests._fakes import DummyStore, FakeHass, make_coordinator

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)
const = importlib.import_module("custom_components.helman.const")
dt_util = importlib.import_module("homeassistant.util.dt")
solar_bias_mod = importlib.import_module(
    "custom_components.helman.training.solar_bias"
)
SolarBiasTrainingJob = solar_bias_mod.SolarBiasTrainingJob


class SolarBiasTrainingJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.SolarBiasTrainingJob = SolarBiasTrainingJob

    async def test_async_train_success_calls_on_trained_and_returns_outcome(self) -> None:
        service = MagicMock()
        service.async_train = AsyncMock(
            return_value={"lastOutcome": "profile_trained"}
        )
        on_trained = AsyncMock()

        job = self.SolarBiasTrainingJob(service, on_trained=on_trained)
        outcome = await job.async_train()

        self.assertEqual(outcome, "profile_trained")
        service.async_train.assert_awaited_once()
        on_trained.assert_awaited_once()

    async def test_async_train_insufficient_history(self) -> None:
        service = MagicMock()
        service.async_train = AsyncMock(
            return_value={"lastOutcome": "insufficient_history"}
        )
        on_trained = AsyncMock()

        job = self.SolarBiasTrainingJob(service, on_trained=on_trained)
        outcome = await job.async_train()

        self.assertEqual(outcome, "insufficient_history")
        service.async_train.assert_awaited_once()
        on_trained.assert_awaited_once()

    async def test_async_train_disabled_returns_skipped_and_skips_callback(self) -> None:
        service = MagicMock()
        service.async_train = AsyncMock(
            side_effect=service_mod.BiasNotConfiguredError("disabled")
        )
        on_trained = AsyncMock()

        job = self.SolarBiasTrainingJob(service, on_trained=on_trained)
        outcome = await job.async_train()

        self.assertEqual(outcome, "skipped_disabled")
        service.async_train.assert_awaited_once()
        on_trained.assert_not_awaited()

    async def test_async_train_handles_service_caught_failure(self) -> None:
        service = MagicMock()
        service.async_train = AsyncMock(
            return_value={"lastOutcome": "training_failed"}
        )
        on_trained = AsyncMock()

        job = self.SolarBiasTrainingJob(service, on_trained=on_trained)
        outcome = await job.async_train()

        self.assertEqual(outcome, "training_failed")
        service.async_train.assert_awaited_once()
        on_trained.assert_awaited_once()

    async def test_async_train_propagates_unexpected_exception(self) -> None:
        service = MagicMock()
        service.async_train = AsyncMock(side_effect=RuntimeError("disk error"))
        on_trained = AsyncMock()

        job = self.SolarBiasTrainingJob(service, on_trained=on_trained)
        with self.assertRaises(RuntimeError):
            await job.async_train()

        service.async_train.assert_awaited_once()
        on_trained.assert_not_awaited()

    async def test_async_train_without_on_trained_callback(self) -> None:
        service = MagicMock()
        service.async_train = AsyncMock(
            return_value={"lastOutcome": "profile_trained"}
        )

        job = self.SolarBiasTrainingJob(service)
        outcome = await job.async_train()

        self.assertEqual(outcome, "profile_trained")
        service.async_train.assert_awaited_once()


class CoordinatorSolarBiasCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_finished_solar_bias_run_triggers_forecast_refresh_and_data_changed(
        self,
    ) -> None:
        """A finished solar-bias run that changes status triggers exactly one forecast refresh

        and one data_changed{solar_bias} through the callback, with no bus event fired.
        """
        hass = FakeHass()
        coordinator = make_coordinator(_hass=hass)
        store = DummyStore()
        bias_cfg = models.read_bias_config({})
        service = service_mod.SolarBiasCorrectionService(
            hass,
            store,
            bias_cfg,
            on_status_changed=coordinator._on_solar_bias_changed,
        )
        await service.async_setup()
        coordinator._solar_bias_service = service

        refresh_calls: list[str] = []

        async def _fake_run_forecast_refresh(*, reason: str, reference_time=None) -> None:
            refresh_calls.append(reason)
            coordinator._solar_bias_service.build_adjustment_result([], dt_util.now())

        coordinator._async_run_forecast_refresh = _fake_run_forecast_refresh

        job = SolarBiasTrainingJob(
            service,
            on_trained=coordinator._async_on_solar_bias_trained,
        )

        fake_outcome = models.TrainingOutcome(
            profile=models.SolarBiasProfile(factors={"08:00": 1.2}, omitted_slots=[]),
            metadata=models.SolarBiasMetadata(
                trained_at="2026-04-25T03:00:00+02:00",
                training_config_fingerprint=service_mod.compute_fingerprint(bias_cfg),
                usable_days=10,
                dropped_days=[],
                factor_min=1.2,
                factor_max=1.2,
                factor_median=1.2,
                omitted_slot_count=0,
                last_outcome="profile_trained",
                error_reason=None,
            ),
            explainability=None,
        )

        hass.async_add_executor_job = AsyncMock(return_value=fake_outcome)
        with (
            patch.object(service_mod, "load_trainer_samples", AsyncMock(return_value=[])),
            patch.object(service_mod, "load_actuals_window", AsyncMock(return_value=[])),
        ):
            outcome = await job.async_train()

        await asyncio.sleep(0)

        self.assertEqual(outcome, "profile_trained")
        self.assertEqual(refresh_calls, ["solar_bias_trained"])
        self.assertEqual(
            hass.bus.fired,
            [(const.EVENT_DATA_CHANGED, {"kind": "solar_bias"})],
        )
        # Ensure no HA bus events for solar bias were fired
        for event_name, _ in hass.bus.fired:
            self.assertNotIn("helman_solar_bias", event_name)

    async def test_startup_build_does_not_trigger_spurious_status_changed(
        self,
    ) -> None:
        """Startup async_setup initialises status so the first forecast build

        does not trigger a spurious on_status_changed.
        """
        hass = FakeHass()
        bias_cfg = models.read_bias_config({})
        store = DummyStore()
        store.profile = {
            "profile": {"factors": {"08:00": 1.2}, "omitted_slots": []},
            "metadata": {
                "trained_at": "2026-04-25T03:00:00+02:00",
                "training_config_fingerprint": service_mod.compute_fingerprint(bias_cfg),
                "usable_days": 10,
                "dropped_days": [],
                "factor_min": 1.2,
                "factor_max": 1.2,
                "factor_median": 1.2,
                "omitted_slot_count": 0,
                "last_outcome": "profile_trained",
                "error_reason": None,
            },
        }
        on_status_changed = MagicMock()
        service = service_mod.SolarBiasCorrectionService(
            hass,
            store,
            bias_cfg,
            on_status_changed=on_status_changed,
        )
        await service.async_setup()

        service.build_adjustment_result([], dt_util.now())

        on_status_changed.assert_not_called()

    async def test_status_changed_triggers_forecast_refresh_and_data_changed(
        self,
    ) -> None:
        """An adjustment-status change triggers the same through on_status_changed."""
        hass = FakeHass()
        coordinator = make_coordinator(_hass=hass)
        coordinator._async_refresh_forecast = AsyncMock()

        coordinator._on_solar_bias_changed()
        await asyncio.sleep(0)

        coordinator._async_refresh_forecast.assert_awaited_once_with(
            reason="solar_bias_changed"
        )
        self.assertEqual(
            hass.bus.fired,
            [(const.EVENT_DATA_CHANGED, {"kind": "solar_bias"})],
        )
        for event_name, _ in hass.bus.fired:
            self.assertNotIn("helman_solar_bias", event_name)

    async def test_on_solar_bias_trained_noop_when_coordinator_unloaded(self) -> None:
        """An unloaded coordinator does not refresh and fires no data_changed."""
        hass = FakeHass()
        coordinator = make_coordinator(_hass=hass)
        coordinator._unloaded = True
        coordinator._async_refresh_forecast = AsyncMock()

        await coordinator._async_on_solar_bias_trained()

        coordinator._async_refresh_forecast.assert_not_awaited()
        self.assertEqual(hass.bus.fired, [])

    async def test_async_reload_training_artifacts_reloads_solar_bias_service(
        self,
    ) -> None:
        """async_reload_training_artifacts makes the solar bias service reload its store."""
        hass = FakeHass()
        coordinator = make_coordinator(_hass=hass)
        store = DummyStore()
        bias_cfg = models.read_bias_config({})
        service = service_mod.SolarBiasCorrectionService(
            hass,
            store,
            bias_cfg,
            on_status_changed=coordinator._on_solar_bias_changed,
        )
        coordinator._solar_bias_service = service
        # The training artifacts are reloaded too; nothing is stored for them.
        coordinator.training.store._store = DummyStore()
        call_order: list[str] = []

        async def _record_refresh(**_kwargs) -> None:
            call_order.append(f"refresh:{len(hass.bus.fired)}")

        coordinator._async_refresh_forecast = AsyncMock(side_effect=_record_refresh)

        self.assertIsNone(service._profile)

        store.profile = {
            "profile": {"factors": {"10:00": 1.25}, "omitted_slots": []},
            "metadata": {
                "trained_at": "2026-04-25T03:00:00+02:00",
                "training_config_fingerprint": service_mod.compute_fingerprint(bias_cfg),
                "usable_days": 10,
                "dropped_days": [],
                "factor_min": 1.25,
                "factor_max": 1.25,
                "factor_median": 1.25,
                "omitted_slot_count": 0,
                "last_outcome": "profile_trained",
                "error_reason": None,
            },
        }

        await coordinator.async_reload_training_artifacts()

        self.assertIsNotNone(service._profile)
        self.assertEqual(service._profile.factors, {"10:00": 1.25})
        self.assertEqual(service._metadata.last_outcome, "profile_trained")
        coordinator._async_refresh_forecast.assert_awaited_once_with(
            reason="training_artifacts_reloaded"
        )
        # data_changed fires only after the forecast refresh completed.
        self.assertEqual(call_order, ["refresh:0"])
        self.assertEqual(
            hass.bus.fired,
            [(const.EVENT_DATA_CHANGED, {"kind": "solar_bias"})],
        )

