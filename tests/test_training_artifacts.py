"""``TrainingArtifacts``: one adoption plumbing, two adoption policies.

The house profile has an expiry arm and is blanked on a fingerprint change; the
appliance estimates are kept on one and also carry the shared-meter weights.
Both are adopted at setup, again when their job finishes, and refit once Home
Assistant has started when adoption says one is due.
"""

from __future__ import annotations

import types
import unittest
import unittest.mock
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from tests._fakes import FakeHass, make_coordinator
from custom_components.helman import coordinator as coordinator_module
from custom_components.helman.training.artifacts import TrainingArtifacts

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    from homeassistant.util import dt as dt_util
    monkeypatch.setattr(dt_util, "now", lambda: REFERENCE_TIME)


def _make_profile_data() -> dict:
    return {
        "schema_version": 1,
        "history_days": 30,
        "non_deferrable": [[1.0, 0.5, 1.5]] * 168,
        "consumers": {},
    }


def _make_section(
    *,
    fingerprint: str = "fp-1",
    trained_at: str = "2026-03-20T03:00:00+01:00",
    last_outcome: str = "profile_trained",
    data: dict | None = -1,  # type: ignore[assignment]
) -> dict:
    return {
        "data": _make_profile_data() if data == -1 else data,
        "fingerprint": fingerprint,
        "trained_at": trained_at,
        "last_outcome": last_outcome,
        "error_reason": None,
    }


def _make_artifacts(
    *,
    house=None,
    appliance=None,
    house_fingerprint: str = "fp-1",
    appliance_fingerprint: str = "ap-1",
    batch=None,
    started: list | None = None,
) -> TrainingArtifacts:
    """Artifacts over a store holding ``house`` and ``appliance`` sections."""
    artifacts = TrainingArtifacts(
        FakeHass(),
        read_house_request=lambda: SimpleNamespace(config_fingerprint=house_fingerprint),
        read_house_fingerprint=lambda: house_fingerprint,
        read_appliance_request=lambda: SimpleNamespace(fingerprint=appliance_fingerprint),
        training_batch=lambda: batch,
        run_when_started=(started if started is not None else []).append,
        on_adopted=AsyncMock(),
    )
    artifacts.store = SimpleNamespace(house_consumption=house, appliance_energy=appliance)
    return artifacts


class HouseProfileAdoptionTests(unittest.TestCase):
    """Which of the three cases a stored profile falls into on startup.

    A config save is a restart, so this one decision covers startup and config
    save both; the setup path refits exactly when this returns a reason.
    """

    def test_a_fresh_matching_profile_triggers_nothing(self) -> None:
        artifacts = _make_artifacts(house=_make_section())

        reason = artifacts.adopt_house_consumption()

        self.assertIsNone(reason)
        self.assertIsNotNone(artifacts.house_profile)
        self.assertEqual(artifacts.house_profile.history_days, 30)
        self.assertEqual(artifacts.house_profile_last_outcome, "profile_trained")

    def test_a_missing_profile_serves_nothing_and_refits(self) -> None:
        artifacts = _make_artifacts(house=None)

        reason = artifacts.adopt_house_consumption()

        self.assertEqual(reason, "no_stored_profile")
        self.assertIsNone(artifacts.house_profile)

    def test_a_fingerprint_stale_profile_is_blanked_and_refitted(self) -> None:
        """G3: the config change has to be visible, so the old answer to a
        question the user has since changed must not be served."""
        artifacts = _make_artifacts(
            house=_make_section(fingerprint="fp-old"), house_fingerprint="fp-new"
        )

        reason = artifacts.adopt_house_consumption()

        self.assertEqual(reason, "config_changed")
        self.assertIsNone(artifacts.house_profile)

    def test_a_profile_older_than_48h_keeps_serving_while_it_refits(self) -> None:
        artifacts = _make_artifacts(
            house=_make_section(trained_at="2026-03-17T03:00:00+01:00")
        )

        reason = artifacts.adopt_house_consumption()

        self.assertEqual(reason, "profile_expired")
        self.assertIsNotNone(artifacts.house_profile)

    def test_an_unreadable_profile_is_treated_as_missing(self) -> None:
        artifacts = _make_artifacts(house=_make_section(data={"schema_version": 99}))

        reason = artifacts.adopt_house_consumption()

        self.assertEqual(reason, "unreadable_profile")
        self.assertIsNone(artifacts.house_profile)

    def test_a_failed_refit_keeps_serving_and_carries_its_outcome(self) -> None:
        """The store preserved the previous fit; it is adopted and the failure
        reported so the banner can name it."""
        artifacts = _make_artifacts(house=_make_section(last_outcome="training_failed"))

        reason = artifacts.adopt_house_consumption()

        self.assertIsNone(reason)
        self.assertIsNotNone(artifacts.house_profile)
        self.assertEqual(artifacts.house_profile_last_outcome, "training_failed")


class ApplianceEnergyAdoptionPolicyTests(unittest.TestCase):
    """The other policy: no expiry arm, and a stale fingerprint blanks nothing."""

    def test_a_stale_fingerprint_keeps_the_estimates_and_adopts_the_weights(self) -> None:
        artifacts = _make_artifacts(
            appliance={
                "data": {"dishwasher": 0.83},
                "fingerprint": "ap-old",
                "shared_meter_weights": {"ac-1": 1.2, "ac-2": None},
            }
        )

        reason = artifacts.adopt_appliance_energy()

        self.assertEqual(reason, "config_changed")
        self.assertEqual(artifacts.appliance_energy_estimates, {"dishwasher": 0.83})
        self.assertEqual(artifacts.shared_meter_weights, {"ac-1": 1.2, "ac-2": None})

    def test_an_old_matching_section_needs_no_refit(self) -> None:
        artifacts = _make_artifacts(
            appliance={
                "data": {"dishwasher": 0.83},
                "fingerprint": "ap-1",
                "trained_at": "2025-01-01T03:00:00+01:00",
            }
        )

        self.assertIsNone(artifacts.adopt_appliance_energy())


