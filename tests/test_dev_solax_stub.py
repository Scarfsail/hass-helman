"""The dev-only solax_modbus stub's registry claim (dev/solax_modbus)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

DEV = Path(__file__).resolve().parents[1] / "dev"
if str(DEV) not in sys.path:
    sys.path.insert(0, str(DEV))

from solax_modbus import claim_rows  # noqa: E402

ENTRY_ID = "stub-entry"


class FakeRegistry:
    def __init__(self, rows, refuse=()):
        self.rows = rows
        self.refuse = set(refuse)
        self.updates = []

    def async_get(self, entity_id):
        return self.rows.get(entity_id)

    def async_update_entity_platform(
        self, entity_id, new_platform, *, new_config_entry_id, new_unique_id
    ):
        if entity_id in self.refuse:
            raise ValueError("Only entities that haven't been loaded can be migrated")
        self.updates.append(
            (entity_id, new_platform, new_config_entry_id, new_unique_id)
        )


def _row(platform, config_entry_id=None):
    return SimpleNamespace(platform=platform, config_entry_id=config_entry_id)


class ClaimRowsTests(unittest.TestCase):
    def test_mirrored_row_is_migrated_keeping_its_entity_id(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("remote_homeassistant")})

        result = claim_rows(registry, ENTRY_ID, {"uid_pv": "sensor.solax_pv"})

        self.assertEqual(
            registry.updates,
            [("sensor.solax_pv", "solax_modbus", ENTRY_ID, "uid_pv")],
        )
        self.assertEqual(result.claimed, ["sensor.solax_pv"])
        self.assertEqual(result.skipped, [])

    def test_row_already_owned_by_the_entry_is_left_alone(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("solax_modbus", ENTRY_ID)})

        result = claim_rows(registry, ENTRY_ID, {"uid_pv": "sensor.solax_pv"})

        self.assertEqual(registry.updates, [])
        self.assertEqual(result.already_claimed, ["sensor.solax_pv"])

    def test_missing_row_is_skipped(self):
        registry = FakeRegistry({})

        result = claim_rows(registry, ENTRY_ID, {"uid_pv": "sensor.solax_pv"})

        self.assertEqual(registry.updates, [])
        self.assertEqual(result.skipped, ["sensor.solax_pv"])

    def test_row_owned_by_another_integration_is_skipped(self):
        registry = FakeRegistry({"sensor.solax_pv": _row("template", "other")})

        result = claim_rows(registry, ENTRY_ID, {"uid_pv": "sensor.solax_pv"})

        self.assertEqual(registry.updates, [])
        self.assertEqual(result.skipped, ["sensor.solax_pv"])

    def test_row_the_registry_refuses_to_migrate_is_skipped(self):
        registry = FakeRegistry(
            {"sensor.solax_pv": _row("remote_homeassistant")},
            refuse={"sensor.solax_pv"},
        )

        result = claim_rows(registry, ENTRY_ID, {"uid_pv": "sensor.solax_pv"})

        self.assertEqual(result.claimed, [])
        self.assertEqual(result.skipped, ["sensor.solax_pv"])


if __name__ == "__main__":
    unittest.main()
