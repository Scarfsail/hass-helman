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
            migrated["target"], {"controllable_id": "dhw", "climate_mode": "heat"}
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
        self.assertEqual(migrated["target"], {"controllable_id": "dhw"})
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
                "target": {"controllable_id": "dhw"},
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
                "target": {"controllable_id": "dhw"},
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
    #: What ``_APPLIANCE`` looks like once the chain has also run v8 -> v9,
    #: which moves ``projection`` under ``consumption``. These tests migrate all
    #: the way to the current version, so the v6 -> v7 assertions have to expect
    #: the later step's output too.
    _APPLIANCE_V9 = {
        "kind": "generic",
        "id": "dishwasher",
        "name": "Dishwasher",
        "controls": {"switch": {"entity_id": "switch.dishwasher"}},
        "consumption": {
            "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.2},
        },
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
                self._APPLIANCE_V9,
            ],
        )
        self.assertEqual(ids, [])

    def test_appliance_entries_move_across_and_keep_their_order(self) -> None:
        second = {**self._APPLIANCE, "id": "boiler", "name": "Boiler"}
        second_v9 = {**self._APPLIANCE_V9, "id": "boiler", "name": "Boiler"}

        migrated, _ids = self._migrate_from_v6(
            {"appliances": [self._APPLIANCE, second]}
        )

        self.assertEqual(migrated["controllables"], [self._APPLIANCE_V9, second_v9])

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

    def test_a_current_version_document_is_left_exactly_as_it_is(self) -> None:
        document = {
            "config_version": CONFIG_DOCUMENT_VERSION,
            "controllables": [self._APPLIANCE],
        }
        self.assertFalse(needs_migration(document))

        migrated, ids = migrate_config_document(document)

        self.assertEqual(migrated, document)
        self.assertEqual(ids, [])


