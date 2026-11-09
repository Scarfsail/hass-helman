"""``battery_hold_while_ev_charging`` (#753): hold the battery while a chosen EV charger charges.

Future slots follow the plan, the current slot follows the charger's measured
draw and live solar (grace applied by the watcher). The live readings come from
a real :class:`EvHoldWatcher` wherever a test is about sensor behaviour.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace

from custom_components.helman.appliances.state import AppliancesRuntimeRegistry
from custom_components.helman.automation.compute_inputs import EvHoldLiveState
from custom_components.helman.automation.conditions import build_eligibility
from custom_components.helman.automation.optimizers.battery_hold_while_ev_charging import (
    GATE_EV_CHARGING,
    BatteryHoldWhileEvChargingOptimizer,
    current_slot_basis,
    current_slot_group,
    current_slot_hold,
)
from custom_components.helman.automation.snapshot import OptimizationSnapshot
from custom_components.helman.battery_slot_simulation import simulate_schedule_action_slot
from custom_components.helman.battery_state import BatteryForecastSettings, BatteryLiveState
from custom_components.helman.scheduling.forecast_overlay import build_schedule_forecast_overlay
from custom_components.helman.scheduling.schedule import (
    ScheduleDocument,
    build_horizon_start,
    format_slot_id,
    schedule_document_to_dict,
)

from _fakes import (
    EV_HOLD_SOLAR,
    EvHoldHarness,
    FakeState,
    ev_charger_power_entity,
    ev_hold_config,
    make_optimization_context,
)
from automation_config_builders import make_optimizer_config
from automation_trace_contract import (
    assert_trace_contract,
    explanation_rows,
    run_optimizer_with_trace,
)

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:15:00+01:00"
THIRD_SLOT_ID = "2026-03-20T21:30:00+01:00"

REGISTRY = AppliancesRuntimeRegistry(
    appliances=(
        SimpleNamespace(id="ev_a", kind="ev_charger"),
        SimpleNamespace(id="ev_b", kind="ev_charger"),
    )
)
CHARGE = {"charge": True, "setBy": "user"}
HOLD = {"kind": "stop_discharging", "setBy": "automation", "optimizer": "battery_hold_while_ev_charging"}


def _config(*, chargers=("ev_a",), groups: list[dict] | None = None):
    return make_optimizer_config(
        id="ev-hold",
        kind="battery_hold_while_ev_charging",
        params={"ev_chargers": [{"controllable_id": charger} for charger in chargers]},
        conditions=groups or [{}],
    )


def _live(*charging: str, solar_w: float | None = None) -> EvHoldLiveState:
    return EvHoldLiveState(
        charging_by_charger_id={charger: True for charger in charging}, solar_w=solar_w
    )


def _snapshot(
    *,
    slots: dict | None = None,
    solar_w: dict[str, float] | None = None,
    live: EvHoldLiveState | None = None,
    condition_met: tuple[bool, ...] | None = None,
    now: datetime = REFERENCE_TIME,
) -> OptimizationSnapshot:
    """``solar_w`` is the forecast's average solar power per slot, in W."""
    series = [
        {"timestamp": slot_id, "durationHours": 0.25, "solarKwh": watts * 0.25 / 1000}
        for slot_id, watts in (solar_w or {}).items()
    ]
    return OptimizationSnapshot(
        schedule=ScheduleDocument(execution_enabled=True, slots=slots or {}),
        adjusted_house_forecast={},
        battery_forecast={"status": "available", "series": series},
        grid_forecast={},
        context=make_optimization_context(
            now=now,
            appliance_registry=REGISTRY,
            ev_hold_live=live,
            condition_met_by_optimizer_id=(
                None if condition_met is None else {"ev-hold": condition_met}
            ),
        ),
    )


class _Case(unittest.TestCase):
    def _run(self, snapshot, config=None, *, now=REFERENCE_TIME):
        config = config or _config()
        result, trace = run_optimizer_with_trace(
            BatteryHoldWhileEvChargingOptimizer(id="ev-hold"),
            snapshot,
            config,
            reference_time=now,
        )
        assert_trace_contract(self, trace)
        self.trace = trace
        return schedule_document_to_dict(result)["slots"]

    def assertHeld(self, slots, slot_id, *, condition_met=True) -> None:
        expected = dict(HOLD) if condition_met else {**HOLD, "conditionMet": False}
        self.assertEqual(slots[slot_id]["inverter"], expected)

    def assertNotHeld(self, slots, slot_id) -> None:
        self.assertNotIn("inverter", slots.get(slot_id, {}))


