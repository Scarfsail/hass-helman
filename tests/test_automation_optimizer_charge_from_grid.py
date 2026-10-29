from __future__ import annotations

import types
import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from unittest.mock import patch

from _ha_stubs import stub_ha_dt, stub_module


TZ = timezone(timedelta(hours=2))
REFERENCE_TIME = datetime(2026, 7, 10, 5, 0, tzinfo=TZ)
DAY = date(2026, 7, 10)

def _install_import_stubs() -> None:

    # ``battery_state`` imports ``HomeAssistant`` only for annotations; stubbing
    # it lets the real horizon simulator load.
    core_mod = stub_module("homeassistant.core")
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = object
    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_ha_dt()
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.config import OptimizerInstanceConfig  # noqa: E402
from custom_components.helman.automation.fields import AutomationConfigError  # noqa: E402
from custom_components.helman.const import SCHEDULE_SLOT_MINUTES  # noqa: E402
from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
    ImportBand,
)
from custom_components.helman.automation.optimizers.charge_from_grid import (  # noqa: E402
    _build_import_band_timeline,
    build_charge_from_grid_optimizer,
)
from _fakes import make_optimization_context  # noqa: E402
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleAction,
    ScheduleDocument,
    build_controllable_actions,
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


def _node(slot, key: str, group_index: int = 0):
    group = next(group for group in slot["groups"] if group["index"] == group_index)
    return next(node for node in group["conditions"] if node["key"] == key)


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
    day_contexts: dict[date, DayContext] | None = None,
    now: datetime = REFERENCE_TIME,
    battery_max_soc: float = 100.0,
) -> OptimizationSnapshot:
    battery_state = (
        types.SimpleNamespace(
            current_soc=50.0,
            min_soc=10.0,
            max_soc=battery_max_soc,
            nominal_capacity_kwh=10.0,
        )
        if battery_configured
        else None
    )
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={"status": "available", "series": soc_series},
        grid_forecast={"status": "available", "series": []},
        context=make_optimization_context(
            now=now,
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
            battery_charge_efficiency=1.0,
            runtime_hours_by_appliance_id_by_local_date={},
            day_contexts=day_contexts or {DAY: _day_context(bands)},
        ),
    )


def _make_config(*, reserve_floor_soc: int = 30) -> OptimizerInstanceConfig:
    return make_optimizer_config(
        id="grid-bridge-charge",
        kind="charge_from_grid",
        params={},
        conditions=[{"reserve_floor_soc": reserve_floor_soc}],
    )


def _charge_slots(result: ScheduleDocument) -> dict[str, int]:
    return {
        slot_id: inverter_action(actions).target_soc
        for slot_id, actions in result.slots.items()
        if inverter_action(actions).kind == "charge_to_target_soc"
        and inverter_action(actions).set_by == "automation"
    }


def _with_real_battery(
    snapshot: OptimizationSnapshot, *, soc: float, battery_max_soc: float
) -> OptimizationSnapshot:
    """Give ``snapshot`` the live state and settings the real simulator needs.

    A lossless 10 kWh battery with a 10 % min SoC, currently at ``soc``.
    """
    from custom_components.helman.battery_state import BatteryLiveState

    return replace(
        snapshot,
        context=replace(
            snapshot.context,
            live=replace(
                snapshot.context.live,
                battery_live_state=BatteryLiveState(
                    current_remaining_energy_kwh=soc / 10,
                    current_soc=soc,
                    min_soc=10.0,
                    max_soc=battery_max_soc,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=1.0,
                    max_energy_kwh=10.0 * battery_max_soc / 100,
                ),
            ),
            battery=replace(
                snapshot.context.battery,
                max_discharge_power_w=5000.0,
                discharge_efficiency=1.0,
            ),
        ),
    )


# Cheap band 06:00-08:00, expensive band 08:00-10:00.
_BANDS = (
    ImportBand(level="cheap", start=_at(6), end=_at(8)),
    ImportBand(level="expensive", start=_at(8), end=_at(10)),
)


