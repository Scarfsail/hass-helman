from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from _ha_stubs import install_helman_packages, stub_module

TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


def _install_import_stubs() -> None:
    install_helman_packages()
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

from custom_components.helman import house_forecast_response  # noqa: E402


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
        cls._house_dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._house_dt_patcher.stop()

    def test_quarter_hour_response_keeps_canonical_series_length(self) -> None:
        response = house_forecast_response.build_house_forecast_response(
            _make_canonical_snapshot(),
            forecast_days=1,
        )

        self.assertEqual(response["resolution"], "quarter_hour")
        self.assertEqual(response["currentSlot"]["timestamp"], "2026-03-20T21:15:00+01:00")
        self.assertEqual(len(response["series"]), 96)
        self.assertEqual(response["series"][0]["timestamp"], "2026-03-20T21:30:00+01:00")
        self.assertEqual(len(response["actualHistory"]), 5)

if __name__ == "__main__":
    unittest.main()
