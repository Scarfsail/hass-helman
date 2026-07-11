from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
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
    dt_mod.now = lambda: datetime(2026, 7, 10, 12, 0, tzinfo=TZ)
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
    DayMinWindow,
)
from custom_components.helman.automation.pipeline import (  # noqa: E402
    _summarize_day_contexts,
)


def _day_context(local_date: date, classification: str, *, with_window: bool) -> DayContext:
    window = None
    if with_window:
        start = datetime.combine(local_date, datetime.min.time(), tzinfo=TZ) + timedelta(
            hours=13
        )
        window = DayMinWindow(start=start, end=start + timedelta(minutes=30))
    return DayContext(
        local_date=local_date,
        classification=classification,
        predicted_solar_kwh=1.0,
        predicted_consumption_kwh=1.0,
        export_price_min=1.0,
        export_price_max=5.0,
        day_min_window=window,
        import_bands=(),
    )


class SummarizeDayContextsTests(unittest.TestCase):
    def test_returns_empty_without_snapshot(self) -> None:
        self.assertEqual(_summarize_day_contexts(None), [])

    def test_summarizes_classification_and_window_sorted_by_date(self) -> None:
        today = date(2026, 7, 10)
        tomorrow = date(2026, 7, 11)
        snapshot = types.SimpleNamespace(
            context=types.SimpleNamespace(
                day_contexts={
                    tomorrow: _day_context(tomorrow, "deficit", with_window=False),
                    today: _day_context(today, "surplus", with_window=True),
                }
            )
        )
        summaries = _summarize_day_contexts(snapshot)
        self.assertEqual(
            [entry["localDate"] for entry in summaries],
            ["2026-07-10", "2026-07-11"],
        )
        self.assertEqual(summaries[0]["classification"], "surplus")
        self.assertIsNotNone(summaries[0]["dayMinWindow"])
        self.assertEqual(summaries[1]["classification"], "deficit")
        self.assertIsNone(summaries[1]["dayMinWindow"])


if __name__ == "__main__":
    unittest.main()
