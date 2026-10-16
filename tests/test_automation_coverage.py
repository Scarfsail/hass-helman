"""``helman/get_automation_coverage``: which automations drive each controllable.

The schedule band badges every lane with it, for admins and non-admins alike,
so the answer must come from the parsed config the pipeline runs -- not from a
second reading of the raw document in the card.
"""

from __future__ import annotations

import importlib
import unittest
from types import SimpleNamespace

from _fakes import FakeConnection, FakeHass, make_coordinator

from custom_components.helman.automation.config import AutomationConfig
from custom_components.helman.automation.coverage import build_automation_coverage
from custom_components.helman.const import DOMAIN

websockets_module = importlib.import_module("custom_components.helman.websockets")


def _appliance_runtime(optimizer_id: str, *members: str, **overrides) -> dict:
    return {
        "id": optimizer_id,
        "kind": "appliance_runtime",
        "target": {"controllables": [{"controllable_id": member} for member in members]},
        "conditions": [{"run_when": ["surplus"]}],
        **overrides,
    }


def _export_price(optimizer_id: str, **overrides) -> dict:
    return {
        "id": optimizer_id,
        "kind": "export_price",
        "conditions": [{"when_price_below": 0.0}],
        **overrides,
    }


def _coverage(automation: dict) -> dict:
    return build_automation_coverage(AutomationConfig.from_dict(automation))


class AutomationCoverageTests(unittest.TestCase):
    def test_matches_controllable_ids_for_both_target_buckets(self) -> None:
        automation = {
            "appliance_optimizers": [_appliance_runtime("heaters", "boiler", "pump")],
            # No target: the spec's reserved default puts it on the inverter.
            "system_optimizers": [
                _export_price("export"),
                _export_price("export_late", target={"controllable_id": "inverter"}),
            ],
        }
        parsed = AutomationConfig.from_dict(automation)

        coverage = build_automation_coverage(parsed)

        expected: dict[str, list[str]] = {}
        for optimizer in parsed.all_optimizers:
            for controllable_id in optimizer.controllable_ids:
                expected.setdefault(controllable_id, []).append(optimizer.id)
        self.assertEqual(
            {key: value["optimizerIds"] for key, value in coverage["controllables"].items()},
            expected,
        )
        self.assertEqual(
            coverage,
            {
                "masterEnabled": True,
                "controllables": {
                    "boiler": {"state": "active", "optimizerIds": ["heaters"]},
                    "pump": {"state": "active", "optimizerIds": ["heaters"]},
                    "inverter": {
                        "state": "active",
                        "optimizerIds": ["export", "export_late"],
                    },
                },
            },
        )

    def test_a_controllable_whose_optimizers_are_all_disabled_is_disabled_only(self) -> None:
        coverage = _coverage({
            "appliance_optimizers": [_appliance_runtime("boiler_surplus", "boiler", enabled=False)],
            "system_optimizers": [
                _export_price("export", enabled=False),
                _export_price("export_late"),
            ],
        })

        self.assertEqual(
            coverage["controllables"],
            {
                "boiler": {"state": "disabled_only", "optimizerIds": ["boiler_surplus"]},
                # One of the two is off; the lane is still driven.
                "inverter": {"state": "active", "optimizerIds": ["export", "export_late"]},
            },
        )

    def test_the_master_switch_overrides_every_optimizer(self) -> None:
        coverage = _coverage({
            "enabled": False,
            "system_optimizers": [_export_price("export")],
        })

        self.assertEqual(
            coverage,
            {
                "masterEnabled": False,
                "controllables": {
                    "inverter": {"state": "disabled_only", "optimizerIds": ["export"]},
                },
            },
        )


class AutomationCoverageCoordinatorTests(unittest.TestCase):
    def _coverage(self, config: dict) -> dict:
        coordinator = make_coordinator()
        coordinator._active_config = config
        return coordinator.get_automation_coverage()

    def test_reads_the_active_config(self) -> None:
        coverage = self._coverage({
            "automation": {"system_optimizers": [_export_price("export")]},
        })

        self.assertEqual(
            coverage["controllables"],
            {"inverter": {"state": "active", "optimizerIds": ["export"]}},
        )

    def test_an_unparsable_automation_config_covers_nothing(self) -> None:
        coverage = self._coverage({
            "automation": {"system_optimizers": [{"id": "x", "kind": "no_such_kind"}]},
        })

        self.assertEqual(coverage["controllables"], {})

    def test_no_automation_section_covers_nothing(self) -> None:
        self.assertEqual(self._coverage({})["controllables"], {})


class AutomationCoverageWebsocketTests(unittest.TestCase):
    def test_answers_a_non_admin_with_the_coordinator_coverage(self) -> None:
        coordinator = make_coordinator()
        coordinator._active_config = {
            "automation": {"system_optimizers": [_export_price("export")]},
        }
        hass = FakeHass()
        hass.data = {DOMAIN: {"coordinator": coordinator}}
        connection = FakeConnection()
        # The badge is drawn for every viewer, so the command is not admin-gated.
        connection.user = SimpleNamespace(is_admin=False)

        websockets_module.ws_get_automation_coverage(
            hass, connection, {"id": 7, "type": "helman/get_automation_coverage"}
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(
            connection.results,
            [(7, {
                "masterEnabled": True,
                "controllables": {
                    "inverter": {"state": "active", "optimizerIds": ["export"]},
                },
            })],
        )


if __name__ == "__main__":
    unittest.main()
