from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
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
    if not hasattr(dt_mod, "now"):
        dt_mod.now = lambda: REFERENCE_TIME
    if not hasattr(dt_mod, "utc_from_timestamp"):
        dt_mod.utc_from_timestamp = lambda ts: datetime.fromtimestamp(ts, tz=UTC)
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
    def now() -> datetime:
        return REFERENCE_TIME

    @staticmethod
    def utc_from_timestamp(timestamp: float) -> datetime:
        return datetime.fromtimestamp(timestamp, tz=UTC)


class _FakeBand:
    def __init__(self, value: float, lower: float, upper: float) -> None:
        self._value = value
        self._lower = lower
        self._upper = upper

    def to_dict(self) -> dict[str, float]:
        return {
            "value": self._value,
            "lower": self._lower,
            "upper": self._upper,
        }


class _FakeProfile:
    def __init__(self, value: float, lower: float, upper: float) -> None:
        self._value = value
        self._lower = lower
        self._upper = upper

    def forecast(self, weekday: int, hour: int) -> _FakeBand:
        return _FakeBand(self._value, self._lower, self._upper)


_install_import_stubs()


class ConsumptionForecastBuilderTests(unittest.IsolatedAsyncioTestCase):
    def _make_builder(self):
        recorder_module = importlib.reload(
            importlib.import_module("custom_components.helman.recorder_hourly_series")
        )
        consumption_module = importlib.reload(
            importlib.import_module("custom_components.helman.consumption_forecast_builder")
        )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=SimpleNamespace(get=lambda entity_id: None),
        )
        config = {
            "power_devices": {
                "house": {
                    "forecast": {
                        "total_energy_entity_id": "sensor.house_total",
                        "training_window_days": 56,
                        "min_history_days": 14,
                        "deferrable_consumers": [
                            {
                                "energy_entity_id": "sensor.washer_energy",
                                "label": "Washer",
                            }
                        ],
                    }
                }
            }
        }
        return (
            consumption_module,
            recorder_module,
            consumption_module.ConsumptionForecastBuilder(hass, config),
        )

    async def _build_payload(
        self,
        *,
        reference_time: datetime,
        forecast_days: int,
    ) -> dict:
        consumption_module, recorder_module, builder = self._make_builder()
        fake_profiles = (
            _FakeProfile(4.0, 2.0, 6.0),
            {"sensor.washer_energy": _FakeProfile(2.0, 1.0, 3.0)},
        )
        hourly_rows = [
            {
                "start": datetime(2026, 2, 20, 0, 0, tzinfo=UTC).timestamp(),
                "change": 1.0,
            }
        ]

        with (
            patch.object(consumption_module, "dt_util", _FakeDtUtil),
            patch.object(recorder_module, "dt_util", _FakeDtUtil),
            patch.object(
                builder,
                "_query_hourly_history",
                AsyncMock(return_value=hourly_rows),
            ),
            patch.object(builder, "_compute_history_days", return_value=28),
            patch.object(
                builder,
                "_query_consumer_histories",
                AsyncMock(return_value=[]),
            ),
            patch.object(builder, "_build_profiles", return_value=fake_profiles),
            patch.object(
                builder,
                "_build_actual_history",
                AsyncMock(return_value=[]),
            ),
        ):
            return await builder.build(
                reference_time=reference_time,
                forecast_days=forecast_days,
            )

    async def test_build_one_day_series_is_canonical_quarter_hour(self) -> None:
        payload = await self._build_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=1,
        )

        self.assertEqual(payload["resolution"], "quarter_hour")
        self.assertEqual(payload["horizonHours"], 24)
        self.assertEqual(payload["currentSlot"]["timestamp"], "2026-03-20T21:00:00+01:00")
        self.assertNotIn("currentHour", payload)
        self.assertEqual(len(payload["series"]), 96)
        self.assertEqual(payload["series"][0]["timestamp"], "2026-03-20T21:15:00+01:00")

    async def test_build_seven_day_series_length_matches_requested_horizon(self) -> None:
        payload = await self._build_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=7,
        )

        self.assertEqual(payload["horizonHours"], 168)
        self.assertEqual(len(payload["series"]), 672)

    async def test_quarter_hour_values_sum_back_to_hourly_band(self) -> None:
        payload = await self._build_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=1,
        )

        first_hour_entries = [payload["currentSlot"], *payload["series"][:3]]
        self.assertAlmostEqual(
            sum(entry["nonDeferrable"]["value"] for entry in first_hour_entries),
            4.0,
        )
        self.assertAlmostEqual(
            sum(entry["nonDeferrable"]["lower"] for entry in first_hour_entries),
            2.0,
        )
        self.assertAlmostEqual(
            sum(entry["nonDeferrable"]["upper"] for entry in first_hour_entries),
            6.0,
        )
        self.assertAlmostEqual(
            sum(
                entry["deferrableConsumers"][0]["value"]
                for entry in first_hour_entries
            ),
            2.0,
        )
        self.assertAlmostEqual(
            sum(
                entry["deferrableConsumers"][0]["lower"]
                for entry in first_hour_entries
            ),
            1.0,
        )
        self.assertAlmostEqual(
            sum(
                entry["deferrableConsumers"][0]["upper"]
                for entry in first_hour_entries
            ),
            3.0,
        )

    async def test_current_slot_alignment_follows_quarter_hour_boundaries(self) -> None:
        payload = await self._build_payload(
            reference_time=datetime.fromisoformat("2026-03-20T21:16:00+01:00"),
            forecast_days=1,
        )

        self.assertEqual(payload["currentSlot"]["timestamp"], "2026-03-20T21:15:00+01:00")


if __name__ == "__main__":
    unittest.main()
