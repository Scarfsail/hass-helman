from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"
NEXT_SLOT_ID = "2026-03-20T21:30:00+01:00"
THIRD_SLOT_ID = "2026-03-20T22:00:00+01:00"

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
from custom_components.helman.automation.optimizers.export_price import (  # noqa: E402
    ExportPriceOptimizer,
)
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleDocument,
    build_horizon_end,
    schedule_document_to_dict,
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
    """The first step's explanation record, decoded from the payload."""
    payload = trace.to_dict()
    return OptimizerExplanation.from_dict(
        payload["steps"][0]["explanation"], payload["slotIds"]
    )


def _slots_by_id(explanation: OptimizerExplanation) -> dict:
    return {slot.slot_id: slot for slot in explanation.slots}


def _node(slot, key: str, group_index: int = 0):
    group = next(group for group in slot.groups if group.index == group_index)
    return next(node for node in group.conditions if node.key == key)


def _gate(slot, key: str):
    return next((gate for gate in slot.gates if gate.key == key), None)


def _make_optimizer_config(
    *,
    when_price_below: float = 0.0,
    groups: list[dict] | None = None,
) -> OptimizerInstanceConfig:
    return make_optimizer_config(
        id="avoid-negative-export",
        kind="export_price",
        conditions=groups or [{"when_price_below": when_price_below}],
    )


def _make_snapshot(
    *,
    schedule_document: ScheduleDocument | None = None,
    export_price_points: list[dict[str, object]] | None = None,
    grid_series: list[dict[str, object]] | None = None,
    current_price: float = 2.0,
) -> OptimizationSnapshot:
    return OptimizationSnapshot(
        schedule=ScheduleDocument() if schedule_document is None else schedule_document,
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={
            "status": "available",
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        grid_forecast={
            "status": "available",
            "exportPriceUnit": "CZK/kWh",
            "currentExportPrice": current_price,
            "series": [] if grid_series is None else deepcopy(grid_series),
        },
        context=OptimizationContext(
            now=REFERENCE_TIME,
            battery_state=None,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={"unit": "CZK/kWh", "currentPrice": 7.0, "points": []},
            export_price_forecast={
                "unit": "CZK/kWh",
                "currentPrice": current_price,
                "points": [] if export_price_points is None else deepcopy(export_price_points),
            },
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id={},
        ),
    )


class ExportPriceOptimizerTests(unittest.TestCase):
    def test_returns_unchanged_schedule_when_export_prices_stay_above_threshold(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                THIRD_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "appliances": {},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": 1.2},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.3},
            ],
            grid_series=[
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "exportedToGridKwh": 0.6,
                },
                {
                    "timestamp": "2026-03-20T21:15:00+01:00",
                    "exportedToGridKwh": 0.4,
                },
            ],
            current_price=1.0,
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            schedule_document_to_dict(schedule_document),
        )

    def test_writes_stop_export_for_negative_price_slots_only(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "empty"},
                    "appliances": {"boiler": {"on": True, "setBy": "user"}},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": 0.2},
                {"timestamp": NEXT_SLOT_ID, "value": 1.5},
            ],
            grid_series=[
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "exportedToGridKwh": 0.6,
                },
                {
                    "timestamp": "2026-03-20T21:15:00+01:00",
                    "exportedToGridKwh": 0.0,
                },
                {
                    "timestamp": NEXT_SLOT_ID,
                    "exportedToGridKwh": 0.5,
                },
            ],
            current_price=1.0,
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            {
                "executionEnabled": True,
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "stop_export", "setBy": "automation"},
                        "appliances": {"boiler": {"on": True, "setBy": "user"}},
                    }
                },
            },
        )

    def test_writes_when_price_is_below_threshold_even_without_expected_export(self) -> None:
        snapshot = _make_snapshot(
            schedule_document=ScheduleDocument(execution_enabled=True),
            export_price_points=[
                {"timestamp": "2026-03-20T21:15:00+01:00", "value": -0.2},
                # Ends the step; see the note in
                # `test_leaves_user_owned_inverter_slots_untouched`.
                {"timestamp": NEXT_SLOT_ID, "value": 1.5},
            ],
            grid_series=[
                {
                    "timestamp": CURRENT_SLOT_ID,
                    "exportedToGridKwh": 0.6,
                }
            ],
            current_price=0.5,
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            {
                "executionEnabled": True,
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "stop_export", "setBy": "automation"},
                        "appliances": {},
                    }
                },
            },
        )

    def test_leaves_user_owned_inverter_slots_untouched(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "normal", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            # The price is a step function, so the second point is what ends the
            # negative one — without it the -0.1 would hold to midnight and this
            # test would silently also be pinning where the step stops. That is
            # `test_carries_the_last_price_forward_to_the_end_of_its_day`'s job.
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                {"timestamp": NEXT_SLOT_ID, "value": 1.5},
            ],
            grid_series=[{"timestamp": CURRENT_SLOT_ID, "exportedToGridKwh": 0.6}],
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            schedule_document_to_dict(schedule_document),
        )

    def test_warns_and_skips_when_stop_export_is_unsupported(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                THIRD_SLOT_ID: {
                    "inverter": {"kind": "normal"},
                    "appliances": {"boiler": {"on": True, "setBy": "user"}},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            grid_series=[{"timestamp": CURRENT_SLOT_ID, "exportedToGridKwh": 0.6}],
        )

        with self.assertLogs(
            "custom_components.helman.automation.optimizers.export_price",
            level="WARNING",
        ) as captured_logs:
            result = ExportPriceOptimizer(
                id="avoid-negative-export",
                stop_export_supported=False,
            ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(
            schedule_document_to_dict(result),
            schedule_document_to_dict(schedule_document),
        )
        self.assertIn("stop_export", captured_logs.output[0])

    def test_does_not_mutate_snapshot_schedule_in_place(self) -> None:
        schedule_document = ScheduleDocument(execution_enabled=True)
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            grid_series=[{"timestamp": CURRENT_SLOT_ID, "exportedToGridKwh": 0.6}],
        )
        original_snapshot_schedule = schedule_document_to_dict(snapshot.schedule)

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(schedule_document_to_dict(snapshot.schedule), original_snapshot_schedule)
        self.assertNotEqual(
            schedule_document_to_dict(result),
            original_snapshot_schedule,
        )

    def test_never_writes_outside_existing_horizon(self) -> None:
        outside_horizon = build_horizon_end(REFERENCE_TIME) + timedelta(minutes=15)
        snapshot = _make_snapshot(
            schedule_document=ScheduleDocument(execution_enabled=True),
            export_price_points=[{"timestamp": outside_horizon.isoformat(), "value": -0.1}],
            grid_series=[
                {
                    "timestamp": outside_horizon.isoformat(),
                    "exportedToGridKwh": 0.6,
                }
            ],
        )

        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())

        self.assertEqual(schedule_document_to_dict(result)["slots"], {})


