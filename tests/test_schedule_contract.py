from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
CURRENT_SLOT_ID = "2026-03-20T21:00:00+01:00"


def _install_voluptuous_stub() -> None:
    if "voluptuous" in sys.modules:
        return

    module = types.ModuleType("voluptuous")

    class Invalid(Exception):
        pass

    class _MissingType:
        pass

    _MISSING = _MissingType()

    class _Marker:
        def __init__(self, key: str, *, default: object = _MISSING) -> None:
            self.key = key
            self.default = default

    class Required(_Marker):
        pass

    class Optional(_Marker):
        pass

    def In(options):
        def validator(value):
            if value not in options:
                raise Invalid(f"Value {value!r} is not in {options!r}")
            return value

        return validator

    def Coerce(expected_type):
        def validator(value):
            try:
                return expected_type(value)
            except (TypeError, ValueError) as err:
                raise Invalid(str(err)) from err

        return validator

    def Range(*, min=None, max=None):
        def validator(value):
            if min is not None and value < min:
                raise Invalid(f"Value {value!r} is less than minimum {min!r}")
            if max is not None and value > max:
                raise Invalid(f"Value {value!r} is greater than maximum {max!r}")
            return value

        return validator

    def All(*validators):
        def validator(value):
            result = value
            for item in validators:
                result = _validate(item, result)
            return result

        return validator

    class Schema:
        def __init__(self, schema, *, extra=None) -> None:
            self._schema = schema
            self._extra = extra

        def __call__(self, value):
            return _validate(self._schema, value, extra=self._extra)

    PREVENT_EXTRA = object()

    def _validate(schema, value, *, extra=None):
        if isinstance(schema, Schema):
            return schema(value)

        if isinstance(schema, dict):
            if not isinstance(value, dict):
                raise Invalid("Expected a dict")

            result = {}
            seen_keys: set[str] = set()
            for key_spec, validator in schema.items():
                if isinstance(key_spec, _Marker):
                    key = key_spec.key
                    seen_keys.add(key)
                    if key in value:
                        result[key] = _validate(validator, value[key])
                        continue
                    if isinstance(key_spec, Optional) and key_spec.default is not _MISSING:
                        result[key] = _validate(validator, key_spec.default)
                        continue
                    if isinstance(key_spec, Required):
                        raise Invalid(f"Missing required key {key!r}")
                    continue

                seen_keys.add(key_spec)
                if key_spec not in value:
                    raise Invalid(f"Missing required key {key_spec!r}")
                result[key_spec] = _validate(validator, value[key_spec])

            if extra is PREVENT_EXTRA:
                extras = set(value) - seen_keys
                if extras:
                    raise Invalid(f"Extra keys not allowed: {sorted(extras)!r}")
            return result

        if isinstance(schema, list):
            if len(schema) != 1:
                raise Invalid("List schema must contain exactly one validator")
            if not isinstance(value, list):
                raise Invalid("Expected a list")
            return [_validate(schema[0], item) for item in value]

        if isinstance(schema, type):
            if not isinstance(value, schema):
                raise Invalid(f"Expected value of type {schema.__name__}")
            return value

        if callable(schema):
            return schema(value)

        if value != schema:
            raise Invalid(f"Expected {schema!r}")
        return value

    module.All = All
    module.Coerce = Coerce
    module.In = In
    module.Invalid = Invalid
    module.Optional = Optional
    module.PREVENT_EXTRA = PREVENT_EXTRA
    module.Range = Range
    module.Required = Required
    module.Schema = Schema
    sys.modules["voluptuous"] = module


try:
    import voluptuous as vol
