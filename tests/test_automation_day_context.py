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
    FrozenDayContext,
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
) -> list[dict[str, object]]:
    return [
        {
            "timestamp": (day_start + timedelta(minutes=30 * index)).isoformat(),
            "solarKwh": solar_per_slot,
            "baselineHouseKwh": house_per_slot,
            "baselineSocPct": baseline_soc_pct,
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

    def test_frozen_override_pins_classification(self) -> None:
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
            frozen_overrides={
                TODAY: FrozenDayContext(classification="deficit")
            },
        )
        ctx = contexts[TODAY]
        self.assertEqual(ctx.classification, "deficit")
        # volatile stats still recomputed live
        self.assertAlmostEqual(ctx.predicted_solar_kwh, 48.0)


if __name__ == "__main__":
    unittest.main()
