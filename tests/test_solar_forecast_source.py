from __future__ import annotations

import asyncio
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
    entity_registry_mod = types.ModuleType("homeassistant.helpers.entity_registry")
    entity_registry_mod.async_get = lambda hass: None
    sys.modules["homeassistant.helpers.entity_registry"] = entity_registry_mod


_install_import_stubs()

from custom_components.helman import solar_forecast_source


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
        solar_forecast_source.is_supported_solar_forecast_entry(
            hass,
            "helman-entry",
            supported_domains={"helman", "forecast_solar"},
            helman_entry_id="helman-entry",
        )
        is False
    )


def test_is_supported_solar_forecast_entry_accepts_supported_forecast_provider():
    hass = SimpleNamespace(
        config_entries=_FakeConfigEntries(
            {
                "forecast-entry": _FakeConfigEntry(
                    "forecast-entry", "forecast_solar", "Forecast"
                ),
            }
        )
    )

    assert (
        solar_forecast_source.is_supported_solar_forecast_entry(
            hass,
            "forecast-entry",
            supported_domains={"forecast_solar"},
            helman_entry_id="helman-entry",
        )
        is True
    )


def test_is_supported_solar_forecast_entry_rejects_missing_and_unsupported_entries():
    hass = SimpleNamespace(
        config_entries=_FakeConfigEntries(
            {
                "weather-entry": _FakeConfigEntry("weather-entry", "weather", "Weather"),
            }
        )
    )

    assert (
        solar_forecast_source.is_supported_solar_forecast_entry(
            hass,
            "missing-entry",
            supported_domains={"forecast_solar"},
            helman_entry_id="helman-entry",
        )
        is False
    )
    assert (
        solar_forecast_source.is_supported_solar_forecast_entry(
            hass,
            "weather-entry",
            supported_domains={"forecast_solar"},
            helman_entry_id="helman-entry",
        )
        is False
    )


def test_async_list_supported_solar_forecast_entries_uses_persisted_helman_entry_id():
    hass = SimpleNamespace(
        data={"helman": {"entry_id": "helman-entry-2"}},
        config_entries=_FakeConfigEntries(
            {
                "helman-entry-1": _FakeConfigEntry("helman-entry-1", "helman", "Helman A"),
                "helman-entry-2": _FakeConfigEntry("helman-entry-2", "helman", "Helman B"),
                "forecast-entry": _FakeConfigEntry(
                    "forecast-entry", "forecast_solar", "Forecast"
                ),
            }
        ),
    )

    async def _async_get_energy_platforms(_hass):
        return ["helman", "forecast_solar"]

    original = solar_forecast_source.async_get_energy_platforms
    solar_forecast_source.async_get_energy_platforms = _async_get_energy_platforms
    try:
        payload = asyncio.run(
            solar_forecast_source.async_list_supported_solar_forecast_entries(hass)
        )
    finally:
        solar_forecast_source.async_get_energy_platforms = original

    assert payload == [
        {
            "entry_id": "forecast-entry",
            "title": "Forecast",
            "domain": "forecast_solar",
        },
    ]


def test_async_list_supported_solar_forecast_entries_excludes_helman_without_persisted_entry_id():
    hass = SimpleNamespace(
        data={"helman": {}},
        config_entries=_FakeConfigEntries(
            {
                "helman-entry": _FakeConfigEntry("helman-entry", "helman", "Helman"),
                "forecast-entry": _FakeConfigEntry(
                    "forecast-entry", "forecast_solar", "Forecast"
                ),
            }
        ),
    )

    async def _async_get_energy_platforms(_hass):
        return ["helman", "forecast_solar"]

    original = solar_forecast_source.async_get_energy_platforms
    solar_forecast_source.async_get_energy_platforms = _async_get_energy_platforms
    try:
        payload = asyncio.run(
            solar_forecast_source.async_list_supported_solar_forecast_entries(hass)
        )
    finally:
        solar_forecast_source.async_get_energy_platforms = original

    assert payload == [
        {
            "entry_id": "forecast-entry",
            "title": "Forecast",
            "domain": "forecast_solar",
        }
    ]