except ModuleNotFoundError:
    _install_voluptuous_stub()
    import voluptuous as vol


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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    websocket_api_mod = sys.modules.get("homeassistant.components.websocket_api")
    if websocket_api_mod is None:
        websocket_api_mod = types.ModuleType("homeassistant.components.websocket_api")
        sys.modules["homeassistant.components.websocket_api"] = websocket_api_mod
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

    helpers_pkg = sys.modules.get("homeassistant.helpers")
    if helpers_pkg is None:
        helpers_pkg = types.ModuleType("homeassistant.helpers")
        sys.modules["homeassistant.helpers"] = helpers_pkg

    storage_mod = sys.modules.get("homeassistant.helpers.storage")
    if storage_mod is None:
        storage_mod = types.ModuleType("homeassistant.helpers.storage")
        sys.modules["homeassistant.helpers.storage"] = storage_mod

    class DummyStore:
        def __init__(self, hass, version, key) -> None:
            self._data = None

        async def async_load(self):
            return self._data

        async def async_save(self, data) -> None:
            self._data = data

    storage_mod.Store = DummyStore
    helpers_pkg.storage = storage_mod

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.as_local = lambda value: value
    dt_mod.now = lambda: REFERENCE_TIME
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.const import DOMAIN  # noqa: E402
from custom_components.helman.websockets import (  # noqa: E402
    SET_SCHEDULE_REQUEST_SCHEMA,
    ws_get_appliance_projections,
    ws_get_appliances,
    ws_set_schedule,
)
from custom_components.helman.scheduling.schedule import ScheduleActionError  # noqa: E402


class FakeCoordinator:
    def __init__(self) -> None:
        self.schedule_calls = []
        self.schedule_error = None
        self.appliances_response = {"appliances": []}
        self.projections_response = {
            "generatedAt": CURRENT_SLOT_ID,
            "appliances": {
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
                }
            },
        }

    async def set_schedule(self, *, slots) -> None:
        if self.schedule_error is not None:
            raise self.schedule_error
        self.schedule_calls.append(list(slots))

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
                        "domains": {
                            "inverter": {
                                "kind": "charge_to_target_soc",
                                "targetSoc": 80,
                            },
                            "appliances": {},
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
                        "domains": {
                            "inverter": {
                                "kind": "charge_to_target_soc",
                                "targetSoc": 80,
                            },
                            "appliances": {},
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
                        "domains": {
                            "inverter": {"kind": "stop_export"},
                            "appliances": {},
                        },
                    }
                ],
            }
        )

        self.assertEqual(
            payload["slots"][0]["domains"]["inverter"]["kind"],
            "stop_export",
        )

    async def test_set_schedule_forwards_domains_slots(self) -> None:
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
                            "domains": {
                                "inverter": {
                                    "kind": "charge_to_target_soc",
                                    "targetSoc": 80,
                                },
                                "appliances": {},
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        self.assertEqual(len(coordinator.schedule_calls), 1)
        self.assertEqual(len(coordinator.schedule_calls[0]), 1)
        slot = coordinator.schedule_calls[0][0]
        self.assertEqual(slot.id, CURRENT_SLOT_ID)
        self.assertEqual(slot.domains.inverter.kind, "charge_to_target_soc")
        self.assertEqual(slot.domains.inverter.target_soc, 80)
        self.assertEqual(slot.domains.appliances, {})
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
                            "domains": {
                                "inverter": {"kind": "normal"},
                                "appliances": {
                                    "garage-ev": {
                                        "charge": True,
                                        "vehicleId": "kona",
                                        "useMode": "Fast",
                                        "ecoGear": "6A",
                                    }
                                },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0][0]
        self.assertEqual(
            slot.domains.appliances,
            {
                "garage-ev": {
                    "charge": True,
                    "vehicleId": "kona",
                    "useMode": "Fast",
                    "ecoGear": "6A",
                }
            },
        )
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
                            "domains": {
                                "inverter": {"kind": "normal"},
                                "appliances": {
                                    "living-room-hvac": {
                                        "mode": "heat",
                                    }
                                },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0][0]
        self.assertEqual(
            slot.domains.appliances,
            {
                "living-room-hvac": {
                    "mode": "heat",
                }
            },
        )
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
                            "domains": {
                                "inverter": {"kind": "normal"},
                                "appliances": {
                                    "living-room-hvac": {
                                        "mode": "off",
                                    }
                                },
                            },
                        }
                    ],
                }
            ),
        }

        await ws_set_schedule(FakeHass(coordinator), connection, msg)

        slot = coordinator.schedule_calls[0][0]
        self.assertEqual(
            slot.domains.appliances,
            {
                "living-room-hvac": {
                    "mode": "off",
                }
            },
        )
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
                            "domains": {
                                "inverter": {"kind": "normal"},
                                "appliances": {
                                    "garage-ev": {
                                        "charge": True,
                                    }
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
                        "appliances": {
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
                            }
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
