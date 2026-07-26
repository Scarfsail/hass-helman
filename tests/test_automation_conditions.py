"""The OR/AND algebra over condition groups, and the invariants it depends on.

Every optimizer consumes the same :class:`Eligibility`, so these are the tests
that would otherwise have to be written five times.
"""

from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
SLOT_0 = "2026-03-20T21:00:00+01:00"
SLOT_1 = "2026-03-20T21:30:00+01:00"
SLOT_2 = "2026-03-20T22:00:00+01:00"


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
    scheduling_pkg.__path__ = [str(ROOT / "custom_components" / "helman" / "scheduling")]

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

from custom_components.helman.appliances import AppliancesRuntimeRegistry  # noqa: E402
from custom_components.helman.automation.conditions import (  # noqa: E402
    build_eligibility,
)
from custom_components.helman.automation.conditions.types import Scope  # noqa: E402
from custom_components.helman.automation.snapshot import (  # noqa: E402
    OptimizationContext,
    OptimizationSnapshot,
)
from custom_components.helman.automation.spec import OPTIMIZER_SPECS  # noqa: E402
from custom_components.helman.scheduling.schedule import ScheduleDocument  # noqa: E402
from automation_config_builders import make_optimizer_config  # noqa: E402


def _snapshot(*, prices: dict[str, float], condition_met=None) -> OptimizationSnapshot:
    """A snapshot whose export price rail is exactly the given per-slot prices."""
    points = [
        {"timestamp": slot_id, "value": value} for slot_id, value in prices.items()
    ]
    return OptimizationSnapshot(
        schedule=ScheduleDocument(),
        adjusted_house_forecast={"status": "available", "series": []},
        battery_forecast={"status": "available", "series": []},
        grid_forecast={"status": "available", "series": []},
        context=OptimizationContext(
            now=REFERENCE_TIME,
            battery_state=None,
            solar_forecast={"status": "available", "points": []},
            import_price_forecast={"currentPrice": 7.0, "points": []},
            export_price_forecast={"currentPrice": 9.0, "points": deepcopy(points)},
            appliance_registry=AppliancesRuntimeRegistry(),
            when_active_hourly_energy_kwh_by_appliance_id={},
            condition_met_by_optimizer_id=condition_met or {},
        ),
    )


def _config(*groups):
    return make_optimizer_config(
        id="export", kind="export_price", conditions=list(groups)
    )


# SLOT_0 is cheap enough for either group; SLOT_1 only for the looser one;
# SLOT_2 for neither.
_PRICES = {SLOT_0: -1.0, SLOT_1: 0.5, SLOT_2: 5.0}


class OrEvaluationTests(unittest.TestCase):
    def test_a_slot_is_eligible_when_any_group_matches(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES),
            _config({"when_price_below": 0.0}, {"when_price_below": 1.0}),
        )

        self.assertEqual(
            [resolved.slot_id for resolved in eligibility.iter_slots()],
            [SLOT_0, SLOT_1],
        )

    def test_a_slot_no_group_matches_is_not_eligible(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES), _config({"when_price_below": 0.0})
        )

        self.assertIsNone(eligibility.at(SLOT_1))
        self.assertIsNone(eligibility.at(SLOT_2))

    def test_the_first_matching_group_wins(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES),
            _config({"when_price_below": 1.0}, {"when_price_below": 0.0}),
        )

        # SLOT_0 clears both thresholds; the earlier group owns it.
        self.assertEqual(eligibility.at(SLOT_0).group.index, 0)
        self.assertEqual(eligibility.at(SLOT_0).condition_value("when_price_below"), 1.0)

    def test_a_later_group_wins_when_the_first_does_not_match_the_slot(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES),
            _config({"when_price_below": 0.0}, {"when_price_below": 1.0}),
        )

        self.assertEqual(eligibility.at(SLOT_0).group.index, 0)
        self.assertEqual(eligibility.at(SLOT_1).group.index, 1)

    def test_a_group_label_falls_back_to_its_position(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES), _config({"when_price_below": 1.0})
        )
        self.assertEqual(eligibility.groups[0].label, "#1")

    def test_a_named_group_is_labelled_by_its_name(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES),
            _config({"name": "Negative prices", "when_price_below": 0.0}),
        )
        self.assertEqual(eligibility.groups[0].label, "Negative prices")


