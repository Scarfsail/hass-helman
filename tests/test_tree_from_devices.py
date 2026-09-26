"""The card's house tree is built from ``devices``, and nothing else.

Before config version 21 the tree came from Home Assistant Energy preferences,
with the power sensor, the switch and the labels inferred from the registries.
The upgrade imports those preferences into ``devices`` once; from then on the
card must show the same rows it showed before, except for the differences that
are the point of the change — each asserted by name below:

* a configured device name (and icon) replaces the cleaned sensor name,
* a switch configured in ``controls`` appears,
* an energy-only row is shown instead of dropped.

``fixtures/energy_path_house_tree.json`` is the house tree the Energy path built
for this very fixture, captured from the builder as it was before the change
(commit c625ef0) — the Energy path itself no longer exists to be run.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

from custom_components.helman import tree_builder  # noqa: E402
from custom_components.helman.automation.migration import (  # noqa: E402
    migrate_config_document,
)
from custom_components.helman.entity_inspection import inspect_target  # noqa: E402
from custom_components.helman.house_device_consumers import (  # noqa: E402
    extract_house_device_consumers,
)

FIXTURES = ROOT / "tests" / "fixtures"
LIVE_PREFERENCES = json.loads((FIXTURES / "live_energy_preferences.json").read_text())
ENERGY_PATH_TREE = json.loads((FIXTURES / "energy_path_house_tree.json").read_text())

#: A row with no ``stat_rate`` whose meter's HA device has no power sensor: the
#: Energy path dropped it, the device list keeps it.
ENERGY_ONLY_METER = "sensor.jistic_bojler_energy"

LABEL_BACKED = "Jističe - Technická zálohované z FV"
LABEL_NIGHT = "Elektřina - Vypnout na noc"

#: ``(entity_id, HA device, labels)``. The AC breaker's HA device carries a
#: switch that registry inference never resolved (its friendly name is not the
#: device's), as live; its label still reaches the row.
REGISTRY = [
    ("sensor.jistic_klimatizace_energy", "dev_ac", []),
    ("sensor.jistic_klimatizace_power", "dev_ac", []),
    ("switch.jistic_klimatizace", "dev_ac", ["backed"]),
    ("switch.jistic_klimatizace_led", "dev_ac", []),
    ("sensor.zasuvka_pracovna_ondra_energy", "dev_plug", []),
    ("switch.zasuvka_pracovna_ondra", "dev_plug", ["night"]),
    (ENERGY_ONLY_METER, "dev_boiler", []),
]
LABELS = {"backed": LABEL_BACKED, "night": LABEL_NIGHT}


class _EntityRegistry:
    def __init__(self) -> None:
        self.entities = {
            entity_id: SimpleNamespace(
                entity_id=entity_id, device_id=device_id, labels=set(labels)
            )
            for entity_id, device_id, labels in REGISTRY
        }

    def async_get(self, entity_id):
        return self.entities.get(entity_id)


class _LabelRegistry:
    def async_get_label(self, label_id):
        name = LABELS.get(label_id)
        return SimpleNamespace(name=name, label_id=label_id) if name else None


def _friendly_name(entity_id: str) -> str:
    object_id = entity_id.partition(".")[2]
    return object_id.replace("_power", "").replace("_", " ").capitalize() + " Výkon"


class _States:
    """Every power sensor exists, named the way the live ones are."""

    def __init__(self, missing: frozenset[str] = frozenset()) -> None:
        self._missing = missing

    def get(self, entity_id):
        if entity_id in self._missing or not entity_id.endswith("_power"):
            return None
        return SimpleNamespace(
            state="120",
            attributes={
                "friendly_name": _friendly_name(entity_id),
                "unit_of_measurement": "W",
            },
        )


def _v20_document() -> dict:
    """The live devices as P1 migrated them, trimmed to what the card reads."""
    return {
        "config_version": 20,
        "visualization": {
            "power_sensor_name_cleaner_regex": " Výkon$",
            "device_label_text": {
                "Skříně": {LABEL_BACKED: "🔋T"},
                "Režimy": {LABEL_NIGHT: "⏻😴"},
            },
        },
        "power_devices": {
            "house": {
                "entities": {"power": "sensor.house_power"},
                "power_sensor_label": "Měření spotřeby elektřiny",
                "power_switch_label": "Ovládání spotřeby elektřiny",
            }
        },
        "devices": [
            {"kind": "inverter", "id": "inverter"},
            {
                "kind": "generic",
                "id": "pool-filtration",
                "name": "Bazén filtrace",
                "icon": "mdi:pool",
                "schedulable": True,
                "controls": {"switch": {"entity_id": "switch.jistic_bazen_filtrace"}},
                "consumption": {
                    "energy_entity_id": "sensor.jistic_bazen_filtrace_energy",
                    "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.75},
                },
            },
            {
                "id": "jistic_klimatizace_energy",
                "consumption": {"energy_entity_id": "sensor.jistic_klimatizace_energy"},
                "children": [
                    {
                        "kind": "climate",
                        "id": f"klima-{room}",
                        "schedulable": True,
                        "controls": {"climate": {"entity_id": f"climate.{room}"}},
                        "consumption": {
                            "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.25}
                        },
                    }
                    for room in ("obyvak", "bartik", "adelka", "loznice")
                ],
            },
        ],
    }


def _preferences(*extra_rows: dict) -> dict:
    return {
        "device_consumption": [
            *LIVE_PREFERENCES["device_consumption"],
            {"stat_consumption": ENERGY_ONLY_METER},
            *extra_rows,
        ]
    }


def _upgrade(*extra_rows: dict) -> dict:
    migrated, _ids = migrate_config_document(_v20_document(), _preferences(*extra_rows))
    return migrated


def _build(config: dict, states: _States | None = None) -> dict:
    hass = SimpleNamespace(states=states or _States())
    with mock.patch.object(
        tree_builder.er, "async_get", lambda _hass: _EntityRegistry()
    ), mock.patch.object(tree_builder.lr, "async_get", lambda _hass: _LabelRegistry()):
        return asyncio.run(tree_builder.HelmanTreeBuilder(hass, config).build())


def _house(tree: dict) -> dict:
    return next(node for node in tree["consumers"] if node["id"] == "house")


_COMPARED = (
    "id",
    "displayName",
    "powerSensorId",
    "switchEntityId",
    "icon",
    "labels",
    "labelBadgeTexts",
    "deferrable",
    "controllableIds",
    "isUnmeasured",
)


def _slim(nodes: list[dict]) -> dict[str, dict]:
    """``id -> node``, compared fields only; order is the card's business (it sorts by power)."""
    return {
        node["id"]: {
            **{key: node[key] for key in _COMPARED},
            "children": _slim(node["children"]),
        }
        for node in nodes
    }


class TreeFromDevicesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = _build(_upgrade())
        self.house = _house(self.tree)

    def test_it_matches_the_energy_path_apart_from_the_intended_differences(self) -> None:
        expected = _slim(ENERGY_PATH_TREE)

        pool = expected["sensor.jistic_bazen_filtrace_energy"]
        # The configured device name replaces the cleaned sensor name.
        self.assertEqual(pool["displayName"], "Jistic bazen filtrace")
        pool["displayName"] = "Bazén filtrace"
        # The configured icon replaces the power sensor's (none).
        self.assertIsNone(pool["icon"])
        pool["icon"] = "mdi:pool"
        # The switch configured in ``controls`` appears; inference found none.
        self.assertIsNone(pool["switchEntityId"])
        pool["switchEntityId"] = "switch.jistic_bazen_filtrace"
        # The energy-only row is shown instead of dropped.
        self.assertNotIn(ENERGY_ONLY_METER, expected)
        expected[ENERGY_ONLY_METER] = {
            "id": ENERGY_ONLY_METER,
            "displayName": "jistic_bojler_energy",
            "powerSensorId": None,
            "switchEntityId": None,
            "icon": None,
            "labels": [],
            "labelBadgeTexts": [],
            "deferrable": False,
            "controllableIds": [],
            "isUnmeasured": False,
            "children": {},
        }

        self.assertEqual(_slim(self.house["children"]), expected)

    def test_every_metered_row_names_its_meter(self) -> None:
        def walk(nodes):
            for node in nodes:
                yield node
                yield from walk(node["children"])

        for node in walk(self.house["children"]):
            with self.subTest(node=node["id"]):
                if node["isUnmeasured"]:
                    self.assertIsNone(node["energyEntityId"])
                else:
                    self.assertEqual(node["energyEntityId"], node["id"])

    def test_the_inspector_lists_the_same_top_level_meters(self) -> None:
        consumers = extract_house_device_consumers(self.tree)

        self.assertEqual(
            sorted(c["energy_entity_id"] for c in consumers),
            sorted(
                [
                    node_id
                    for node_id, node in _slim(ENERGY_PATH_TREE).items()
                    if not node["isUnmeasured"]
                ]
                + [ENERGY_ONLY_METER]
            ),
        )

    def test_a_meterless_child_has_no_row_and_stays_on_its_parent(self) -> None:
        breaker = next(
            node
            for node in self.house["children"]
            if node["id"] == "sensor.jistic_klimatizace_energy"
        )

        self.assertEqual(breaker["children"], [])
        self.assertEqual(
            breaker["controllableIds"],
            ["klima-obyvak", "klima-bartik", "klima-adelka", "klima-loznice"],
        )


