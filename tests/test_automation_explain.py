"""The explanation DTOs and their index-aligned serialization.

Pure codec tests: no optimizer, no pipeline, no store. What is guarded here is
(a) that a record survives a round trip unchanged, (b) that the per-slot columns
really are index-aligned and run-length encoded, and (c) that a passing node
costs nothing in the payload.
"""

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

    automation_pkg = sys.modules.get("custom_components.helman.automation")
    if automation_pkg is None:
        automation_pkg = types.ModuleType("custom_components.helman.automation")
        sys.modules["custom_components.helman.automation"] = automation_pkg
    automation_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "automation")
    ]


_install_import_stubs()

from custom_components.helman.automation.explain import (  # noqa: E402
    ConditionNode,
    GateNode,
    GroupExplanation,
    OptimizerExplanation,
    RunExplanation,
    SlotExplanation,
    decode_runs,
    decode_sparse,
    encode_runs,
    encode_sparse,
)

RUN_AT = datetime(2026, 7, 31, 20, 15, tzinfo=TZ)


def _slot_ids(count: int, *, start_hour: int = 12) -> tuple[str, ...]:
    base = datetime(2026, 7, 31, start_hour, 0, tzinfo=TZ)
    return tuple(
        (base + timedelta(minutes=30 * index)).isoformat() for index in range(count)
    )


class RunLengthCodecTests(unittest.TestCase):
    def test_all_same_states_collapse_to_one_run(self) -> None:
        self.assertEqual(encode_runs(["true"] * 96), [["true", 96]])

    def test_alternating_states_do_not_collapse(self) -> None:
        values = ["true", "false", "true", "false"]
        self.assertEqual(
            encode_runs(values),
            [["true", 1], ["false", 1], ["true", 1], ["false", 1]],
        )

    def test_empty_column_encodes_to_empty_runs(self) -> None:
        self.assertEqual(encode_runs([]), [])
        self.assertEqual(decode_runs([], 0), [])

    def test_round_trip_preserves_order_and_length(self) -> None:
        values = ["true"] * 3 + ["not_evaluated"] * 2 + [None] * 4 + ["false"]
        self.assertEqual(decode_runs(encode_runs(values), len(values)), values)

    def test_dict_values_collapse_by_equality(self) -> None:
        params = {"targetSocPct": 80}
        self.assertEqual(
            encode_runs([dict(params), dict(params), None]),
            [[params, 2], [None, 1]],
        )

    def test_bool_and_int_are_not_merged(self) -> None:
        self.assertEqual(encode_runs([True, 1]), [[True, 1], [1, 1]])

    def test_decode_pads_short_columns_with_none(self) -> None:
        self.assertEqual(
            decode_runs([["true", 2]], 4), ["true", "true", None, None]
        )

    def test_decode_truncates_over_long_columns(self) -> None:
        self.assertEqual(decode_runs([["true", 5]], 2), ["true", "true"])

    def test_malformed_runs_are_skipped_not_raised(self) -> None:
        self.assertEqual(decode_runs([["true", 1], "junk", ["x", -1]], 1), ["true"])
        self.assertEqual(decode_runs("not-a-list", 2), [None, None])


class SparseCodecTests(unittest.TestCase):
    def test_none_entries_are_omitted(self) -> None:
        self.assertEqual(encode_sparse([None, 4.2, None, 0.0]), {"1": 4.2, "3": 0.0})

    def test_all_none_column_encodes_to_empty_map(self) -> None:
        self.assertEqual(encode_sparse([None, None]), {})

    def test_round_trip(self) -> None:
        values = [None, 4.2, None]
        self.assertEqual(decode_sparse(encode_sparse(values), 3), values)

    def test_out_of_range_and_non_integer_keys_are_ignored(self) -> None:
        self.assertEqual(decode_sparse({"9": 1.0, "x": 2.0}, 2), [None, None])


