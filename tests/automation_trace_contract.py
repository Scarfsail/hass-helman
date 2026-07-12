"""Shared contract-test helper for optimizer decision-matrix traces.

Import AFTER a test module has installed its ``custom_components`` import stubs.
It drives an optimizer through a live ``OptimizerTrace`` exactly as the pipeline
does (begin_step / optimize / end_step) and hard-asserts the v1 coverage
contract: every horizon slot is explained, every committed write has a covering
``applied`` decision, no overlaps, and every emitted ``code`` is in the
catalogue below. This is what keeps the reason catalogue honest — adding or
removing a code, or flipping its source, is a deliberate change to this set.
"""

from __future__ import annotations

from custom_components.helman.automation.trace import OptimizerTrace
from custom_components.helman.scheduling.schedule import iter_horizon_slot_ids


# The v1 reason catalogue — every code that can appear in a trace, whether
# emitted by an optimizer, carried as a note, or synthesized by the framework.
# Frontend-derived (D) codes are listed too, so the frontend/backend agree.
V1_REASON_CODES: frozenset[str] = frozenset(
    {
        # export_price
        "price_below_threshold",
        "price_not_below_threshold",  # D (frontend derivation)
        "stop_export_unsupported",
        # charge_hold
        "hold_window_applied",
        "after_release",
        "outside_window",
        "no_room_to_hold",
        "day_not_matched",
        "battery_params_missing",
        # charge_from_grid
        "bridge_window",
        "cheaper_slot_chosen",
        "window_covered",
        "band_not_expensive",
        "no_cheap_band",
        # daily_runtime
        "runtime_deficit_placed",
        "ranked_more_expensive",
        "runtime_satisfied",
        "day_skipped",
        # surplus_appliance
        "surplus_covers_demand",
        "surplus_insufficient",  # D (frontend derivation)
        "forecast_unavailable",
        # any / framework
        "blocked_user_owned",
        "optimizer_skipped",
        "unexplained",
    }
)


# Optimizer kinds whose scenario tests wire ``assert_trace_contract``. A new
# optimizer kind must be added here (with a contract test) or the meta-test in
# test_automation_trace_contract_meta.py fails — new kinds cannot ship
# uninstrumented.
CONTRACT_TESTED_KINDS: frozenset[str] = frozenset(
    {
        "export_price",
        "surplus_appliance",
        "charge_hold",
        "charge_from_grid",
        "daily_runtime",
    }
)


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


def assert_trace_contract(testcase, trace: OptimizerTrace) -> None:
    """Hard-assert exhaustive coverage + write/decision consistency + catalogue."""
    payload = trace.to_dict()
    for step in payload["steps"]:
        if step["status"] == "skipped":
            continue
        prefix = f"step {step['optimizerId']} ({step['kind']})"

        # exhaustive coverage: no synthetic `unexplained` fill was needed
        testcase.assertTrue(
            step["complete"],
            f"{prefix} is incomplete (coverage gap / unexplained write)",
        )
        testcase.assertFalse(
            any(
                decision["reason"] is not None
                and decision["reason"].get("code") == "unexplained"
                for decision in step["decisions"]
            ),
            f"{prefix} has a synthetic unexplained fill",
        )

        # no overlaps + collect applied slots
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

        # every committed write is explained by a covering applied decision
        for write in step["writes"]:
            testcase.assertIn(
                write["slotId"],
                applied,
                f"{prefix} wrote {write['slotId']} without an applied decision",
            )

        # every emitted code is in the v1 catalogue
        for decision in step["decisions"]:
            reason = decision["reason"]
            if reason is not None:
                testcase.assertIn(
                    reason["code"],
                    V1_REASON_CODES,
                    f"{prefix} emitted unknown code {reason['code']!r}",
                )
        for note in step["notes"]:
            testcase.assertIn(
                note["code"],
                V1_REASON_CODES,
                f"{prefix} noted unknown code {note['code']!r}",
            )
