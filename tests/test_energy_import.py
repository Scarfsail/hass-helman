"""Energy ``device_consumption`` rows as ``devices`` entries.

Pure, so this runs on the host: the preferences are an argument, and what could
not be imported comes back as data for the caller to log or present.
"""

from __future__ import annotations

import sys
import types
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

from custom_components.helman.controllables.energy_import import (  # noqa: E402
    EnergyImportConflict,
    import_energy_preferences,
)


def _row(meter, rate=None, included_in=None):
    row = {"stat_consumption": meter}
    if rate is not None:
        row["stat_rate"] = rate
    if included_in is not None:
        row["included_in_stat"] = included_in
    return row


def _import(devices, *rows):
    return import_energy_preferences(devices, {"device_consumption": list(rows)})


def _dishwasher(**overrides):
    return {
        "kind": "generic",
        "id": "dishwasher",
        "schedulable": True,
        "controls": {"switch": {"entity_id": "switch.dishwasher"}},
        "consumption": {"energy_entity_id": "sensor.dishwasher_energy"},
        **overrides,
    }


class EnergyImportTests(unittest.TestCase):
    def test_a_row_becomes_a_passive_device_named_after_its_meter(self) -> None:
        result = _import([], _row("sensor.oven_energy", "sensor.oven_power"))

        self.assertEqual(
            result.devices,
            [
                {
                    "id": "oven_energy",
                    "consumption": {
                        "energy_entity_id": "sensor.oven_energy",
                        "power_entity_id": "sensor.oven_power",
                    },
                }
            ],
        )
        self.assertEqual(result.conflicts, [])

    def test_a_row_without_stat_rate_imports_energy_only(self) -> None:
        result = _import([], _row("sensor.oven_energy"))

        self.assertEqual(
            result.devices[0]["consumption"], {"energy_entity_id": "sensor.oven_energy"}
        )

    def test_included_in_stat_becomes_nesting(self) -> None:
        result = _import(
            [],
            # A child listed before its parent still lands under it.
            _row("sensor.plug_energy", "sensor.plug_power", "sensor.breaker_energy"),
            _row("sensor.breaker_energy", "sensor.breaker_power"),
        )

        self.assertEqual([d["id"] for d in result.devices], ["breaker_energy"])
        self.assertEqual(
            [c["id"] for c in result.devices[0]["children"]], ["plug_energy"]
        )

    def test_an_owned_meter_only_gains_a_missing_power_sensor(self) -> None:
        devices = [_dishwasher()]

        result = _import(devices, _row("sensor.dishwasher_energy", "sensor.dishwasher_power"))

        self.assertEqual(
            result.devices,
            [
                _dishwasher(
                    consumption={
                        "energy_entity_id": "sensor.dishwasher_energy",
                        "power_entity_id": "sensor.dishwasher_power",
                    }
                )
            ],
        )
        # The input is not modified.
        self.assertEqual(devices, [_dishwasher()])

    def test_a_configured_power_sensor_is_kept(self) -> None:
        device = _dishwasher(
            consumption={
                "energy_entity_id": "sensor.dishwasher_energy",
                "power_entity_id": "sensor.my_power",
            }
        )

        result = _import([device], _row("sensor.dishwasher_energy", "sensor.dishwasher_power"))

        self.assertEqual(result.devices, [device])

    def test_a_row_nested_under_a_passive_device_becomes_its_child(self) -> None:
        breaker = {
            "id": "breaker",
            "consumption": {"energy_entity_id": "sensor.breaker_energy"},
            "children": [{"id": "ac", "kind": "climate", "schedulable": True}],
        }

        result = _import(
            [breaker],
            _row("sensor.plug_energy", "sensor.plug_power", "sensor.breaker_energy"),
        )

        self.assertEqual(
            [c["id"] for c in result.devices[0]["children"]], ["ac", "plug_energy"]
        )

    def test_a_powerless_row_beside_meterless_children_is_a_conflict(self) -> None:
        # The live split needs every metered sibling's power, and the parent's
        # meter already counts the row, so it is reported, not placed.
        breaker = {
            "id": "breaker",
            "consumption": {"energy_entity_id": "sensor.breaker_energy"},
            "children": [{"id": "ac", "kind": "climate", "schedulable": True}],
        }

        result = _import([breaker], _row("sensor.plug_energy", None, "sensor.breaker_energy"))

        self.assertEqual([c["id"] for c in result.devices[0]["children"]], ["ac"])
        self.assertEqual(
            result.conflicts,
            [EnergyImportConflict("sensor.plug_energy", "breaker", "power_required")],
        )

    def test_a_nesting_cycle_leaves_both_rows_at_the_top_level(self) -> None:
        result = _import(
            [],
            _row("sensor.a_energy", None, "sensor.b_energy"),
            _row("sensor.b_energy", None, "sensor.a_energy"),
        )

        self.assertEqual([d["id"] for d in result.devices], ["a_energy", "b_energy"])
        self.assertTrue(all("children" not in d for d in result.devices))
        self.assertEqual(result.conflicts, [])

    def test_a_row_nested_under_a_schedulable_device_is_a_conflict(self) -> None:
        result = _import(
            [_dishwasher()],
            _row("sensor.plug_energy", "sensor.plug_power", "sensor.dishwasher_energy"),
            # Inside the conflicting row, so inside the dishwasher's meter too.
            _row("sensor.inner_energy", None, "sensor.plug_energy"),
        )

        self.assertEqual(result.devices, [_dishwasher()])
        self.assertEqual(
            result.conflicts,
            [
                EnergyImportConflict("sensor.plug_energy", "dishwasher"),
                EnergyImportConflict("sensor.inner_energy", "dishwasher"),
            ],
        )

    def test_existing_devices_are_not_restructured(self) -> None:
        # Energy nests one existing meter in another: both stay where they are.
        breaker = {"id": "breaker", "consumption": {"energy_entity_id": "sensor.breaker_energy"}}
        devices = [breaker, _dishwasher()]

        result = _import(
            devices,
            _row("sensor.breaker_energy"),
            _row("sensor.dishwasher_energy", None, "sensor.breaker_energy"),
        )

        self.assertEqual(result.devices, devices)
        self.assertEqual(result.conflicts, [])

    def test_external_statistics_are_skipped_and_reported(self) -> None:
        result = _import([], _row("tibber:energy_consumption"), _row("sensor.oven_energy"))

        self.assertEqual([d["id"] for d in result.devices], ["oven_energy"])
        self.assertEqual(result.external_statistics, ["tibber:energy_consumption"])

    def test_a_generated_id_never_clashes(self) -> None:
        result = _import(
            [_dishwasher(id="oven_energy", consumption={"energy_entity_id": "sensor.x"})],
            _row("sensor.oven_energy"),
            _row("sensor.inverter"),
        )

        self.assertEqual(
            [d["id"] for d in result.devices], ["oven_energy", "oven_energy_2", "inverter_2"]
        )

    def test_importing_twice_changes_nothing(self) -> None:
        rows = [
            _row("sensor.breaker_energy", "sensor.breaker_power"),
            _row("sensor.plug_energy", "sensor.plug_power", "sensor.breaker_energy"),
            _row("sensor.dishwasher_energy", "sensor.dishwasher_power"),
        ]
        once = _import([_dishwasher()], *rows).devices

        twice = _import(deepcopy(once), *rows).devices

        self.assertEqual(twice, once)

    def test_absent_preferences_import_nothing(self) -> None:
        for preferences in (None, {}, {"device_consumption": None}):
            with self.subTest(preferences=preferences):
                result = import_energy_preferences([_dishwasher()], preferences)
                self.assertEqual(result.devices, [_dishwasher()])


if __name__ == "__main__":
    unittest.main()
