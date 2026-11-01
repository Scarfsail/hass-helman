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
import unittest
from datetime import datetime, timedelta, timezone


from custom_components.helman.const import SIGNAL_LIVE_TICK
from custom_components.helman.tree_builder import HelmanTreeBuilder, TreeIndex  # noqa: E402
from tests._fakes import (
    DISHWASHER_ENERGY,
    DISHWASHER_KWH,
    DISHWASHER_POWER,
    DISHWASHER_SWITCH,
    DISHWASHER_WEIGHTS,
    KITCHEN_ENERGY,
    KITCHEN_OWN_KW,
    KITCHEN_POWER,
    KITCHEN_REMAINDER_KWH,
    FakeHass,
    FakeState,
    FakeStates,
    capture_signal,
    kitchen_config,
    make_live_tracker,
)


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
    builder = HelmanTreeBuilder(_Hass(), {"devices": {"consumers": devices}})
    children = builder._build_house_children([])
    return {node.id: node for node in children}


def _built_house_children(devices):
    """The house's children as ``build`` serialises them, remainders included."""
    config = {
        "energy_nodes": {"house": {"entities": {"power": "sensor.house_power"}}},
        "devices": {"consumers": devices},
    }
    tree = asyncio.run(HelmanTreeBuilder(_Hass(), config).build()).tree
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

    def test_energy_only_own_attribution_does_not_add_live_house_rows(self):
        breaker = _breaker(metered_child=True)
        del breaker["consumption"]["power_entity_id"]
        config = {
            "energy_nodes": {"house": {"entities": {"energy": "sensor.house_energy"}}},
            "devices": {"consumers": [breaker]},
        }
        builder = HelmanTreeBuilder(_Hass(), config)
        live = asyncio.run(builder.build()).tree
        self.assertEqual(live["consumers"], [])
        history = asyncio.run(builder.build(include_house_without_power=True)).tree
        parent = history["consumers"][0]["children"][0]
        self.assertFalse(parent["deferrable"])
        self.assertFalse(any(node["isUnmeasured"] for node in parent["children"]))
        from custom_components.helman.house_device_consumers import extract_house_device_consumers
        rows = extract_house_device_consumers(history)
        shares = [f"sensor.helman_share_energy_ac_{i}" for i in range(4)]
        self.assertEqual([(row["energy_entity_id"], row["deferrable"]) for row in rows],
                         [("sensor.jistic_klimatizace_energy", False)]
                         + [(share, True) for share in shares])
        self.assertEqual(rows[0]["metered_children"], shares)

    def test_all_schedulable_shared_meter_and_mixed_meter_use_canonical_own_attribution(self):
        from custom_components.helman.house_device_consumers import extract_house_device_consumers
        for passive in (False, True):
            breaker = _breaker()
            if passive:
                breaker["children"][0]["schedulable"] = False
            children = _built_house_children([breaker])
            rows = extract_house_device_consumers({"consumers": [
                {"id": "house", "children": list(children.values())}
            ]})
            self.assertEqual(len(rows), 5 if not passive else 4)
            self.assertFalse(rows[0]["deferrable"])
            self.assertEqual(rows[0]["ids"], [])
            self.assertEqual([row["ids"] for row in rows[1:]],
                             [[f"ac-{i}"] for i in range(4) if not passive or i != 0])

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
        HelmanTreeBuilder(_Hass(), {})._add_unmeasured_items(kitchen)

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

        self.assertFalse(breaker["deferrable"])
        self.assertEqual(breaker["controllableIds"], [])
        self.assertEqual(
            [(c["id"], c["controllableIds"], c["deferrable"]) for c in breaker["children"]],
            [(f"sensor.helman_share_energy_ac_{index}", [f"ac-{index}"], True) for index in range(4)],
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
    """Only schedulable leaves carry the carve tint."""

    METER = "sensor.jistic_klimatizace_energy"
    REMAINDER = "sensor_jistic_klimatizace_energy_unmeasured"

    def test_with_a_metered_child_the_remainder_is_passive(self):
        breaker = _built_house_children([_breaker(metered_child=True)])[self.METER]
        children = {c["id"]: c for c in breaker["children"]}

        self.assertFalse(breaker["deferrable"])
        self.assertFalse(children[self.REMAINDER]["deferrable"])
        # The sub-metered heater is not schedulable demand.
        self.assertFalse(children["sensor.heater_energy"]["deferrable"])

    def test_without_metered_children_the_parent_stays_passive(self):
        breaker = _built_house_children([_breaker()])[self.METER]
        children = {c["id"]: c for c in breaker["children"]}

        self.assertFalse(breaker["deferrable"])
        self.assertFalse(children[self.REMAINDER]["deferrable"])


class TestKitchenSplit(unittest.TestCase):
    """A meterless child is a device row like any other, and its share conserves its parent."""

    def test_the_dishwasher_reads_its_share_sensors_and_the_remainder_keeps_the_rest(self):
        config = kitchen_config()
        hass = FakeHass()
        hass.states = FakeStates({
            "sensor.house_power": FakeState("3000"),
            KITCHEN_POWER: FakeState(str(KITCHEN_OWN_KW * 1000)),
            DISHWASHER_SWITCH: FakeState("on"),
        })
        tree = asyncio.run(HelmanTreeBuilder(hass, config).build()).tree
        (kitchen,) = [n for n in tree["consumers"][0]["children"] if n["id"] == KITCHEN_ENERGY]
        dishwasher, remainder = kitchen["children"]

        self.assertEqual(
            (dishwasher["id"], dishwasher["energyEntityId"], dishwasher["powerSensorId"]),
            (DISHWASHER_ENERGY, DISHWASHER_ENERGY, DISHWASHER_POWER),
        )
        self.assertTrue(dishwasher["isEstimated"])
        self.assertTrue(remainder["isUnmeasured"])

        # One hour of the live split: one tick an hour long.
        tracker = make_live_tracker(hass, config, weights=DISHWASHER_WEIGHTS)
        tracker._init_buffers(tree, TreeIndex.from_tree(tree))
        tracker._source_sensor_ids = []
        tracker._tick_seconds = 3600.0
        now = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)
        tracker._energy_since = now - timedelta(hours=1)
        sent = capture_signal(hass, SIGNAL_LIVE_TICK)
        tracker._tick(now)

        self.assertAlmostEqual(sent[0][DISHWASHER_ENERGY], DISHWASHER_KWH)
        self.assertAlmostEqual(
            sent[0][remainder["powerSensorId"]] / 1000, KITCHEN_REMAINDER_KWH
        )


if __name__ == "__main__":
    unittest.main()