class FutureSlotTests(_Case):
    def test_planned_charge_under_low_forecast_solar_holds(self) -> None:
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE}}, solar_w={NEXT_SLOT_ID: 200}),
            _config(groups=[{"when_solar_below_w": 500}]),
        )
        self.assertHeld(slots, NEXT_SLOT_ID)

    def test_planned_charge_under_high_forecast_solar_does_not_hold(self) -> None:
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE}}, solar_w={NEXT_SLOT_ID: 2000}),
            _config(groups=[{"when_solar_below_w": 500}]),
        )
        self.assertNotHeld(slots, NEXT_SLOT_ID)

    def test_a_slot_with_no_planned_charge_does_not_hold(self) -> None:
        slots = self._run(_snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE}}))
        self.assertNotHeld(slots, THIRD_SLOT_ID)

    def test_a_candidate_charge_is_not_a_plan(self) -> None:
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_a": {**CHARGE, "conditionMet": False}}})
        )
        self.assertNotHeld(slots, NEXT_SLOT_ID)

    def test_a_missing_forecast_bucket_holds_under_a_threshold(self) -> None:
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE}}, solar_w={}),
            _config(groups=[{"when_solar_below_w": 500}]),
        )
        self.assertHeld(slots, NEXT_SLOT_ID)

    def test_no_threshold_holds_whatever_the_forecast(self) -> None:
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE}}, solar_w={NEXT_SLOT_ID: 9000})
        )
        self.assertHeld(slots, NEXT_SLOT_ID)

    def test_a_user_owned_slot_is_left_alone(self) -> None:
        user_normal = {"kind": "normal", "setBy": "user"}
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE, "inverter": user_normal}})
        )
        self.assertEqual(slots[NEXT_SLOT_ID]["inverter"], user_normal)

    def test_the_gate_says_the_future_slot_reads_the_plan(self) -> None:
        self._run(_snapshot(slots={NEXT_SLOT_ID: {"ev_a": CHARGE}}))
        rows = {row["slotId"]: row for row in explanation_rows(self.trace)["slots"]}
        gate = next(gate for gate in rows[NEXT_SLOT_ID]["gates"] if gate["key"] == GATE_EV_CHARGING)
        self.assertEqual((gate["state"], gate["params"]), ("true", {"source": "planned"}))


class CurrentSlotTests(_Case):
    def test_scheduled_but_not_drawing_does_not_hold(self) -> None:
        slots = self._run(_snapshot(slots={CURRENT_SLOT_ID: {"ev_a": CHARGE}}, live=_live()))
        self.assertNotHeld(slots, CURRENT_SLOT_ID)

    def test_drawing_without_a_schedule_holds_under_low_live_solar(self) -> None:
        slots = self._run(
            # The forecast says sunny; the current slot reads live solar only.
            _snapshot(live=_live("ev_a", solar_w=100), solar_w={CURRENT_SLOT_ID: 5000}),
            _config(groups=[{"when_solar_below_w": 500}]),
        )
        self.assertHeld(slots, CURRENT_SLOT_ID)
        rows = {row["slotId"]: row for row in explanation_rows(self.trace)["slots"]}
        gate = next(gate for gate in rows[CURRENT_SLOT_ID]["gates"] if gate["key"] == GATE_EV_CHARGING)
        self.assertEqual(
            gate["params"], {"source": "live", "chargers": ["ev_a"], "inGrace": []}
        )

    def test_live_solar_at_or_above_the_threshold_does_not_hold(self) -> None:
        slots = self._run(
            _snapshot(live=_live("ev_a", solar_w=500)),
            _config(groups=[{"when_solar_below_w": 500}]),
        )
        self.assertNotHeld(slots, CURRENT_SLOT_ID)

    def test_unknown_live_solar_holds_and_never_falls_back_to_the_forecast(self) -> None:
        slots = self._run(
            _snapshot(live=_live("ev_a", solar_w=None), solar_w={CURRENT_SLOT_ID: 5000}),
            _config(groups=[{"when_solar_below_w": 500}]),
        )
        self.assertHeld(slots, CURRENT_SLOT_ID)

    def test_a_planned_future_hold_is_re_decided_from_live_state_once_current(self) -> None:
        planned = {NEXT_SLOT_ID: {"ev_a": CHARGE}}
        slots = self._run(_snapshot(slots=planned, live=_live()))
        self.assertHeld(slots, NEXT_SLOT_ID)

        later = REFERENCE_TIME + timedelta(minutes=10)
        slots = self._run(_snapshot(slots=planned, live=_live(), now=later), now=later)
        self.assertNotHeld(slots, NEXT_SLOT_ID)


