from __future__ import annotations

import types
import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

from _ha_stubs import stub_ha_dt, stub_module


TZ = timezone(timedelta(hours=2))
REFERENCE_TIME = datetime(2026, 7, 10, 5, 0, tzinfo=TZ)
DAY = date(2026, 7, 10)

def _install_import_stubs() -> None:

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_ha_dt()
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.config import OptimizerInstanceConfig  # noqa: E402
from custom_components.helman.const import SCHEDULE_SLOT_MINUTES  # noqa: E402
from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
)
from custom_components.helman.automation.optimizers.charge_hold import (  # noqa: E402
    build_charge_hold_optimizer,
)
from _fakes import make_optimization_context  # noqa: E402
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleDocument,
    inverter_action,
)
from custom_components.helman.appliances.state import AppliancesRuntimeRegistry  # noqa: E402
from automation_config_builders import make_optimizer_config  # noqa: E402
from automation_trace_contract import (  # noqa: E402
    assert_trace_contract,
    explanation_rows,
    run_optimizer_with_trace,
)


def _slots_by_id(trace) -> dict:
    return {slot["slotId"]: slot for slot in explanation_rows(trace)["slots"]}


def _gate(slot, key: str):
    return next((gate for gate in slot["gates"] if gate["key"] == key), None)


def _slot_id(hour: int, minute: int) -> str:
    return datetime(2026, 7, 10, hour, minute, tzinfo=TZ).isoformat(timespec="seconds")


def _surplus_series() -> list[dict[str, object]]:
    # 2 kWh of surplus per hour from 10:00 to 14:00 -> 8 kWh, on the canonical
    # 15-minute forecast grid.
    series = []
    cursor = datetime(2026, 7, 10, 10, 0, tzinfo=TZ)
    end = datetime(2026, 7, 10, 14, 0, tzinfo=TZ)
    while cursor < end:
        series.append(
            {
                "timestamp": cursor.isoformat(timespec="seconds"),
                "solarKwh": 0.5,
                "baselineHouseKwh": 0.0,
                "durationHours": 0.25,
            }
        )
        cursor += timedelta(minutes=SCHEDULE_SLOT_MINUTES)
    return series


def _series_with_soc(soc_pct: float) -> list[dict[str, object]]:
    """The surplus series behind an overnight point carrying a forecast SoC.

    The real battery forecast stamps every bucket with the level it ends at;
    only the last bucket before the window start decides the day's need, so one
    leading point is enough to fix it. It carries no surplus of its own, which
    keeps the charge-able energy identical to :func:`_surplus_series`.
    """
    return [
        {
            "timestamp": datetime(2026, 7, 10, 5, 30, tzinfo=TZ).isoformat(
                timespec="seconds"
            ),
            "solarKwh": 0.0,
            "baselineHouseKwh": 0.0,
            "durationHours": 0.5,
            "socPct": soc_pct,
        }
    ] + _surplus_series()


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


