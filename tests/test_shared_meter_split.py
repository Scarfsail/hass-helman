"""The shared-meter split: learning each member's power, and sharing by it."""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _install_package_stubs() -> None:
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


_install_package_stubs()

split = importlib.import_module("custom_components.helman.shared_meter_split")
fit_member_weights = split.fit_member_weights
split_own_power = split.split_own_power


class FitMemberWeightsTests(unittest.TestCase):
    """Segments are ``(running ids, duration h, own kWh)``."""

    def test_solo_history_recovers_each_members_power(self) -> None:
        weights = fit_member_weights([(("pump",), 2.0, 0.1), (("heater",), 3.0, 6.0)])

        self.assertAlmostEqual(weights["pump"], 0.05, places=4)
        self.assertAlmostEqual(weights["heater"], 2.0, places=4)

    def test_a_member_only_seen_with_a_solo_trained_sibling_is_resolved(self) -> None:
        # The heater alone pins 2 kW; the pump never runs alone, and the 2.5 kW
        # it runs at with the heater leaves it 0.5 kW.
        weights = fit_member_weights(
            [(("heater",), 4.0, 8.0), (("heater", "pump"), 2.0, 5.0)]
        )

        self.assertAlmostEqual(weights["heater"], 2.0, places=4)
        self.assertAlmostEqual(weights["pump"], 0.5, places=4)

    def test_members_always_running_together_get_equal_weights(self) -> None:
        weights = fit_member_weights([(("a", "b", "c"), 5.0, 15.0)])

        self.assertAlmostEqual(weights["a"], 1.0, places=4)
        self.assertAlmostEqual(weights["a"], weights["b"], places=9)
        self.assertAlmostEqual(weights["b"], weights["c"], places=9)

    def test_near_identical_members_get_stable_weights(self) -> None:
        # The two air conditioners switch on a second apart, each first on
        # alternate days. Which one led must not tip the fit to one side.
        second = 1 / 3600

        def _history(first: str, then: str) -> list:
            return [
                ((first,), second, second * 1.0),
                ((first, then), 4.0, 8.0),
            ]

        one = fit_member_weights(_history("a", "b") + _history("b", "a"))
        other = fit_member_weights(_history("b", "a") + _history("a", "b"))

        self.assertAlmostEqual(one["a"], 1.0, places=3)
        self.assertAlmostEqual(one["b"], 1.0, places=3)
        self.assertAlmostEqual(one["a"], other["a"], places=9)

    def test_standby_while_nobody_runs_is_kept_out_of_the_weights(self) -> None:
        # 50 W of standby all day, and the heater's 2 kW on top of it.
        weights = fit_member_weights(
            [((), 20.0, 1.0), (("heater",), 2.0, 4.1), (("pump",), 2.0, 0.3)]
        )

        self.assertAlmostEqual(weights["heater"], 2.0, places=4)
        self.assertAlmostEqual(weights["pump"], 0.1, places=4)

    def test_a_member_running_the_whole_window_gets_its_power(self) -> None:
        # No time without a member running: the baseline is 0, not unknown.
        weights = fit_member_weights([(("fridge",), 24.0, 2.4)])

        self.assertAlmostEqual(weights["fridge"], 0.1, places=4)

    def test_a_member_under_an_hour_is_none_without_shifting_its_sibling(self) -> None:
        # The pump's short runs still claim their energy, so the heater's
        # 2 kW is not inflated by the pump's 1 kW in the shared stretch.
        weights = fit_member_weights(
            [
                (("heater",), 5.0, 10.0),
                (("pump",), 0.5, 0.5),
                (("heater", "pump"), 0.25, 0.75),
            ]
        )

        self.assertIsNone(weights["pump"])
        self.assertAlmostEqual(weights["heater"], 2.0, places=4)

    def test_a_member_whose_draw_the_others_explain_is_zero_not_negative(self) -> None:
        weights = fit_member_weights(
            [(("heater",), 4.0, 8.0), (("heater", "lamp"), 2.0, 3.6)]
        )

        self.assertEqual(weights["lamp"], 0.0)


class SplitOwnPowerTests(unittest.TestCase):
    def test_ratio_mode_shares_all_own_power_by_weight(self) -> None:
        shares = split_own_power(
            1500.0, ["heater", "pump"], {"heater": 2.0, "pump": 1.0}, tolerance=None
        )

        self.assertEqual(shares, {"heater": 1000.0, "pump": 500.0})

    def test_an_untrained_member_takes_the_mean_of_the_trained(self) -> None:
        shares = split_own_power(
            3000.0,
            ["heater", "pump", "new"],
            {"heater": 2.0, "pump": 1.0, "new": None},
            tolerance=None,
        )

        # The newcomer weighs 1.5 kW, the mean of 2 and 1.
        for member, watts in (("heater", 4000 / 3), ("pump", 2000 / 3), ("new", 1000.0)):
            self.assertAlmostEqual(shares[member], watts)

    def test_no_weights_at_all_is_the_even_split(self) -> None:
        shares = split_own_power(900.0, ["a", "b", "c"], {}, tolerance=None)

        self.assertEqual(shares, {"a": 300.0, "b": 300.0, "c": 300.0})

    def test_nobody_running_shares_nothing(self) -> None:
        self.assertEqual(split_own_power(900.0, [], {"a": 1.0}, tolerance=None), {})

    def test_capped_mode_caps_at_the_learned_kw_plus_tolerance_in_watts(self) -> None:
        # 2 kW and 1 kW learned, 10 % tolerance: caps of 2,200 W and 1,100 W.
        # Of 4,500 W the ratio would hand out 3,000 W and 1,500 W; the
        # remaining 1,200 W is the excess nobody gets.
        shares = split_own_power(
            4500.0, ["heater", "pump"], {"heater": 2.0, "pump": 1.0}, tolerance=0.1
        )

        self.assertAlmostEqual(shares["heater"], 2200.0)
        self.assertAlmostEqual(shares["pump"], 1100.0)

    def test_capped_mode_below_the_caps_is_the_ratio_split(self) -> None:
        shares = split_own_power(
            1500.0, ["heater", "pump"], {"heater": 2.0, "pump": 1.0}, tolerance=0.1
        )

        self.assertEqual(shares, {"heater": 1000.0, "pump": 500.0})

    def test_capped_mode_never_caps_an_untrained_member(self) -> None:
        # The new member weighs 1.5 kW (the mean) but has no cap: it keeps its
        # 3,000 W ratio share while the trained ones stop at theirs.
        shares = split_own_power(
            9000.0,
            ["heater", "pump", "new"],
            {"heater": 2.0, "pump": 1.0},
            tolerance=0.0,
        )

        self.assertEqual(shares, {"heater": 2000.0, "pump": 1000.0, "new": 3000.0})


if __name__ == "__main__":
    unittest.main()
