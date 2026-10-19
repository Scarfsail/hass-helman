from __future__ import annotations
from tests._fakes import hold_pipeline, make_coordinator

import importlib
import types
from types import SimpleNamespace
import unittest
import pytest
import unittest.mock
from datetime import datetime, timedelta

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:16:00+01:00")

const_module = importlib.import_module("custom_components.helman.const")
coordinator_module = importlib.import_module("custom_components.helman.coordinator")


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    from homeassistant.util import dt as dt_util
    monkeypatch.setattr(dt_util, "now", lambda: REFERENCE_TIME)


FORECAST_CANONICAL_GRANULARITY_MINUTES = (
    const_module.FORECAST_CANONICAL_GRANULARITY_MINUTES
)
HOUSE_FORECAST_MODEL_ID = const_module.HOUSE_FORECAST_MODEL_ID
MAX_FORECAST_DAYS = const_module.MAX_FORECAST_DAYS
HelmanCoordinator = coordinator_module.HelmanCoordinator


class CoordinatorHouseForecastTests(unittest.TestCase):
    def test_has_matching_forecast_snapshot_rejects_missing_canonical_slot(self) -> None:
        coordinator = make_coordinator()
        coordinator._cached_forecast = {
            "status": "available",
            "actualHistory": [],
            "trainingWindowDays": 56,
            "requiredHistoryDays": 14,
            "configFingerprint": "abc123",
            "model": HOUSE_FORECAST_MODEL_ID,
        }

        self.assertFalse(
            coordinator._has_matching_forecast_snapshot(
                total_energy_entity_id="sensor.house_total",
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="abc123",
            )
        )

    def test_has_matching_forecast_snapshot_accepts_canonical_slot_shape(self) -> None:
        coordinator = make_coordinator()
        coordinator._cached_forecast = {
            "status": "available",
            "actualHistory": [],
            "trainingWindowDays": 56,
            "requiredHistoryDays": 14,
            "configFingerprint": "abc123",
            "model": HOUSE_FORECAST_MODEL_ID,
            "sourceGranularityMinutes": FORECAST_CANONICAL_GRANULARITY_MINUTES,
            "forecastDaysAvailable": MAX_FORECAST_DAYS,
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
            },
        }

        self.assertTrue(
            coordinator._has_matching_forecast_snapshot(
                total_energy_entity_id="sensor.house_total",
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="abc123",
            )
        )

    def test_current_w_uses_adjusted_nondeferrable_not_deferrable_band(self) -> None:
        # The current slot covers 21:16 (the stubbed now); its adjusted
        # nonDeferrable already carries scheduled appliance demand (0.6 kWh).
        # The deferrableConsumers band and the unadjusted cache must be ignored.
        coordinator = make_coordinator()
        coordinator._cached_forecast = {
            "status": "available",
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "nonDeferrable": {"value": 0.2},
                "deferrableConsumers": [{"value": 0.3}],
            },
            "series": [],
        }
        hold_pipeline(
            coordinator,
            types.SimpleNamespace(
                adjusted_house_forecast={
                    "status": "available",
                    "currentSlot": {
                        "timestamp": "2026-03-20T21:15:00+01:00",
                        "nonDeferrable": {"value": 0.6},
                        "deferrableConsumers": [{"value": 0.9}],
                    },
                    "series": [],
                }
            ),
        )

        # 0.6 kWh over a 15-min slot -> 0.6 * 1000 / 0.25 = 2400 W.
        self.assertEqual(
            coordinator.get_house_consumption_forecast_current_w(),
            2400.0,
        )

    def test_current_w_falls_back_to_base_load_when_pipeline_cold(self) -> None:
        # With no pipeline, the sensor reports the unadjusted base load only,
        # never base + deferrableConsumers.
        coordinator = make_coordinator()
        hold_pipeline(coordinator, None)
        coordinator._cached_forecast = {
            "status": "available",
            "currentSlot": {
                "timestamp": "2026-03-20T21:15:00+01:00",
                "nonDeferrable": {"value": 0.2},
                "deferrableConsumers": [{"value": 0.3}],
            },
            "series": [],
        }

        # 0.2 kWh base load only -> 0.2 * 1000 / 0.25 = 800 W (not 2000 W).
        self.assertEqual(
            coordinator.get_house_consumption_forecast_current_w(),
            800.0,
        )


