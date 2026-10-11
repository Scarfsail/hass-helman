from __future__ import annotations

import importlib
import sys
import unittest
from datetime import datetime

import voluptuous as vol
from _ha_stubs import install_helman_packages, stub_module

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"


def _install_import_stubs() -> None:
    install_helman_packages("scheduling")
    stub_module("homeassistant")
    core_mod = stub_module("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func

    components_pkg = stub_module("homeassistant.components")
    websocket_api_mod = stub_module("homeassistant.components.websocket_api")
    websocket_api_mod.ActiveConnection = type("ActiveConnection", (), {})
    websocket_api_mod.async_register_command = lambda hass, command: None
    websocket_api_mod.async_response = lambda func: func

    def websocket_command(schema):
        def decorator(func):
            func.websocket_schema = schema
            return func

        return decorator

    websocket_api_mod.websocket_command = websocket_command
    components_pkg.websocket_api = websocket_api_mod

    helpers_pkg = stub_module("homeassistant.helpers")
    storage_mod = stub_module("homeassistant.helpers.storage")

    class DummyStore:
        def __init__(self, hass, version, key) -> None:
            self._data = None

        async def async_load(self):
            return self._data

        async def async_save(self, data) -> None:
            self._data = data

    storage_mod.Store = DummyStore
    helpers_pkg.storage = storage_mod

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt", as_local=lambda value: value)
    dt_mod.now = lambda: REFERENCE_TIME
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()
sys.modules.pop("custom_components.helman.websockets", None)

from custom_components.helman.const import DOMAIN  # noqa: E402
websockets_module = importlib.import_module("custom_components.helman.websockets")
SET_SCHEDULE_REQUEST_SCHEMA = websockets_module.SET_SCHEDULE_REQUEST_SCHEMA
ws_get_appliance_projections = websockets_module.ws_get_appliance_projections
ws_get_appliances = websockets_module.ws_get_appliances
ws_set_schedule = websockets_module.ws_set_schedule
from custom_components.helman.scheduling.schedule import (  # noqa: E402
    ScheduleActionError,
    appliance_actions,
    build_controllable_actions,
    inverter_action,
)


class FakeCoordinator:
    def __init__(self) -> None:
        self.schedule_calls = []
        self.schedule_error = None
        self.appliances_response = {"appliances": []}
        self.projections_response = {
            "generatedAt": CURRENT_SLOT_ID,
            "garage-ev": {
                    "series": [
                        {
                            "slotId": CURRENT_SLOT_ID,
                            "energyKwh": 1.75,
                            "mode": "Fast",
                            "vehicleId": "kona",
                            "vehicleSoc": 58,
                        }
                    ]
                },
        }

    async def set_schedule(self, *, slots, set_by=None) -> None:
        if self.schedule_error is not None:
            raise self.schedule_error
        self.schedule_calls.append({"slots": list(slots), "set_by": set_by})

    async def get_appliances(self) -> dict:
        return self.appliances_response

    async def get_appliance_projections(self) -> dict:
        return self.projections_response


class FakeConnection:
    def __init__(self) -> None:
        self.results: list[tuple[int, dict]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: dict) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class FakeHass:
    def __init__(self, coordinator: FakeCoordinator | None) -> None:
        self.data = {DOMAIN: {"coordinator": coordinator}}


class ScheduleContractTests(unittest.IsolatedAsyncioTestCase):
    def test_set_schedule_schema_accepts_domains_shape(self) -> None:
        payload = SET_SCHEDULE_REQUEST_SCHEMA(
            {
                "type": "helman/set_schedule",
                "slots": [
                    {
                        "id": CURRENT_SLOT_ID,
                        "controllables": {
                            "inverter": {
                                "kind": "charge_to_target_soc",
                                "targetSoc": 80,
                            },
                        },
                    }
                ],
            }
        )

        self.assertEqual(
            payload,
            {
                "type": "helman/set_schedule",
                "slots": [
                    {
                        "id": CURRENT_SLOT_ID,
                        "controllables": {
                            "inverter": {
                                "kind": "charge_to_target_soc",
                                "targetSoc": 80,
                            },
                        },
                    }
                ],
            },
        )

    def test_set_schedule_schema_accepts_stop_export_action(self) -> None:
        payload = SET_SCHEDULE_REQUEST_SCHEMA(
            {
                "type": "helman/set_schedule",
                "slots": [
                    {
                        "id": CURRENT_SLOT_ID,
                        "controllables": {
                            "inverter": {"kind": "stop_export"},
                        },
                    }
                ],
            }
        )

        self.assertEqual(
            payload["slots"][0]["controllables"]["inverter"]["kind"],
            "stop_export",
        )

    def test_set_schedule_schema_accepts_a_slot_with_nothing_scheduled(self) -> None:
        # "Nothing scheduled" is an empty map now, for every controllable
        # alike, rather than an explicit empty inverter action beside an empty
        # appliance map.
        payload = SET_SCHEDULE_REQUEST_SCHEMA(
            {
                "type": "helman/set_schedule",
                "slots": [
                    {
                        "id": CURRENT_SLOT_ID,
                        "controllables": {},
                    }
                ],
            }
        )

        self.assertEqual(payload["slots"][0]["controllables"], {})

    async def test_set_schedule_forwards_controllables_slots(self) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "controllables": {
                                "inverter": {
                                    "kind": "charge_to_target_soc",
                                    "targetSoc": 80,
                                },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        self.assertEqual(len(coordinator.schedule_calls), 1)
        self.assertEqual(len(coordinator.schedule_calls[0]["slots"]), 1)
        self.assertEqual(coordinator.schedule_calls[0]["set_by"], "user")
        slot = coordinator.schedule_calls[0]["slots"][0]
        self.assertEqual(slot.id, CURRENT_SLOT_ID)
        self.assertEqual(inverter_action(slot.controllables).kind, "charge_to_target_soc")
        self.assertEqual(inverter_action(slot.controllables).target_soc, 80)
        self.assertEqual(appliance_actions(slot.controllables), {})
        self.assertEqual(connection.results, [(1, {"success": True})])
        self.assertEqual(connection.errors, [])

    async def test_set_schedule_rejects_legacy_action_payload_with_clear_error(
        self,
    ) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "action": {"kind": "normal"},
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        self.assertEqual(coordinator.schedule_calls, [])
        self.assertEqual(connection.results, [])
        self.assertEqual(len(connection.errors), 1)
        self.assertEqual(connection.errors[0][0], 1)
        self.assertEqual(connection.errors[0][1], "invalid_action")
        self.assertIn(
            "Legacy schedule payload uses top-level 'action'",
            connection.errors[0][2],
        )

    async def test_set_schedule_forwards_non_empty_appliance_domains(self) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "controllables": {
                                "garage-ev": {
                                        "charge": True,
                                        "vehicleId": "kona",
                                        "useMode": "Fast",
                                        "ecoGear": "6A",
                                    },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0]["slots"][0]
        self.assertEqual(
            appliance_actions(slot.controllables),
            {
                "garage-ev": {
                    "charge": True,
                    "vehicleId": "kona",
                    "useMode": "Fast",
                    "ecoGear": "6A",
                }
            },
        )
        self.assertEqual(coordinator.schedule_calls[0]["set_by"], "user")
        self.assertEqual(connection.results, [(1, {"success": True})])
        self.assertEqual(connection.errors, [])

    async def test_set_schedule_forwards_climate_appliance_action(self) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "controllables": {
                                "living-room-hvac": {
                                        "mode": "heat",
                                    },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0]["slots"][0]
        self.assertEqual(
            appliance_actions(slot.controllables),
            {
                "living-room-hvac": {
                    "mode": "heat",
                }
            },
        )
        self.assertEqual(coordinator.schedule_calls[0]["set_by"], "user")
        self.assertEqual(connection.results, [(1, {"success": True})])
        self.assertEqual(connection.errors, [])

    async def test_set_schedule_forwards_climate_off_action(self) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "controllables": {
                                "living-room-hvac": {
                                        "mode": "off",
                                    },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0]["slots"][0]
        self.assertEqual(
            appliance_actions(slot.controllables),
            {
                "living-room-hvac": {
                    "mode": "off",
                }
            },
        )
        self.assertEqual(coordinator.schedule_calls[0]["set_by"], "user")
        self.assertEqual(connection.results, [(1, {"success": True})])
        self.assertEqual(connection.errors, [])

    async def test_set_schedule_websocket_defaults_user_without_overwriting_explicit_set_by(
        self,
    ) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "controllables": {
                                "inverter": {
                                    "kind": "normal",
                                    "setBy": "automation",
                                },
                                "garage-ev": {
                                        "charge": True,
                                        "vehicleId": "kona",
                                        "useMode": "Fast",
                                        "setBy": "automation",
                                    },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0]["slots"][0]
        self.assertEqual(coordinator.schedule_calls[0]["set_by"], "user")
        self.assertEqual(inverter_action(slot.controllables).set_by, "automation")
        self.assertEqual(appliance_actions(slot.controllables)["garage-ev"]["setBy"], "automation")
        self.assertEqual(connection.results, [(1, {"success": True})])
        self.assertEqual(connection.errors, [])

    async def test_set_schedule_surfaces_coordinator_validation_error(self) -> None:
        coordinator = FakeCoordinator()
        coordinator.schedule_error = ScheduleActionError("bad appliance action")
        connection = FakeConnection()
        msg = {
            "id": 1,
            **SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": [
                        {
                            "id": CURRENT_SLOT_ID,
                            "controllables": {
                                "garage-ev": {
                                        "charge": True,
                                    },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors, [(1, "invalid_action", "bad appliance action")])

    async def test_get_appliances_returns_stable_empty_payload(self) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()

        await ws_get_appliances(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/get_appliances"},
        )

        self.assertEqual(connection.results, [(1, {"appliances": []})])
        self.assertEqual(connection.errors, [])

    async def test_get_appliance_projections_returns_appliance_series_payload(
        self,
    ) -> None:
        coordinator = FakeCoordinator()
        connection = FakeConnection()

        await ws_get_appliance_projections(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/get_appliance_projections"},
        )

        self.assertEqual(
            connection.results,
            [
                (
                    1,
                    {
                        "generatedAt": CURRENT_SLOT_ID,
                        "garage-ev": {
                                "series": [
                                    {
                                        "slotId": CURRENT_SLOT_ID,
                                        "energyKwh": 1.75,
                                        "mode": "Fast",
                                        "vehicleId": "kona",
                                        "vehicleSoc": 58,
                                    }
                                ]
                            },
                    },
                )
            ],
        )
        self.assertEqual(connection.errors, [])

    def test_invalid_request_shape_still_uses_voluptuous_validation(self) -> None:
        with self.assertRaises(vol.Invalid):
            SET_SCHEDULE_REQUEST_SCHEMA(
                {
                    "type": "helman/set_schedule",
                    "slots": "not-a-list",
                }
            )


if __name__ == "__main__":
    unittest.main()
