"""``helman.get_group_entities`` and ``helman.group_action`` (issue #375).

A group's entities are its direct members' running signals, in tree order; a
member without one is reported, never dropped. ``group_action`` goes through an
always-open :class:`ScheduleActuator`, so disabled schedule execution does not
block it, and one failing entity does not stop the rest.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

import voluptuous as vol  # noqa: E402
from homeassistant.core import SupportsResponse  # noqa: E402
from homeassistant.exceptions import (  # noqa: E402
    HomeAssistantError,
    ServiceValidationError,
)

from custom_components.helman import group_services  # noqa: E402
from custom_components.helman.const import DOMAIN  # noqa: E402
from custom_components.helman.controllables.config import (  # noqa: E402
    group_exists,
    group_member_entities,
)


def _switch(entity_id: str) -> dict:
    return {"switch": {"entity_id": entity_id}}


CONFIG = {
    "devices": {
        "groupings": [
            {
                "id": "power",
                "groups": [
                    {"id": "night", "name": "Night"},
                    {"id": "away", "name": "Away"},
                    {"id": "empty", "name": "Empty"},
                ],
            },
            {"id": "room", "groups": [{"id": "night", "name": "Other grouping"}]},
        ],
        "system": [
            {
                "kind": "inverter",
                "id": "inverter",
                "groups": {"power": "night"},
                "controls": _switch("switch.inverter"),
            }
        ],
        "consumers": [
            {
                "id": "boiler",
                "groups": {"power": "night"},
                "controls": _switch("switch.boiler"),
                "children": [
                    # Inherits (no own entry): not a direct member.
                    {"id": "boiler_pump", "controls": _switch("switch.pump")},
                    # Own entry: a member, after its parent in tree order.
                    {
                        "id": "boiler_light",
                        "groups": {"power": "night"},
                        "controls": {"switch": {"entity_id": "light.boiler"}},
                    },
                ],
            },
            {
                "id": "no_control",
                "groups": {"power": "night"},
                "meter": {"entity_id": "sensor.x_power"},
            },
            {
                "kind": "climate",
                "id": "ac",
                "groups": {"power": "night"},
                "controls": {"climate": {"entity_id": "climate.ac"}},
            },
            # Shares boiler's switch: de-duplicated.
            {
                "id": "boiler_twin",
                "groups": {"power": "night"},
                "controls": _switch("switch.boiler"),
            },
            {
                "id": "tv",
                "groups": {"power": "away", "room": "night"},
                "controls": _switch("switch.tv"),
            },
        ],
    }
}
NIGHT = ["switch.boiler", "light.boiler", "climate.ac"]


class GroupResolverTests(unittest.TestCase):
    def test_direct_members_in_tree_order_deduplicated(self) -> None:
        entity_ids, skipped = group_member_entities(CONFIG, "power", "night")
        self.assertEqual(entity_ids, NIGHT)
        self.assertEqual(skipped, ["no_control"])

    def test_inheriting_child_and_inverter_are_excluded(self) -> None:
        entity_ids, _ = group_member_entities(CONFIG, "power", "night")
        self.assertNotIn("switch.pump", entity_ids)
        self.assertNotIn("switch.inverter", entity_ids)

    def test_group_id_is_scoped_to_its_grouping(self) -> None:
        self.assertEqual(
            group_member_entities(CONFIG, "room", "night"), (["switch.tv"], [])
        )

    def test_group_exists(self) -> None:
        self.assertTrue(group_exists(CONFIG, "power", "empty"))
        self.assertEqual(group_member_entities(CONFIG, "power", "empty"), ([], []))
        self.assertFalse(group_exists(CONFIG, "power", "missing"))
        self.assertFalse(group_exists(CONFIG, "missing", "night"))
        self.assertFalse(group_exists({}, "power", "night"))


class FakeServices:
    def __init__(self, failing: set[str] = frozenset()) -> None:
        self.registered: dict[str, tuple] = {}
        self.calls: list[tuple[str, str, dict]] = []
        self._failing = failing

    def async_register(
        self, domain, service, handler, schema=None, supports_response=None
    ) -> None:
        assert domain == DOMAIN
        self.registered[service] = (handler, schema, supports_response)

    async def async_call(self, domain, service, data, *, blocking) -> None:
        self.calls.append((domain, service, data))
        if data["entity_id"] in self._failing:
            raise HomeAssistantError("boom")


class GroupServicesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.services = FakeServices()
        self._register()

    def _register(self) -> None:
        # Schedule execution disabled: the services must not care.
        storage = SimpleNamespace(config=CONFIG, execution_enabled=False)
        hass = SimpleNamespace(
            data={DOMAIN: {"storage": storage}}, services=self.services
        )
        group_services.async_register_group_services(hass)

    def _call(self, service: str, **data):
        handler, schema, _ = self.services.registered[service]
        return asyncio.run(handler(SimpleNamespace(data=schema(data))))

    def test_registration(self) -> None:
        self.assertIs(
            self.services.registered["get_group_entities"][2], SupportsResponse.ONLY
        )
        self.assertIsNone(self.services.registered["group_action"][2])

    def test_get_group_entities_response(self) -> None:
        self.assertEqual(
            self._call("get_group_entities", grouping="power", group="night"),
            {"entity_ids": NIGHT, "skipped": ["no_control"]},
        )

    def test_unknown_group_raises_validation_error(self) -> None:
        for service, extra in [
            ("get_group_entities", {}),
            ("group_action", {"action": "turn_on"}),
        ]:
            with self.assertRaises(ServiceValidationError):
                self._call(service, grouping="power", group="missing", **extra)
            with self.assertRaises(ServiceValidationError):
                self._call(service, grouping="missing", group="night", **extra)
        self.assertEqual(self.services.calls, [])

    def test_schema_rejects_bad_input(self) -> None:
        for data in [
            {"grouping": "", "group": "night", "action": "turn_on"},
            {"grouping": "power", "group": "night", "action": "open"},
            {"grouping": "power", "group": "night", "action": "toggle", "delay_ms": -1},
        ]:
            with self.assertRaises(vol.Invalid):
                self._call("group_action", **data)

    def test_group_action_calls_each_entity_with_delay_between(self) -> None:
        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        with patch.object(group_services.asyncio, "sleep", fake_sleep):
            self._call(
                "group_action",
                grouping="power",
                group="night",
                action="toggle",
                delay_ms=500,
            )
        self.assertEqual(
            self.services.calls,
            [
                ("switch", "toggle", {"entity_id": "switch.boiler"}),
                ("light", "toggle", {"entity_id": "light.boiler"}),
                ("climate", "toggle", {"entity_id": "climate.ac"}),
            ],
        )
        self.assertEqual(sleeps, [0.5, 0.5])

    def test_group_action_without_delay_does_not_sleep(self) -> None:
        async def fail_sleep(seconds: float) -> None:
            raise AssertionError("slept")

        with patch.object(group_services.asyncio, "sleep", fail_sleep):
            self._call("group_action", grouping="power", group="night", action="turn_off")
        self.assertEqual(
            [call[1] for call in self.services.calls], ["turn_off"] * 3
        )

    def test_failing_entity_does_not_stop_the_rest(self) -> None:
        self.services = FakeServices(failing={"light.boiler"})
        self._register()
        with self.assertRaises(HomeAssistantError) as raised:
            self._call("group_action", grouping="power", group="night", action="turn_on")
        self.assertNotIsInstance(raised.exception, ServiceValidationError)
        self.assertIn("light.boiler", str(raised.exception))
        self.assertEqual(
            [call[2]["entity_id"] for call in self.services.calls], NIGHT
        )


if __name__ == "__main__":
    unittest.main()
