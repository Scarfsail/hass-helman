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
from custom_components.helman.const import SCHEDULE_SLOT_MINUTES  # noqa: E402
from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
    ImportBand,
)
from custom_components.helman.automation.optimizers.charge_from_grid import (  # noqa: E402
    build_charge_from_grid_optimizer,
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


def _node(slot, key: str, group_index: int = 0):
    group = next(group for group in slot.groups if group.index == group_index)
    return next(node for node in group.conditions if node.key == key)


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 10, hour, minute, tzinfo=TZ)


def _slot_id(hour: int, minute: int = 0) -> str:
    return _at(hour, minute).isoformat(timespec="seconds")


def _soc_series(soc_by_hour: dict[int, float]) -> list[dict[str, object]]:
    # Build 30-min socPct series across the day from an hour->soc map (step-held).
    series = []
    cursor = _at(0)
    end = _at(0) + timedelta(days=1)
    current = soc_by_hour.get(0, 50.0)
    while cursor < end:
        if cursor.minute == 0 and cursor.hour in soc_by_hour:
            current = soc_by_hour[cursor.hour]
        series.append(
            {"timestamp": cursor.isoformat(timespec="seconds"), "socPct": current}
        )
        cursor += timedelta(minutes=30)
    return series


def _import_points(price_by_hour: dict[int, float]) -> list[dict[str, object]]:
    points = []
    cursor = _at(0)
    end = _at(0) + timedelta(days=1)
    current = price_by_hour.get(0, 3.0)
    while cursor < end:
        if cursor.minute == 0 and cursor.hour in price_by_hour:
            current = price_by_hour[cursor.hour]
        points.append(
            {"timestamp": cursor.isoformat(timespec="seconds"), "value": current}
        )
        cursor += timedelta(minutes=30)
    return points


def _day_context(bands: tuple[ImportBand, ...]) -> DayContext:
    return DayContext(
        local_date=DAY,
        classification="tight",
        predicted_solar_kwh=5.0,
        predicted_consumption_kwh=5.0,
        export_price_min=1.0,
        export_price_max=5.0,
        import_bands=bands,
    )


def _make_snapshot(
    *,
    soc_series: list[dict[str, object]],
    import_points: list[dict[str, object]],
    bands: tuple[ImportBand, ...],
    schedule_document: ScheduleDocument | None = None,
    battery_configured: bool = True,
) -> OptimizationSnapshot:
    battery_state = (
        types.SimpleNamespace(current_soc=50.0, min_soc=10.0, max_soc=100.0)
        if battery_configured
        else None
    )
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={"status": "available", "series": soc_series},
        grid_forecast={"status": "available", "series": []},
        context=OptimizationContext(
            now=REFERENCE_TIME,
            battery_state=battery_state,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": 3.0,
                "points": import_points,
            },
            export_price_forecast={"unit": "CZK/kWh", "currentPrice": 2.0, "points": []},
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id={},
            battery_max_charge_power_kw=5.0,
            battery_usable_capacity_kwh=10.0,
            battery_charge_efficiency=1.0,
            runtime_hours_by_appliance_id_by_local_date={},
            day_contexts={DAY: _day_context(bands)},
        ),
    )


def _make_config(
    *, reserve_floor_soc: int = 30, margin_pct: int = 0, max_target_soc: int = 100
) -> OptimizerInstanceConfig:
    return make_optimizer_config(
        id="grid-bridge-charge",
        kind="charge_from_grid",
        params={"margin_pct": margin_pct, "max_target_soc": max_target_soc},
        conditions=[{"reserve_floor_soc": reserve_floor_soc}],
    )


def _charge_slots(result: ScheduleDocument) -> dict[str, int]:
    return {
        slot_id: inverter_action(actions).target_soc
        for slot_id, actions in result.slots.items()
        if inverter_action(actions).kind == "charge_to_target_soc"
        and inverter_action(actions).set_by == "automation"
    }


# Cheap band 06:00-08:00, expensive band 08:00-10:00.
_BANDS = (
    ImportBand(level="cheap", start=_at(6), end=_at(8)),
    ImportBand(level="expensive", start=_at(8), end=_at(10)),
)


