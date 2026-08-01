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
    build_group_explanations,
)
from custom_components.helman.automation.conditions.types import (  # noqa: E402
    ConditionRailsUnavailable,
    Scope,
)
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
            eligibility.rejection(SLOT_2), ("when_price_below", 0.0)
        )

    def test_an_eligible_slot_has_no_rejection(self) -> None:
        eligibility = build_eligibility(
            _snapshot(prices=_PRICES), _config({"when_price_below": 0.0})
        )

        self.assertIsNone(eligibility.rejection(SLOT_0))


class MaxRunPriceConditionTests(unittest.TestCase):
    """``max_run_price`` (issue #5) — permission to consume needs *every*
    bucket a slot spans to clear the threshold, the opposite of
    ``when_price_below``'s any-bucket reading for ``export_price``.
    """

    @staticmethod
    def _snapshot_with_price_points(points, *, current_price=None, now=None):
        from dataclasses import replace

        from custom_components.helman.automation.day_context import DayContext

        snapshot = _snapshot(prices={})
        forecast = dict(snapshot.context.export_price_forecast)
        forecast["points"] = [
            {"timestamp": timestamp, "value": value}
            for timestamp, value in points.items()
        ]
        forecast["currentPrice"] = current_price
        snapshot = replace(
            snapshot,
            context=replace(snapshot.context, export_price_forecast=forecast),
        )
        if now is not None:
            snapshot = replace(snapshot, context=replace(snapshot.context, now=now))
        # `appliance_runtime` carries `run_when`, which ANDs a day mask over
        # everything; without a day context no slot is ever eligible.
        local_date = REFERENCE_TIME.date()
        return replace(
            snapshot,
            context=replace(
                snapshot.context,
                day_contexts={
                    local_date: DayContext(
                        local_date=local_date,
                        classification="tight",
                        predicted_solar_kwh=5.0,
                        predicted_consumption_kwh=5.0,
                        export_price_min=1.0,
                        export_price_max=5.0,
                        day_min_window=None,
                        import_bands=(),
                    )
                },
            ),
        )

    @staticmethod
    def _config(threshold):
        return make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={
                "daily_minimum": {
                    "min_hours_per_day": 1,
                    "max_consecutive_skips": 0,
                },
                "window": {"start": "00:00", "end": "23:30"},
            },
            conditions=[{"max_run_price": threshold}],
        )

    def test_a_slot_qualifies_when_both_buckets_clear_the_threshold(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_price_points(
                {
                    "2026-03-20T21:00:00+01:00": 1.0,
                    "2026-03-20T21:30:00+01:00": 6.0,
                },
                current_price=None,
            ),
            self._config(2.0),
        )

        self.assertIsNotNone(eligibility.at(SLOT_0))
        self.assertIsNone(eligibility.at(SLOT_1))

    def test_one_expensive_bucket_sinks_the_slot(self) -> None:
        # `when_price_below`'s any-bucket reading would have let this slot
        # through on its cheap first half; `max_run_price` must not.
        eligibility = build_eligibility(
            self._snapshot_with_price_points(
                {
                    "2026-03-20T21:00:00+01:00": 1.0,
                    "2026-03-20T21:15:00+01:00": 5.0,
                },
                current_price=None,
            ),
            self._config(2.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))

    def test_the_threshold_is_exclusive(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_price_points(
                {"2026-03-20T21:00:00+01:00": 2.0}, current_price=None
            ),
            self._config(2.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))

    def test_a_missing_bucket_fails_closed(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_price_points({}, current_price=None),
            self._config(2.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))

    def test_elapsed_buckets_are_skipped(self) -> None:
        # The bucket containing `now` is 21:15; 21:00 has already elapsed at
        # an expensive price. Only buckets still to come can be gated.
        eligibility = build_eligibility(
            self._snapshot_with_price_points(
                {
                    "2026-03-20T21:00:00+01:00": 9.0,
                    "2026-03-20T21:15:00+01:00": 1.0,
                },
                current_price=None,
                now=datetime.fromisoformat("2026-03-20T21:22:00+01:00"),
            ),
            self._config(2.0),
        )

        self.assertIsNotNone(eligibility.at(SLOT_0))

    def test_current_price_overrides_a_stale_forecast_point_for_the_live_bucket(
        self,
    ) -> None:
        # The forecast point for 21:00 is expensive, but the live sensor has
        # already ticked down; the live reading is authoritative for the
        # bucket containing `now`, not just another way to qualify it.
        eligibility = build_eligibility(
            self._snapshot_with_price_points(
                {
                    "2026-03-20T21:00:00+01:00": 9.0,
                    "2026-03-20T21:15:00+01:00": 1.0,
                },
                current_price=1.0,
            ),
            self._config(2.0),
        )

        self.assertIsNotNone(eligibility.at(SLOT_0))

    def test_current_price_can_also_sink_an_otherwise_cheap_bucket(self) -> None:
        # The forecast point for 21:00 is cheap, but the live sensor has since
        # ticked up; the live reading still governs the bucket in progress.
        eligibility = build_eligibility(
            self._snapshot_with_price_points(
                {
                    "2026-03-20T21:00:00+01:00": 1.0,
                    "2026-03-20T21:15:00+01:00": 1.0,
                },
                current_price=9.0,
            ),
            self._config(2.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))


