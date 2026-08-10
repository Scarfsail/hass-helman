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

    def test_a_document_without_automation_still_migrates(self) -> None:
        # v5->v6 moves a solar key, so the gate is a plain version check: an
        # automation-less document has to be migrated too.
        self.assertTrue(needs_migration({"history_buckets": 60}))

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

    def test_surplus_appliance_becomes_an_uncapped_appliance_runtime(self) -> None:
        migrated = _migrate_one(
            {
                "id": "s",
                "kind": "surplus_appliance",
                "enabled": False,
                "params": {
                    "appliance_id": "dhw",
                    "climate_mode": "heat",
                    "action": "on",
                    "min_surplus_buffer_pct": 15,
                },
            }
        )

        self.assertEqual(migrated["kind"], "appliance_runtime")
        # A disabled rule stays disabled, and its target survives verbatim.
        self.assertFalse(migrated["enabled"])
        self.assertEqual(
            migrated["target"], {"appliance_id": "dhw", "climate_mode": "heat"}
        )
        # No `daily_minimum` — uncapped, which is what the old kind did.
        self.assertEqual(migrated["params"], {})

    def test_the_retired_buffer_becomes_run_when_surplus(self) -> None:
        """Removing the buffer cannot leave the group narrowing nothing.

        An uncapped group that narrows nothing means "on for the whole horizon",
        which the reader rejects, so the migrated group needs *something*.
        `run_when: [surplus]` is the closest honest reading of the old kind and
        invents no threshold.
        """
        migrated = _migrate_one(
            {
                "id": "s",
                "kind": "surplus_appliance",
                "params": {"appliance_id": "dhw", "min_surplus_buffer_pct": 15},
            }
        )

        group = migrated["conditions"][0]
        self.assertNotIn("min_surplus_buffer_pct", group)
        self.assertEqual(group["run_when"], ["surplus"])

    def test_custom_conditions_survive_the_surplus_translation(self) -> None:
        condition = [{"condition": "state", "entity_id": "input_boolean.x"}]
        migrated = _migrate_one(
            {
                "id": "s",
                "kind": "surplus_appliance",
                "params": {"appliance_id": "dhw"},
                "condition": condition,
            }
        )

        self.assertEqual(migrated["conditions"][0]["custom"], condition)

    def test_daily_runtime_becomes_appliance_runtime(self) -> None:
        migrated = _migrate_one(
            {
                "id": "d",
                "kind": "daily_runtime",
                "params": {"appliance_id": "dhw", "min_hours_per_day": 3},
            }
        )

        self.assertEqual(migrated["kind"], "appliance_runtime")
        self.assertEqual(
            migrated["params"]["daily_minimum"],
            {"min_hours_per_day": 3, "max_consecutive_skips": 0},
        )

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


