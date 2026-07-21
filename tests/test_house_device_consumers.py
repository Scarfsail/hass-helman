"""The inspector's consumer list must mirror the power card's device tree exactly.

The controlling switch in particular is never inferred: whatever the tree resolved
for a node is what both views show, so a device the card offers no control for is
a device the inspector offers no control for either.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

module = importlib.import_module("custom_components.helman.house_device_consumers")
extract = module.extract_house_device_consumers


def _tree(children):
    return {"consumers": [{"id": "house", "children": children}]}


def _node(node_id, **overrides):
    node = {
        "id": node_id,
        "displayName": node_id,
        "switchEntityId": None,
        "isUnmeasured": False,
        "isVirtual": False,
        "isSource": False,
        "children": [],
    }
    node.update(overrides)
    return node


class TestHouseDeviceConsumers(unittest.TestCase):

    def test_switch_and_power_sensor_carried_verbatim_from_the_tree(self):
        tree = _tree(
            [
                _node(
                    "sensor.dishwasher_energy",
                    switchEntityId="switch.dishwasher",
                    powerSensorId="sensor.dishwasher_power",
                )
            ]
        )

        self.assertEqual(
            extract(tree),
            [
                {
                    "energy_entity_id": "sensor.dishwasher_energy",
                    "label": "sensor.dishwasher_energy",
                    "switch_entity_id": "switch.dishwasher",
                    "power_entity_id": "sensor.dishwasher_power",
                }
            ],
        )

    def test_no_power_sensor_on_the_card_means_none_here(self):
        # A power sensor is never inferred: a node the tree resolved none for, or
        # one whose id is an external statistic the recorder holds no state for,
        # must yield None rather than a guessed entity.
        tree = _tree(
            [
                _node("sensor.a_energy"),
                _node("sensor.b_energy", powerSensorId=""),
                _node("sensor.c_energy", powerSensorId="source:stat"),
            ]
        )

        result = extract(tree)

        self.assertEqual(len(result), 3)
        for consumer in result:
            self.assertIsNone(consumer["power_entity_id"], consumer["energy_entity_id"])

    def test_no_switch_on_the_card_means_no_switch_here(self):
        # The contract that matters: a node the tree resolved no switch for must
        # yield None. Nothing may infer one from the entity's name or anywhere else.
        tree = _tree(
            [
                _node("sensor.jistic_klimatizace_energy"),
                _node("sensor.jistic_trouba_energy", switchEntityId=""),
                _node("sensor.jistic_indukce_energy", switchEntityId=None),
            ]
        )

        result = extract(tree)

        self.assertEqual(len(result), 3)
        for consumer in result:
            self.assertIsNone(consumer["switch_entity_id"], consumer["energy_entity_id"])

    def test_label_falls_back_to_the_energy_entity(self):
        tree = _tree([_node("sensor.x_energy", displayName="")])

        self.assertEqual(extract(tree)[0]["label"], "sensor.x_energy")

    def test_synthetic_and_source_nodes_are_skipped(self):
        tree = _tree(
            [
                _node("sensor.real_energy"),
                _node("house_unmeasured", isUnmeasured=True),
                _node("sensor.virtual_energy", isVirtual=True),
                _node("sensor.source_energy", isSource=True),
            ]
        )

        self.assertEqual(
            [c["energy_entity_id"] for c in extract(tree)], ["sensor.real_energy"]
        )

    def test_external_statistics_ids_are_skipped(self):
        # No state history behind these, so the breakdown cannot read them; they
        # fall into the unmeasured remainder instead.
        tree = _tree([_node("some_source:total_energy"), _node("sensor.real_energy")])

        self.assertEqual(
            [c["energy_entity_id"] for c in extract(tree)], ["sensor.real_energy"]
        )

    def test_nested_submeters_are_not_returned(self):
        # Their energy is already inside the parent's stat; returning both would
        # double-count against the house total.
        tree = _tree(
            [
                _node(
                    "sensor.parent_energy",
                    children=[_node("sensor.child_energy")],
                )
            ]
        )

        self.assertEqual(
            [c["energy_entity_id"] for c in extract(tree)], ["sensor.parent_energy"]
        )

    def test_malformed_trees_yield_nothing(self):
        for tree in (None, {}, {"consumers": None}, {"consumers": []}, "nonsense"):
            self.assertEqual(extract(tree), [], tree)


if __name__ == "__main__":
    unittest.main()
