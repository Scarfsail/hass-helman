from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


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

appliance_energy_module = importlib.import_module(
    "custom_components.helman.training.appliance_energy"
)
generic_module = importlib.import_module(
    "custom_components.helman.appliances.generic_appliance"
)
climate_module = importlib.import_module(
    "custom_components.helman.appliances.climate_appliance"
)

ApplianceEnergyTrainingJob = appliance_energy_module.ApplianceEnergyTrainingJob
ApplianceEnergyTrainingRequest = appliance_energy_module.ApplianceEnergyTrainingRequest


def _make_generic(
    appliance_id: str = "dishwasher",
    *,
    strategy: str = "history_average",
    energy_entity_id: str | None = "sensor.dishwasher_energy",
    lookback_days: int = 30,
    hourly_energy_kwh: float = 1.2,
):
    return generic_module.GenericApplianceRuntime(
        id=appliance_id,
        name=appliance_id,
        switch_entity_id=f"switch.{appliance_id}",
        projection_strategy=strategy,
        hourly_energy_kwh=hourly_energy_kwh,
        history_energy_entity_id=energy_entity_id,
        history_lookback_days=lookback_days,
    )


def _make_climate(appliance_id: str = "living-room-hvac"):
    return climate_module.ClimateApplianceRuntime(
        id=appliance_id,
        name=appliance_id,
        climate_entity_id=f"climate.{appliance_id}",
        projection_strategy="history_average",
        hourly_energy_kwh=1.5,
        history_energy_entity_id=f"sensor.{appliance_id}_energy",
        history_lookback_days=30,
    )