class ExportPriceStepFunctionTests(unittest.TestCase):
    """The feed publishes hourly points; slots are half-hourly.

    The mask used to mark the slot each below-threshold *point* landed in and
    nothing else, so an hourly feed protected ``21:00`` and left ``21:30``
    exporting into the same negative-priced hour. Prices are a step function:
    a bucket takes the most recent point at or before it.
    """

    def _stop_export_slot_ids(
        self,
        *,
        export_price_points: list[dict[str, object]],
        current_price: float = 2.0,
    ) -> list[str]:
        snapshot = _make_snapshot(
            schedule_document=ScheduleDocument(execution_enabled=True),
            export_price_points=export_price_points,
            current_price=current_price,
        )
        result = ExportPriceOptimizer(
            id="avoid-negative-export",
            stop_export_supported=True,
        ).optimize(snapshot, _make_optimizer_config())
        return sorted(
            slot_id
            for slot_id, slot in schedule_document_to_dict(result)["slots"].items()
            if slot["inverter"].get("kind") == "stop_export"
        )

    def test_an_hourly_point_covers_both_slots_of_its_hour(self) -> None:
        self.assertEqual(
            self._stop_export_slot_ids(
                export_price_points=[
                    {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                    {"timestamp": THIRD_SLOT_ID, "value": 1.5},
                ]
            ),
            [CURRENT_SLOT_ID, NEXT_SLOT_ID],
        )

    def test_a_point_mid_slot_does_not_reach_back_over_the_slot_start(self) -> None:
        """The step runs forwards only, so 21:00's bucket stays uncovered."""
        self.assertEqual(
            self._stop_export_slot_ids(
                export_price_points=[
                    {"timestamp": "2026-03-20T21:30:00+01:00", "value": -0.1},
                    {"timestamp": "2026-03-20T22:00:00+01:00", "value": 1.5},
                ]
            ),
            [NEXT_SLOT_ID],
        )

    def test_the_last_price_carries_to_the_end_of_its_day_and_no_further(self) -> None:
        """Export tariffs are published a day at a time.

        The final point of a published day governs until midnight; past that the
        feed says nothing, and an unknown price must not authorise a write.
        """
        self.assertEqual(
            self._stop_export_slot_ids(
                export_price_points=[{"timestamp": THIRD_SLOT_ID, "value": -0.1}]
            ),
            [
                "2026-03-20T22:00:00+01:00",
                "2026-03-20T22:30:00+01:00",
                "2026-03-20T23:00:00+01:00",
                "2026-03-20T23:30:00+01:00",
            ],
        )

    def test_current_price_alone_still_qualifies_the_slot_in_progress(self) -> None:
        """``currentPrice`` contributes independently of the points, as before."""
        self.assertEqual(
            self._stop_export_slot_ids(
                export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": 5.0}],
                current_price=-0.1,
            ),
            [CURRENT_SLOT_ID],
        )


class ExportPriceTraceContractTests(unittest.TestCase):
    def test_applied_writes_are_explained_and_contract_holds(self) -> None:
        schedule_document = ScheduleDocument(execution_enabled=True)
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                {"timestamp": NEXT_SLOT_ID, "value": -0.2},
            ],
            current_price=-0.1,
        )

        _result, trace = run_optimizer_with_trace(
            ExportPriceOptimizer(id="avoid-negative-export", stop_export_supported=True),
            snapshot,
            _make_optimizer_config(),
            reference_time=REFERENCE_TIME,
        )

        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        applied = [d for d in step["decisions"] if d["outcome"] == "applied"]
        self.assertEqual(len(applied), 1)
        self.assertIn(CURRENT_SLOT_ID, applied[0]["slotIds"])

        slots = _slots_by_id(_explanation(trace))
        written = slots[CURRENT_SLOT_ID]
        self.assertEqual(written.verdict, "execute")
        self.assertEqual(_node(written, "when_price_below").state, "true")
        self.assertEqual(_gate(written, "stop_export_supported").state, "true")

    def test_a_rejected_slot_names_the_failing_condition_and_its_actual(self) -> None:
        """The whole rationale for a rejection is now the condition matrix.

        No reason code says "price not below threshold" any more: the node for
        `when_price_below` is false, carries the configured threshold as its
        `value` and the price the slot actually presented as its `actual`.
        """
        snapshot = _make_snapshot(
            schedule_document=ScheduleDocument(execution_enabled=True),
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                {"timestamp": NEXT_SLOT_ID, "value": 1.5},
            ],
            current_price=-0.1,
        )

        _result, trace = run_optimizer_with_trace(
            ExportPriceOptimizer(id="avoid-negative-export", stop_export_supported=True),
            snapshot,
            _make_optimizer_config(),
            reference_time=REFERENCE_TIME,
        )

        assert_trace_contract(self, trace)
        slots = _slots_by_id(_explanation(trace))
        rejected = slots[NEXT_SLOT_ID]
        self.assertEqual(rejected.verdict, "skip")
        node = _node(rejected, "when_price_below")
        self.assertEqual(node.state, "false")
        self.assertEqual(node.value, 0.0)
        self.assertEqual(node.actual, 1.5)
        # A rejected slot never reaches the capability gate.
        self.assertIsNone(_gate(rejected, "stop_export_supported"))

    def test_no_candidates_is_fully_derivable(self) -> None:
        snapshot = _make_snapshot(current_price=5.0)
        _result, trace = run_optimizer_with_trace(
            ExportPriceOptimizer(id="avoid-negative-export", stop_export_supported=True),
            snapshot,
            _make_optimizer_config(),
            reference_time=REFERENCE_TIME,
        )
        assert_trace_contract(self, trace)
        explanation = _explanation(trace)
        self.assertEqual(explanation.status, "ok")
        self.assertEqual(
            {slot.verdict for slot in explanation.slots}, {"skip"}
        )

    def test_blocked_user_owned_is_emitted(self) -> None:
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_charging", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            current_price=-0.1,
        )
        _result, trace = run_optimizer_with_trace(
            ExportPriceOptimizer(id="avoid-negative-export", stop_export_supported=True),
            snapshot,
            _make_optimizer_config(),
            reference_time=REFERENCE_TIME,
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        blocked = [d for d in step["decisions"] if d["outcome"] == "blocked"]
        self.assertEqual(len(blocked), 1)
        self.assertEqual(blocked[0]["reason"]["code"], "blocked_user_owned")

        # Every condition passed and nothing was placed: the verdict must not
        # claim otherwise.
        slots = _slots_by_id(_explanation(trace))
        self.assertEqual(_node(slots[CURRENT_SLOT_ID], "when_price_below").state, "true")
        self.assertEqual(slots[CURRENT_SLOT_ID].verdict, "skip")

    def test_a_user_owned_slot_records_the_veto_rather_than_a_failed_condition(
        self,
    ) -> None:
        """⛨ blocked and ✗ not eligible must not be the same-looking cell.

        Two slots clear the price threshold; the user owns one of them. The
        owned slot's conditions all pass — nothing in the matrix says "no" —
        so only the writer's veto node explains why the schedule does not show
        the action.
        """
        schedule_document = ScheduleDocument(
            execution_enabled=True,
            slots={
                CURRENT_SLOT_ID: {
                    "inverter": {"kind": "stop_charging", "setBy": "user"},
                    "appliances": {},
                }
            },
        )
        snapshot = _make_snapshot(
            schedule_document=schedule_document,
            export_price_points=[
                {"timestamp": CURRENT_SLOT_ID, "value": -0.1},
                {"timestamp": NEXT_SLOT_ID, "value": -0.1},
                {"timestamp": THIRD_SLOT_ID, "value": 1.5},
            ],
            current_price=-0.1,
        )

        _result, trace = run_optimizer_with_trace(
            ExportPriceOptimizer(id="avoid-negative-export", stop_export_supported=True),
            snapshot,
            _make_optimizer_config(),
            reference_time=REFERENCE_TIME,
        )

        assert_trace_contract(self, trace)
        slots = _slots_by_id(_explanation(trace))

        blocked = slots[CURRENT_SLOT_ID]
        veto = _gate(blocked, "blocked_user_owned")
        self.assertIsNotNone(veto)
        self.assertEqual(veto.state, "false")
        self.assertEqual(veto.params, {"domain": "inverter"})
        # Not a condition failure: every condition column on this slot is true.
        self.assertEqual(
            {node.state for group in blocked.groups for node in group.conditions},
            {"true"},
        )

        # The slot the writer did keep records the same node as passed, so the
        # two are told apart by state and not by absence.
        written = _gate(slots[NEXT_SLOT_ID], "blocked_user_owned")
        self.assertIsNotNone(written)
        self.assertEqual(written.state, "true")

        # A slot the optimizer never offered to the writer has no veto node at
        # all — the veto has nothing to say about it.
        self.assertIsNone(_gate(slots[THIRD_SLOT_ID], "blocked_user_owned"))

    def test_unsupported_capability_emits_note(self) -> None:
        snapshot = _make_snapshot(
            export_price_points=[{"timestamp": CURRENT_SLOT_ID, "value": -0.1}],
            current_price=-0.1,
        )
        _result, trace = run_optimizer_with_trace(
            ExportPriceOptimizer(id="avoid-negative-export", stop_export_supported=False),
            snapshot,
            _make_optimizer_config(),
            reference_time=REFERENCE_TIME,
        )
        assert_trace_contract(self, trace)
        step = trace.to_dict()["steps"][0]
        self.assertTrue(
            any(note["code"] == "stop_export_unsupported" for note in step["notes"])
        )

        # A capability the inverter lacks is not "every slot false": it is a
        # skipped step, and the status is what keeps the two distinguishable.
        explanation = _explanation(trace)
        self.assertEqual(explanation.status, "skipped")
        self.assertEqual(explanation.status_reason, "stop_export_unsupported")
        slots = _slots_by_id(explanation)
        gate = _gate(slots[CURRENT_SLOT_ID], "stop_export_supported")
        self.assertEqual(gate.state, "false")
        self.assertEqual(gate.params["skippedSlots"], 6)
        self.assertEqual(slots[CURRENT_SLOT_ID].verdict, "skip")


if __name__ == "__main__":
    unittest.main()