class ChargeFromGridOptimizerTests(unittest.TestCase):
    def test_charges_cheapest_slots_to_bridge_dip(self) -> None:
        # SoC dips to 20 during expensive window (floor 30 -> dip 10).
        # window_start_soc (08:00) = 40 -> target = 40 + 10 = 50.
        # cheap_start_soc (06:00) = 45 -> gap 5 pts -> 0.5 kWh -> 1 slot.
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 2.0, 8: 6.0})  # cheap slots equal price
        # make 07:00 the cheapest cheap slot
        prices = _import_points({6: 3.0, 8: 6.0})
        prices_map = {p["timestamp"]: p for p in prices}
        prices_map[_slot_id(7, 0)]["value"] = 1.0
        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS),
            _make_config(),
        )
        charged = _charge_slots(result)
        self.assertEqual(list(charged), [_slot_id(7, 0)])
        self.assertEqual(charged[_slot_id(7, 0)], 50)

    def test_skips_when_window_never_dips_below_floor(self) -> None:
        soc = _soc_series({0: 80, 6: 80, 8: 70, 9: 60, 10: 60})
        prices = _import_points({6: 2.0, 8: 6.0})
        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS),
            _make_config(),
        )
        self.assertEqual(_charge_slots(result), {})

    def test_clamps_target_to_max_target_soc(self) -> None:
        # Big dip pushes target above cap; clamp to max_target_soc=60.
        soc = _soc_series({0: 55, 6: 55, 8: 55, 9: 5, 10: 60})
        prices = _import_points({6: 2.0, 8: 6.0})
        result = build_charge_from_grid_optimizer(
            _make_config(max_target_soc=60)
        ).optimize(
            _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS),
            _make_config(max_target_soc=60),
        )
        charged = _charge_slots(result)
        self.assertTrue(charged)
        for target in charged.values():
            self.assertEqual(target, 60)

    def test_no_bands_no_op(self) -> None:
        soc = _soc_series({0: 20, 6: 20, 8: 20})
        prices = _import_points({6: 2.0})
        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(soc_series=soc, import_points=prices, bands=()),
            _make_config(),
        )
        self.assertEqual(_charge_slots(result), {})

    def test_leaves_user_owned_slots_untouched(self) -> None:
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 3.0, 8: 6.0})
        prices_map = {p["timestamp"]: p for p in prices}
        prices_map[_slot_id(7, 0)]["value"] = 1.0
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                _slot_id(7, 0): {
                    "inverter": {"kind": "normal", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(
                soc_series=soc,
                import_points=prices,
                bands=_BANDS,
                schedule_document=schedule_document,
            ),
            _make_config(),
        )
        charged = _charge_slots(result)
        # 07:00 is user-owned; the next cheapest cheap slot is chosen instead.
        self.assertNotIn(_slot_id(7, 0), charged)
        self.assertEqual(len(charged), 1)

    def test_does_not_mutate_snapshot_schedule(self) -> None:
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 3.0, 8: 6.0})
        snapshot = _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS)
        before = deepcopy(snapshot.schedule.slots)
        build_charge_from_grid_optimizer(_make_config()).optimize(
            snapshot, _make_config()
        )
        self.assertEqual(snapshot.schedule.slots, before)


