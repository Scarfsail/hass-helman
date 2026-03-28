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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
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
from custom_components.helman import battery_forecast_response, recorder_hourly_series  # noqa: E402


def _make_series_entry(
    timestamp: str,
    *,
    duration_hours: float,
    remaining_energy_kwh: float,
    soc_pct: float,
    hit_min_soc: bool = False,
    baseline_remaining_energy_kwh: float | None = None,
    baseline_soc_pct: float | None = None,
) -> dict:
    entry = {
        "timestamp": timestamp,
        "durationHours": duration_hours,
        "solarKwh": round(duration_hours, 4),
        "baselineHouseKwh": round(duration_hours / 2, 4),
        "netKwh": round(duration_hours / 2, 4),
        "chargedKwh": round(duration_hours / 2, 4),
        "dischargedKwh": 0.0,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.0,
        "remainingEnergyKwh": remaining_energy_kwh,
        "socPct": soc_pct,
        "hitMinSoc": hit_min_soc,
        "hitMaxSoc": False,
        "limitedByChargePower": False,
        "limitedByDischargePower": False,
    }
    if baseline_remaining_energy_kwh is not None:
        entry["baselineRemainingEnergyKwh"] = baseline_remaining_energy_kwh
    if baseline_soc_pct is not None:
        entry["baselineSocPct"] = baseline_soc_pct
    return entry


def _make_snapshot() -> dict:
    return {
        "status": "partial",
        "generatedAt": "2026-03-20T21:20:30+01:00",
        "startedAt": "2026-03-20T21:20:00+01:00",
        "unit": "kWh",
        "resolution": "quarter_hour",
        "horizonHours": 168,
        "sourceGranularityMinutes": 15,
        "partialReason": "solar_forecast_ended",
        "coverageUntil": "2026-03-20T23:00:00+01:00",
        "series": [
            _make_series_entry(
                "2026-03-20T21:20:00+01:00",
                duration_hours=10 / 60,
                remaining_energy_kwh=5.1,
                soc_pct=51.0,
            ),
            _make_series_entry(
                "2026-03-20T21:30:00+01:00",
                duration_hours=0.25,
                remaining_energy_kwh=5.2,
                soc_pct=52.0,
            ),
            _make_series_entry(
                "2026-03-20T21:45:00+01:00",
                duration_hours=0.25,
                remaining_energy_kwh=5.3,
                soc_pct=53.0,
                hit_min_soc=True,
            ),
            _make_series_entry(
                "2026-03-20T22:00:00+01:00",
                duration_hours=0.25,
                remaining_energy_kwh=5.4,
                soc_pct=54.0,
            ),
            _make_series_entry(
                "2026-03-20T22:15:00+01:00",
                duration_hours=0.25,
                remaining_energy_kwh=5.5,
                soc_pct=55.0,
            ),
            _make_series_entry(
                "2026-03-20T22:30:00+01:00",
                duration_hours=0.25,
                remaining_energy_kwh=5.6,
                soc_pct=56.0,
            ),
            _make_series_entry(
                "2026-03-20T22:45:00+01:00",
                duration_hours=0.25,
                remaining_energy_kwh=5.7,
                soc_pct=57.0,
            ),
        ],
        "actualHistory": [
            {
                "timestamp": "2026-03-20T20:00:00+01:00",
                "startSocPct": 40.0,
                "socPct": 41.0,
            },
            {
                "timestamp": "2026-03-20T20:15:00+01:00",
                "startSocPct": 41.0,
                "socPct": 42.0,
            },
            {
                "timestamp": "2026-03-20T20:30:00+01:00",
                "startSocPct": 42.0,
                "socPct": 43.0,
            },
            {
                "timestamp": "2026-03-20T20:45:00+01:00",
                "startSocPct": 43.0,
                "socPct": 44.0,
            },
        ],
    }


