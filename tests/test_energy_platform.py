from __future__ import annotations

import importlib
import sys
import types
import unittest

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_energy_module():
    for module_name in [
        "custom_components.helman.energy",
        "custom_components.helman.const",
    ]:
        sys.modules.pop(module_name, None)

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

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    sys.modules["homeassistant.core"] = core_mod

    return importlib.import_module("custom_components.helman.energy")


class _FakeConfigEntry:
    def __init__(self, entry_id: str, domain: str) -> None:
        self.entry_id = entry_id
        self.domain = domain


class _FakeConfigEntries:
    def __init__(self, entries: dict[str, _FakeConfigEntry]) -> None:
        self._entries = entries

    def async_get_entry(self, entry_id: str) -> _FakeConfigEntry | None:
        return self._entries.get(entry_id)


class _FakeHass:
    def __init__(self, coordinator, entries: dict[str, _FakeConfigEntry]) -> None:
        self.data = {"helman": {"coordinator": coordinator}}
        self.config_entries = _FakeConfigEntries(entries)


class _FakeCoordinator:
    def __init__(self, forecast: dict | None = None) -> None:
        self.calls: list[dict[str, int]] = []
        self._forecast = forecast or {
            "solar": {
                "points": [
                    {"timestamp": "2026-04-29T10:00:00+02:00", "value": 1250.25},
                    {"timestamp": "2026-04-29T11:00:00+02:00", "value": 0},
                    {"timestamp": "2026-04-29T12:00:00+02:00", "value": "bad"},
                    {"timestamp": None, "value": 500},
                ],
            },
        }

    async def get_forecast(self, *, granularity: int, forecast_days: int) -> dict:
        self.calls.append({"granularity": granularity, "forecast_days": forecast_days})
        return self._forecast


class EnergyPlatformTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.energy = _load_energy_module()

    async def test_get_solar_forecast_returns_hourly_wh_for_matching_entry(self) -> None:
        coordinator = _FakeCoordinator()
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertEqual(coordinator.calls, [{"granularity": 60, "forecast_days": 14}])
        self.assertEqual(
            result,
            {
                "wh_hours": {
                    "2026-04-29T10:00:00+02:00": 1250.25,
                    "2026-04-29T11:00:00+02:00": 0,
                }
            },
        )

    async def test_get_solar_forecast_prefers_adjusted_points_when_available(self) -> None:
        coordinator = _FakeCoordinator(
            {
                "solar": {
                    "points": [
                        {"timestamp": "2026-04-29T10:00:00+02:00", "value": 1250.25},
                    ],
                    "adjustedPoints": [
                        {"timestamp": "2026-04-29T10:00:00+02:00", "value": 900.5},
                        {"timestamp": "2026-04-29T11:00:00+02:00", "value": 0},
                    ],
                },
            }
        )
        entry = _FakeConfigEntry("entry-1", "helman")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertEqual(
            result,
            {
                "wh_hours": {
                    "2026-04-29T10:00:00+02:00": 900.5,
                    "2026-04-29T11:00:00+02:00": 0,
                }
            },
        )

    async def test_get_solar_forecast_returns_none_for_unknown_entry(self) -> None:
        coordinator = _FakeCoordinator()
        hass = _FakeHass(coordinator, {})

        result = await self.energy.async_get_solar_forecast(hass, "missing")

        self.assertIsNone(result)
        self.assertEqual(coordinator.calls, [])

    async def test_get_solar_forecast_returns_none_for_other_domain(self) -> None:
        coordinator = _FakeCoordinator()
        entry = _FakeConfigEntry("entry-1", "open_meteo_solar_forecast")
        hass = _FakeHass(coordinator, {"entry-1": entry})

        result = await self.energy.async_get_solar_forecast(hass, "entry-1")

        self.assertIsNone(result)
        self.assertEqual(coordinator.calls, [])


if __name__ == "__main__":
    unittest.main()