def test_infer_source_config_entry_id_from_legacy_entities_returns_single_match():
    entity_entries = {
        "sensor.energy_production_today": SimpleNamespace(
            config_entry_id="forecast-entry"
        ),
        "sensor.energy_production_tomorrow": SimpleNamespace(
            config_entry_id="forecast-entry"
        ),
    }

    inferred = solar_forecast_source.infer_source_config_entry_id_from_legacy_entities(
        ["sensor.energy_production_today", "sensor.energy_production_tomorrow"],
        entity_entries=entity_entries,
        supported_entry_ids={"forecast-entry"},
        helman_entry_id="helman-entry",
    )

    assert inferred == "forecast-entry"


def test_infer_source_config_entry_id_from_legacy_entities_returns_none_for_multiple_candidates():
    entity_entries = {
        "sensor.day_1": SimpleNamespace(config_entry_id="forecast-entry-a"),
        "sensor.day_2": SimpleNamespace(config_entry_id="forecast-entry-b"),
    }

    inferred = solar_forecast_source.infer_source_config_entry_id_from_legacy_entities(
        ["sensor.day_1", "sensor.day_2"],
        entity_entries=entity_entries,
        supported_entry_ids={"forecast-entry-a", "forecast-entry-b"},
        helman_entry_id="helman-entry",
    )

    assert inferred is None


def test_infer_source_config_entry_id_from_legacy_entities_ignores_helman_self_entry():
    entity_entries = {
        "sensor.day_1": SimpleNamespace(config_entry_id="helman-entry"),
        "sensor.day_2": SimpleNamespace(config_entry_id="forecast-entry"),
    }

    inferred = solar_forecast_source.infer_source_config_entry_id_from_legacy_entities(
        ["sensor.day_1", "sensor.day_2"],
        entity_entries=entity_entries,
        supported_entry_ids={"helman-entry", "forecast-entry"},
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

    migrated = solar_forecast_source.migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=None,
    )

    forecast = migrated["power_devices"]["solar"]["forecast"]
    assert "daily_energy_entity_ids" not in forecast
    assert forecast.get("source_config_entry_id") is None


def test_migrate_legacy_solar_forecast_config_is_noop_without_forecast_section():
    config = {
        "power_devices": {
            "solar": {
                "total_energy_entity_id": "sensor.solar_total",
            }
        }
    }

    migrated = solar_forecast_source.migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id="forecast-entry",
    )

    assert migrated == config
    assert "forecast" not in migrated["power_devices"]["solar"]
    assert "forecast" not in config["power_devices"]["solar"]


def test_migrate_legacy_solar_forecast_config_ignores_blank_inferred_source_id():
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

    migrated = solar_forecast_source.migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id="   ",
    )

    forecast = migrated["power_devices"]["solar"]["forecast"]
    assert "daily_energy_entity_ids" not in forecast
    assert forecast.get("source_config_entry_id") is None


def test_migrate_legacy_solar_forecast_config_normalizes_existing_source_id():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.day_1", "sensor.day_2"],
                    "source_config_entry_id": "  forecast-entry  ",
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }

    migrated = solar_forecast_source.migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=None,
    )

    forecast = migrated["power_devices"]["solar"]["forecast"]
    assert forecast["source_config_entry_id"] == "forecast-entry"
    assert config["power_devices"]["solar"]["forecast"]["source_config_entry_id"] == (
        "  forecast-entry  "
    )


def test_migrate_legacy_solar_forecast_config_removes_blank_existing_source_id():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.day_1", "sensor.day_2"],
                    "source_config_entry_id": "   ",
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }

    migrated = solar_forecast_source.migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=None,
    )

    forecast = migrated["power_devices"]["solar"]["forecast"]
    assert "source_config_entry_id" not in forecast


