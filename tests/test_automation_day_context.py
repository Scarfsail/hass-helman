from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
PRAGUE = ZoneInfo("Europe/Prague")


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

    def _as_local(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=PRAGUE)
        return value.astimezone(PRAGUE)

    def _as_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    dt_mod.as_local = _as_local
    dt_mod.as_utc = _as_utc
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.day_context import (  # noqa: E402
    build_day_contexts,
)

TODAY = date(2026, 7, 10)
DAY_START = datetime(2026, 7, 10, 0, 0, tzinfo=PRAGUE)


def _slot_points(
    *,
    day_start: datetime,
    values: list[float],
    minutes: int = 30,
) -> list[dict[str, object]]:
    return [
        {
            "timestamp": (day_start + timedelta(minutes=minutes * index)).isoformat(),
            "value": value,
        }
        for index, value in enumerate(values)
    ]


def _battery_series(
    *,
    day_start: datetime,
    solar_per_slot: float,
    house_per_slot: float,
    baseline_soc_pct: float,
    slot_count: int = 48,
    soc_field: str = "baselineSocPct",
) -> list[dict[str, object]]:
    return [
        {
            "timestamp": (day_start + timedelta(minutes=30 * index)).isoformat(),
            "solarKwh": solar_per_slot,
            "baselineHouseKwh": house_per_slot,
            soc_field: baseline_soc_pct,
        }
        for index in range(slot_count)
    ]