class CandidateSemanticsTests(unittest.TestCase):
    """System conditions matched but ``custom`` failed -> candidate, not nothing."""

    def _eligibility(self, *, custom_met, groups=None):
        config = _config(*(groups or [{"when_price_below": 1.0}]))
        return build_eligibility(
            _snapshot(prices=_PRICES, condition_met={config.id: custom_met}), config
        )

    def test_a_failing_custom_still_places_the_slot_as_a_candidate(self) -> None:
        eligibility = self._eligibility(custom_met=(False,))

        self.assertEqual(eligibility.candidate_slot_ids, (SLOT_0, SLOT_1))
        self.assertEqual(eligibility.planned_slot_ids, ())
        self.assertFalse(eligibility.at(SLOT_0).condition_met)

    def test_a_failing_custom_does_not_widen_the_system_conditions(self) -> None:
        # Only `custom` failed; the price mask still excludes SLOT_2.
        self.assertIsNone(self._eligibility(custom_met=(False,)).at(SLOT_2))

    def test_a_fully_matching_group_beats_an_earlier_custom_failure(self) -> None:
        eligibility = self._eligibility(
            custom_met=(False, True),
            groups=[{"when_price_below": 1.0}, {"when_price_below": 0.0}],
        )

        # SLOT_0 matches both; group 0 fails only on custom, so group 1 — which
        # matches fully — owns it and it is genuinely planned.
        self.assertEqual(eligibility.at(SLOT_0).group.index, 1)
        self.assertTrue(eligibility.at(SLOT_0).condition_met)
        self.assertIn(SLOT_0, eligibility.planned_slot_ids)

    def test_a_slot_only_the_failing_group_covers_stays_a_candidate(self) -> None:
        eligibility = self._eligibility(
            custom_met=(False, True),
            groups=[{"when_price_below": 1.0}, {"when_price_below": 0.0}],
        )

        # Only group 0 (custom failed) reaches SLOT_1.
        self.assertEqual(eligibility.at(SLOT_1).group.index, 0)
        self.assertFalse(eligibility.at(SLOT_1).condition_met)
        self.assertIn(SLOT_1, eligibility.candidate_slot_ids)

    def test_an_unevaluated_optimizer_counts_every_group_as_met(self) -> None:
        # Forecast/projection paths build snapshots without evaluating
        # conditions; they must still see the plan the automation would produce.
        config = _config({"when_price_below": 1.0})
        eligibility = build_eligibility(_snapshot(prices=_PRICES), config)

        self.assertEqual(eligibility.condition_met_by_group, (True,))
        self.assertEqual(eligibility.planned_slot_ids, (SLOT_0, SLOT_1))


class RejectionTests(unittest.TestCase):
    def test_an_ineligible_slot_names_the_condition_that_excluded_it(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES), _config({"when_price_below": 0.0})
        )

        self.assertEqual(
            eligibility.rejection(SLOT_2), ("price_not_below_threshold", 0.0)
        )

    def test_an_eligible_slot_has_no_rejection(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES), _config({"when_price_below": 0.0})
        )

        self.assertIsNone(eligibility.rejection(SLOT_0))


class SpecInvariantTests(unittest.TestCase):
    def test_r2_holds_for_every_registered_kind(self) -> None:
        """A kind resolving params per day or per band accepts no slot condition.

        Group resolution is per slot, but charge_hold resolves one release slot
        per *day* and charge_from_grid sizes one target per *band*. That is only
        coherent while every slot of a day resolves to the same group.
        """
        for kind, spec in OPTIMIZER_SPECS.items():
            with self.subTest(kind=kind):
                if spec.param_scope is Scope.SLOT:
                    continue
                self.assertFalse(
                    any(
                        condition.scope is Scope.SLOT and not condition.self_gating
                        for condition in spec.condition_type_list
                    ),
                    f"{kind} resolves params per {spec.param_scope.value} but "
                    "accepts a slot-scoped condition",
                )

    def test_constructing_a_spec_that_violates_r2_fails(self) -> None:
        from custom_components.helman.automation.spec import OptimizerSpec

        with self.assertRaises(AssertionError):
            OptimizerSpec(
                kind="bad",
                condition_types=("when_price_below",),
                param_scope=Scope.DAY,
            )

    def test_every_kind_declares_only_registered_condition_types(self) -> None:
        from custom_components.helman.automation.conditions.types import CONDITION_TYPES

        for kind, spec in OPTIMIZER_SPECS.items():
            with self.subTest(kind=kind):
                for key in spec.condition_types:
                    self.assertIn(key, CONDITION_TYPES)


if __name__ == "__main__":
    unittest.main()
