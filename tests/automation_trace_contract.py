"""Shared contract-test helper for optimizer decision-matrix traces.

Import AFTER a test module has installed its ``custom_components`` import stubs.
It drives an optimizer through a live ``OptimizerTrace`` exactly as the pipeline
does (begin_step / optimize / end_step) and asserts the *structural* trace
contract: decisions never overlap, every committed write is attributable, and —
for every step that reports one — the per-slot explanation record covers the
whole horizon.

v1 (the reason catalogue) is gone. The old contract hard-asserted that every
horizon slot carried a reason-coded decision, that every write was covered by an
``applied`` decision, and that every emitted ``code`` belonged to a closed
``V1_REASON_CODES`` vocabulary. Optimizers now record structured
``trace.gate(...)`` + :mod:`custom_components.helman.automation.explain`
records instead, and a decision carries only an outcome — so a closed reason
vocabulary and exhaustive *decision* coverage are no longer the right
invariants. Explanation coverage replaces them.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from custom_components.helman.automation.explain import (
    OptimizerExplanation,
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


#: Key under which a step carries its serialized
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
    trace.begin_step(optimizer.id, optimizer.kind)
    result = optimizer.optimize(snapshot, config, trace)
    trace.end_step(status=status)
    return result, trace


def _decode_explanation(
    step: Mapping[str, Any], slot_ids: Sequence[str]
) -> OptimizerExplanation | None:
    """Return the step's explanation record, or ``None`` if it reports none."""
    payload = step.get(EXPLANATION_KEY)
    if not isinstance(payload, Mapping):
        return None
    return OptimizerExplanation.from_dict(payload, slot_ids)


def assert_trace_contract(testcase, trace: OptimizerTrace) -> None:
    """Assert the structural trace contract + explanation coverage."""
    payload = trace.to_dict()
    assert_trace_payload_contract(testcase, payload)


def assert_trace_payload_contract(testcase, payload: Mapping[str, Any]) -> None:
    """The contract, expressed over a serialized trace payload.

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

        # --- decisions never double-claim a slot -----------------------------
        # Structural and reason-free: whatever vocabulary a decision carries, a
        # slot must not be claimed by two of them.
        seen: set[str] = set()
        applied: set[str] = set()
        for decision in step["decisions"]:
            for slot_id in decision["slotIds"]:
                testcase.assertNotIn(
                    slot_id, seen, f"{prefix} overlaps on slot {slot_id}"
                )
                seen.add(slot_id)
                if decision["outcome"] == "applied":
                    applied.add(slot_id)

        explanation = _decode_explanation(step, slot_ids)

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
        explained = {slot.slot_id for slot in explanation.slots}
        missing = [slot_id for slot_id in slot_ids if slot_id not in explained]
        testcase.assertFalse(
            missing,
            f"{prefix} leaves {len(missing)}/{len(slot_ids)} horizon slot(s) "
            f"without a condition matrix "
            f"(first: {missing[0] if missing else None})",
        )

        # --- every committed write is attributable ---------------------------
        # Either through an `applied` decision or through an explanation whose
        # verdict for that slot is execute/candidate. A write nothing accounts
        # for is always a bug.
        attributable = applied | {
            slot.slot_id
            for slot in explanation.slots
            if slot.verdict in (VERDICT_EXECUTE, VERDICT_CANDIDATE)
        }
        for write in step["writes"]:
            if write["slotId"] not in horizon:
                continue
            testcase.assertIn(
                write["slotId"],
                attributable,
                f"{prefix} wrote {write['slotId']} with nothing accounting for "
                "it (no applied decision, no execute/candidate explanation)",
            )
