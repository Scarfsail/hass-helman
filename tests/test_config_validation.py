from __future__ import annotations

from datetime import datetime
import unittest

from _fakes import (
    _valid_config, _inverter_controllable, _generic_appliance,
    _climate_appliance, _ac_breaker, _study_breaker,
)


from custom_components.helman.config_validation import validate_config_document
from custom_components.helman.controllables.config import running_signal


class ConfigValidationTests(unittest.TestCase):
    def test_bounded_unknown_keys_warn_without_blocking(self) -> None:
        config = _valid_config()
        config["training"].update({"old_training": 1})
        config["training"]["house_consumption"] = {"old_house": 1}
        config["training"]["solar_bias"] = {}
        config["training"]["solar_bias"].update({"clamp_mx": 2, "old_bias": 1})
        config["training"]["solar_bias"]["slot_invalidation"] = {"old_slot": 1}
        config["energy_nodes"]["battery"]["forecast"] = {"old_forecast": 1}

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(
            {(issue.path, issue.code) for issue in report.warnings},
            {
                ("training.old_training", "unknown_key"),
                ("training.house_consumption.old_house", "unknown_key"),
                ("training.solar_bias.clamp_mx", "unknown_key"),
                ("training.solar_bias.old_bias", "unknown_key"),
                ("training.solar_bias.slot_invalidation.old_slot", "unknown_key"),
                ("energy_nodes.battery.forecast.old_forecast", "unknown_key"),
            },
        )

    def test_optional_reader_keys_are_not_unknown(self) -> None:
        config = _valid_config()
        config["training"]["solar_bias"] = {}
        config["training"]["solar_bias"]["total_energy_entity_id"] = "sensor.solar_total"
        config["training"]["solar_bias"]["slot_invalidation"] = {
            "data_glitch_max_slot_wh": 10,
        }
        config["energy_nodes"]["battery"]["forecast"] = {
            "max_charge_power_w": 2000,
            "max_discharge_power_w": 2000,
        }

        report = validate_config_document(config)

        self.assertEqual([issue for issue in report.warnings if issue.code == "unknown_key"], [])

    def test_valid_document_passes(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])

    def test_solax_profile_document_without_entity_slots_passes(self) -> None:
        # The stored shape under the SolaX inverter profile: the profile owns
        # every energy entity slot, so none is written, and the `profile` key
        # on the inverter is a config key like any other.
        config = _valid_config()
        config["energy_nodes"]["inverter"]["profile"] = {
            "id": "solax_inverter",
            "entry_id": "solax-entry",
        }
        for node in config["energy_nodes"].values():
            node.pop("entities", None)
        del config["energy_nodes"]["house"]["forecast"]["total_energy_entity_id"]
        config.get("training", {}).get("solar_bias", {}).pop(
            "total_energy_entity_id", None
        )
        config["energy_nodes"]["grid"]["max_allowed_export_power"] = 9900

        report = validate_config_document(config)

        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])

    def _export_cap_errors(self, *, vendor: bool, **grid) -> list[tuple[str, str]]:
        config = _valid_config()
        if vendor:
            config["energy_nodes"]["inverter"]["profile"] = {
                "id": "solax_inverter",
                "entry_id": "solax-entry",
            }
        config["energy_nodes"]["grid"].update(grid)
        return [
            (issue.path, issue.code)
            for issue in validate_config_document(config).errors
            if issue.path == "energy_nodes.grid.max_allowed_export_power"
        ]

    def test_export_cap_is_required_with_the_solax_profile(self) -> None:
        self.assertEqual(
            self._export_cap_errors(vendor=True),
            [("energy_nodes.grid.max_allowed_export_power", "required")],
        )

    def test_export_cap_must_not_be_negative(self) -> None:
        self.assertEqual(
            self._export_cap_errors(vendor=True, max_allowed_export_power=-1),
            [("energy_nodes.grid.max_allowed_export_power", "invalid_non_negative_number")],
        )

    def test_export_cap_of_zero_is_a_no_export_contract(self) -> None:
        self.assertEqual(
            self._export_cap_errors(vendor=True, max_allowed_export_power=0), []
        )

    def test_export_cap_is_optional_without_a_profile(self) -> None:
        self.assertEqual(self._export_cap_errors(vendor=False), [])

    def test_unknown_controllable_kind_is_warning_only(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"] = [{"kind": "heat_pump"}]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(len(report.warnings), 1)
        self.assertEqual(report.warnings[0].code, "unsupported_kind")

    def test_invalid_inverter_control_is_error(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["inverter"]["controls"]["mode"] = {
            "entity_id": "sensor.bad_domain",
            "options": {
                "normal": "Normal",
            },
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.code == "invalid_inverter_control" for issue in report.errors)
        )
        self.assertTrue(any(issue.code == "invalid_domain" for issue in report.errors))

    def test_invalid_stop_export_option_type_is_error(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["inverter"]["controls"]["mode"]["options"]["stop_export"] = 42

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "energy_nodes.inverter.controls.mode.options.stop_export"
                and issue.code == "invalid_type"
                for issue in report.errors
            )
        )

    def test_retired_config_keys_are_rejected_by_name(self) -> None:
        # Migration runs on load only, so a hand-edited old-shape document
        # reaching the save path must be refused with the new key named.
        for retired_key, value in (
            ("appliances", []),
            ("scheduler", {}),
            ("controllables", []),
        ):
            with self.subTest(retired_key=retired_key):
                config = _valid_config()
                config[retired_key] = value

                report = validate_config_document(config)

                self.assertFalse(report.valid)
                issue = next(
                    issue
                    for issue in report.errors
                    if issue.code == "retired_config_key"
                )
                self.assertEqual(issue.path, retired_key)
                self.assertIn("devices", issue.message)

    def test_reserved_inverter_id_is_rejected_for_other_kinds(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["id"] = "inverter"
        config["devices"]["consumers"].append(appliance)

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.code == "reserved_controllable_id" for issue in report.errors)
        )

    def test_duplicate_ids_across_kinds_are_rejected(self) -> None:
        config = _valid_config()
        climate = _climate_appliance()
        generic = _generic_appliance()
        generic["id"] = climate["id"]
        config["devices"]["consumers"].extend([climate, generic])

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.code == "duplicate_controllable_id"
                for issue in report.errors
            )
        )

    def test_invalid_grid_energy_meter_entity_ids_are_reported(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["grid"]["entities"]["today_import"] = "not-an-entity-id"
        config["energy_nodes"]["grid"]["entities"]["today_export"] = 42

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        for key in ("today_import", "today_export"):
            self.assertTrue(
                any(
                    issue.path == f"energy_nodes.grid.entities.{key}"
                    for issue in report.errors
                ),
                msg=f"expected an error for {key}",
            )

    def test_invalid_grid_import_windows_are_reported(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["grid"]["forecast"]["import_price_windows"] = [
            {"start": "00:00", "end": "05:00", "price": 2.5},
            {"start": "06:00", "end": "00:00", "price": 3.5},
        ]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.code == "invalid_import_price_config"
                and "leave a gap" in issue.message
                for issue in report.errors
            )
        )

    def test_appliance_runtime_optimizer_passes_for_configured_generic_appliance(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "run-dishwasher-on-surplus",
                    "kind": "appliance_runtime",
                    "target": {"controllables": [{"controllable_id": "dishwasher"}]},
                    "conditions": [{"min_soc_pct": 80}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_schedulable_devices_need_no_name_override(self) -> None:
        for device in [_generic_appliance(), _climate_appliance()]:
            with self.subTest(kind=device["kind"]):
                del device["name"]
                config = _valid_config()
                config["devices"]["consumers"].append(device)
                report = validate_config_document(config)
                self.assertTrue(report.valid, report.errors)

    def test_appliance_runtime_optimizer_rejects_unknown_appliance_id(self) -> None:
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "run-unknown-on-surplus",
                    "kind": "appliance_runtime",
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "target": {"controllables": [{"controllable_id": "missing-appliance"}]},
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "automation.appliance_optimizers[0].target.controllables[0].controllable_id"
                for issue in report.errors
            )
        )

    def test_appliance_runtime_optimizer_rejects_climate_mode_for_generic_appliance(
        self,
    ) -> None:
        config = _valid_config()
        config["devices"]["consumers"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "run-dishwasher-on-surplus",
                    "kind": "appliance_runtime",
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "target": {
                        "controllables": [
                            {"controllable_id": "dishwasher", "climate_mode": "heat"}
                        ]
                    },
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path
                == "automation.appliance_optimizers[0].target.controllables[0].climate_mode"
                for issue in report.errors
            )
        )

    def test_charge_hold_targets_the_inverter_without_saying_so(self) -> None:
        """An existing config omits ``target`` entirely and must keep working.

        The three inverter kinds gained ``controllable_id`` with the reserved
        id as its default, so a document written before the field existed keeps
        meaning exactly what it meant.
        """
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "system_optimizers": [
                {
                    "id": "hold",
                    "kind": "charge_hold",
                    "params": {
                        "window": {"start": "06:00", "end": "14:00"},
                        "battery_first": {"target_soc": 100, "margin_pct": 20},
                    },
                    "conditions": [{"run_when": ["surplus"]}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertTrue(report.valid, msg=report.to_dict())

    def test_an_optimizer_aimed_at_a_kind_it_cannot_drive_is_rejected(self) -> None:
        """A ``charge_hold`` on a boiler used to be accepted and do nothing.

        The pairing is incoherent — the inverter's actions and an appliance's
        are different vocabularies — and nothing said so, because the kind
        implied its own target.
        """
        config = _valid_config()
        config["devices"]["consumers"].append(_generic_appliance())
        config["automation"] = {
            "enabled": True,
            "system_optimizers": [
                {
                    "id": "hold",
                    "kind": "charge_hold",
                    "target": {"controllable_id": "dishwasher"},
                    "params": {
                        "window": {"start": "06:00", "end": "14:00"},
                        "battery_first": {"target_soc": 100, "margin_pct": 20},
                    },
                    "conditions": [{"run_when": ["surplus"]}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        incompatible = [
            issue for issue in report.errors if issue.code == "incompatible_target"
        ]
        self.assertEqual(len(incompatible), 1)
        self.assertEqual(
            incompatible[0].path, "automation.system_optimizers[0].target.controllable_id"
        )
        # The kind that cannot be driven is named, not just the id.
        self.assertIn("'generic'", incompatible[0].message)
        self.assertIn("inverter", incompatible[0].message)

    def test_an_appliance_runtime_aimed_at_an_ev_charger_is_rejected(self) -> None:
        """``ev_charger`` declares no optimizer kind, so nothing may target it.

        This used to fail only when the optimizer was *built* — the registry
        authors an action for generic and climate appliances and rejects
        everything else — which meant the config editor accepted it happily.
        Making chargers automatable is a feature; this only moves the existing
        refusal to where the user typed the id.
        """
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "charge-the-car",
                    "kind": "appliance_runtime",
                    "target": {"controllables": [{"controllable_id": "garage-ev"}]},
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        incompatible = [
            issue for issue in report.errors if issue.code == "incompatible_target"
        ]
        self.assertEqual(len(incompatible), 1)
        self.assertIn("'ev_charger'", incompatible[0].message)
        # And says what it *can* drive, so the fix is in the message.
        self.assertIn("climate, generic", incompatible[0].message)

    def test_an_optimizer_naming_no_configured_controllable_is_rejected_once(
        self,
    ) -> None:
        config = _valid_config()
        config["automation"] = {
            "enabled": True,
            "appliance_optimizers": [
                {
                    "id": "ghost",
                    "kind": "appliance_runtime",
                    "target": {"controllables": [{"controllable_id": "nobody"}]},
                    "params": {"window": {"start": "08:00", "end": "18:00"}},
                    "conditions": [{}],
                }
            ],
        }

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        # One finding: the builder would say the same thing in the appliance
        # registry's words, and two errors for one typo is noise.
        self.assertEqual(len(report.errors), 1)
        self.assertEqual(report.errors[0].code, "unknown_controllable")

    # --- requires_appliance ---------------------------------------------

    @staticmethod
    def _pool_optimizer(optimizer_id, *appliance_ids, requires=None, enabled=True):
        group = {} if requires is None else {"requires_appliance": requires}
        return {
            "id": optimizer_id,
            "kind": "appliance_runtime",
            "enabled": enabled,
            "target": {
                "controllables": [
                    {"controllable_id": appliance_id} for appliance_id in appliance_ids
                ]
            },
            "params": {"window": {"start": "08:00", "end": "18:00"}},
            "conditions": [group],
        }

    def _pool_config(self, *optimizers) -> dict:
        """Three pool appliances, plus whichever optimizers the case needs.

        The default pair is the correct arrangement — filtration planned first,
        the heat pump depending on it — so a case that wants a fault states only
        the fault.
        """
        config = _valid_config()
        for appliance_id in ("heatpump", "filtration", "sweeper"):
            appliance = _generic_appliance()
            appliance["id"] = appliance_id
            appliance["name"] = appliance_id.title()
            appliance["consumption"]["energy_entity_id"] = f"sensor.{appliance_id}_energy"
            appliance["controls"]["switch"]["entity_id"] = f"switch.{appliance_id}"
            config["devices"]["consumers"].append(appliance)

        config["automation"] = {
            "enabled": True,
            "appliance_optimizers": list(optimizers)
            or [
                self._pool_optimizer("filter", "filtration"),
                self._pool_optimizer("heat", "heatpump", requires="filtration"),
            ],
        }
        return config

    def _findings(self, config, code):
        report = validate_config_document(config)
        return [
            issue for issue in [*report.errors, *report.warnings] if issue.code == code
        ], report

    def test_a_provider_planned_earlier_is_accepted_silently(self) -> None:
        report = validate_config_document(self._pool_config())

        self.assertTrue(report.valid)
        self.assertEqual(report.warnings, [])

    def test_a_provider_with_no_optimizer_at_all_is_accepted_silently(self) -> None:
        """The mask reads the plan, not the optimizer: hand-scheduling is valid."""
        report = validate_config_document(
            self._pool_config(
                self._pool_optimizer("heat", "heatpump", requires="filtration")
            )
        )

        self.assertTrue(report.valid)
        self.assertEqual(report.warnings, [])

    def test_a_provider_planned_later_warns(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
            self._pool_optimizer("filter", "filtration"),
        )

        findings, report = self._findings(config, "required_appliance_planned_later")

        # A warning, not an error: an invisible lane does not prove the
        # dependent is dead, and the config still saves.
        self.assertTrue(report.valid)
        self.assertEqual(len(findings), 1)
        self.assertEqual(
            findings[0].path,
            "automation.appliance_optimizers[0].conditions[0].requires_appliance",
        )

    def test_a_provider_whose_only_optimizer_is_disabled_warns(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("filter", "filtration", enabled=False),
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
        )

        findings, report = self._findings(
            config, "required_appliance_optimizer_disabled"
        )

        self.assertTrue(report.valid)
        self.assertEqual(len(findings), 1)
        # The path addresses the *document*, whose index 1 is the heat pump.
        # Index 0 is the disabled filtration optimizer the warning is about —
        # pointing the editor there would highlight the wrong card.
        self.assertEqual(
            findings[0].path,
            "automation.appliance_optimizers[1].conditions[0].requires_appliance",
        )

    def test_an_unconfigured_provider_is_rejected(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("filter", "filtration"),
            self._pool_optimizer("heat", "heatpump", requires="nobody"),
        )

        findings, report = self._findings(config, "unknown_required_appliance")

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_the_inverter_is_not_an_appliance(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="inverter")
        )

        findings, report = self._findings(config, "unknown_required_appliance")

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_an_appliance_cannot_depend_on_itself(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="heatpump")
        )

        findings, report = self._findings(
            config, "self_referential_required_appliance"
        )

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_a_group_cannot_depend_on_any_of_its_own_members(self) -> None:
        """Every member's lane is stripped every run, not just the first's."""
        config = self._pool_config(
            self._pool_optimizer("group", "heatpump", "sweeper", requires="sweeper")
        )

        findings, report = self._findings(
            config, "self_referential_required_appliance"
        )

        self.assertFalse(report.valid)
        self.assertEqual(len(findings), 1)

    def test_a_provider_planned_by_a_later_groups_second_member_warns(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
            self._pool_optimizer("group", "sweeper", "filtration"),
        )

        findings, report = self._findings(config, "required_appliance_planned_later")

        self.assertTrue(report.valid)
        self.assertEqual(len(findings), 1)

    def test_a_provider_planned_by_an_earlier_groups_second_member_is_silent(
        self,
    ) -> None:
        config = self._pool_config(
            self._pool_optimizer("group", "sweeper", "filtration"),
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
        )

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.warnings, [])

    def test_a_provider_in_a_disabled_groups_second_member_warns(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("group", "sweeper", "filtration", enabled=False),
            self._pool_optimizer("heat", "heatpump", requires="filtration"),
        )

        findings, report = self._findings(
            config, "required_appliance_optimizer_disabled"
        )

        self.assertTrue(report.valid)
        self.assertEqual(len(findings), 1)

    # --- appliance groups -------------------------------------------------

    def test_a_group_of_several_members_is_accepted(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("group", "heatpump", "filtration", "sweeper")
        )

        report = validate_config_document(config)

        self.assertTrue(report.valid, msg=report.to_dict())

    def test_an_empty_group_is_rejected(self) -> None:
        config = self._pool_config(self._pool_optimizer("group"))

        findings, report = self._findings(config, "required")

        self.assertFalse(report.valid)
        self.assertEqual(
            [finding.path for finding in findings],
            ["automation.appliance_optimizers[0].target.controllables"],
        )

    def test_a_duplicated_member_is_rejected_at_its_second_occurrence(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("group", "heatpump", "filtration", "heatpump")
        )

        findings, report = self._findings(config, "duplicate_controllable")

        self.assertFalse(report.valid)
        self.assertEqual(
            [finding.path for finding in findings],
            ["automation.appliance_optimizers[0].target.controllables[2].controllable_id"],
        )

    def test_an_unknown_member_is_reported_at_its_own_index(self) -> None:
        config = self._pool_config(
            self._pool_optimizer("group", "heatpump", "nobody")
        )

        findings, report = self._findings(config, "unknown_controllable")

        self.assertFalse(report.valid)
        self.assertEqual(
            [finding.path for finding in findings],
            ["automation.appliance_optimizers[0].target.controllables[1].controllable_id"],
        )

    def test_climate_mode_is_checked_per_member_by_its_kind(self) -> None:
        config = self._pool_config()
        config["devices"]["consumers"].append(_climate_appliance())
        config["automation"]["appliance_optimizers"] = [
            {
                "id": "group",
                "kind": "appliance_runtime",
                "target": {
                    "controllables": [
                        {"controllable_id": "heatpump"},
                        # A generic member may not carry a mode...
                        {"controllable_id": "filtration", "climate_mode": "heat"},
                        # ...and a climate member must.
                        {"controllable_id": "living-room-hvac"},
                    ]
                },
                "params": {"window": {"start": "08:00", "end": "18:00"}},
                "conditions": [{}],
            }
        ]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertEqual(
            sorted(issue.path for issue in report.errors),
            [
                "automation.appliance_optimizers[0].target.controllables[1].climate_mode",
                "automation.appliance_optimizers[0].target.controllables[2].climate_mode",
            ],
        )

    def test_the_inverter_takes_no_id_kind_or_name(self) -> None:
        """Its location implies them: ``energy_nodes.inverter`` is the inverter."""
        config = _valid_config()
        config["energy_nodes"]["inverter"].update(
            id="inverter", kind="inverter", name="Inverter"
        )

        report = validate_config_document(config)

        self.assertEqual(
            [(i.section, i.path, i.code) for i in report.errors],
            [
                ("energy_nodes", f"energy_nodes.inverter.{key}", "retired_config_key")
                for key in ("id", "kind", "name")
            ],
        )
        self.assertIn("implies", report.errors[0].message)

    def test_the_inverters_issues_count_towards_energy_nodes(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["inverter"]["controls"]["mode"]["entity_id"] = (
            "sensor.bad_domain"
        )

        report = validate_config_document(config)

        self.assertEqual(
            {(i.section, i.path) for i in report.errors},
            {("energy_nodes", "energy_nodes.inverter.controls.mode.entity_id")},
        )

    def test_the_inverter_must_be_an_object(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["inverter"] = []

        self.assertIn(
            ("energy_nodes.inverter", "invalid_type"),
            _paths_and_codes(validate_config_document(config)),
        )

    def test_input_select_ev_controls_are_accepted(self) -> None:
        report = validate_config_document(_valid_config())

        self.assertTrue(report.valid)

    def test_valid_generic_appliance_passes(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"] = [_generic_appliance(strategy="history_average")]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_valid_climate_appliance_passes(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"] = [_climate_appliance(strategy="history_average")]

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_appliance_icon_accepts_non_mdi_value(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"][0]["icon"] = "hass:car-electric"

        report = validate_config_document(config)

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])

    def test_a_top_level_device_requires_a_meter(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance(strategy="history_average")
        del appliance["consumption"]["energy_entity_id"]
        config["devices"]["consumers"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertIn(
            ("devices.consumers[0].consumption.energy_entity_id", "required"),
            {(issue.path, issue.code) for issue in report.errors},
        )

    def test_the_inverter_may_not_declare_consumption(self) -> None:
        config = _valid_config()
        inverter = _inverter_controllable()
        inverter["consumption"] = {"energy_entity_id": "sensor.inverter_energy"}
        config["energy_nodes"]["inverter"] = inverter

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "energy_nodes.inverter.consumption"
                and issue.code == "consumption_not_allowed"
                for issue in report.errors
            )
        )

    def test_four_climate_children_may_share_their_parents_meter(self) -> None:
        # Four air conditioners behind one breaker meter: the house baseline
        # subtracts the meter once and history_average splits it among them.
        config = _valid_config()
        config["devices"]["consumers"] = [_ac_breaker()]

        report = validate_config_document(config)

        self.assertTrue(report.valid, report.errors)
        self.assertEqual(report.errors, [])

    def test_a_meter_named_by_two_devices_is_rejected(self) -> None:
        # The old shared form is migrated, not accepted.
        config = _valid_config()
        first = _generic_appliance(strategy="history_average")
        second = _climate_appliance(strategy="history_average")
        second["consumption"]["energy_entity_id"] = first["consumption"][
            "energy_entity_id"
        ]
        config["devices"]["consumers"] = [first, second]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertEqual(
            [issue.path for issue in report.errors if issue.code == "duplicate_meter"],
            ["devices.consumers[1].consumption.energy_entity_id"],
        )

    def test_a_device_id_that_is_a_meter_is_rejected(self) -> None:
        # Records are keyed by meter, or by id without one: the two must not
        # collide.
        config = _valid_config()
        first = _generic_appliance()
        second = _climate_appliance()
        second["id"] = first["consumption"]["energy_entity_id"]
        config["devices"]["consumers"] = [first, second]

        report = validate_config_document(config)

        self.assertIn(
            ("devices.consumers[0].consumption.energy_entity_id", "meter_is_device_id"),
            [(issue.path, issue.code) for issue in report.errors],
        )

    def test_the_meter_must_be_a_sensor(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["consumption"]["energy_entity_id"] = "switch.not_a_meter"
        config["devices"]["consumers"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "devices.consumers[0].consumption.energy_entity_id"
                for issue in report.errors
            )
        )

    def test_a_top_level_projection_is_reported_by_its_new_path(self) -> None:
        # Migration runs on load; a hand-edited save is told where the key went
        # rather than having it silently ignored.
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["projection"] = {"strategy": "fixed", "hourly_energy_kwh": 1.2}
        config["devices"]["consumers"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "devices.consumers[0].projection"
                and issue.code == "retired_config_key"
                and "consumption.projection" in issue.message
                for issue in report.errors
            )
        )

    def test_consumption_deferrable_is_rejected_as_unknown(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance(strategy="history_average")
        appliance["consumption"]["deferrable"] = False
        config["devices"]["consumers"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertIn(
            ("devices.consumers[0].consumption.deferrable", "unknown_key"),
            {(issue.path, issue.code) for issue in report.errors},
        )

    def test_the_retired_deferrable_consumers_key_is_reported(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["house"]["forecast"]["deferrable_consumers"] = [
            {"energy_entity_id": "sensor.washer_energy", "label": "Washer"}
        ]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "energy_nodes.house.forecast.deferrable_consumers"
                and issue.code == "retired_config_key"
                for issue in report.errors
            )
        )
        # The guidance names the rule that replaced it, not the rejected key.
        message = next(
            issue.message
            for issue in report.errors
            if issue.path == "energy_nodes.house.forecast.deferrable_consumers"
        )
        self.assertIn("schedulable", message)
        self.assertNotIn("consumption.deferrable", message)

    def test_the_retired_house_forecast_history_window_keys_are_reported(self) -> None:
        """min_history_days and training_window_days moved to training.house_consumption.

        Load migrates (see ``_migrate_v13_to_v14`` in automation/migration.py);
        save refuses these at their old home.
        """
        for retired_key in ("min_history_days", "training_window_days"):
            with self.subTest(retired_key=retired_key):
                config = _valid_config()
                config["energy_nodes"]["house"]["forecast"][retired_key] = 30

                report = validate_config_document(config)

                self.assertFalse(report.valid)
                self.assertTrue(
                    any(
                        issue.path
                        == f"energy_nodes.house.forecast.{retired_key}"
                        and issue.code == "retired_config_key"
                        for issue in report.errors
                    )
                )

    def test_training_house_consumption_settings_must_be_positive_ints(self) -> None:
        for key in ("min_history_days", "training_window_days"):
            with self.subTest(key=key):
                config = _valid_config()
                config["training"]["house_consumption"][key] = 0

                report = validate_config_document(config)

                self.assertFalse(report.valid)
                self.assertTrue(
                    any(
                        issue.path == f"training.house_consumption.{key}"
                        and issue.code == "invalid_positive_int"
                        for issue in report.errors
                    )
                )

    def test_a_minimum_above_the_training_window_is_refused(self) -> None:
        # The window caps what the trainer fetches, so a minimum above it can
        # never be met: the house trainer would report insufficient_history on
        # every run for as long as the config stood.
        config = _valid_config()
        config["training"]["house_consumption"]["training_window_days"] = 8
        config["training"]["house_consumption"]["min_history_days"] = 30

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.house_consumption.min_history_days"
                and issue.code == "invalid_relation"
                for issue in report.errors
            )
        )

    def test_a_minimum_equal_to_the_training_window_is_allowed(self) -> None:
        # Reachable, if only just: every day the window returns has to count.
        config = _valid_config()
        config["training"]["house_consumption"]["training_window_days"] = 8
        config["training"]["house_consumption"]["min_history_days"] = 8

        report = validate_config_document(config)

        self.assertTrue(report.valid, report.errors)

    def test_the_window_relation_is_not_judged_when_one_side_is_absent(self) -> None:
        # A blank field takes the const.py default, and pairing a typed value
        # against a default the user never sees would be a confusing error.
        config = _valid_config()
        config["training"]["house_consumption"]["min_history_days"] = 30
        config["training"]["house_consumption"].pop("training_window_days", None)

        report = validate_config_document(config)

        self.assertFalse(
            any(issue.code == "invalid_relation" for issue in report.errors)
        )

    def test_climate_requires_climate_domain(self) -> None:
        config = _valid_config()
        appliance = _climate_appliance()
        appliance["controls"]["climate"]["entity_id"] = "switch.not_a_climate"
        config["devices"]["consumers"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "devices.consumers[0].controls.climate.entity_id"
                and "controls.climate.entity_id" in issue.message
                for issue in report.errors
            )
        )

    def test_blank_appliance_icon_is_error(self) -> None:
        config = _valid_config()
        appliance = _generic_appliance()
        appliance["icon"] = "   "
        config["devices"]["consumers"] = [appliance]

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "devices.consumers[0].icon"
                and ".icon must be a non-empty string" in issue.message
                for issue in report.errors
            )
        )

    def test_invalid_groupings_are_reported(self) -> None:
        config = _valid_config()
        config["devices"]["groupings"] = [
            {"id": "rooms", "name": "Rooms", "groups": [
                {"id": "a", "name": "A", "short_name": "A"},
                {"id": "a", "name": "", "short_name": 1},
            ]},
            {"id": "rooms", "name": "Again", "groups": []},
            {"id": "", "groups": "x"},
            "oops",
        ]
        config["devices"]["consumers"][0]["groups"] = {"rooms": "a"}

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report),
            [
                ("devices.groupings[0].groups[1].name", "required"),
                ("devices.groupings[0].groups[1].short_name", "required"),
                ("devices.groupings[0].groups[1].id", "duplicate_group_id"),
                ("devices.groupings[1].id", "duplicate_grouping_id"),
                ("devices.groupings[2].groups", "invalid_type"),
                ("devices.groupings[2].name", "required"),
                ("devices.groupings[2].id", "required"),
                ("devices.groupings[3]", "invalid_type"),
            ],
        )

    def test_groupings_must_be_a_list(self) -> None:
        config = _valid_config()
        config["devices"]["groupings"] = {"rooms": {}}
        del config["devices"]["consumers"][0]["groups"]

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report), [("devices.groupings", "invalid_type")]
        )

    def test_a_device_names_only_known_groupings_and_groups(self) -> None:
        breaker = _ac_breaker()
        breaker["groups"] = {"rooms": "cellar", "floors": "garage"}
        breaker["children"][0]["groups"] = {"rooms": "garage"}
        breaker["children"][1]["groups"] = ["garage"]
        config = _valid_config()
        config["devices"]["consumers"].append(breaker)

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report),
            [
                ("devices.consumers[1].groups.rooms", "unknown_group"),
                ("devices.consumers[1].groups.floors", "unknown_grouping"),
                ("devices.consumers[1].children[1].groups", "invalid_type"),
            ],
        )

    def test_an_unsupported_kind_still_names_only_known_groups(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"].append(
            {"kind": "heat_pump", "groups": {"floors": "garage"}}
        )

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report),
            [("devices.consumers[1].groups.floors", "unknown_grouping")],
        )

    def test_the_inverter_takes_no_groups(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["inverter"]["groups"] = {"rooms": "garage"}

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report),
            [("energy_nodes.inverter.groups", "groups_not_allowed")],
        )

    def test_a_consumer_may_name_its_phase_or_none(self) -> None:
        breaker = _ac_breaker()
        breaker["phase"] = "3ph"
        breaker["children"][0]["phase"] = "L2"
        config = _valid_config()
        config["devices"]["consumers"][0]["phase"] = "L1"
        config["devices"]["consumers"].append(breaker)

        report = validate_config_document(config)

        # The other children name none: unassigned is always allowed.
        self.assertEqual(_paths_and_codes(report), [])

    def test_a_phase_must_be_one_of_the_known_wirings(self) -> None:
        breaker = _ac_breaker()
        breaker["phase"] = "L4"
        breaker["children"][1]["phase"] = 1
        config = _valid_config()
        config["devices"]["consumers"][0]["phase"] = "l1"
        config["devices"]["consumers"].append(breaker)

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report),
            [
                ("devices.consumers[0].phase", "invalid_phase"),
                ("devices.consumers[1].phase", "invalid_phase"),
                ("devices.consumers[1].children[1].phase", "invalid_phase"),
            ],
        )

    def test_the_inverter_takes_no_phase(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["inverter"]["phase"] = "L1"

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report),
            [("energy_nodes.inverter.phase", "phase_not_allowed")],
        )

    def test_a_stored_vendor_key_is_refused_by_name(self) -> None:
        """Load migrates ``vendor`` to ``profile`` (v29); save refuses it."""
        config = _valid_config()
        vendor = {"profile": "solax_inverter", "entry_id": "solax-entry"}
        config["energy_nodes"]["inverter"]["vendor"] = vendor
        config["devices"]["consumers"][0]["vendor"] = vendor

        report = validate_config_document(config)

        self.assertEqual(
            sorted(
                issue.path
                for issue in report.errors
                if issue.code == "relocated_config_key"
            ),
            ["devices.consumers[0].vendor", "energy_nodes.inverter.vendor"],
        )

    def test_top_level_card_key_is_refused_by_name(self) -> None:
        config = _valid_config()
        config["history_buckets"] = 60

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "history_buckets"
                and issue.code == "relocated_config_key"
                for issue in report.errors
            )
        )

    def test_top_level_training_time_is_refused_by_name(self) -> None:
        config = _valid_config()
        config["training_time"] = "03:00"

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training_time"
                and issue.code == "relocated_config_key"
                for issue in report.errors
            )
        )

    def test_training_time_valid_for_hhmm(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["training_time"] = "03:00"

        report = validate_config_document(config)

        self.assertTrue(report.valid)

    def test_training_time_invalid_for_bad_string(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["training_time"] = "3am"

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(issue.path == "training.training_time" for issue in report.errors)
        )

    def test_training_time_invalid_for_out_of_range_time(self) -> None:
        config = _valid_config()
        config.setdefault("training", {})["training_time"] = "25:00"

        report = validate_config_document(config)

        self.assertFalse(report.valid)
        self.assertTrue(
            any(
                issue.path == "training.training_time"
                and issue.code == "invalid_value"
                for issue in report.errors
            )
        )


    def test_relocated_device_settings_are_refused_by_name(self) -> None:
        for old_path, new_path in (
            ("power_sensor_name_cleaner_regex", "devices.name_cleaner_regex"),
            (
                "visualization.power_sensor_name_cleaner_regex",
                "devices.name_cleaner_regex",
            ),
            ("power_devices.house.power_sensor_label", "devices.power_sensor_label"),
            ("power_devices.house.power_switch_label", "devices.power_switch_label"),
            ("energy_nodes.house.power_sensor_label", "devices.power_sensor_label"),
            ("energy_nodes.house.power_switch_label", "devices.power_switch_label"),
            ("device_label_text", "devices.groupings"),
            ("visualization.device_label_text", "devices.groupings"),
        ):
            with self.subTest(old_path=old_path):
                config = _valid_config()
                *parents, key = old_path.split(".")
                container = config
                for part in parents:
                    container = container.setdefault(part, {})
                container[key] = "x"

                report = validate_config_document(config)

                issues = [
                    issue
                    for issue in report.errors
                    if issue.code == "relocated_config_key"
                ]
                # A label under the old top-level key is refused twice: once
                # for the renamed key, once for the label's own new home.
                renamed = ["power_devices"] if parents[:1] == ["power_devices"] else []
                self.assertEqual([issue.path for issue in issues], [*renamed, old_path])
                self.assertIn(new_path, issues[-1].message)

    def test_power_devices_is_refused_with_its_new_name(self) -> None:
        config = _valid_config()
        config["power_devices"] = config.pop("energy_nodes")

        report = validate_config_document(config)

        self.assertEqual(
            [
                (issue.section, issue.path, issue.code, issue.message)
                for issue in report.errors
            ],
            [
                (
                    "energy_nodes",
                    "power_devices",
                    "relocated_config_key",
                    "'power_devices' was renamed to 'energy_nodes'",
                )
            ],
        )

    def test_the_unmeasured_power_title_is_retired(self) -> None:
        config = _valid_config()
        config["energy_nodes"]["house"]["unmeasured_power_title"] = "Unmeasured"

        report = validate_config_document(config)

        self.assertEqual(
            [
                (issue.path, issue.code, issue.message)
                for issue in report.errors
            ],
            [
                (
                    "energy_nodes.house.unmeasured_power_title",
                    "retired_config_key",
                    "the Unmeasured rows use a fixed label; remove this key",
                )
            ],
        )

    def test_the_card_texts_are_retired(self) -> None:
        paths = [
            f"{prefix}{key}"
            for prefix in ("", "visualization.")
            for key in (
                "sources_title",
                "consumers_title",
                "groups_title",
                "others_group_label",
            )
        ] + [
            f"energy_nodes.{node}.{key}"
            for node in ("house", "solar", "battery", "grid")
            for key in ("source_name", "consumption_name")
        ]
        for path in paths:
            with self.subTest(path=path):
                config = _valid_config()
                *parents, key = path.split(".")
                container = config
                for part in parents:
                    container = container[part]
                container[key] = "x"

                report = validate_config_document(config)

                self.assertEqual(
                    [
                        (issue.path, issue.code, issue.message)
                        for issue in report.errors
                    ],
                    [
                        (
                            path,
                            "retired_config_key",
                            "the card localizes this text; remove this key",
                        )
                    ],
                )

    def test_devices_as_a_list_is_refused_with_the_new_shape(self) -> None:
        config = _valid_config()
        config["devices"] = config["devices"]["consumers"]

        report = validate_config_document(config)

        self.assertEqual(
            [(issue.path, issue.code, issue.message) for issue in report.errors],
            [
                (
                    "devices",
                    "relocated_config_key",
                    "devices is now an object; put the devices under "
                    "devices.consumers and the inverter under energy_nodes.inverter",
                )
            ],
        )

    def test_devices_must_be_an_object(self) -> None:
        config = _valid_config()
        config["devices"] = "nonsense"

        report = validate_config_document(config)

        self.assertIn(("devices", "invalid_type"), _paths_and_codes(report))

    def test_the_consumers_must_be_a_list(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"] = {"id": "washer"}

        report = validate_config_document(config)

        self.assertIn(("devices.consumers", "invalid_type"), _paths_and_codes(report))

    def test_a_leftover_items_list_is_refused_by_name(self) -> None:
        config = _valid_config()
        config["devices"]["items"] = []

        report = validate_config_document(config)

        self.assertEqual(
            [(issue.path, issue.code, issue.message) for issue in report.errors],
            [
                (
                    "devices.items",
                    "relocated_config_key",
                    "devices.items split into devices.consumers and "
                    "energy_nodes.inverter",
                )
            ],
        )

    def test_an_invalid_name_cleaner_regex_is_reported_at_its_new_path(self) -> None:
        for value, code in (("(", "invalid_regex"), ("  ", "invalid_type")):
            with self.subTest(value=value):
                config = _valid_config()
                config["devices"]["name_cleaner_regex"] = value

                report = validate_config_document(config)

                self.assertEqual(
                    _paths_and_codes(report),
                    [("devices.name_cleaner_regex", code)],
                )

    def test_device_labels_must_be_non_empty_strings(self) -> None:
        config = _valid_config()
        config["devices"]["power_sensor_label"] = "power"
        config["devices"]["power_switch_label"] = 5

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report), [("devices.power_switch_label", "invalid_type")]
        )

    def test_an_unknown_key_under_devices_is_reported(self) -> None:
        config = _valid_config()
        config["devices"]["colour"] = "blue"

        report = validate_config_document(config)

        self.assertEqual(
            _paths_and_codes(report), [("devices.colour", "unknown_key")]
        )


