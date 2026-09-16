from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    core_mod.HomeAssistant = type("HomeAssistant", (), {})

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-05T12:00:00+00:00")
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.automation.config import (
    AutomationConfig,
    AutomationConfigError,
    read_automation_config,
)
from custom_components.helman.automation.spec import OPTIMIZER_SPECS
from custom_components.helman.config_validation import validate_config_document
from custom_components.helman.const import DAY_CLASSIFICATIONS


def _export_price(**overrides):
    """A minimal, valid export_price optimizer in the unified shape.

    ``export_price`` is a system-kind optimizer: it targets the inverter,
    which is not an appliance controllable, so it belongs in
    ``system_optimizers``.
    """
    return {
        "id": "export",
        "kind": "export_price",
        "conditions": [{"when_price_below": 0.0}],
        **overrides,
    }


def _charge_hold(**overrides):
    """A minimal, valid charge_hold optimizer — also system-bucket."""
    return {
        "id": "hold",
        "kind": "charge_hold",
        "params": {
            "window": {"start": "06:00", "end": "12:00"},
            "battery_first": {"target_soc": 90, "margin_pct": 10},
        },
        "conditions": [{"run_when": ["surplus"]}],
        **overrides,
    }


class AutomationConfigTests(unittest.TestCase):
    def test_parses_minimal_automation_block_with_defaults(self) -> None:
        parsed = AutomationConfig.from_dict({})

        self.assertTrue(parsed.enabled)
        self.assertEqual(parsed.appliance_optimizers, ())
        self.assertEqual(parsed.system_optimizers, ())
        self.assertEqual(parsed.enabled_appliance_optimizers, ())
        self.assertEqual(parsed.enabled_system_optimizers, ())
        self.assertEqual(parsed.all_optimizers, ())

    def test_parses_two_optimizers_and_preserves_order(self) -> None:
        parsed = AutomationConfig.from_dict(
            {"system_optimizers": [_charge_hold(), _export_price()]}
        )

        self.assertEqual(
            [optimizer.id for optimizer in parsed.system_optimizers],
            ["hold", "export"],
        )
        self.assertEqual(
            [optimizer.kind for optimizer in parsed.enabled_system_optimizers],
            ["charge_hold", "export_price"],
        )

    def test_preserves_explicit_top_level_enabled_false(self) -> None:
        parsed = AutomationConfig.from_dict(
            {"enabled": False, "system_optimizers": [_export_price()]}
        )

        self.assertFalse(parsed.enabled)
        self.assertEqual(len(parsed.system_optimizers), 1)
        self.assertEqual(parsed.enabled_system_optimizers, ())

    def test_rejects_duplicate_optimizer_ids(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        _export_price(id="duplicate"),
                        _charge_hold(id="duplicate"),
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "duplicate_optimizer_id")
        self.assertEqual(ctx.exception.path, "automation.system_optimizers[1].id")

    def test_rejects_duplicate_ids_across_both_buckets(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "duplicate",
                            "kind": "appliance_runtime",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "conditions": [{"run_when": ["surplus"]}],
                        }
                    ],
                    "system_optimizers": [_export_price(id="duplicate")],
                }
            )

        self.assertEqual(ctx.exception.code, "duplicate_optimizer_id")

    def test_filters_disabled_instances_from_execution_order(self) -> None:
        parsed = AutomationConfig.from_dict(
            {"system_optimizers": [_export_price(), _charge_hold(enabled=False)]}
        )

        self.assertEqual(
            [optimizer.id for optimizer in parsed.system_optimizers],
            ["export", "hold"],
        )
        self.assertEqual(
            [optimizer.id for optimizer in parsed.enabled_system_optimizers],
            ["export"],
        )

    def test_rejects_unknown_optimizer_kinds_with_descriptive_error(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {"system_optimizers": [{"id": "unknown", "kind": "does_not_exist"}]}
            )

        self.assertEqual(ctx.exception.code, "unknown_optimizer_kind")
        self.assertEqual(ctx.exception.path, "automation.system_optimizers[0].kind")
        self.assertIn("does_not_exist", str(ctx.exception))
        self.assertIn(
            "supported optimizer kinds are: appliance_runtime", str(ctx.exception)
        )

    def test_is_no_op_when_automation_branch_is_absent(self) -> None:
        self.assertIsNone(read_automation_config({}))
        self.assertIsNone(read_automation_config(None))

    def test_rejects_the_old_flat_optimizers_key(self) -> None:
        """There is no dual-schema path: the flat key is a hard config error."""
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict({"optimizers": [_export_price()]})

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertEqual(ctx.exception.path, "automation.optimizers")
        self.assertIn("appliance_optimizers", str(ctx.exception))
        self.assertIn("system_optimizers", str(ctx.exception))

    def test_rejects_a_system_kind_in_appliance_optimizers(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict({"appliance_optimizers": [_charge_hold()]})

        self.assertEqual(ctx.exception.code, "wrong_bucket")
        self.assertEqual(ctx.exception.path, "automation.appliance_optimizers[0].kind")

    def test_rejects_an_appliance_kind_in_system_optimizers(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        {
                            "id": "runtime",
                            "kind": "appliance_runtime",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "conditions": [{"run_when": ["surplus"]}],
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "wrong_bucket")
        self.assertEqual(ctx.exception.path, "automation.system_optimizers[0].kind")


class ConditionGroupTests(unittest.TestCase):
    def test_requires_at_least_one_condition_group(self) -> None:
        for conditions in ({}, {"conditions": []}, {"conditions": None}):
            with self.subTest(conditions=conditions):
                with self.assertRaises(AutomationConfigError) as ctx:
                    AutomationConfig.from_dict(
                        {
                            "system_optimizers": [
                                {"id": "export", "kind": "export_price", **conditions}
                            ]
                        }
                    )
                self.assertEqual(ctx.exception.code, "required")
                self.assertEqual(
                    ctx.exception.path, "automation.system_optimizers[0].conditions"
                )

    def test_an_omitted_condition_stays_omitted_rather_than_defaulting(self) -> None:
        """`when_price_below` has no default, so absence means unconstrained.

        A threshold of 0 is a *restriction*, unlike `run_when`'s
        all-classifications default. Filling it in for a group that never asked
        would silently gate `daily_runtime` on negative export prices, and
        `build_eligibility` only masks on the keys actually present.
        """
        parsed = AutomationConfig.from_dict(
            {
                "system_optimizers": [
                    {"id": "export", "kind": "export_price", "conditions": [{}]}
                ]
            }
        )

        self.assertEqual(
            parsed.system_optimizers[0].conditions[0].condition_values, {}
        )

    def test_a_permissive_condition_default_is_still_filled_in(self) -> None:
        parsed = AutomationConfig.from_dict(
            {
                "appliance_optimizers": [
                    {
                        "id": "runtime",
                        "kind": "appliance_runtime",
                        "target": {"controllables": [{"controllable_id": "boiler"}]},
                        "params": {
                            "daily_minimum": {
                                "min_hours_per_day": 4,
                                "max_consecutive_skips": 0,
                            },
                            "window": {"start": "08:00", "end": "18:00"},
                        },
                        "conditions": [{}],
                    }
                ]
            }
        )

        # Every defaulted condition field fills, not just `run_when`: the SoC
        # margin carries one too, and an unused margin on a group that asked for
        # no budget is inert.
        self.assertEqual(
            parsed.appliance_optimizers[0].conditions[0].condition_values,
            {
                "run_when": DAY_CLASSIFICATIONS,
                "self_sustainability_margin_pct": 5.0,
            },
        )

    def test_a_group_cannot_override_a_non_overridable_param(self) -> None:
        """`max_consecutive_skips` describes a chain of days, not one day.

        `_plan_for_day` reads it from master params only, so accepting a group
        override would silently do nothing — reject it at the config boundary
        instead, and the editor hides it from the override form off the schema.
        """
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "runtime",
                            "kind": "appliance_runtime",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "params": {
                                "daily_minimum": {
                                    "min_hours_per_day": 4,
                                    "max_consecutive_skips": 0,
                                },
                                "window": {"start": "08:00", "end": "18:00"},
                            },
                            "conditions": [
                                {"params": {"daily_minimum": {"max_consecutive_skips": 3}}}
                            ],
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "not_overridable")
        self.assertEqual(
            ctx.exception.path,
            "automation.appliance_optimizers[0].conditions[0].params.daily_minimum"
            ".max_consecutive_skips",
        )

    def test_an_overridable_param_is_still_accepted_per_group(self) -> None:
        parsed = AutomationConfig.from_dict(
            {
                "appliance_optimizers": [
                    {
                        "id": "runtime",
                        "kind": "appliance_runtime",
                        "target": {"controllables": [{"controllable_id": "boiler"}]},
                        "params": {
                            "daily_minimum": {
                                "min_hours_per_day": 4,
                                "max_consecutive_skips": 0,
                            },
                            "window": {"start": "08:00", "end": "18:00"},
                        },
                        "conditions": [
                            {"params": {"daily_minimum": {"min_hours_per_day": 2}}}
                        ],
                    }
                ]
            }
        )

        self.assertEqual(
            parsed.appliance_optimizers[0].conditions[0].params["daily_minimum"][
                "min_hours_per_day"
            ],
            2,
        )

    def test_custom_conditions_are_read_verbatim(self) -> None:
        custom = [{"condition": "numeric_state", "entity_id": "sensor.x", "above": 10}]
        parsed = AutomationConfig.from_dict(
            {
                "system_optimizers": [
                    _export_price(conditions=[{"when_price_below": 0.0, "custom": custom}])
                ]
            }
        )

        self.assertEqual(
            parsed.system_optimizers[0].conditions[0].custom, tuple(custom)
        )

    def test_absent_custom_is_an_empty_tuple(self) -> None:
        parsed = AutomationConfig.from_dict(
            {"system_optimizers": [_export_price()]}
        )
        self.assertEqual(parsed.system_optimizers[0].conditions[0].custom, ())

    def test_rejects_non_list_custom(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        _export_price(conditions=[{"custom": "nope"}]),
                    ]
                }
            )

        self.assertEqual(
            ctx.exception.path, "automation.system_optimizers[0].conditions[0].custom"
        )

    def test_rejects_non_object_custom_entry(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {"system_optimizers": [_export_price(conditions=[{"custom": ["nope"]}])]}
            )

        self.assertEqual(
            ctx.exception.path,
            "automation.system_optimizers[0].conditions[0].custom[0]",
        )

    def test_rejects_a_condition_type_the_kind_does_not_accept(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        _export_price(conditions=[{"run_when": ["surplus"]}])
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "unknown_key")
        self.assertEqual(
            ctx.exception.path, "automation.system_optimizers[0].conditions[0].run_when"
        )

    def test_rejects_target_inside_a_group(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        _export_price(conditions=[{"target": {"controllable_id": "x"}}])
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertIn("never overridable", str(ctx.exception))

    def test_group_name_is_optional_and_read(self) -> None:
        parsed = AutomationConfig.from_dict(
            {"system_optimizers": [_export_price(conditions=[{"name": "Cheap hours"}])]}
        )

        self.assertEqual(
            parsed.system_optimizers[0].conditions[0].name, "Cheap hours"
        )


class ParamOverrideTests(unittest.TestCase):
    def _hold_with_override(self, override):
        parsed = AutomationConfig.from_dict(
            {
                "system_optimizers": [
                    _charge_hold(
                        conditions=[{"run_when": ["surplus"], "params": override}]
                    )
                ]
            }
        )
        return parsed.system_optimizers[0]

    def test_master_params_are_unchanged_by_a_group_override(self) -> None:
        optimizer = self._hold_with_override({"battery_first": {"target_soc": 95}})

        self.assertEqual(optimizer.params["battery_first"]["target_soc"], 90.0)

    def test_nested_objects_merge_one_level_deep(self) -> None:
        optimizer = self._hold_with_override({"battery_first": {"target_soc": 95}})

        self.assertEqual(
            optimizer.conditions[0].params["battery_first"],
            {"target_soc": 95.0, "margin_pct": 10.0},
        )

    def test_window_end_can_move_while_start_is_inherited(self) -> None:
        optimizer = self._hold_with_override({"window": {"end": "14:00"}})

        self.assertEqual(
            optimizer.conditions[0].params["window"],
            {"start": "06:00", "end": "14:00"},
        )

    def test_the_override_as_authored_is_kept_separately(self) -> None:
        optimizer = self._hold_with_override({"window": {"end": "14:00"}})

        self.assertEqual(
            optimizer.conditions[0].params_override, {"window": {"end": "14:00"}}
        )

    def test_rejects_an_unknown_key_inside_a_nested_override(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            self._hold_with_override({"battery_first": {"typo": 1}})

        self.assertEqual(ctx.exception.code, "unknown_key")
        self.assertEqual(
            ctx.exception.path,
            "automation.system_optimizers[0].conditions[0].params.battery_first.typo",
        )

    def test_cross_field_validation_runs_against_resolved_group_params(self) -> None:
        # Master window is valid; only the resolved group window is inverted.
        with self.assertRaises(AutomationConfigError) as ctx:
            self._hold_with_override({"window": {"end": "05:00"}})

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertEqual(
            ctx.exception.path,
            "automation.system_optimizers[0].conditions[0].params.window.end",
        )

    def test_daily_runtime_window_width_is_checked_per_group(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "dhw",
                            "kind": "appliance_runtime",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "params": {
                                "daily_minimum": {
                                    "min_hours_per_day": 3,
                                    "max_consecutive_skips": 0,
                                },
                                "window": {"start": "06:00", "end": "22:00"},
                            },
                            "conditions": [
                                {"params": {"window": {"end": "08:00"}}},
                            ],
                        }
                    ]
                }
            )

        self.assertIn("at least", str(ctx.exception))
        self.assertEqual(
            ctx.exception.path,
            "automation.appliance_optimizers[0].conditions[0].params.window",
        )


