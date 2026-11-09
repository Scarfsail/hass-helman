"""``EvHoldWatcher`` (#753): re-plan only when the current slot's hold decision flips."""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, Mock, patch

from custom_components.helman.automation import pipeline as pipeline_module
from custom_components.helman.automation.pipeline import (
    AutomationRunFailure,
    AutomationRunResult,
)
from custom_components.helman.automation.triggers import AutomationTriggerCoordinator

from _fakes import (
    EV_HOLD_SOLAR,
    EvHoldHarness,
    FakeState,
    ev_charger_power_entity,
    ev_hold_config,
    make_coordinator,
)

T0 = datetime.fromisoformat("2026-03-20T21:00:00+01:00")
EV_A = ev_charger_power_entity("ev_a")
EV_B = ev_charger_power_entity("ev_b")
REASON = "ev_hold_changed"


def _watts(value: str) -> FakeState:
    return FakeState(value, attributes={"unit_of_measurement": "W"})


async def _harness(
    *,
    charging: tuple[str, ...] = (),
    chargers: tuple[str, ...] = ("ev_a",),
    solar: str | None = None,
    threshold: float | None = None,
    grace: int = 60,
    request_replan=None,
) -> EvHoldHarness:
    """A set-up watcher whose plan was recorded from the state it started in."""
    states = {
        ev_charger_power_entity(charger): _watts("7000" if charger in charging else "0")
        for charger in chargers
    }
    if solar is not None:
        states[EV_HOLD_SOLAR] = _watts(solar)
    harness = EvHoldHarness(
        ev_hold_config(
            chargers=chargers,
            sensor_grace_seconds=grace,
            conditions=[{} if threshold is None else {"when_solar_below_w": threshold}],
        ),
        states,
        request_replan=request_replan,
    )
    await harness.setup()
    harness.publish(harness.watcher.snapshot(T0))
    return harness


class NoReplanTests(unittest.IsolatedAsyncioTestCase):
    """Changes that leave the effective decision alone cost no re-plan."""

    async def test_a_power_change_while_charging(self) -> None:
        harness = await _harness(charging=("ev_a",))
        await harness.event(EV_A, 7100, T0)
        await harness.event(EV_A, 7300, T0 + timedelta(seconds=5))
        self.assertEqual(harness.requests, [])

    async def test_a_second_charger_starting_or_the_first_stopping_while_one_charges(
        self,
    ) -> None:
        harness = await _harness(charging=("ev_a",), chargers=("ev_a", "ev_b"), grace=0)
        await harness.event(EV_B, 7000, T0)
        await harness.event(EV_A, 0, T0 + timedelta(seconds=5))
        await harness.watcher.async_evaluate(T0 + timedelta(minutes=5))
        self.assertEqual(harness.requests, [])

    async def test_a_charger_starting_while_solar_is_above_the_threshold(self) -> None:
        harness = await _harness(solar="2000", threshold=500)
        await harness.event(EV_A, 7000, T0)
        self.assertEqual(harness.requests, [])

    async def test_solar_moving_below_the_threshold(self) -> None:
        harness = await _harness(charging=("ev_a",), solar="120", threshold=500)
        await harness.event(EV_HOLD_SOLAR, 140, T0)
        self.assertEqual(harness.requests, [])


