from __future__ import annotations

import unittest
from datetime import datetime

from _ha_stubs import install_helman_packages


REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"


def _install_import_stubs() -> None:
    install_helman_packages("scheduling")

    import homeassistant.util.dt  # type: ignore  # noqa: F401
    import homeassistant.core  # type: ignore  # noqa: F401


_install_import_stubs()

from custom_components.helman.appliances import (
    AppliancesRuntimeRegistry,
    ClimateApplianceRuntime,
    build_appliances_runtime_registry,
)
from custom_components.helman.const import SCHEDULE_SLOT_MINUTES
from custom_components.helman.scheduling.schedule import (
    ScheduleActionError,
    ScheduleDocument,
    ScheduleSlot,
    appliance_actions,
    build_controllable_actions,
    inverter_action,
    normalize_schedule_document_for_registry,
    normalize_slot_patch_request,
    schedule_document_from_dict,
    schedule_document_to_dict,
    slot_from_dict,
)


def _valid_config(
    *,
    include_second_appliance: bool = False,
    include_generic: bool = False,
    include_climate: bool = False,
) -> dict:
    appliances = [
        {
            "kind": "ev_charger",
            "schedulable": True,
            "id": "garage-ev",
            "name": "Garage EV",
            "limits": {
                "max_charging_power_kw": 11.0,
            },
            "controls": {
                "charge": {
                    "entity_id": "switch.ev_nabijeni",
                },
                "use_mode": {
                    "entity_id": "select.solax_ev_charger_charger_use_mode",
                    "values": {
                        "Fast": {"behavior": "fixed_max_power"},
                        "ECO": {"behavior": "surplus_aware"},
                    },
                },
                "eco_gear": {
                    "entity_id": "select.solax_ev_charger_eco_gear",
                    "values": {
                        "6A": {"min_power_kw": 1.4},
                        "10A": {"min_power_kw": 2.3},
                    },
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
        }
    ]
    if include_second_appliance:
        appliances.append(
            {
                **appliances[0],
                "id": "driveway-ev",
                "name": "Driveway EV",
                "vehicles": [
                    {
                        "id": "tesla",
                        "name": "Tesla",
                        "telemetry": {
                            "soc_entity_id": "sensor.tesla_soc",
                        },
                        "limits": {
                            "battery_capacity_kwh": 82.0,
                            "max_charging_power_kw": 11.0,
                        },
                    }
                ],
            }
        )
    if include_generic:
        appliances.append(
            {
                "kind": "generic",
                "schedulable": True,
                "id": "dishwasher",
                "name": "Dishwasher",
                "controls": {
                    "switch": {
                        "entity_id": "switch.dishwasher",
                    }
                },
                "consumption": {
                    "projection": {
                        "strategy": "fixed",
                        "hourly_energy_kwh": 1.1,
                    },
                },
            }
        )
    if include_climate:
        appliances.append(
            {
                "kind": "climate",
                "schedulable": True,
                "id": "living-room-hvac",
                "name": "Living Room HVAC",
                "controls": {
                    "climate": {
                        "entity_id": "climate.living_room",
                    }
                },
                "consumption": {
                    "projection": {
                        "strategy": "fixed",
                        "hourly_energy_kwh": 1.5,
                    },
                },
            }
        )
    return {"devices": {"consumers": appliances}}


def _registry(
    *,
    include_second_appliance: bool = False,
    config: dict | None = None,
):
    return build_appliances_runtime_registry(
        config
        if config is not None
        else _valid_config(include_second_appliance=include_second_appliance)
    )


def _slot_payload(*, appliances: dict | None = None) -> dict:
    return {
        "id": CURRENT_SLOT_ID,
        "controllables": {} if appliances is None else appliances,
    }


class ScheduleApplianceTests(unittest.TestCase):
    def test_fast_action_is_normalized_and_drops_eco_gear(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "garage-ev": {
                        "charge": True,
                        "vehicleId": "kona",
                        "useMode": "Fast",
                        "ecoGear": "6A",
                    }
                }
            )
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {
                "garage-ev": {
                    "charge": True,
                    "vehicleId": "kona",
                    "useMode": "Fast",
                }
            },
        )

    def test_fixed_max_power_behavior_drops_eco_gear_for_custom_mode_name(self) -> None:
        config = _valid_config()
        config["devices"]["consumers"][0]["controls"]["use_mode"]["values"] = {
            "Boost": {"behavior": "fixed_max_power"},
            "Solar": {"behavior": "surplus_aware"},
        }
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "garage-ev": {
                        "charge": True,
                        "vehicleId": "kona",
                        "useMode": "Boost",
                        "ecoGear": "6A",
                    }
                }
            )
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(config=config),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {
                "garage-ev": {
                    "charge": True,
                    "vehicleId": "kona",
                    "useMode": "Boost",
                }
            },
        )

    def test_charge_false_accepts_omitted_vehicle_id(self) -> None:
        slot = slot_from_dict(
            _slot_payload(appliances={"garage-ev": {"charge": False}})
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {"garage-ev": {"charge": False}},
        )

    def test_charge_false_rejects_use_mode(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "garage-ev": {
                        "charge": False,
                        "useMode": "Fast",
                    }
                }
            )
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(),
            )

    def test_charge_true_eco_requires_eco_gear(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "garage-ev": {
                        "charge": True,
                        "vehicleId": "kona",
                        "useMode": "ECO",
                    }
                }
            )
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(),
            )

    def test_generic_on_action_is_normalized(self) -> None:
        slot = slot_from_dict(_slot_payload(appliances={"dishwasher": {"on": True}}))

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(config=_valid_config(include_generic=True)),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {"dishwasher": {"on": True}},
        )

    def test_generic_action_preserves_condition_met_candidate(self) -> None:
        # Regression: normalization rejected/dropped conditionMet, so a candidate
        # appliance action failed to persist and the old committed plan stayed
        # live (the executor kept running the appliance).
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "dishwasher": {
                        "on": True,
                        "setBy": "automation",
                        "conditionMet": False,
                    }
                }
            )
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(config=_valid_config(include_generic=True)),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {"dishwasher": {"on": True, "setBy": "automation", "conditionMet": False}},
        )

    def test_appliance_actions_preserve_set_by(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "garage-ev": {
                        "charge": True,
                        "vehicleId": "kona",
                        "useMode": "Fast",
                        "setBy": "user",
                    },
                    "dishwasher": {
                        "on": True,
                        "setBy": "automation",
                    },
                    "living-room-hvac": {
                        "mode": "heat",
                        "setBy": "user",
                    },
                }
            )
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(
                config=_valid_config(include_generic=True, include_climate=True)
            ),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {
                "garage-ev": {
                    "charge": True,
                    "vehicleId": "kona",
                    "useMode": "Fast",
                    "setBy": "user",
                },
                "dishwasher": {
                    "on": True,
                    "setBy": "automation",
                },
                "living-room-hvac": {
                    "mode": "heat",
                    "setBy": "user",
                },
            },
        )

    def test_generic_action_rejects_unsupported_fields(self) -> None:
        slot = slot_from_dict(
            _slot_payload(appliances={"dishwasher": {"on": True, "mode": "eco"}})
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(config=_valid_config(include_generic=True)),
            )

    def test_climate_mode_action_is_normalized(self) -> None:
        slot = slot_from_dict(
            _slot_payload(appliances={"living-room-hvac": {"mode": "heat"}})
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(config=_valid_config(include_climate=True)),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {"living-room-hvac": {"mode": "heat"}},
        )

    def test_climate_off_action_is_normalized(self) -> None:
        slot = slot_from_dict(
            _slot_payload(appliances={"living-room-hvac": {"mode": "off"}})
        )

        normalized = normalize_slot_patch_request(
            slots=[slot],
            reference_time=REFERENCE_TIME,
            battery_soc_bounds=None,
            appliances_registry=_registry(config=_valid_config(include_climate=True)),
        )

        self.assertEqual(
            appliance_actions(normalized[0].controllables),
            {"living-room-hvac": {"mode": "off"}},
        )

    def test_climate_action_rejects_mode_not_supported_by_runtime(self) -> None:
        slot = slot_from_dict(
            _slot_payload(appliances={"living-room-hvac": {"mode": "cool"}})
        )
        registry = AppliancesRuntimeRegistry.from_appliances(
            [
                ClimateApplianceRuntime(
                    id="living-room-hvac",
                    name="Living Room HVAC",
                    climate_entity_id="climate.living_room",
                    projection_strategy="fixed",
                    hourly_energy_kwh=1.5,
                    history_energy_entity_id=None,
                    supported_modes=("heat",),
                    stop_hvac_mode="off",
                )
            ]
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=registry,
            )

    def test_climate_action_rejects_unsupported_fields(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "living-room-hvac": {
                        "mode": "cool",
                        "targetTemperature": 22,
                    }
                }
            )
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(config=_valid_config(include_climate=True)),
            )

    def test_unknown_appliance_id_is_rejected(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "missing-ev": {
                        "charge": True,
                        "vehicleId": "kona",
                        "useMode": "Fast",
                    }
                }
            )
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(),
            )

    def test_unknown_vehicle_id_is_rejected(self) -> None:
        slot = slot_from_dict(
            _slot_payload(
                appliances={
                    "garage-ev": {
                        "charge": True,
                        "vehicleId": "missing-car",
                        "useMode": "Fast",
                    }
                }
            )
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(),
            )

    def test_schedule_document_round_trip_keeps_appliance_actions_structurally(self) -> None:
        doc = schedule_document_from_dict(
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                                "ecoGear": "6A",
                                "setBy": "user",
                            },
                    }
                },
            }
        )

        self.assertEqual(
            schedule_document_to_dict(doc),
            {
                "executionEnabled": False,
                "slotMinutes": SCHEDULE_SLOT_MINUTES,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                                "ecoGear": "6A",
                                "setBy": "user",
                            },
                    }
                },
            },
        )

    def test_load_normalization_drops_only_invalid_appliance_action(self) -> None:
        doc = ScheduleDocument(
            execution_enabled=False,
            slots={
                CURRENT_SLOT_ID: build_controllable_actions(
                    appliances={
                        "garage-ev": {
                            "charge": True,
                            "vehicleId": "kona",
                            "useMode": "Fast",
                        },
                        "missing-ev": {
                            "charge": True,
                            "vehicleId": "ghost",
                            "useMode": "Fast",
                        },
                    }
                )
            },
        )

        normalized = normalize_schedule_document_for_registry(
            doc,
            appliances_registry=_registry(include_second_appliance=True),
        )

        self.assertEqual(
            appliance_actions(normalized.slots[CURRENT_SLOT_ID]),
            {
                "garage-ev": {
                    "charge": True,
                    "vehicleId": "kona",
                    "useMode": "Fast",
                }
            },
        )

    def test_load_normalization_drops_slot_when_only_invalid_action_remains(self) -> None:
        doc = ScheduleDocument(
            execution_enabled=False,
            slots={
                CURRENT_SLOT_ID: build_controllable_actions(
                    appliances={
                        "missing-ev": {
                            "charge": True,
                            "vehicleId": "ghost",
                            "useMode": "Fast",
                        }
                    }
                )
            },
        )

        normalized = normalize_schedule_document_for_registry(
            doc,
            appliances_registry=_registry(),
        )

        self.assertEqual(normalized.slots, {})


if __name__ == "__main__":
    unittest.main()