def _paths_and_codes(report) -> list[tuple[str, str]]:
    return [(issue.path, issue.code) for issue in report.errors]



class DeviceTreeValidationTests(unittest.TestCase):
    """The rules that relate devices to one another in the ``devices`` tree."""

    def _codes(self, *devices, automation=None):
        config = _valid_config()
        config["devices"]["consumers"] = list(devices)
        if automation is not None:
            config["automation"] = automation
        report = validate_config_document(config)
        return {(issue.path, issue.code) for issue in report.errors}, report

    def test_a_device_without_a_kind_is_a_passive_generic(self) -> None:
        errors, report = self._codes(
            {"id": "fridge", "consumption": {"energy_entity_id": "sensor.fridge_energy"}}
        )

        self.assertEqual(errors, set())
        self.assertEqual(report.warnings, [])

    def test_a_passive_device_needs_no_controls_or_projection(self) -> None:
        errors, _ = self._codes(
            {
                "id": "boiler",
                "kind": "generic",
                "schedulable": False,
                "consumption": {"energy_entity_id": "sensor.boiler_energy"},
            }
        )

        self.assertEqual(errors, set())

    def test_schedulable_requires_the_kinds_controls(self) -> None:
        appliance = _generic_appliance()
        del appliance["controls"]

        errors, _ = self._codes(appliance)

        self.assertIn(("devices.consumers[0].controls", "invalid_appliance"), errors)

    def test_an_invalid_generic_appliance_is_reported_at_the_field(self) -> None:
        appliance = _generic_appliance()
        del appliance["consumption"]["projection"]["hourly_energy_kwh"]

        errors, _ = self._codes(appliance)

        self.assertIn(
            (
                "devices.consumers[0].consumption.projection.hourly_energy_kwh",
                "invalid_appliance",
            ),
            errors,
        )

    def test_an_invalid_climate_appliance_is_reported_at_the_field(self) -> None:
        appliance = _climate_appliance()
        del appliance["controls"]["climate"]

        errors, _ = self._codes(appliance)

        self.assertIn(
            ("devices.consumers[0].controls.climate", "invalid_appliance"), errors
        )

    def test_an_invalid_ev_charger_is_reported_at_the_field(self) -> None:
        charger = _valid_config()["devices"]["consumers"][0]
        charger["controls"]["use_mode"]["values"] = {}

        errors, _ = self._codes(charger)

        self.assertIn(
            ("devices.consumers[0].controls.use_mode.values", "invalid_appliance"),
            errors,
        )

    def test_a_blank_use_mode_id_is_reported_at_the_values(self) -> None:
        charger = _valid_config()["devices"]["consumers"][0]
        values = charger["controls"]["use_mode"]["values"]
        values[" "] = next(iter(values.values()))

        errors, _ = self._codes(charger)

        self.assertIn(
            ("devices.consumers[0].controls.use_mode.values", "invalid_appliance"),
            errors,
        )

    def test_ids_are_unique_across_the_whole_tree(self) -> None:
        breaker = _ac_breaker()
        breaker["children"][0]["id"] = "garage-ev"

        errors, _ = self._codes(_valid_config()["devices"]["consumers"][0], breaker)

        self.assertIn(
            ("devices.consumers[1].children[0].id", "duplicate_controllable_id"), errors
        )

    def test_the_inverter_is_refused_among_the_consumers(self) -> None:
        inverter = {"kind": "inverter", "id": "fv", **_inverter_controllable()}
        breaker = _ac_breaker()
        breaker["children"].append(inverter)

        errors, _ = self._codes(inverter, breaker)

        self.assertIn(("devices.consumers[0]", "inverter_not_a_consumer"), errors)
        self.assertIn(("devices.consumers[1].children[4]", "inverter_not_a_consumer"), errors)

    def test_a_stored_system_list_is_refused_by_name(self) -> None:
        config = _valid_config()
        config["devices"]["system"] = [{"kind": "inverter", **_inverter_controllable()}]

        report = validate_config_document(config)

        self.assertEqual(
            [(issue.path, issue.code, issue.message) for issue in report.errors],
            [
                (
                    "devices.system",
                    "relocated_config_key",
                    "the inverter moved from devices.system to energy_nodes.inverter",
                )
            ],
        )

    def test_a_consumer_may_not_take_the_inverters_id(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"][0]["id"] = "inverter"

        self.assertIn(
            ("devices.consumers[0].id", "reserved_controllable_id"),
            _paths_and_codes(validate_config_document(config)),
        )

    def test_a_child_may_not_repeat_another_devices_meter(self) -> None:
        breaker = _ac_breaker()
        breaker["children"][0]["consumption"]["energy_entity_id"] = (
            "sensor.jistic_klimatizace_energy"
        )

        errors, _ = self._codes(breaker)

        self.assertIn(
            ("devices.consumers[0].children[0].consumption.energy_entity_id", "duplicate_meter"),
            errors,
        )

    def test_a_device_under_a_meterless_parent_is_rejected(self) -> None:
        breaker = _ac_breaker()
        breaker["children"][0]["schedulable"] = False
        breaker["children"][0]["children"] = [
            {"id": "lamp", "consumption": {"energy_entity_id": "sensor.lamp_energy"}}
        ]
        for child in breaker["children"][1:]:
            child["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertIn(
            ("devices.consumers[0].children[0].children", "children_without_meter"), errors
        )

    def test_a_schedulable_device_with_children_is_rejected(self) -> None:
        breaker = _ac_breaker()
        breaker["schedulable"] = True
        breaker["kind"] = "generic"
        breaker["name"] = "Breaker"
        breaker["controls"] = {"switch": {"entity_id": "switch.breaker"}}
        breaker["consumption"]["projection"] = {
            "strategy": "fixed",
            "hourly_energy_kwh": 1.0,
        }

        errors, _ = self._codes(breaker)

        self.assertIn(("devices.consumers[0].children", "schedulable_with_children"), errors)

    def test_the_inverter_cannot_have_children_or_a_schedulable_flag(self) -> None:
        config = _valid_config()
        inverter = _inverter_controllable()
        inverter["children"] = [
            {
                "id": "x",
                "kind": "generic",
                "name": "X",
                "schedulable": True,
                "controls": {"switch": {"entity_id": "switch.x"}},
                "consumption": {
                    "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.0}
                },
            }
        ]
        inverter["schedulable"] = True
        config["energy_nodes"]["inverter"] = inverter

        report = validate_config_document(config)

        self.assertLessEqual(
            {
                ("energy_nodes.inverter.children", "children_not_allowed"),
                ("energy_nodes.inverter.schedulable", "schedulable_not_allowed"),
            },
            {(issue.path, issue.code) for issue in report.errors},
        )

    def test_meterless_ids_that_name_one_share_sensor_are_rejected(self) -> None:
        breaker = _ac_breaker()
        breaker["children"][0]["id"] = "ac-room"
        breaker["children"][1]["id"] = "ac_room"

        errors, _ = self._codes(breaker)

        self.assertIn(("devices.consumers[0].children[1].id", "share_sensor_collision"), errors)

    def test_a_share_collision_with_an_unsupported_kind_is_rejected(self) -> None:
        # A preserved future kind is skipped by the rest of validation, but
        # still gets a share sensor at runtime.
        breaker = _ac_breaker()
        breaker["children"][0]["id"] = "ac-room"
        breaker["children"][0]["kind"] = "future_kind"
        breaker["children"][1]["id"] = "ac_room"

        errors, _ = self._codes(breaker)

        self.assertIn(("devices.consumers[0].children[1].id", "share_sensor_collision"), errors)

    def test_a_meterless_child_needs_a_running_signal(self) -> None:
        breaker = _ac_breaker()
        breaker["children"].append({"id": "mystery", "schedulable": True})
        for child in breaker["children"]:
            child["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertIn(
            ("devices.consumers[0].children[4].controls", "running_signal_required"), errors
        )

    def test_a_lights_switch_control_is_its_running_signal(self) -> None:
        breaker = _ac_breaker()
        breaker["children"].append(
            {"id": "hall", "controls": {"switch": {"entity_id": "light.hall"}}}
        )
        for child in breaker["children"]:
            child["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertNotIn(
            ("devices.consumers[0].children[4].controls", "running_signal_required"), errors
        )
        self.assertEqual(running_signal(breaker["children"][4]), ("light.hall", "switch"))

    def test_an_ev_chargers_charge_switch_is_its_running_signal(self) -> None:
        # The editor offers an EV charger as a meterless child and asks for its
        # charge switch; that switch is what tells when it draws from the meter.
        breaker = _ac_breaker()
        breaker["children"].append(
            {
                "id": "garage-ev",
                "kind": "ev_charger",
                "controls": {"charge": {"entity_id": "switch.ev_charge"}},
            }
        )
        for child in breaker["children"]:
            child["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertNotIn(
            ("devices.consumers[0].children[4].controls", "running_signal_required"), errors
        )
        self.assertEqual(
            running_signal(breaker["children"][4]), ("switch.ev_charge", "switch")
        )
        # Only an EV charger's charge control counts; on another kind it is not
        # a control the device's reader knows.
        generic = {"id": "x", "controls": {"charge": {"entity_id": "switch.x"}}}
        self.assertIsNone(running_signal(generic))

    def test_a_fans_switch_control_is_its_running_signal(self) -> None:
        breaker = _ac_breaker()
        breaker["children"].append(
            {"id": "fan", "controls": {"switch": {"entity_id": "fan.ventilation"}}}
        )
        for child in breaker["children"]:
            child["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertNotIn(
            ("devices.consumers[0].children[4].controls", "running_signal_required"), errors
        )
        self.assertEqual(running_signal(breaker["children"][4]), ("fan.ventilation", "switch"))

    def test_a_covers_control_is_its_running_signal(self) -> None:
        breaker = _ac_breaker()
        breaker["children"].append(
            {"id": "awning", "controls": {"cover": {"entity_id": "cover.awning"}}}
        )
        for child in breaker["children"]:
            child["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertNotIn(
            ("devices.consumers[0].children[4].controls", "running_signal_required"), errors
        )
        self.assertEqual(running_signal(breaker["children"][4]), ("cover.awning", "cover"))

    def test_schedulable_cover_is_rejected(self) -> None:
        cover_dev = {
            "id": "gate",
            "schedulable": True,
            "controls": {"cover": {"entity_id": "cover.gate"}},
        }
        errors, _ = self._codes(cover_dev)
        self.assertIn(("devices.consumers[0].schedulable", "cover_not_schedulable"), errors)

    def test_conflicting_switch_and_cover_controls_are_rejected(self) -> None:
        device = {
            "id": "conflict",
            "schedulable": False,
            "controls": {
                "switch": {"entity_id": "switch.light"},
                "cover": {"entity_id": "cover.gate"},
            },
        }
        errors, _ = self._codes(device)
        self.assertIn(("devices.consumers[0].controls", "conflicting_controls"), errors)

    def test_passive_device_with_wrong_switch_domain_is_rejected(self) -> None:
        device = {
            "id": "bad_switch",
            "schedulable": False,
            "controls": {"switch": {"entity_id": "cover.gate"}},
        }
        errors, _ = self._codes(device)
        self.assertIn(("devices.consumers[0].controls.switch.entity_id", "invalid_domain"), errors)

    def test_passive_device_with_wrong_cover_domain_is_rejected(self) -> None:
        device = {
            "id": "bad_cover",
            "schedulable": False,
            "controls": {"cover": {"entity_id": "switch.gate"}},
        }
        errors, _ = self._codes(device)
        self.assertIn(("devices.consumers[0].controls.cover.entity_id", "invalid_domain"), errors)

    def test_passive_device_with_malformed_entity_id_is_rejected(self) -> None:
        for key, entity_id in [("cover", "cover."), ("switch", "switch.")]:
            with self.subTest(key=key):
                device = {
                    "id": f"bad_{key}",
                    "schedulable": False,
                    "controls": {key: {"entity_id": entity_id}},
                }
                errors, _ = self._codes(device)
                self.assertIn(
                    (f"devices.consumers[0].controls.{key}.entity_id", "invalid_entity_id"),
                    errors,
                )

    def test_passive_generic_cover_device_is_valid(self) -> None:
        device = {
            "id": "valid_cover",
            "schedulable": False,
            "controls": {"cover": {"entity_id": "cover.gate"}},
            "consumption": {"energy_entity_id": "sensor.gate_energy"},
        }
        errors, warnings = self._codes(device)
        self.assertEqual(errors, set())

    def test_mixed_schedulable_and_passive_meterless_siblings_are_rejected(
        self,
    ) -> None:
        breaker = _ac_breaker()
        breaker["children"][0]["schedulable"] = False

        errors, _ = self._codes(breaker)

        self.assertIn(("devices.consumers[0].children", "mixed_meterless_children"), errors)

    def test_a_parent_of_meterless_children_needs_a_power_sensor(self) -> None:
        breaker = _ac_breaker()
        del breaker["consumption"]["power_entity_id"]

        errors, _ = self._codes(breaker)

        self.assertIn(
            ("devices.consumers[0].consumption.power_entity_id", "power_entity_required"), errors
        )

    def test_the_childrens_tolerance_is_a_non_negative_number(self) -> None:
        path = "devices.consumers[0].consumption.children_tolerance_percent"
        for value, valid in ((0, True), (12.5, True), (-1, False), ("10", False), (True, False), (None, False)):
            with self.subTest(value=value):
                breaker = _ac_breaker()
                breaker["consumption"]["children_tolerance_percent"] = value

                errors, _ = self._codes(breaker)

                self.assertEqual(
                    (path, "invalid_non_negative_number") in errors, not valid
                )

    def test_an_energy_only_metered_sibling_of_a_meterless_child_is_rejected(
        self,
    ) -> None:
        errors, _ = self._codes(_study_breaker(plug_power=False))

        self.assertEqual(
            errors,
            {
                (
                    "devices.consumers[0].children[0].consumption.power_entity_id",
                    "power_entity_required",
                )
            },
        )

    def test_nested_meters_without_meterless_children_need_no_power(self) -> None:
        breaker = _study_breaker(plug_power=False)
        del breaker["children"][1]
        del breaker["consumption"]["power_entity_id"]

        errors, _ = self._codes(breaker)

        self.assertEqual(errors, set())

    def test_an_optimizer_target_on_a_passive_device_is_rejected(self) -> None:
        # Unsetting `schedulable` on a targeted device is refused rather than
        # silently dropping the target: a passive device with controls still
        # gets no runtime and cannot be targeted.
        appliance = _generic_appliance()
        appliance["schedulable"] = False

        errors, _ = self._codes(
            appliance,
            automation={
                "enabled": True,
                "appliance_optimizers": [
                    {
                        "id": "run-dishwasher",
                        "kind": "appliance_runtime",
                        "target": {
                            "controllables": [{"controllable_id": "dishwasher"}]
                        },
                        "conditions": [{"min_soc_pct": 80}],
                    }
                ],
            },
        )

        self.assertEqual(
            errors,
            {
                (
                    "automation.appliance_optimizers[0].target.controllables[0]"
                    ".controllable_id",
                    "target_not_schedulable",
                )
            },
        )

    def test_a_schedulable_child_may_be_targeted(self) -> None:
        errors, _ = self._codes(
            _ac_breaker(),
            automation={
                "enabled": True,
                "appliance_optimizers": [
                    {
                        "id": "heat",
                        "kind": "appliance_runtime",
                        "target": {
                            "controllables": [
                                {"controllable_id": "ac-0", "climate_mode": "heat"}
                            ]
                        },
                        "conditions": [{"min_soc_pct": 80}],
                    }
                ],
            },
        )

        self.assertEqual(errors, set())


if __name__ == "__main__":
    unittest.main()


def test_legacy_numeric_validation_codes_are_stable():
    from custom_components.helman.config_validation import (
        ValidationReport,
        _validate_optional_positive_int,
        _validate_optional_probability,
    )

    for validator, code in (
        (_validate_optional_positive_int, "invalid_positive_int"),
        (_validate_optional_probability, "invalid_probability"),
    ):
        for value in (True, "1", -1, 0):
            report = ValidationReport()
            validator(report, "training", "training.value", value)
            assert [error.code for error in report.errors] == [code]