class ChargeFromGridTraceContractTests(unittest.TestCase):
    def test_bridge_and_ranking_reasons_and_contract(self) -> None:
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 3.0, 8: 6.0})
        prices_map = {p["timestamp"]: p for p in prices}
        prices_map[_slot_id(7, 0)]["value"] = 1.0
        optimizer = build_charge_from_grid_optimizer(_make_config())
        snapshot = _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS)

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        applied = [d for d in step["decisions"] if d["outcome"] == "applied"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0]["slotIds"], [_slot_id(7, 0)])

        slots = _slots_by_id(trace)
        chosen = slots[_slot_id(7, 0)]
        self.assertEqual(chosen.verdict, "execute")
        self.assertEqual(_gate(chosen, "window_soc_known").state, "true")
        self.assertEqual(_gate(chosen, "charge_needed").state, "true")
        self.assertEqual(_gate(chosen, "slot_available").state, "true")
        # Ownership is stated once, by the node the ranking owns; the writer's
        # veto would only repeat it.
        self.assertIsNone(_gate(chosen, "blocked_user_owned"))
        rank = _gate(chosen, "cheapest_rank")
        self.assertEqual(rank.state, "true")
        self.assertEqual(rank.params["rank"], 1)
        self.assertEqual(rank.params["slotsNeeded"], 1)

    def test_ranking_is_an_ordinal_not_a_boolean(self) -> None:
        """A slot that lost to cheaper ones carries its position, not a code."""
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 3.0, 8: 6.0})
        prices_map = {p["timestamp"]: p for p in prices}
        prices_map[_slot_id(7, 0)]["value"] = 1.0
        optimizer = build_charge_from_grid_optimizer(_make_config())
        snapshot = _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS)

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        slots = _slots_by_id(trace)
        loser = slots[_slot_id(6, 0)]
        self.assertEqual(loser.verdict, "skip")
        rank = _gate(loser, "cheapest_rank")
        self.assertEqual(rank.state, "false")
        self.assertGreater(rank.params["rank"], rank.params["slotsNeeded"])
        # The whole 06:00-08:00 window is ranked.
        self.assertEqual(rank.params["rankOf"], 2 * (60 // SCHEDULE_SLOT_MINUTES))
        self.assertEqual(rank.params["chosenPrice"], 1.0)
        # Everything upstream of the ranking still passed for this slot.
        self.assertEqual(_gate(loser, "charge_needed").state, "true")
        self.assertEqual(_gate(loser, "cheap_window_capacity").state, "true")

    def test_a_user_owned_cheap_slot_never_reaches_the_ranking(self) -> None:
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 3.0, 8: 6.0})
        prices_map = {p["timestamp"]: p for p in prices}
        prices_map[_slot_id(7, 0)]["value"] = 1.0
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                _slot_id(7, 0): {
                    "inverter": {"kind": "normal", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        optimizer = build_charge_from_grid_optimizer(_make_config())
        snapshot = _make_snapshot(
            soc_series=soc,
            import_points=prices,
            bands=_BANDS,
            schedule_document=schedule_document,
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        owned = _slots_by_id(trace)[_slot_id(7, 0)]
        self.assertEqual(owned.verdict, "skip")
        self.assertEqual(_gate(owned, "slot_available").state, "false")
        # Dropped before the ranking, so it has no rank at all.
        self.assertIsNone(_gate(owned, "cheapest_rank"))

    def test_window_covered_resolves_the_floor_as_a_window_scoped_node(self) -> None:
        """`reserve_floor_soc` is self-gating: the rails leave it unevaluated.

        It is answered per *expensive* band while the slots carrying the answer
        lie in the *preceding cheap* one, so the node is window-scoped — a
        run-scoped cell would span a horizon whose answer changes per band.
        """
        soc = _soc_series({0: 80, 6: 80, 8: 70, 9: 60, 10: 60})
        prices = _import_points({6: 2.0, 8: 6.0})
        optimizer = build_charge_from_grid_optimizer(_make_config())
        snapshot = _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS)

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)

        slots = _slots_by_id(trace)
        cheap = slots[_slot_id(6, 0)]
        floor = _node(cheap, "reserve_floor_soc")
        self.assertEqual(floor.state, "false")  # covered: no dip below the floor
        self.assertEqual(floor.scope, "window")
        self.assertEqual(floor.value, 30)
        self.assertEqual(floor.actual, 60.0)  # the window's projected minimum
        self.assertEqual(cheap.verdict, "skip")

        # A slot no bridging window reaches keeps the unevaluated placeholder:
        # nothing consulted the floor there.
        untouched = slots[_slot_id(20, 0)]
        self.assertEqual(_node(untouched, "reserve_floor_soc").state, "not_evaluated")
        self.assertIsNone(_gate(untouched, "window_soc_known"))

    def test_battery_params_missing_is_a_skipped_step(self) -> None:
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 3.0, 8: 6.0})
        optimizer = build_charge_from_grid_optimizer(_make_config())
        snapshot = _make_snapshot(
            soc_series=soc,
            import_points=prices,
            bands=_BANDS,
            battery_configured=False,
        )

        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )

        assert_trace_contract(self, trace)
        explanation = _explanation(trace)
        self.assertEqual(explanation.status, "skipped")
        self.assertEqual(explanation.status_reason, "battery_params_missing")
        self.assertEqual({slot.verdict for slot in explanation.slots}, {"skip"})


if __name__ == "__main__":
    unittest.main()
