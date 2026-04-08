from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"


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

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    try:
        import homeassistant.util.dt  # type: ignore  # noqa: F401
        import homeassistant.core  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
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

        dt_mod.parse_datetime = datetime.fromisoformat
        dt_mod.as_local = lambda value: value
        util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.appliances import (
    AppliancesRuntimeRegistry,
    ClimateApplianceRuntime,
    build_appliances_runtime_registry,
)
from custom_components.helman.scheduling.schedule import (
    ScheduleActionError,
    ScheduleDocument,
    ScheduleDomains,
    ScheduleSlot,
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
                "id": "dishwasher",
                "name": "Dishwasher",
                "controls": {
                    "switch": {
                        "entity_id": "switch.dishwasher",
                    }
                },
                "projection": {
                    "strategy": "fixed",
                    "hourly_energy_kwh": 1.1,
                },
            }
        )
    if include_climate:
        appliances.append(
            {
                "kind": "climate",
                "id": "living-room-hvac",
                "name": "Living Room HVAC",
                "controls": {
                    "climate": {
                        "entity_id": "climate.living_room",
                    }
                },
                "projection": {
                    "strategy": "fixed",
                    "hourly_energy_kwh": 1.5,
                },
            }
        )
    return {"appliances": appliances}


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
        "domains": {
            "inverter": {"kind": "normal"},
            "appliances": {} if appliances is None else appliances,
        },
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
            normalized[0].domains.appliances,
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
        config["appliances"][0]["controls"]["use_mode"]["values"] = {
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
            normalized[0].domains.appliances,
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
            normalized[0].domains.appliances,
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
            normalized[0].domains.appliances,
            {"dishwasher": {"on": True}},
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
            normalized[0].domains.appliances,
            {"living-room-hvac": {"mode": "heat"}},
        )

    def test_climate_action_rejects_off_mode(self) -> None:
        slot = slot_from_dict(
            _slot_payload(appliances={"living-room-hvac": {"mode": "off"}})
        )

        with self.assertRaises(ScheduleActionError):
            normalize_slot_patch_request(
                slots=[slot],
                reference_time=REFERENCE_TIME,
                battery_soc_bounds=None,
                appliances_registry=_registry(config=_valid_config(include_climate=True)),
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
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "normal"},
                        "appliances": {
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                                "ecoGear": "6A",
                            }
                        },
                    }
                },
            }
        )

        self.assertEqual(
            schedule_document_to_dict(doc),
            {
                "executionEnabled": False,
                "slotMinutes": 30,
                "slots": {
                    CURRENT_SLOT_ID: {
                        "inverter": {"kind": "normal"},
                        "appliances": {
                            "garage-ev": {
                                "charge": True,
                                "vehicleId": "kona",
                                "useMode": "Fast",
                                "ecoGear": "6A",
                            }
                        },
                    }
                },
            },
        )

    def test_load_normalization_drops_only_invalid_appliance_action(self) -> None:
        doc = ScheduleDocument(
            execution_enabled=False,
            slots={
                CURRENT_SLOT_ID: ScheduleDomains(
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
            normalized.slots[CURRENT_SLOT_ID].appliances,
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
                CURRENT_SLOT_ID: ScheduleDomains(
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
