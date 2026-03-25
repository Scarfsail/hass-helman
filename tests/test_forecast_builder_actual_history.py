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


class _FakeStateMachine:
    def get(self, entity_id: str):
        return None


_install_import_stubs()


class ForecastBuilderActualHistoryTests(unittest.IsolatedAsyncioTestCase):
    def _make_builder(self):
        forecast_builder_module = importlib.reload(
            importlib.import_module("custom_components.helman.forecast_builder")
        )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=_FakeStateMachine(),
        )
        return (
            forecast_builder_module,
            forecast_builder_module.HelmanForecastBuilder(hass, {}),
        )

    async def test_build_solar_actual_history_defaults_to_hourly_query(self) -> None:
        forecast_builder_module, builder = self._make_builder()
        slot_start = datetime(2026, 3, 20, 20, 0, tzinfo=TZ)
        query_mock = AsyncMock(return_value={_FakeDtUtil.as_utc(slot_start): 1.5})

        with (
            patch.object(
                builder,
                "_read_solar_actual_energy_entity_id",
                return_value="sensor.solar_actual",
            ),
            patch.dict(
                forecast_builder_module.HelmanForecastBuilder._build_solar_actual_history.__globals__,
                {
                    "dt_util": _FakeDtUtil,
                    "query_slot_energy_changes": query_mock,
                },
            ),
        ):
            actual_history = await builder._build_solar_actual_history(REFERENCE_TIME)

        query_mock.assert_awaited_once_with(
            builder._hass,
            "sensor.solar_actual",
            REFERENCE_TIME,
            interval_minutes=60,
        )
        self.assertEqual(
            actual_history,
            [
                {
                    "timestamp": "2026-03-20T20:00:00+01:00",
                    "value": 1500.0,
                }
            ],
        )

    async def test_build_solar_actual_history_supports_custom_interval(self) -> None:
        forecast_builder_module, builder = self._make_builder()
        slot_start = datetime(2026, 3, 20, 20, 15, tzinfo=TZ)
        query_mock = AsyncMock(
            return_value={
                _FakeDtUtil.as_utc(slot_start): 0.25,
                datetime(2026, 3, 20, 19, 30, tzinfo=UTC): 0.3,
            }
        )

        with (
            patch.object(
                builder,
                "_read_solar_actual_energy_entity_id",
                return_value="sensor.solar_actual",
            ),
            patch.dict(
                forecast_builder_module.HelmanForecastBuilder._build_solar_actual_history.__globals__,
                {
                    "dt_util": _FakeDtUtil,
                    "query_slot_energy_changes": query_mock,
                },
            ),
        ):
            actual_history = await builder._build_solar_actual_history(
                REFERENCE_TIME,
                interval_minutes=15,
            )

        query_mock.assert_awaited_once_with(
            builder._hass,
            "sensor.solar_actual",
            REFERENCE_TIME,
            interval_minutes=15,
        )
        self.assertEqual(
            actual_history,
            [
                {
                    "timestamp": "2026-03-20T20:15:00+01:00",
                    "value": 250.0,
                },
                {
                    "timestamp": "2026-03-20T20:30:00+01:00",
                    "value": 300.0,
                },
            ],
        )

    async def test_build_solar_actual_history_returns_empty_when_entity_missing(self) -> None:
        forecast_builder_module, builder = self._make_builder()
        query_mock = AsyncMock()

        with (
            patch.object(
                builder,
                "_read_solar_actual_energy_entity_id",
                return_value=None,
            ),
            patch.dict(
                forecast_builder_module.HelmanForecastBuilder._build_solar_actual_history.__globals__,
                {
                    "dt_util": _FakeDtUtil,
                    "query_slot_energy_changes": query_mock,
                },
            ),
        ):
            actual_history = await builder._build_solar_actual_history(REFERENCE_TIME)

        query_mock.assert_not_awaited()
        self.assertEqual(actual_history, [])

    async def test_build_solar_forecast_uses_canonical_actual_history_interval(self) -> None:
        _, builder = self._make_builder()
        builder._config = {
            "power_devices": {
                "solar": {
                    "forecast": {
                        "daily_energy_entity_ids": ["sensor.solar_forecast_day_0"],
                    },
                    "entities": {
                        "remaining_today_energy_forecast": "sensor.remaining_today_energy",
                    },
                }
            }
        }
        actual_history_mock = AsyncMock(return_value=[{"timestamp": "history"}])

        with (
            patch.object(
                builder,
                "_extract_hourly_solar_points",
                return_value=[
                    (
                        datetime.fromisoformat("2026-03-20T22:00:00+01:00"),
                        {
                            "timestamp": "2026-03-20T22:00:00+01:00",
                            "value": 250.0,
                        },
                    )
                ],
            ),
            patch.object(builder, "_read_first_unit", return_value="Wh"),
            patch.object(builder, "_build_solar_actual_history", actual_history_mock),
        ):
            payload = await builder._build_solar_forecast(REFERENCE_TIME)

        self.assertEqual(payload["status"], "available")
        self.assertEqual(payload["actualHistory"], [{"timestamp": "history"}])
        actual_history_mock.assert_awaited_once_with(
            REFERENCE_TIME,
            interval_minutes=15,
        )


if __name__ == "__main__":
    unittest.main()