class ChargeFromGridOptimizerTests(unittest.TestCase):
    def test_charge_start_margin_slots_defaults_and_rejects_invalid_values(self) -> None:
        defaulted = make_optimizer_config(
            id="grid-bridge-charge",
            kind="charge_from_grid",
            params={},
            conditions=[{"reserve_floor_soc": 30}],
        )
        self.assertEqual(defaulted.params["charge_start_margin_slots"], 2)
        disabled = make_optimizer_config(
            id="grid-bridge-charge",
            kind="charge_from_grid",
            params={"charge_start_margin_slots": 0},
            conditions=[{"reserve_floor_soc": 30}],
        )
        self.assertEqual(disabled.params["charge_start_margin_slots"], 0)
        with self.assertRaises(AutomationConfigError):
            make_optimizer_config(
                id="grid-bridge-charge",
                kind="charge_from_grid",
                params={"charge_start_margin_slots": -1},
                conditions=[{"reserve_floor_soc": 30}],
            )

    def test_retired_sizing_params_are_rejected(self) -> None:
        for key in ("margin_pct", "max_target_soc"):
            with self.subTest(key=key), self.assertRaises(AutomationConfigError):
                make_optimizer_config(
                    id="grid-bridge-charge",
                    kind="charge_from_grid",
                    params={key: 10},
                    conditions=[{"reserve_floor_soc": 30}],
                )

    def test_simulated_preservation_uses_latest_hold_cutoff_without_charging(self) -> None:
        # Four late holds are enough; a simulator-backed plan must not buy
        # energy simply because all cheap slots have the same price.
        result = self._run_with_fake_simulator(holds_needed=4, charges_needed=99)
        actions = {
            slot_id: inverter_action(slot_actions).kind
            for slot_id, slot_actions in result.slots.items()
            if inverter_action(slot_actions).set_by == "automation"
        }
        self.assertEqual(
            list(actions.values()), ["stop_discharging"] * 4
        )
        self.assertEqual(list(actions)[0], _slot_id(7, 0))

    def test_simulated_residual_charges_latest_slots_with_default_margin(self) -> None:
        result = self._run_with_fake_simulator(holds_needed=99, charges_needed=3)
        actions = {
            slot_id: inverter_action(slot_actions).kind
            for slot_id, slot_actions in result.slots.items()
            if inverter_action(slot_actions).set_by == "automation"
        }
        charges = [slot_id for slot_id, kind in actions.items() if kind == "charge_to_target_soc"]
        self.assertEqual(charges, [_slot_id(6, 45), _slot_id(7), _slot_id(7, 15), _slot_id(7, 30), _slot_id(7, 45)])

    def test_written_actions_record_the_optimizer_kind(self) -> None:
        result = self._run_with_fake_simulator(holds_needed=4, charges_needed=3)
        optimizers = {
            inverter_action(slot_actions).optimizer
            for slot_actions in result.slots.values()
            if inverter_action(slot_actions).set_by == "automation"
        }
        self.assertEqual(optimizers, {"charge_from_grid"})

    def test_simulation_does_not_restore_inactive_document_action(self) -> None:
        inactive = ScheduleDocument(slots={
            _slot_id(6): build_controllable_actions(
                inverter=ScheduleAction(
                    kind="stop_discharging",
                    set_by="automation",
                    condition_met=False,
                )
            )
        })
        result = self._run_with_fake_simulator(
            holds_needed=4,
            charges_needed=99,
            schedule_document=inactive,
        )

        # The candidate is omitted by the forecast overlay and must not count
        # as a hold while selecting the latest cutoff.
        holds = [
            slot_id for slot_id, actions in result.slots.items()
            if inverter_action(actions).kind == "stop_discharging"
            and inverter_action(actions).condition_met
        ]
        self.assertEqual(holds, [_slot_id(7), _slot_id(7, 15), _slot_id(7, 30), _slot_id(7, 45)])

    def test_simulated_hold_trace_records_the_actual_action(self) -> None:
        _result, trace = self._run_with_fake_simulator(
            holds_needed=4, charges_needed=99, with_trace=True
        )

        slots = _slots_by_id(trace)
        skipped = slots[_slot_id(6)]
        self.assertEqual(skipped["verdict"], "skip")
        self.assertEqual(_gate(skipped, "slot_available")["state"], "true")
        self.assertEqual(_gate(skipped, "latest_cutoff")["state"], "false")
        selected = slots[_slot_id(7)]
        self.assertEqual(_gate(selected, "latest_cutoff")["state"], "true")

    def test_simulated_trace_marks_user_owned_slots_unavailable(self) -> None:
        owned_slot = _slot_id(6, 30)
        schedule = ScheduleDocument(slots={
            owned_slot: build_controllable_actions(
                inverter=ScheduleAction(kind="normal", set_by="user")
            )
        })
        _result, trace = self._run_with_fake_simulator(
            holds_needed=4,
            charges_needed=99,
            schedule_document=schedule,
            with_trace=True,
        )

        owned = _slots_by_id(trace)[owned_slot]
        self.assertEqual(owned["verdict"], "skip")
        self.assertEqual(_gate(owned, "slot_available")["state"], "false")
        self.assertIsNone(_gate(owned, "latest_cutoff"))

    def test_simulated_holds_when_cheap_window_is_entered_above_target(self) -> None:
        # #285: the battery enters the cheap window at 80% — above the 50%
        # bridge target — and drains to 40% by 08:00.  The entry SoC alone says
        # "not needed"; the simulated boundary says hold.
        result = self._run_with_fake_simulator(
            holds_needed=4,
            charges_needed=99,
            soc={0: 80, 6: 80, 7: 40, 9: 20, 10: 60},
        )
        holds = [
            slot_id for slot_id, actions in result.slots.items()
            if inverter_action(actions).kind == "stop_discharging"
        ]
        self.assertEqual(holds, [_slot_id(7), _slot_id(7, 15), _slot_id(7, 30), _slot_id(7, 45)])

    def test_simulated_writes_nothing_when_boundary_already_reaches_target(self) -> None:
        result, trace = self._run_with_fake_simulator(
            holds_needed=0, charges_needed=99, with_trace=True
        )
        self.assertEqual(result.slots, {})
        # The simulated window never dips below the floor: covered, as on the
        # rail path, so there is no charge_needed gate to answer.
        slot = _slots_by_id(trace)[_slot_id(7, 45)]
        self.assertIsNone(_gate(slot, "charge_needed"))
        self.assertEqual(_gate(slot, "window_soc_known")["state"], "true")
        self.assertEqual(_node(slot, "reserve_floor_soc")["state"], "false")
        self.assertEqual(_node(slot, "reserve_floor_soc")["actual"], 50.0)

    def test_partial_simulation_before_boundary_falls_back_to_rails(self) -> None:
        result = self._run_with_fake_simulator(
            holds_needed=0,
            charges_needed=99,
            trajectory_end=_at(7, 30),
        )

        # The stale simulated value says the target is reached, but it ends one
        # slot before the 08:00 boundary.  Rail sizing still places the bridge.
        self.assertEqual(len(_charge_slots(result)), 1)

    def test_overlapping_windows_do_not_overwrite_an_earlier_plan(self) -> None:
        # Both expensive bands share the 06:00-08:00 cheap band.  The first
        # needs a residual charge; the second is already carried by it and
        # must not replace those charges with holds.
        bands = (
            ImportBand(level="cheap", start=_at(6), end=_at(8)),
            ImportBand(level="expensive", start=_at(8), end=_at(10)),
            ImportBand(level="expensive", start=_at(9), end=_at(11)),
        )
        def boundary_soc(holds: int, charges: int, overrides) -> float:
            if charges >= 3:
                return float(max(
                    action.target_soc
                    for action in overrides.values()
                    if action.kind == "charge_to_target_soc"
                ))
            return 20.0 if holds >= 4 else 0.0

        result = self._run_with_fake_simulator(
            holds_needed=4,
            charges_needed=3,
            soc={0: 45, 6: 45, 7: 40, 8: 15, 10: 50, 11: 60},
            bands=bands,
            boundary_soc=boundary_soc,
        )
        kinds = {
            slot_id: inverter_action(actions).kind
            for slot_id, actions in result.slots.items()
        }
        self.assertEqual(
            [slot_id for slot_id, kind in kinds.items() if kind == "charge_to_target_soc"],
            [_slot_id(6, 45), _slot_id(7), _slot_id(7, 15), _slot_id(7, 30), _slot_id(7, 45)],
        )
        self.assertEqual(set(_charge_slots(result).values()), {30})
        self.assertEqual(
            [slot_id for slot_id, kind in kinds.items() if kind == "stop_discharging"],
            [_slot_id(6), _slot_id(6, 15), _slot_id(6, 30)],
        )

    def test_legacy_target_reads_soc_entering_the_expensive_window(self) -> None:
        # The 08:00 point is the SoC *after* 08:00-08:30; the window is entered
        # with the 07:30 point (45), so the target is 45 + dip 10 = 55.
        soc = _soc_series({0: 45, 6: 45, 8: 40, 9: 20, 10: 60})
        prices = _import_points({6: 2.0, 8: 6.0})
        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(soc_series=soc, import_points=prices, bands=_BANDS),
            _make_config(),
        )
        self.assertEqual(set(_charge_slots(result).values()), {55})

    def test_real_simulation_charges_across_a_normal_band_gap(self) -> None:
        # The battery enters the cheap band at 42 % and would sit at 10 % by
        # 12:00; the window's lowest point (13:45) needs 30 %.  Sixteen normal
        # and eight expensive buckets drain 48 % after charging stops, so the
        # inverter target must be 78 %.  The 07:45 floor charge (entered at
        # 28 %) is raised to it, not replaced.
        result, trace = self._run_with_real_simulator(battery_max_soc=100.0)

        self.assertEqual(
            _charge_slots(result),
            {_slot_id(hour, minute): 78 for hour, minute in (
                (6, 45), (7, 0), (7, 15), (7, 30), (7, 45)
            )},
        )
        slot = _slots_by_id(trace)[_slot_id(7, 45)]
        params = _gate(slot, "charge_needed")["params"]
        self.assertEqual(params["chargeTargetSoc"], 78)
        self.assertEqual(params["goalSoc"], 30)
        self.assertEqual(params["projectedWindowMinSoc"], 30.0)
        self.assertNotIn("projectedBoundarySoc", params)
        self.assertEqual(_gate(slot, "cheap_window_capacity")["state"], "true")
        (observation,) = trace.reserve_floor_observations
        self.assertIsNone(observation.limit)

    def test_real_simulation_reports_cap_when_the_gap_needs_more(self) -> None:
        # Even charging to the 50 % cap leaves 18 % at 12:00, pinned at the
        # 10 % min SoC inside the window, but for fewer slots than without the
        # charge: the clamp hides the deficit, so every cheap slot charges to
        # the cap.  A higher battery `max_soc` would help, so the cap is the
        # limit.
        result, trace = self._run_with_real_simulator(battery_max_soc=50.0)

        self.assertEqual(set(_charge_slots(result).values()), {50})
        slot = _slots_by_id(trace)[_slot_id(7, 45)]
        params = _gate(slot, "charge_needed")["params"]
        self.assertEqual(params["chargeTargetSoc"], 50)
        self.assertEqual(params["goalSoc"], 30)
        self.assertEqual(params["projectedWindowMinSoc"], 10.0)
        self.assertEqual(_gate(slot, "cheap_window_capacity")["state"], "false")
        (observation,) = trace.reserve_floor_observations
        self.assertEqual(observation.limit, "cap")
        self.assertTrue(observation.bridge_written)

    def test_real_simulation_floor_step_reaches_the_autumn_dst_ambiguous_hour(self) -> None:
        # Europe/Prague falls back 03:00 CEST -> 02:00 CET on 2026-10-25.  The
        # cheap band runs 01:00-02:30 CEST and the battery (2 % per slot) only
        # sinks below the 31 % floor at 02:15 CEST, whose preceding slot lies
        # in the ambiguous hour.  The simulator keys its buckets in local time,
        # where that slot does not equal its UTC instant, so the lookup must
        # be done in UTC.
        prague = ZoneInfo("Europe/Prague")
        now = datetime(2026, 10, 25, 0, 0, tzinfo=prague)
        day = date(2026, 10, 25)
        bands = (
            ImportBand(
                level="cheap",
                start=datetime(2026, 10, 25, 1, 0, tzinfo=prague),
                end=datetime(2026, 10, 25, 2, 30, tzinfo=prague),
            ),
            ImportBand(
                level="expensive",
                start=datetime(2026, 10, 25, 2, 30, tzinfo=prague),
                end=datetime(2026, 10, 25, 5, 0, tzinfo=prague),
            ),
        )
        start_utc = now.astimezone(timezone.utc)
        series = [
            {
                "timestamp": (start_utc + timedelta(minutes=15 * index)).isoformat(
                    timespec="seconds"
                ),
                "durationHours": 0.25,
                "solarKwh": 0.0,
                "baselineHouseKwh": 0.2,
                "socPct": max(10.0, 50.0 - 2.0 * (index + 1)),
            }
            for index in range(48 * 4)
        ]
        prices = [
            {
                "timestamp": (start_utc + timedelta(minutes=30 * index)).isoformat(
                    timespec="seconds"
                ),
                "value": 3.0,
            }
            for index in range(48 * 2)
        ]
        snapshot = _make_snapshot(
            soc_series=series,
            import_points=prices,
            bands=bands,
            day_contexts={day: replace(_day_context(bands), local_date=day)},
            now=now,
        )
        snapshot = _with_real_battery(snapshot, soc=50.0, battery_max_soc=100.0)
        config = _make_config(reserve_floor_soc=31)

        result, _trace = run_optimizer_with_trace(
            build_charge_from_grid_optimizer(config),
            snapshot,
            config,
            reference_time=now,
        )

        self.assertTrue(_charge_slots(result))

    def _run_with_real_simulator(self, *, battery_max_soc: float):
        """Cheap 06-08, normal 08-12, expensive 12-14 on the real simulator.

        The house draws 0.2 kWh per 15 min (2 % of a lossless 10 kWh battery)
        with no solar, starting from 50 % at 05:00.
        """
        bands = (
            ImportBand(level="cheap", start=_at(6), end=_at(8)),
            ImportBand(level="normal", start=_at(8), end=_at(12)),
            ImportBand(level="expensive", start=_at(12), end=_at(14)),
        )
        series = [
            {
                "timestamp": (
                    REFERENCE_TIME + timedelta(minutes=15 * index)
                ).isoformat(timespec="seconds"),
                "durationHours": 0.25,
                "solarKwh": 0.0,
                "baselineHouseKwh": 0.2,
                "socPct": max(10.0, 50.0 - 2.0 * (index + 1)),
            }
            for index in range(48 * 4)
        ]
        prices = _import_points({6: 2.0, 8: 4.0, 12: 6.0, 14: 4.0})
        snapshot = _make_snapshot(
            soc_series=series, import_points=prices, bands=bands
        )
        snapshot = _with_real_battery(snapshot, soc=50.0, battery_max_soc=battery_max_soc)
        config = _make_config()
        return run_optimizer_with_trace(
            build_charge_from_grid_optimizer(config),
            snapshot,
            config,
            reference_time=REFERENCE_TIME,
        )

    def _run_with_fake_simulator(
        self,
        *,
        holds_needed: int,
        charges_needed: int,
        with_trace: bool = False,
        schedule_document: ScheduleDocument | None = None,
        soc: dict[int, float] | None = None,
        bands: tuple[ImportBand, ...] = _BANDS,
        boundary_soc=None,
        trajectory_end: datetime | None = None,
        battery_max_soc: float = 100.0,
    ) -> ScheduleDocument | tuple[ScheduleDocument, object]:
        class FakeSimulator:
            def simulate(self, _demand, *, action_overrides):
                holds = sum(action.kind == "stop_discharging" for action in action_overrides.values())
                targets = [
                    action.target_soc
                    for action in action_overrides.values()
                    if action.kind == "charge_to_target_soc"
                ]
                if boundary_soc is not None:
                    soc_pct = boundary_soc(holds, len(targets), action_overrides)
                else:
                    # A charged slot does not discharge either, so it counts
                    # towards the holds; charges alone carry their target.
                    soc_pct = max(
                        50.0 if holds + len(targets) >= holds_needed else 0.0,
                        max(targets, default=0) if len(targets) >= charges_needed else 0.0,
                    )
                if trajectory_end is not None:
                    return types.SimpleNamespace(soc_by_bucket={trajectory_end: soc_pct})
                # The slot entering the boundary and every bucket of the
                # expensive windows, all flat: the window minimum is ``soc_pct``.
                return types.SimpleNamespace(soc_by_bucket={
                    _at(7, 45) + timedelta(minutes=15 * index): soc_pct
                    for index in range(14)
                })

        # Points carry end-of-slot SoC, so the 07:xx values are what the
        # expensive window at 08:00 is entered with.
        soc_series = _soc_series(soc if soc is not None else {
            0: 45,
            6: 45,
            7: 40,
            9: 20,
            10: 60,
        })
        prices = _import_points({6: 2.0, 8: 6.0})
        with patch(
            "custom_components.helman.automation.optimizers.self_sustainability.build_horizon_simulator",
            side_effect=lambda *_args, **_kwargs: FakeSimulator(),
        ):
            optimizer = build_charge_from_grid_optimizer(_make_config())
            snapshot = _make_snapshot(
                soc_series=soc_series,
                import_points=prices,
                bands=bands,
                schedule_document=schedule_document,
                battery_max_soc=battery_max_soc,
            )
            if with_trace:
                return run_optimizer_with_trace(
                    optimizer, snapshot, _make_config(), reference_time=REFERENCE_TIME
                )
            return optimizer.optimize(snapshot, _make_config())

    def test_joins_a_cheap_window_across_midnight_for_ranking(self) -> None:
        previous_day = DAY - timedelta(days=1)
        cheap_start = datetime(2026, 7, 9, 22, tzinfo=TZ)
        midnight = datetime(2026, 7, 10, 0, tzinfo=TZ)
        expensive_start = datetime(2026, 7, 10, 6, tzinfo=TZ)
        expensive_end = datetime(2026, 7, 10, 22, tzinfo=TZ)
        day_contexts = {
            previous_day: _day_context((
                ImportBand(level="cheap", start=cheap_start, end=midnight),
            )),
            DAY: _day_context((
                ImportBand(level="cheap", start=midnight, end=expensive_start),
                ImportBand(
                    level="expensive", start=expensive_start, end=expensive_end
                ),
            )),
        }
        soc = []
        prices = []
        cursor = cheap_start
        while cursor < expensive_end:
            soc_pct = 45.0 if cursor < expensive_start else 40.0
            if cursor >= expensive_start + timedelta(hours=1):
                soc_pct = 20.0
            soc.append({"timestamp": cursor.isoformat(), "socPct": soc_pct})
            prices.append({"timestamp": cursor.isoformat(), "value": 2.0})
            cursor += timedelta(minutes=30)

        optimizer = build_charge_from_grid_optimizer(_make_config())
        snapshot = _make_snapshot(
            soc_series=soc,
            import_points=prices,
            bands=(),
            day_contexts=day_contexts,
            now=cheap_start - timedelta(hours=1),
        )
        result, trace = run_optimizer_with_trace(
            optimizer, snapshot, _make_config(), reference_time=snapshot.context.now
        )

        charged = _charge_slots(result)
        cheap_start_id = cheap_start.isoformat(timespec="seconds")
        self.assertEqual(list(charged), [cheap_start_id])
        rank = _gate(_slots_by_id(trace)[cheap_start_id], "cheapest_rank")
        self.assertEqual(rank["params"]["rankOf"], 32)
        self.assertEqual(rank["params"]["rank"], 1)

    def test_timeline_only_joins_equal_level_exactly_adjacent_bands(self) -> None:
        start = datetime(2026, 7, 9, 22, tzinfo=TZ)
        midnight = datetime(2026, 7, 10, 0, tzinfo=TZ)
        six = datetime(2026, 7, 10, 6, tzinfo=TZ)
        contexts = {
            DAY: _day_context((
                ImportBand(level="cheap", start=midnight, end=six),
                ImportBand(level="expensive", start=six, end=six + timedelta(hours=1)),
            )),
            DAY - timedelta(days=1): _day_context((
                ImportBand(level="cheap", start=start, end=midnight),
            )),
        }
        timeline = _build_import_band_timeline(contexts.values())
        self.assertEqual(len(timeline), 2)
        self.assertEqual((timeline[0].start, timeline[0].end), (start, six))

        gap = _build_import_band_timeline((_day_context((
            ImportBand(level="cheap", start=start, end=midnight),
            ImportBand(level="cheap", start=midnight + timedelta(minutes=15), end=six),
        )),))
        self.assertEqual(len(gap), 2)
        level_change = _build_import_band_timeline((_day_context((
            ImportBand(level="cheap", start=start, end=midnight),
            ImportBand(level="expensive", start=midnight, end=six),
        )),))
        self.assertEqual(len(level_change), 2)

    def test_timeline_merges_across_dst_by_elapsed_time(self) -> None:
        berlin = ZoneInfo("Europe/Berlin")
        start = datetime(2026, 10, 24, 22, tzinfo=berlin)
        boundary = datetime(2026, 10, 25, 3, tzinfo=berlin)
        end = datetime(2026, 10, 25, 6, tzinfo=berlin)
        timeline = _build_import_band_timeline((_day_context((
            ImportBand(level="cheap", start=start, end=boundary),
        )), _day_context((
            ImportBand(level="cheap", start=boundary, end=end),
        ))))
        self.assertEqual(len(timeline), 1)
        self.assertEqual((timeline[0].start, timeline[0].end), (start, end))

    def test_does_not_bridge_an_expensive_window_across_a_coverage_gap(self) -> None:
        bands = (
            ImportBand(level="cheap", start=_at(6), end=_at(8)),
            ImportBand(level="expensive", start=_at(9), end=_at(11)),
        )
        soc = _soc_series({0: 45, 6: 45, 9: 40, 10: 20, 11: 60})
        prices = _import_points({6: 2.0, 9: 6.0})

        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(soc_series=soc, import_points=prices, bands=bands),
            _make_config(),
        )

        self.assertEqual(_charge_slots(result), {})

    def test_charges_cheapest_slots_to_bridge_dip(self) -> None:
        # SoC dips to 20 during expensive window (floor 30 -> dip 10).
        # Entering 08:00 (the 07:30 point, end-of-slot) = 40 -> target 50.
        # Entering 06:00 (the 05:30 point) = 45 -> gap 5 pts -> 0.5 kWh -> 1 slot.
        soc = _soc_series({0: 45, 6: 45, 7: 40, 9: 20, 10: 60})
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

    def test_clamps_target_to_battery_max_soc(self) -> None:
        # Big dip pushes target above cap; clamp to battery max_soc=60.
        soc = _soc_series({0: 55, 6: 55, 8: 55, 9: 5, 10: 60})
        prices = _import_points({6: 2.0, 8: 6.0})
        result = build_charge_from_grid_optimizer(_make_config()).optimize(
            _make_snapshot(
                soc_series=soc,
                import_points=prices,
                bands=_BANDS,
                battery_max_soc=60.0,
            ),
            _make_config(),
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


def _tomorrow(hour: int, minute: int = 0) -> datetime:
    return _at(hour, minute) + timedelta(days=1)


def _id(at: datetime) -> str:
    return at.isoformat(timespec="seconds")


def _sunny(at: datetime) -> float:
    """0.5 kWh per 15 min from 08:00 to 18:00 tomorrow."""
    return 0.5 if at.date() > DAY and 8 <= at.hour < 18 else 0.0


# Cheap tonight 22:00 - 06:00, expensive tomorrow 06:00 - 22:00.
_OVERNIGHT_BANDS = (
    ImportBand(level="cheap", start=_at(22), end=_tomorrow(6)),
    ImportBand(level="expensive", start=_tomorrow(6), end=_tomorrow(22)),
)


class ChargeFromGridCheapWindowFloorTests(unittest.TestCase):
    """#668 on the real simulator: floor 20 %, battery min SoC 10 %.

    The house draws 0.1 kWh per 15 min (1 % of the lossless 10 kWh battery)
    unless a test says otherwise; a charging slot takes 1.25 kWh (12.5 %).
    """

    def test_a_restores_the_floor_and_tops_up_for_the_pre_solar_morning(self) -> None:
        # Entered at 15 %: charge back to 20 % at 22:00 and hold.  06:00-08:00
        # drains 8 % before the sun comes up, so the band ends with a top-up
        # to 28 % — the minimum lands on the floor at 07:45.
        result, trace = self._run_overnight(soc=19.0, solar=_sunny)

        self.assertEqual(
            _charge_slots(result),
            {
                _id(_at(22)): 20,
                _id(_tomorrow(5, 15)): 28,
                _id(_tomorrow(5, 30)): 28,
                _id(_tomorrow(5, 45)): 28,
            },
        )
        self.assertEqual(
            _holds(result), _ids_between(_at(22, 15), _tomorrow(5, 15))
        )
        slots = _slots_by_id(trace)
        floor_gate = _gate(slots[_id(_at(22))], "cheap_window_floor")
        self.assertEqual(floor_gate["state"], "true")
        self.assertEqual(floor_gate["params"], {"floorSoc": 20, "entrySoc": 15.0})
        params = _gate(slots[_id(_tomorrow(5, 45))], "charge_needed")["params"]
        self.assertEqual(params["goalSoc"], 20)
        self.assertEqual(params["projectedWindowMinSoc"], 20.0)
        assert_trace_contract(self, trace)

    def test_b_charges_the_floor_plus_the_whole_day_deficit(self) -> None:
        # Entered at the 10 % min SoC, no sun tomorrow: 64 expensive buckets
        # drain 64 %, so the band ends charged to 20 + 64 = 84 %.
        result, trace = self._run_overnight(soc=14.0)

        top_up = _ids_between(_tomorrow(4), _tomorrow(6))
        self.assertEqual(
            _charge_slots(result),
            {_id(_at(22)): 20, **{slot_id: 84 for slot_id in top_up}},
        )
        (observation,) = trace.reserve_floor_observations
        self.assertIsNone(observation.limit)
        self.assertEqual(
            _gate(_slots_by_id(trace)[top_up[-1]], "cheap_window_capacity")["state"],
            "true",
        )

    def test_simulated_charge_stays_below_fractional_battery_cap(self) -> None:
        # Row B short of the floor: 84 % would be needed, but 80 % is the
        # highest integral inverter target under an 80.5 % battery cap.  The
        # best minimum (16 %) is still placed, and the cap is the limit.
        result, trace = self._run_overnight(soc=14.0, battery_max_soc=80.5)

        charged = _charge_slots(result)
        self.assertEqual(charged.pop(_id(_at(22))), 20)
        self.assertEqual(set(charged.values()), {80})
        slot = _slots_by_id(trace)[_id(_tomorrow(5, 45))]
        self.assertEqual(_gate(slot, "cheap_window_capacity")["state"], "false")
        self.assertEqual(
            _gate(slot, "charge_needed")["params"]["projectedWindowMinSoc"], 16.0
        )
        (observation,) = trace.reserve_floor_observations
        self.assertEqual(observation.limit, "cap")

    def test_c_sizes_the_hold_on_the_window_minimum_not_the_pinned_rail(self) -> None:
        # Entered at 92 %, no sun: the rail enters 06:00 at 60 % and pins at
        # 10 % by 18:30, so `entry + dip` would be 70 %.  Keeping 20 % at
        # 21:45 needs 84 % at 06:00: hold from midnight, no charge.
        result, trace = self._run_overnight(soc=96.0)

        self.assertEqual(_charge_slots(result), {})
        self.assertEqual(_holds(result), _ids_between(_tomorrow(0), _tomorrow(6)))
        params = _gate(_slots_by_id(trace)[_id(_tomorrow(5, 45))], "charge_needed")[
            "params"
        ]
        self.assertEqual(params["projectedWindowMinSoc"], 20.0)
        self.assertIsNone(params["chargeTargetSoc"])

    def test_d_holds_earlier_to_cover_the_pre_solar_morning(self) -> None:
        # Entered at 42 %, the battery would reach 10 % by 06:00.  `entry +
        # dip` holds from 03:30 to enter at 20 %; the morning before the sun
        # needs 28 %, so the hold starts at 01:30.  The floor step's charge at
        # 03:45 (entered at 19 % before the hold was placed) is entered at
        # 28 % and buys nothing.
        result, trace = self._run_overnight(soc=46.0, solar=_sunny)

        self.assertEqual(_charge_slots(result), {_id(_tomorrow(3, 45)): 20})
        self.assertEqual(
            _holds(result),
            [
                slot_id
                for slot_id in _ids_between(_tomorrow(1, 30), _tomorrow(6))
                if slot_id != _id(_tomorrow(3, 45))
            ],
        )
        params = _gate(_slots_by_id(trace)[_id(_tomorrow(1, 30))], "charge_needed")[
            "params"
        ]
        self.assertEqual(params["projectedWindowMinSoc"], 20.0)

    def test_e_writes_nothing_for_a_dip_after_solar_filled_the_battery(self) -> None:
        # The sun fills the battery by noon; a heavy evening pins it at 10 %
        # anyway.  Nothing bought overnight survives the full battery.
        def house(at: datetime) -> float:
            return 0.3 if at.date() > DAY and 14 <= at.hour < 22 else 0.1

        def solar(at: datetime) -> float:
            return 1.35 if at.date() > DAY and 8 <= at.hour < 14 else 0.0

        result, trace = self._run_overnight(soc=64.0, solar=solar, house=house)

        self.assertEqual(result.slots, {})
        (observation,) = trace.reserve_floor_observations
        self.assertEqual(observation.limit, "cap")
        self.assertFalse(observation.bridge_written)
        gate = _gate(_slots_by_id(trace)[_id(_at(22))], "charge_needed")
        self.assertEqual(gate["state"], "false")
        self.assertEqual(gate["params"], {"goalSoc": 10.0, "projectedWindowMinSoc": 10.0})

    def test_f_keeps_the_floor_even_when_the_expensive_window_is_covered(self) -> None:
        # Entered at 15 %; a light night and early sun carry the window well
        # above the floor, so the rail says covered.  The band is still
        # brought back to 20 % and held — and nothing more is bought.
        def house(at: datetime) -> float:
            return 0.02 if _at(22) <= at < _tomorrow(6) else 0.1

        def solar(at: datetime) -> float:
            return 0.6 if _tomorrow(4) <= at < _tomorrow(18) else 0.0

        result, trace = self._run_overnight(soc=17.0, solar=solar, house=house)

        self.assertEqual(_charge_slots(result), {_id(_at(22)): 20})
        self.assertEqual(_holds(result), _ids_between(_at(22, 15), _tomorrow(6)))
        slot = _slots_by_id(trace)[_id(_at(22))]
        self.assertEqual(_gate(slot, "cheap_window_floor")["state"], "true")
        self.assertEqual(_node(slot, "reserve_floor_soc")["state"], "true")
        (observation,) = trace.reserve_floor_observations
        self.assertTrue(observation.bridge_written)
        assert_trace_contract(self, trace)

    def test_g_charges_the_first_horizon_slot_from_the_live_soc(self) -> None:
        # The run starts inside the cheap band, at 15 %.
        result, trace = self._run_overnight(soc=15.0, solar=_sunny, now=_at(23))

        first = min(_charge_slots(result).items())
        self.assertEqual(first, (_id(_at(23)), 20))
        self.assertEqual(
            _gate(_slots_by_id(trace)[_id(_at(23))], "cheap_window_floor")["params"],
            {"floorSoc": 20, "entrySoc": 15.0},
        )

    def test_h_leaves_a_cheap_band_without_expensive_band_alone(self) -> None:
        bands = (
            ImportBand(level="cheap", start=_at(22), end=_tomorrow(6)),
            ImportBand(level="normal", start=_tomorrow(6), end=_tomorrow(22)),
        )
        result, _trace = self._run_overnight(soc=19.0, bands=bands)

        self.assertEqual(result.slots, {})

    def test_horizon_ending_inside_the_window_falls_back_to_the_rail(self) -> None:
        # The expensive band runs past the horizon's end (21:00 the day after
        # tomorrow) and its only dip lies in that last, unsimulated hour.  The
        # simulator cannot see it, so the rail sizes the bridge: 60 + 10.
        last_hour = _tomorrow(21) + timedelta(days=1)
        bands = (
            ImportBand(level="cheap", start=_at(22), end=_tomorrow(6)),
            ImportBand(
                level="expensive",
                start=_tomorrow(6),
                end=last_hour + timedelta(hours=1),
            ),
        )

        def house(at: datetime) -> float:
            return 1.25 if last_hour <= at else 0.0

        result, trace = self._run_overnight(soc=60.0, house=house, bands=bands)

        print("DBG", result.slots and list(result.slots.items())[:3], [ (o) for o in trace.reserve_floor_observations])
        self.assertTrue(_charge_slots(result))
        self.assertEqual(set(_charge_slots(result).values()), {70})
        (observation,) = trace.reserve_floor_observations
        self.assertTrue(observation.bridge_written)

    def _run_overnight(
        self,
        *,
        soc: float,
        solar=lambda _at: 0.0,
        house=lambda _at: 0.1,
        now: datetime = _at(21),
        battery_max_soc: float = 100.0,
        bands: tuple[ImportBand, ...] = _OVERNIGHT_BANDS,
    ):
        """The overnight bands on the real simulator, starting at ``soc``.

        ``solar`` and ``house`` give kWh per 15-min bucket.  The rail is the
        same walk without any action, clamped to the battery's SoC range.
        """
        series = []
        energy = soc / 10
        for index in range(49 * 4):
            at = now + timedelta(minutes=15 * index)
            flow = solar(at) - house(at)
            energy = min(
                10.0 * battery_max_soc / 100,
                max(1.0, energy + max(-1.25, min(1.25, flow))),
            )
            series.append({
                "timestamp": _id(at),
                "durationHours": 0.25,
                "solarKwh": solar(at),
                "baselineHouseKwh": house(at),
                "socPct": energy * 10,
            })
        snapshot = _with_real_battery(
            _make_snapshot(
                soc_series=series,
                import_points=_import_points({}),
                bands=bands,
                now=now,
            ),
            soc=soc,
            battery_max_soc=battery_max_soc,
        )
        config = _make_config(reserve_floor_soc=20)
        return run_optimizer_with_trace(
            build_charge_from_grid_optimizer(config),
            snapshot,
            config,
            reference_time=now,
        )


def _holds(result: ScheduleDocument) -> list[str]:
    return sorted(
        slot_id
        for slot_id, actions in result.slots.items()
        if inverter_action(actions).kind == "stop_discharging"
    )


def _ids_between(start: datetime, end: datetime) -> list[str]:
    ids = []
    while start < end:
        ids.append(_id(start))
        start += timedelta(minutes=15)
    return ids


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
        step = trace_rows_payload(trace)["steps"][0]

        slots = _slots_by_id(trace)
        chosen = slots[_slot_id(7, 0)]
        self.assertEqual(chosen["verdict"], "execute")
        self.assertEqual(_gate(chosen, "window_soc_known")["state"], "true")
        self.assertEqual(_gate(chosen, "charge_needed")["state"], "true")
        self.assertEqual(_gate(chosen, "slot_available")["state"], "true")
        # Ownership is stated once, by the node the ranking owns; the writer's
        # veto would only repeat it.
        self.assertIsNone(_gate(chosen, "blocked_user_owned"))
        rank = _gate(chosen, "cheapest_rank")
        self.assertEqual(rank["state"], "true")
        self.assertEqual(rank["params"]["rank"], 1)
        self.assertEqual(rank["params"]["slotsNeeded"], 1)

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
        self.assertEqual(loser["verdict"], "skip")
        rank = _gate(loser, "cheapest_rank")
        self.assertEqual(rank["state"], "false")
        self.assertGreater(rank["params"]["rank"], rank["params"]["slotsNeeded"])
        # The whole 06:00-08:00 window is ranked.
        self.assertEqual(rank["params"]["rankOf"], 2 * (60 // SCHEDULE_SLOT_MINUTES))
        self.assertEqual(rank["params"]["chosenPrice"], 1.0)
        # Everything upstream of the ranking still passed for this slot.
        self.assertEqual(_gate(loser, "charge_needed")["state"], "true")
        self.assertEqual(_gate(loser, "cheap_window_capacity")["state"], "true")

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
        self.assertEqual(owned["verdict"], "skip")
        self.assertEqual(_gate(owned, "slot_available")["state"], "false")
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
        self.assertEqual(floor["state"], "false")  # covered: no dip below the floor
        self.assertEqual(floor["scope"], "window")
        self.assertEqual(floor.get("value"), 30)
        self.assertEqual(floor.get("actual"), 60.0)  # the window's projected minimum
        self.assertEqual(cheap["verdict"], "skip")

        # A slot no bridging window reaches keeps the unevaluated placeholder:
        # nothing consulted the floor there.
        untouched = slots[_slot_id(20, 0)]
        self.assertEqual(_node(untouched, "reserve_floor_soc")["state"], "not_evaluated")
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
        explanation = explanation_rows(trace)
        self.assertEqual(explanation["status"], "skipped")
        self.assertEqual(explanation.get("statusReason"), "battery_params_missing")
        self.assertEqual({slot["verdict"] for slot in explanation["slots"]}, {"skip"})


from automation_trace_contract import trace_rows_payload

if __name__ == "__main__":
    unittest.main()
