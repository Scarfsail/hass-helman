"""#194's regression guard for the bug that started it: a sensor whose
``_attr_translation_key`` has no matching ``name`` in ``strings.json`` falls
back to its device-class name (this is exactly how
``house_consumption_forecast_current`` rendered as plain "Power").

Two checks: every ``_attr_translation_key`` that the ``sensor``, ``select``
and ``switch`` platforms actually produce has a ``name`` entry under
``strings.json``'s ``entity.<platform>``, and ``strings.json``,
``translations/en.json`` and ``translations/cs.json`` all carry exactly the
same key set -- ``strings.json`` is the file HA's own tooling treats as source
of truth, and the three had drifted apart before this change.
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
    return importlib.import_module("custom_components.helman.sensor")


class _FakeEntry:
    entry_id = "entry-1"


def _load_entity_translation_keys() -> set[str]:
    """Every ``_attr_translation_key`` ``async_setup_entry`` actually produces.

    Built with one node carrying an unmeasured child, one share node and one
    source, so the dynamic families (unmeasured, share, source ratio) are
    exercised too.
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
        config={},
        set_entity_factory=Mock(),
        tree_index=object(),
    )
    hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
    added_entities: list[object] = []
    entry = _FakeEntry()
    entry.runtime_data = coordinator

    import asyncio

    asyncio.run(sensor_module.async_setup_entry(hass, entry, added_entities.extend))
    # The coordinator adds the unmeasured and share sensors through the factories.
    factories = coordinator.set_entity_factory.call_args.args[1]
    added_entities.extend(factories["unmeasured"]("house", "sensor.house_power"))
    added_entities.extend(
        factories["share"]("klima-obyvak", "sensor.helman_share_power_klima_obyvak", "Klima")
    )

    return _translation_keys(added_entities)


def _translation_keys(entities) -> set[str]:
    return {
        key
        for entity in entities
        if (key := getattr(entity, "_attr_translation_key", None)) is not None
    }


def _reachable_keys_by_platform() -> dict[str, set[str]]:
    """The sensor platform's keys, plus the select's and the switch's.

    A consumer entity on a foreign device it shares with other consumers uses
    its key's ``_named`` variant, so each of those is reachable too.
    """
    from custom_components.helman.entity import consumer_device_binding
    from custom_components.helman.select import HelmanInverterModeSelect
    from custom_components.helman.switch import HelmanEvChargingSwitch
    from custom_components.helman.vendors import PROFILES, VendorDevice

    entry = _FakeEntry()
    charger = VendorDevice(
        path="devices.consumers[0]",
        device={"kind": "ev_charger", "id": "garage-ev", "name": "Garage EV"},
        profile=PROFILES["solax_ev_charger"],
        entry=None,
    )
    sensor = _load_entity_translation_keys()
    switch = _translation_keys(
        [
            HelmanEvChargingSwitch(
                "garage-ev",
                charger,
                binding=consumer_device_binding(None, entry, {}, device=charger.device),
            )
        ]
    )
    named = {"unmeasured_power", "share_power", "share_energy"}
    return {
        "sensor": sensor | {f"{key}_named" for key in sensor & named},
        "select": _translation_keys(
            [HelmanInverterModeSelect(None, entry, PROFILES["solax_inverter"], None)]
        ),
        "switch": switch | {f"{key}_named" for key in switch},
    }


class TranslationStringsCompletenessTests(unittest.TestCase):
    def test_every_reachable_translation_key_has_a_strings_json_name(self) -> None:
        strings = json.loads((HELMAN_DIR / "strings.json").read_text())

        for platform, reachable_keys in _reachable_keys_by_platform().items():
            defined_keys = set(strings["entity"][platform].keys())
            missing = reachable_keys - defined_keys
            self.assertEqual(
                missing,
                set(),
                f"strings.json is missing a {platform} name for: {sorted(missing)}",
            )

    def test_every_named_variant_carries_the_name_placeholder(self) -> None:
        for path in (
            HELMAN_DIR / "strings.json",
            HELMAN_DIR / "translations" / "en.json",
            HELMAN_DIR / "translations" / "cs.json",
        ):
            entity = json.loads(path.read_text())["entity"]
            for platform in ("sensor", "switch"):
                for key, value in entity[platform].items():
                    if key.endswith("_named"):
                        self.assertIn("{name}", value["name"], f"{path.name} {key}")

    def test_strings_and_both_translations_share_exactly_the_same_key_set(self) -> None:
        strings = json.loads((HELMAN_DIR / "strings.json").read_text())
        en = json.loads((HELMAN_DIR / "translations" / "en.json").read_text())
        cs = json.loads((HELMAN_DIR / "translations" / "cs.json").read_text())

        for platform in ("sensor", "select", "switch"):
            strings_keys = set(strings["entity"][platform].keys())
            en_keys = set(en["entity"][platform].keys())
            cs_keys = set(cs["entity"][platform].keys())

            self.assertEqual(strings_keys, en_keys, "en.json has drifted from strings.json")
            self.assertEqual(strings_keys, cs_keys, "cs.json has drifted from strings.json")

    def test_every_inverter_mode_option_has_a_state_name(self) -> None:
        # The select's options are the inverter's action kinds.
        kinds = {
            "normal",
            "stop_charging",
            "stop_discharging",
            "charge_to_target_soc",
            "discharge_to_target_soc",
            "stop_export",
        }
        for path in (
            HELMAN_DIR / "strings.json",
            HELMAN_DIR / "translations" / "en.json",
            HELMAN_DIR / "translations" / "cs.json",
        ):
            states = json.loads(path.read_text())["entity"]["select"]["inverter_mode"][
                "state"
            ]
            self.assertEqual(set(states), kinds, path.name)


if __name__ == "__main__":
    unittest.main()
