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
from custom_components.helman.automation.migration import (  # noqa: E402
    migrate_config_document,
)
from custom_components.helman.automation.spec import (  # noqa: E402
    KNOWN_OPTIMIZER_KINDS,
    OPTIMIZER_SPECS,
)
from custom_components.helman.controllables.config import (  # noqa: E402
    read_deferrable_consumers,
    read_scheduled_consumers,
)
from custom_components.helman.controllables.spec import (  # noqa: E402
    CONTROLLABLE_SPECS,
    controllable_kinds_for_optimizer_kind,
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
        "controllables": [
            {
                "kind": "inverter",
                "id": "inverter",
                "name": "Inverter",
                "controls": {
                    "mode": {
                        "entity_id": "select.solax_charger_use_mode",
                        "options": {
                            "normal": "Self Use",
                            "stop_charging": "Manual",
                            "stop_discharging": "Manual",
                            "charge_to_target_soc": "Manual",
                            "discharge_to_target_soc": "Manual",
                            "stop_export": "Feedin Priority",
                        },
                    }
                },
            },
            {
                "kind": "climate",
                "id": "living-room-hvac",
                "name": "Living Room HVAC",
                "controls": {"climate": {"entity_id": "climate.living_room"}},
                "consumption": {
                    "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.5},
                },
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
                "consumption": {
                    "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.2},
                },
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
        self.assertEqual(controllable_kinds_for_optimizer_kind("appliance_runtime"),
                         ("climate", "generic"))

    def test_the_two_directions_of_the_table_agree(self) -> None:
        """The inverse index is computed, so it cannot drift — pinned anyway,
        because the editor's target picker and the config validator both read
        it and a silent disagreement would be invisible until a user hit it."""
        for optimizer_kind in KNOWN_OPTIMIZER_KINDS:
            with self.subTest(optimizer_kind):
                for controllable_kind in controllable_kinds_for_optimizer_kind(
                    optimizer_kind
                ):
                    self.assertIn(
                        optimizer_kind,
                        CONTROLLABLE_SPECS[controllable_kind].optimizer_kinds,
                    )

    def test_every_optimizer_kind_targets_a_controllable_by_id(self) -> None:
        """No kind may infer its target from its own kind any more."""
        for kind, spec in OPTIMIZER_SPECS.items():
            with self.subTest(kind):
                self.assertIn(
                    "controllable_id", {field.key for field in spec.target}
                )


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
        config["controllables"][1:] = list(reversed(config["controllables"][1:]))
        payload = build_controllable_entities(
            control_config=read_schedule_control_config(config),
            registry=build_appliances_runtime_registry(config),
        )

        self.assertEqual(
            [entity["kind"] for entity in payload],
            ["inverter", "generic", "ev_charger", "climate"],
        )


class MigratedRuntimeEquivalenceTests(unittest.TestCase):
    """A v6 document must produce the runtime its v7 rewrite does.

    The acceptance criterion for the config unification, checked where the
    runtime objects actually live rather than on the migrated dict alone: a
    faithful-looking dict that the readers then interpret differently would
    pass a shape comparison and still break an installation on upgrade.
    """

    @staticmethod
    def _v6_config() -> dict:
        """The same installation as :func:`_config`, in the pre-v7 shape."""
        controllables = _config()["controllables"]
        inverter, *appliances = controllables
        mode = inverter["controls"]["mode"]
        return {
            "config_version": 6,
            "scheduler": {
                "control": {
                    "mode_entity_id": mode["entity_id"],
                    "action_option_map": dict(mode["options"]),
                }
            },
            "appliances": appliances,
        }

    def test_the_migrated_document_matches_the_v7_authored_one(self) -> None:
        migrated, _ids = migrate_config_document(self._v6_config())

        self.assertEqual(migrated["controllables"], _config()["controllables"])

    def test_the_inverter_runtime_survives_the_migration(self) -> None:
        migrated, _ids = migrate_config_document(self._v6_config())

        self.assertEqual(
            read_schedule_control_config(migrated),
            read_schedule_control_config(_config()),
        )

    def test_the_appliance_registry_survives_the_migration(self) -> None:
        migrated, _ids = migrate_config_document(self._v6_config())

        self.assertEqual(
            build_appliances_runtime_registry(migrated).appliances,
            build_appliances_runtime_registry(_config()).appliances,
        )

    def test_the_controllable_roster_survives_the_migration(self) -> None:
        migrated, _ids = migrate_config_document(self._v6_config())

        def roster(config: dict) -> list:
            return build_controllable_entities(
                control_config=read_schedule_control_config(config),
                registry=build_appliances_runtime_registry(config),
            )

        self.assertEqual(
            json.dumps(roster(migrated)), json.dumps(roster(_config()))
        )


class DeferrableConsumerReaderTests(unittest.TestCase):
    """``read_deferrable_consumers``: which controllables the house forecast
    carves out of its baseline, and what each one is called."""

    @staticmethod
    def _entry(controllable_id, *, meter=None, name=None, deferrable=None, kind="generic"):
        entry = {"kind": kind, "id": controllable_id}
        if name is not None:
            entry["name"] = name
        consumption = {}
        if meter is not None:
            consumption["energy_entity_id"] = meter
        if deferrable is not None:
            consumption["deferrable"] = deferrable
        if consumption:
            entry["consumption"] = consumption
        return entry

    def test_a_metered_controllable_is_deferrable_by_default(self) -> None:
        consumers = read_deferrable_consumers(
            {
                "controllables": [
                    self._entry("pool", meter="sensor.pool_energy", name="Pool pump")
                ]
            }
        )

        self.assertEqual(
            consumers,
            [
                {
                    "energy_entity_id": "sensor.pool_energy",
                    "label": "Pool pump",
                    "id": "pool",
                }
            ],
        )

    def test_the_controllable_id_rides_along_where_one_is_declared(self) -> None:
        """The key the forecast's scheduled demand is reported under.

        Without it a scheduled appliance could not be resolved back to the meter
        and the name the measured breakdown gives it, and the same device would
        read as two different rows either side of now. An entry that declares no
        id simply omits the key: it can never be scheduled, so nothing keys off
        it.
        """
        config = {
            "controllables": [
                self._entry("pool", meter="sensor.pool_energy", name="Pool pump"),
                {
                    "kind": "generic",
                    "name": "Anonymous",
                    "consumption": {"energy_entity_id": "sensor.anon"},
                },
            ]
        }

        self.assertEqual(
            [c.get("id") for c in read_deferrable_consumers(config)],
            ["pool", None],
        )

    def test_only_an_explicit_false_opts_a_device_out(self) -> None:
        config = {
            "controllables": [
                self._entry("a", meter="sensor.a", name="A", deferrable=False),
                self._entry("b", meter="sensor.b", name="B", deferrable=True),
                # Neither None nor a bad value shrinks the list: the default is
                # what a controllable means, not what it happens to say.
                self._entry("c", meter="sensor.c", name="C", deferrable="yes"),
            ]
        }

        self.assertEqual(
            [c["energy_entity_id"] for c in read_deferrable_consumers(config)],
            ["sensor.b", "sensor.c"],
        )

    def test_the_inverter_is_never_a_deferrable_consumer(self) -> None:
        config = {
            "controllables": [
                self._entry(
                    "inverter", meter="sensor.inverter", name="Inverter", kind="inverter"
                )
            ]
        }

        self.assertEqual(read_deferrable_consumers(config), [])

    def test_a_controllable_without_a_meter_contributes_nothing(self) -> None:
        config = {"controllables": [self._entry("rail", name="Towel rail")]}

        self.assertEqual(read_deferrable_consumers(config), [])

    def test_order_follows_the_list_and_a_duplicate_meter_is_taken_once(self) -> None:
        config = {
            "controllables": [
                self._entry("b", meter="sensor.b", name="B"),
                self._entry("a", meter="sensor.a", name="A"),
                self._entry("b2", meter="sensor.b", name="B again"),
            ]
        }

        self.assertEqual(
            [c["label"] for c in read_deferrable_consumers(config)], ["B", "A"]
        )

    def test_an_unnamed_device_is_labelled_by_its_meter(self) -> None:
        config = {"controllables": [self._entry("x", meter="sensor.x")]}

        self.assertEqual(read_deferrable_consumers(config)[0]["label"], "sensor.x")

    def test_a_config_without_controllables_yields_nothing(self) -> None:
        self.assertEqual(read_deferrable_consumers({}), [])
        self.assertEqual(read_deferrable_consumers(None), [])
        self.assertEqual(read_deferrable_consumers({"controllables": "nonsense"}), [])


class ScheduledConsumerReaderTests(unittest.TestCase):
    """``read_scheduled_consumers``: everything the planner can schedule demand
    for, which is a wider list than the deferrable one and keyed differently."""

    _entry = staticmethod(DeferrableConsumerReaderTests._entry)

    def test_a_meterless_controllable_still_gets_a_row(self) -> None:
        """The difference that matters against ``read_deferrable_consumers``.

        There is nothing to subtract from the house baseline for a device with
        no meter, so the deferrable roster drops it — but the planner schedules
        it all the same, and its forecast row has to be named after something.
        """
        config = {
            "controllables": [
                {
                    "kind": "ev_charger",
                    "id": "ev",
                    "name": "EV charger",
                    # Projected, and so scheduled, without ever being metered.
                    "consumption": {
                        "projection": {"strategy": "fixed", "hourly_energy_kwh": 7.0}
                    },
                }
            ]
        }

        self.assertEqual(
            read_scheduled_consumers(config),
            [
                {
                    "id": "ev",
                    "label": "EV charger",
                    "energy_entity_id": None,
                    "deferrable": True,
                }
            ],
        )

    def test_the_opt_out_is_carried_rather_than_filtered_on(self) -> None:
        """A device that opted out is still scheduled; it is just not shiftable.

        Filtering it out here, as the deferrable roster does, would leave its
        forecast row unnamed and assumed deferrable — the same appliance reading
        as two different things either side of now.
        """
        config = {
            "controllables": [
                self._entry("a", meter="sensor.a", name="A", deferrable=False),
                self._entry("b", meter="sensor.b", name="B"),
            ]
        }

        self.assertEqual(
            [(c["id"], c["deferrable"]) for c in read_scheduled_consumers(config)],
            [("a", False), ("b", True)],
        )

    def test_an_entry_with_no_id_is_skipped(self) -> None:
        """Nothing can be scheduled against it, so nothing keys off it."""
        config = {
            "controllables": [
                {"kind": "generic", "name": "Anonymous", "consumption": {}},
                self._entry("pool", meter="sensor.pool_energy", name="Pool pump"),
            ]
        }

        self.assertEqual([c["id"] for c in read_scheduled_consumers(config)], ["pool"])

    def test_an_unnamed_device_is_labelled_by_its_id(self) -> None:
        """Not by its meter: the row is identified by the controllable here."""
        config = {"controllables": [self._entry("x", meter="sensor.x")]}

        self.assertEqual(read_scheduled_consumers(config)[0]["label"], "x")

    def test_the_inverter_is_never_a_scheduled_consumer(self) -> None:
        config = {
            "controllables": [
                self._entry(
                    "inverter", meter="sensor.inverter", name="Inverter", kind="inverter"
                )
            ]
        }

        self.assertEqual(read_scheduled_consumers(config), [])

    def test_a_config_without_controllables_yields_nothing(self) -> None:
        self.assertEqual(read_scheduled_consumers({}), [])
        self.assertEqual(read_scheduled_consumers(None), [])
        self.assertEqual(read_scheduled_consumers({"controllables": "nonsense"}), [])


if __name__ == "__main__":
    unittest.main()
