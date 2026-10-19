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
    return importlib.import_module("custom_components.helman.sensor")


class _FakeEntry:
    entry_id = "entry-1"


def _load_entity_translation_keys() -> set[str]:
    """Every ``_attr_translation_key`` ``async_setup_entry`` actually produces.

    Built with one node carrying an unmeasured child, one share node and one
    source, so the dynamic families (unmeasured, share, source ratio) are
    exercised too -- the unmeasured and share sensors contribute no translation
    key (their names are resolved, not translated), and are excluded by
    construction, not by an assertion.
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
    )
    hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
    added_entities: list[object] = []
    entry = _FakeEntry()
    entry.runtime_data = coordinator

    import asyncio

    asyncio.run(sensor_module.async_setup_entry(hass, entry, added_entities.extend))
    # The coordinator adds the unmeasured and share sensors through the factories.
    factories = coordinator.set_entity_factory.call_args.args[1]
    added_entities.append(factories["unmeasured"]("house", "sensor.house_power"))
    added_entities.append(
        factories["share"]("klima-obyvak", "sensor.helman_share_power_klima_obyvak", "Klima")
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

        for platform in ("sensor", "select"):
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
