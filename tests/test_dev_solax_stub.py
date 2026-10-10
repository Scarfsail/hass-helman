"""The dev-only solax_modbus stub's registry claim (dev/solax_modbus)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

DEV = Path(__file__).resolve().parents[1] / "dev"
if str(DEV) not in sys.path:
    sys.path.insert(0, str(DEV))

from solax_modbus import claim_rows, load_snapshot  # noqa: E402

ENTRY_ID = "stub-entry"
INVERTER = "SolaX Inverter"
ROWS = {"sensor.solax_pv": {"unique_id": "uid_pv", "device": INVERTER}}


class FakeRegistry:
    def __init__(self, rows, refuse=()):
        self.rows = rows
        self.refuse = set(refuse)
        self.updates = []

    def async_get(self, entity_id):
        return self.rows.get(entity_id)

    def async_update_entity_platform(
        self, entity_id, new_platform, *, new_config_entry_id, new_unique_id, new_device_id
    ):
        if entity_id in self.refuse:
            raise ValueError("Only entities that haven't been loaded can be migrated")
        self.updates.append(
            (entity_id, new_platform, new_config_entry_id, new_unique_id, new_device_id)
        )

    def async_update_entity(self, entity_id, *, device_id):
        self.updates.append((entity_id, device_id))


class FakeDeviceRegistry:
    def __init__(self):
        self.created = []

    def async_get_or_create(self, *, config_entry_id, identifiers, name):
        self.created.append((config_entry_id, identifiers, name))
        return SimpleNamespace(id=f"device:{name}")


def _row(platform, config_entry_id=None):
    return SimpleNamespace(platform=platform, config_entry_id=config_entry_id)


class ClaimRowsTests(unittest.TestCase):
    def test_mirrored_row_is_migrated_keeping_its_entity_id(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("remote_homeassistant")})

        result = claim_rows(registry, FakeDeviceRegistry(), ENTRY_ID, ROWS)

        self.assertEqual(
            registry.updates,
            [("sensor.solax_pv", "solax_modbus", ENTRY_ID, "uid_pv", f"device:{INVERTER}")],
        )
        self.assertEqual(result.claimed, ["sensor.solax_pv"])
        self.assertEqual(result.skipped, [])

    def test_row_already_owned_by_the_entry_is_only_moved_onto_its_device(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("solax_modbus", ENTRY_ID)})

        result = claim_rows(registry, FakeDeviceRegistry(), ENTRY_ID, ROWS)

        self.assertEqual(registry.updates, [("sensor.solax_pv", f"device:{INVERTER}")])
        self.assertEqual(result.already_claimed, ["sensor.solax_pv"])

    def test_missing_row_is_skipped(self):
        registry = FakeRegistry({})

        result = claim_rows(registry, FakeDeviceRegistry(), ENTRY_ID, ROWS)

        self.assertEqual(registry.updates, [])
        self.assertEqual(result.skipped, ["sensor.solax_pv"])

    def test_row_owned_by_another_integration_is_skipped(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("template", "other")})

        result = claim_rows(registry, FakeDeviceRegistry(), ENTRY_ID, ROWS)

        self.assertEqual(registry.updates, [])
        self.assertEqual(result.skipped, ["sensor.solax_pv"])

    def test_row_the_registry_refuses_to_migrate_is_skipped(self):
        registry = FakeRegistry(
            {"sensor.solax_pv": _row("remote_homeassistant")},
            refuse={"sensor.solax_pv"},
        )

        result = claim_rows(registry, FakeDeviceRegistry(), ENTRY_ID, ROWS)

        self.assertEqual(result.claimed, [])
        self.assertEqual(result.skipped, ["sensor.solax_pv"])

    def test_one_device_is_created_per_distinct_device_name(self):
        registry = FakeRegistry(
            {
                "sensor.solax_pv": _row("remote_homeassistant"),
                "sensor.solax_grid": _row("remote_homeassistant"),
                "sensor.solax_dashboard_grid": _row("remote_homeassistant"),
            }
        )
        devices = FakeDeviceRegistry()

        claim_rows(
            registry,
            devices,
            ENTRY_ID,
            {
                "sensor.solax_pv": {"unique_id": "uid_pv", "device": INVERTER},
                "sensor.solax_grid": {"unique_id": "uid_grid", "device": INVERTER},
                "sensor.solax_dashboard_grid": {
                    "unique_id": "uid_dash_grid",
                    "device": "SolaX Energy Dashboard",
                },
            },
        )

        self.assertEqual(
            devices.created,
            [
                (ENTRY_ID, {("solax_modbus", "SolaX Energy Dashboard")}, "SolaX Energy Dashboard"),
                (ENTRY_ID, {("solax_modbus", INVERTER)}, INVERTER),
            ],
        )
        self.assertEqual(
            {update[0]: update[-1] for update in registry.updates},
            {
                "sensor.solax_pv": f"device:{INVERTER}",
                "sensor.solax_grid": f"device:{INVERTER}",
                "sensor.solax_dashboard_grid": "device:SolaX Energy Dashboard",
            },
        )


    def test_a_row_on_no_device_is_claimed_without_one(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("remote_homeassistant")})
        devices = FakeDeviceRegistry()

        claim_rows(
            registry,
            devices,
            ENTRY_ID,
            {"sensor.solax_pv": {"unique_id": "uid_pv", "device": None}},
        )

        self.assertEqual(devices.created, [])
        self.assertEqual(
            registry.updates,
            [("sensor.solax_pv", "solax_modbus", ENTRY_ID, "uid_pv", None)],
        )


class SnapshotTests(unittest.TestCase):
    def test_rows_are_keyed_by_entity_id_with_their_unique_id_and_device(self):
        snapshot = load_snapshot()

        for rows in snapshot.values():
            for entity_id, row in rows.items():
                self.assertEqual(set(row), {"unique_id", "device"}, entity_id)
        charger = snapshot["SolaX_EV_Charger"]
        # One unique id in two domains: both rows survive.
        self.assertEqual(
            {
                entity_id: row
                for entity_id, row in charger.items()
                if row["unique_id"] == "SolaX_EV_Charger_control_command"
            },
            {
                "select.solax_ev_charger_control_command": {
                    "unique_id": "SolaX_EV_Charger_control_command",
                    "device": "SolaX_EV_Charger solax_ev_charger",
                },
                "sensor.solax_ev_charger_control_command": {
                    "unique_id": "SolaX_EV_Charger_control_command",
                    "device": "SolaX_EV_Charger solax_ev_charger",
                },
            },
        )


if __name__ == "__main__":
    unittest.main()