class MissingEntityTests(unittest.TestCase):
    """A selected entity that is missing keeps its row and is reported, never replaced."""

    def test_the_row_stays_with_its_configured_sensor(self) -> None:
        missing = "sensor.jistic_klimatizace_power"
        config = _upgrade()

        house = _house(_build(config, _States(missing=frozenset({missing}))))

        breaker = next(
            node
            for node in house["children"]
            if node["id"] == "sensor.jistic_klimatizace_energy"
        )
        # Not swapped for another power sensor on the breaker's HA device.
        self.assertEqual(breaker["powerSensorId"], missing)
        self.assertEqual(breaker["displayName"], "jistic_klimatizace_energy")

        index = next(
            i
            for i, device in enumerate(config["devices"])
            if device.get("id") == "jistic_klimatizace_energy"
        )
        inspection = inspect_target(
            SimpleNamespace(states=_States(missing=frozenset({missing}))),
            config,
            ("devices", index, "consumption", "power_entity_id"),
        )
        self.assertEqual(inspection.entity_id, missing)
        self.assertEqual(inspection.status, "unavailable")
        self.assertEqual([fact.token for fact in inspection.facts], ["entity_missing"])


class ConflictTests(unittest.TestCase):
    """A row Energy nests under a schedulable device is not imported, so never counted twice."""

    PLUG = "sensor.zasuvka_bazen_energy"

    def test_the_conflict_has_no_row_and_the_parent_is_counted_once(self) -> None:
        tree = _build(
            _upgrade(
                {
                    "stat_consumption": self.PLUG,
                    "stat_rate": "sensor.zasuvka_bazen_power",
                    "included_in_stat": "sensor.jistic_bazen_filtrace_energy",
                }
            )
        )

        meters = [c["energy_entity_id"] for c in extract_house_device_consumers(tree)]
        self.assertNotIn(self.PLUG, json.dumps(tree))
        self.assertEqual(meters.count("sensor.jistic_bazen_filtrace_energy"), 1)
        pool = next(
            node
            for node in _house(tree)["children"]
            if node["id"] == "sensor.jistic_bazen_filtrace_energy"
        )
        self.assertEqual(pool["children"], [])


if __name__ == "__main__":
    unittest.main()