class RelocatedKeyTests(unittest.TestCase):
    """The old shape must fail loudly, naming where the value lives now."""

    def test_top_level_condition_names_its_new_home(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {"system_optimizers": [_export_price(condition=[{"condition": "state"}])]}
            )

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertIn("conditions[0].custom", str(ctx.exception))

    def test_dropped_action_param_is_rejected_rather_than_ignored(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        _export_price(params={"action": "stop_export"}),
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "unknown_key")
        self.assertEqual(
            ctx.exception.path, "automation.system_optimizers[0].params.action"
        )

    def test_unknown_optimizer_key_is_rejected(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {"system_optimizers": [_export_price(extra="ignored")]}
            )

        self.assertEqual(ctx.exception.code, "unknown_key")
        self.assertEqual(ctx.exception.path, "automation.system_optimizers[0].extra")

    def test_top_level_appliance_id_points_at_target_member(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "boiler-surplus",
                            "kind": "appliance_runtime",
                            "appliance_id": "boiler",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "params": {
                                "window": {"start": "08:00", "end": "18:00"},
                            },
                            "conditions": [{}],
                        }
                    ]
                }
            )

        self.assertIn("target.controllables[].controllable_id", str(ctx.exception))


class TargetTests(unittest.TestCase):
    def test_requires_appliance_id_for_appliance_kinds(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "boiler-surplus",
                            "kind": "appliance_runtime",
                            "params": {"window": {"start": "08:00", "end": "18:00"}},
                            "conditions": [{}],
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "required")
        self.assertEqual(
            ctx.exception.path, "automation.appliance_optimizers[0].target.controllables"
        )

    def test_rejects_an_unsupported_climate_mode(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "climate-surplus",
                            "kind": "appliance_runtime",
                            "params": {"window": {"start": "08:00", "end": "18:00"}},
                            "target": {
                                "controllables": [
                                    {
                                        "controllable_id": "living-room-hvac",
                                        "climate_mode": "fan_only",
                                    }
                                ]
                            },
                            "conditions": [{}],
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertEqual(
            ctx.exception.path,
            "automation.appliance_optimizers[0].target.controllables[0].climate_mode",
        )

    @staticmethod
    def _read_appliance_target(target):
        return AutomationConfig.from_dict(
            {
                "appliance_optimizers": [
                    {
                        "id": "acs",
                        "kind": "appliance_runtime",
                        "params": {"window": {"start": "08:00", "end": "18:00"}},
                        "target": target,
                        "conditions": [{}],
                    }
                ]
            }
        ).appliance_optimizers[0]

    def test_a_group_reads_in_priority_order(self) -> None:
        optimizer = self._read_appliance_target(
            {
                "controllables": [
                    {"controllable_id": "ac-living", "climate_mode": "cool"},
                    {"controllable_id": "boiler"},
                ]
            }
        )

        self.assertEqual(optimizer.controllable_ids, ("ac-living", "boiler"))
        self.assertEqual(
            [member.target for member in optimizer.member_configs()],
            [
                {"controllable_id": "ac-living", "climate_mode": "cool"},
                {"controllable_id": "boiler"},
            ],
        )

    def test_a_member_error_carries_its_index(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            self._read_appliance_target(
                {
                    "controllables": [
                        {"controllable_id": "ac-living", "climate_mode": "cool"},
                        {"controllable_id": "ac-bedroom", "climate_mode": "fan_only"},
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertEqual(
            ctx.exception.path,
            "automation.appliance_optimizers[0].target.controllables[1].climate_mode",
        )

    def test_an_empty_group_is_rejected(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            self._read_appliance_target({"controllables": []})

        self.assertEqual(ctx.exception.code, "required")
        self.assertEqual(
            ctx.exception.path, "automation.appliance_optimizers[0].target.controllables"
        )

    def test_a_group_must_be_a_list(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            self._read_appliance_target({"controllables": {"controllable_id": "boiler"}})

        self.assertEqual(ctx.exception.code, "invalid_type")

    def test_the_schema_serialises_the_group_element_fields(self) -> None:
        (field,) = OPTIMIZER_SPECS["appliance_runtime"].target

        self.assertEqual(
            field.to_dict(),
            {
                "key": "controllables",
                "type": "object_list",
                "minItems": 1,
                "fields": [
                    {"key": "controllable_id", "type": "string"},
                    {
                        "key": "climate_mode",
                        "type": "string",
                        "required": False,
                        "choices": list(field.fields[1].choices),
                    },
                ],
            },
        )

    def test_rejects_an_out_of_range_soc_threshold(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "boiler-soak",
                            "kind": "appliance_runtime",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "conditions": [{"min_soc_pct": 120}],
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "invalid_value")
        self.assertEqual(
            ctx.exception.path,
            "automation.appliance_optimizers[0].conditions[0].min_soc_pct",
        )

    def test_a_retired_kind_names_its_replacement(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "appliance_optimizers": [
                        {
                            "id": "boiler-surplus",
                            "kind": "surplus_appliance",
                            "target": {"controllables": [{"controllable_id": "boiler"}]},
                            "conditions": [{}],
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "retired_optimizer_kind")
        self.assertIn("appliance_runtime", str(ctx.exception))

    def test_rejects_a_non_numeric_export_price_threshold(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "system_optimizers": [
                        _export_price(conditions=[{"when_price_below": "zero"}])
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "invalid_type")
        self.assertEqual(
            ctx.exception.path,
            "automation.system_optimizers[0].conditions[0].when_price_below",
        )


class MigrationRoundTripTests(unittest.TestCase):
    """The migration's output must be exactly what the reader accepts.

    Migration and reading are written independently; without this, a rule that
    moves a key to the wrong place only fails on a user's next restart.
    """

    def test_a_full_old_shape_document_reads_back_after_migration(self) -> None:
        from custom_components.helman.automation.migration import (
            migrate_config_document,
        )

        old = {
            "automation": {
                "optimizers": [
                    {
                        "id": "hold",
                        "kind": "charge_hold",
                        "params": {
                            "only_on_days": ["surplus"],
                            "hold_action": "stop_charging",
                            "window": {"start": "06:00", "end": "12:00"},
                            "battery_first": {"target_soc": 90, "margin_pct": 10},
                        },
                        "condition": [{"condition": "state", "entity_id": "x.y"}],
                    },
                    {
                        "id": "export",
                        "kind": "export_price",
                        "params": {"when_price_below": -0.05, "action": "stop_export"},
                    },
                    {
                        "id": "surplus",
                        "kind": "surplus_appliance",
                        "params": {
                            "appliance_id": "boiler",
                            "action": "on",
                            "min_surplus_buffer_pct": 15,
                        },
                    },
                    {
                        "id": "bridge",
                        "kind": "charge_from_grid",
                        "params": {"reserve_floor_soc": 20, "margin_pct": 10},
                    },
                    {
                        "id": "dhw",
                        "kind": "daily_runtime",
                        "params": {
                            "appliance_id": "boiler",
                            "min_hours_per_day": 3,
                            "window": {"start": "06:00", "end": "22:00"},
                            "skip": {
                                "on_days": ["deficit"],
                                "max_consecutive_skips": 2,
                            },
                        },
                    },
                ]
            }
        }
        migrated, _ids = migrate_config_document(old)

        parsed = read_automation_config(migrated)

        # System-bucket kinds keep their relative order; so do appliance-bucket
        # ones — but the two lists are separate now, so the flat interleaved
        # order across both is not (and cannot be) preserved. See #271.
        self.assertEqual(
            [optimizer.id for optimizer in parsed.system_optimizers],
            ["hold", "export", "bridge"],
        )
        self.assertEqual(
            [optimizer.id for optimizer in parsed.appliance_optimizers],
            ["surplus", "dhw"],
        )

        by_id = {optimizer.id: optimizer for optimizer in parsed.all_optimizers}
        self.assertEqual(
            by_id["hold"].conditions[0].custom,
            ({"condition": "state", "entity_id": "x.y"},),
        )
        self.assertEqual(
            by_id["dhw"].conditions[0].condition_values["run_when"],
            ("surplus", "tight"),
        )
        self.assertEqual(
            by_id["dhw"].params["daily_minimum"]["max_consecutive_skips"], 2
        )
        self.assertEqual(by_id["surplus"].controllable_ids, ("boiler",))


class DayContextTests(unittest.TestCase):
    def test_validate_config_document_accepts_valid_automation_block(self) -> None:
        report = validate_config_document(
            {
                "automation": {
                    "enabled": True,
                    "appliance_optimizers": [],
                    "system_optimizers": [],
                }
            }
        )

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])

    def test_day_context_defaults_when_absent(self) -> None:
        parsed = AutomationConfig.from_dict({"enabled": True})
        self.assertAlmostEqual(parsed.day_context.deficit_below_ratio, 0.7)
        self.assertAlmostEqual(parsed.day_context.surplus_above_ratio, 1.3)

    def test_day_context_reads_custom_ratios(self) -> None:
        parsed = AutomationConfig.from_dict(
            {
                "enabled": True,
                "day_context": {
                    "deficit_below_ratio": 0.5,
                    "surplus_above_ratio": 1.5,
                },
            }
        )
        self.assertAlmostEqual(parsed.day_context.deficit_below_ratio, 0.5)
        self.assertAlmostEqual(parsed.day_context.surplus_above_ratio, 1.5)

    def test_day_context_rejects_deficit_ge_surplus(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "enabled": True,
                    "day_context": {
                        "deficit_below_ratio": 1.5,
                        "surplus_above_ratio": 1.3,
                    },
                }
            )
        self.assertEqual(ctx.exception.code, "invalid_value")


if __name__ == "__main__":
    unittest.main()
