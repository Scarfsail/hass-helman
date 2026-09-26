"""House children carry the carve-out of the device that owns their meter.

The power card marks the loads the optimizer may move in time, and it must do so
from the same roster the house forecast carves out — no second list to keep in
agreement. A house child is a metered device, and its meter is exactly what
``read_carved_meters`` is keyed by, so the match is a dict lookup — which also
hands the node the device ids the schedule is stored under — and nothing else on
the tree is touched.
"""

from __future__ import annotations

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

from custom_components.helman.tree_builder import HelmanTreeBuilder  # noqa: E402


class _Registry:
    """A registry that knows nothing: no device here carries labels.

    The tree only consults the registries for the labels, which deferrability
    does not depend on.
    """

    entities: dict = {}

    def async_get(self, entity_id):
        return None


class _Hass:
    class states:
        @staticmethod
        def get(entity_id):
            return None


def _controllable(controllable_id, energy_entity_id, *, schedulable=True):
    entry = {
        "name": (controllable_id or energy_entity_id).title(),
        "schedulable": schedulable,
        "consumption": {"energy_entity_id": energy_entity_id},
    }
    if controllable_id is not None:
        entry["id"] = controllable_id
    return entry


def _house_children(devices):
    builder = HelmanTreeBuilder(_Hass(), {"devices": devices})
    reg = _Registry()
    children = builder._build_house_children(reg, reg, {})
    return {node.id: node for node in children}


class TestHouseChildDeferrability(unittest.TestCase):

    def test_only_the_children_that_are_deferrable_controllables_are_marked(self):
        nodes = _house_children(
            [
                _controllable("dishwasher", "sensor.dishwasher_energy"),
                _controllable("fridge", "sensor.fridge_energy", schedulable=False),
            ]
        )

        self.assertTrue(nodes["sensor.dishwasher_energy"].deferrable)
        self.assertFalse(nodes["sensor.fridge_energy"].deferrable)

    def test_a_passive_device_is_not_marked(self):
        nodes = _house_children(
            [_controllable("boiler", "sensor.boiler_energy", schedulable=False)]
        )

        self.assertFalse(nodes["sensor.boiler_energy"].deferrable)

    def test_the_flag_reaches_the_wire_and_the_remainder_defaults_false(self):
        kitchen = _controllable("kitchen", "sensor.kitchen_energy", schedulable=False)
        kitchen["children"] = [_controllable("dishwasher", "sensor.dishwasher_energy")]
        nodes = _house_children([kitchen])
        kitchen = nodes["sensor.kitchen_energy"]
        # The remainder is synthesised without consulting the roster at all.
        HelmanTreeBuilder(_Hass(), {})._add_unmeasured_nodes(kitchen, "Unmeasured")

        payload = kitchen.to_dict()
        self.assertFalse(payload["deferrable"])
        self.assertEqual(payload["controllableIds"], [])
        self.assertEqual(
            {c["id"]: c["deferrable"] for c in payload["children"]},
            {"sensor.dishwasher_energy": True, "sensor_kitchen_energy_unmeasured": False},
        )
        self.assertEqual(
            {c["id"]: c["controllableIds"] for c in payload["children"]},
            {
                "sensor.dishwasher_energy": ["dishwasher"],
                "sensor_kitchen_energy_unmeasured": [],
            },
        )


class TestHouseChildControllableId(unittest.TestCase):
    """The badge needs the key the schedule is stored under, not the meter."""

    def test_a_deferrable_child_carries_the_controllable_that_owns_its_meter(self):
        nodes = _house_children(
            [
                _controllable("dishwasher", "sensor.dishwasher_energy"),
                _controllable("fridge", "sensor.fridge_energy", schedulable=False),
            ]
        )

        self.assertEqual(
            nodes["sensor.dishwasher_energy"].controllable_ids, ["dishwasher"]
        )
        # Nothing the roster does not name is given an id to look a schedule up by.
        self.assertEqual(nodes["sensor.fridge_energy"].controllable_ids, [])

    def test_a_shared_meter_is_one_node_naming_every_controllable_behind_it(self):
        # Four air conditioners on one breaker meter: one node, one badge, and
        # the badge has to cover all four schedules.
        meter = "sensor.jistic_klimatizace_energy"
        breaker = {
            "id": "breaker",
            "consumption": {"energy_entity_id": meter},
            "children": [
                {"id": f"ac-{index}", "kind": "climate", "schedulable": True}
                for index in range(4)
            ],
        }
        nodes = _house_children([breaker])

        self.assertEqual(list(nodes), [meter])
        self.assertTrue(nodes[meter].deferrable)
        self.assertEqual(
            nodes[meter].to_dict()["controllableIds"],
            ["ac-0", "ac-1", "ac-2", "ac-3"],
        )

    def test_a_roster_entry_with_no_id_is_deferrable_with_no_controllable(self):
        # Such an entry can never be scheduled, so there is nothing to key off —
        # but it is still carved out of the base load, so it stays deferrable.
        nodes = _house_children([_controllable(None, "sensor.dryer_energy")])

        self.assertTrue(nodes["sensor.dryer_energy"].deferrable)
        self.assertEqual(nodes["sensor.dryer_energy"].controllable_ids, [])

    def test_a_passive_device_carries_no_controllable_ids(self):
        nodes = _house_children(
            [_controllable("boiler", "sensor.boiler_energy", schedulable=False)]
        )

        self.assertEqual(nodes["sensor.boiler_energy"].controllable_ids, [])


if __name__ == "__main__":
    unittest.main()
