from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
TZ = timezone.utc


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
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}
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


_install_import_stubs()

from custom_components.helman.solar_bias_correction import actuals  # noqa: E402


class _FakeState:
    def __init__(self, state: str, last_updated: datetime) -> None:
        self.state = state
        self.last_updated = last_updated


class SolarBiasActualsTests(unittest.IsolatedAsyncioTestCase):
    async def test_ignores_recovery_after_cumulative_sensor_glitch_to_zero(self) -> None:
        states = [
            _FakeState("42026.4", datetime(2026, 4, 15, 0, 0, tzinfo=TZ)),
            _FakeState("42027.0", datetime(2026, 4, 15, 8, 0, tzinfo=TZ)),
            _FakeState("0.0", datetime(2026, 4, 15, 10, 29, tzinfo=TZ)),
            _FakeState("42029.7", datetime(2026, 4, 15, 10, 30, tzinfo=TZ)),
            _FakeState("42030.1", datetime(2026, 4, 15, 10, 45, tzinfo=TZ)),
        ]

        with patch.object(
            actuals,
            "_read_history_for_entity",
            AsyncMock(return_value=states),
        ):
            slot_actuals = await actuals._read_day_slot_actuals(
                SimpleNamespace(),
                "sensor.solax_total_solar_energy",
                date(2026, 4, 15),
                local_now=datetime(2026, 4, 16, 12, 0, tzinfo=TZ),
            )

        self.assertAlmostEqual(sum(slot_actuals.values()), 1000.0)


if __name__ == "__main__":
    unittest.main()
