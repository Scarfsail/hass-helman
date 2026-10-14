from __future__ import annotations

import types
import unittest
from datetime import date, datetime, timedelta, timezone

from _ha_stubs import stub_ha_dt, stub_module


TZ = timezone(timedelta(hours=2))


def _install_import_stubs() -> None:

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_ha_dt(datetime(2026, 7, 10, 12, 0, tzinfo=TZ))
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.day_context import (  # noqa: E402
    DayContext,
)
from custom_components.helman.automation.pipeline import (  # noqa: E402
    _summarize_day_contexts,
)


def _day_context(
    local_date: date,
    classification: str,
    *,
    ratio: float = 1.0,
) -> DayContext:
    return DayContext(
        local_date=local_date,
        classification=classification,
        predicted_solar_kwh=1.0,
        predicted_consumption_kwh=1.0,
        export_price_min=1.0,
        export_price_max=5.0,
        import_bands=(),
        ratio=ratio,
    )


class SummarizeDayContextsTests(unittest.TestCase):
    def test_returns_empty_without_snapshot(self) -> None:
        self.assertEqual(_summarize_day_contexts(None), [])

    def test_summarizes_classification_sorted_by_date(self) -> None:
        today = date(2026, 7, 10)
        tomorrow = date(2026, 7, 11)
        snapshot = types.SimpleNamespace(
            context=types.SimpleNamespace(
                day_contexts={
                    tomorrow: _day_context(tomorrow, "deficit"),
                    today: _day_context(today, "surplus"),
                }
            )
        )
        summaries = _summarize_day_contexts(snapshot)
        self.assertEqual(
            [entry["localDate"] for entry in summaries],
            ["2026-07-10", "2026-07-11"],
        )
        self.assertEqual(summaries[0]["classification"], "surplus")
        self.assertEqual(summaries[1]["classification"], "deficit")

    def test_summary_carries_the_ratio_behind_the_band(self) -> None:
        """The band is a live reading now, so the reading travels with it (#264)."""
        today = date(2026, 7, 10)
        snapshot = types.SimpleNamespace(
            context=types.SimpleNamespace(
                day_contexts={today: _day_context(today, "deficit", ratio=0.61)}
            )
        )
        self.assertEqual(_summarize_day_contexts(snapshot)[0]["ratio"], 0.61)

    def test_an_infinite_ratio_serializes_as_null(self) -> None:
        """A day with no forecast consumption at all is not a JSON number."""
        today = date(2026, 7, 10)
        snapshot = types.SimpleNamespace(
            context=types.SimpleNamespace(
                day_contexts={
                    today: _day_context(today, "surplus", ratio=float("inf"))
                }
            )
        )
        self.assertIsNone(_summarize_day_contexts(snapshot)[0]["ratio"])


if __name__ == "__main__":
    unittest.main()
