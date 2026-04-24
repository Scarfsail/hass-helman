from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
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

from custom_components.helman.solar_bias_correction import forecast_history  # noqa: E402
from custom_components.helman.solar_bias_correction.models import BiasConfig  # noqa: E402


class _FakeState:
    def __init__(self, state: str, last_updated: datetime) -> None:
        self.state = state
        self.last_updated = last_updated


class ForecastHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_ignores_midnight_boundary_state(self) -> None:
        hass = SimpleNamespace()
        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )
        midnight = datetime(2026, 3, 20, 0, 0, tzinfo=TZ)
        later = datetime(2026, 3, 20, 0, 5, tzinfo=TZ)
        history = {
            "sensor.energy_production_today": [
                _FakeState("1.0", midnight),
                _FakeState("2.0", later),
            ]
        }

        async def _get_significant_states(hass_arg, start_time, end_time, **kwargs):
            if start_time.date() == datetime(2026, 3, 20, tzinfo=TZ).date():
                return history
            return {}

        with patch.object(
            forecast_history,
            "get_significant_states",
            AsyncMock(side_effect=_get_significant_states),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass,
                cfg,
                datetime(2026, 3, 21, 12, 0, tzinfo=TZ),
            )

        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0].forecast_wh, 2000.0)


if __name__ == "__main__":
    unittest.main()
