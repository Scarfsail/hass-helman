from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TZ = timezone(timedelta(hours=2))
REFERENCE_TIME = datetime(2026, 7, 10, 5, 0, tzinfo=TZ)
DAY = date(2026, 7, 10)

def _install_import_stubs() -> None:
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

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg
    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg
    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.parse_datetime = datetime.fromisoformat
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.config import OptimizerInstanceConfig  # noqa: E402
from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
)
from custom_components.helman.automation.optimizers.charge_hold import (  # noqa: E402
    build_charge_hold_optimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleDocument,
    inverter_action,
)
from custom_components.helman.appliances import AppliancesRuntimeRegistry  # noqa: E402
from custom_components.helman.automation.explain import (  # noqa: E402
    OptimizerExplanation,
)
from automation_config_builders import make_optimizer_config  # noqa: E402
from automation_trace_contract import (  # noqa: E402
    assert_trace_contract,
    run_optimizer_with_trace,
)


def _explanation(trace) -> OptimizerExplanation:
    payload = trace.to_dict()
    return OptimizerExplanation.from_dict(
        payload["steps"][0]["explanation"], payload["slotIds"]
    )


def _slots_by_id(trace) -> dict:
    return {slot.slot_id: slot for slot in _explanation(trace).slots}


def _gate(slot, key: str):
    return next((gate for gate in slot.gates if gate.key == key), None)


def _slot_id(hour: int, minute: int) -> str:
    return datetime(2026, 7, 10, hour, minute, tzinfo=TZ).isoformat(timespec="seconds")


def _surplus_series() -> list[dict[str, object]]:
    # 1 kWh surplus per 30-min slot from 10:00 to 13:30 (8 slots -> 8 kWh).
    series = []
    cursor = datetime(2026, 7, 10, 10, 0, tzinfo=TZ)
    end = datetime(2026, 7, 10, 14, 0, tzinfo=TZ)
    while cursor < end:
        series.append(
            {
                "timestamp": cursor.isoformat(timespec="seconds"),
                "solarKwh": 1.0,
                "baselineHouseKwh": 0.0,
                "durationHours": 0.5,
            }
        )
        cursor += timedelta(minutes=30)
    return series


#: Hourly export price, dearest in the morning and bottoming out at 13:00 — the
#: shape of the real day that exposed the release-time bug (issue #79). Only the
#: hours the surplus series covers matter, but the feed publishes the whole day.
_EXPORT_PRICES = {
    10: 4.0,
    11: 3.0,
    12: 2.0,
    13: 1.0,
}


def _export_price_points(
    prices_by_hour: dict[int, float] | None = None,
) -> list[dict[str, object]]:
    prices = _EXPORT_PRICES if prices_by_hour is None else prices_by_hour
    return [
        {
            "timestamp": datetime(2026, 7, 10, hour, 0, tzinfo=TZ).isoformat(
                timespec="seconds"
            ),
            "value": prices.get(hour, 9.0),
        }
        for hour in range(24)
    ]


def _day_context(
    *,
    classification: str = "surplus",
) -> DayContext:
    return DayContext(
        local_date=DAY,
        classification=classification,
        predicted_solar_kwh=8.0,
        predicted_consumption_kwh=4.0,
        export_price_min=1.0,
        export_price_max=9.0,
        day_min_window=None,
        import_bands=(),
    )


def _make_snapshot(
    *,
    schedule_document: ScheduleDocument | None = None,
    current_soc: float = 60.0,
    day_context: DayContext | None = None,
    battery_configured: bool = True,
    surplus_series: list[dict[str, object]] | None = None,
    export_price_points: list[dict[str, object]] | None = None,
) -> OptimizationSnapshot:
    battery_state = (
        types.SimpleNamespace(current_soc=current_soc, max_soc=100.0)
        if battery_configured
        else None
    )
    day_contexts = {} if day_context is None else {DAY: day_context}
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={
            "status": "available",
            "series": _surplus_series() if surplus_series is None else surplus_series,
        },
        grid_forecast={"status": "available", "series": []},
        context=OptimizationContext(
            now=REFERENCE_TIME,
            battery_state=battery_state,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={"unit": "CZK/kWh", "currentPrice": 3.0, "points": []},
            export_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 2.0,
                "points": (
                    _export_price_points()
                    if export_price_points is None
                    else export_price_points
                ),
            },
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id={},
            battery_max_charge_power_kw=5.0,
            battery_usable_capacity_kwh=10.0,
            battery_charge_efficiency=1.0,
            runtime_hours_by_appliance_id_by_local_date={},
            day_contexts=day_contexts,
        ),
    )