class BuildDayContextsTests(unittest.TestCase):
    def test_surplus_day_classified_and_reaches_full(self) -> None:
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=100.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertIn(TODAY, contexts)
        ctx = contexts[TODAY]
        self.assertEqual(ctx.classification, "surplus")
        self.assertAlmostEqual(ctx.predicted_solar_kwh, 48.0)
        self.assertAlmostEqual(ctx.predicted_consumption_kwh, 24.0)

    def test_surplus_ratio_demoted_to_tight_when_baseline_never_fills(self) -> None:
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=60.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertEqual(contexts[TODAY].classification, "tight")

    def test_deficit_day(self) -> None:
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=0.2,
                house_per_slot=1.0,
                baseline_soc_pct=40.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertEqual(contexts[TODAY].classification, "deficit")

    def test_import_bands_partition_two_level_tariff(self) -> None:
        # cheap (low) 00:00-01:00, expensive 01:00-02:00, cheap 02:00-03:00
        values = [2.0, 2.0, 6.0, 6.0, 2.0, 2.0]
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=1.0,
                house_per_slot=1.0,
                baseline_soc_pct=100.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 6),
            import_price_points=_slot_points(day_start=DAY_START, values=values),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        bands = contexts[TODAY].import_bands
        self.assertEqual([band.level for band in bands], ["cheap", "expensive", "cheap"])
        self.assertEqual(bands[1].start, DAY_START + timedelta(minutes=60))
        self.assertEqual(bands[1].end, DAY_START + timedelta(minutes=120))

    def test_day_without_export_prices_is_skipped(self) -> None:
        tomorrow_start = DAY_START + timedelta(days=1)
        battery_series = _battery_series(
            day_start=DAY_START,
            solar_per_slot=1.0,
            house_per_slot=0.5,
            baseline_soc_pct=100.0,
            slot_count=96,
        )
        contexts = build_day_contexts(
            battery_series=battery_series,
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertIn(TODAY, contexts)
        self.assertNotIn(tomorrow_start.date(), contexts)

    def test_soc_fallback_demotes_on_an_unadjusted_series(self) -> None:
        """`socPct` is the baseline trajectory when nothing adjusted the series.

        The forecast builder attaches `baselineSocPct` only when the schedule
        carries a non-normal *inverter* action, so on a run whose schedule holds
        appliance placements alone the demotion used to be silently inert (#264).
        """
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=60.0,
                soc_field="socPct",
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertEqual(contexts[TODAY].classification, "tight")

    def test_baseline_soc_wins_over_soc_on_an_adjusted_series(self) -> None:
        series = _battery_series(
            day_start=DAY_START,
            solar_per_slot=1.0,
            house_per_slot=0.5,
            baseline_soc_pct=60.0,
        )
        for point in series:
            # The adjusted trajectory reaches full; the baseline one does not,
            # and the baseline one is what the demotion asks about.
            point["socPct"] = 100.0
        contexts = build_day_contexts(
            battery_series=series,
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertEqual(contexts[TODAY].classification, "tight")


class WholeDayAggregationTests(unittest.TestCase):
    """Today's figures are whole-day figures, elapsed part included (#264)."""

    def _contexts(self, *, elapsed_slots: int, **kwargs):
        # The forecast series covers only what is left of the day; the actual
        # histories cover the completed slots. Both halves use the same per-slot
        # figures, so the whole-day total must not move as the day advances.
        remaining_start = DAY_START + timedelta(minutes=30 * elapsed_slots)
        return build_day_contexts(
            battery_series=_battery_series(
                day_start=remaining_start,
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=100.0,
                slot_count=48 - elapsed_slots,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            solar_actual_history=[
                {
                    "timestamp": (
                        DAY_START + timedelta(minutes=30 * index)
                    ).isoformat(),
                    # Wh per slot, against a series carrying kWh.
                    "value": 1000.0,
                }
                for index in range(elapsed_slots)
            ],
            house_actual_history=[
                {
                    "timestamp": (
                        DAY_START + timedelta(minutes=30 * index)
                    ).isoformat(),
                    "nonDeferrable": {"value": 0.3},
                    "deferrableConsumers": [
                        {"entityId": "sensor.pool", "value": 0.2},
                    ],
                }
                for index in range(elapsed_slots)
            ],
            **kwargs,
        )

    def test_whole_day_total_does_not_decay_through_the_day(self) -> None:
        morning = self._contexts(elapsed_slots=16)[TODAY]
        afternoon = self._contexts(elapsed_slots=32)[TODAY]
        self.assertAlmostEqual(morning.predicted_solar_kwh, 48.0)
        self.assertAlmostEqual(morning.predicted_consumption_kwh, 24.0)
        self.assertAlmostEqual(
            afternoon.predicted_solar_kwh, morning.predicted_solar_kwh
        )
        self.assertAlmostEqual(
            afternoon.predicted_consumption_kwh,
            morning.predicted_consumption_kwh,
        )
        self.assertAlmostEqual(afternoon.ratio, 2.0)

    def test_without_actuals_the_remaining_day_is_all_there_is(self) -> None:
        """The regression the elapsed half exists to close.

        With no actuals the same unchanged forecast reads smaller every hour,
        which is what dragged every day toward deficit by evening.
        """
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START + timedelta(hours=16),
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=100.0,
                slot_count=16,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
        )
        self.assertAlmostEqual(contexts[TODAY].predicted_solar_kwh, 16.0)

    def test_actuals_for_an_uncovered_date_are_ignored(self) -> None:
        contexts = self._contexts(elapsed_slots=0)
        self.assertAlmostEqual(contexts[TODAY].predicted_solar_kwh, 48.0)
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=100.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            solar_actual_history=[
                {
                    "timestamp": (DAY_START - timedelta(days=1)).isoformat(),
                    "value": 99000.0,
                }
            ],
        )
        self.assertAlmostEqual(contexts[TODAY].predicted_solar_kwh, 48.0)


class ClassificationDeadbandTests(unittest.TestCase):
    """Leaving a band costs more than staying in it (#264)."""

    def _classify(self, *, ratio: float, previous_band: str | None) -> str:
        # house 1.0 kWh/slot over 48 slots = 48 kWh, so solar is ratio * 48.
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=ratio,
                house_per_slot=1.0,
                baseline_soc_pct=100.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            previous_bands=(
                None if previous_band is None else {TODAY: previous_band}
            ),
        )
        return contexts[TODAY].classification

    def test_no_previous_band_uses_the_plain_thresholds(self) -> None:
        # Just either side of each threshold rather than exactly on it: the
        # ratio is a sum-over-sum, so an exact boundary is a coin toss on the
        # last bit and says nothing about the rule.
        self.assertEqual(self._classify(ratio=0.69, previous_band=None), "deficit")
        self.assertEqual(self._classify(ratio=0.71, previous_band=None), "tight")
        self.assertEqual(self._classify(ratio=1.31, previous_band=None), "surplus")
        self.assertEqual(self._classify(ratio=1.29, previous_band=None), "tight")

    def test_tight_holds_just_inside_the_deficit_threshold(self) -> None:
        self.assertEqual(self._classify(ratio=0.68, previous_band="tight"), "tight")
        self.assertEqual(self._classify(ratio=0.60, previous_band="tight"), "deficit")

    def test_deficit_holds_just_above_the_deficit_threshold(self) -> None:
        self.assertEqual(
            self._classify(ratio=0.73, previous_band="deficit"), "deficit"
        )
        self.assertEqual(self._classify(ratio=0.80, previous_band="deficit"), "tight")

    def test_tight_holds_just_inside_the_surplus_threshold(self) -> None:
        self.assertEqual(self._classify(ratio=1.32, previous_band="tight"), "tight")
        self.assertEqual(
            self._classify(ratio=1.40, previous_band="tight"), "surplus"
        )

    def test_surplus_holds_just_below_the_surplus_threshold(self) -> None:
        self.assertEqual(
            self._classify(ratio=1.27, previous_band="surplus"), "surplus"
        )
        self.assertEqual(
            self._classify(ratio=1.20, previous_band="surplus"), "tight"
        )

    def test_band_carries_the_denominator_it_was_measured_for(self) -> None:
        contexts = build_day_contexts(
            battery_series=_battery_series(
                day_start=DAY_START,
                solar_per_slot=1.0,
                house_per_slot=0.5,
                baseline_soc_pct=100.0,
            ),
            export_price_points=_slot_points(day_start=DAY_START, values=[2.0] * 48),
            import_price_points=_slot_points(day_start=DAY_START, values=[3.0] * 48),
            battery_max_soc=100.0,
            deficit_below_ratio=0.7,
            surplus_above_ratio=1.3,
            denominator_optimizer_id="pool-filtration",
        )
        self.assertEqual(
            contexts[TODAY].denominator_optimizer_id, "pool-filtration"
        )
        self.assertAlmostEqual(contexts[TODAY].ratio, 2.0)


if __name__ == "__main__":
    unittest.main()