class IndexAlignedShapeTests(unittest.TestCase):
    def _record(self) -> RunExplanation:
        slot_ids = _slot_ids(4)
        # price passes on the first two slots and fails on the last two, which
        # are the only slots carrying an actual.
        states = ["true", "true", "false", "false"]
        actuals = [None, None, 4.10, 4.55]
        slots = tuple(
            SlotExplanation(
                slot_id=slot_id,
                groups=(
                    GroupExplanation(
                        index=0,
                        label="night",
                        params={"targetSocPct": 80},
                        params_source="slot_matched",
                        custom_results=(True,),
                        conditions=(
                            ConditionNode(
                                key="max_price",
                                scope="slot",
                                state=states[index],
                                value=3.5,
                                actual=actuals[index],
                            ),
                        ),
                    ),
                ),
                gates=(GateNode(key="window", state="true", params={"rank": index}),),
                verdict="execute" if states[index] == "true" else "skip",
            )
            for index, slot_id in enumerate(slot_ids)
        )
        return RunExplanation(
            run_at=RUN_AT,
            slot_ids=slot_ids,
            optimizers=(
                OptimizerExplanation(
                    optimizer_id="grid-1",
                    kind="charge_from_grid",
                    slots=slots,
                ),
            ),
        )

    def test_single_slot_ids_array_lives_on_the_record(self) -> None:
        payload = self._record().to_dict()
        self.assertEqual(payload["slotIds"], list(_slot_ids(4)))
        self.assertEqual(payload["runAt"], RUN_AT.isoformat())
        step = payload["optimizers"][0]
        self.assertNotIn("slotIds", step)
        self.assertNotIn("slotId", str(step.get("groups")))

    def test_node_state_is_run_length_encoded(self) -> None:
        payload = self._record().to_dict()
        node = payload["optimizers"][0]["groups"][0]["conditions"][0]
        self.assertEqual(node["key"], "max_price")
        self.assertEqual(node["scope"], "slot")
        self.assertEqual(node["state"], [["true", 2], ["false", 2]])
        self.assertEqual(node["value"], [[3.5, 4]])

    def test_actuals_are_sparse_and_only_for_failing_slots(self) -> None:
        payload = self._record().to_dict()
        node = payload["optimizers"][0]["groups"][0]["conditions"][0]
        self.assertEqual(node["actual"], {"2": 4.10, "3": 4.55})

    def test_passing_node_omits_the_actual_key_entirely(self) -> None:
        record = RunExplanation(
            run_at=RUN_AT,
            slot_ids=_slot_ids(2),
            optimizers=(
                OptimizerExplanation(
                    optimizer_id="export-1",
                    kind="export_price",
                    slots=tuple(
                        SlotExplanation(
                            slot_id=slot_id,
                            groups=(
                                GroupExplanation(
                                    index=0,
                                    conditions=(
                                        ConditionNode(key="run_when", state="true"),
                                    ),
                                ),
                            ),
                            verdict="execute",
                        )
                        for slot_id in _slot_ids(2)
                    ),
                ),
            ),
        )
        node = record.to_dict()["optimizers"][0]["groups"][0]["conditions"][0]
        self.assertNotIn("actual", node)
        self.assertNotIn("value", node)

    def test_verdict_column_is_run_length_encoded(self) -> None:
        payload = self._record().to_dict()
        self.assertEqual(
            payload["optimizers"][0]["verdict"],
            [["execute", 2], ["skip", 2]],
        )

    def test_gate_params_ride_the_same_column_shape(self) -> None:
        payload = self._record().to_dict()
        gate = payload["optimizers"][0]["gates"][0]
        self.assertEqual(gate["key"], "window")
        self.assertEqual(gate["state"], [["true", 4]])
        self.assertEqual(
            gate["params"],
            [[{"rank": 0}, 1], [{"rank": 1}, 1], [{"rank": 2}, 1], [{"rank": 3}, 1]],
        )

    def test_empty_slot_list_serializes_and_round_trips(self) -> None:
        record = RunExplanation(
            run_at=RUN_AT,
            slot_ids=(),
            optimizers=(
                OptimizerExplanation(optimizer_id="idle", kind="charge_hold"),
            ),
        )
        payload = record.to_dict()
        self.assertEqual(payload["slotIds"], [])
        self.assertEqual(payload["optimizers"][0]["verdict"], [])
        self.assertEqual(RunExplanation.from_dict(payload), record)

    def test_off_horizon_slot_is_dropped_not_raised(self) -> None:
        record = RunExplanation(
            run_at=RUN_AT,
            slot_ids=_slot_ids(1),
            optimizers=(
                OptimizerExplanation(
                    optimizer_id="grid-1",
                    kind="charge_from_grid",
                    slots=(SlotExplanation(slot_id="2020-01-01T00:00:00+02:00"),),
                ),
            ),
        )
        self.assertEqual(record.to_dict()["optimizers"][0]["verdict"], [[None, 1]])