def _make_config(
    *,
    run_when=("surplus",),
    window_start: str = "06:00",
    window_end: str = "14:00",
    target_soc: int = 100,
    margin_pct: int = 0,
    groups: list[dict] | None = None,
) -> OptimizerInstanceConfig:
    return make_optimizer_config(
        id="morning-export",
        kind="charge_hold",
        params={
            "window": {"start": window_start, "end": window_end},
            "battery_first": {"target_soc": target_soc, "margin_pct": margin_pct},
        },
        conditions=groups or [{"run_when": list(run_when)}],
    )


def _held_slot_ids(result: ScheduleDocument) -> set[str]:
    return {
        slot_id
        for slot_id, actions in result.slots.items()
        if inverter_action(actions).kind == "stop_charging"
        and inverter_action(actions).set_by == "automation"
    }


class ChargeHoldOptimizerTests(unittest.TestCase):
    def test_releases_the_cheapest_slots_that_cover_the_need(self) -> None:
        # 4 kWh needed, 1 kWh per slot: the four cheapest surplus slots are
        # 13:00/13:30 (1.0) and 12:00/12:30 (2.0). Everything else in the window
        # is held, including the dearer surplus slots *after* the window start.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context()), _make_config()
        )
        held = _held_slot_ids(result)
        self.assertEqual(
            held,
            {_slot_id(hour, minute) for hour in range(6, 10) for minute in (0, 30)}
            | {_slot_id(10, 0), _slot_id(10, 30), _slot_id(11, 0), _slot_id(11, 30)},
        )
        self.assertNotIn(_slot_id(5, 30), held)

    def test_the_charge_set_need_not_be_contiguous(self) -> None:
        """The bug of issue #79: the cheapest slots are what matters, not a run.

        With 12:00–12:30 priced *above* 11:00–11:30, the charge set straddles a
        dearer pair — something the release-time model could never express, and
        which it got wrong by charging from the day minimum forward into the
        rising prices behind it.
        """
        prices = {10: 4.0, 11: 1.5, 12: 3.0, 13: 1.0}
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                day_context=_day_context(),
                export_price_points=_export_price_points(prices),
            ),
            _make_config(),
        )
        held = _held_slot_ids(result)
        # Released: 13:00, 13:30 (1.0) and 11:00, 11:30 (1.5) — 12:00/12:30 sit
        # between them and are held.
        self.assertIn(_slot_id(12, 0), held)
        self.assertIn(_slot_id(12, 30), held)
        self.assertNotIn(_slot_id(11, 0), held)
        self.assertNotIn(_slot_id(11, 30), held)
        self.assertNotIn(_slot_id(13, 0), held)
        self.assertNotIn(_slot_id(13, 30), held)

    def test_a_cheap_morning_is_released_and_the_dear_afternoon_held(self) -> None:
        """The ranking spans the day, so the hold is not tied to the morning."""
        prices = {10: 1.0, 11: 2.0, 12: 3.0, 13: 4.0}
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                day_context=_day_context(),
                export_price_points=_export_price_points(prices),
            ),
            _make_config(),
        )
        held = _held_slot_ids(result)
        self.assertNotIn(_slot_id(10, 0), held)
        self.assertNotIn(_slot_id(11, 30), held)
        self.assertIn(_slot_id(12, 0), held)
        self.assertIn(_slot_id(13, 30), held)

    def test_slots_past_the_window_are_ranked_but_never_held(self) -> None:
        """A window ending at noon still charges from the cheap afternoon.

        Every candidate after ``window.end`` outranks the morning, so the whole
        window is held and nothing is written past it — the "hold the morning,
        charge in the afternoon" case, out of the same ranking.
        """
        result = build_charge_hold_optimizer(
            _make_config(window_end="12:00")
        ).optimize(
            _make_snapshot(day_context=_day_context()),
            _make_config(window_end="12:00"),
        )
        held = _held_slot_ids(result)
        self.assertIn(_slot_id(10, 0), held)
        self.assertIn(_slot_id(11, 30), held)
        self.assertNotIn(_slot_id(12, 0), held)
        self.assertNotIn(_slot_id(13, 0), held)

    def test_gate_skips_non_surplus_day(self) -> None:
        day_context = _day_context(classification="deficit")
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context), _make_config()
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_no_room_when_surplus_cannot_cover_need(self) -> None:
        # target 100, current 10 -> needed 9 kWh > 8 kWh total surplus.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context(), current_soc=10.0),
            _make_config(),
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_surplus_is_scoped_to_the_resolved_day(self) -> None:
        # Today's own surplus (3 kWh at 10:00/10:30/11:00) is below the 4 kWh
        # need, but tomorrow's forecast surplus is plentiful. Tomorrow's solar
        # cannot refill today's battery, so it must not count toward the release
        # decision — the day has no room to hold and nothing is held.
        today_surplus = [
            {
                "timestamp": datetime(2026, 7, 10, hour, minute, tzinfo=TZ).isoformat(
                    timespec="seconds"
                ),
                "solarKwh": 1.0,
                "baselineHouseKwh": 0.0,
                "durationHours": 0.5,
            }
            for hour, minute in ((10, 0), (10, 30), (11, 0))
        ]
        tomorrow_surplus = [
            {
                "timestamp": (
                    datetime(2026, 7, 11, 10, 0, tzinfo=TZ) + timedelta(minutes=30 * i)
                ).isoformat(timespec="seconds"),
                "solarKwh": 1.0,
                "baselineHouseKwh": 0.0,
                "durationHours": 0.5,
            }
            for i in range(8)
        ]
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                day_context=_day_context(),
                surplus_series=today_surplus + tomorrow_surplus,
            ),
            _make_config(),
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_already_full_holds_the_whole_window(self) -> None:
        # needed <= 0 -> nothing to charge, so no slot is worth releasing.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context(), current_soc=100.0),
            _make_config(),
        )
        held = _held_slot_ids(result)
        self.assertIn(_slot_id(12, 30), held)
        self.assertIn(_slot_id(13, 30), held)
        self.assertNotIn(_slot_id(14, 0), held)  # past window.end

    def test_leaves_user_owned_inverter_untouched(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                _slot_id(6, 0): {
                    "inverter": {"kind": "normal", "setBy": "user"},
                }
            },
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                schedule_document=schedule_document, day_context=_day_context()
            ),
            _make_config(),
        )
        self.assertEqual(inverter_action(result.slots[_slot_id(6, 0)]).kind, "normal")
        self.assertNotIn(_slot_id(6, 0), _held_slot_ids(result))

    def test_no_battery_state_writes_nothing(self) -> None:
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context(), battery_configured=False),
            _make_config(),
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_does_not_mutate_snapshot_schedule(self) -> None:
        snapshot = _make_snapshot(day_context=_day_context())
        before = deepcopy(snapshot.schedule.slots)
        build_charge_hold_optimizer(_make_config()).optimize(snapshot, _make_config())
        self.assertEqual(snapshot.schedule.slots, before)


