"""The inspector's consumer list must mirror the power card's device tree exactly.

The controlling switch in particular is never inferred: whatever the tree resolved
for a node is what both views show, so a device the card offers no control for is
a device the inspector offers no control for either.
"""

from __future__ import annotations

import importlib
import unittest
from datetime import datetime, timedelta, timezone

from custom_components.helman.shared_meter_fit import own_energy_changes


module = importlib.import_module("custom_components.helman.house_device_consumers")
extract = module.extract_house_device_consumers
START = datetime(2026, 11, 1, 10, tzinfo=timezone.utc)


def _tree(children):
    return {"consumers": [{"id": "house", "children": children}]}


def _node(node_id, **overrides):
    node = {
        "id": node_id,
        "energyEntityId": node_id,
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
                    "metered_children": [],
                    "deferrable": False,
                    "ids": [],
                }
            ],
        )

    def test_the_meter_is_read_from_energy_entity_id_not_the_node_id(self):
        # The node id is only the card's list key; the meter is its own field.
        tree = _tree(
            [
                _node("row-key", energyEntityId="sensor.dishwasher_energy"),
                _node("sensor.no_meter_energy", energyEntityId=None),
            ]
        )

        self.assertEqual(
            [c["energy_entity_id"] for c in extract(tree)],
            ["sensor.dishwasher_energy"],
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

    def test_carved_own_load_keeps_passive_child_in_base_group(self):
        tree = _tree([_node("sensor.parent", deferrable=True,
                            controllableIds=["washer", "dryer"],
                            children=[_node("sensor.passive", children=[
                                _node("sensor.nested", deferrable=True,
                                      controllableIds=["heater"])
                            ])])])
        rows = extract(tree)
        self.assertEqual([row["deferrable"] for row in rows], [True, False, True])
        self.assertEqual([row["metered_children"] for row in rows],
                         [["sensor.passive"], ["sensor.nested"], []])
        self.assertEqual(rows[0]["ids"], ["washer", "dryer"])
        self.assertIsNone(rows[0]["power_entity_id"])

    def test_duplicate_meters_are_not_measured_twice(self):
        tree = _tree([_node("sensor.shared"), _node("sensor.shared")])
        self.assertEqual([row["energy_entity_id"] for row in extract(tree)], ["sensor.shared"])

    def test_a_meterless_child_is_a_disjoint_row_that_conserves_its_parent(self):
        # The kitchen circuit read 1.3 kWh; its dishwasher's share sensor 1 kWh.
        share = "sensor.helman_share_energy_dishwasher"
        tree = _tree([_node("sensor.kitchen", children=[
                                _node(share, isEstimated=True, deferrable=True,
                                      controllableIds=["dishwasher"]),
                            ])])
        rows = extract(tree)
        self.assertEqual([row["energy_entity_id"] for row in rows], ["sensor.kitchen", share])
        self.assertEqual(rows[0]["metered_children"], [share])
        # The dishwasher is claimed by its own row only, not the circuit's too.
        self.assertEqual(rows[0]["ids"], [])
        self.assertEqual(rows[1]["ids"], ["dishwasher"])

        slot = timedelta(hours=1)
        energy = {"sensor.kitchen": {START: 1.3}, share: {START: 1.0}}
        own = {
            row["energy_entity_id"]: own_energy_changes(
                energy[row["energy_entity_id"]],
                [energy[child] for child in row["metered_children"]],
                slot=slot,
            )[START]
            for row in rows
        }
        # Parent remainder plus child is the parent's meter, counted once.
        self.assertAlmostEqual(own["sensor.kitchen"], 0.3)
        self.assertAlmostEqual(own[share], 1.0)
        self.assertAlmostEqual(sum(own.values()), 1.3)

    def test_each_meterless_child_claims_its_id_from_its_carved_parent(self):
        tree = _tree([_node("sensor.breaker", children=[
                                _node("sensor.helman_share_energy_ac_1", isEstimated=True,
                                      deferrable=True, controllableIds=["ac_1"]),
                                _node("sensor.helman_share_energy_ac_2", isEstimated=True,
                                      deferrable=True, controllableIds=["ac_2"]),
                            ])])
        self.assertEqual([row["ids"] for row in extract(tree)], [[], ["ac_1"], ["ac_2"]])

    def test_a_meterless_child_of_a_passive_meter_stays_in_its_row(self):
        tree = _tree([_node("sensor.mixed", children=[
            _node("sensor.helman_share_energy_ac", isEstimated=True, controllableIds=["ac"])
        ])])
        (row,) = extract(tree)
        self.assertFalse(row["deferrable"])
        self.assertEqual(row["ids"], [])
        self.assertEqual(row["metered_children"], [])

    def test_malformed_trees_yield_nothing(self):
        for tree in (None, {}, {"consumers": None}, {"consumers": []}, "nonsense"):
            self.assertEqual(extract(tree), [], tree)

    def test_carved_meters_beneath_a_row_are_its_metered_children(self):
        # A schedulable washer under a passive circuit is a breakdown row of its
        # own, so the circuit's row must leave it out. Only the topmost carved
        # meter counts: the one beneath it is already inside its row.
        tree = _tree(
            [
                _node(
                    "sensor.circuit_energy",
                    children=[
                        _node("sensor.lamp_energy"),
                        _node(
                            "sensor.room_energy",
                            children=[
                                _node(
                                    "sensor.washer_energy",
                                    deferrable=True,
                                    children=[_node("sensor.inner_energy", deferrable=True)],
                                )
                            ],
                        ),
                    ],
                )
            ]
        )

        result = extract(tree)

        self.assertEqual(result[0]["metered_children"], ["sensor.washer_energy"])
        self.assertEqual(result[1]["metered_children"], ["sensor.inner_energy"])
        self.assertEqual(len(result), 3)


if __name__ == "__main__":
    unittest.main()