class ControllableTargetTests(unittest.TestCase):
    """v7->v8: every optimizer names its target by controllable id.

    Table-driven over the two shapes that exist: a kind that had the field
    under its old name, and the three that had no target at all because their
    own ``kind`` was the target.
    """

    @staticmethod
    def _migrate_from_v7(*optimizers):
        migrated, ids = migrate_config_document(
            {**_document(*optimizers), "config_version": 7}
        )
        return migrated["automation"]["optimizers"], ids

    def test_appliance_id_becomes_controllable_id(self) -> None:
        (optimizer,), ids = self._migrate_from_v7(
            {
                "id": "dhw",
                "kind": "appliance_runtime",
                "target": {"appliance_id": "boiler", "climate_mode": "heat"},
                "params": {"window": {"start": "08:00", "end": "18:00"}},
                "conditions": [{"run_when": ["surplus"]}],
            }
        )

        # `climate_mode` stays put: it is the second target field, not a name
        # the unification touched.
        self.assertEqual(
            optimizer["target"], {"controllable_id": "boiler", "climate_mode": "heat"}
        )
        self.assertEqual(ids, ["dhw"])

    def test_the_inverter_kinds_get_the_reserved_id_written_out(self) -> None:
        for kind in ("charge_hold", "export_price", "charge_from_grid"):
            with self.subTest(kind):
                (optimizer,), _ids = self._migrate_from_v7(
                    {"id": kind, "kind": kind, "conditions": [{}]}
                )

                self.assertEqual(optimizer["target"], {"controllable_id": "inverter"})

    def test_an_authored_controllable_id_wins(self) -> None:
        """Half-migrated by hand is still the user's word on the subject."""
        (optimizer,), _ids = self._migrate_from_v7(
            {
                "id": "dhw",
                "kind": "appliance_runtime",
                "target": {"appliance_id": "boiler", "controllable_id": "pool"},
            }
        )

        self.assertEqual(optimizer["target"], {"controllable_id": "pool"})

    def test_an_unknown_kind_is_left_targetless(self) -> None:
        """No target invented for a kind this step never knew about."""
        (optimizer,), _ids = self._migrate_from_v7({"id": "x", "kind": "mystery"})

        self.assertNotIn("target", optimizer)

    def test_a_v1_appliance_target_survives_every_step_into_the_new_name(self) -> None:
        """Composition: v2 moved it out of ``params``, v8 renames what it wrote."""
        migrated, _ids = migrate_config_document(
            _document(
                {
                    "id": "dhw",
                    "kind": "daily_runtime",
                    "params": {"appliance_id": "boiler", "min_hours_per_day": 3},
                }
            )
        )

        self.assertEqual(
            migrated["automation"]["optimizers"][0]["target"],
            {"controllable_id": "boiler"},
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


class ConsumptionBlockTests(unittest.TestCase):
    """v8->v9: ``projection`` moves under ``consumption``, meter lifted out.

    Table-driven over the shapes a stored entry can have: a history strategy
    carrying a meter, a fixed strategy carrying none, an entry with no
    projection at all, and the two shapes that must be left alone.
    """

    @staticmethod
    def _migrate_from_v8(*controllables):
        migrated, _ids = migrate_config_document(
            {"controllables": list(controllables), "config_version": 8}
        )
        return migrated["controllables"]

    def test_the_meter_comes_up_and_lookback_flattens(self) -> None:
        (entry,) = self._migrate_from_v8(
            {
                "kind": "generic",
                "id": "pool-pump",
                "controls": {"switch": {"entity_id": "switch.pool_pump"}},
                "projection": {
                    "strategy": "history_average",
                    "hourly_energy_kwh": 1.2,
                    "history_average": {
                        "energy_entity_id": "sensor.pool_pump_energy_total",
                        "lookback_days": 21,
                    },
                },
            }
        )

        self.assertNotIn("projection", entry)
        consumption = dict(entry["consumption"])
        # Written by the *next* step, which opts a meter that was never a
        # deferrable consumer out of the split. Not this step's business.
        consumption.pop("deferrable", None)
        self.assertEqual(
            consumption,
            {
                "energy_entity_id": "sensor.pool_pump_energy_total",
                "projection": {
                    "strategy": "history_average",
                    "hourly_energy_kwh": 1.2,
                    "lookback_days": 21,
                },
            },
        )

    def test_a_fixed_strategy_moves_across_without_gaining_a_meter(self) -> None:
        (entry,) = self._migrate_from_v8(
            {
                "kind": "generic",
                "id": "dishwasher",
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.9},
            }
        )

        self.assertEqual(
            entry["consumption"],
            {"projection": {"strategy": "fixed", "hourly_energy_kwh": 0.9}},
        )

    def test_an_entry_without_a_projection_is_left_alone(self) -> None:
        # The inverter's case, and the EV charger's. Neither may grow a
        # consumption block here — version 10 is what gives the charger one.
        entries = self._migrate_from_v8(
            {"kind": "inverter", "id": "inverter", "controls": {"mode": {}}},
            {"kind": "ev_charger", "id": "ev", "controls": {"charge": {}}},
        )

        for entry in entries:
            self.assertNotIn("consumption", entry)

    def test_an_entry_already_carrying_consumption_keeps_its_own_shape(self) -> None:
        # v8->v9 leaves a hand-written consumption block untouched. v9->v10 then
        # writes `deferrable: false` on it, because a meter absent from the old
        # deferrable list was never part of the baseline split — see
        # DeferrableConsumerDerivationTests.
        already = {
            "kind": "generic",
            "id": "dishwasher",
            "consumption": {
                "energy_entity_id": "sensor.dishwasher_energy_total",
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.9},
            },
        }

        (entry,) = self._migrate_from_v8(already)

        self.assertEqual(entry["consumption"]["projection"], already["consumption"]["projection"])
        self.assertEqual(
            entry["consumption"]["energy_entity_id"],
            "sensor.dishwasher_energy_total",
        )

    def test_a_projection_of_the_wrong_type_still_moves(self) -> None:
        # The information survives; the reader reports the type error in the
        # new vocabulary rather than the value vanishing on upgrade.
        (entry,) = self._migrate_from_v8(
            {"kind": "generic", "id": "dishwasher", "projection": "nonsense"}
        )

        self.assertEqual(entry["consumption"], {"projection": "nonsense"})

    def test_a_history_average_holding_only_a_meter_leaves_no_empty_block(self) -> None:
        (entry,) = self._migrate_from_v8(
            {
                "kind": "climate",
                "id": "hvac",
                "projection": {
                    "strategy": "history_average",
                    "hourly_energy_kwh": 1.5,
                    "history_average": {"energy_entity_id": "sensor.hvac_energy"},
                },
            }
        )

        self.assertNotIn("history_average", entry["consumption"]["projection"])
        self.assertNotIn("lookback_days", entry["consumption"]["projection"])
        self.assertEqual(
            entry["consumption"]["energy_entity_id"], "sensor.hvac_energy"
        )