class MinSocConditionTests(unittest.TestCase):
    """A slot passes only when *every* bucket it spans clears the threshold.

    Slots are 30 minutes and forecast buckets 15, so each slot spans two.
    """

    @staticmethod
    def _snapshot_with_soc(soc_by_timestamp, *, status="available", now=None):
        from dataclasses import replace

        from custom_components.helman.automation.day_context import DayContext

        snapshot = _snapshot(prices={})
        if now is not None:
            snapshot = replace(
                snapshot, context=replace(snapshot.context, now=now)
            )
        snapshot.battery_forecast["status"] = status
        snapshot.battery_forecast["series"] = [
            {"timestamp": timestamp, "socPct": soc_pct}
            for timestamp, soc_pct in soc_by_timestamp.items()
        ]
        # `daily_runtime` carries `run_when`, which ANDs a day-classification
        # mask over everything; without a day context no slot is ever eligible.
        local_date = REFERENCE_TIME.date()
        return replace(
            snapshot,
            context=replace(
                snapshot.context,
                day_contexts={
                    local_date: DayContext(
                        local_date=local_date,
                        classification="tight",
                        predicted_solar_kwh=5.0,
                        predicted_consumption_kwh=5.0,
                        export_price_min=1.0,
                        export_price_max=5.0,
                        day_min_window=None,
                        import_bands=(),
                    )
                },
            ),
        )

    @staticmethod
    def _config(threshold):
        return make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={
                "daily_minimum": {
                    "min_hours_per_day": 1,
                    "max_consecutive_skips": 0,
                },
                "window": {"start": "00:00", "end": "23:30"},
            },
            conditions=[{"min_soc_pct": threshold}],
        )

    def test_a_slot_qualifies_when_both_buckets_clear_the_threshold(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_soc(
                {
                    "2026-03-20T21:00:00+01:00": 62.0,
                    "2026-03-20T21:15:00+01:00": 66.0,
                    "2026-03-20T21:30:00+01:00": 71.0,
                    "2026-03-20T21:45:00+01:00": 74.0,
                }
            ),
            self._config(70.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))
        self.assertIsNotNone(eligibility.at(SLOT_1))

    def test_the_slot_in_progress_survives_once_its_first_bucket_has_elapsed(
        self,
    ) -> None:
        # The battery forecast starts at the bucket containing `now`, so once
        # `now` passes a slot's midpoint the slot's first bucket is in the past
        # and absent from the series. "Every bucket clears the threshold" must
        # not read that absence as a failure: the slot is executing, its first
        # bucket is history, and the only buckets that can still be gated are
        # the ones still to come.
        eligibility = build_eligibility(
            self._snapshot_with_soc(
                {
                    # 21:00 has elapsed and is not in the forecast.
                    "2026-03-20T21:15:00+01:00": 95.0,
                    "2026-03-20T21:30:00+01:00": 95.0,
                    "2026-03-20T21:45:00+01:00": 95.0,
                },
                now=datetime.fromisoformat("2026-03-20T21:22:00+01:00"),
            ),
            self._config(70.0),
        )

        self.assertIsNotNone(eligibility.at(SLOT_0))

    def test_one_failing_bucket_sinks_the_slot(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_soc(
                {
                    "2026-03-20T21:00:00+01:00": 91.0,
                    "2026-03-20T21:15:00+01:00": 69.0,
                }
            ),
            self._config(70.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))

    def test_the_threshold_is_inclusive(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_soc(
                {
                    "2026-03-20T21:00:00+01:00": 70.0,
                    "2026-03-20T21:15:00+01:00": 82.0,
                }
            ),
            self._config(70.0),
        )

        self.assertIsNotNone(eligibility.at(SLOT_0))

    def test_a_missing_bucket_fails_closed(self) -> None:
        eligibility = build_eligibility(
            self._snapshot_with_soc({"2026-03-20T21:00:00+01:00": 88.0}),
            self._config(70.0),
        )

        self.assertIsNone(eligibility.at(SLOT_0))

    def test_a_forecast_short_of_the_horizon_voids_the_run(self) -> None:
        # Not "nothing matched": an empty mask would silently clear the
        # appliance, so the pipeline must get the chance to restore its baseline.
        with self.assertRaises(ConditionRailsUnavailable) as ctx:
            build_eligibility(
                self._snapshot_with_soc(
                    {"2026-03-20T21:00:00+01:00": 88.0}, status="partial"
                ),
                self._config(70.0),
            )

        self.assertEqual(ctx.exception.appliance_id, "pool")