def test_migrate_legacy_solar_forecast_config_sets_source_id_and_deep_copies():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.day_1", "sensor.day_2"],
                    "total_energy_entity_id": "sensor.solar_total",
                    "metadata": {"unit": "Wh"},
                }
            }
        }
    }

    migrated = solar_forecast_source.migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id="forecast-entry",
    )

    migrated["power_devices"]["solar"]["forecast"]["metadata"]["unit"] = "kWh"

    assert (
        migrated["power_devices"]["solar"]["forecast"]["source_config_entry_id"]
        == "forecast-entry"
    )
    assert (
        "daily_energy_entity_ids"
        not in migrated["power_devices"]["solar"]["forecast"]
    )
    assert (
        config["power_devices"]["solar"]["forecast"]["daily_energy_entity_ids"]
        == ["sensor.day_1", "sensor.day_2"]
    )
    assert (
        config["power_devices"]["solar"]["forecast"]["metadata"]["unit"] == "Wh"
    )


def test_async_migrate_legacy_solar_forecast_config_infers_source_from_registry_entities():
    hass = SimpleNamespace(
        data={"helman": {"entry_id": "helman-entry"}},
        config_entries=_FakeConfigEntries(
            {
                "helman-entry": _FakeConfigEntry("helman-entry", "helman", "Helman"),
                "forecast-entry": _FakeConfigEntry(
                    "forecast-entry", "forecast_solar", "Forecast"
                ),
            }
        ),
    )
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": [
                        "sensor.energy_production_today",
                        "sensor.energy_production_tomorrow",
                    ],
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }

    async def _async_get_energy_platforms(_hass):
        return ["helman", "forecast_solar"]

    original_platforms = solar_forecast_source.async_get_energy_platforms
    solar_forecast_source.async_get_energy_platforms = _async_get_energy_platforms

    original_registry_get = solar_forecast_source.er.async_get
    solar_forecast_source.er.async_get = lambda _hass: SimpleNamespace(
        async_get=lambda entity_id: {
            "sensor.energy_production_today": SimpleNamespace(
                config_entry_id="forecast-entry"
            ),
            "sensor.energy_production_tomorrow": SimpleNamespace(
                config_entry_id="forecast-entry"
            ),
        }.get(entity_id)
    )
    try:
        migrated = asyncio.run(
            solar_forecast_source.async_migrate_legacy_solar_forecast_config(
                hass, config
            )
        )
    finally:
        solar_forecast_source.async_get_energy_platforms = original_platforms
        solar_forecast_source.er.async_get = original_registry_get

    assert migrated == {
        "power_devices": {
            "solar": {
                "forecast": {
                    "source_config_entry_id": "forecast-entry",
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }


def test_async_migrate_legacy_solar_forecast_config_keeps_explicit_source_over_inferred():
    hass = SimpleNamespace(
        data={"helman": {"entry_id": "helman-entry"}},
        config_entries=_FakeConfigEntries(
            {
                "helman-entry": _FakeConfigEntry("helman-entry", "helman", "Helman"),
                "forecast-entry-a": _FakeConfigEntry(
                    "forecast-entry-a", "forecast_solar", "Forecast A"
                ),
                "forecast-entry-b": _FakeConfigEntry(
                    "forecast-entry-b", "forecast_solar", "Forecast B"
                ),
            }
        ),
    )
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": [
                        "sensor.energy_production_today",
                        "sensor.energy_production_tomorrow",
                    ],
                    "source_config_entry_id": "forecast-entry-a",
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }

    async def _async_get_energy_platforms(_hass):
        return ["helman", "forecast_solar"]

    original_platforms = solar_forecast_source.async_get_energy_platforms
    solar_forecast_source.async_get_energy_platforms = _async_get_energy_platforms

    original_registry_get = solar_forecast_source.er.async_get
    solar_forecast_source.er.async_get = lambda _hass: SimpleNamespace(
        async_get=lambda entity_id: {
            "sensor.energy_production_today": SimpleNamespace(
                config_entry_id="forecast-entry-b"
            ),
            "sensor.energy_production_tomorrow": SimpleNamespace(
                config_entry_id="forecast-entry-b"
            ),
        }.get(entity_id)
    )
    try:
        migrated = asyncio.run(
            solar_forecast_source.async_migrate_legacy_solar_forecast_config(
                hass, config
            )
        )
    finally:
        solar_forecast_source.async_get_energy_platforms = original_platforms
        solar_forecast_source.er.async_get = original_registry_get

    assert migrated == {
        "power_devices": {
            "solar": {
                "forecast": {
                    "source_config_entry_id": "forecast-entry-a",
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }
