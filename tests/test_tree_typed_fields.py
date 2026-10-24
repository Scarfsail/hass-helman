"""The tree carries the resolved fields the cards read, never the stored config.

A card that read ``energy_nodes`` verbatim broke silently whenever a migration
renamed a key, and filled every unset field from a default of its own. The
tree builder now resolves each field once, from the active config, with the
backend's defaults; and a battery's or grid's power carries the sign that reads
it losslessly, where ``valueType`` keeps only one half's magnitude.
"""

from __future__ import annotations

import asyncio
import unittest

from custom_components.helman.config_defaults import CONFIG_FIELD_DEFAULTS
from custom_components.helman.const import (
    BATTERY_DEFAULT_MAX_POWER_W,
    GRID_DEFAULT_MAX_POWER_W,
    SOLAR_DEFAULT_MAX_POWER_W,
)
from custom_components.helman.tree_builder import HelmanTreeBuilder

TYPED_KEYS = {
    "power", "maxPowerW", "socEntityId", "minSocEntityId", "maxSocEntityId",
    "remainingEnergyEntityId", "todayEnergyEntityId", "todayImportEntityId",
    "todayExportEntityId",
}


class _Hass:
    class states:
        @staticmethod
        def get(entity_id):
            return None


def _build(energy_nodes: dict) -> dict:
    return asyncio.run(HelmanTreeBuilder(_Hass(), {"energy_nodes": energy_nodes}).build()).tree


def _nodes(tree: dict) -> dict[str, dict]:
    """``{"<group>:<sourceType>": node}`` for every energy node the build made."""
    return {
        f"{group}:{node['sourceType']}": node
        for group in ("sources", "consumers")
        for node in tree[group]
    }


FULL = {
    "solar": {
        "max_power": 9000,
        "entities": {"power": "sensor.solar_power", "today_energy": "sensor.solar_today"},
    },
    "house": {"entities": {"power": "sensor.house_power", "today_energy": "sensor.house_today"}},
    "battery": {
        "max_power": 6000,
        "entities": {
            "power": "sensor.battery_power",
            "capacity": "sensor.battery_soc",
            "min_soc": "sensor.battery_min_soc",
            "max_soc": "sensor.battery_max_soc",
            "remaining_energy": "sensor.battery_remaining",
        },
    },
    "grid": {
        "max_power": 17000,
        "entities": {
            "power": "sensor.grid_power",
            "today_import": "sensor.grid_import_today",
            "today_export": "sensor.grid_export_today",
        },
    },
}


class TestTypedFields(unittest.TestCase):
    def test_only_one_schedulable_meter_owner_has_appliance_kind(self):
        config = {
            "energy_nodes": {"house": {"entities": {"power": "sensor.house_power"}}},
            "devices": {"consumers": [
                {"id": "ev", "kind": "ev_charger", "schedulable": True,
                 "consumption": {"energy_entity_id": "sensor.ev_energy"}},
                {"id": "light", "kind": "generic", "schedulable": False,
                 "consumption": {"energy_entity_id": "sensor.light_energy"}},
            ]},
        }
        tree = asyncio.run(HelmanTreeBuilder(_Hass(), config).build()).tree
        children = {node["id"]: node for node in tree["consumers"][0]["children"]}
        self.assertEqual(children["sensor.ev_energy"]["controllableIds"], ["ev"])
        self.assertEqual(children["sensor.ev_energy"]["applianceKind"], "ev_charger")
        self.assertNotIn("applianceKind", children["sensor.light_energy"])

    def test_a_metered_device_carries_its_configured_climate_entity(self):
        config = {
            "energy_nodes": {"house": {"entities": {"power": "sensor.house_power"}}},
            "devices": {"consumers": [
                {"id": "ac", "kind": "climate", "schedulable": False,
                 "consumption": {"energy_entity_id": "sensor.ac_energy"},
                 "controls": {
                     "switch": {"entity_id": "switch.ac_breaker"},
                     "climate": {"entity_id": " climate.living_room "},
                 }},
                {"id": "light", "kind": "generic", "schedulable": False,
                 "consumption": {"energy_entity_id": "sensor.light_energy"},
                 "controls": {"switch": {"entity_id": "switch.light"}, "climate": {"entity_id": ""}}},
            ]},
        }
        tree = asyncio.run(HelmanTreeBuilder(_Hass(), config).build()).tree
        house = tree["consumers"][0]
        children = {node["id"]: node for node in house["children"]}
        # Both controls are typed fields of their own, the climate one trimmed.
        self.assertEqual(children["sensor.ac_energy"]["switchEntityId"], "switch.ac_breaker")
        self.assertEqual(children["sensor.ac_energy"]["climateEntityId"], "climate.living_room")
        # An unset or blank climate control is a typed null, never dropped.
        self.assertIn("climateEntityId", children["sensor.light_energy"])
        self.assertIsNone(children["sensor.light_energy"]["climateEntityId"])
        self.assertIsNone(house["climateEntityId"])

    def test_the_stored_config_is_not_shipped(self):
        for key, node in _nodes(_build(FULL)).items():
            with self.subTest(node=key):
                self.assertNotIn("sourceConfig", node)
                self.assertLessEqual(TYPED_KEYS, node.keys())

    def test_each_node_carries_its_resolved_fields(self):
        nodes = _nodes(_build(FULL))
        empty = dict.fromkeys(TYPED_KEYS)
        solar = {**empty, "maxPowerW": 9000.0, "todayEnergyEntityId": "sensor.solar_today"}
        house = {**empty, "todayEnergyEntityId": "sensor.house_today"}
        battery = {
            **empty,
            "power": {"entityId": "sensor.battery_power", "sign": 1},
            "maxPowerW": 6000.0,
            "socEntityId": "sensor.battery_soc",
            "minSocEntityId": "sensor.battery_min_soc",
            "maxSocEntityId": "sensor.battery_max_soc",
            "remainingEnergyEntityId": "sensor.battery_remaining",
        }
        grid = {
            **empty,
            "power": {"entityId": "sensor.grid_power", "sign": 1},
            "maxPowerW": 17000.0,
            "todayImportEntityId": "sensor.grid_import_today",
            "todayExportEntityId": "sensor.grid_export_today",
        }
        expected = {
            "sources:solar": solar,
            "sources:battery": battery,
            "sources:grid": grid,
            "consumers:house": house,
            "consumers:battery": battery,
            "consumers:grid": grid,
        }
        for key, fields in expected.items():
            with self.subTest(node=key):
                self.assertEqual({k: nodes[key][k] for k in TYPED_KEYS}, fields)

    def test_house_children_carry_none(self):
        tree = _build(FULL)
        house = _nodes(tree)["consumers:house"]
        for child in house["children"]:
            self.assertEqual({k: child[k] for k in TYPED_KEYS}, dict.fromkeys(TYPED_KEYS))
        self.assertNotIn("applianceKind", house)

    def test_a_renamed_stored_key_does_not_reach_the_tree(self):
        """Only the keys the builder resolves are read; anything else stays behind."""
        renamed = {
            "battery": {"entities": {"power": "sensor.battery_power", "soc": "sensor.battery_soc"}},
        }
        node = _nodes(_build(renamed))["sources:battery"]
        self.assertIsNone(node["socEntityId"])
        self.assertNotIn("sensor.battery_soc", repr(node))


class TestPowerSign(unittest.TestCase):
    """``power.sign`` turns the raw reading into Helman's convention, both polarities."""

    def _signs(self, **polarities: str) -> dict[str, int]:
        energy_nodes = {
            device: {"entities": {"power": f"sensor.{device}_power", **(
                {"power_polarity": polarities[device]} if device in polarities else {}
            )}}
            for device in ("battery", "grid")
        }
        return {key: node["power"]["sign"] for key, node in _nodes(_build(energy_nodes)).items()}

    def test_upright_sensors_read_as_they_are(self):
        self.assertEqual(set(self._signs().values()), {1})
        explicit = self._signs(battery="positive_is_charging", grid="positive_is_export")
        self.assertEqual(set(explicit.values()), {1})

    def test_inverted_sensors_flip_on_both_halves(self):
        signs = self._signs(battery="positive_is_discharging", grid="positive_is_import")
        self.assertEqual(signs, {
            "sources:battery": -1, "consumers:battery": -1,
            "sources:grid": -1, "consumers:grid": -1,
        })

    def test_inverting_one_device_leaves_the_other_alone(self):
        signs = self._signs(grid="positive_is_import")
        self.assertEqual(signs["sources:battery"], 1)
        self.assertEqual(signs["sources:grid"], -1)

    def test_solar_and_house_carry_no_signed_power(self):
        nodes = _nodes(_build(FULL))
        self.assertIsNone(nodes["sources:solar"]["power"])
        self.assertIsNone(nodes["consumers:house"]["power"])


class TestMaxPowerDefaults(unittest.TestCase):
    def test_unset_max_power_takes_the_backend_default(self):
        energy_nodes = {
            device: {"entities": {"power": f"sensor.{device}_power"}}
            for device in ("solar", "battery", "grid")
        }
        nodes = _nodes(_build(energy_nodes))
        self.assertEqual(nodes["sources:solar"]["maxPowerW"], SOLAR_DEFAULT_MAX_POWER_W)
        self.assertEqual(nodes["sources:battery"]["maxPowerW"], BATTERY_DEFAULT_MAX_POWER_W)
        self.assertEqual(nodes["consumers:battery"]["maxPowerW"], BATTERY_DEFAULT_MAX_POWER_W)
        self.assertEqual(nodes["sources:grid"]["maxPowerW"], GRID_DEFAULT_MAX_POWER_W)

    def test_non_positive_max_power_reads_as_unset(self):
        for bogus in (0, -5, "nonsense", True, "inf", float("inf"), float("nan"), 1e400):
            with self.subTest(value=bogus):
                tree = _build({"grid": {"max_power": bogus, "entities": {"power": "sensor.g"}}})
                self.assertEqual(_nodes(tree)["sources:grid"]["maxPowerW"], GRID_DEFAULT_MAX_POWER_W)

    def test_the_editor_hints_the_same_defaults(self):
        self.assertEqual(CONFIG_FIELD_DEFAULTS["energy_nodes.solar.max_power"], SOLAR_DEFAULT_MAX_POWER_W)
        self.assertEqual(CONFIG_FIELD_DEFAULTS["energy_nodes.battery.max_power"], BATTERY_DEFAULT_MAX_POWER_W)
        self.assertEqual(CONFIG_FIELD_DEFAULTS["energy_nodes.grid.max_power"], GRID_DEFAULT_MAX_POWER_W)

    def test_the_history_bucket_default_comes_from_visualization(self):
        tree = _build(FULL)
        self.assertEqual(tree["uiConfig"]["history_bucket_duration"], 5)


if __name__ == "__main__":
    unittest.main()
