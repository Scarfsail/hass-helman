from __future__ import annotations

from homeassistant.util import dt as dt_util

import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from _ha_stubs import stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


def _install_import_stubs() -> None:

    core_mod = stub_module("homeassistant.core")
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    recorder_mod = stub_module("homeassistant.components.recorder")
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = stub_module("homeassistant.components.recorder.history")
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt")
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod




_install_import_stubs()
from custom_components.helman import battery_forecast_response, slot_grid  # noqa: E402


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
            dt_util,
        )
        cls._recorder_dt_patcher = patch.object(
            slot_grid,
            "dt_util",
            dt_util,
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
            forecast_days=1,
        )

        self.assertEqual(len(response["series"]), 7)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertEqual(len(response["actualHistory"]), 4)

    def test_response_carries_partial_coverage_metadata(self) -> None:
        response = battery_forecast_response.build_battery_forecast_response(
            _make_snapshot(),
            forecast_days=1,
        )

        self.assertEqual(response["partialReason"], "solar_forecast_ended")
        self.assertEqual(response["coverageUntil"], "2026-03-20T23:00:00+01:00")
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:20:00+01:00")
        self.assertAlmostEqual(
            response["series"][0]["durationHours"], 10 / 60, places=4
        )
        self.assertEqual(response["series"][0]["remainingEnergyKwh"], 5.1)
        self.assertEqual(response["series"][0]["socPct"], 51.0)
        # History stops before the slot the run started in (21:20 floors to
        # 21:15); that slot belongs to the series, never to history.
        self.assertEqual(
            response["actualHistory"][-1]["timestamp"], "2026-03-20T20:45:00+01:00"
        )

    def test_response_preserves_schedule_metadata_but_omits_baseline_fields(self) -> None:
        response = battery_forecast_response.build_battery_forecast_response(
            _make_adjusted_snapshot(),
            forecast_days=1,
        )

        self.assertTrue(response["scheduleAdjusted"])
        self.assertEqual(
            response["scheduleAdjustmentCoverageUntil"],
            "2026-03-20T23:00:00+01:00",
        )
        self.assertNotIn("baselineRemainingEnergyKwh", response["series"][0])
        self.assertNotIn("baselineSocPct", response["series"][0])

    def test_response_does_not_expose_internal_baseline_series(self) -> None:
        snapshot = _make_adjusted_snapshot()
        snapshot["baselineSeries"] = [
            {
                "timestamp": "2026-03-20T21:20:00+01:00",
                "durationHours": 10 / 60,
                "importedFromGridKwh": 0.1,
                "exportedToGridKwh": 0.0,
            }
        ]

        response = battery_forecast_response.build_battery_forecast_response(
            snapshot,
            forecast_days=1,
        )

        self.assertNotIn("baselineSeries", response)

    def test_response_does_not_expose_internal_available_surplus_field(self) -> None:
        snapshot = _make_snapshot()
        snapshot["series"][0]["availableSurplusKwh"] = 0.2

        response = battery_forecast_response.build_battery_forecast_response(
            snapshot,
            forecast_days=1,
        )

        self.assertNotIn("availableSurplusKwh", response["series"][0])

    def test_response_keeps_schedule_adjustment_coverage_distinct_from_coverage_until(
        self,
    ) -> None:
        snapshot = _make_adjusted_snapshot()
        snapshot["coverageUntil"] = "2026-03-21T00:00:00+01:00"

        response = battery_forecast_response.build_battery_forecast_response(
            snapshot,
            forecast_days=1,
        )

        self.assertEqual(response["coverageUntil"], "2026-03-21T00:00:00+01:00")
        self.assertEqual(
            response["scheduleAdjustmentCoverageUntil"],
            "2026-03-20T23:00:00+01:00",
        )


if __name__ == "__main__":
    unittest.main()