class DeferrableConsumerDerivationTests(unittest.TestCase):
    """v9->v10: ``deferrable_consumers`` is derived from ``controllables``.

    The rule under test is the *baseline-preserving* one: the new default is
    "a metered controllable is deferrable", but that was not true of any
    existing config, so the step writes the old truth out explicitly rather
    than letting the default rewrite every forecast on upgrade.
    """

    @staticmethod
    def _migrate_from_v9(controllables, *listed):
        document = {
            "config_version": 9,
            "controllables": list(controllables),
            "power_devices": {
                "house": {
                    "forecast": {
                        "total_energy_entity_id": "sensor.house_total",
                        "deferrable_consumers": list(listed),
                    }
                }
            },
        }
        migrated, _ids = migrate_config_document(document)
        return (
            migrated["controllables"],
            migrated["power_devices"]["house"]["forecast"],
        )

    @staticmethod
    def _metered(controllable_id, meter, name=None):
        return {
            "kind": "generic",
            "id": controllable_id,
            "name": name or controllable_id.title(),
            "consumption": {
                "energy_entity_id": meter,
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.0},
            },
        }

    def test_a_listed_meter_keeps_the_new_default(self) -> None:
        entries, forecast = self._migrate_from_v9(
            [self._metered("pool", "sensor.pool_energy")],
            {"energy_entity_id": "sensor.pool_energy", "label": "Pool"},
        )

        self.assertNotIn("deferrable", entries[0]["consumption"])
        self.assertNotIn("deferrable_consumers", forecast)

    def test_a_meter_that_was_never_listed_is_opted_out_explicitly(self) -> None:
        # v9 lifted this meter out of `history_average`: the device was metered
        # to project itself and was never part of the baseline split. Letting
        # the new default claim it would move every forecast.
        (entry,), _forecast = self._migrate_from_v9(
            [self._metered("rack", "sensor.rack_energy")]
        )

        self.assertIs(entry["consumption"]["deferrable"], False)

    def test_a_listed_device_with_no_meter_gains_one_by_its_name(self) -> None:
        # The EV charger's case: it has no projection, so v9 gave it no
        # consumption block, and the old list is the only place its meter was
        # ever written down. The label is the link.
        (entry,), _forecast = self._migrate_from_v9(
            [
                {
                    "kind": "ev_charger",
                    "id": "ev",
                    "name": "EV Charging",
                    "controls": {"charge": {"entity_id": "switch.ev"}},
                }
            ],
            {
                "energy_entity_id": "sensor.ev_charging_energy_total",
                "label": "EV Charging",
            },
        )

        self.assertEqual(
            entry["consumption"],
            {"energy_entity_id": "sensor.ev_charging_energy_total"},
        )

    def test_an_entry_matching_nothing_is_dropped(self) -> None:
        entries, forecast = self._migrate_from_v9(
            [self._metered("pool", "sensor.pool_energy")],
            {"energy_entity_id": "sensor.pool_energy", "label": "Pool"},
            {"energy_entity_id": "sensor.submeter_only", "label": "Something else"},
        )

        self.assertEqual(len(entries), 1)
        self.assertNotIn("deferrable_consumers", forecast)

    def test_the_inverter_is_never_touched(self) -> None:
        (entry,), _forecast = self._migrate_from_v9(
            [{"kind": "inverter", "id": "inverter", "name": "Inverter"}]
        )

        self.assertNotIn("consumption", entry)

    def test_an_unmetered_controllable_is_left_alone(self) -> None:
        untouched = {
            "kind": "generic",
            "id": "rail",
            "name": "Towel rail",
            "consumption": {
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.3}
            },
        }

        (entry,), _forecast = self._migrate_from_v9([untouched])

        self.assertEqual(entry, untouched)

    def test_a_document_with_no_old_key_still_opts_metered_devices_out(self) -> None:
        migrated, _ids = migrate_config_document(
            {
                "config_version": 9,
                "controllables": [self._metered("pool", "sensor.pool_energy")],
            }
        )

        self.assertIs(
            migrated["controllables"][0]["consumption"]["deferrable"], False
        )


