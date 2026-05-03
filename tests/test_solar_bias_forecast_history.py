from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
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
    if not hasattr(components_pkg, "__path__"):
        components_pkg.__path__ = []

    energy_pkg = sys.modules.get("homeassistant.components.energy")
    if energy_pkg is None:
        energy_pkg = types.ModuleType("homeassistant.components.energy")
        sys.modules["homeassistant.components.energy"] = energy_pkg
    if not hasattr(energy_pkg, "__path__"):
        energy_pkg.__path__ = []

    energy_ws_mod = sys.modules.get("homeassistant.components.energy.websocket_api")
    if energy_ws_mod is None:
        energy_ws_mod = types.ModuleType(
            "homeassistant.components.energy.websocket_api"
        )
        sys.modules["homeassistant.components.energy.websocket_api"] = energy_ws_mod
    if not hasattr(energy_ws_mod, "async_get_energy_platforms"):
        async def _async_get_energy_platforms(_hass):
            return []
        energy_ws_mod.async_get_energy_platforms = _async_get_energy_platforms

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

    helpers_pkg = sys.modules.get("homeassistant.helpers")
    if helpers_pkg is None:
        helpers_pkg = types.ModuleType("homeassistant.helpers")
        sys.modules["homeassistant.helpers"] = helpers_pkg
    if not hasattr(helpers_pkg, "__path__"):
        helpers_pkg.__path__ = []

    entity_registry_mod = sys.modules.get("homeassistant.helpers.entity_registry")
    if entity_registry_mod is None:
        entity_registry_mod = types.ModuleType("homeassistant.helpers.entity_registry")
        sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod
    if not hasattr(entity_registry_mod, "async_get"):
        entity_registry_mod.async_get = lambda _hass: None


_install_import_stubs()

from custom_components.helman.solar_bias_correction import forecast_history  # noqa: E402
from custom_components.helman.solar_bias_correction.models import BiasConfig  # noqa: E402


def _make_cfg(*, source_config_entry_id: str | None = "forecast-entry", max_training_window_days: int = 90) -> BiasConfig:
    return BiasConfig(
        enabled=True,
        min_history_days=10,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        source_config_entry_id=source_config_entry_id,
        total_energy_entity_id=None,
        max_training_window_days=max_training_window_days,
    )


def _make_hass():
    return SimpleNamespace(
        config=SimpleNamespace(time_zone="UTC"),
        config_entries=SimpleNamespace(async_get_entry=lambda entry_id: None),
    )


class LoadForecastPointsForDayTests(unittest.IsolatedAsyncioTestCase):
    async def test_load_forecast_points_for_past_day_reads_provider_wh_hours_slice(self) -> None:
        forecast = {
            "wh_hours": {
                "2026-05-02T04:00:00+00:00": 93,
                "2026-05-02T05:00:00+00:00": 866,
                "2026-05-03T04:00:00+00:00": 102,
            }
        }

        with patch.object(
            forecast_history,
            "async_load_upstream_solar_forecast",
            new=AsyncMock(return_value=forecast),
        ):
            result = await forecast_history.load_forecast_points_for_day(
                _make_hass(),
                _make_cfg(),
                date.fromisoformat("2026-05-02"),
                local_now=datetime(2026, 5, 3, 10, 0, tzinfo=UTC),
            )

        self.assertEqual([p["value"] for p in result], [93.0, 866.0])

    async def test_load_forecast_points_returns_empty_when_provider_unavailable(self) -> None:
        with patch.object(
            forecast_history,
            "async_load_upstream_solar_forecast",
            new=AsyncMock(return_value=None),
        ):
            result = await forecast_history.load_forecast_points_for_day(
                _make_hass(),
                _make_cfg(),
                date.fromisoformat("2026-05-02"),
                local_now=datetime(2026, 5, 3, 10, 0, tzinfo=UTC),
            )

        self.assertEqual(result, [])


class LoadTrainerSamplesTests(unittest.IsolatedAsyncioTestCase):
    async def test_load_trainer_samples_returns_samples_for_past_days_in_wh_hours(self) -> None:
        forecast = {
            "wh_hours": {
                "2026-05-01T06:00:00+00:00": 500.0,
                "2026-05-01T07:00:00+00:00": 800.0,
                "2026-05-02T06:00:00+00:00": 400.0,
                "2026-05-02T07:00:00+00:00": 600.0,
                "2026-05-03T06:00:00+00:00": 300.0,  # today — excluded from training
            }
        }
        cfg = _make_cfg(max_training_window_days=5)
        cfg.min_history_days = 2

        with patch.object(
            forecast_history,
            "async_load_upstream_solar_forecast",
            new=AsyncMock(return_value=forecast),
        ):
            samples = await forecast_history.load_trainer_samples(
                _make_hass(),
                cfg,
                datetime(2026, 5, 3, 10, 0, tzinfo=UTC),
            )

        self.assertEqual(len(samples), 2)
        dates = [s.date for s in samples]
        self.assertIn("2026-05-01", dates)
        self.assertIn("2026-05-02", dates)
        sample_05_01 = next(s for s in samples if s.date == "2026-05-01")
        self.assertAlmostEqual(sample_05_01.forecast_wh, 1300.0)
        self.assertIn("06:00", sample_05_01.slot_forecast_wh)
        self.assertIn("07:00", sample_05_01.slot_forecast_wh)

    async def test_load_trainer_samples_drops_days_when_provider_has_insufficient_past_wh_hours(self) -> None:
        forecast = {
            "wh_hours": {
                "2026-05-03T04:00:00+00:00": 102,  # today only
            }
        }
        cfg = _make_cfg(max_training_window_days=3)

        with patch.object(
            forecast_history,
            "async_load_upstream_solar_forecast",
            new=AsyncMock(return_value=forecast),
        ):
            samples = await forecast_history.load_trainer_samples(
                _make_hass(),
                cfg,
                datetime(2026, 5, 3, 10, 0, tzinfo=UTC),
            )

        self.assertEqual(samples, [])

    async def test_load_trainer_samples_uses_configured_max_training_window_days(self) -> None:
        forecast = {
            "wh_hours": {
                "2026-03-20T08:00:00+00:00": 500.0,
                "2026-03-19T08:00:00+00:00": 400.0,
                "2026-03-15T08:00:00+00:00": 300.0,  # outside 2-day window
            }
        }
        cfg = _make_cfg(max_training_window_days=2)

        with patch.object(
            forecast_history,
            "async_load_upstream_solar_forecast",
            new=AsyncMock(return_value=forecast),
        ):
            samples = await forecast_history.load_trainer_samples(
                _make_hass(),
                cfg,
                datetime(2026, 3, 21, 12, 0, tzinfo=UTC),
            )

        self.assertEqual(
            [s.date for s in samples],
            ["2026-03-19", "2026-03-20"],
        )


if __name__ == "__main__":
    unittest.main()