class PriceConditionSplitTests(unittest.TestCase):
    """v4->v5: ``appliance_runtime``'s ``when_price_below`` -> ``max_run_price``.

    Issue #5 — the two kinds sharing ``when_price_below`` needed opposite
    aggregation over a slot's forecast buckets, so ``appliance_runtime`` gets
    its own key. ``export_price`` is untouched: its usage stays correct as-is.

    Unlike the other per-kind moves, ``appliance_runtime``'s price condition
    only exists in the *already-unified* (v4) shape — pre-unification there
    was no such condition for the retired ``daily_runtime``/``surplus_appliance``
    kinds to carry. So these start from a v4 document instead of v1, to isolate
    the v4->v5 step rather than replaying the whole chain.
    """

    @staticmethod
    def _migrate_from_v4(*optimizers):
        document = {**_document(*optimizers), "config_version": 4}
        migrated, _ids = migrate_config_document(document)
        return migrated["automation"]["optimizers"][0]

    def test_appliance_runtime_price_condition_is_renamed(self) -> None:
        migrated = self._migrate_from_v4(
            {
                "id": "runtime",
                "kind": "appliance_runtime",
                "target": {"appliance_id": "dhw"},
                "conditions": [{"run_when": ALL_DAYS, "when_price_below": 2.0}],
            }
        )

        group = migrated["conditions"][0]
        self.assertNotIn("when_price_below", group)
        self.assertEqual(group["max_run_price"], 2.0)

    def test_export_price_is_left_alone(self) -> None:
        migrated = self._migrate_from_v4(
            {
                "id": "export",
                "kind": "export_price",
                "conditions": [{"when_price_below": 1.0}],
            }
        )

        self.assertEqual(migrated["conditions"][0]["when_price_below"], 1.0)

    def test_a_group_without_the_price_condition_is_untouched(self) -> None:
        migrated = self._migrate_from_v4(
            {
                "id": "runtime",
                "kind": "appliance_runtime",
                "target": {"appliance_id": "dhw"},
                "conditions": [{"run_when": ALL_DAYS}],
            }
        )

        self.assertEqual(migrated["conditions"][0], {"run_when": ALL_DAYS})

    def test_migrating_to_the_current_version_covers_this_step(self) -> None:
        migrated, _ids = migrate_config_document(_document())
        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)
        self.assertGreaterEqual(CONFIG_DOCUMENT_VERSION, 5)


class TrainingTimePromotionTests(unittest.TestCase):
    """v5->v6: solar bias ``training_time`` -> top-level ``training_time``.

    The nightly training batch is more than bias training, so the schedule
    stops living under ``bias_correction``. First step that moves a key
    outside the automation block, which is why the version gate had to stop
    requiring one.
    """

    @staticmethod
    def _migrate_from_v5(document):
        migrated, ids = migrate_config_document({**document, "config_version": 5})
        return migrated, ids

    @staticmethod
    def _bias_document(**bias):
        return {
            "power_devices": {
                "solar": {"forecast": {"bias_correction": {"enabled": True, **bias}}}
            }
        }

    def test_training_time_moves_to_the_top_level(self) -> None:
        migrated, ids = self._migrate_from_v5(self._bias_document(training_time="04:30"))

        bias = migrated["power_devices"]["solar"]["forecast"]["bias_correction"]
        self.assertNotIn("training_time", bias)
        self.assertEqual(migrated["training_time"], "04:30")
        self.assertEqual(bias["enabled"], True)
        self.assertEqual(ids, [])

    def test_an_existing_top_level_value_wins(self) -> None:
        document = self._bias_document(training_time="04:30")
        document["training_time"] = "02:15"

        migrated, _ids = self._migrate_from_v5(document)

        self.assertEqual(migrated["training_time"], "02:15")
        self.assertNotIn(
            "training_time",
            migrated["power_devices"]["solar"]["forecast"]["bias_correction"],
        )

    def test_a_document_without_the_bias_key_is_untouched(self) -> None:
        migrated, _ids = self._migrate_from_v5(self._bias_document())

        self.assertNotIn("training_time", migrated)

    def test_a_v5_document_without_automation_is_migrated_and_stamped(self) -> None:
        document = self._bias_document(training_time="04:30")
        document["config_version"] = 5
        self.assertTrue(needs_migration(document))

        migrated, _ids = migrate_config_document(document)

        self.assertNotIn("automation", migrated)
        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)
        self.assertEqual(migrated["training_time"], "04:30")

    def test_a_v1_document_carries_the_key_through_every_step(self) -> None:
        document = {
            **_document({"id": "e", "kind": "export_price"}),
            **self._bias_document(training_time="04:30"),
        }

        migrated, ids = migrate_config_document(document)

        self.assertEqual(migrated["training_time"], "04:30")
        # The optimizer ids from the v1 step survive a later step that moves none.
        self.assertEqual(ids, ["e"])


