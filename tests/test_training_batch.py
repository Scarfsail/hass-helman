from __future__ import annotations

import asyncio
import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-08-02T03:00:00+02:00")


def _install_package_stubs() -> None:
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


_install_package_stubs()

batch_module = importlib.import_module("custom_components.helman.training.batch")
house_module = importlib.import_module(
    "custom_components.helman.training.house_consumption"
)
service_module = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
profiles_module = importlib.import_module(
    "custom_components.helman.consumption_forecast_profiles"
)


class _FakeStore:
    """Only the two writes the job makes, with the preserve rule kept honest."""

    def __init__(self) -> None:
        self.section: dict | None = None
        self.writes: list[str] = []

    @property
    def house_consumption(self) -> dict | None:
        return self.section

    async def async_record_house_consumption(
        self, *, data, fingerprint, trained_at, last_outcome
    ) -> None:
        self.section = {
            "data": data,
            "fingerprint": fingerprint,
            "trained_at": trained_at,
            "last_outcome": last_outcome,
            "error_reason": None,
        }
        self.writes.append(last_outcome)

    async def async_record_house_consumption_failure(
        self, *, last_outcome, error_reason
    ) -> None:
        previous = self.section or {}
        self.section = {
            **{key: previous.get(key) for key in ("data", "fingerprint", "trained_at")},
            "last_outcome": last_outcome,
            "error_reason": error_reason,
        }
        self.writes.append(last_outcome)


def _make_request(**overrides):
    defaults = {
        "total_energy_entity_id": "sensor.house_total",
        "training_window_days": 56,
        "min_history_days": 14,
        "consumers_config": [],
        "config_fingerprint": "fp-1",
    }
    return house_module.HouseTrainingRequest(**{**defaults, **overrides})


def _make_hass(*, known_entities=("sensor.house_total",)):
    async def _executor_job(func, *args):
        return func(*args)

    return SimpleNamespace(
        states=SimpleNamespace(
            get=lambda entity_id: object() if entity_id in known_entities else None
        ),
        async_add_executor_job=_executor_job,
        async_create_task=asyncio.ensure_future,
    )


class HouseConsumptionTrainingJobTests(unittest.IsolatedAsyncioTestCase):
    def _make_job(self, *, store, hass=None, request=None, rows=None, error=None):
        job = house_module.HouseConsumptionTrainingJob(
            hass or _make_hass(),
            store,
            read_request=lambda: request or _make_request(),
            on_trained=self._record_trained,
        )
        self.trained_calls = 0

        async def _query(entity_id, window, *, reference_time):
            if error is not None:
                raise error
            return rows or []

        job._async_query_hourly_history = _query
        return job

    async def _record_trained(self) -> None:
        self.trained_calls += 1

    async def test_a_fitted_profile_is_stored_with_its_fingerprint(self) -> None:
        store = _FakeStore()
        # 20 days of hourly rows: comfortably past the 14-day minimum.
        oldest = datetime.now(timezone.utc) - timedelta(days=20)
        rows = [
            {
                "start": (oldest + timedelta(hours=hour)).timestamp(),
                "change": 1.0,
            }
            for hour in range(20 * 24)
        ]
        job = self._make_job(store=store, rows=rows)

        outcome = await job.async_train()

        self.assertEqual(outcome, "profile_trained")
        self.assertEqual(store.section["fingerprint"], "fp-1")
        self.assertIsNotNone(
            profiles_module.profile_from_dict(store.section["data"]),
            "what is stored must be readable back as a profile",
        )
        self.assertEqual(self.trained_calls, 1)

    async def test_a_short_window_is_stored_as_insufficient_history(self) -> None:
        """Stored, not discarded: the payload's history_days is what lets the
        card say how short the history is rather than just "unavailable"."""
        store = _FakeStore()
        today = datetime.now(timezone.utc)
        rows = [
            {"start": (today + timedelta(hours=hour)).timestamp(), "change": 1.0}
            for hour in range(24)
        ]
        job = self._make_job(store=store, rows=rows)

        outcome = await job.async_train()

        self.assertEqual(outcome, "insufficient_history")
        self.assertIsNotNone(store.section["data"])

    async def test_a_missing_entity_is_reported_as_such(self) -> None:
        store = _FakeStore()
        job = self._make_job(
            store=store,
            hass=_make_hass(known_entities=()),
        )

        outcome = await job.async_train()

        self.assertEqual(outcome, "entity_missing")
        self.assertEqual(store.section["error_reason"], "sensor.house_total")

    async def test_an_unconfigured_entity_is_reported_as_not_configured(self) -> None:
        store = _FakeStore()
        job = self._make_job(
            store=store,
            request=_make_request(total_energy_entity_id=None),
        )

        self.assertEqual(await job.async_train(), "not_configured")

    async def test_a_failed_refit_keeps_the_previous_profile(self) -> None:
        store = _FakeStore()
        store.section = {
            "data": {"schema_version": 1},
            "fingerprint": "fp-1",
            "trained_at": "2026-07-30T03:00:00+02:00",
            "last_outcome": "profile_trained",
            "error_reason": None,
        }
        job = self._make_job(store=store, error=RuntimeError("recorder is down"))

        with self.assertLogs(house_module._LOGGER, level="ERROR"):
            outcome = await job.async_train()

        self.assertEqual(outcome, "training_failed")
        self.assertEqual(store.section["data"], {"schema_version": 1})
        self.assertEqual(store.section["trained_at"], "2026-07-30T03:00:00+02:00")
        self.assertEqual(store.section["error_reason"], "recorder is down")
        # Still announced: the coordinator has to pick the failure up to put
        # the banner on the card.
        self.assertEqual(self.trained_calls, 1)


