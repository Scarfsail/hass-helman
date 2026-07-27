"""Migration of stored automation configs to the target/params/conditions shape.

Pure ``dict -> dict``, so this module needs no Home Assistant and runs on the
host. The riskiest rule in the whole change lives here — the ``run_when``
inversion, which silently affects every existing ``daily_runtime`` config — so
it is table-driven over all three of its cases.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]


_install_import_stubs()

from custom_components.helman.automation.migration import (  # noqa: E402
    migrate_config_document,
    needs_migration,
)
from custom_components.helman.const import (  # noqa: E402
    CONFIG_DOCUMENT_VERSION,
    DAY_CLASSIFICATIONS,
)

ALL_DAYS = list(DAY_CLASSIFICATIONS)


def _document(*optimizers):
    return {"automation": {"enabled": True, "optimizers": list(optimizers)}}


def _migrate_one(optimizer):
    migrated, _ids = migrate_config_document(_document(optimizer))
    return migrated["automation"]["optimizers"][0]


class VersionGateTests(unittest.TestCase):
    def test_absent_version_is_treated_as_pre_unification(self) -> None:
        self.assertTrue(needs_migration(_document()))

    def test_current_version_needs_no_migration(self) -> None:
        document = {**_document(), "config_version": CONFIG_DOCUMENT_VERSION}
        self.assertFalse(needs_migration(document))

    def test_a_document_without_automation_is_left_alone(self) -> None:
        self.assertFalse(needs_migration({"history_buckets": 60}))

    def test_migration_stamps_the_current_version(self) -> None:
        migrated, _ids = migrate_config_document(_document())
        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)

    def test_migration_does_not_mutate_its_input(self) -> None:
        document = _document(
            {"id": "e", "kind": "export_price", "params": {"when_price_below": -0.1}}
        )
        migrate_config_document(document)
        self.assertEqual(
            document["automation"]["optimizers"][0]["params"],
            {"when_price_below": -0.1},
        )

    def test_optimizer_order_is_preserved_verbatim(self) -> None:
        migrated, ids = migrate_config_document(
            _document(
                {"id": "hold", "kind": "charge_hold"},
                {"id": "export", "kind": "export_price"},
            )
        )
        self.assertEqual(
            [o["id"] for o in migrated["automation"]["optimizers"]], ["hold", "export"]
        )
        self.assertEqual(ids, ["hold", "export"])


class CustomConditionTests(unittest.TestCase):
    def test_top_level_condition_becomes_the_first_groups_custom(self) -> None:
        condition = [{"condition": "state", "entity_id": "binary_sensor.home"}]
        migrated = _migrate_one(
            {"id": "e", "kind": "export_price", "condition": condition}
        )
        self.assertNotIn("condition", migrated)
        self.assertEqual(migrated["conditions"][0]["custom"], condition)

    def test_absent_condition_becomes_an_empty_custom_list(self) -> None:
        migrated = _migrate_one({"id": "e", "kind": "export_price"})
        self.assertEqual(migrated["conditions"][0]["custom"], [])


class PerKindMoveTests(unittest.TestCase):
    def test_export_price_threshold_moves_and_action_is_dropped(self) -> None:
        migrated = _migrate_one(
            {
                "id": "e",
                "kind": "export_price",
                "params": {"when_price_below": -0.05, "action": "stop_export"},
            }
        )
        self.assertEqual(migrated["params"], {})
        self.assertEqual(migrated["conditions"][0]["when_price_below"], -0.05)

    def test_charge_hold_only_on_days_becomes_run_when(self) -> None:
        migrated = _migrate_one(
            {
                "id": "h",
                "kind": "charge_hold",
                "params": {
                    "only_on_days": ["surplus"],
                    "hold_action": "stop_charging",
                    "window": {"start": "06:00", "end": "12:00"},
                },
            }
        )
        self.assertEqual(migrated["conditions"][0]["run_when"], ["surplus"])
        self.assertNotIn("hold_action", migrated["params"])
        self.assertEqual(migrated["params"]["window"], {"start": "06:00", "end": "12:00"})

    def test_charge_hold_drops_the_release_key_no_reader_ever_read(self) -> None:
        # The old editor draft wrote `release: day_price_min`; nothing read it —
        # the release slot is computed per day. Left in place it would fail the
        # new reader's unknown-key check on the first restart after upgrading.
        migrated = _migrate_one(
            {
                "id": "h",
                "kind": "charge_hold",
                "params": {"release": "day_price_min", "only_on_days": ["surplus"]},
            }
        )
        self.assertNotIn("release", migrated["params"])

    def test_charge_hold_without_only_on_days_runs_on_every_classification(self) -> None:
        migrated = _migrate_one({"id": "h", "kind": "charge_hold"})
        self.assertEqual(migrated["conditions"][0]["run_when"], ALL_DAYS)

    def test_surplus_appliance_target_and_condition_split(self) -> None:
        migrated = _migrate_one(
            {
                "id": "s",
                "kind": "surplus_appliance",
                "params": {
                    "appliance_id": "dhw",
                    "climate_mode": "heat",
                    "action": "on",
                    "min_surplus_buffer_pct": 15,
                },
            }
        )
        self.assertEqual(migrated["target"], {"appliance_id": "dhw", "climate_mode": "heat"})
        self.assertEqual(migrated["params"], {})
        self.assertEqual(migrated["conditions"][0]["min_surplus_buffer_pct"], 15)

    def test_charge_from_grid_floor_becomes_a_condition(self) -> None:
        migrated = _migrate_one(
            {
                "id": "g",
                "kind": "charge_from_grid",
                "params": {"reserve_floor_soc": 20, "margin_pct": 10},
            }
        )
        self.assertEqual(migrated["params"], {"margin_pct": 10})
        self.assertEqual(migrated["conditions"][0]["reserve_floor_soc"], 20)

    def test_daily_runtime_appliance_moves_to_target(self) -> None:
        migrated = _migrate_one(
            {
                "id": "d",
                "kind": "daily_runtime",
                "params": {"appliance_id": "dhw", "min_hours_per_day": 3},
            }
        )
        self.assertEqual(migrated["target"], {"appliance_id": "dhw"})
        self.assertEqual(
            migrated["params"]["daily_minimum"]["min_hours_per_day"], 3
        )


class RunWhenInversionTests(unittest.TestCase):
    """``skip.on_days`` -> ``run_when`` is not a plain complement.

    A day was skipped only when its classification was listed **and** the
    consecutive-skip guard still allowed it. With the default
    ``max_consecutive_skips == 0`` the guard never allowed it, so skipping never
    happened and the complement would silently stop the optimizer running on
    days it has always run on.
    """

    def _run_when(self, skip):
        params = {"appliance_id": "dhw", "min_hours_per_day": 3}
        if skip is not None:
            params["skip"] = skip
        migrated = _migrate_one(
            {"id": "d", "kind": "daily_runtime", "params": params}
        )
        return (
            migrated["conditions"][0]["run_when"],
            migrated["params"]["daily_minimum"]["max_consecutive_skips"],
        )

    def test_skip_absent_runs_on_every_classification(self) -> None:
        self.assertEqual(self._run_when(None), (ALL_DAYS, 0))

    def test_empty_on_days_runs_on_every_classification(self) -> None:
        self.assertEqual(
            self._run_when({"on_days": [], "max_consecutive_skips": 2}), (ALL_DAYS, 2)
        )

    def test_zero_max_consecutive_skips_runs_on_every_classification(self) -> None:
        # The default, and therefore most existing configs: skipping never
        # actually happened, so the complement would change behaviour.
        self.assertEqual(
            self._run_when({"on_days": ["deficit"], "max_consecutive_skips": 0}),
            (ALL_DAYS, 0),
        )

    def test_missing_max_consecutive_skips_defaults_to_zero(self) -> None:
        self.assertEqual(self._run_when({"on_days": ["deficit"]}), (ALL_DAYS, 0))

    def test_a_real_skip_policy_inverts_to_the_complement(self) -> None:
        self.assertEqual(
            self._run_when({"on_days": ["deficit"], "max_consecutive_skips": 2}),
            (["surplus", "tight"], 2),
        )

    def test_skipping_every_classification_inverts_to_an_empty_run_when(self) -> None:
        # Coherent: the optimizer never runs on its own, only when the
        # consecutive-skip guard forces it — exactly the old behaviour.
        self.assertEqual(
            self._run_when({"on_days": ALL_DAYS, "max_consecutive_skips": 2}), ([], 2)
        )

    def test_max_consecutive_skips_is_lifted_out_of_the_skip_block(self) -> None:
        migrated = _migrate_one(
            {
                "id": "d",
                "kind": "daily_runtime",
                "params": {
                    "appliance_id": "dhw",
                    "skip": {"on_days": ["deficit"], "max_consecutive_skips": 2},
                },
            }
        )
        self.assertNotIn("skip", migrated["params"])
        self.assertEqual(
            migrated["params"]["daily_minimum"]["max_consecutive_skips"], 2
        )


if __name__ == "__main__":
    unittest.main()