class GroupExplanationTests(unittest.TestCase):
    """The per-slot condition matrix ``build_eligibility`` stamps on the trace.

    Read-only over the same ``masks_by_key`` ``Eligibility`` uses, so nothing
    here may change which slots an optimizer sees — the classes above guard
    that.
    """

    @staticmethod
    def _explanations(snapshot, config):
        eligibility = build_eligibility(snapshot, config)
        return build_group_explanations(snapshot, config, eligibility)

    @staticmethod
    def _states(groups, key):
        return [
            next(node for node in group.conditions if node.key == key).state
            for group in groups
        ]

    def test_every_group_is_explained_in_every_horizon_slot(self) -> None:
        config = _config({"when_price_below": 0.0}, {"when_price_below": 1.0})
        explanations = self._explanations(_snapshot(prices=_PRICES), config)

        self.assertEqual(len(explanations), 96)
        for slot_id, groups in explanations.items():
            with self.subTest(slot_id=slot_id):
                self.assertEqual([group.index for group in groups], [0, 1])

    def test_a_failing_slot_is_false_and_a_passing_one_true(self) -> None:
        config = _config({"when_price_below": 0.0})
        explanations = self._explanations(_snapshot(prices=_PRICES), config)

        self.assertEqual(self._states(explanations[SLOT_0], "when_price_below"), ["true"])
        self.assertEqual(
            self._states(explanations[SLOT_2], "when_price_below"), ["false"]
        )

    def test_a_slot_failing_on_price_carries_the_actual_price(self) -> None:
        config = _config({"when_price_below": 0.0})
        explanations = self._explanations(_snapshot(prices=_PRICES), config)

        rejected = explanations[SLOT_2][0].conditions[0]
        self.assertEqual(rejected.state, "false")
        self.assertEqual(rejected.value, 0.0)
        self.assertEqual(rejected.actual, 5.0)

    def test_a_passing_slot_carries_the_reading_it_passed_with(self) -> None:
        config = _config({"when_price_below": 0.0})
        explanations = self._explanations(_snapshot(prices=_PRICES), config)

        passed = explanations[SLOT_0][0].conditions[0]
        self.assertEqual(passed.state, "true")
        self.assertEqual(passed.actual, -1.0)

    def test_run_when_reports_the_classification_it_found(self) -> None:
        # Which kinds of day are allowed, without which kind today *is*, is a
        # test the reader cannot complete from the drawing.
        from dataclasses import replace

        from custom_components.helman.automation.day_context import DayContext

        local_date = REFERENCE_TIME.date()
        snapshot = _snapshot(prices=_PRICES)
        snapshot = replace(
            snapshot,
            context=replace(
                snapshot.context,
                day_contexts={
                    local_date: DayContext(
                        local_date=local_date,
                        classification="surplus",
                        predicted_solar_kwh=5.0,
                        predicted_consumption_kwh=5.0,
                        export_price_min=1.0,
                        export_price_max=5.0,
                        day_min_window=None,
                        import_bands=(),
                    )
                },
            ),
        )
        config = make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={"window": {"start": "00:00", "end": "23:30"}},
            conditions=[{"run_when": ["tight"]}],
        )
        explanations = self._explanations(snapshot, config)

        node = next(
            node
            for node in explanations[SLOT_0][0].conditions
            if node.key == "run_when"
        )
        self.assertEqual(node.state, "false")
        self.assertEqual(node.actual, "surplus")

    def test_a_group_that_does_not_configure_a_condition_is_not_applicable(self) -> None:
        config = make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={"window": {"start": "00:00", "end": "23:30"}},
            conditions=[
                {"run_when": ["tight"], "max_run_price": 2.0},
                {"run_when": ["tight"]},
            ],
        )
        explanations = self._explanations(_snapshot(prices=_PRICES), config)

        # Never `true`: the second group simply has no opinion on price.
        self.assertEqual(
            self._states(explanations[SLOT_0], "max_run_price"),
            ["false", "not_applicable"],
        )

    def test_a_self_gating_condition_stays_not_evaluated(self) -> None:
        config = make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={"window": {"start": "00:00", "end": "23:30"}},
            conditions=[{"run_when": ["tight"], "ensure_self_sustainability": "soft"}],
        )
        explanations = self._explanations(_snapshot(prices=_PRICES), config)

        # `_all_slots_mask` says "true" for every slot; rendering that would be
        # a lie, so the optimizer resolves it later instead.
        node = next(
            node
            for node in explanations[SLOT_0][0].conditions
            if node.key == "ensure_self_sustainability"
        )
        self.assertEqual(node.state, "not_evaluated")
        self.assertEqual(node.value, "soft")

    def test_condition_scope_is_carried_onto_the_node(self) -> None:
        config = make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={"window": {"start": "00:00", "end": "23:30"}},
            conditions=[{"run_when": ["tight"], "max_run_price": 2.0}],
        )
        groups = self._explanations(_snapshot(prices=_PRICES), config)[SLOT_0]
        scopes = {node.key: node.scope for node in groups[0].conditions}

        self.assertEqual(scopes["run_when"], "day")
        self.assertEqual(scopes["max_run_price"], "slot")

    def test_a_slot_scoped_kind_reports_slot_matched_params(self) -> None:
        config = _config({"when_price_below": 0.0})
        groups = self._explanations(_snapshot(prices=_PRICES), config)[SLOT_0]

        self.assertEqual(groups[0].params_source, "slot_matched")

    def test_a_day_scoped_kind_marks_resolved_and_fallback_days_apart(self) -> None:
        from dataclasses import replace

        from custom_components.helman.automation.day_context import DayContext

        local_date = REFERENCE_TIME.date()
        snapshot = _snapshot(prices=_PRICES)
        snapshot = replace(
            snapshot,
            context=replace(
                snapshot.context,
                day_contexts={
                    local_date: DayContext(
                        local_date=local_date,
                        classification="tight",
                        predicted_solar_kwh=5.0,
                        predicted_consumption_kwh=5.0,
                        export_price_min=1.0,
                        export_price_max=5.0,
                        day_min_window=None,
                        import_bands=(),
                    )
                },
            ),
        )
        config = make_optimizer_config(
            id="hold",
            kind="charge_hold",
            params={
                "window": {"start": "06:00", "end": "14:00"},
                "battery_first": {"target_soc": 100, "margin_pct": 20},
            },
            conditions=[{"run_when": ["tight"]}],
        )
        explanations = self._explanations(snapshot, config)

        # Today has a day context, so `for_day` resolves a group; the following
        # days have none, and the kind would fall back to master params.
        self.assertEqual(explanations[SLOT_0][0].params_source, "day_resolved")
        tomorrow = "2026-03-21T12:00:00+01:00"
        self.assertEqual(explanations[tomorrow][0].params_source, "master_fallback")

    def test_each_group_carries_its_own_resolved_params_and_label(self) -> None:
        config = make_optimizer_config(
            id="runtime",
            kind="appliance_runtime",
            target={"appliance_id": "pool"},
            params={"window": {"start": "00:00", "end": "23:30"}},
            conditions=[
                {"name": "Cheap", "run_when": ["tight"]},
                {
                    "run_when": ["tight"],
                    "params": {"window": {"start": "10:00", "end": "12:00"}},
                },
            ],
        )
        groups = self._explanations(_snapshot(prices=_PRICES), config)[SLOT_0]

        self.assertEqual([group.label for group in groups], ["Cheap", "#2"])
        self.assertEqual(groups[0].params["window"]["start"], "00:00")
        self.assertEqual(groups[1].params["window"]["start"], "10:00")

    def test_per_entry_custom_results_reach_the_explanation(self) -> None:
        from dataclasses import replace

        from custom_components.helman.automation.compute_inputs import (
            CustomConditionGroupResult,
            CustomConditionResult,
        )

        config = _config({"when_price_below": 1.0})
        snapshot = _snapshot(prices=_PRICES)
        snapshot = replace(
            snapshot,
            context=replace(
                snapshot.context,
                custom_condition_results_by_optimizer_id={
                    config.id: (
                        CustomConditionGroupResult(
                            index=0,
                            met=False,
                            entries=(
                                CustomConditionResult(met=True),
                                CustomConditionResult(met=False),
                                CustomConditionResult(met=False, errored=True),
                            ),
                        ),
                    )
                },
            ),
        )
        groups = self._explanations(snapshot, config)[SLOT_0]

        # `None` is the entry that blew up, which fail-closed `met=False` alone
        # could not distinguish from one that plainly evaluated false.
        self.assertEqual(groups[0].custom_results, (True, False, None))

    def test_a_run_without_custom_evaluation_reports_no_entries(self) -> None:
        config = _config({"when_price_below": 1.0})
        groups = self._explanations(_snapshot(prices=_PRICES), config)[SLOT_0]

        self.assertEqual(groups[0].custom_results, ())

    def test_build_eligibility_stamps_the_explanations_on_the_trace(self) -> None:
        class _RecordingTrace:
            def __init__(self) -> None:
                self.explanations = None

            def set_condition_groups(self, groups) -> None:
                tuple(groups)

            def set_group_explanations(self, explanations) -> None:
                self.explanations = explanations

        trace = _RecordingTrace()
        config = _config({"when_price_below": 0.0})
        build_eligibility(_snapshot(prices=_PRICES), config, trace)

        self.assertIsNotNone(trace.explanations)
        self.assertEqual(trace.explanations[SLOT_2][0].conditions[0].actual, 5.0)


