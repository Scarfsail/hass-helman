from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from _ha_stubs import install_helman_packages, stub_module

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
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

    @staticmethod
    def _reader(query_mock: AsyncMock) -> SimpleNamespace:
        """A stand-in for the coordinator's shared boundary reader."""
        return SimpleNamespace(
            async_query_slot_boundary_state_values=query_mock
        )

    async def test_default_interval_keeps_hourly_behavior(self) -> None:
        slot_start = datetime(2026, 3, 20, 20, 0, tzinfo=TZ)
        boundary_samples = {
            _FakeDtUtil.as_utc(slot_start): 30.0,
            _FakeDtUtil.as_utc(slot_start.replace(hour=21)): 35.0,
        }

        query_mock = AsyncMock(return_value=boundary_samples)

        with (
            patch.object(
                battery_actual_history_builder,
                "get_today_completed_local_slots",
                return_value=[slot_start],
            ) as slots_mock,
        ):
            actual_history = await battery_actual_history_builder.build_battery_actual_history(
                self._reader(query_mock),
                "sensor.battery_soc",
                REFERENCE_TIME,
            )

        query_mock.assert_awaited_once_with(
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
        slot_start = datetime(2026, 3, 20, 20, 15, tzinfo=TZ)
        boundary_samples = {
            _FakeDtUtil.as_utc(slot_start): 40.0,
            datetime(2026, 3, 20, 19, 30, tzinfo=UTC): 41.25,
        }

        query_mock = AsyncMock(return_value=boundary_samples)

        with (
            patch.object(
                battery_actual_history_builder,
                "get_today_completed_local_slots",
                return_value=[slot_start],
            ),
        ):
            actual_history = await battery_actual_history_builder.build_battery_actual_history(
                self._reader(query_mock),
                "sensor.battery_soc",
                REFERENCE_TIME,
                interval_minutes=15,
            )

        query_mock.assert_awaited_once_with(
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
        slot_start = datetime(2026, 3, 20, 20, 15, tzinfo=TZ)
        boundary_samples = {
            _FakeDtUtil.as_utc(slot_start): 120.0,
        }

        query_mock = AsyncMock(return_value=boundary_samples)

        with (
            patch.object(
                battery_actual_history_builder,
                "get_today_completed_local_slots",
                return_value=[slot_start],
            ),
        ):
            actual_history = await battery_actual_history_builder.build_battery_actual_history(
                self._reader(query_mock),
                "sensor.battery_soc",
                REFERENCE_TIME,
                interval_minutes=15,
            )

        self.assertEqual(actual_history, [])


if __name__ == "__main__":
    unittest.main()