class AdoptionPlumbingTests(unittest.IsolatedAsyncioTestCase):
    """What both policies share: the refit, the trained hook and the reload."""

    async def test_a_due_refit_runs_its_own_batch_job_once_started(self) -> None:
        runs: list[tuple[str, str]] = []

        async def _run(job, *, reason):
            runs.append((job, reason))

        batch = SimpleNamespace(
            async_run_house_consumption=lambda *, reason: _run("house", reason=reason),
            async_run_appliance_energy=lambda *, reason: _run("appliance", reason=reason),
        )
        started: list = []
        artifacts = _make_artifacts(batch=batch, started=started)

        artifacts.adopt_house_consumption()
        artifacts.adopt_appliance_energy()
        self.assertEqual(runs, [])
        for factory in started:
            await factory()

        self.assertEqual(
            runs,
            [("house", "no_stored_profile"), ("appliance", "no_stored_estimates")],
        )

    async def test_a_finished_job_is_adopted_before_the_one_hook_runs(self) -> None:
        artifacts = _make_artifacts()
        seen: list = []

        async def _on_adopted(reason: str) -> None:
            seen.append(
                (
                    reason,
                    artifacts.house_profile is not None,
                    dict(artifacts.appliance_energy_estimates),
                )
            )

        artifacts._on_adopted = _on_adopted
        artifacts.store.house_consumption = _make_section()
        artifacts.store.appliance_energy = {"data": {"pump": 0.4}, "fingerprint": "ap-1"}

        await artifacts.house_consumption_job._on_trained()
        await artifacts.appliance_energy_job._on_trained()

        self.assertEqual(
            seen,
            [
                ("house_profile_trained", True, {}),
                ("appliance_energy_trained", True, {"pump": 0.4}),
            ],
        )

    async def test_an_adoption_after_unload_does_not_refresh_the_forecast(self) -> None:
        coordinator = make_coordinator()
        coordinator._async_refresh_forecast = AsyncMock()
        coordinator.training.store = SimpleNamespace(
            house_consumption=None, appliance_energy=None
        )
        coordinator._unloaded = True

        await coordinator.training.house_consumption_job._on_trained()

        coordinator._async_refresh_forecast.assert_not_awaited()

    async def test_a_reload_adopts_both_sections_and_schedules_no_refit(self) -> None:
        started: list = []
        artifacts = _make_artifacts(
            batch=SimpleNamespace(), started=started, house_fingerprint="fp-new"
        )
        artifacts.store.async_load = AsyncMock()
        artifacts.store.house_consumption = _make_section()
        artifacts.store.appliance_energy = {"data": {"pump": 0.4}, "fingerprint": "x"}

        await artifacts.async_reload()

        artifacts.store.async_load.assert_awaited_once()
        self.assertIsNone(artifacts.house_profile)
        self.assertEqual(artifacts.appliance_energy_estimates, {"pump": 0.4})
        self.assertEqual(started, [])


class HouseProfileRefitDeferralTests(unittest.TestCase):
    """The startup refit waits for Home Assistant to finish starting.

    Regression guard. Run during ``async_setup``, the fit can read the house
    energy entity before its own integration has registered it, record
    ``entity_missing``, and leave the house forecast unavailable until the next
    nightly run. Observed live: the entity turned up about eighty seconds after
    setup.
    """

    def _make_coordinator(self):
        runs: list[str] = []

        coordinator = make_coordinator()
        coordinator._hass = types.SimpleNamespace()
        coordinator._unsub_listeners = []
        coordinator._training_batch = types.SimpleNamespace(
            async_run_house_consumption=lambda *, reason: runs.append(reason)
        )
        coordinator._create_tracked_refresh_task = lambda awaitable: awaitable
        coordinator.training.store = types.SimpleNamespace(house_consumption=None)
        return coordinator, runs

    def test_the_refit_does_not_run_before_home_assistant_has_started(self) -> None:
        coordinator, runs = self._make_coordinator()
        started_callbacks: list = []

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            side_effect=lambda hass, cb: (
                started_callbacks.append(cb) or (lambda: None)
            ),
        ):
            coordinator.training.adopt_house_consumption()

        self.assertEqual(runs, [])
        self.assertEqual(len(started_callbacks), 1)

        started_callbacks[0](coordinator._hass)

        self.assertEqual(runs, ["no_stored_profile"])

    def test_the_registration_is_unsubscribed_on_teardown(self) -> None:
        coordinator, _runs = self._make_coordinator()

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            return_value=lambda: None,
        ):
            coordinator.training.adopt_house_consumption()

        self.assertEqual(len(coordinator._unsub_listeners), 1)

    def test_no_batch_means_no_registration(self) -> None:
        coordinator, _runs = self._make_coordinator()
        coordinator._training_batch = None

        with unittest.mock.patch.object(
            coordinator_module, "async_at_started"
        ) as at_started:
            coordinator.training.adopt_house_consumption()

        at_started.assert_not_called()
        self.assertEqual(coordinator._unsub_listeners, [])


if __name__ == "__main__":
    unittest.main()