class SelfSustainabilityUnificationTests(unittest.TestCase):
    """v10->v11: the level becomes a budget, and the margin joins the group.

    ``soft``/``strict`` were never two points on one scale — ``soft`` tested the
    SoC floor, ``strict`` added a per-day balance test — so they collapse onto a
    budget whose ends reproduce them: ``strict`` is that budget at ``0``,
    ``soft`` is it switched off at ``100``.
    """

    @staticmethod
    def _migrate_from_v10(optimizer):
        document = {**_document(optimizer), "config_version": 10}
        migrated, ids = migrate_config_document(document)
        return migrated["automation"]["optimizers"][0], ids

    @staticmethod
    def _runtime(*, params=None, conditions):
        optimizer = {
            "id": "runtime",
            "kind": "appliance_runtime",
            "target": {"controllable_id": "pool"},
            "conditions": conditions,
        }
        if params is not None:
            optimizer["params"] = params
        return optimizer

    def test_strict_becomes_a_zero_budget(self) -> None:
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                conditions=[
                    {"run_when": ALL_DAYS, "ensure_self_sustainability": "strict"}
                ]
            )
        )

        self.assertEqual(
            migrated["conditions"][0]["ensure_self_sustainability"], 0
        )

    def test_soft_becomes_an_unbounded_budget(self) -> None:
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                conditions=[
                    {"run_when": ALL_DAYS, "ensure_self_sustainability": "soft"}
                ]
            )
        )

        self.assertEqual(
            migrated["conditions"][0]["ensure_self_sustainability"], 100
        )

    def test_the_master_margin_lands_on_every_group(self) -> None:
        """Including the group with no budget — deliberately, unlike the default.

        A named master margin *was* what every group resolved, so dropping it
        from the ones without a budget would mean a group that gains one later
        silently runs on `5` instead of the 12 the config has said all along.
        Contrast `test_a_group_that_never_used_the_feature_gets_no_margin_written`:
        there is no such meaning to preserve in a value nobody typed.
        """
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                params={"self_sustainability": {"margin_pct": 12}},
                conditions=[
                    {"run_when": ALL_DAYS, "ensure_self_sustainability": "soft"},
                    {"run_when": ["tight"]},
                ],
            )
        )

        self.assertEqual(
            [
                group["self_sustainability_margin_pct"]
                for group in migrated["conditions"]
            ],
            [12, 12],
        )
        self.assertNotIn("self_sustainability", migrated["params"])

    def test_a_group_override_beats_the_master(self) -> None:
        """The override resolved first as a param; it must still resolve first."""
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                params={"self_sustainability": {"margin_pct": 12}},
                conditions=[
                    {
                        "run_when": ALL_DAYS,
                        "ensure_self_sustainability": "strict",
                        "params": {"self_sustainability": {"margin_pct": 20}},
                    }
                ],
            )
        )

        group = migrated["conditions"][0]
        self.assertEqual(group["self_sustainability_margin_pct"], 20)
        # The override held nothing else, so it goes rather than lingering as an
        # empty object the editor would render as "this group overrides params".
        self.assertNotIn("params", group)

    def test_an_override_keeping_other_params_survives(self) -> None:
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                conditions=[
                    {
                        "run_when": ALL_DAYS,
                        "ensure_self_sustainability": "soft",
                        "params": {
                            "self_sustainability": {"margin_pct": 20},
                            "window": {"start": "09:00", "end": "17:00"},
                        },
                    }
                ],
            )
        )

        group = migrated["conditions"][0]
        self.assertEqual(group["self_sustainability_margin_pct"], 20)
        self.assertEqual(
            group["params"], {"window": {"start": "09:00", "end": "17:00"}}
        )

    def test_a_user_of_the_feature_without_a_margin_gets_the_old_default(self) -> None:
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                conditions=[
                    {"run_when": ALL_DAYS, "ensure_self_sustainability": "strict"}
                ]
            )
        )

        self.assertEqual(
            migrated["conditions"][0]["self_sustainability_margin_pct"], 5
        )

    def test_a_group_that_never_used_the_feature_gets_no_margin_written(self) -> None:
        """The condition field's default covers it; writing 5 would be noise."""
        migrated, _ids = self._migrate_from_v10(
            self._runtime(conditions=[{"run_when": ALL_DAYS}])
        )

        self.assertEqual(migrated["conditions"][0], {"run_when": ALL_DAYS})

    def test_a_malformed_conditions_key_is_left_for_the_reader(self) -> None:
        """Not replaced with `[]`, which would launder it into "no groups".

        There is nothing to move the margin onto either way, and such a document
        is rejected on load regardless — an optimizer must list at least one
        condition group — so the honest move is to leave it exactly as found.
        """
        broken = self._runtime(
            params={"self_sustainability": {"margin_pct": 12}},
            conditions="junk",
        )
        migrated, _ids = self._migrate_from_v10(broken)

        self.assertEqual(migrated["conditions"], "junk")
        self.assertEqual(
            migrated["params"], {"self_sustainability": {"margin_pct": 12}}
        )

    def test_a_group_that_is_not_a_mapping_is_passed_through(self) -> None:
        migrated, _ids = self._migrate_from_v10(
            self._runtime(
                conditions=["junk", {"ensure_self_sustainability": "strict"}]
            )
        )

        self.assertEqual(migrated["conditions"][0], "junk")
        self.assertEqual(
            migrated["conditions"][1]["ensure_self_sustainability"], 0
        )

    def test_other_kinds_are_untouched(self) -> None:
        migrated, _ids = self._migrate_from_v10(
            {
                "id": "grid",
                "kind": "charge_from_grid",
                "params": {"margin_pct": 10},
                "conditions": [{"reserve_floor_soc": 30}],
            }
        )

        self.assertEqual(migrated["params"], {"margin_pct": 10})
        self.assertEqual(migrated["conditions"][0], {"reserve_floor_soc": 30})

    def test_migrating_to_the_current_version_covers_this_step(self) -> None:
        migrated, _ids = migrate_config_document(_document())
        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)
        self.assertGreaterEqual(CONFIG_DOCUMENT_VERSION, 11)