class ChargingThresholdTests(unittest.IsolatedAsyncioTestCase):
    async def test_exactly_1000_w_is_not_charging_and_1001_w_is(self) -> None:
        for watts, charging in (("1000", False), ("1001", True), ("1.001", True)):
            unit = "kW" if "." in watts else "W"
            with self.subTest(watts=watts, unit=unit):
                harness = EvHoldHarness(
                    ev_hold_config(),
                    {
                        ev_charger_power_entity("ev_a"): FakeState(
                            watts, attributes={"unit_of_measurement": unit}
                        )
                    },
                )
                await harness.setup()
                live = harness.watcher.snapshot(REFERENCE_TIME)
                self.assertEqual(live.charging_by_charger_id, {"ev_a": charging})


class MultipleChargerTests(_Case):
    def test_any_charging_charger_holds_overlapping_or_handing_over(self) -> None:
        config = _config(chargers=("ev_a", "ev_b"))
        for live in (_live("ev_a"), _live("ev_b"), _live("ev_a", "ev_b")):
            with self.subTest(live=live):
                slots = self._run(_snapshot(live=live), config)
                self.assertHeld(slots, CURRENT_SLOT_ID)
        slots = self._run(
            _snapshot(
                slots={NEXT_SLOT_ID: {"ev_a": CHARGE}, THIRD_SLOT_ID: {"ev_b": CHARGE}},
                live=_live(),
            ),
            config,
        )
        self.assertNotHeld(slots, CURRENT_SLOT_ID)
        self.assertHeld(slots, NEXT_SLOT_ID)
        self.assertHeld(slots, THIRD_SLOT_ID)

    def test_a_charger_the_optimizer_does_not_select_is_ignored(self) -> None:
        slots = self._run(
            _snapshot(slots={NEXT_SLOT_ID: {"ev_b": CHARGE}}, live=_live("ev_b"))
        )
        self.assertNotHeld(slots, CURRENT_SLOT_ID)
        self.assertNotHeld(slots, NEXT_SLOT_ID)


class GroupResolutionTests(_Case):
    """The current slot's decision functions agree with ``Eligibility``."""

    CASES = (
        # (name, groups, custom met, live solar, expected group, executable)
        (
            "false A, true B",
            [{"when_solar_below_w": 500}, {"when_solar_below_w": 1000}],
            (False, True),
            100.0,
            1,
            True,
        ),
        (
            "only a candidate passes",
            [{"when_solar_below_w": 500}, {"when_solar_below_w": 50}],
            (False, True),
            100.0,
            0,
            False,
        ),
        ("nothing passes", [{"when_solar_below_w": 50}], (True,), 100.0, None, False),
        (
            "unknown solar passes every group",
            [{"when_solar_below_w": 50}, {}],
            (True, True),
            None,
            0,
            True,
        ),
    )

    def test_current_slot_functions_match_eligibility_and_the_write(self) -> None:
        for name, groups, condition_met, solar_w, expected_group, executable in self.CASES:
            with self.subTest(name):
                config = _config(groups=groups)
                snapshot = _snapshot(
                    live=_live("ev_a", solar_w=solar_w), condition_met=condition_met
                )
                basis = current_slot_basis(snapshot, config)
                live = snapshot.context.ev_hold_live
                resolved = build_eligibility(snapshot, config).at(CURRENT_SLOT_ID)

                self.assertEqual(current_slot_group(basis, live), expected_group)
                self.assertEqual(
                    None if resolved is None else resolved.group.index, expected_group
                )
                self.assertEqual(current_slot_hold(basis, live), executable)

                slots = self._run(snapshot, config)
                if expected_group is None:
                    self.assertNotHeld(slots, CURRENT_SLOT_ID)
                else:
                    self.assertHeld(slots, CURRENT_SLOT_ID, condition_met=executable)


