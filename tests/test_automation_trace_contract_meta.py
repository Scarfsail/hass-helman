from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


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
    decisions=(),
    writes=(),
    explanation: OptimizerExplanation | None = None,
    status: str = "ok",
) -> dict:
    step: dict = {
        "optimizerId": "opt-1",
        "kind": "export_price",
        "status": status,
        "complete": True,
        "railsIn": {},
        "writes": list(writes),
        "decisions": list(decisions),
        "notes": [],
    }
    if explanation is not None:
        step[EXPLANATION_KEY] = explanation.to_dict(SLOT_IDS)
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

    def test_overlapping_decisions_fail(self) -> None:
        payload = _payload(
            decisions=[
                {"slotIds": SLOT_IDS[:2], "outcome": "applied"},
                {"slotIds": SLOT_IDS[1:], "outcome": "rejected"},
            ]
        )
        with self.assertRaises(AssertionError):
            assert_trace_payload_contract(self, payload)

    def test_write_without_applied_decision_fails(self) -> None:
        payload = _payload(
            decisions=[{"slotIds": SLOT_IDS, "outcome": "rejected"}],
            writes=[{"slotId": SLOT_IDS[0], "domain": "inverter"}],
        )
        with self.assertRaises(AssertionError):
            assert_trace_payload_contract(self, payload)

    def test_write_covered_by_applied_decision_passes(self) -> None:
        payload = _payload(
            decisions=[{"slotIds": SLOT_IDS, "outcome": "applied"}],
            writes=[{"slotId": SLOT_IDS[0], "domain": "inverter"}],
            explanation=_explanation(SLOT_IDS),
        )
        assert_trace_payload_contract(self, payload)

    def test_write_attributable_to_explanation_verdict_passes(self) -> None:
        # Post-conversion path: no `applied` decision, but the explanation says
        # the slot executes.
        payload = _payload(
            writes=[{"slotId": SLOT_IDS[0], "domain": "inverter"}],
            explanation=_explanation(SLOT_IDS, verdict=VERDICT_EXECUTE),
        )
        assert_trace_payload_contract(self, payload)

    def test_reason_codes_are_no_longer_a_closed_vocabulary(self) -> None:
        # v1 asserted every `code` was in V1_REASON_CODES; v2 does not care.
        payload = _payload(
            decisions=[
                {
                    "slotIds": SLOT_IDS,
                    "outcome": "rejected",
                    "reason": {"code": "brand_new_code", "params": {}},
                }
            ],
            explanation=_explanation(SLOT_IDS),
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