class ExportEnabledEntityRetirementTests(unittest.TestCase):
    """v11 -> v12: curtailment is inferred, so the boolean entity key goes."""

    @staticmethod
    def _migrate_from_v11(slot_invalidation):
        document = {
            **_document(),
            "config_version": 11,
            "power_devices": {
                "solar": {
                    "forecast": {
                        "bias_correction": {
                            "min_history_days": 10,
                            "slot_invalidation": slot_invalidation,
                        }
                    }
                }
            },
        }
        migrated, _ids = migrate_config_document(document)
        return migrated["power_devices"]["solar"]["forecast"]["bias_correction"]

    def test_the_retired_key_is_dropped(self) -> None:
        bias = self._migrate_from_v11(
            {
                "max_battery_soc_percent": 97,
                "export_enabled_entity_id": "switch.solax_export_enabled",
            }
        )

        self.assertEqual(bias["slot_invalidation"], {"max_battery_soc_percent": 97})

    def test_the_rest_of_the_block_is_left_alone(self) -> None:
        bias = self._migrate_from_v11(
            {
                "max_battery_soc_percent": 97,
                "data_glitch_backfill_max_minutes": 90,
            }
        )

        self.assertEqual(
            bias["slot_invalidation"],
            {"max_battery_soc_percent": 97, "data_glitch_backfill_max_minutes": 90},
        )
        self.assertEqual(bias["min_history_days"], 10)

    def test_a_document_without_the_block_survives(self) -> None:
        migrated, _ids = migrate_config_document(
            {**_document(), "config_version": 11}
        )

        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)


class SolarRemainingTodayForecastRetirementTests(unittest.TestCase):
    """v12 -> v13: the "remaining today" entity is Helman's own, so the key goes."""

    @staticmethod
    def _migrate_from_v12(entities):
        document = {
            **_document(),
            "config_version": 12,
            "power_devices": {
                "solar": {
                    "entities": entities,
                    "forecast": {"daily_energy_entity_ids": ["sensor.solar_day_0"]},
                }
            },
        }
        migrated, _ids = migrate_config_document(document)
        return migrated["power_devices"]["solar"]

    def test_the_retired_key_is_dropped(self) -> None:
        solar = self._migrate_from_v12(
            {
                "power": "sensor.solar_power",
                "remaining_today_energy_forecast": (
                    "sensor.helman_energy_production_today_remaining"
                ),
            }
        )

        self.assertEqual(solar["entities"], {"power": "sensor.solar_power"})

    def test_a_value_pointing_elsewhere_is_dropped_just_the_same(self) -> None:
        solar = self._migrate_from_v12(
            {
                "power": "sensor.solar_power",
                "today_energy": "sensor.solar_today",
                "remaining_today_energy_forecast": "sensor.somebody_elses_guess",
            }
        )

        self.assertEqual(
            solar["entities"],
            {"power": "sensor.solar_power", "today_energy": "sensor.solar_today"},
        )
        self.assertEqual(solar["forecast"]["daily_energy_entity_ids"], ["sensor.solar_day_0"])

    def test_a_document_without_the_key_survives(self) -> None:
        migrated, _ids = migrate_config_document(
            {**_document(), "config_version": 12}
        )

        self.assertEqual(migrated["config_version"], CONFIG_DOCUMENT_VERSION)


if __name__ == "__main__":
    unittest.main()
