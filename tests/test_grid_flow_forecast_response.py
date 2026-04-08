from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


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

    recorder_mod = sys.modules.get("custom_components.helman.recorder_hourly_series")
    if recorder_mod is None:
        recorder_mod = types.ModuleType(
            "custom_components.helman.recorder_hourly_series"
        )
        sys.modules["custom_components.helman.recorder_hourly_series"] = recorder_mod
    recorder_mod.get_local_current_slot_start = (
        lambda reference_time, *, interval_minutes: reference_time.replace(
            minute=(reference_time.minute // interval_minutes) * interval_minutes,
            second=0,
            microsecond=0,
        )
    )
    async def _estimate_average_hourly_energy_when_switch_on(*args, **kwargs):
        return None

    async def _estimate_average_hourly_energy_when_climate_active(*args, **kwargs):
        return None

    recorder_mod.estimate_average_hourly_energy_when_switch_on = (
        _estimate_average_hourly_energy_when_switch_on
    )
    recorder_mod.estimate_average_hourly_energy_when_climate_active = (
        _estimate_average_hourly_energy_when_climate_active
    )

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
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


class _FakeDtUtil:
    @staticmethod
    def as_local(value: datetime) -> datetime:
        if value.tzinfo == TZ:
            return value
        return value.astimezone(TZ)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)

    @staticmethod
    def parse_datetime(value: str) -> datetime:
        return datetime.fromisoformat(value)


_install_import_stubs()

from custom_components.helman import grid_flow_forecast_response, slot_series_response  # noqa: E402


def _make_snapshot(*, include_baseline: bool = True, schedule_adjusted: bool = True) -> dict:
    snapshot = {
        "status": "partial",
        "generatedAt": "2026-03-20T21:20:30+01:00",
        "startedAt": "2026-03-20T21:20:00+01:00",
        "unit": "kWh",
        "sourceGranularityMinutes": 15,
        "partialReason": "solar_forecast_ended",
        "coverageUntil": "2026-03-20T23:00:00+01:00",
        "series": [
            {
                "timestamp": "2026-03-20T21:20:00+01:00",
                "durationHours": 10 / 60,
                "importedFromGridKwh": 0.1,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
            },
            {
                "timestamp": "2026-03-20T22:00:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.3,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:15:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.1,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.2,
            },
            {
                "timestamp": "2026-03-20T22:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
            },
        ],
    }
    if include_baseline:
        snapshot["scheduleAdjusted"] = schedule_adjusted
        snapshot["scheduleAdjustmentCoverageUntil"] = "2026-03-20T23:00:00+01:00"
        snapshot["baselineSeries"] = [
            {
                "timestamp": "2026-03-20T21:20:00+01:00",
                "durationHours": 10 / 60,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T21:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
            },
            {
                "timestamp": "2026-03-20T22:00:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.4,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:15:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.1,
                "exportedToGridKwh": 0.0,
            },
            {
                "timestamp": "2026-03-20T22:30:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.2,
            },
            {
                "timestamp": "2026-03-20T22:45:00+01:00",
                "durationHours": 0.25,
                "importedFromGridKwh": 0.0,
                "exportedToGridKwh": 0.1,
            },
        ]
    return snapshot


class GridFlowForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._grid_dt_patcher = patch.object(
            slot_series_response,
            "dt_util",
            _FakeDtUtil,
        )
        cls._grid_dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._grid_dt_patcher.stop()

    def test_quarter_hour_response_keeps_canonical_entries_and_nested_baseline(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(),
            granularity=15,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "quarter_hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertAlmostEqual(response["series"][0]["durationHours"], 10 / 60, places=4)
        self.assertEqual(
            response["series"][0]["baseline"],
            {
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
        )

    def test_hourly_response_aggregates_partial_first_bucket_and_baseline(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(),
            granularity=60,
            forecast_days=1,
        )

        self.assertEqual(len(response["series"]), 2)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertAlmostEqual(response["series"][0]["durationHours"], 2 / 3, places=4)
        self.assertAlmostEqual(response["series"][0]["importedFromGridKwh"], 0.3, places=4)
        self.assertAlmostEqual(response["series"][0]["exportedToGridKwh"], 0.1, places=4)
        self.assertEqual(
            response["series"][0]["baseline"],
            {
                "importedFromGridKwh": 0.4,
                "exportedToGridKwh": 0.1,
            },
        )
        self.assertEqual(response["series"][1]["timestamp"], "2026-03-20T22:00:00+01:00")
        self.assertEqual(response["series"][1]["durationHours"], 1.0)
        self.assertEqual(
            response["series"][1]["baseline"],
            {
                "importedFromGridKwh": 0.5,
                "exportedToGridKwh": 0.3,
            },
        )

    def test_scheduler_context_without_adjustment_still_emits_baseline(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(schedule_adjusted=False),
            granularity=15,
            forecast_days=1,
        )

        self.assertFalse(response["scheduleAdjusted"])
        self.assertIn("baseline", response["series"][0])
        self.assertEqual(
            response["series"][1]["baseline"],
            {
                "importedFromGridKwh": 0.2,
                "exportedToGridKwh": 0.0,
            },
        )

    def test_response_omits_baseline_without_schedule_context(self) -> None:
        response = grid_flow_forecast_response.build_grid_flow_forecast_response(
            _make_snapshot(include_baseline=False),
            granularity=15,
            forecast_days=1,
        )

        self.assertNotIn("scheduleAdjusted", response)
        self.assertNotIn("baseline", response["series"][0])


if __name__ == "__main__":
    unittest.main()
