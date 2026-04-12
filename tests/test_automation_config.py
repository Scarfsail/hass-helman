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
from custom_components.helman.automation import config as automation_config_module
from custom_components.helman.config_validation import validate_config_document


class AutomationConfigTests(unittest.TestCase):
    def _set_known_kinds(self, *kinds: str) -> None:
        original = automation_config_module.KNOWN_OPTIMIZER_KINDS
        automation_config_module.KNOWN_OPTIMIZER_KINDS = frozenset(kinds)
        self.addCleanup(
            setattr,
            automation_config_module,
            "KNOWN_OPTIMIZER_KINDS",
            original,
        )

    def test_parses_minimal_automation_block_with_defaults(self) -> None:
        parsed = AutomationConfig.from_dict({})

        self.assertTrue(parsed.enabled)
        self.assertEqual(parsed.optimizers, ())
        self.assertEqual(parsed.execution_optimizers, ())

    def test_parses_two_optimizers_and_preserves_order(self) -> None:
        self._set_known_kinds("alpha", "beta")
        parsed = AutomationConfig.from_dict(
            {
                "optimizers": [
                    {
                        "id": "export",
                        "kind": "alpha",
                    },
                    {
                        "id": "surplus",
                        "kind": "beta",
                    },
                ]
            }
        )

        self.assertEqual(
            [optimizer.id for optimizer in parsed.optimizers],
            ["export", "surplus"],
        )
        self.assertEqual(
            [optimizer.kind for optimizer in parsed.execution_optimizers],
            ["alpha", "beta"],
        )

    def test_preserves_explicit_top_level_enabled_false(self) -> None:
        self._set_known_kinds("alpha")
        parsed = AutomationConfig.from_dict(
            {
                "enabled": False,
                "optimizers": [
                    {
                        "id": "export",
                        "kind": "alpha",
                    }
                ],
            }
        )

        self.assertFalse(parsed.enabled)
        self.assertEqual(len(parsed.optimizers), 1)
        self.assertEqual(parsed.execution_optimizers, ())

    def test_rejects_duplicate_optimizer_ids(self) -> None:
        self._set_known_kinds("alpha", "beta")
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "optimizers": [
                        {
                            "id": "duplicate",
                            "kind": "alpha",
                        },
                        {
                            "id": "duplicate",
                            "kind": "beta",
                        },
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "duplicate_optimizer_id")
        self.assertEqual(ctx.exception.path, "automation.optimizers[1].id")

    def test_filters_disabled_instances_from_execution_order(self) -> None:
        self._set_known_kinds("alpha", "beta")
        parsed = AutomationConfig.from_dict(
            {
                "optimizers": [
                    {
                        "id": "export",
                        "kind": "alpha",
                    },
                    {
                        "id": "surplus",
                        "kind": "beta",
                        "enabled": False,
                    },
                ]
            }
        )

        self.assertEqual(
            [optimizer.id for optimizer in parsed.optimizers],
            ["export", "surplus"],
        )
        self.assertEqual(
            [optimizer.id for optimizer in parsed.execution_optimizers],
            ["export"],
        )

    def test_rejects_unknown_optimizer_kinds_with_descriptive_error(self) -> None:
        with self.assertRaises(AutomationConfigError) as ctx:
            AutomationConfig.from_dict(
                {
                    "optimizers": [
                        {
                            "id": "unknown",
                            "kind": "does_not_exist",
                        }
                    ]
                }
            )

        self.assertEqual(ctx.exception.code, "unknown_optimizer_kind")
        self.assertEqual(ctx.exception.path, "automation.optimizers[0].kind")
        self.assertIn("does_not_exist", str(ctx.exception))
        self.assertIn("no optimizer kinds are supported in this phase", str(ctx.exception))

    def test_is_no_op_when_automation_branch_is_absent(self) -> None:
        self.assertIsNone(read_automation_config({}))
        self.assertIsNone(read_automation_config(None))

    def test_ignores_unknown_extra_keys(self) -> None:
        self._set_known_kinds("alpha")
        parsed = AutomationConfig.from_dict(
            {
                "enabled": True,
                "note": "ignored",
                "optimizers": [
                    {
                        "id": "export",
                        "kind": "alpha",
                        "extra": "ignored",
                        "params": {"window": 2},
                    }
                ],
            }
        )

        self.assertEqual(parsed.optimizers[0].params, {"window": 2})

    def test_validate_config_document_accepts_valid_automation_block(self) -> None:
        report = validate_config_document(
            {
                "automation": {
                    "enabled": True,
                    "optimizers": [],
                }
            }
        )

        self.assertTrue(report.valid)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])


if __name__ == "__main__":
    unittest.main()