class StartupForecastRefreshDeferralTests(unittest.TestCase):
    """The startup forecast refresh waits for Home Assistant to finish starting.

    Regression guard for #30. Run during ``async_setup``, the solar half reads
    its points off the forecast provider's daily energy entities before that
    integration has registered them, comes back ``unavailable`` with no points,
    and — before the guard in ``_async_build_forecast_snapshots`` — overwrote
    the persisted snapshot with an empty one.
    """

    def _make_coordinator(self) -> tuple[HelmanCoordinator, list[str]]:
        reasons: list[str] = []

        coordinator = make_coordinator()
        coordinator._hass = types.SimpleNamespace()
        coordinator._unsub_listeners = []
        coordinator._async_refresh_forecast = lambda *, reason: reasons.append(reason)
        coordinator._create_tracked_refresh_task = lambda awaitable: awaitable
        return coordinator, reasons

    def test_the_refresh_does_not_run_before_home_assistant_has_started(self) -> None:
        coordinator, reasons = self._make_coordinator()
        started_callbacks: list = []

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            side_effect=lambda hass, cb: (
                started_callbacks.append(cb) or (lambda: None)
            ),
        ):
            coordinator._schedule_startup_forecast_refresh()

        self.assertEqual(reasons, [])
        self.assertEqual(len(started_callbacks), 1)

        started_callbacks[0](coordinator._hass)

        self.assertEqual(reasons, ["startup"])

    def test_an_already_running_home_assistant_refreshes_at_once(self) -> None:
        """A config save reloads the entry while HA runs — G3 is unaffected."""
        coordinator, reasons = self._make_coordinator()

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            side_effect=lambda hass, cb: cb(hass) or (lambda: None),
        ):
            coordinator._schedule_startup_forecast_refresh()

        self.assertEqual(reasons, ["startup"])

    def test_the_registration_is_unsubscribed_on_teardown(self) -> None:
        coordinator, _reasons = self._make_coordinator()

        with unittest.mock.patch.object(
            coordinator_module,
            "async_at_started",
            return_value=lambda: None,
        ):
            coordinator._schedule_startup_forecast_refresh()

        self.assertEqual(len(coordinator._unsub_listeners), 1)


class ForecastStalenessTests(unittest.TestCase):
    def test_a_healthy_outcome_leaves_the_age_rule_alone(self) -> None:
        self.assertIsNone(
            coordinator_module._build_house_profile_health(
                {"lastOutcome": "profile_trained"}
            )
        )

    def test_each_failing_outcome_has_its_own_localizable_reason(self) -> None:
        for last_outcome, expected_reason in (
            ("insufficient_history", "house_profile_insufficient_history"),
            ("entity_missing", "house_profile_entity_missing"),
            ("training_failed", "house_profile_training_failed"),
        ):
            with self.subTest(last_outcome=last_outcome):
                health = coordinator_module._build_house_profile_health(
                    {
                        "lastOutcome": last_outcome,
                        "historyDaysAvailable": 3,
                        "requiredHistoryDays": 14,
                    }
                )
                self.assertIsNotNone(health)
                self.assertEqual(health[0], expected_reason)
                # The numeric detail lives in the hint, because `localize`
                # takes no interpolation parameters.
                self.assertTrue(health[1])

    def test_the_override_wins_over_a_fresh_snapshot(self) -> None:
        staleness = coordinator_module._build_forecast_staleness(
            REFERENCE_TIME.isoformat(),
            reference_time=REFERENCE_TIME,
            override=("house_profile_training_failed", "check the log"),
        )

        self.assertTrue(staleness["isStale"])
        self.assertEqual(staleness["reason"], "house_profile_training_failed")
        self.assertEqual(staleness["hint"], "check the log")

    def test_without_an_override_age_still_decides(self) -> None:
        staleness = coordinator_module._build_forecast_staleness(
            REFERENCE_TIME.isoformat(),
            reference_time=REFERENCE_TIME,
        )

        self.assertFalse(staleness["isStale"])
        self.assertIsNone(staleness["reason"])


if __name__ == "__main__":
    unittest.main()
