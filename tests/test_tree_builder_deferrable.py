"""House children carry the deferrability of their controllable.

The power card marks the loads the optimizer may move in time, and it must do so
from the same roster the house forecast carves out — no second list to keep in
agreement. A house child's node id *is* its energy statistic, which is exactly
what ``read_deferrable_consumers`` is keyed by, so the match is a dict lookup —
which also hands the node the controllable id the schedule is stored under — and
nothing else on the tree is touched.
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
    """A registry that knows nothing: every device here is meter-only.

    The tree only consults the registries for the switch, the labels and a power
    sensor fallback, none of which deferrability depends on.
    """

    entities: dict = {}

    def async_get(self, entity_id):
        return None


class _Hass:
    class states:
        @staticmethod
        def get(entity_id):
            return None


def _controllable(controllable_id, energy_entity_id, **consumption):
    entry = {
        "name": (controllable_id or energy_entity_id).title(),
        "consumption": {"energy_entity_id": energy_entity_id, **consumption},
    }
    if controllable_id is not None:
        entry["id"] = controllable_id
    return entry


def _house_children(controllables, stats, parent_of=None):
    builder = HelmanTreeBuilder(_Hass(), {"controllables": controllables})
    prefs = {
        "device_consumption": [
            {
                "stat_consumption": stat,
                "stat_rate": f"{stat}_power",
                "included_in_stat": (parent_of or {}).get(stat),
            }
            for stat in stats
        ]
    }
    reg = _Registry()
    children = builder._build_house_children(prefs, reg, reg, reg, {}, {})
    return {node.id: node for node in children}


class TestHouseChildDeferrability(unittest.TestCase):

    def test_only_the_children_that_are_deferrable_controllables_are_marked(self):
        nodes = _house_children(
            [_controllable("dishwasher", "sensor.dishwasher_energy")],
            ["sensor.dishwasher_energy", "sensor.fridge_energy"],
        )

        self.assertTrue(nodes["sensor.dishwasher_energy"].deferrable)
        self.assertFalse(nodes["sensor.fridge_energy"].deferrable)

    def test_a_controllable_that_opted_out_is_not_marked(self):
        nodes = _house_children(
            [_controllable("boiler", "sensor.boiler_energy", deferrable=False)],
            ["sensor.boiler_energy"],
        )

        self.assertFalse(nodes["sensor.boiler_energy"].deferrable)

    def test_the_flag_reaches_the_wire_and_the_remainder_defaults_false(self):
        nodes = _house_children(
            [_controllable("dishwasher", "sensor.dishwasher_energy")],
            ["sensor.kitchen_energy", "sensor.dishwasher_energy"],
            parent_of={"sensor.dishwasher_energy": "sensor.kitchen_energy"},
        )
        kitchen = nodes["sensor.kitchen_energy"]
        # The remainder is synthesised without consulting the roster at all.
        HelmanTreeBuilder(_Hass(), {})._add_unmeasured_nodes(kitchen, "Unmeasured")

        payload = kitchen.to_dict()
        self.assertFalse(payload["deferrable"])
        self.assertIsNone(payload["controllableId"])
        self.assertEqual(
            {c["id"]: c["deferrable"] for c in payload["children"]},
            {"sensor.dishwasher_energy": True, "sensor_kitchen_energy_unmeasured": False},
        )
        self.assertEqual(
            {c["id"]: c["controllableId"] for c in payload["children"]},
            {
                "sensor.dishwasher_energy": "dishwasher",
                "sensor_kitchen_energy_unmeasured": None,
            },
        )


class TestHouseChildControllableId(unittest.TestCase):
    """The badge needs the key the schedule is stored under, not the meter."""

    def test_a_deferrable_child_carries_the_controllable_that_owns_its_meter(self):
        nodes = _house_children(
            [_controllable("dishwasher", "sensor.dishwasher_energy")],
            ["sensor.dishwasher_energy", "sensor.fridge_energy"],
        )

        self.assertEqual(
            nodes["sensor.dishwasher_energy"].controllable_id, "dishwasher"
        )
        # Nothing the roster does not name is given an id to look a schedule up by.
        self.assertIsNone(nodes["sensor.fridge_energy"].controllable_id)

    def test_a_roster_entry_with_no_id_is_deferrable_with_no_controllable(self):
        # Such an entry can never be scheduled, so there is nothing to key off —
        # but it is still carved out of the base load, so it stays deferrable.
        nodes = _house_children(
            [_controllable(None, "sensor.dryer_energy")],
            ["sensor.dryer_energy"],
        )

        self.assertTrue(nodes["sensor.dryer_energy"].deferrable)
        self.assertIsNone(nodes["sensor.dryer_energy"].controllable_id)

    def test_a_controllable_that_opted_out_carries_no_controllable_id(self):
        nodes = _house_children(
            [_controllable("boiler", "sensor.boiler_energy", deferrable=False)],
            ["sensor.boiler_energy"],
        )

        self.assertIsNone(nodes["sensor.boiler_energy"].controllable_id)


if __name__ == "__main__":
    unittest.main()
