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
    effective_meter,
    find_inverter_device,
    iter_devices,
    read_carved_meters,
    read_controllable_kinds_by_id,
    read_schedulable_consumers,
    read_shared_meters,
    resolve_device_name,
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
        "devices": [
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
                "schedulable": True,
                "id": "living-room-hvac",
                "name": "Living Room HVAC",
                "controls": {"climate": {"entity_id": "climate.living_room"}},
                "consumption": {
                    "projection": {"strategy": "fixed", "hourly_energy_kwh": 1.5},
                },
            },
            {
                "kind": "ev_charger",
                "schedulable": True,
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
                "schedulable": True,
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
                # Either flat, or once per member of an ordered group.
                keys = {field.key for field in spec.target} | {
                    child.key for field in spec.target for child in field.fields
                }
                self.assertIn("controllable_id", keys)


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
        config["devices"][1:] = list(reversed(config["devices"][1:]))
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
        controllables = _config()["devices"]
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

        self.assertEqual(migrated["devices"], _config()["devices"])

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


def _device(device_id, *, meter=None, name=None, schedulable=None, kind=None, **extra):
    device = {"id": device_id, **extra}
    if kind is not None:
        device["kind"] = kind
    if name is not None:
        device["name"] = name
    if schedulable is not None:
        device["schedulable"] = schedulable
    if meter is not None:
        device.setdefault("consumption", {})["energy_entity_id"] = meter
    return device


def _switched(device_id, **kwargs):
    """A meterless child, running by its own switch."""
    return _device(
        device_id,
        controls={"switch": {"entity_id": f"switch.{device_id}"}},
        **kwargs,
    )


def _ac_breaker():
    """Four schedulable climate children behind one passive breaker meter."""
    return _device(
        "jistic_klimatizace_energy",
        meter="sensor.jistic_klimatizace_energy",
        children=[
            _device(
                ac_id,
                kind="climate",
                schedulable=True,
                controls={"climate": {"entity_id": f"climate.{ac_id}"}},
            )
            for ac_id in ("ac-1", "ac-2", "ac-3", "ac-4")
        ],
    )


def _study():
    """A passive breaker with a schedulable sub-metered plug and a meterless lamp."""
    return _device(
        "study",
        meter="sensor.study_energy",
        children=[
            _device("plug", meter="sensor.plug_energy", schedulable=True),
            _switched("lamp"),
        ],
    )


class DeviceTreeReaderTests(unittest.TestCase):
    """The ``devices`` tree, flattened, and what is derived from it."""

    def test_the_tree_flattens_in_document_order_with_parents(self) -> None:
        config = {"devices": [_device("a"), _study(), _device("z")]}

        self.assertEqual(
            [
                (device["id"], None if parent is None else parent["id"])
                for device, parent in iter_devices(config)
            ],
            [
                ("a", None),
                ("study", None),
                ("plug", "study"),
                ("lamp", "study"),
                ("z", None),
            ],
        )

    def test_a_config_without_devices_yields_nothing(self) -> None:
        for config in ({}, None, {"devices": "nonsense"}):
            with self.subTest(config=config):
                self.assertEqual(list(iter_devices(config)), [])
                self.assertEqual(read_carved_meters(config), [])
                self.assertEqual(read_schedulable_consumers(config), [])
                self.assertEqual(read_shared_meters(config), {})

    def test_the_effective_meter_falls_back_to_the_parents(self) -> None:
        study = _study()
        plug, lamp = study["children"]

        self.assertEqual(effective_meter(plug, study), "sensor.plug_energy")
        self.assertEqual(effective_meter(lamp, study), "sensor.study_energy")
        self.assertIsNone(effective_meter(_device("x"), None))

    def test_children_are_indexed_by_id_with_the_default_kind(self) -> None:
        self.assertEqual(
            read_controllable_kinds_by_id({"devices": [_study()]}),
            {"study": "generic", "plug": "generic", "lamp": "generic"},
        )

    def test_the_inverter_is_found_at_the_top_level(self) -> None:
        inverter = _device("inverter", kind="inverter")

        self.assertIs(find_inverter_device({"devices": [_study(), inverter]}), inverter)
        self.assertEqual(find_inverter_device({"devices": [_study()]}), {})


class CarvedMeterReaderTests(unittest.TestCase):
    """``read_carved_meters``: whose own energy leaves the house baseline."""

    def test_a_schedulable_leaf_is_carved_under_its_own_id(self) -> None:
        config = {
            "devices": [
                _device("pool", meter="sensor.pool_energy", name="Pool pump", schedulable=True)
            ]
        }

        self.assertEqual(
            read_carved_meters(config),
            [
                {
                    "energy_entity_id": "sensor.pool_energy",
                    "label": "Pool pump",
                    "ids": ["pool"],
                    "metered_children": [],
                }
            ],
        )

    def test_a_passive_leaf_is_not_carved(self) -> None:
        config = {"devices": [_device("fridge", meter="sensor.fridge_energy")]}

        self.assertEqual(read_carved_meters(config), [])

    def test_a_parent_of_schedulable_meterless_children_is_carved_for_them(
        self,
    ) -> None:
        """The live AC breaker: one row, labelled by the meter, naming all four."""
        self.assertEqual(
            read_carved_meters({"devices": [_ac_breaker()]}),
            [
                {
                    "energy_entity_id": "sensor.jistic_klimatizace_energy",
                    "label": "sensor.jistic_klimatizace_energy",
                    "ids": ["ac-1", "ac-2", "ac-3", "ac-4"],
                    "metered_children": [],
                }
            ],
        )

    def test_a_passive_meterless_sibling_set_is_never_carved(self) -> None:
        breaker = _device(
            "breaker",
            meter="sensor.breaker_energy",
            children=[_switched("lamp"), _switched("radio")],
        )

        self.assertEqual(read_carved_meters({"devices": [breaker]}), [])

    def test_nested_meters_are_carved_once_each(self) -> None:
        """The study: the plug is carved on its own; the breaker only if its
        meterless children are all schedulable — here the lamp is passive."""
        self.assertEqual(
            [
                (meter["energy_entity_id"], meter["ids"], meter["metered_children"])
                for meter in read_carved_meters({"devices": [_study()]})
            ],
            [("sensor.plug_energy", ["plug"], [])],
        )

        study = _study()
        study["children"][1]["schedulable"] = True
        self.assertEqual(
            [
                (meter["energy_entity_id"], meter["ids"], meter["metered_children"])
                for meter in read_carved_meters({"devices": [study]})
            ],
            [
                ("sensor.study_energy", ["lamp"], ["sensor.plug_energy"]),
                ("sensor.plug_energy", ["plug"], []),
            ],
        )

    def test_the_inverter_is_never_carved(self) -> None:
        config = {"devices": [_device("inverter", kind="inverter", meter="sensor.x")]}

        self.assertEqual(read_carved_meters(config), [])


class SharedMeterReaderTests(unittest.TestCase):
    """``read_shared_meters``: who splits a meter, from the tree alone."""

    def test_a_meters_meterless_children_split_it_passive_ones_included(self) -> None:
        config = {"devices": [_study()]}

        self.assertEqual(
            read_shared_meters(config),
            {
                "sensor.study_energy": {
                    "members": [("lamp", "switch.lamp", "switch")],
                    "metered_children": ["sensor.plug_energy"],
                }
            },
        )

    def test_each_member_runs_by_its_own_control(self) -> None:
        shared = read_shared_meters({"devices": [_ac_breaker()]})

        self.assertEqual(
            shared["sensor.jistic_klimatizace_energy"]["members"],
            [(ac_id, f"climate.{ac_id}", "climate") for ac_id in ("ac-1", "ac-2", "ac-3", "ac-4")],
        )

    def test_a_meter_without_meterless_children_is_not_shared(self) -> None:
        study = _study()
        del study["children"][1]

        self.assertEqual(read_shared_meters({"devices": [study]}), {})


class SchedulableConsumerReaderTests(unittest.TestCase):
    """``read_schedulable_consumers``: everything the planner can schedule demand for."""

    def test_only_schedulable_devices_are_listed_at_every_level(self) -> None:
        config = {"devices": [_device("fridge", meter="sensor.fridge"), _ac_breaker(), _study()]}

        self.assertEqual(
            [consumer["id"] for consumer in read_schedulable_consumers(config)],
            ["ac-1", "ac-2", "ac-3", "ac-4", "plug"],
        )

    def test_a_meterless_child_names_its_effective_meter_and_carve_out(self) -> None:
        consumers = read_schedulable_consumers({"devices": [_ac_breaker()]})

        self.assertEqual(
            consumers[0],
            {
                "id": "ac-1",
                "label": "ac-1",
                "energy_entity_id": "sensor.jistic_klimatizace_energy",
                "deferrable": True,
            },
        )

    def test_the_inverter_is_never_a_scheduled_consumer(self) -> None:
        config = {"devices": [_device("inverter", kind="inverter", meter="sensor.x")]}

        self.assertEqual(read_schedulable_consumers(config), [])


class DeviceNameTests(unittest.TestCase):
    """``resolve_device_name``: one backend place for what every surface shows."""

    _NAMES = {
        "sensor.study_power": "Study breaker power",
        "sensor.study_energy": "Study breaker energy",
        "switch.lamp": "Lamp switch",
    }

    def _resolve(self, device, regex=r"\s+(power|energy|switch)$"):
        return resolve_device_name(
            device, friendly_name=self._NAMES.get, cleaner_regex=regex
        )

    def test_the_override_wins(self) -> None:
        self.assertEqual(self._resolve({**_study(), "name": "Study"}), "Study")

    def test_power_then_energy_then_control_each_cleaned(self) -> None:
        study = _study()
        study["consumption"]["power_entity_id"] = "sensor.study_power"
        self.assertEqual(self._resolve(study), "Study breaker")

        del study["consumption"]["power_entity_id"]
        self.assertEqual(self._resolve(study), "Study breaker")

        self.assertEqual(self._resolve(_switched("lamp")), "Lamp")

    def test_the_id_when_nothing_resolves(self) -> None:
        self.assertEqual(self._resolve(_device("ghost", meter="sensor.gone")), "ghost")


if __name__ == "__main__":
    unittest.main()