class _FakeStore:
    def __init__(self) -> None:
        self.section: dict | None = None
        self.writes: list[str] = []

    @property
    def appliance_energy(self) -> dict | None:
        return self.section

    async def async_record_appliance_energy(
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

    async def async_record_appliance_energy_failure(
        self, *, last_outcome, error_reason
    ) -> None:
        previous = self.section or {}
        self.section = {
            **{key: previous.get(key) for key in ("data", "fingerprint", "trained_at")},
            "last_outcome": last_outcome,
            "error_reason": error_reason,
        }
        self.writes.append(last_outcome)


class _RecordingEstimator:
    """Stands in for the two recorder reads, one answer per appliance id."""

    def __init__(self, answers: dict[str, float | None], *, error_ids=()) -> None:
        self._answers = answers
        self._error_ids = set(error_ids)
        self.switch_calls: list[tuple[str, str, int]] = []
        self.climate_calls: list[tuple[str, str, int]] = []

    async def switch(
        self, _hass, *, switch_entity_id, energy_entity_id, reference_time, lookback_days
    ):
        appliance_id = switch_entity_id.split(".", 1)[1]
        self.switch_calls.append((switch_entity_id, energy_entity_id, lookback_days))
        if appliance_id in self._error_ids:
            raise RuntimeError("recorder is down")
        return self._answers.get(appliance_id)

    async def climate(
        self,
        _hass,
        *,
        climate_entity_id,
        energy_entity_id,
        reference_time,
        lookback_days,
    ):
        appliance_id = climate_entity_id.split(".", 1)[1]
        self.climate_calls.append((climate_entity_id, energy_entity_id, lookback_days))
        if appliance_id in self._error_ids:
            raise RuntimeError("recorder is down")
        return self._answers.get(appliance_id)


class ApplianceEnergyTrainingJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._original_switch = (
            appliance_energy_module.estimate_average_hourly_energy_when_switch_on
        )
        self._original_climate = (
            appliance_energy_module.estimate_average_hourly_energy_when_climate_active
        )

    def tearDown(self) -> None:
        appliance_energy_module.estimate_average_hourly_energy_when_switch_on = (
            self._original_switch
        )
        appliance_energy_module.estimate_average_hourly_energy_when_climate_active = (
            self._original_climate
        )

    def _install(self, estimator: _RecordingEstimator) -> None:
        appliance_energy_module.estimate_average_hourly_energy_when_switch_on = (
            estimator.switch
        )
        appliance_energy_module.estimate_average_hourly_energy_when_climate_active = (
            estimator.climate
        )

    def _make_job(self, store, appliances, *, on_trained=None):
        return ApplianceEnergyTrainingJob(
            SimpleNamespace(),
            store,
            read_request=lambda: ApplianceEnergyTrainingRequest(
                appliances=tuple(appliances)
            ),
            on_trained=on_trained,
        )

    async def test_resolves_and_stores_one_estimate_per_appliance(self) -> None:
        store = _FakeStore()
        estimator = _RecordingEstimator(
            {"dishwasher": 0.8, "living-room-hvac": 1.1}
        )
        self._install(estimator)
        job = self._make_job(store, [_make_generic(), _make_climate()])

        outcome = await job.async_train()

        self.assertEqual(outcome, "estimates_trained")
        self.assertEqual(
            store.section["data"],
            {"dishwasher": 0.8, "living-room-hvac": 1.1},
        )
        self.assertEqual(len(estimator.switch_calls), 1)
        self.assertEqual(len(estimator.climate_calls), 1)

    async def test_no_history_appliances_records_not_configured_without_reading(
        self,
    ) -> None:
        """The all-``fixed`` config: nothing to resolve, and nothing read.

        Recorded rather than skipped so the stored fingerprint matches what
        startup computes — otherwise every restart would schedule a refit for a
        config that has no history-average appliance in it at all.
        """
        store = _FakeStore()
        estimator = _RecordingEstimator({})
        self._install(estimator)
        job = self._make_job(store, [])

        outcome = await job.async_train()

        self.assertEqual(outcome, "not_configured")
        self.assertEqual(store.section["data"], {})
        self.assertEqual(estimator.switch_calls, [])
        self.assertEqual(estimator.climate_calls, [])

    async def test_unusable_estimate_is_left_out_rather_than_stored(self) -> None:
        """``None`` and non-positive mean the history did not answer.

        Storing them would pin the appliance to a wrong number; leaving the id
        out is what makes the reader fall back to its configured figure.
        """
        store = _FakeStore()
        self._install(
            _RecordingEstimator({"dishwasher": None, "living-room-hvac": 0.0})
        )
        job = self._make_job(store, [_make_generic(), _make_climate()])

        outcome = await job.async_train()

        self.assertEqual(outcome, "no_history")
        self.assertEqual(store.section["data"], {})

    async def test_one_failing_appliance_does_not_cost_the_others(self) -> None:
        store = _FakeStore()
        self._install(
            _RecordingEstimator(
                {"dishwasher": 0.8, "living-room-hvac": 1.1},
                error_ids=("dishwasher",),
            )
        )
        job = self._make_job(store, [_make_generic(), _make_climate()])

        with self.assertLogs(appliance_energy_module._LOGGER, level="ERROR"):
            outcome = await job.async_train()

        self.assertEqual(outcome, "estimates_trained")
        self.assertEqual(store.section["data"], {"living-room-hvac": 1.1})

    async def test_store_failure_preserves_the_previous_estimates(self) -> None:
        store = _FakeStore()
        store.section = {
            "data": {"dishwasher": 0.8},
            "fingerprint": "old",
            "trained_at": "2026-08-01T03:00:00+02:00",
            "last_outcome": "estimates_trained",
            "error_reason": None,
        }

        async def _explode(*_args, **_kwargs):
            raise RuntimeError("store is broken")

        store.async_record_appliance_energy = _explode
        self._install(_RecordingEstimator({"dishwasher": 0.9}))
        job = self._make_job(store, [_make_generic()])

        with self.assertLogs(appliance_energy_module._LOGGER, level="ERROR"):
            outcome = await job.async_train()

        self.assertEqual(outcome, "training_failed")
        self.assertEqual(store.section["data"], {"dishwasher": 0.8})
        self.assertEqual(store.section["error_reason"], "store is broken")

    async def test_on_trained_is_announced(self) -> None:
        store = _FakeStore()
        self._install(_RecordingEstimator({"dishwasher": 0.8}))
        calls: list[int] = []

        async def _on_trained() -> None:
            calls.append(1)

        job = self._make_job(store, [_make_generic()], on_trained=_on_trained)

        await job.async_train()

        self.assertEqual(len(calls), 1)


class ApplianceEnergyFingerprintTests(unittest.TestCase):
    def test_lookback_change_moves_the_fingerprint(self) -> None:
        before = ApplianceEnergyTrainingRequest((_make_generic(),)).fingerprint
        after = ApplianceEnergyTrainingRequest(
            (_make_generic(lookback_days=60),)
        ).fingerprint

        self.assertNotEqual(before, after)

    def test_entity_change_moves_the_fingerprint(self) -> None:
        before = ApplianceEnergyTrainingRequest((_make_generic(),)).fingerprint
        after = ApplianceEnergyTrainingRequest(
            (_make_generic(energy_entity_id="sensor.other"),)
        ).fingerprint

        self.assertNotEqual(before, after)

    def test_hourly_energy_change_does_not_move_the_fingerprint(self) -> None:
        """``hourly_energy_kwh`` is only the fallback.

        Changing it must not invalidate an estimate that is still correct.
        """
        before = ApplianceEnergyTrainingRequest((_make_generic(),)).fingerprint
        after = ApplianceEnergyTrainingRequest(
            (_make_generic(hourly_energy_kwh=9.9),)
        ).fingerprint

        self.assertEqual(before, after)

    def test_appliance_order_does_not_move_the_fingerprint(self) -> None:
        one = ApplianceEnergyTrainingRequest(
            (_make_generic("a"), _make_generic("b"))
        ).fingerprint
        other = ApplianceEnergyTrainingRequest(
            (_make_generic("b"), _make_generic("a"))
        ).fingerprint

        self.assertEqual(one, other)


if __name__ == "__main__":
    unittest.main()