class FlipTests(unittest.IsolatedAsyncioTestCase):
    """Exactly one debounced re-plan per real flip."""

    async def test_charging_starts(self) -> None:
        harness = await _harness()
        await harness.event(EV_A, 7000, T0)
        self.assertEqual(harness.requests, [REASON])

    async def test_the_grace_period_runs_out_on_a_tick(self) -> None:
        harness = await _harness(charging=("ev_a",))
        stop = T0 + timedelta(minutes=1)
        await harness.event(EV_A, 0, stop)
        await harness.watcher.async_evaluate(stop + timedelta(seconds=30))
        self.assertEqual(harness.requests, [])

        await harness.watcher.async_evaluate(stop + timedelta(seconds=60))
        self.assertEqual(harness.requests, [REASON])

    async def test_a_removed_charger_entity_stops_charging_after_the_grace(
        self,
    ) -> None:
        harness = await _harness(charging=("ev_a",))
        removed = T0 + timedelta(minutes=1)
        harness.watcher._on_state_changed(
            SimpleNamespace(
                data={"entity_id": EV_A, "new_state": None}, time_fired=removed
            )
        )
        await asyncio.sleep(0)
        self.assertEqual(
            harness.watcher.snapshot(removed).in_grace_charger_ids, frozenset({"ev_a"})
        )
        self.assertEqual(harness.requests, [])

        await harness.watcher.async_evaluate(removed + timedelta(seconds=60))
        self.assertEqual(harness.requests, [REASON])

    async def test_solar_crosses_the_threshold(self) -> None:
        harness = await _harness(charging=("ev_a",), solar="120", threshold=500)
        await harness.event(EV_HOLD_SOLAR, 800, T0)
        self.assertEqual(harness.requests, [REASON])

    async def test_no_second_request_while_one_for_the_same_decision_is_pending(
        self,
    ) -> None:
        harness = await _harness()
        await harness.event(EV_A, 7000, T0)
        await harness.event(EV_A, 7300, T0 + timedelta(seconds=5))
        await harness.watcher.async_evaluate(T0 + timedelta(seconds=30))
        self.assertEqual(harness.requests, [REASON])


class CompletionCheckTests(unittest.IsolatedAsyncioTestCase):
    """Against the real trigger coordinator, so coalescing is the real one."""

    async def asyncSetUp(self) -> None:
        self.clock = T0
        self.runs: list = []
        self.release = asyncio.Event()
        self.triggers = AutomationTriggerCoordinator(
            create_task=asyncio.create_task,
            run_callback=self._run,
            debounce_seconds=0,
        )

    async def asyncTearDown(self) -> None:
        await self.triggers.async_shutdown()

    async def _run(self, _request) -> None:
        """A run: read the live inputs, compute until released, publish, check."""
        live = self.harness.watcher.snapshot(self.clock)
        self.runs.append(live)
        await self.release.wait()
        self.harness.publish(live)
        await self.harness.watcher.async_check_after_run(self.clock, recorded=True)

    async def _settle(self) -> None:
        for _ in range(50):
            await asyncio.sleep(0)

    async def _at(self, when: datetime, entity_id: str, value) -> None:
        self.clock = when
        await self.harness.event(entity_id, value, when)
        await self._settle()

    def _charging(self) -> list[bool]:
        return [run.charging_by_charger_id["ev_a"] for run in self.runs]

    async def test_a_stop_before_publication_gets_exactly_one_follow_up(self) -> None:
        self.harness = await _harness(grace=0, request_replan=self.triggers.request_debounced)
        await self._at(T0 + timedelta(seconds=1), EV_A, 7000)
        self.assertEqual(self._charging(), [True])

        # Back to the recorded value while the run computes: nothing to ask for.
        await self._at(T0 + timedelta(seconds=2), EV_A, 0)
        self.release.set()
        await self._settle()

        # The published hold differs from live state: one follow-up, no more.
        self.assertEqual(self._charging(), [True, False])

    async def test_solar_crossing_back_before_publication_gets_exactly_one_follow_up(
        self,
    ) -> None:
        self.harness = await _harness(
            charging=("ev_a",),
            solar="100",
            threshold=500,
            grace=0,
            request_replan=self.triggers.request_debounced,
        )
        await self._at(T0 + timedelta(seconds=1), EV_HOLD_SOLAR, 800)
        await self._at(T0 + timedelta(seconds=2), EV_HOLD_SOLAR, 100)
        self.release.set()
        await self._settle()

        self.assertEqual([run.solar_w for run in self.runs], [800, 100])

    async def test_a_quarter_hour_run_whose_inputs_change_while_it_computes(
        self,
    ) -> None:
        self.harness = await _harness(grace=0, request_replan=self.triggers.request_debounced)
        await self.triggers.request_immediate(reason="quarter_hour")
        await self._settle()
        await self._at(T0 + timedelta(seconds=1), EV_A, 7000)
        self.release.set()
        await self._settle()

        self.assertEqual(self._charging(), [False, True])

    async def test_a_failed_run_records_nothing_and_is_retried(self) -> None:
        harness = await _harness()
        await harness.event(EV_A, 7000, T0)
        self.assertEqual(harness.requests, [REASON])

        # The run fails: nothing is published, and the completion check asks
        # for nothing, so a run that keeps failing cannot loop back to back.
        await harness.watcher.async_check_after_run(
            T0 + timedelta(seconds=1), recorded=False
        )
        self.assertEqual(harness.requests, [REASON])

        # The next tick retries it; the failed request no longer suppresses it.
        await harness.watcher.async_evaluate(T0 + timedelta(minutes=1))
        self.assertEqual(harness.requests, [REASON, REASON])


class SetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_reads_current_states_without_grace(self) -> None:
        harness = EvHoldHarness(
            ev_hold_config(chargers=("ev_a", "ev_b")),
            {
                EV_A: _watts("7000"),
                EV_B: FakeState("unavailable"),
                EV_HOLD_SOLAR: FakeState("unknown"),
            },
        )
        await harness.setup()
        live = harness.watcher.snapshot(T0)
        self.assertEqual(live.charging_by_charger_id, {"ev_a": True, "ev_b": False})
        self.assertIsNone(live.solar_w)
        self.assertEqual(live.in_grace_charger_ids, frozenset())
        self.assertEqual(harness.tracked, [[EV_A, EV_B, EV_HOLD_SOLAR]])

    async def test_nothing_is_watched_without_a_hold_optimizer(self) -> None:
        config = ev_hold_config()
        config["automation"]["system_optimizers"][0]["enabled"] = False
        harness = EvHoldHarness(config, {EV_A: _watts("7000")})
        await harness.setup()
        self.assertEqual(harness.tracked, [])
        self.assertEqual(harness.watcher.snapshot(T0).charging_by_charger_id, {})

    async def test_a_reload_drops_the_old_listeners_and_charger_state(self) -> None:
        harness = await _harness(charging=("ev_a",))
        harness.watcher.async_unload()
        self.assertEqual(harness.removed, [[EV_A, EV_HOLD_SOLAR]])

        harness.config = ev_hold_config(chargers=("ev_b",))
        await harness.setup()
        self.assertEqual(harness.tracked[-1], [EV_B, EV_HOLD_SOLAR])
        self.assertEqual(
            harness.watcher.snapshot(T0).charging_by_charger_id, {"ev_b": False}
        )
        # Nothing is recorded until the new config's first run.
        await harness.event(EV_B, 7000, T0)
        self.assertEqual(harness.requests, [])


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_run_ends_with_the_completion_check_and_only_success_records(
        self,
    ) -> None:
        coordinator = make_coordinator()
        coordinator._hass.async_add_executor_job = Mock()
        coordinator.ev_hold.record_plan = Mock()
        coordinator.ev_hold.async_check_after_run = AsyncMock()
        failed = AutomationRunResult.failed(
            reason="runner_failed",
            failure=AutomationRunFailure(stage="optimizer_loop", message="boom"),
        )
        runner = Mock()
        runner.return_value.run = AsyncMock(return_value=failed)

        with patch.object(pipeline_module, "AutomationRunner", runner):
            await coordinator.run_automation(reason="ev_hold_changed")

        coordinator.ev_hold.record_plan.assert_not_called()
        coordinator.ev_hold.async_check_after_run.assert_awaited_once_with(
            ANY, recorded=False
        )

    async def test_a_raising_run_still_ends_with_the_completion_check(self) -> None:
        coordinator = make_coordinator()
        coordinator._hass.async_add_executor_job = Mock()
        coordinator.ev_hold.async_check_after_run = AsyncMock()
        runner = Mock()
        runner.return_value.run = AsyncMock(side_effect=RuntimeError("boom"))

        with patch.object(pipeline_module, "AutomationRunner", runner):
            with self.assertRaises(RuntimeError):
                await coordinator.run_automation(reason="ev_hold_changed")

        coordinator.ev_hold.async_check_after_run.assert_awaited_once_with(
            ANY, recorded=False
        )

    async def test_every_executor_tick_evaluates_the_hold(self) -> None:
        coordinator = make_coordinator()
        coordinator.ev_hold.async_evaluate = AsyncMock()

        await coordinator._async_reality_check_and_maybe_replan(T0)

        coordinator.ev_hold.async_evaluate.assert_awaited_once_with(T0)


if __name__ == "__main__":
    unittest.main()