#: The instance whose house view the fixture context is classified over. Since
#: #264 a day context names it, because `charge_hold` runs first — with every
#: appliance lane restored as demand — and so can hold a different band for the
#: same calendar day than the appliance that runs after it.
DENOMINATOR_OPTIMIZER_ID = "charge-hold"


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
        import_bands=(),
        ratio=2.0,
        denominator_optimizer_id=DENOMINATOR_OPTIMIZER_ID,
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
        types.SimpleNamespace(
            current_soc=current_soc, max_soc=100.0, nominal_capacity_kwh=10.0
        )
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
        context=make_optimization_context(
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
    min_soc: int | None = None,
    groups: list[dict] | None = None,
) -> OptimizerInstanceConfig:
    battery_first = {"target_soc": target_soc, "margin_pct": margin_pct}
    if min_soc is not None:
        battery_first["min_soc"] = min_soc
    return make_optimizer_config(
        id="morning-export",
        kind="charge_hold",
        params={
            "window": {"start": window_start, "end": window_end},
            "battery_first": battery_first,
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
        # 4 kWh needed, 0.5 kWh per slot: the eight cheapest surplus slots are
        # 13:00-13:45 (1.0) and 12:00-12:45 (2.0). Everything else in the window
        # is held, including the dearer surplus slots *after* the window start.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context()), _make_config()
        )
        held = _held_slot_ids(result)
        self.assertEqual(
            held,
            {
                _slot_id(hour, minute)
                for hour in range(6, 12)
                for minute in (0, 15, 30, 45)
            },
        )
        self.assertNotIn(_slot_id(5, 30), held)

    def test_written_actions_record_the_optimizer_kind(self) -> None:
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context()), _make_config()
        )
        self.assertTrue(_held_slot_ids(result))
        for slot_id in _held_slot_ids(result):
            self.assertEqual(
                inverter_action(result.slots[slot_id]).optimizer, "charge_hold"
            )

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

    def test_equal_prices_extend_the_charge_set_into_one_run(self) -> None:
        """The prod plan of 2026-11-06 (issue #733), at the same prices.

        Four 5.459 slots at 12:00–12:45 and four 5.526 slots before them, with a
        need of seven slots: the three 5.526 slots are the ones next to 12:00,
        so the battery charges unbroken from 11:15 instead of exporting 11:45
        between two charging runs.
        """
        prices = {10: 9.0, 11: 5.526, 12: 5.459, 13: 9.0}
        snapshot = _make_snapshot(
            day_context=_day_context(),
            # 3.5 kWh to target: seven 0.5 kWh slots.
            current_soc=65.0,
            export_price_points=_export_price_points(prices),
        )
        result, trace = run_optimizer_with_trace(
            build_charge_hold_optimizer(_make_config()),
            snapshot,
            _make_config(),
            reference_time=REFERENCE_TIME,
        )
        # Up to 12:45, where the charge set reaches target; the hold ends there.
        released = {
            _slot_id(hour, minute)
            for hour in range(10, 13)
            for minute in (0, 15, 30, 45)
        } - _held_slot_ids(result)
        self.assertEqual(
            released,
            {_slot_id(11, minute) for minute in (15, 30, 45)}
            | {_slot_id(12, minute) for minute in (0, 15, 30, 45)},
        )

        slots = _slots_by_id(trace)
        for minute, rank in ((45, 5), (30, 6), (15, 7)):
            gate = _gate(slots[_slot_id(11, minute)], "cheapest_rank")
            self.assertEqual(gate["state"], "false")
            self.assertEqual(gate["params"]["rank"], rank)
        held = slots[_slot_id(11, 0)]
        self.assertEqual(held["verdict"], "execute")
        self.assertEqual(_gate(held, "cheapest_rank")["state"], "true")
        self.assertEqual(_gate(held, "cheapest_rank")["params"]["rank"], 8)

    def test_a_cheap_morning_frees_the_dear_afternoon_behind_it(self) -> None:
        """Reaching target ends the hold, however dear what follows is.

        Ascending prices put the whole charge set in the morning, so the battery
        is full by 11:30 — and the 3.0/4.0 afternoon behind it is released even
        though it is the dearest surplus of the day. Holding it would protect
        nothing (the surplus exports for the same price either way) and cost the
        battery the headroom to ride a peak and take the dip back.
        """
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
        self.assertNotIn(_slot_id(12, 0), held)
        self.assertNotIn(_slot_id(13, 30), held)
        # The pre-surplus morning is still held: the target is not reached yet.
        self.assertIn(_slot_id(9, 30), held)

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

    def test_already_at_target_holds_nothing(self) -> None:
        # needed <= 0 -> the battery is at target before the window even opens,
        # so the hold has nothing to protect from the first slot on.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context(), current_soc=100.0),
            _make_config(),
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_the_hold_ends_where_the_charge_set_reaches_target(self) -> None:
        # 4 kWh need, 0.5 kWh per slot: the cheapest eight are 13:00-13:45
        # (1.0) and 12:00-12:45 (2.0), so the charge set opens at 12:00. Nothing
        # from there on is held, and the held set is exactly the run before it.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=_day_context()), _make_config()
        )
        held = _held_slot_ids(result)
        self.assertEqual(max(held), _slot_id(11, 45))
        self.assertNotIn(_slot_id(13, 30), held)

    def test_slots_after_target_are_freed_even_without_surplus(self) -> None:
        """Breathing room is not confined to the slots the ranking saw.

        The ranking only ever contains slots with surplus, but a slot with none
        is still one the battery should be free to move in once it is full — so
        the release runs over the day's slots, not over the candidates.
        """
        # Surplus stops at 12:00, so 12:00-13:30 are the only ranked slots after
        # the 4 kWh need is covered... and the day's remaining slots have none.
        series = [
            point
            for point in _surplus_series()
            if point["timestamp"] < _slot_id(12, 0)
        ]
        result = build_charge_hold_optimizer(
            _make_config(window_end="14:00")
        ).optimize(
            _make_snapshot(day_context=_day_context(), surplus_series=series),
            _make_config(window_end="14:00"),
        )
        held = _held_slot_ids(result)
        # 10:00-11:45 is 4 kWh of surplus and covers the need exactly, so the
        # target lands at 11:45 and the surplus-less rest of the window is free.
        self.assertEqual(max(held), _slot_id(9, 45))
        self.assertNotIn(_slot_id(12, 0), held)
        self.assertNotIn(_slot_id(13, 30), held)

    def test_need_is_measured_from_the_forecast_soc_at_the_window_start(self) -> None:
        # The battery reads 60% now but the forecast has it down to 30% by the
        # time the window opens, so the need is 7 kWh rather than 4 — and the
        # charge set grows from the eight cheapest slots to the fourteen
        # cheapest. The last two come from the four equal 4.0 slots, and they
        # are the two next to 11:00, so the charge runs unbroken from 10:30.
        # Sizing this off the run-time reading is what held 10:00–11:30 while
        # the battery was still 30 points short.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                day_context=_day_context(),
                current_soc=60.0,
                surplus_series=_series_with_soc(30.0),
            ),
            _make_config(),
        )
        held = _held_slot_ids(result)
        self.assertEqual(
            held,
            {
                _slot_id(hour, minute)
                for hour in range(6, 10)
                for minute in (0, 15, 30, 45)
            }
            | {_slot_id(10, 0), _slot_id(10, 15)},
        )

    def test_a_forecast_soc_above_the_reading_shrinks_the_charge_set(self) -> None:
        # The correction runs both ways: a battery the forecast fills overnight
        # needs less of the cheap band, not more. 80% leaves 2 kWh to cover, so
        # only the two cheapest slots are released.
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                day_context=_day_context(),
                current_soc=60.0,
                surplus_series=_series_with_soc(80.0),
            ),
            _make_config(),
        )
        held = _held_slot_ids(result)
        self.assertIn(_slot_id(12, 0), held)
        self.assertIn(_slot_id(12, 30), held)
        self.assertNotIn(_slot_id(13, 0), held)
        self.assertNotIn(_slot_id(13, 30), held)

    def test_the_starting_soc_is_recorded_on_the_room_gate(self) -> None:
        _, trace = run_optimizer_with_trace(
            build_charge_hold_optimizer(_make_config()),
            _make_snapshot(
                day_context=_day_context(),
                current_soc=60.0,
                surplus_series=_series_with_soc(30.0),
            ),
            _make_config(),
            reference_time=REFERENCE_TIME,
        )
        gate = _gate(_slots_by_id(trace)[_slot_id(10, 30)], "hold_room")
        self.assertEqual(gate["params"]["startSocPct"], 30.0)
        self.assertEqual(gate["params"]["neededKwh"], 7.0)

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
        step = trace_rows_payload(trace)["steps"][0]

        slots = _slots_by_id(trace)
        held = slots[_slot_id(10, 0)]
        self.assertEqual(held["verdict"], "execute")
        self.assertEqual(_gate(held, "day_context")["state"], "true")
        matched = _gate(held, "day_group_matched")
        self.assertEqual(matched["state"], "true")
        self.assertEqual(matched["params"]["solarToConsumptionRatio"], 2.0)
        self.assertEqual(
            matched["params"]["denominatorOptimizerId"], DENOMINATOR_OPTIMIZER_ID
        )
        self.assertEqual(_gate(held, "hold_window")["state"], "true")
        self.assertEqual(_gate(held, "hold_room")["state"], "true")
        rank = _gate(held, "cheapest_rank")
        # 10:00 opens the dearest hour of the day, so it ranks below every
        # cheaper slot and lost to a marginal price of 2.0. Its equal-price
        # hour ranks from 10:45 back, next to the cheaper 11:00, so it is last.
        self.assertEqual(rank["state"], "true")
        self.assertEqual(rank["params"]["rank"], 16)
        self.assertEqual(rank["params"]["rankOf"], 16)
        self.assertEqual(rank["params"]["price"], 4.0)
        self.assertEqual(rank["params"]["marginalPrice"], 2.0)
        # It supplies none of the need, so it is quoted no running total.
        self.assertIsNone(rank["params"]["cumulativeKwh"])

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
        self.assertEqual(released["verdict"], "skip")
        self.assertEqual(_gate(released, "hold_window")["state"], "true")
        self.assertEqual(_gate(released, "hold_room")["state"], "true")
        rank = _gate(released, "cheapest_rank")
        self.assertEqual(rank["state"], "false")
        self.assertEqual(rank["params"]["rank"], 1)  # cheapest slot of the day
        self.assertEqual(rank["params"]["cumulativeKwh"], 0.5)
        self.assertEqual(rank["params"]["thresholdKwh"], 4.0)

        # A window slot with no surplus takes no rank at all — it is held for
        # want of anywhere to charge, not for losing a comparison.
        dark = slots[_slot_id(7, 0)]
        self.assertEqual(dark["verdict"], "execute")
        self.assertEqual(_gate(dark, "cheapest_rank")["state"], "true")
        self.assertIsNone(_gate(dark, "cheapest_rank")["params"]["rank"])

        # Outside the window the ranking never applies: absent, not false.
        outside = slots[_slot_id(5, 30)]
        self.assertEqual(_gate(outside, "hold_window")["state"], "false")
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
        self.assertEqual(in_window["verdict"], "skip")
        room = _gate(in_window, "hold_room")
        self.assertEqual(room["state"], "false")
        self.assertGreater(room["params"]["neededKwh"], room["params"]["surplusAtWindowStart"])
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
        self.assertEqual(slot["verdict"], "skip")
        self.assertEqual(_gate(slot, "day_context")["state"], "true")
        matched = _gate(slot, "day_group_matched")
        self.assertEqual(matched["state"], "false")
        self.assertEqual(matched["params"]["classification"], "deficit")
        # The reading behind the band, not just its name: the band is resolved
        # per optimizer now, so the trace has to name the denominator (#264).
        self.assertEqual(matched["params"]["solarToConsumptionRatio"], 2.0)
        self.assertEqual(
            matched["params"]["denominatorOptimizerId"], DENOMINATOR_OPTIMIZER_ID
        )
        self.assertEqual(matched["params"]["failingCondition"], "run_when")
        # Keyed `conditionValue`, like appliance_runtime's equivalent gate, and
        # carrying the classifications the group does allow.
        self.assertEqual(matched["params"]["conditionValue"], ["surplus"])
        # The window is never reached once the day itself is out.
        self.assertIsNone(_gate(slot, "hold_window"))

    def test_battery_params_missing_retains_skipped_status(self) -> None:
        day_context = _day_context()
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=day_context, battery_configured=False)
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace_rows_payload(trace)["steps"][0]

        # Nothing was evaluated at all; only the status keeps that apart from a
        # horizon where every slot genuinely failed.
        explanation = explanation_rows(trace)
        self.assertEqual(explanation["status"], "skipped")
        self.assertEqual(explanation.get("statusReason"), "battery_params_missing")
        self.assertEqual({slot["verdict"] for slot in explanation["slots"]}, {"skip"})


