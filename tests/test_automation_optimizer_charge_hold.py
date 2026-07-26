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
    DayMinWindow,
)
from custom_components.helman.automation.optimizers.charge_hold import (  # noqa: E402
    build_charge_hold_optimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import ScheduleDocument  # noqa: E402
from custom_components.helman.appliances import AppliancesRuntimeRegistry  # noqa: E402
from automation_config_builders import make_optimizer_config  # noqa: E402
from automation_trace_contract import (  # noqa: E402
    assert_trace_contract,
    run_optimizer_with_trace,
)


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


def _day_context(
    *,
    classification: str = "surplus",
    day_min_window: DayMinWindow | None = None,
) -> DayContext:
    return DayContext(
        local_date=DAY,
        classification=classification,
        predicted_solar_kwh=8.0,
        predicted_consumption_kwh=4.0,
        export_price_min=1.0,
        export_price_max=5.0,
        day_min_window=day_min_window,
        import_bands=(),
    )


def _make_snapshot(
    *,
    schedule_document: ScheduleDocument | None = None,
    current_soc: float = 60.0,
    day_context: DayContext | None = None,
    battery_configured: bool = True,
    surplus_series: list[dict[str, object]] | None = None,
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
            export_price_forecast={"unit": "CZK/kWh", "currentPrice": 2.0, "points": []},
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
        for slot_id, domains in result.slots.items()
        if domains.inverter.kind == "stop_charging"
        and domains.inverter.set_by == "automation"
    }


class ChargeHoldOptimizerTests(unittest.TestCase):
    def test_holds_until_latest_safe_release_bounded_by_price_min(self) -> None:
        # latest_safe_release = 12:00 (needed 4 kWh, surplus_after(12:00)=4).
        # day_min_window.start = 13:00 -> release = min(13:00, 12:00) = 12:00.
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context), _make_config()
        )
        held = _held_slot_ids(result)
        self.assertIn(_slot_id(6, 0), held)
        self.assertIn(_slot_id(11, 30), held)
        self.assertNotIn(_slot_id(12, 0), held)
        self.assertNotIn(_slot_id(5, 30), held)
        self.assertEqual(len(held), 12)

    def test_price_min_moves_release_earlier(self) -> None:
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 9, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 9, 30, tzinfo=TZ),
            )
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context), _make_config()
        )
        held = _held_slot_ids(result)
        self.assertIn(_slot_id(8, 30), held)
        self.assertNotIn(_slot_id(9, 0), held)
        self.assertEqual(len(held), 6)  # 06:00..08:30

    def test_gate_skips_non_surplus_day(self) -> None:
        day_context = _day_context(classification="deficit")
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context), _make_config()
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_no_room_when_surplus_cannot_cover_need(self) -> None:
        # target 100, current 10 -> needed 9 kWh > 8 kWh total surplus.
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context, current_soc=10.0),
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

    def test_already_full_holds_whole_window_bounded_by_price(self) -> None:
        # needed <= 0 -> hold whole window, bounded by price min at 13:00.
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context, current_soc=100.0),
            _make_config(),
        )
        held = _held_slot_ids(result)
        self.assertIn(_slot_id(12, 30), held)
        self.assertNotIn(_slot_id(13, 0), held)

    def test_leaves_user_owned_inverter_untouched(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                _slot_id(6, 0): {
                    "inverter": {"kind": "normal", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(
                schedule_document=schedule_document, day_context=day_context
            ),
            _make_config(),
        )
        self.assertEqual(result.slots[_slot_id(6, 0)].inverter.kind, "normal")
        self.assertNotIn(_slot_id(6, 0), _held_slot_ids(result))

    def test_no_battery_state_writes_nothing(self) -> None:
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        result = build_charge_hold_optimizer(_make_config()).optimize(
            _make_snapshot(day_context=day_context, battery_configured=False),
            _make_config(),
        )
        self.assertEqual(_held_slot_ids(result), set())

    def test_does_not_mutate_snapshot_schedule(self) -> None:
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        snapshot = _make_snapshot(day_context=day_context)
        before = deepcopy(snapshot.schedule.slots)
        build_charge_hold_optimizer(_make_config()).optimize(snapshot, _make_config())
        self.assertEqual(snapshot.schedule.slots, before)


class ChargeHoldTraceContractTests(unittest.TestCase):
    def test_matched_day_full_coverage_and_applied_reason(self) -> None:
        day_context = _day_context(
            day_min_window=DayMinWindow(
                start=datetime(2026, 7, 10, 13, 0, tzinfo=TZ),
                end=datetime(2026, 7, 10, 13, 30, tzinfo=TZ),
            )
        )
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=day_context)
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        applied = [d for d in step["decisions"] if d["outcome"] == "applied"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0]["reason"]["code"], "hold_window_applied")
        self.assertEqual(applied[0]["reason"]["params"]["boundBy"], "surplus")

    def test_non_matched_day_emits_day_not_matched(self) -> None:
        day_context = _day_context(classification="deficit")
        optimizer = build_charge_hold_optimizer(_make_config())
        snapshot = _make_snapshot(day_context=day_context)
        _result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        self.assertTrue(
            any(
                d["reason"]["code"] == "day_not_matched"
                for d in step["decisions"]
            )
        )

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


if __name__ == "__main__":
    unittest.main()
