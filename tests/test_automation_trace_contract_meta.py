from __future__ import annotations

import unittest

from _ha_stubs import stub_ha_dt, stub_module


def _install_import_stubs() -> None:

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_ha_dt()
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.explain import (  # noqa: E402
    OptimizerExplanation,
    SlotExplanation,
    VERDICT_EXECUTE,
    VERDICT_SKIP,
)
from custom_components.helman.automation.optimizer import (  # noqa: E402
    KNOWN_OPTIMIZER_KINDS,
)
from automation_trace_contract import (  # noqa: E402
    CONTRACT_TESTED_KINDS,
    EXPLANATION_KEY,
    assert_trace_payload_contract,
)


SLOT_IDS = ["2026-07-31T10:00", "2026-07-31T10:30", "2026-07-31T11:00"]


def _payload(
    *,
    writes=(),
    explanation: OptimizerExplanation | None = None,
    status: str = "ok",
) -> dict:
    step: dict = {
        "optimizerId": "opt-1",
        "kind": "export_price",
        "status": status,
        "writes": list(writes),
    }
    if explanation is not None:
        step[EXPLANATION_KEY] = explanation.to_rows()
    return {"slotIds": list(SLOT_IDS), "steps": [step]}


def _explanation(slot_ids, verdict: str = VERDICT_SKIP) -> OptimizerExplanation:
    return OptimizerExplanation(
        optimizer_id="opt-1",
        kind="export_price",
        slots=tuple(
            SlotExplanation(slot_id=slot_id, verdict=verdict)
            for slot_id in slot_ids
        ),
    )


class TraceContractMetaTests(unittest.TestCase):
    def test_every_known_optimizer_kind_is_contract_tested(self) -> None:
        # A new optimizer kind cannot ship without a decision-matrix contract
        # test: add it to CONTRACT_TESTED_KINDS (and wire assert_trace_contract
        # into its scenario tests).
        self.assertEqual(CONTRACT_TESTED_KINDS, KNOWN_OPTIMIZER_KINDS)

    # --- structural guarantees (reason-free) ---------------------------------


    def test_committed_write_without_execute_or_candidate_verdict_fails(self) -> None:
        payload = _payload(
            explanation=_explanation(SLOT_IDS),
            writes=[{"slotId": SLOT_IDS[0], "domain": "inverter"}],
        )
        with self.assertRaises(AssertionError):
            assert_trace_payload_contract(self, payload)


    def test_write_attributable_to_explanation_verdict_passes(self) -> None:
        # The explanation verdict attributes the committed write.
        payload = _payload(
            writes=[{"slotId": SLOT_IDS[0], "domain": "inverter"}],
            explanation=_explanation(SLOT_IDS, verdict=VERDICT_EXECUTE),
        )
        assert_trace_payload_contract(self, payload)


    # --- explanation coverage (the v2 contract) ------------------------------

    def test_partial_explanation_coverage_fails(self) -> None:
        payload = _payload(explanation=_explanation(SLOT_IDS[:2]))
        with self.assertRaises(AssertionError):
            assert_trace_payload_contract(self, payload)

    def test_full_explanation_coverage_passes(self) -> None:
        payload = _payload(explanation=_explanation(SLOT_IDS))
        assert_trace_payload_contract(self, payload)

    def test_step_without_explanation_fails(self) -> None:
        # The exhaustive-coverage guarantee the v1 reason catalogue used to
        # provide: a non-skipped step that accounts for none of its slots is a
        # contract violation, not a permissible mid-migration state.
        with self.assertRaises(AssertionError):
            assert_trace_payload_contract(self, _payload())

    def test_skipped_step_is_exempt(self) -> None:
        payload = _payload(explanation=_explanation(SLOT_IDS[:1]), status="skipped")
        assert_trace_payload_contract(self, payload)


if __name__ == "__main__":
    unittest.main()