def _make_adjusted_snapshot() -> dict:
    snapshot = _make_snapshot()
    snapshot["scheduleAdjusted"] = True
    snapshot["scheduleAdjustmentCoverageUntil"] = "2026-03-20T23:00:00+01:00"
    snapshot["series"] = [
        _make_series_entry(
            "2026-03-20T21:20:00+01:00",
            duration_hours=10 / 60,
            remaining_energy_kwh=5.1,
            soc_pct=51.0,
            baseline_remaining_energy_kwh=4.9,
            baseline_soc_pct=49.0,
        ),
        _make_series_entry(
            "2026-03-20T21:30:00+01:00",
            duration_hours=0.25,
            remaining_energy_kwh=5.2,
            soc_pct=52.0,
            baseline_remaining_energy_kwh=5.0,
            baseline_soc_pct=50.0,
        ),
        _make_series_entry(
            "2026-03-20T21:45:00+01:00",
            duration_hours=0.25,
            remaining_energy_kwh=5.3,
            soc_pct=53.0,
            hit_min_soc=True,
            baseline_remaining_energy_kwh=5.1,
            baseline_soc_pct=51.0,
        ),
        _make_series_entry(
            "2026-03-20T22:00:00+01:00",
            duration_hours=0.25,
            remaining_energy_kwh=5.4,
            soc_pct=54.0,
            baseline_remaining_energy_kwh=5.2,
            baseline_soc_pct=52.0,
        ),
        _make_series_entry(
            "2026-03-20T22:15:00+01:00",
            duration_hours=0.25,
            remaining_energy_kwh=5.5,
            soc_pct=55.0,
            baseline_remaining_energy_kwh=5.3,
            baseline_soc_pct=53.0,
        ),
        _make_series_entry(
            "2026-03-20T22:30:00+01:00",
            duration_hours=0.25,
            remaining_energy_kwh=5.6,
            soc_pct=56.0,
            baseline_remaining_energy_kwh=5.4,
            baseline_soc_pct=54.0,
        ),
        _make_series_entry(
            "2026-03-20T22:45:00+01:00",
            duration_hours=0.25,
            remaining_energy_kwh=5.7,
            soc_pct=57.0,
            baseline_remaining_energy_kwh=5.5,
            baseline_soc_pct=55.0,
        ),
    ]
    return snapshot


class BatteryForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._response_dt_patcher = patch.object(
            battery_forecast_response,
            "dt_util",
            _FakeDtUtil,
        )
        cls._recorder_dt_patcher = patch.object(
            recorder_hourly_series,
            "dt_util",
            _FakeDtUtil,
        )
        cls._response_dt_patcher.start()
        cls._recorder_dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._response_dt_patcher.stop()
        cls._recorder_dt_patcher.stop()

    def test_quarter_hour_response_keeps_canonical_entries(self) -> None:
        response = battery_forecast_response.build_battery_forecast_response(
            _make_snapshot(),
            granularity=15,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "quarter_hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(len(response["series"]), 7)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertEqual(len(response["actualHistory"]), 4)

    def test_hourly_response_aggregates_current_bucket_and_history(self) -> None:
        response = battery_forecast_response.build_battery_forecast_response(
            _make_snapshot(),
            granularity=60,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["partialReason"], "solar_forecast_ended")
        self.assertEqual(response["coverageUntil"], "2026-03-20T23:00:00+01:00")
        self.assertEqual(len(response["series"]), 2)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertAlmostEqual(response["series"][0]["durationHours"], 2 / 3, places=4)
        self.assertEqual(response["series"][0]["remainingEnergyKwh"], 5.3)
        self.assertEqual(response["series"][0]["socPct"], 53.0)
        self.assertTrue(response["series"][0]["hitMinSoc"])
        self.assertEqual(response["series"][1]["timestamp"], "2026-03-20T22:00:00+01:00")
        self.assertEqual(response["series"][1]["durationHours"], 1.0)
        self.assertEqual(
            response["actualHistory"],
            [
                {
                    "timestamp": "2026-03-20T20:00:00+01:00",
                    "startSocPct": 40.0,
                    "socPct": 44.0,
                }
            ],
        )

    def test_hourly_response_drops_incomplete_trailing_group(self) -> None:
        snapshot = _make_snapshot()
        snapshot["series"] = snapshot["series"][:-1]

        response = battery_forecast_response.build_battery_forecast_response(
            snapshot,
            granularity=60,
            forecast_days=1,
        )

        self.assertEqual(len(response["series"]), 1)

    def test_hourly_response_preserves_schedule_metadata_and_baseline_fields(self) -> None:
        response = battery_forecast_response.build_battery_forecast_response(
            _make_adjusted_snapshot(),
            granularity=60,
            forecast_days=1,
        )

        self.assertTrue(response["scheduleAdjusted"])
        self.assertEqual(
            response["scheduleAdjustmentCoverageUntil"],
            "2026-03-20T23:00:00+01:00",
        )
        self.assertEqual(response["series"][0]["baselineRemainingEnergyKwh"], 5.1)
        self.assertEqual(response["series"][0]["baselineSocPct"], 51.0)
        self.assertEqual(response["series"][1]["baselineRemainingEnergyKwh"], 5.5)
        self.assertEqual(response["series"][1]["baselineSocPct"], 55.0)

    def test_hourly_response_keeps_schedule_adjustment_coverage_distinct_from_coverage_until(
        self,
    ) -> None:
        snapshot = _make_adjusted_snapshot()
        snapshot["coverageUntil"] = "2026-03-21T00:00:00+01:00"

        response = battery_forecast_response.build_battery_forecast_response(
            snapshot,
            granularity=60,
            forecast_days=1,
        )

        self.assertEqual(response["coverageUntil"], "2026-03-21T00:00:00+01:00")
        self.assertEqual(
            response["scheduleAdjustmentCoverageUntil"],
            "2026-03-20T23:00:00+01:00",
        )


if __name__ == "__main__":
    unittest.main()
