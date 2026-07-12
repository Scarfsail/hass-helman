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

from custom_components.helman.automation.trace import (  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
