from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TZ = timezone(timedelta(hours=2))


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

from custom_components.helman.automation.explain import (  # noqa: E402
    SCOPE_WINDOW,
    STATE_FALSE,
    STATE_NOT_EVALUATED,
    STATE_TRUE,
    VERDICT_EXECUTE,
    VERDICT_SKIP,
    ConditionNode,
    GroupExplanation,
)
from custom_components.helman.automation.trace import (  # noqa: E402
    NULL_TRACE,
    OptimizerTrace,
    TraceWrite,
    aggregate_series_to_slots,
    price_points_to_slots,
)
from custom_components.helman.scheduling.schedule import format_slot_id  # noqa: E402


def _slot_ids(count: int, *, start_hour: int = 6) -> list[str]:
    base = datetime(2026, 7, 12, start_hour, 0, tzinfo=TZ)
    return [format_slot_id(base + timedelta(minutes=30 * i)) for i in range(count)]


class AggregateSeriesToSlotsTests(unittest.TestCase):
    def test_sums_energy_and_takes_end_of_slot_soc(self) -> None:
        slots = _slot_ids(2)  # 06:00, 06:30
        base = datetime(2026, 7, 12, 6, 0, tzinfo=TZ)
        series = [
            {"timestamp": (base).isoformat(), "solarKwh": 0.1, "socPct": 40.0},
            {
                "timestamp": (base + timedelta(minutes=15)).isoformat(),
                "solarKwh": 0.2,
                "socPct": 42.0,
            },
            {
                "timestamp": (base + timedelta(minutes=30)).isoformat(),
                "solarKwh": 0.5,
                "socPct": 50.0,
            },
        ]
        result = aggregate_series_to_slots(
            series, slots, sum_fields=("solarKwh",), last_fields=("socPct",)
        )
        self.assertAlmostEqual(result["solarKwh"][0], 0.3)  # 0.1 + 0.2
        self.assertEqual(result["socPct"][0], 42.0)  # end of slot
        self.assertAlmostEqual(result["solarKwh"][1], 0.5)
        self.assertEqual(result["socPct"][1], 50.0)

    def test_slots_past_coverage_are_none(self) -> None:
        slots = _slot_ids(3)
        base = datetime(2026, 7, 12, 6, 0, tzinfo=TZ)
        series = [{"timestamp": base.isoformat(), "solarKwh": 0.4}]
        result = aggregate_series_to_slots(series, slots, sum_fields=("solarKwh",))
        self.assertAlmostEqual(result["solarKwh"][0], 0.4)
        self.assertIsNone(result["solarKwh"][1])
        self.assertIsNone(result["solarKwh"][2])

    def test_non_list_series_yields_all_none(self) -> None:
        slots = _slot_ids(2)
        result = aggregate_series_to_slots(None, slots, sum_fields=("x",))
        self.assertEqual(result["x"], [None, None])


class PricePointsToSlotsTests(unittest.TestCase):
    def test_step_function_carries_last_price_forward(self) -> None:
        slots = _slot_ids(3)  # 06:00, 06:30, 07:00
        base = datetime(2026, 7, 12, 6, 0, tzinfo=TZ)
        points = [
            {"timestamp": base.isoformat(), "value": 2.0},
            {"timestamp": (base + timedelta(hours=1)).isoformat(), "value": 3.0},
        ]
        result = price_points_to_slots(points, slots)
        self.assertEqual(result, [2.0, 2.0, 3.0])

    def test_missing_points_are_none(self) -> None:
        self.assertEqual(price_points_to_slots(None, _slot_ids(2)), [None, None])


