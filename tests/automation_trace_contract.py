"""Test-only observer for retained writes and optimizer explanation rows.

Scenario contracts require every horizon slot to be explained, every committed
write to carry an execute/candidate verdict, and gate roles to match the
optimizer's behavior. Production needs no run-trace serializer for these tests.
"""

from __future__ import annotations

from typing import Any, Mapping

from custom_components.helman.automation.explain import (
    VERDICT_CANDIDATE,
    VERDICT_EXECUTE,
)
from custom_components.helman.automation.trace import OptimizerTrace
from custom_components.helman.scheduling.schedule import iter_horizon_slot_ids


# Optimizer kinds whose scenario tests wire ``assert_trace_contract``. A new
# optimizer kind must be added here (with a contract test) or the meta-test in
# test_automation_trace_contract_meta.py fails — new kinds cannot ship
# uninstrumented.
CONTRACT_TESTED_KINDS: frozenset[str] = frozenset(
    {
        "export_price",
        "charge_hold",
        "charge_from_grid",
        "appliance_runtime",
    }
)


#: Key under which a step carries its
#: :class:`~custom_components.helman.automation.explain.OptimizerExplanation`.
#: Every non-skipped step must populate it, covering the whole horizon.
EXPLANATION_KEY = "explanation"


def run_optimizer_with_trace(
    optimizer,
    snapshot,
    config,
    *,
    reference_time,
    status: str = "ok",
):
    """Drive ``optimizer.optimize`` through a live trace like the pipeline does.

    Returns ``(result_document, trace)``.
    """
    trace = OptimizerTrace(slot_ids=iter_horizon_slot_ids(reference_time))
    trace.begin_step(optimizer.id, optimizer.kind, controllable_id=config.controllable_ids[0])
    result = optimizer.optimize(snapshot, config, trace)
    from custom_components.helman.automation.pipeline import _collect_changed_writable_action_records

    trace.record_writes(_collect_changed_writable_action_records(
        before_document=snapshot.schedule, after_document=result))
    trace.end_step(status=status)
    return result, trace


def trace_rows_payload(trace: OptimizerTrace) -> dict[str, Any]:
    """Observe retained step facts and plain explanation rows in tests only."""
    steps = []
    for step, explanation in zip(trace._steps, trace.optimizer_explanations()):
        observed = {
            "optimizerId": step.optimizer_id,
            "kind": step.kind,
            "status": step.status,
            "writes": [
                {"slotId": write.slot_id, "domain": write.controllable_id,
                 "before": write.before, "after": write.after}
                for write in step.writes
            ],
        }
        if step.has_explanation():
            observed[EXPLANATION_KEY] = explanation.to_rows()
        steps.append(observed)
    return {"slotIds": list(trace.slot_ids), "steps": steps}


def explanation_rows(trace: OptimizerTrace, step_index: int = 0) -> dict[str, Any]:
    """One step's explanation as plain rows (see :func:`trace_rows_payload`)."""
    return trace_rows_payload(trace)["steps"][step_index][EXPLANATION_KEY]


def assert_trace_contract(testcase, trace: OptimizerTrace) -> None:
    """Assert the structural trace contract + explanation coverage."""
    assert_trace_payload_contract(testcase, trace_rows_payload(trace))


def assert_trace_payload_contract(testcase, payload: Mapping[str, Any]) -> None:
    """The contract, expressed over a :func:`trace_rows_payload` payload.

    Split out from :func:`assert_trace_contract` so the meta-test can exercise
    the assertions themselves against synthetic payloads that no real optimizer
    run would produce.
    """
    slot_ids: list[str] = list(payload.get("slotIds") or [])
    horizon = set(slot_ids)

    for step in payload["steps"]:
        if step["status"] == "skipped":
            continue
        prefix = f"step {step['optimizerId']} ({step['kind']})"

        explanation = step.get(EXPLANATION_KEY)

        # --- explanation coverage (the v2 contract) --------------------------
        # Every non-skipped step must report an explanation, and it must cover
        # every horizon slot. This is the exhaustive-coverage guarantee the
        # retired v1 contract provided through reason codes: an optimizer may
        # not quietly leave a slot with no account of itself.
        testcase.assertIsNotNone(
            explanation,
            f"{prefix} reports no explanation; every non-skipped step must "
            "carry a per-slot condition record",
        )
        explained = {row["slotId"] for row in explanation["slots"]}
        missing = [slot_id for slot_id in slot_ids if slot_id not in explained]
        testcase.assertFalse(
            missing,
            f"{prefix} leaves {len(missing)}/{len(slot_ids)} horizon slot(s) "
            f"without a condition matrix "
            f"(first: {missing[0] if missing else None})",
        )

        # --- every committed write is attributable ---------------------------
        # The explanation verdict for a written slot must execute/candidate.
        # A write nothing accounts
        # for is always a bug.
        attributable = {
            row["slotId"]
            for row in explanation["slots"]
            if row["verdict"] in (VERDICT_EXECUTE, VERDICT_CANDIDATE)
        }
        for row in explanation["slots"]:
            for gate in row["gates"]:
                expected_role = (
                    "advisory" if gate["key"] in {"placement_capacity", "cheap_window_capacity"}
                    else "override" if gate["key"] == "consecutive_skip_override"
                    else "veto"
                )
                testcase.assertEqual(gate["role"], expected_role)
        for write in step["writes"]:
            if write["slotId"] not in horizon:
                continue
            testcase.assertIn(
                write["slotId"],
                attributable,
                f"{prefix} wrote {write['slotId']} with nothing accounting for "
                "it (no execute/candidate explanation)",
            )