class ControllablesUnificationTests(unittest.TestCase):
    """v6->v7: ``appliances`` + ``scheduler.control`` -> ``controllables``.

    The step every existing installation runs, and the only one that reshapes
    what the user sees in the editor. Table-driven over the four shapes a v6
    document can actually have — both keys, one, the other, neither — because
    the runtime that reads the result treats an absent list and an empty one
    differently.
    """

    _CONTROL = {
        "mode_entity_id": "select.fv_mode",
        "action_option_map": {
            "normal": "Self Use",
            "stop_charging": "Manual",
            "stop_discharging": "Manual",
        },
    }
    _APPLIANCE = {
        "kind": "generic",
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {"switch": {"entity_id": "switch.dishwasher"}},
        "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.2},
    }

    @classmethod
    def _migrate_from_v6(cls, document):
        migrated, ids = migrate_config_document({**document, "config_version": 6})
        return migrated, ids

    def test_the_inverter_becomes_the_first_controllable(self) -> None:
        migrated, ids = self._migrate_from_v6(
            {"scheduler": {"control": self._CONTROL}, "appliances": [self._APPLIANCE]}
        )

        self.assertNotIn("scheduler", migrated)
        self.assertNotIn("appliances", migrated)
        self.assertEqual(
            migrated["controllables"],
            [
                {
                    "kind": "inverter",
                    "id": "inverter",
                    "name": "Inverter",
                    "controls": {
                        "mode": {
                            "entity_id": "select.fv_mode",
                            "options": {
                                "normal": "Self Use",
                                "stop_charging": "Manual",
                                "stop_discharging": "Manual",
                            },
                        }
                    },
                },
                self._APPLIANCE,
            ],
        )
        self.assertEqual(ids, [])

    def test_appliance_entries_move_verbatim_and_keep_their_order(self) -> None:
        second = {**self._APPLIANCE, "id": "boiler", "name": "Boiler"}

        migrated, _ids = self._migrate_from_v6(
            {"appliances": [self._APPLIANCE, second]}
        )

        self.assertEqual(migrated["controllables"], [self._APPLIANCE, second])

    def test_an_installation_without_a_wired_inverter_gets_no_entry(self) -> None:
        migrated, _ids = self._migrate_from_v6({"scheduler": {}, "appliances": []})

        self.assertEqual(migrated["controllables"], [])

    def test_a_document_with_neither_key_grows_no_controllables(self) -> None:
        migrated, _ids = self._migrate_from_v6({"history_buckets": 60})

        self.assertNotIn("controllables", migrated)

    def test_unknown_control_keys_ride_along_on_the_inverter_entry(self) -> None:
        migrated, _ids = self._migrate_from_v6(
            {"scheduler": {"control": {**self._CONTROL, "future_key": "keep-me"}}}
        )

        self.assertEqual(migrated["controllables"][0]["future_key"], "keep-me")

    def test_an_appliances_value_that_is_not_a_list_is_moved_not_dropped(self) -> None:
        migrated, _ids = self._migrate_from_v6({"appliances": {"oops": True}})

        self.assertEqual(migrated["controllables"], {"oops": True})
        self.assertNotIn("appliances", migrated)

    def test_a_v1_document_reaches_the_new_shape_through_every_step(self) -> None:
        document = {
            **_document({"id": "e", "kind": "export_price"}),
            "scheduler": {"control": self._CONTROL},
            "appliances": [self._APPLIANCE],
        }

        migrated, ids = migrate_config_document(document)

        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)
        self.assertEqual(
            [entry["kind"] for entry in migrated["controllables"]],
            ["inverter", "generic"],
        )
        self.assertEqual(ids, ["e"])

    def test_a_v7_document_is_left_exactly_as_it_is(self) -> None:
        document = {
            "config_version": CONFIG_DOCUMENT_VERSION,
            "controllables": [self._APPLIANCE],
        }
        self.assertFalse(needs_migration(document))

        migrated, ids = migrate_config_document(document)

        self.assertEqual(migrated, document)
        self.assertEqual(ids, [])


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
