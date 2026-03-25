from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
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


_install_import_stubs()

from custom_components.helman import battery_actual_history_builder  # noqa: E402


class BatteryActualHistoryBuilderTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(
            battery_actual_history_builder,
            "dt_util",
            _FakeDtUtil,
        )
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    async def test_default_interval_keeps_hourly_behavior(self) -> None:
        hass = object()
        slot_start = datetime(2026, 3, 20, 20, 0, tzinfo=TZ)
        boundary_samples = {
            _FakeDtUtil.as_utc(slot_start): 30.0,
            _FakeDtUtil.as_utc(slot_start.replace(hour=21)): 35.0,
        }

        with (
            patch.object(
                battery_actual_history_builder,
                "query_slot_boundary_state_values",
                AsyncMock(return_value=boundary_samples),
            ) as query_mock,
            patch.object(
                battery_actual_history_builder,
                "get_today_completed_local_slots",
                return_value=[slot_start],
            ) as slots_mock,
        ):
            actual_history = await battery_actual_history_builder.build_battery_actual_history(
                hass,
                "sensor.battery_soc",
                REFERENCE_TIME,
            )

        query_mock.assert_awaited_once_with(
            hass,
            "sensor.battery_soc",
            REFERENCE_TIME,
            interval_minutes=60,
        )
        slots_mock.assert_called_once_with(REFERENCE_TIME, interval_minutes=60)
        self.assertEqual(
            actual_history,
            [
                {
                    "timestamp": "2026-03-20T20:00:00+01:00",
                    "startSocPct": 30.0,
                    "socPct": 35.0,
                }
            ],
        )

    async def test_interval_minutes_15_emits_quarter_hour_entry(self) -> None:
        hass = object()
        slot_start = datetime(2026, 3, 20, 20, 15, tzinfo=TZ)
        boundary_samples = {
            _FakeDtUtil.as_utc(slot_start): 40.0,
            datetime(2026, 3, 20, 19, 30, tzinfo=UTC): 41.25,
        }

        with (
            patch.object(
                battery_actual_history_builder,
                "query_slot_boundary_state_values",
                AsyncMock(return_value=boundary_samples),
            ) as query_mock,
            patch.object(
                battery_actual_history_builder,
                "get_today_completed_local_slots",
                return_value=[slot_start],
            ),
        ):
            actual_history = await battery_actual_history_builder.build_battery_actual_history(
                hass,
                "sensor.battery_soc",
                REFERENCE_TIME,
                interval_minutes=15,
            )

        query_mock.assert_awaited_once_with(
            hass,
            "sensor.battery_soc",
            REFERENCE_TIME,
            interval_minutes=15,
        )
        self.assertEqual(
            actual_history,
            [
                {
                    "timestamp": "2026-03-20T20:15:00+01:00",
                    "startSocPct": 40.0,
                    "socPct": 41.25,
                }
            ],
        )

    async def test_invalid_or_missing_soc_boundaries_are_skipped(self) -> None:
        hass = object()
        slot_start = datetime(2026, 3, 20, 20, 15, tzinfo=TZ)
        boundary_samples = {
            _FakeDtUtil.as_utc(slot_start): 120.0,
        }

        with (
            patch.object(
                battery_actual_history_builder,
                "query_slot_boundary_state_values",
                AsyncMock(return_value=boundary_samples),
            ),
            patch.object(
                battery_actual_history_builder,
                "get_today_completed_local_slots",
                return_value=[slot_start],
            ),
        ):
            actual_history = await battery_actual_history_builder.build_battery_actual_history(
                hass,
                "sensor.battery_soc",
                REFERENCE_TIME,
                interval_minutes=15,
            )

        self.assertEqual(actual_history, [])


if __name__ == "__main__":
    unittest.main()