class OptimizerTraceCoverageTests(unittest.TestCase):
    def test_empty_step_gets_synthetic_fill_and_is_incomplete(self) -> None:
        slots = _slot_ids(3)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.end_step(status="ok")
        step = trace.to_dict()["steps"][0]
        self.assertFalse(step["complete"])
        # one synthetic group covering all slots
        fills = [d for d in step["decisions"] if d["reason"]["code"] == "unexplained"]
        self.assertEqual(len(fills), 1)
        self.assertEqual(set(fills[0]["slotIds"]), set(slots))

    def test_full_coverage_is_complete_without_fill(self) -> None:
        slots = _slot_ids(3)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.decision(slot_ids=slots, outcome="out_of_scope", reason={"code": "x", "params": {}})
        trace.end_step(status="ok")
        step = trace.to_dict()["steps"][0]
        self.assertTrue(step["complete"])
        self.assertEqual(len(step["decisions"]), 1)

    def test_overlap_marks_incomplete(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.decision(slot_ids=slots, outcome="out_of_scope", reason={"code": "a", "params": {}})
        trace.decision(slot_ids=[slots[0]], outcome="out_of_scope", reason={"code": "b", "params": {}})
        trace.end_step(status="ok")
        self.assertFalse(trace.to_dict()["steps"][0]["complete"])

    def test_write_without_applied_marks_incomplete(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        # cover everything but only out_of_scope, not applied
        trace.decision(slot_ids=slots, outcome="out_of_scope", reason={"code": "x", "params": {}})
        trace.record_writes(
            [TraceWrite(slot_id=slots[0], domain="inverter", before=None, after={"kind": "stop_export"})]
        )
        trace.end_step(status="ok")
        self.assertFalse(trace.to_dict()["steps"][0]["complete"])

    def test_applied_covering_write_is_complete(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.decision(slot_ids=[slots[0]], outcome="applied", reason={"code": "x", "params": {}})
        trace.decision(slot_ids=[slots[1]], outcome="out_of_scope", reason={"code": "y", "params": {}})
        trace.record_writes(
            [TraceWrite(slot_id=slots[0], domain="inverter", before=None, after={"kind": "stop_export"})]
        )
        trace.end_step(status="ok")
        self.assertTrue(trace.to_dict()["steps"][0]["complete"])

    def test_skipped_step_is_exempt_from_gap_check(self) -> None:
        slots = _slot_ids(3)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "surplus_appliance")
        trace.note_horizon(code="optimizer_skipped", params={"applianceId": "boiler"})
        trace.end_step(status="skipped")
        step = trace.to_dict()["steps"][0]
        # note_horizon already covers all slots; no synthetic `unexplained` fill
        self.assertEqual(step["status"], "skipped")
        self.assertTrue(step["complete"])
        self.assertFalse(
            any(d["reason"]["code"] == "unexplained" for d in step["decisions"])
        )

    def test_discard_step_decisions_clears_partial(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "surplus_appliance")
        trace.decision(slot_ids=[slots[0]], outcome="applied", reason={"code": "x", "params": {}})
        trace.discard_step_decisions()
        trace.note_horizon(code="optimizer_skipped", params={})
        trace.end_step(status="skipped")
        step = trace.to_dict()["steps"][0]
        self.assertTrue(all(d["reason"]["code"] != "x" for d in step["decisions"]))


class OptimizerTraceShapeTests(unittest.TestCase):
    def test_to_dict_has_parallel_arrays_keyed_by_slot_ids(self) -> None:
        slots = _slot_ids(4)
        trace = OptimizerTrace(slot_ids=slots)
        trace.set_static_rails({"importPrice": [1.0] * len(slots)})
        trace.begin_step("opt", "export_price")
        trace.set_rails_in({"availableSurplusKwh": [0.0] * len(slots)})
        trace.decision(slot_ids=slots, outcome="out_of_scope", reason={"code": "x", "params": {}})
        trace.end_step(status="ok")
        trace.set_rails_final({"batterySocPct": [50.0] * len(slots)})
        payload = trace.to_dict()
        self.assertEqual(payload["slotIds"], slots)
        self.assertEqual(len(payload["staticRails"]["importPrice"]), len(slots))
        self.assertEqual(len(payload["steps"]), 1)
        self.assertEqual(
            len(payload["steps"][0]["railsIn"]["availableSurplusKwh"]), len(slots)
        )
        self.assertEqual(len(payload["railsFinal"]["batterySocPct"]), len(slots))


def _group(
    *conditions: ConditionNode, index: int = 0, label: str = "g"
) -> GroupExplanation:
    return GroupExplanation(index=index, label=label, conditions=tuple(conditions))


class TraceGroupExplanationTests(unittest.TestCase):
    def test_groups_are_stored_per_slot_and_ordered_by_index(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.set_group_explanations(
            {
                slots[0]: [_group(index=1, label="night"), _group(index=0, label="day")],
                slots[1]: [_group(index=0, label="day")],
            }
        )
        trace.end_step(status="ok")
        explanation = trace.optimizer_explanations()[0]
        self.assertEqual(explanation.optimizer_id, "opt")
        self.assertEqual([slot.slot_id for slot in explanation.slots], slots)
        self.assertEqual(
            [group.index for group in explanation.slots[0].groups], [0, 1]
        )
        self.assertEqual([group.label for group in explanation.slots[0].groups],
                         ["day", "night"])
        self.assertEqual(len(explanation.slots[1].groups), 1)

    def test_off_horizon_slots_are_dropped(self) -> None:
        slots = _slot_ids(1)
        stray = format_slot_id(datetime(2020, 1, 1, 0, 0, tzinfo=TZ))
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.set_group_explanations({slots[0]: [_group()], stray: [_group()]})
        trace.end_step(status="ok")
        explanation = trace.optimizer_explanations()[0]
        self.assertEqual([slot.slot_id for slot in explanation.slots], slots)

    def test_replaces_previous_generation(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.set_group_explanations({slots[0]: [_group(label="stale")]})
        trace.set_group_explanations({slots[0]: [_group(label="fresh")]})
        trace.end_step(status="ok")
        groups = trace.optimizer_explanations()[0].slots[0].groups
        self.assertEqual([group.label for group in groups], ["fresh"])

    def test_no_open_step_is_a_no_op(self) -> None:
        NULL_TRACE.set_group_explanations({"x": [_group()]})
        NULL_TRACE.gate(slot_ids=["x"], key="window", state=STATE_TRUE)
        NULL_TRACE.resolve_condition(
            slot_ids=["x"], key="reserve_floor_soc", state=STATE_TRUE
        )
        NULL_TRACE.set_step_status(status="failed", reason="boom")
        self.assertEqual(NULL_TRACE.optimizer_explanations(), ())


class TraceGateTests(unittest.TestCase):
    def test_gate_is_group_encoded_over_slots(self) -> None:
        slots = _slot_ids(3)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.gate(
            slot_ids=slots[:2],
            key="window",
            state=STATE_FALSE,
            params={"windowStart": "20:00"},
        )
        trace.end_step(status="ok")
        explanation = trace.optimizer_explanations()[0]
        self.assertEqual([slot.slot_id for slot in explanation.slots], slots[:2])
        gate = explanation.slots[0].gates[0]
        self.assertEqual((gate.key, gate.state), ("window", STATE_FALSE))
        self.assertEqual(gate.params, {"windowStart": "20:00"})

    def test_ranking_is_recorded_as_an_ordinal_not_a_boolean(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.gate(
            slot_ids=[slots[0]],
            key="cheapness_rank",
            state=STATE_TRUE,
            params={"rank": 1, "rank_of": 12},
        )
        trace.gate(
            slot_ids=[slots[1]],
            key="cheapness_rank",
            state=STATE_FALSE,
            params={"rank": 5, "rank_of": 12},
        )
        trace.end_step(status="ok")
        slot_a, slot_b = trace.optimizer_explanations()[0].slots
        self.assertEqual(slot_a.gates[0].params, {"rank": 1, "rank_of": 12})
        self.assertEqual(slot_b.gates[0].params["rank"], 5)
        self.assertEqual(slot_b.gates[0].state, STATE_FALSE)

    def test_re_recording_a_key_overwrites_that_slot(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "appliance_runtime")
        trace.gate(slot_ids=slots, key="capacity", state=STATE_NOT_EVALUATED)
        trace.gate(slot_ids=slots, key="capacity", state=STATE_TRUE)
        trace.gate(slot_ids=slots, key="deadline", state=STATE_TRUE)
        trace.end_step(status="ok")
        gates = trace.optimizer_explanations()[0].slots[0].gates
        self.assertEqual([gate.key for gate in gates], ["capacity", "deadline"])
        self.assertEqual(gates[0].state, STATE_TRUE)

    def test_unknown_state_warns_and_still_records(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        with self.assertLogs(
            "custom_components.helman.automation.trace", level="WARNING"
        ):
            trace.gate(slot_ids=slots, key="window", state="maybe")
        trace.end_step(status="ok")
        self.assertEqual(
            trace.optimizer_explanations()[0].slots[0].gates[0].state, "maybe"
        )

    def test_off_horizon_slot_is_dropped_with_a_warning(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        with self.assertLogs(
            "custom_components.helman.automation.trace", level="WARNING"
        ):
            trace.gate(slot_ids=["2020-01-01T00:00:00"], key="window",
                       state=STATE_TRUE)
        trace.end_step(status="ok")
        self.assertEqual(trace.optimizer_explanations()[0].slots, ())


class TraceResolveConditionTests(unittest.TestCase):
    def _trace_with_placeholder(self, slots: list[str]) -> OptimizerTrace:
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "appliance_runtime")
        trace.set_group_explanations(
            {
                slot: [
                    _group(
                        ConditionNode(key="max_price", state=STATE_TRUE),
                        ConditionNode(
                            key="ensure_self_sustainability",
                            state=STATE_NOT_EVALUATED,
                        ),
                    )
                ]
                for slot in slots
            }
        )
        return trace

    def test_resolves_placeholder_and_keeps_scope(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.set_group_explanations(
            {
                slots[0]: [
                    _group(
                        ConditionNode(
                            key="reserve_floor_soc",
                            scope=SCOPE_WINDOW,
                            state=STATE_NOT_EVALUATED,
                            value=30.0,
                        )
                    )
                ]
            }
        )
        trace.resolve_condition(
            slot_ids=[slots[0]],
            key="reserve_floor_soc",
            state=STATE_FALSE,
            actual=22.5,
        )
        trace.end_step(status="ok")
        node = trace.optimizer_explanations()[0].slots[0].groups[0].conditions[0]
        self.assertEqual(node.state, STATE_FALSE)
        self.assertEqual(node.scope, SCOPE_WINDOW)
        self.assertEqual(node.value, 30.0)  # configured threshold preserved
        self.assertEqual(node.actual, 22.5)

    def test_unreached_slots_stay_not_evaluated(self) -> None:
        slots = _slot_ids(3)
        trace = self._trace_with_placeholder(slots)
        # capped run: only the first two slots were ever consulted
        trace.resolve_condition(
            slot_ids=slots[:2], key="ensure_self_sustainability", state=STATE_TRUE
        )
        trace.end_step(status="ok")
        states = [
            slot.groups[0].conditions[1].state
            for slot in trace.optimizer_explanations()[0].slots
        ]
        self.assertEqual(states, [STATE_TRUE, STATE_TRUE, STATE_NOT_EVALUATED])

    def test_other_conditions_are_untouched(self) -> None:
        slots = _slot_ids(1)
        trace = self._trace_with_placeholder(slots)
        trace.resolve_condition(
            slot_ids=slots, key="ensure_self_sustainability", state=STATE_FALSE
        )
        trace.end_step(status="ok")
        conditions = trace.optimizer_explanations()[0].slots[0].groups[0].conditions
        self.assertEqual(
            [(node.key, node.state) for node in conditions],
            [
                ("max_price", STATE_TRUE),
                ("ensure_self_sustainability", STATE_FALSE),
            ],
        )

    def test_group_index_filter_limits_resolution(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "appliance_runtime")
        placeholder = ConditionNode(
            key="ensure_self_sustainability", state=STATE_NOT_EVALUATED
        )
        trace.set_group_explanations(
            {slots[0]: [_group(placeholder, index=0), _group(placeholder, index=1)]}
        )
        trace.resolve_condition(
            slot_ids=slots,
            key="ensure_self_sustainability",
            state=STATE_TRUE,
            group_index=1,
        )
        trace.end_step(status="ok")
        groups = trace.optimizer_explanations()[0].slots[0].groups
        self.assertEqual(groups[0].conditions[0].state, STATE_NOT_EVALUATED)
        self.assertEqual(groups[1].conditions[0].state, STATE_TRUE)

    def test_resolution_leaves_sibling_conditions_alone(self) -> None:
        """Only the named key is resolved; the group's other nodes are untouched."""
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "appliance_runtime")
        trace.set_group_explanations(
            {
                slots[0]: [
                    _group(
                        ConditionNode(key="run_when", state=STATE_NOT_EVALUATED),
                        ConditionNode(
                            key="ensure_self_sustainability",
                            state=STATE_NOT_EVALUATED,
                        ),
                    )
                ]
            }
        )
        trace.resolve_condition(
            slot_ids=slots, key="ensure_self_sustainability", state=STATE_TRUE
        )
        trace.end_step(status="ok")
        conditions = trace.optimizer_explanations()[0].slots[0].groups[0].conditions
        self.assertEqual(conditions[0].state, STATE_NOT_EVALUATED)
        self.assertEqual(conditions[1].state, STATE_TRUE)

    def test_missing_placeholder_warns_and_invents_nothing(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "appliance_runtime")
        trace.set_group_explanations(
            {slots[0]: [_group(ConditionNode(key="max_price", state=STATE_TRUE))]}
        )
        with self.assertLogs(
            "custom_components.helman.automation.trace", level="WARNING"
        ):
            trace.resolve_condition(
                slot_ids=slots, key="reserve_floor_soc", state=STATE_TRUE
            )
        trace.end_step(status="ok")
        conditions = trace.optimizer_explanations()[0].slots[0].groups[0].conditions
        self.assertEqual([node.key for node in conditions], ["max_price"])


class TraceStepStatusTests(unittest.TestCase):
    def test_skipped_step_carries_a_reason(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.set_step_status(status="skipped", reason="battery_params_missing")
        trace.end_step(status="skipped")
        explanation = trace.optimizer_explanations()[0]
        self.assertEqual(explanation.status, "skipped")
        self.assertEqual(explanation.status_reason, "battery_params_missing")
        # distinguishable from "every slot false": no slot claims a matrix
        self.assertEqual(explanation.slots, ())

    def test_status_defaults_from_end_step(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.end_step(status="failed")
        explanation = trace.optimizer_explanations()[0]
        self.assertEqual(explanation.status, "failed")
        self.assertIsNone(explanation.status_reason)

    def test_explicit_status_wins_over_end_step(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.set_step_status(status="skipped", reason="stop_export_unsupported")
        trace.end_step(status="ok")
        self.assertEqual(trace.optimizer_explanations()[0].status, "skipped")

    def test_unknown_status_warns_and_still_records(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        with self.assertLogs(
            "custom_components.helman.automation.trace", level="WARNING"
        ):
            trace.set_step_status(status="exploded")
        trace.end_step(status="ok")
        self.assertEqual(trace.optimizer_explanations()[0].status, "exploded")


class TraceExplanationPayloadTests(unittest.TestCase):
    def _baseline_step(self, slots: list[str]) -> dict:
        baseline = OptimizerTrace(slot_ids=slots)
        baseline.begin_step("opt", "export_price")
        baseline.decision(
            slot_ids=slots, outcome="out_of_scope", reason={"code": "x", "params": {}}
        )
        baseline.end_step(status="ok")
        return baseline.to_dict()["steps"][0]

    def test_a_step_that_records_nothing_keeps_its_payload_unchanged(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.decision(
            slot_ids=slots, outcome="out_of_scope", reason={"code": "x", "params": {}}
        )
        trace.set_step_status(status="ok")
        trace.end_step(status="ok")
        self.assertEqual(trace.to_dict()["steps"][0], self._baseline_step(slots))

    def test_recorded_explanation_serializes_under_the_explanation_key(self) -> None:
        slots = _slot_ids(2)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "export_price")
        trace.decision(
            slot_ids=slots, outcome="out_of_scope", reason={"code": "x", "params": {}}
        )
        trace.set_group_explanations(
            {
                slot: [_group(ConditionNode(key="min_price", state=STATE_TRUE))]
                for slot in slots
            }
        )
        trace.gate(
            slot_ids=[slots[1]],
            key="window",
            state=STATE_FALSE,
            params={"windowEnd": "22:00"},
        )
        trace.set_step_status(status="ok", reason=None)
        trace.end_step(status="ok")

        step = trace.to_dict()["steps"][0]
        baseline = self._baseline_step(slots)
        self.assertEqual({key: step[key] for key in baseline}, baseline)
        self.assertEqual(set(step) - set(baseline), {"explanation"})

        from custom_components.helman.automation.explain import OptimizerExplanation

        decoded = OptimizerExplanation.from_dict(step["explanation"], slots)
        self.assertEqual(decoded, trace.optimizer_explanations()[0])
        self.assertEqual([slot.slot_id for slot in decoded.slots], slots)
        self.assertEqual(decoded.slots[1].gates[0].params, {"windowEnd": "22:00"})

    def test_status_reason_survives_serialization(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_from_grid")
        trace.set_group_explanations({slots[0]: [_group()]})
        trace.set_step_status(status="failed", reason="battery_params_missing")
        trace.end_step(status="failed")
        step = trace.to_dict()["steps"][0]
        self.assertEqual(step["explanation"]["status"], "failed")
        self.assertEqual(
            step["explanation"]["statusReason"], "battery_params_missing"
        )


class TraceWinnerAttributionTests(unittest.TestCase):
    """``ScheduleWriter.set_inverter`` blind-overwrites among optimizers.

    It guards only against *user*-owned actions, so between optimizers the
    schedule is last-writer-wins in pipeline order: a step can decide
    ``execute``, write, and silently lose. A verdict of ``execute`` alone never
    implies the schedule shows it, so the record names the winner per slot.
    """

    def _two_step_trace(self, slots: list[str]) -> OptimizerTrace:
        trace = OptimizerTrace(slot_ids=slots)
        for optimizer_id in ("early", "late"):
            trace.begin_step(optimizer_id, "export_price", target_key="inverter")
            trace.set_verdict(slot_ids=[slots[0]], verdict=VERDICT_EXECUTE)
            trace.set_verdict(slot_ids=slots[1:], verdict=VERDICT_SKIP)
            trace.record_writes(
                [
                    TraceWrite(
                        slot_id=slots[0],
                        domain="inverter",
                        before=None,
                        after={"kind": "stop_export"},
                    )
                ]
            )
            trace.end_step(status="ok")
        return trace

    def test_the_last_writer_in_pipeline_order_wins_the_slot(self) -> None:
        slots = _slot_ids(2)
        trace = self._two_step_trace(slots)

        early, late = trace.optimizer_explanations()

        self.assertEqual(early.slots[0].winning_optimizer, "late")
        self.assertEqual(late.slots[0].winning_optimizer, "late")
        # The earlier step decided `execute` and still lost: that is exactly the
        # "⤫ overwritten" cell.
        self.assertEqual(early.slots[0].verdict, VERDICT_EXECUTE)

    def test_a_slot_nobody_wrote_has_no_winner(self) -> None:
        slots = _slot_ids(2)
        trace = self._two_step_trace(slots)

        early, _late = trace.optimizer_explanations()

        self.assertIsNone(early.slots[1].winning_optimizer)

    def test_winners_do_not_leak_across_lanes(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("inverter-opt", "export_price", target_key="inverter")
        trace.set_verdict(slot_ids=slots, verdict=VERDICT_EXECUTE)
        trace.record_writes(
            [
                TraceWrite(
                    slot_id=slots[0],
                    domain="inverter",
                    before=None,
                    after={"kind": "stop_export"},
                )
            ]
        )
        trace.end_step(status="ok")
        trace.begin_step(
            "boiler-opt", "appliance_runtime", target_key="appliance:boiler"
        )
        trace.set_verdict(slot_ids=slots, verdict=VERDICT_EXECUTE)
        trace.record_writes(
            [
                TraceWrite(
                    slot_id=slots[0],
                    domain="appliance:boiler",
                    before=None,
                    after={"on": True},
                )
            ]
        )
        trace.end_step(status="ok")

        inverter, boiler = trace.optimizer_explanations()

        self.assertEqual(inverter.slots[0].winning_optimizer, "inverter-opt")
        self.assertEqual(boiler.slots[0].winning_optimizer, "boiler-opt")

    def test_the_target_key_is_carried_on_the_explanation(self) -> None:
        slots = _slot_ids(1)
        trace = OptimizerTrace(slot_ids=slots)
        trace.begin_step("opt", "charge_hold", target_key="inverter")
        trace.set_verdict(slot_ids=slots, verdict=VERDICT_SKIP)
        trace.end_step(status="ok")

        payload = trace.to_dict()["steps"][0]["explanation"]

        self.assertEqual(payload["targetKey"], "inverter")
        self.assertEqual(trace.optimizer_explanations()[0].target_key, "inverter")


if __name__ == "__main__":
    unittest.main()