class ChargeHoldTraceContractTests(unittest.TestCase):
    def test_matched_day_full_coverage_and_applied_reason(self) -> None:
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=_day_context())
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        applied = [d for d in step["decisions"] if d["outcome"] == "applied"]
        self.assertEqual(len(applied), 1)

        slots = _slots_by_id(trace)
        held = slots[_slot_id(10, 0)]
        self.assertEqual(held.verdict, "execute")
        self.assertEqual(_gate(held, "day_context").state, "true")
        self.assertEqual(_gate(held, "day_group_matched").state, "true")
        self.assertEqual(_gate(held, "hold_window").state, "true")
        self.assertEqual(_gate(held, "hold_room").state, "true")
        rank = _gate(held, "cheapest_rank")
        # 10:00 is the dearest surplus slot of the day: last of the eight, and
        # it lost to a marginal price of 2.0.
        self.assertEqual(rank.state, "true")
        self.assertEqual(rank.params["rank"], 7)
        self.assertEqual(rank.params["rankOf"], 8)
        self.assertEqual(rank.params["price"], 4.0)
        self.assertEqual(rank.params["marginalPrice"], 2.0)
        # It supplies none of the need, so it is quoted no running total.
        self.assertIsNone(rank.params["cumulativeKwh"])

    def test_the_ranking_is_recorded_as_a_gate_on_both_sides_of_the_cut(self) -> None:
        """The cheapness ranking is the one thing no condition can express."""
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=_day_context())
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        slots = _slots_by_id(trace)
        released = slots[_slot_id(13, 0)]
        self.assertEqual(released.verdict, "skip")
        self.assertEqual(_gate(released, "hold_window").state, "true")
        self.assertEqual(_gate(released, "hold_room").state, "true")
        rank = _gate(released, "cheapest_rank")
        self.assertEqual(rank.state, "false")
        self.assertEqual(rank.params["rank"], 1)  # cheapest slot of the day
        self.assertEqual(rank.params["cumulativeKwh"], 1.0)
        self.assertEqual(rank.params["thresholdKwh"], 4.0)

        # A window slot with no surplus takes no rank at all — it is held for
        # want of anywhere to charge, not for losing a comparison.
        dark = slots[_slot_id(7, 0)]
        self.assertEqual(dark.verdict, "execute")
        self.assertEqual(_gate(dark, "cheapest_rank").state, "true")
        self.assertIsNone(_gate(dark, "cheapest_rank").params["rank"])

        # Outside the window the ranking never applies: absent, not false.
        outside = slots[_slot_id(5, 30)]
        self.assertEqual(_gate(outside, "hold_window").state, "false")
        self.assertIsNone(_gate(outside, "hold_room"))
        self.assertIsNone(_gate(outside, "cheapest_rank"))

    def test_no_room_to_hold_is_a_day_scoped_gate(self) -> None:
        # target 100, current 10 -> needed 9 kWh > 8 kWh total surplus.
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=_day_context(), current_soc=10.0)
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        in_window = _slots_by_id(trace)[_slot_id(7, 0)]
        self.assertEqual(in_window.verdict, "skip")
        room = _gate(in_window, "hold_room")
        self.assertEqual(room.state, "false")
        self.assertGreater(room.params["neededKwh"], room.params["surplusAtWindowStart"])
        # The ranking is never consulted for a day with no room.
        self.assertIsNone(_gate(in_window, "cheapest_rank"))

    def test_non_matched_day_names_the_failing_condition(self) -> None:
        day_context = _day_context(classification="deficit")
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=day_context)
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)

        slot = _slots_by_id(trace)[_slot_id(7, 0)]
        self.assertEqual(slot.verdict, "skip")
        self.assertEqual(_gate(slot, "day_context").state, "true")
        matched = _gate(slot, "day_group_matched")
        self.assertEqual(matched.state, "false")
        self.assertEqual(matched.params["classification"], "deficit")
        self.assertEqual(matched.params["failingCondition"], "run_when")
        # Keyed `conditionValue`, like appliance_runtime's equivalent gate, and
        # carrying the classifications the group does allow.
        self.assertEqual(matched.params["conditionValue"], ["surplus"])
        # The window is never reached once the day itself is out.
        self.assertIsNone(_gate(slot, "hold_window"))

    def test_battery_params_missing_emits_note(self) -> None:
        day_context = _day_context()
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=day_context, battery_configured=False)
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        self.assertTrue(
            any(note["code"] == "battery_params_missing" for note in step["notes"])
        )

        # Nothing was evaluated at all; only the status keeps that apart from a
        # horizon where every slot genuinely failed.
        explanation = _explanation(trace)
        self.assertEqual(explanation.status, "skipped")
        self.assertEqual(explanation.status_reason, "battery_params_missing")
        self.assertEqual({slot.verdict for slot in explanation.slots}, {"skip"})


if __name__ == "__main__":
    unittest.main()
