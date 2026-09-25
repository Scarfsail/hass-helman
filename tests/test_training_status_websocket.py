"""``helman/training/status`` and ``helman/training/train_now``.

Runs against the real coordinator assembler, the real training store and the
real bias service -- the point is that the status reads the record honestly,
so faking the record would test nothing.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

coordinator_module = importlib.import_module("custom_components.helman.coordinator")
training_ws = importlib.import_module("custom_components.helman.training.websocket")
batch_module = importlib.import_module("custom_components.helman.training.batch")
house_module = importlib.import_module(
    "custom_components.helman.training.house_consumption"
)
appliance_module = importlib.import_module(
    "custom_components.helman.training.appliance_energy"
)
service_module = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module("custom_components.helman.solar_bias_correction.models")
storage_module = importlib.import_module("custom_components.helman.storage")
const = importlib.import_module("custom_components.helman.const")

TRAINED_AT = "2026-08-01T03:00:00+02:00"
HOUSE_FP = "house-fp"
APPLIANCE_FP = "appliance-fp"


class FakeConnection:
    def __init__(self, *, is_admin: bool = True) -> None:
        self.user = SimpleNamespace(is_admin=is_admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class _MemoryBackend:
    data = None

    async def async_load(self):
        return self.data

    async def async_save(self, data) -> None:
        self.data = data


def _make_store(**sections) -> storage_module.TrainingArtifactsStore:
    """The real store over an in-memory backend, seeded with ``sections``."""
    store = object.__new__(storage_module.TrainingArtifactsStore)
    store._store = _MemoryBackend()
    store._document = {"version": 1, **sections}
    return store


def _section(last_outcome: str, **overrides) -> dict:
    return {
        "data": {"schema_version": 1},
        "fingerprint": HOUSE_FP,
        "trained_at": TRAINED_AT,
        "last_attempt_at": TRAINED_AT,
        "last_outcome": last_outcome,
        "error_reason": None,
        **overrides,
    }


def _bias_cfg(*, enabled: bool = True) -> models.BiasConfig:
    return models.BiasConfig(
        enabled=enabled,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        daily_energy_entity_ids=["sensor.pv_today"],
        total_energy_entity_id="sensor.pv_total",
    )


def _bias_metadata(last_outcome: str, **overrides) -> models.SolarBiasMetadata:
    return models.SolarBiasMetadata(
        **{
            "trained_at": TRAINED_AT,
            "training_config_fingerprint": service_module.compute_fingerprint(
                _bias_cfg()
            ),
            "usable_days": 12,
            "dropped_days": [],
            "factor_min": 1.1,
            "factor_max": 1.1,
            "factor_median": 1.1,
            "omitted_slot_count": 0,
            "last_outcome": last_outcome,
            "last_attempt_at": TRAINED_AT,
            **overrides,
        }
    )


class _BiasStore:
    profile = None

    async def async_save(self, payload) -> None:
        self.profile = payload


def _make_bias_service(*, enabled: bool = True, metadata=None, profile=None):
    async def _executor_job(func, *args):
        return func(*args)

    service = service_module.SolarBiasCorrectionService(
        SimpleNamespace(
            bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None),
            async_add_executor_job=_executor_job,
        ),
        _BiasStore(),
        _bias_cfg(enabled=enabled),
    )
    if metadata is not None:
        service._metadata = metadata
    service._profile = profile
    return service


def _bias_profile() -> models.SolarBiasProfile:
    return models.SolarBiasProfile(factors={"12:00": 1.1}, omitted_slots=[])


class _StubJob:
    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        self.calls = 0

    async def async_train(self) -> str:
        self.calls += 1
        return self.outcome


def _make_coordinator(
    *,
    store=None,
    bias_service=None,
    house_job=None,
    appliance_job=None,
    house_profile=None,
    appliance_estimates=None,
):
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._solar_bias_service = bias_service or _make_bias_service()
    coordinator._training_artifacts_store = store or _make_store()
    coordinator._house_profile = house_profile
    coordinator._appliance_energy_estimates = appliance_estimates or {}
    coordinator._read_house_training_request = lambda: SimpleNamespace(
        config_fingerprint=HOUSE_FP
    )
    coordinator._read_appliance_energy_training_request = lambda: SimpleNamespace(
        fingerprint=APPLIANCE_FP
    )
    coordinator._training_batch = batch_module.TrainingBatch(
        SimpleNamespace(async_create_task=asyncio.ensure_future),
        solar_bias_service=coordinator._solar_bias_service,
        house_consumption_job=house_job or _StubJob("profile_trained"),
        appliance_energy_job=appliance_job or _StubJob("estimates_trained"),
    )
    return coordinator


def _hass(coordinator) -> SimpleNamespace:
    return SimpleNamespace(data={const.DOMAIN: {"coordinator": coordinator}})


def _status(coordinator, *, is_admin: bool = True):
    connection = FakeConnection(is_admin=is_admin)
    training_ws.ws_get_training_status(
        _hass(coordinator), connection, {"id": 1, "type": "helman/training/status"}
    )
    return connection


def _job(payload: dict, job_id: str) -> dict:
    return next(job for job in payload["jobs"] if job["id"] == job_id)


async def _train_now(coordinator, *, job=None, is_admin: bool = True):
    connection = FakeConnection(is_admin=is_admin)
    msg = {"id": 1, "type": "helman/training/train_now"}
    if job is not None:
        msg["job"] = job
    await training_ws.ws_train_now.__wrapped__(_hass(coordinator), connection, msg)
    return connection


async def _train_now_with_hass(hass, *, job=None):
    connection = FakeConnection()
    msg = {"id": 1, "type": "helman/training/train_now"}
    if job is not None:
        msg["job"] = job
    await training_ws.ws_train_now.__wrapped__(hass, connection, msg)
    return connection


class TrainingStatusTests(unittest.TestCase):
    def _payload(self, coordinator) -> dict:
        connection = _status(coordinator)
        self.assertEqual(connection.errors, [])
        return connection.results[0][1]

    def test_every_job_is_reported_in_batch_order(self) -> None:
        payload = self._payload(_make_coordinator())

        self.assertEqual(
            [job["id"] for job in payload["jobs"]],
            ["solar_bias", "house_consumption", "appliance_energy"],
        )
        self.assertFalse(payload["isRunning"])
        self.assertIsNone(payload["currentJob"])
        self.assertFalse(payload["anyFailed"])

    def test_appliance_not_configured_is_idle_and_not_a_failure(self) -> None:
        store = _make_store(
            appliance_energy=_section(
                "not_configured",
                data={},
                fingerprint=APPLIANCE_FP,
                failed_appliances={},
            )
        )
        payload = self._payload(_make_coordinator(store=store))

        appliance = _job(payload, "appliance_energy")
        self.assertEqual(appliance["health"], "idle")
        self.assertFalse(appliance["usingOlderArtifact"])
        self.assertFalse(appliance["isStale"])
        self.assertFalse(payload["anyFailed"])

    def test_appliance_no_history_is_degraded(self) -> None:
        store = _make_store(
            appliance_energy=_section(
                "no_history", data={}, fingerprint=APPLIANCE_FP, failed_appliances={}
            )
        )
        payload = self._payload(_make_coordinator(store=store))

        self.assertEqual(_job(payload, "appliance_energy")["health"], "degraded")

    def test_one_failed_appliance_degrades_the_run_and_is_its_issue(self) -> None:
        store = _make_store(
            appliance_energy=_section(
                "estimates_trained",
                data={"dishwasher": 0.8},
                fingerprint=APPLIANCE_FP,
                failed_appliances={"boiler": "sensor.boiler_energy is gone"},
            )
        )
        payload = self._payload(
            _make_coordinator(store=store, appliance_estimates={"dishwasher": 0.8})
        )

        appliance = _job(payload, "appliance_energy")
        self.assertEqual(appliance["health"], "degraded")
        self.assertEqual(
            appliance["issues"],
            [{"subject": "boiler", "reason": "sensor.boiler_energy is gone"}],
        )
        self.assertTrue(appliance["artifactInUse"])
        self.assertFalse(appliance["usingOlderArtifact"])

    def test_only_the_appliance_job_carries_the_adopted_estimates(self) -> None:
        estimates = {"dishwasher": 1.12, "living_ac": 0.6}
        payload = self._payload(_make_coordinator(appliance_estimates=estimates))

        self.assertEqual(_job(payload, "appliance_energy")["estimates"], estimates)
        self.assertNotIn("estimates", _job(payload, "solar_bias"))
        self.assertNotIn("estimates", _job(payload, "house_consumption"))

    def test_a_current_short_house_profile_is_degraded_not_older(self) -> None:
        store = _make_store(house_consumption=_section("insufficient_history"))
        payload = self._payload(
            _make_coordinator(store=store, house_profile=object())
        )

        house = _job(payload, "house_consumption")
        self.assertEqual(house["health"], "degraded")
        self.assertTrue(house["artifactInUse"])
        self.assertFalse(house["usingOlderArtifact"])
        self.assertEqual(house["issues"], [])

    def test_a_missing_meter_over_a_served_profile_uses_the_older_one(self) -> None:
        store = _make_store(
            house_consumption=_section(
                "entity_missing",
                error_reason="sensor.house_energy",
                last_attempt_at="2026-08-03T03:00:00+02:00",
            )
        )
        payload = self._payload(
            _make_coordinator(store=store, house_profile=object())
        )

        house = _job(payload, "house_consumption")
        self.assertEqual(house["health"], "failed")
        self.assertEqual(house["errorReason"], "sensor.house_energy")
        self.assertTrue(house["usingOlderArtifact"])
        self.assertEqual(house["trainedAt"], TRAINED_AT)
        self.assertEqual(house["lastAttemptAt"], "2026-08-03T03:00:00+02:00")
        self.assertTrue(payload["anyFailed"])

    def test_a_legacy_document_has_no_attempt_time(self) -> None:
        legacy = _section("training_failed", error_reason="recorder exploded")
        del legacy["last_attempt_at"]
        store = _make_store(house_consumption=legacy)
        payload = self._payload(
            _make_coordinator(store=store, house_profile=object())
        )

        house = _job(payload, "house_consumption")
        self.assertIsNone(house["lastAttemptAt"])
        self.assertEqual(house["trainedAt"], TRAINED_AT)
        self.assertTrue(house["usingOlderArtifact"])

    def test_solar_dropped_days_are_issues_after_a_trained_or_short_run(self) -> None:
        dropped = [{"date": "2026-07-30", "reason": "day_forecast_too_low"}]
        for last_outcome, health in (
            ("profile_trained", "ok"),
            ("insufficient_history", "degraded"),
        ):
            with self.subTest(last_outcome=last_outcome):
                service = _make_bias_service(
                    metadata=_bias_metadata(last_outcome, dropped_days=dropped),
                    profile=_bias_profile(),
                )
                payload = self._payload(_make_coordinator(bias_service=service))

                solar = _job(payload, "solar_bias")
                self.assertEqual(solar["health"], health)
                self.assertEqual(
                    solar["issues"],
                    [{"subject": "2026-07-30", "reason": "day_forecast_too_low"}],
                )

    def test_disabled_solar_is_idle(self) -> None:
        service = _make_bias_service(
            enabled=False,
            metadata=_bias_metadata("training_failed"),
            profile=_bias_profile(),
        )
        payload = self._payload(_make_coordinator(bias_service=service))

        solar = _job(payload, "solar_bias")
        self.assertFalse(solar["enabled"])
        self.assertEqual(solar["health"], "idle")
        self.assertFalse(payload["anyFailed"])


class TrainingStatusAfterRealRunsTests(unittest.IsolatedAsyncioTestCase):
    def _payload(self, coordinator) -> dict:
        connection = _status(coordinator)
        self.assertEqual(connection.errors, [])
        return connection.results[0][1]

    async def test_a_wholesale_solar_failure_reports_no_issues(self) -> None:
        """The failure copies the previous run's dropped days forward: they
        explain the preserved profile, not this attempt."""
        service = _make_bias_service(
            metadata=_bias_metadata(
                "profile_trained",
                dropped_days=[{"date": "2026-07-30", "reason": "day_forecast_too_low"}],
            ),
            profile=_bias_profile(),
        )

        async def _samples(*_args, **_kwargs):
            raise RuntimeError("recorder is down")

        original = service_module.load_trainer_samples
        service_module.load_trainer_samples = _samples
        try:
            await service.async_train()
        finally:
            service_module.load_trainer_samples = original

        payload = self._payload(_make_coordinator(bias_service=service))

        solar = _job(payload, "solar_bias")
        self.assertEqual(solar["health"], "failed")
        self.assertEqual(solar["issues"], [])
        self.assertEqual(solar["errorReason"], "recorder is down")
        self.assertTrue(solar["usingOlderArtifact"])
        self.assertEqual(solar["trainedAt"], TRAINED_AT)
        self.assertNotEqual(solar["lastAttemptAt"], TRAINED_AT)

    async def test_a_wholesale_appliance_failure_reports_no_issues(self) -> None:
        store = _make_store()
        await store.async_record_appliance_energy(
            data={"dishwasher": 0.8},
            fingerprint=APPLIANCE_FP,
            trained_at=TRAINED_AT,
            last_outcome="estimates_trained",
            failed_appliances={"boiler": "sensor.boiler_energy is gone"},
        )
        await store.async_record_appliance_energy_failure(
            last_outcome="training_failed",
            error_reason="recorder is down",
            attempted_at="2026-08-02T03:00:00+02:00",
        )

        payload = self._payload(
            _make_coordinator(store=store, appliance_estimates={"dishwasher": 0.8})
        )

        appliance = _job(payload, "appliance_energy")
        self.assertEqual(appliance["health"], "failed")
        self.assertEqual(appliance["issues"], [])
        self.assertTrue(appliance["usingOlderArtifact"])

    async def test_a_house_request_that_raises_is_persisted_and_still_reported(
        self,
    ) -> None:
        store = _make_store(house_consumption=_section("profile_trained"))
        coordinator = _make_coordinator(store=store, house_profile=object())

        def _raise():
            raise RuntimeError("house config is broken")

        coordinator._read_house_training_request = _raise
        job = house_module.HouseConsumptionTrainingJob(
            SimpleNamespace(),
            store,
            read_request=_raise,
            on_trained=AsyncMock(),
        )

        with self.assertLogs(house_module._LOGGER, level="ERROR"):
            self.assertEqual(await job.async_train(), "training_failed")
        with self.assertLogs(coordinator_module._LOGGER, level="DEBUG"):
            payload = self._payload(coordinator)

        house = _job(payload, "house_consumption")
        self.assertEqual(house["health"], "failed")
        self.assertEqual(house["errorReason"], "house config is broken")
        self.assertEqual(house["trainedAt"], TRAINED_AT)
        self.assertIsNotNone(house["lastAttemptAt"])
        self.assertIsNone(house["isStale"])
        self.assertEqual(
            [job["id"] for job in payload["jobs"]],
            ["solar_bias", "house_consumption", "appliance_energy"],
        )
        self.assertIsNotNone(_job(payload, "appliance_energy")["isStale"])

    async def test_an_appliance_request_that_raises_is_persisted_and_still_reported(
        self,
    ) -> None:
        store = _make_store(
            appliance_energy=_section(
                "estimates_trained",
                data={"dishwasher": 0.8},
                fingerprint=APPLIANCE_FP,
                failed_appliances={},
            )
        )
        coordinator = _make_coordinator(
            store=store, appliance_estimates={"dishwasher": 0.8}
        )

        def _raise():
            raise RuntimeError("registry is broken")

        coordinator._read_appliance_energy_training_request = _raise
        job = appliance_module.ApplianceEnergyTrainingJob(
            SimpleNamespace(), store, read_request=_raise
        )

        with self.assertLogs(appliance_module._LOGGER, level="ERROR"):
            self.assertEqual(await job.async_train(), "training_failed")
        with self.assertLogs(coordinator_module._LOGGER, level="DEBUG"):
            payload = self._payload(coordinator)

        appliance = _job(payload, "appliance_energy")
        self.assertEqual(appliance["health"], "failed")
        self.assertEqual(appliance["errorReason"], "registry is broken")
        self.assertEqual(appliance["trainedAt"], TRAINED_AT)
        self.assertIsNotNone(appliance["lastAttemptAt"])
        self.assertIsNone(appliance["isStale"])
        self.assertTrue(appliance["usingOlderArtifact"])
        self.assertIsNotNone(_job(payload, "house_consumption")["isStale"])


class TrainingStatusAdminTests(unittest.TestCase):
    def test_status_refuses_a_non_admin(self) -> None:
        connection = _status(_make_coordinator(), is_admin=False)

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors, [(1, "unauthorized", "Admin access required")])


class TrainNowTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_job_runs_the_whole_batch(self) -> None:
        service = _make_bias_service()
        service.async_train = AsyncMock(return_value={"lastOutcome": "profile_trained"})
        house_job = _StubJob("profile_trained")
        appliance_job = _StubJob("estimates_trained")
        coordinator = _make_coordinator(
            bias_service=service, house_job=house_job, appliance_job=appliance_job
        )

        connection = await _train_now(coordinator)

        self.assertEqual(connection.errors, [])
        result = connection.results[0][1]
        self.assertEqual(
            result["outcomes"],
            {
                "solar_bias": "profile_trained",
                "house_consumption": "profile_trained",
                "appliance_energy": "estimates_trained",
            },
        )
        self.assertEqual(len(result["status"]["jobs"]), 3)
        self.assertEqual((house_job.calls, appliance_job.calls), (1, 1))
        service.async_train.assert_awaited_once()

    async def test_a_job_runs_only_that_job(self) -> None:
        service = _make_bias_service()
        service.async_train = AsyncMock()
        house_job = _StubJob("profile_trained")
        appliance_job = _StubJob("no_history")
        coordinator = _make_coordinator(
            bias_service=service, house_job=house_job, appliance_job=appliance_job
        )

        connection = await _train_now(coordinator, job="appliance_energy")

        self.assertEqual(connection.errors, [])
        self.assertEqual(
            connection.results[0][1]["outcomes"], {"appliance_energy": "no_history"}
        )
        self.assertEqual((house_job.calls, appliance_job.calls), (0, 1))
        service.async_train.assert_not_awaited()

    async def test_solar_bias_reports_a_failure_the_service_caught(self) -> None:
        """Never ``profile_trained`` beside a ``failed`` job."""
        service = _make_bias_service()
        service.async_train = AsyncMock(return_value={"lastOutcome": "training_failed"})
        coordinator = _make_coordinator(bias_service=service)

        connection = await _train_now(coordinator, job="solar_bias")

        self.assertEqual(connection.errors, [])
        self.assertEqual(
            connection.results[0][1]["outcomes"], {"solar_bias": "training_failed"}
        )

    async def test_a_run_in_flight_is_rejected_and_nothing_dispatched(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        class _SlowHouseJob:
            calls = 0

            async def async_train(self_inner):
                self_inner.calls += 1
                started.set()
                await release.wait()
                return "profile_trained"

        service = _make_bias_service()
        service.async_train = AsyncMock()
        house_job = _SlowHouseJob()
        appliance_job = _StubJob("estimates_trained")
        coordinator = _make_coordinator(
            bias_service=service, house_job=house_job, appliance_job=appliance_job
        )
        running = asyncio.ensure_future(
            coordinator._training_batch.async_run_house_consumption(reason="startup")
        )
        await started.wait()

        connection = await _train_now(coordinator, job="appliance_energy")

        release.set()
        await running
        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [
                (
                    1,
                    "training_in_progress",
                    "Training is already running: house_consumption",
                )
            ],
        )
        self.assertEqual((house_job.calls, appliance_job.calls), (1, 0))
        service.async_train.assert_not_awaited()

    async def test_legacy_solar_run_in_flight_rejects_every_unified_run(self) -> None:
        for job in (None, "solar_bias", "house_consumption", "appliance_energy"):
            with self.subTest(job=job):
                service = _make_bias_service()
                service._training_in_progress = True
                house_job = _StubJob("profile_trained")
                appliance_job = _StubJob("estimates_trained")
                coordinator = _make_coordinator(
                    bias_service=service,
                    house_job=house_job,
                    appliance_job=appliance_job,
                )

                connection = await _train_now(coordinator, job=job)

                self.assertEqual(connection.results, [])
                self.assertEqual(
                    connection.errors,
                    [
                        (
                            1,
                            "training_in_progress",
                            "Training is already running: solar_bias",
                        )
                    ],
                )
                self.assertEqual((house_job.calls, appliance_job.calls), (0, 0))

    async def test_reload_mid_run_refreshes_and_adopts_persisted_artifacts(self) -> None:
        old_store = _make_store()
        new_store = _make_store()
        new_store._store = old_store._store
        new_coordinator = _make_coordinator(store=new_store)
        new_coordinator._read_house_forecast_config = lambda: (
            None,
            56,
            14,
            HOUSE_FP,
        )
        new_coordinator._async_refresh_forecast = AsyncMock()
        hass = _hass(None)

        class _ReloadingApplianceJob:
            async def async_train(self_inner):
                # The new coordinator has already loaded the old empty document
                # when the superseded coordinator completes its write.
                hass.data[const.DOMAIN]["coordinator"] = new_coordinator
                await old_store.async_record_appliance_energy(
                    data={"dishwasher": 0.8},
                    fingerprint=APPLIANCE_FP,
                    trained_at=TRAINED_AT,
                    last_outcome="estimates_trained",
                    failed_appliances={},
                )
                return "estimates_trained"

        old_coordinator = _make_coordinator(
            store=old_store,
            appliance_job=_ReloadingApplianceJob(),
        )
        hass.data[const.DOMAIN]["coordinator"] = old_coordinator

        connection = await _train_now_with_hass(hass, job="appliance_energy")

        self.assertEqual(connection.errors, [])
        self.assertEqual(new_coordinator._appliance_energy_estimates, {"dishwasher": 0.8})
        self.assertEqual(
            _job(connection.results[0][1]["status"], "appliance_energy")["health"],
            "ok",
        )
        new_coordinator._async_refresh_forecast.assert_awaited_once_with(
            reason="training_artifacts_reloaded"
        )

    async def test_an_unload_mid_run_is_reported_not_crashed(self) -> None:
        coordinator = _make_coordinator()

        class _UnloadingHouseJob:
            async def async_train(self_inner):
                # A config save reloads Helman while the run is in flight.
                coordinator._training_batch = None
                return "profile_trained"

        coordinator._training_batch._house_consumption_job = _UnloadingHouseJob()

        connection = await _train_now(coordinator, job="house_consumption")

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors[0][1], "not_loaded")

    async def test_disabled_solar_bias_is_rejected_up_front(self) -> None:
        service = _make_bias_service(enabled=False)
        service.async_train = AsyncMock()
        coordinator = _make_coordinator(bias_service=service)

        connection = await _train_now(coordinator, job="solar_bias")

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors[0][1], "job_disabled")
        service.async_train.assert_not_awaited()

    async def test_a_non_admin_is_refused(self) -> None:
        house_job = _StubJob("profile_trained")
        coordinator = _make_coordinator(house_job=house_job)

        connection = await _train_now(coordinator, is_admin=False)

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors, [(1, "unauthorized", "Admin access required")])
        self.assertEqual(house_job.calls, 0)


if __name__ == "__main__":
    unittest.main()