def _series_rising_from(soc_pct: float, *, day_offset: int = 0) -> list[dict[str, object]]:
    """The surplus series with a SoC trajectory: ``soc_pct`` overnight, then
    each 0.5 kWh surplus bucket lifting a 10 kWh battery by 5 points."""
    shift = timedelta(days=day_offset)
    overnight, *surplus = _series_with_soc(soc_pct)
    series = [dict(overnight)]
    for index, point in enumerate(surplus):
        series.append(dict(point, socPct=soc_pct + 5.0 * (index + 1)))
    for point in series:
        point["timestamp"] = (
            datetime.fromisoformat(point["timestamp"]) + shift
        ).isoformat(timespec="seconds")
    return series


_BELOW_FLOOR = {
    _slot_id(hour, minute) for hour in range(6, 10) for minute in (0, 15, 30, 45)
} | {_slot_id(10, 0)}


class ChargeHoldMinSocTests(unittest.TestCase):
    """``battery_first.min_soc``: no hold while the battery enters below it.

    The battery sits at 15% until the 10:00 surplus lifts it to 20%, so every
    window slot up to and including 10:00 enters below a 20% floor. Target 90
    from 15 is 7.5 kWh: without a floor that is the fifteen cheapest surplus
    slots, and 06:00-10:00 is held.
    """

    def _run(self, config, snapshot=None):
        return run_optimizer_with_trace(
            build_charge_hold_optimizer(config),
            snapshot
            or _make_snapshot(
                day_context=_day_context(),
                surplus_series=_series_rising_from(15.0),
            ),
            config,
            reference_time=REFERENCE_TIME,
        )

    def test_without_a_floor_the_low_morning_is_held(self) -> None:
        result, _ = self._run(_make_config(target_soc=90))
        self.assertEqual(_held_slot_ids(result), _BELOW_FLOOR)

    def test_below_floor_slots_charge_and_seed_the_need(self) -> None:
        result, trace = self._run(_make_config(target_soc=90, min_soc=20))
        assert_trace_contract(self, trace)
        # 10:00's 0.5 kWh counts first, so the ranking needs fourteen slots, not
        # fifteen: 13:xx, 12:xx, 11:xx and two of the tied 10:xx. 10:00 charges,
        # so it counts as picked and the tie runs on from it: 10:15 and 10:30,
        # leaving 10:45 the one slot still held.
        self.assertEqual(_held_slot_ids(result), {_slot_id(10, 45)})

        slots = _slots_by_id(trace)
        below = _gate(slots[_slot_id(7, 0)], "above_min_soc")
        self.assertEqual(below["state"], "false")
        self.assertEqual(below["params"], {"socPct": 15.0, "minSoc": 20})
        self.assertIsNone(_gate(slots[_slot_id(7, 0)], "cheapest_rank"))
        self.assertEqual(_gate(slots[_slot_id(10, 0)], "above_min_soc")["state"], "false")

        held = slots[_slot_id(10, 45)]
        above = _gate(held, "above_min_soc")
        self.assertEqual(above["state"], "true")
        self.assertEqual(above["params"], {"socPct": 30.0, "minSoc": 20})
        rank = _gate(held, "cheapest_rank")
        self.assertEqual(rank["state"], "true")
        # Below-floor slots take no place in the ranking.
        self.assertEqual(rank["params"]["rankOf"], 15)

        released = slots[_slot_id(12, 0)]
        self.assertEqual(_gate(released, "above_min_soc")["state"], "true")
        self.assertEqual(_gate(released, "cheapest_rank")["state"], "false")
        self.assertEqual(_gate(released, "hold_room")["params"]["minSoc"], 20)

    def test_a_group_override_applies_on_its_day_only(self) -> None:
        tomorrow = DAY + timedelta(days=1)
        snapshot = _make_snapshot(
            day_context=_day_context(),
            surplus_series=_series_rising_from(15.0)
            + _series_rising_from(15.0, day_offset=1),
        )
        snapshot.context.day_contexts[tomorrow] = replace(
            _day_context(classification="deficit"), local_date=tomorrow
        )
        config = _make_config(
            target_soc=90,
            groups=[
                {
                    "run_when": ["surplus"],
                    "params": {"battery_first": {"min_soc": 20}},
                },
                {"run_when": ["deficit"]},
            ],
        )
        result, trace = self._run(config, snapshot)
        held = _held_slot_ids(result)
        tomorrow_morning = (
            datetime(2026, 7, 11, 7, 0, tzinfo=TZ).isoformat(timespec="seconds")
        )

        self.assertNotIn(_slot_id(7, 0), held)
        self.assertIn(tomorrow_morning, held)
        gate = _gate(_slots_by_id(trace)[tomorrow_morning], "above_min_soc")
        self.assertEqual(gate["state"], "true")
        self.assertEqual(gate["params"]["minSoc"], 0)

    def _run_series(self, config, overnight_soc, rows, prices_by_hour):
        """Run over a hand-built forecast: ``rows`` are
        ``(hour, minute, solar_kwh, house_kwh, soc_pct)`` 15-minute buckets
        behind a 05:30 overnight point at ``overnight_soc``."""
        overnight = {
            "timestamp": datetime(2026, 7, 10, 5, 30, tzinfo=TZ).isoformat(
                timespec="seconds"
            ),
            "solarKwh": 0.0,
            "baselineHouseKwh": 0.0,
            "durationHours": 0.5,
            "socPct": overnight_soc,
        }
        series = [overnight] + [
            {
                "timestamp": _slot_id(hour, minute),
                "solarKwh": solar,
                "baselineHouseKwh": house,
                "durationHours": 0.25,
                "socPct": soc,
            }
            for hour, minute, solar, house, soc in rows
        ]
        return self._run(
            config,
            _make_snapshot(
                day_context=_day_context(),
                surplus_series=series,
                export_price_points=_export_price_points(prices_by_hour),
            ),
        )

    def test_a_zero_need_holds_nothing_for_below_floor_slots(self) -> None:
        # 55% entering 06:00 against a 50% target: nothing to charge. The
        # pre-dawn drain dips under the 20% floor at 08:00-08:45 (08:45 with a
        # little surplus); that must not turn the morning into a hold.
        drain = [(hour, minute) for hour in (6, 7) for minute in (0, 15, 30, 45)]
        rows = [
            (hour, minute, 0.0, 0.5, max(18.0, 55.0 - 5.0 * (index + 1)))
            for index, (hour, minute) in enumerate(drain)
        ] + [
            (8, 0, 0.0, 0.0, 18.0),
            (8, 15, 0.0, 0.0, 18.0),
            (8, 30, 0.0, 0.0, 18.0),
            (8, 45, 0.5, 0.0, 23.0),
        ]
        result, trace = self._run_series(
            _make_config(target_soc=50, min_soc=20), 55.0, rows, {}
        )
        assert_trace_contract(self, trace)
        self.assertEqual(_held_slot_ids(result), set())
        slots = _slots_by_id(trace)
        for minute in (0, 15, 30, 45):
            gate = _gate(slots[_slot_id(8, minute)], "above_min_soc")
            self.assertEqual(gate["state"], "false")

    def test_a_dry_below_floor_slot_does_not_delay_the_release(self) -> None:
        # 70% -> 90% is 2 kWh: the four 10:xx slots, done by 10:45. A load spike
        # takes 12:30 under the floor with no surplus; it adds no charge, so
        # 11:00-12:15 stay released rather than held up to it.
        rows = [
            (10, minute, 0.5, 0.0, 75.0 + minute / 3) for minute in (0, 15, 30, 45)
        ] + [(12, 15, 0.0, 7.5, 15.0), (12, 30, 0.0, 0.0, 25.0)]
        result, trace = self._run_series(
            _make_config(target_soc=90, min_soc=20), 70.0, rows, {10: 1.0}
        )
        assert_trace_contract(self, trace)
        self.assertEqual(
            _held_slot_ids(result),
            {_slot_id(hour, minute) for hour in range(6, 10) for minute in (0, 15, 30, 45)},
        )
        gate = _gate(_slots_by_id(trace)[_slot_id(12, 30)], "above_min_soc")
        self.assertEqual(gate["state"], "false")

    def test_charging_below_floor_slots_count_as_picked_for_ties(self) -> None:
        # 10% -> 40% is 3 kWh. 06:00-06:45 enter below 20% and bring 2 kWh;
        # 10:45 is cheapest, then 07:00 and 11:00 tie. 07:00 continues the
        # below-floor run, so it wins over 11:00 (next to 10:45) instead of the
        # battery charging to 07:00, holding 07:00, and charging again later.
        rows = [
            (6, 0, 0.5, 0.0, 12.0),
            (6, 15, 0.5, 0.0, 14.0),
            (6, 30, 0.5, 0.0, 16.0),
            (6, 45, 0.5, 0.0, 20.0),
            (7, 0, 0.5, 0.0, 25.0),
            (10, 45, 0.5, 0.0, 30.0),
            (11, 0, 0.5, 0.0, 35.0),
        ]
        result, trace = self._run_series(
            _make_config(target_soc=40, min_soc=20),
            10.0,
            rows,
            {7: 2.0, 10: 1.0, 11: 2.0},
        )
        assert_trace_contract(self, trace)
        held = {
            _slot_id(hour, minute) for hour in range(7, 11) for minute in (0, 15, 30, 45)
        } - {_slot_id(7, 0), _slot_id(10, 45)}
        self.assertEqual(_held_slot_ids(result), held)


from automation_trace_contract import trace_rows_payload

if __name__ == "__main__":
    unittest.main()
