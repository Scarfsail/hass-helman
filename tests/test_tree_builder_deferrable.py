"""House children carry the carve-out of the device that owns their meter.

The power card marks the loads the optimizer may move in time, and it must do so
from the same roster the house forecast carves out — no second list to keep in
agreement. A house child is a metered device, and its meter is exactly what
``read_carved_meters`` is keyed by, so the match is a dict lookup — which also
hands the node the device ids the schedule is stored under — and nothing else on
the tree is touched.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path
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


def _built_house_children(devices):
    """The house's children as ``build`` serialises them, remainders included."""
    config = {
        "power_devices": {"house": {"entities": {"power": "sensor.house_power"}}},
        "devices": devices,
    }
    with mock.patch.object(tree_builder.er, "async_get", lambda _hass: _Registry()), \
            mock.patch.object(tree_builder.lr, "async_get", lambda _hass: _Registry()):
        tree = asyncio.run(HelmanTreeBuilder(_Hass(), config).build())
    (house,) = tree["consumers"]
    return {node["id"]: node for node in house["children"]}


def _breaker(*, metered_child=False):
    """The AC breaker: a passive meter owner split by four schedulable ACs."""
    children = [
        {
            "id": f"ac-{index}",
            "kind": "climate",
            "schedulable": True,
            "controls": {"climate": {"entity_id": f"climate.ac_{index}"}},
        }
        for index in range(4)
    ]
    if metered_child:
        children.insert(
            0,
            {
                "id": "heater",
                "consumption": {
                    "energy_entity_id": "sensor.heater_energy",
                    "power_entity_id": "sensor.heater_power",
                },
            },
        )
    return {
        "id": "breaker",
        "consumption": {
            "energy_entity_id": "sensor.jistic_klimatizace_energy",
            "power_entity_id": "sensor.jistic_klimatizace_power",
        },
        "children": children,
    }


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
        kitchen["consumption"]["power_entity_id"] = "sensor.kitchen_power"
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

    def test_a_shared_meter_s_children_carry_their_own_schedule_ids(self):
        # Four air conditioners on one breaker meter: a badge on each, keyed by
        # its own id; the passive breaker names none.
        meter = "sensor.jistic_klimatizace_energy"
        breaker = _house_children([_breaker()])[meter].to_dict()

        self.assertTrue(breaker["deferrable"])
        self.assertEqual(breaker["controllableIds"], [])
        self.assertEqual(
            [(c["id"], c["controllableIds"], c["deferrable"]) for c in breaker["children"]],
            [(f"ac-{index}", [f"ac-{index}"], True) for index in range(4)],
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


class TestCarveOutTintFollowsOwnEnergy(unittest.TestCase):
    """A carved meter carves its own energy; the tint goes where that shows."""

    METER = "sensor.jistic_klimatizace_energy"
    REMAINDER = "sensor_jistic_klimatizace_energy_unmeasured"

    def test_with_a_metered_child_the_remainder_is_marked_not_the_aggregate(self):
        breaker = _built_house_children([_breaker(metered_child=True)])[self.METER]
        children = {c["id"]: c for c in breaker["children"]}

        self.assertFalse(breaker["deferrable"])
        self.assertTrue(children[self.REMAINDER]["deferrable"])
        # The sub-metered heater is not schedulable demand.
        self.assertFalse(children["sensor.heater_energy"]["deferrable"])

    def test_without_metered_children_the_parent_keeps_the_mark(self):
        breaker = _built_house_children([_breaker()])[self.METER]
        children = {c["id"]: c for c in breaker["children"]}

        self.assertTrue(breaker["deferrable"])
        self.assertFalse(children[self.REMAINDER]["deferrable"])


if __name__ == "__main__":
    unittest.main()
