from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
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

from custom_components.helman import house_forecast_response, recorder_hourly_series  # noqa: E402


def _make_house_entry(
    slot_start: datetime,
    *,
    non_deferrable_value: float,
    consumer_value: float,
) -> dict:
    return {
        "timestamp": slot_start.isoformat(),
        "nonDeferrable": {"value": non_deferrable_value},
        "deferrableConsumers": [
            {
                "entityId": "sensor.washer_energy",
                "label": "Washer",
                "value": consumer_value,
            }
        ],
    }


def _make_canonical_snapshot() -> dict:
    current_slot_start = datetime(2026, 3, 20, 21, 15, tzinfo=TZ)
    current_hour_start = current_slot_start.replace(minute=0, second=0, microsecond=0)

    def hour_value(slot_start: datetime) -> float:
        slot_hour_start = slot_start.replace(minute=0, second=0, microsecond=0)
        delta_hours = int(
            (
                slot_hour_start.astimezone(UTC) - current_hour_start.astimezone(UTC)
            ).total_seconds()
            // 3600
        )
        return float(delta_hours + 1)

    current_slot = _make_house_entry(
        current_slot_start,
        non_deferrable_value=hour_value(current_slot_start),
        consumer_value=hour_value(current_slot_start) / 2,
    )

    actual_history = [
        _make_house_entry(
            datetime(2026, 3, 20, 20, minute, tzinfo=TZ),
            non_deferrable_value=0.25,
            consumer_value=0.125,
        )
        for minute in (0, 15, 30, 45)
    ] + [
        _make_house_entry(
            datetime(2026, 3, 20, 21, 0, tzinfo=TZ),
            non_deferrable_value=0.5,
            consumer_value=0.25,
        )
    ]

    series: list[dict] = []
    first_series_utc = current_slot_start.astimezone(UTC) + timedelta(minutes=15)
    for index in range(99):
        slot_start = (first_series_utc + timedelta(minutes=15 * index)).astimezone(TZ)
        value = hour_value(slot_start)
        series.append(
            _make_house_entry(
                slot_start,
                non_deferrable_value=value,
                consumer_value=value / 2,
            )
        )

    return {
        "status": "available",
        "generatedAt": "2026-03-20T21:16:00+01:00",
        "unit": "kWh",
        "resolution": "quarter_hour",
        "horizonHours": 24,
        "trainingWindowDays": 56,
        "historyDaysAvailable": 28,
        "requiredHistoryDays": 14,
        "model": "hour_of_week_winsorized_mean",
        "configFingerprint": "abc123",
        "sourceGranularityMinutes": 15,
        "forecastDaysAvailable": 1,
        "alignmentPaddingSlots": 3,
        "currentSlot": current_slot,
        "actualHistory": actual_history,
        "series": series,
    }


class HouseForecastResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._house_dt_patcher = patch.object(
            house_forecast_response,
            "dt_util",
            _FakeDtUtil,
        )
        cls._recorder_dt_patcher = patch.object(
            recorder_hourly_series,
            "dt_util",
            _FakeDtUtil,
        )
        cls._house_dt_patcher.start()
        cls._recorder_dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._house_dt_patcher.stop()
        cls._recorder_dt_patcher.stop()

    def test_quarter_hour_response_keeps_canonical_series_length(self) -> None:
        response = house_forecast_response.build_house_forecast_response(
            _make_canonical_snapshot(),
            granularity=15,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "quarter_hour")
        self.assertEqual(response["currentSlot"]["timestamp"], "2026-03-20T21:15:00+01:00")
        self.assertEqual(len(response["series"]), 96)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:30:00+01:00")
        self.assertEqual(len(response["actualHistory"]), 5)

    def test_hourly_response_aggregates_current_slot_series_and_history(self) -> None:
        response = house_forecast_response.build_house_forecast_response(
            _make_canonical_snapshot(),
            granularity=60,
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "hour")
        self.assertEqual(response["horizonHours"], 24)
        self.assertEqual(response["currentSlot"]["timestamp"], "2026-03-20T21:00:00+01:00")
        self.assertEqual(response["currentSlot"]["nonDeferrable"]["value"], 4.0)
        self.assertEqual(response["currentSlot"]["deferrableConsumers"][0]["value"], 2.0)
        self.assertEqual(len(response["series"]), 24)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T22:00:00+01:00")
        self.assertEqual(response["series"][0]["nonDeferrable"]["value"], 8.0)
        self.assertEqual(response["series"][0]["deferrableConsumers"][0]["value"], 4.0)
        self.assertEqual(response["actualHistory"], [
            {
                "timestamp": "2026-03-20T20:00:00+01:00",
                "nonDeferrable": {"value": 1.0},
                "deferrableConsumers": [
                    {
                        "entityId": "sensor.washer_energy",
                        "label": "Washer",
                        "value": 0.5,
                    }
                ],
            }
        ])


if __name__ == "__main__":
    unittest.main()
