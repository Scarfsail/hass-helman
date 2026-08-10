"""The controllable registry, checked against the code that relies on it.

A registry is only worth having if it stays true. These tests pin the two ways
it could quietly become a lie: a kind whose declared attributes no longer exist
on the runtime dataclass it describes, and a capability flag that no longer
matches how the rest of the integration actually branches.

The last test is the one that guards the refactor itself:
``helman/get_controllable_entities`` must serialise byte for byte as it did
before the roster became spec-driven.
"""

from __future__ import annotations

import dataclasses
import json
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

from custom_components.helman.appliances.climate_appliance import (  # noqa: E402
    ClimateApplianceRuntime,
)
from custom_components.helman.appliances.config import (  # noqa: E402
    build_appliances_runtime_registry,
)
from custom_components.helman.appliances.ev_charger import (  # noqa: E402
    EvChargerApplianceRuntime,
)
from custom_components.helman.appliances.generic_appliance import (  # noqa: E402
    GenericApplianceRuntime,
)
from custom_components.helman.automation.spec import (  # noqa: E402
    KNOWN_OPTIMIZER_KINDS,
)
from custom_components.helman.controllables.spec import (  # noqa: E402
    CONTROLLABLE_SPECS,
)
from custom_components.helman.scheduling.normal_state import (  # noqa: E402
    build_controllable_entities,
)
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleControlConfig,
    read_schedule_control_config,
)

#: The runtime dataclass each kind's attribute names are read off.
_RUNTIME_TYPE_BY_KIND = {
    "inverter": ScheduleControlConfig,
    "climate": ClimateApplianceRuntime,
    "ev_charger": EvChargerApplianceRuntime,
    "generic": GenericApplianceRuntime,
}


def _config() -> dict:
    """One installation with an inverter and one appliance of every kind."""
    return {
        "scheduler": {
            "control": {
                "mode_entity_id": "select.solax_charger_use_mode",
                "action_option_map": {
                    "normal": "Self Use",
                    "stop_charging": "Manual",
                    "stop_discharging": "Manual",
                    "charge_to_target_soc": "Manual",
                    "discharge_to_target_soc": "Manual",
                    "stop_export": "Feedin Priority",
                },
            }
        },
        "appliances": [
            {
                "kind": "climate",
                "id": "living-room-hvac",
                "name": "Living Room HVAC",
                "controls": {"climate": {"entity_id": "climate.living_room"}},
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.5},
            },
            {
                "kind": "ev_charger",
                "id": "garage-ev",
                "name": "Garage EV",
                "limits": {"max_charging_power_kw": 11.0},
                "controls": {
                    "charge": {"entity_id": "switch.ev_nabijeni"},
                    "use_mode": {
                        "entity_id": "select.solax_ev_charger_charger_use_mode",
                        "values": {
                            "Fast": {"behavior": "fixed_max_power"},
                            "ECO": {"behavior": "surplus_aware"},
                        },
                    },
                    "eco_gear": {
                        "entity_id": "select.solax_ev_charger_eco_gear",
                        "values": {"6A": {"min_power_kw": 1.4}},
                    },
                },
                "vehicles": [
                    {
                        "id": "kona",
                        "name": "Kona",
                        "telemetry": {
                            "soc_entity_id": "sensor.kona_ev_battery_level",
                        },
                        "limits": {
                            "battery_capacity_kwh": 64.0,
                            "max_charging_power_kw": 11.0,
                        },
                    }
                ],
            },
            {
                "kind": "generic",
                "id": "dishwasher",
                "name": "Dishwasher",
                "controls": {"switch": {"entity_id": "switch.dishwasher"}},
                "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.2},
            },
        ],
    }