class GraceTests(unittest.IsolatedAsyncioTestCase):
    """The watcher's grace period, as the current slot sees it."""

    START = datetime.fromisoformat("2026-03-20T21:00:00+01:00")

    async def _harness(self, *, charging: bool = True, solar: str | None = None):
        states = {
            ev_charger_power_entity("ev_a"): FakeState(
                "7000" if charging else "0", attributes={"unit_of_measurement": "W"}
            )
        }
        if solar is not None:
            states[EV_HOLD_SOLAR] = FakeState(solar, attributes={"unit_of_measurement": "W"})
        harness = EvHoldHarness(
            ev_hold_config(
                sensor_grace_seconds=60, conditions=[{"when_solar_below_w": 500}]
            ),
            states,
        )
        await harness.setup()
        return harness

    def _holds(self, harness, now: datetime, *, slots: dict | None = None) -> bool:
        """What the optimizer writes for the current slot from the watcher's live state."""
        snapshot = _snapshot(slots=slots, live=harness.watcher.snapshot(now), now=now)
        result = BatteryHoldWhileEvChargingOptimizer(id="ev-hold").optimize(
            snapshot, _config(groups=[{"when_solar_below_w": 500}])
        )
        current_slot_id = format_slot_id(build_horizon_start(now))
        return "inverter" in result.slots.get(current_slot_id, {})

    async def test_a_dip_shorter_than_the_grace_keeps_the_hold_and_a_longer_one_releases(
        self,
    ) -> None:
        harness = await self._harness()
        dip = self.START + timedelta(minutes=1)
        await harness.event(ev_charger_power_entity("ev_a"), 0, dip)

        self.assertTrue(self._holds(harness, dip + timedelta(seconds=59)))
        self.assertFalse(self._holds(harness, dip + timedelta(seconds=60)))

        await harness.event(ev_charger_power_entity("ev_a"), 7000, dip + timedelta(seconds=30))
        self.assertTrue(self._holds(harness, dip + timedelta(minutes=5)))

    async def test_the_grace_runs_from_the_falling_edge_not_the_last_positive_reading(
        self,
    ) -> None:
        harness = await self._harness(charging=False)
        await harness.event(ev_charger_power_entity("ev_a"), 7000, self.START)
        # Silent for an hour: still charging all along.
        stop = self.START + timedelta(hours=1)
        self.assertTrue(self._holds(harness, stop - timedelta(seconds=1)))

        await harness.event(ev_charger_power_entity("ev_a"), 0, stop)
        self.assertTrue(self._holds(harness, stop + timedelta(seconds=59)))
        self.assertFalse(self._holds(harness, stop + timedelta(seconds=60)))

    async def test_an_unavailable_charger_holds_through_the_grace_then_does_not(
        self,
    ) -> None:
        harness = await self._harness()
        lost = self.START + timedelta(minutes=1)
        await harness.event(ev_charger_power_entity("ev_a"), "unavailable", lost)
        scheduled = {CURRENT_SLOT_ID: {"ev_a": CHARGE}}

        self.assertTrue(self._holds(harness, lost + timedelta(seconds=59), slots=scheduled))
        self.assertFalse(self._holds(harness, lost + timedelta(seconds=60), slots=scheduled))

    async def test_a_charger_unavailable_at_startup_is_not_charging_with_no_grace(
        self,
    ) -> None:
        harness = EvHoldHarness(
            ev_hold_config(),
            {ev_charger_power_entity("ev_a"): FakeState("unavailable")},
        )
        await harness.setup()
        self.assertFalse(self._holds(harness, self.START))

    async def test_an_unavailable_solar_sensor_keeps_its_value_through_the_grace_then_holds(
        self,
    ) -> None:
        harness = await self._harness(solar="2000")
        self.assertFalse(self._holds(harness, self.START))

        lost = self.START + timedelta(minutes=1)
        await harness.event(EV_HOLD_SOLAR, "unavailable", lost)
        self.assertEqual(harness.watcher.snapshot(lost + timedelta(seconds=59)).solar_w, 2000)
        self.assertFalse(self._holds(harness, lost + timedelta(seconds=59)))
        self.assertIsNone(harness.watcher.snapshot(lost + timedelta(seconds=60)).solar_w)
        self.assertTrue(self._holds(harness, lost + timedelta(seconds=60)))

    async def test_a_kw_solar_sensor_is_read_in_watts(self) -> None:
        harness = await self._harness()
        await harness.event(EV_HOLD_SOLAR, "0.4", self.START, unit="kW")
        self.assertEqual(harness.watcher.snapshot(self.START).solar_w, 400)
        self.assertTrue(self._holds(harness, self.START))
        await harness.event(EV_HOLD_SOLAR, "0.6", self.START, unit="kW")
        self.assertFalse(self._holds(harness, self.START))

    async def test_the_gate_names_a_charger_that_counts_only_through_its_grace(self) -> None:
        harness = await self._harness()
        dip = self.START + timedelta(minutes=1)
        await harness.event(ev_charger_power_entity("ev_a"), 0, dip)
        now = dip + timedelta(seconds=10)
        result, trace = run_optimizer_with_trace(
            BatteryHoldWhileEvChargingOptimizer(id="ev-hold"),
            _snapshot(live=harness.watcher.snapshot(now), now=now),
            _config(),
            reference_time=now,
        )
        rows = {row["slotId"]: row for row in explanation_rows(trace)["slots"]}
        gate = next(gate for gate in rows[CURRENT_SLOT_ID]["gates"] if gate["key"] == GATE_EV_CHARGING)
        self.assertEqual(gate["params"]["inGrace"], ["ev_a"])
        self.assertIn("inverter", result.slots[CURRENT_SLOT_ID])


