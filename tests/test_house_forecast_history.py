from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
LOCAL_TZ = timezone(timedelta(hours=2))


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

    solar_bias_pkg = sys.modules.get("custom_components.helman.solar_bias_correction")
    if solar_bias_pkg is None:
        solar_bias_pkg = types.ModuleType("custom_components.helman.solar_bias_correction")
        sys.modules["custom_components.helman.solar_bias_correction"] = solar_bias_pkg
    solar_bias_pkg.__path__ = [str(ROOT / "custom_components" / "helman" / "solar_bias_correction")]

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

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}

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


_install_import_stubs()

from custom_components.helman.solar_bias_correction import house_forecast_history  # noqa: E402


def _state(value: float, ts_iso: str):
    return SimpleNamespace(state=str(value), last_changed=datetime.fromisoformat(ts_iso))


class HouseForecastHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_buckets_state_changes_into_15min_slots(self):
        target = date(2026, 5, 10)
        # Two state values spanning the day: 800 W from 00:00 to 12:00, then 1200 W
        states = [
            _state(800, "2026-05-10T00:00:00+02:00"),
            _state(1200, "2026-05-10T12:00:00+02:00"),
        ]
        fake_get_states = AsyncMock(return_value={
            "sensor.helman_house_consumption_forecast_current": states,
        })
        hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
        with patch.object(house_forecast_history, "get_significant_states", fake_get_states):
            points = await house_forecast_history.load_house_forecast_points_for_day(hass, target)
        self.assertEqual(len(points), 96)
        # First slot: 800 W → 800 / 4 = 200 Wh
        # Timestamp is ISO local with tz offset, e.g. "2026-05-10T00:00:00+02:00"
        self.assertIn("T00:00:00", points[0]["timestamp"])
        self.assertAlmostEqual(points[0]["wh"], 200.0, places=3)
        # Slot at 12:00 onward: 1200 W → 300 Wh
        noon = next(p for p in points if "T12:00:00" in p["timestamp"])
        self.assertAlmostEqual(noon["wh"], 300.0, places=3)

    async def test_returns_empty_when_no_states(self):
        target = date(2026, 5, 9)
        fake_get_states = AsyncMock(return_value={})
        hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
        with patch.object(house_forecast_history, "get_significant_states", fake_get_states):
            points = await house_forecast_history.load_house_forecast_points_for_day(hass, target)
        self.assertEqual(points, [])


if __name__ == "__main__":
    unittest.main()