class ControllableSpecRegistryTests(unittest.TestCase):
    def test_registry_covers_exactly_the_four_kinds(self) -> None:
        self.assertEqual(
            sorted(CONTROLLABLE_SPECS),
            ["climate", "ev_charger", "generic", "inverter"],
        )

    def test_every_spec_is_keyed_by_its_own_kind(self) -> None:
        for kind, spec in CONTROLLABLE_SPECS.items():
            self.assertEqual(kind, spec.kind)

    def test_declared_attributes_exist_on_the_runtime_they_describe(self) -> None:
        """The registry names attributes; a rename must break here, loudly."""
        for kind, spec in CONTROLLABLE_SPECS.items():
            runtime_type = _RUNTIME_TYPE_BY_KIND[kind]
            available = {
                field.name for field in dataclasses.fields(runtime_type)
            } | {
                name
                for name in dir(runtime_type)
                if isinstance(getattr(runtime_type, name, None), property)
            }
            declared = {spec.control_entity_attr}
            if spec.resting_state_attr is not None:
                declared.add(spec.resting_state_attr)
            declared.update(spec.action_option_attrs.values())

            self.assertEqual(
                declared - available,
                set(),
                f"{kind} declares attributes {runtime_type.__name__} does not have",
            )

    def test_the_inverter_is_the_only_kind_that_affects_the_battery(self) -> None:
        """Only inverter actions reach ``battery_slot_simulation``.

        Appliances move the battery only by adding demand, which is what
        ``affects_consumption`` records; nothing lets one select an inverter
        mode.
        """
        self.assertEqual(
            {kind for kind, spec in CONTROLLABLE_SPECS.items() if spec.affects_battery},
            {"inverter"},
        )

    def test_the_appliance_kinds_are_the_only_ones_that_affect_consumption(
        self,
    ) -> None:
        """Only appliances are projected by ``build_appliance_projection_plan``."""
        self.assertEqual(
            {
                kind
                for kind, spec in CONTROLLABLE_SPECS.items()
                if spec.affects_consumption
            },
            {"climate", "ev_charger", "generic"},
        )

    def test_no_kind_both_drives_the_battery_and_projects_demand(self) -> None:
        for kind, spec in CONTROLLABLE_SPECS.items():
            self.assertFalse(
                spec.affects_battery and spec.affects_consumption,
                f"{kind} claims both capabilities",
            )

    def test_only_the_inverter_maps_schedule_actions_to_options(self) -> None:
        """An appliance's state follows from its action shape, not an option map."""
        self.assertEqual(
            {
                kind
                for kind, spec in CONTROLLABLE_SPECS.items()
                if spec.action_option_attrs
            },
            {"inverter"},
        )

    def test_declared_optimizer_kinds_all_exist(self) -> None:
        for kind, spec in CONTROLLABLE_SPECS.items():
            self.assertEqual(
                set(spec.optimizer_kinds) - KNOWN_OPTIMIZER_KINDS,
                set(),
                f"{kind} declares an optimizer kind that does not exist",
            )

    def test_every_optimizer_kind_can_reach_some_controllable(self) -> None:
        """An optimizer no kind accepts would be unusable by construction."""
        targeted = {
            optimizer_kind
            for spec in CONTROLLABLE_SPECS.values()
            for optimizer_kind in spec.optimizer_kinds
        }
        self.assertEqual(targeted, set(KNOWN_OPTIMIZER_KINDS))

    def test_ev_chargers_accept_no_optimizer(self) -> None:
        """``resolve_appliance_target`` authors actions for generic and climate
        appliances only, and rejects everything else — so today nothing can
        target a charger. Pinned so the day that changes, the spec is updated
        with it rather than silently lying."""
        self.assertEqual(CONTROLLABLE_SPECS["ev_charger"].optimizer_kinds, ())


class ControllableEntitiesPayloadTests(unittest.TestCase):
    """The roster payload is a wire contract; the refactor must not move it."""

    def _payload(self) -> list[dict]:
        config = _config()
        return build_controllable_entities(
            control_config=read_schedule_control_config(config),
            registry=build_appliances_runtime_registry(config),
        )

    def test_payload_is_byte_identical_to_the_pre_registry_roster(self) -> None:
        self.assertEqual(
            json.dumps(self._payload()),
            json.dumps(
                [
                    {
                        "kind": "inverter",
                        "name": "Inverter",
                        "entityId": "select.solax_charger_use_mode",
                        "normalState": "Self Use",
                        "actionOptions": {
                            "normal": "Self Use",
                            "stop_charging": "Manual",
                            "stop_discharging": "Manual",
                            "charge_to_target_soc": "Manual",
                            "discharge_to_target_soc": "Manual",
                            "stop_export": "Feedin Priority",
                        },
                    },
                    {
                        "kind": "climate",
                        "name": "Living Room HVAC",
                        "entityId": "climate.living_room",
                        "normalState": "off",
                    },
                    {
                        "kind": "ev_charger",
                        "name": "Garage EV",
                        "entityId": "switch.ev_nabijeni",
                        "normalState": "off",
                    },
                    {
                        "kind": "generic",
                        "name": "Dishwasher",
                        "entityId": "switch.dishwasher",
                        "normalState": "off",
                    },
                ]
            ),
        )

    def test_appliances_keep_the_order_they_were_configured_in(self) -> None:
        """Grouping by kind would reorder the card's lanes."""
        config = _config()
        config["appliances"].reverse()
        payload = build_controllable_entities(
            control_config=read_schedule_control_config(config),
            registry=build_appliances_runtime_registry(config),
        )

        self.assertEqual(
            [entity["kind"] for entity in payload],
            ["inverter", "generic", "ev_charger", "climate"],
        )


if __name__ == "__main__":
    unittest.main()
