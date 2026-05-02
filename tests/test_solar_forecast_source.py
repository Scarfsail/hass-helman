from __future__ import annotations

import sys
import types

from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


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
    homeassistant_pkg.__path__ = []

    components_pkg = types.ModuleType("homeassistant.components")
    components_pkg.__path__ = []
    sys.modules["homeassistant.components"] = components_pkg

    energy_pkg = types.ModuleType("homeassistant.components.energy")
    energy_pkg.__path__ = []
    sys.modules["homeassistant.components.energy"] = energy_pkg

    websocket_mod = types.ModuleType("homeassistant.components.energy.websocket_api")

    async def _async_get_energy_platforms(_hass):
        return []

    websocket_mod.async_get_energy_platforms = _async_get_energy_platforms
    sys.modules["homeassistant.components.energy.websocket_api"] = websocket_mod

    helpers_pkg = types.ModuleType("homeassistant.helpers")
    helpers_pkg.__path__ = []
    sys.modules["homeassistant.helpers"] = helpers_pkg
    sys.modules["homeassistant.helpers.entity_registry"] = types.ModuleType(
        "homeassistant.helpers.entity_registry"
    )


_install_import_stubs()

from custom_components.helman.solar_forecast_source import (
    infer_source_config_entry_id_from_legacy_entities,
    is_supported_solar_forecast_entry,
    migrate_legacy_solar_forecast_config,
)


class _FakeConfigEntry:
    def __init__(self, entry_id: str, domain: str, title: str = "Forecast") -> None:
        self.entry_id = entry_id
        self.domain = domain
        self.title = title


class _FakeConfigEntries:
    def __init__(self, entries: dict[str, _FakeConfigEntry]) -> None:
        self._entries = entries

    def async_get_entry(self, entry_id: str):
        return self._entries.get(entry_id)

    def async_entries(self, domain: str | None = None):
        entries = list(self._entries.values())
        if domain is None:
            return entries
        return [entry for entry in entries if entry.domain == domain]


def test_is_supported_solar_forecast_entry_rejects_helman_self():
    hass = SimpleNamespace(
        config_entries=_FakeConfigEntries(
            {
                "helman-entry": _FakeConfigEntry("helman-entry", "helman", "Helman"),
            }
        )
    )

    assert (
        is_supported_solar_forecast_entry(
            hass,
            "helman-entry",
            supported_domains={"helman", "forecast_solar"},
            helman_entry_id="helman-entry",
        )
        is False
    )


def test_infer_source_config_entry_id_from_legacy_entities_returns_single_match():
    entity_entries = {
        "sensor.energy_production_today": SimpleNamespace(
            config_entry_id="forecast-entry"
        ),
        "sensor.energy_production_tomorrow": SimpleNamespace(
            config_entry_id="forecast-entry"
        ),
    }

    inferred = infer_source_config_entry_id_from_legacy_entities(
        ["sensor.energy_production_today", "sensor.energy_production_tomorrow"],
        entity_entries=entity_entries,
        supported_entry_ids={"forecast-entry"},
        helman_entry_id="helman-entry",
    )

    assert inferred == "forecast-entry"


def test_migrate_legacy_solar_forecast_config_removes_daily_entities_when_inference_fails():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.day_1", "sensor.day_2"],
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }

    migrated = migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=None,
    )

    forecast = migrated["power_devices"]["solar"]["forecast"]
    assert "daily_energy_entity_ids" not in forecast
    assert forecast.get("source_config_entry_id") is None