class _FakeBiasService:
    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error
        self.calls = 0
        self.started_at: int | None = None
        self.finished_at: int | None = None

    async def async_train(self):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return {}


class TrainingBatchTests(unittest.IsolatedAsyncioTestCase):
    def _make_batch(self, *, bias_service, house_job):
        return batch_module.TrainingBatch(
            _make_hass(),
            solar_bias_service=bias_service,
            house_consumption_job=house_job,
        )

    def _make_recording_house_job(self, order, *, error=None):
        class _Job:
            async def async_train(self_inner):
                order.append("house_start")
                await asyncio.sleep(0)
                order.append("house_end")
                if error is not None:
                    raise error
                return "profile_trained"

        return _Job()

    async def test_subjobs_run_sequentially(self) -> None:
        """Never gathered: both read the recorder on the same executor thread."""
        order: list[str] = []

        class _BiasService:
            async def async_train(self_inner):
                order.append("bias_start")
                await asyncio.sleep(0)
                order.append("bias_end")
                return {}

        batch = self._make_batch(
            bias_service=_BiasService(),
            house_job=self._make_recording_house_job(order),
        )

        await batch.async_run(reason="test")

        self.assertEqual(
            order, ["bias_start", "bias_end", "house_start", "house_end"]
        )

    async def test_a_failing_subjob_does_not_stop_the_next_one(self) -> None:
        order: list[str] = []
        bias_service = _FakeBiasService(error=RuntimeError("bias blew up"))
        batch = self._make_batch(
            bias_service=bias_service,
            house_job=self._make_recording_house_job(order),
        )

        with self.assertLogs(batch_module._LOGGER, level="ERROR"):
            await batch.async_run(reason="test")

        self.assertEqual(order, ["house_start", "house_end"])
        self.assertEqual(
            batch.last_outcomes,
            {"solar_bias": "training_failed", "house_consumption": "profile_trained"},
        )

    async def test_bias_disabled_still_fits_the_house_profile(self) -> None:
        order: list[str] = []
        bias_service = _FakeBiasService(
            error=service_module.BiasNotConfiguredError("disabled")
        )
        batch = self._make_batch(
            bias_service=bias_service,
            house_job=self._make_recording_house_job(order),
        )

        await batch.async_run(reason="test")

        self.assertEqual(order, ["house_start", "house_end"])
        self.assertEqual(batch.last_outcomes["solar_bias"], "skipped_disabled")

    async def test_a_manual_bias_train_in_progress_is_a_skip_not_a_failure(
        self,
    ) -> None:
        """`helman/train_solar_bias_now` bypasses the batch lock."""
        bias_service = _FakeBiasService(
            error=service_module.TrainingInProgressError("already running")
        )
        batch = self._make_batch(
            bias_service=bias_service,
            house_job=self._make_recording_house_job([]),
        )

        await batch.async_run(reason="test")

        self.assertEqual(batch.last_outcomes["solar_bias"], "skipped_in_progress")

    async def test_a_second_trigger_joins_the_run_in_flight(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        bias_service = _FakeBiasService()

        class _SlowJob:
            calls = 0

            async def async_train(self_inner):
                self_inner.calls += 1
                started.set()
                await release.wait()
                return "profile_trained"

        house_job = _SlowJob()
        batch = self._make_batch(bias_service=bias_service, house_job=house_job)

        first = asyncio.ensure_future(batch.async_run(reason="scheduled"))
        await started.wait()
        second = asyncio.ensure_future(
            batch.async_run_house_consumption(reason="startup")
        )
        await asyncio.sleep(0)
        release.set()
        await asyncio.gather(first, second)

        self.assertEqual(house_job.calls, 1)
        self.assertEqual(bias_service.calls, 1)

    async def test_house_only_run_leaves_the_bias_job_alone(self) -> None:
        """Startup and config-save refits want the profile, not a bias
        re-train: the bias fingerprint is untouched by a forecast config
        change."""
        order: list[str] = []
        bias_service = _FakeBiasService()
        batch = self._make_batch(
            bias_service=bias_service,
            house_job=self._make_recording_house_job(order),
        )

        await batch.async_run_house_consumption(reason="startup")

        self.assertEqual(order, ["house_start", "house_end"])
        self.assertEqual(bias_service.calls, 0)

    def test_schedule_rejects_an_impossible_time(self) -> None:
        batch = self._make_batch(
            bias_service=_FakeBiasService(),
            house_job=self._make_recording_house_job([]),
        )

        with self.assertRaises(ValueError):
            batch.schedule("25:00")

    def test_schedule_registers_a_sync_callback(self) -> None:
        captured: dict[str, object] = {}

        def _track_time_change(hass, callback, **kwargs):
            captured["callback"] = callback
            captured["kwargs"] = kwargs
            return lambda: None

        created: list = []
        batch = batch_module.TrainingBatch(
            SimpleNamespace(async_create_task=created.append),
            solar_bias_service=_FakeBiasService(),
            house_consumption_job=self._make_recording_house_job([]),
        )
        original = batch_module.async_track_time_change
        batch_module.async_track_time_change = _track_time_change
        try:
            batch.schedule("03:15")
        finally:
            batch_module.async_track_time_change = original

        self.assertEqual(captured["kwargs"], {"hour": 3, "minute": 15, "second": 0})
        captured["callback"](None)
        self.assertEqual(len(created), 1)
        created[0].close()


if __name__ == "__main__":
    unittest.main()
