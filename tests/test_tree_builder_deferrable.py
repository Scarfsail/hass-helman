"""House children carry the deferrability of their controllable.

The power card marks the loads the optimizer may move in time, and it must do so
from the same roster the house forecast carves out — no second list to keep in
agreement. A house child's node id *is* its energy statistic, which is exactly
what ``read_deferrable_consumers`` is keyed by, so the match is a set lookup and
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
    return {
        "id": controllable_id,
        "name": controllable_id.title(),
        "consumption": {"energy_entity_id": energy_entity_id, **consumption},
    }


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
        self.assertEqual(
            {c["id"]: c["deferrable"] for c in payload["children"]},
            {"sensor.dishwasher_energy": True, "sensor_kitchen_energy_unmeasured": False},
        )


if __name__ == "__main__":
    unittest.main()