class RoundTripTests(unittest.TestCase):
    def _rich_record(self) -> RunExplanation:
        slot_ids = _slot_ids(5)
        # slot 0: two groups, the second one not configuring max_price at all;
        # slot 1: the self-gating node was never reached;
        # slot 2: no groups (the optimizer only ran gates);
        # slot 3: the optimizer said nothing at all (absent slot);
        # slot 4: blocked by the writer.
        slots = (
            SlotExplanation(
                slot_id=slot_ids[0],
                groups=(
                    GroupExplanation(
                        index=0,
                        label="cheap night",
                        params={"targetSocPct": 80, "powerW": 3000},
                        params_source="day_resolved",
                        custom_results=(True, False),
                        conditions=(
                            ConditionNode(
                                key="max_price",
                                state="false",
                                value=3.5,
                                actual=4.2,
                                children=(
                                    ConditionNode(
                                        key="custom:0",
                                        state="true",
                                        value="binary_sensor.away",
                                    ),
                                ),
                            ),
                            ConditionNode(
                                key="reserve_floor_soc",
                                scope="window",
                                state="true",
                            ),
                        ),
                    ),
                    GroupExplanation(
                        index=1,
                        label="fallback",
                        params_source="master_fallback",
                        conditions=(
                            ConditionNode(key="max_price", state="not_applicable"),
                        ),
                    ),
                ),
                gates=(GateNode(key="capacity", state="true"),),
                verdict="candidate",
            ),
            SlotExplanation(
                slot_id=slot_ids[1],
                groups=(
                    GroupExplanation(
                        index=0,
                        label="cheap night",
                        params={"targetSocPct": 80, "powerW": 3000},
                        params_source="day_resolved",
                        custom_results=(True, False),
                        conditions=(
                            ConditionNode(
                                key="ensure_self_sustainability",
                                state="not_evaluated",
                            ),
                        ),
                    ),
                ),
                verdict="skip",
            ),
            SlotExplanation(
                slot_id=slot_ids[2],
                gates=(
                    GateNode(key="capacity", state="false", params={"rank": 7}),
                    GateNode(key="deadline", state="true"),
                ),
                verdict="skip",
            ),
            SlotExplanation(
                slot_id=slot_ids[4],
                gates=(GateNode(key="blocked_user_owned", state="false"),),
                verdict="execute",
                winning_optimizer="export_price",
            ),
        )
        return RunExplanation(
            run_at=RUN_AT,
            slot_ids=slot_ids,
            optimizers=(
                OptimizerExplanation(
                    optimizer_id="grid-1",
                    kind="charge_from_grid",
                    slots=slots,
                ),
                OptimizerExplanation(
                    optimizer_id="boiler",
                    kind="appliance_runtime",
                    status="skipped",
                    status_reason="condition_rails_unavailable",
                ),
            ),
        )

    def test_record_round_trips_losslessly(self) -> None:
        record = self._rich_record()
        self.assertEqual(RunExplanation.from_dict(record.to_dict()), record)

    def test_round_trip_survives_json(self) -> None:
        import json

        record = self._rich_record()
        payload = json.loads(json.dumps(record.to_dict()))
        self.assertEqual(RunExplanation.from_dict(payload), record)

    def test_skipped_step_keeps_its_reason_and_stays_distinct(self) -> None:
        payload = self._rich_record().to_dict()
        step = payload["optimizers"][1]
        self.assertEqual(step["status"], "skipped")
        self.assertEqual(step["statusReason"], "condition_rails_unavailable")
        # a skipped step has no per-slot matrix at all -- it is not "every slot
        # false".
        self.assertEqual(step["verdict"], [[None, 5]])
        self.assertNotIn("groups", step)

    def test_absent_slot_stays_absent_after_a_round_trip(self) -> None:
        record = self._rich_record()
        restored = RunExplanation.from_dict(record.to_dict())
        explained = {slot.slot_id for slot in restored.optimizers[0].slots}
        self.assertNotIn(record.slot_ids[3], explained)
        self.assertEqual(len(explained), 4)

    def test_not_applicable_and_not_evaluated_survive_distinctly(self) -> None:
        restored = RunExplanation.from_dict(self._rich_record().to_dict())
        slots = {slot.slot_id: slot for slot in restored.optimizers[0].slots}
        fallback = slots[restored.slot_ids[0]].groups[1]
        self.assertEqual(fallback.conditions[0].state, "not_applicable")
        gated = slots[restored.slot_ids[1]].groups[0].conditions[0]
        self.assertEqual(gated.state, "not_evaluated")

    def test_child_nodes_round_trip(self) -> None:
        restored = RunExplanation.from_dict(self._rich_record().to_dict())
        node = restored.optimizers[0].slots[0].groups[0].conditions[0]
        self.assertEqual(node.children[0].key, "custom:0")
        self.assertEqual(node.children[0].value, "binary_sensor.away")

    def test_window_scope_is_carried(self) -> None:
        restored = RunExplanation.from_dict(self._rich_record().to_dict())
        node = restored.optimizers[0].slots[0].groups[0].conditions[1]
        self.assertEqual(node.scope, "window")


if __name__ == "__main__":
    unittest.main()