class SpecInvariantTests(unittest.TestCase):
    def test_a_day_scoped_kind_may_accept_a_slot_scoped_condition(self) -> None:
        """R2 is a resolution rule now, not a ban.

        It used to be an assertion: a kind resolving params per day could accept
        no slot-scoped condition, because different slots of one day could then
        resolve to different groups. ``daily_runtime`` needs exactly that
        combination for ``when_price_below``, so the ambiguity is resolved
        deterministically (see :meth:`Eligibility.for_day`) instead of banned.
        """
        from custom_components.helman.automation.spec import OptimizerSpec

        spec = OptimizerSpec(
            kind="bad",
            condition_types=("when_price_below",),
            param_scope=Scope.DAY,
        )

        self.assertEqual(spec.condition_type_list[0].scope, Scope.SLOT)

    def test_daily_runtime_accepts_both_the_day_and_the_price_condition(self) -> None:
        self.assertEqual(
            OPTIMIZER_SPECS["appliance_runtime"].condition_types,
            (
                "run_when",
                "max_run_price",
                "min_soc_pct",
                "min_solar_coverage_pct",
                "ensure_self_sustainability",
            ),
        )

    def test_every_kind_declares_only_registered_condition_types(self) -> None:
        from custom_components.helman.automation.conditions.types import CONDITION_TYPES

        for kind, spec in OPTIMIZER_SPECS.items():
            with self.subTest(kind=kind):
                for key in spec.condition_types:
                    self.assertIn(key, CONDITION_TYPES)


if __name__ == "__main__":
    unittest.main()