class ForecastTests(unittest.TestCase):
    """The hold reaches the battery simulation the published forecast runs."""

    def test_held_night_slots_import_instead_of_discharging(self) -> None:
        night = [CURRENT_SLOT_ID, NEXT_SLOT_ID, THIRD_SLOT_ID]
        document = BatteryHoldWhileEvChargingOptimizer(id="ev-hold").optimize(
            _snapshot(
                slots={slot_id: {"ev_a": CHARGE} for slot_id in night[1:]},
                live=_live("ev_a"),
            ),
            _config(),
        )
        overlay = build_schedule_forecast_overlay(
            schedule_document=document, reference_time=REFERENCE_TIME
        )
        live_state = BatteryLiveState(
            current_remaining_energy_kwh=5.0,
            current_soc=50.0,
            min_soc=10.0,
            max_soc=100.0,
            nominal_capacity_kwh=10.0,
            min_energy_kwh=1.0,
            max_energy_kwh=10.0,
        )
        settings = BatteryForecastSettings(
            charge_efficiency=1.0,
            discharge_efficiency=1.0,
            max_charge_power_w=5000.0,
            max_discharge_power_w=5000.0,
        )

        def simulate(lookup):
            remaining = live_state.current_remaining_energy_kwh
            imported = []
            for slot_id in night:
                start = datetime.fromisoformat(slot_id)
                result = simulate_schedule_action_slot(
                    slot_start=start,
                    duration_hours=0.25,
                    solar_kwh=0.0,
                    # The house and the charge, within the battery's discharge limit.
                    baseline_house_kwh=1.0,
                    remaining_energy_kwh=remaining,
                    live_state=live_state,
                    settings=settings,
                    action=lookup(start),
                )
                remaining = result.remaining_energy_kwh
                imported.append(result.slot["importedFromGridKwh"])
            return remaining, imported

        held_remaining, held_imported = simulate(overlay.lookup_action)
        bare = build_schedule_forecast_overlay(
            schedule_document=ScheduleDocument(execution_enabled=True),
            reference_time=REFERENCE_TIME,
        )
        bare_remaining, bare_imported = simulate(bare.lookup_action)

        # Held: the battery ends the night where it started, the grid pays.
        self.assertEqual((held_remaining, held_imported), (5.0, [1.0, 1.0, 1.0]))
        self.assertEqual(bare_remaining, 2.0)
        self.assertEqual(bare_imported, [0.0, 0.0, 0.0])


if __name__ == "__main__":
    unittest.main()
