"""#194's regression guard for the bug that started it: a sensor whose
``_attr_translation_key`` has no matching ``name`` in ``strings.json`` falls
back to its device-class name (this is exactly how
``house_consumption_forecast_current`` rendered as plain "Power").

Two checks: every ``_attr_translation_key`` that ``sensor.py`` actually
produces has a ``name`` entry under ``strings.json``'s ``entity.sensor``, and
``strings.json``, ``translations/en.json`` and ``translations/cs.json`` all
carry exactly the same key set -- ``strings.json`` is the file HA's own
tooling treats as source of truth, and the three had drifted apart before
this change.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

ROOT = Path(__file__).resolve().parents[1]
HELMAN_DIR = ROOT / "custom_components" / "helman"


def _load_sensor_module():
    for module_name in [
        "custom_components.helman.sensor",
        "custom_components.helman.const",
        "homeassistant",
        "homeassistant.components",
        "homeassistant.components.sensor",
        "homeassistant.config_entries",
        "homeassistant.const",
        "homeassistant.core",
        "homeassistant.helpers",
        "homeassistant.helpers.entity_platform",
        "homeassistant.helpers.device_registry",
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
    helman_pkg.__path__ = [str(HELMAN_DIR)]

    homeassistant_pkg = types.ModuleType("homeassistant")
    sys.modules["homeassistant"] = homeassistant_pkg
    components_pkg = types.ModuleType("homeassistant.components")
    sys.modules["homeassistant.components"] = components_pkg

    sensor_mod = types.ModuleType("homeassistant.components.sensor")
    sensor_mod.SensorDeviceClass = type(
        "SensorDeviceClass",
        (),
        {"DURATION": "duration", "POWER": "power", "ENERGY": "energy", "BATTERY": "battery"},
    )
    sensor_mod.SensorStateClass = type("SensorStateClass", (), {"MEASUREMENT": "measurement"})

    class SensorEntity:
        def __init__(self) -> None:
            self.hass = None
            self.entity_id = None

        async def async_added_to_hass(self) -> None:
            return None

        def async_write_ha_state(self) -> None:
            return None

    sensor_mod.SensorEntity = SensorEntity
    sys.modules["homeassistant.components.sensor"] = sensor_mod

    config_entries_mod = types.ModuleType("homeassistant.config_entries")
    config_entries_mod.ConfigEntry = type("ConfigEntry", (), {})
    sys.modules["homeassistant.config_entries"] = config_entries_mod

    const_mod = types.ModuleType("homeassistant.const")
    const_mod.UnitOfTime = type("UnitOfTime", (), {"MINUTES": "min"})
    sys.modules["homeassistant.const"] = const_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    sys.modules["homeassistant.core"] = core_mod

    helpers_pkg = types.ModuleType("homeassistant.helpers")
    helpers_pkg.__path__ = []
    sys.modules["homeassistant.helpers"] = helpers_pkg
    entity_platform_mod = types.ModuleType("homeassistant.helpers.entity_platform")
    entity_platform_mod.AddEntitiesCallback = object
    sys.modules["homeassistant.helpers.entity_platform"] = entity_platform_mod

    device_registry_mod = types.ModuleType("homeassistant.helpers.device_registry")
    device_registry_mod.DeviceEntryType = type("DeviceEntryType", (), {"SERVICE": "service"})
    device_registry_mod.DeviceInfo = dict
    sys.modules["homeassistant.helpers.device_registry"] = device_registry_mod

    return importlib.import_module("custom_components.helman.sensor")


class _FakeEntry:
    entry_id = "entry-1"


def _load_entity_translation_keys() -> set[str]:
    """Every ``_attr_translation_key`` ``async_setup_entry`` actually produces.

    Built with one node carrying an unmeasured child, one source, so the
    dynamic families (unmeasured, source ratio) are exercised too -- the
    unmeasured sensor contributes no translation key (its name is resolved,
    not translated), and is excluded by construction, not by an assertion.
    """
    sensor_module = _load_sensor_module()
    coordinator = SimpleNamespace(
        get_device_tree=AsyncMock(
            return_value={
                "sources": [
                    {
                        "powerSensorId": "sensor.solar_power",
                        "ratioSensorId": "sensor.helman_solar_source_ratio",
                        "sourceType": "solar",
                    }
                ],
                "consumers": [],
            }
        ),
        collect_qualifying_nodes=Mock(
            return_value={"house": "sensor.house_power"}
        ),
        config={},
        set_sensors=Mock(),
        set_entity_factory=Mock(),
        register_house_consumption_forecast_current_sensor=Mock(),
        register_solar_forecast_current_sensors=Mock(),
        register_battery_forecast_current_sensors=Mock(),
        register_grid_import_price_sensor=Mock(),
        register_grid_export_price_sensor=Mock(),
    )
    hass = SimpleNamespace(
        data={"helman": {"coordinator": coordinator}},
        states=SimpleNamespace(get=lambda entity_id: None),
    )
    added_entities: list[object] = []

    import asyncio

    asyncio.run(
        sensor_module.async_setup_entry(hass, _FakeEntry(), added_entities.extend)
    )

    return {
        key
        for entity in added_entities
        if (key := getattr(entity, "_attr_translation_key", None)) is not None
    }


class TranslationStringsCompletenessTests(unittest.TestCase):
    def test_every_reachable_translation_key_has_a_strings_json_name(self) -> None:
        strings = json.loads((HELMAN_DIR / "strings.json").read_text())
        defined_keys = set(strings["entity"]["sensor"].keys())

        reachable_keys = _load_entity_translation_keys()

        missing = reachable_keys - defined_keys
        self.assertEqual(
            missing,
            set(),
            f"strings.json is missing a name for: {sorted(missing)}",
        )

    def test_strings_and_both_translations_share_exactly_the_same_key_set(self) -> None:
        strings = json.loads((HELMAN_DIR / "strings.json").read_text())
        en = json.loads((HELMAN_DIR / "translations" / "en.json").read_text())
        cs = json.loads((HELMAN_DIR / "translations" / "cs.json").read_text())

        strings_keys = set(strings["entity"]["sensor"].keys())
        en_keys = set(en["entity"]["sensor"].keys())
        cs_keys = set(cs["entity"]["sensor"].keys())

        self.assertEqual(strings_keys, en_keys, "en.json has drifted from strings.json")
        self.assertEqual(strings_keys, cs_keys, "cs.json has drifted from strings.json")


if __name__ == "__main__":
    unittest.main()
