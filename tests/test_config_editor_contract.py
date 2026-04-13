from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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

    module.Coerce = Coerce
    module.In = In
    module.Invalid = Invalid
    module.Optional = Optional
    module.PREVENT_EXTRA = PREVENT_EXTRA
    module.Required = Required
    module.Schema = Schema
    sys.modules["voluptuous"] = module


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
    dt_mod.as_utc = lambda value: value
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-05T12:00:00+00:00")
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_voluptuous_stub()
_install_import_stubs()

from custom_components.helman.automation import config as automation_config_module
from custom_components.helman.const import DOMAIN
from custom_components.helman.websockets import (
    ws_get_config,
    ws_save_config,
    ws_validate_config,
)


def _invalid_config() -> dict:
    return {
        "scheduler": {
            "control": {
                "mode_entity_id": "sensor.invalid",
                "action_option_map": {
                    "normal": "Normal",
                },
            }
        }
    }


class FakeStorage:
    def __init__(self, config: dict | None = None) -> None:
        self.config = config or {}
        self.saved_payloads: list[dict] = []

    async def async_save(self, new_config: dict) -> None:
        self.saved_payloads.append(new_config)
        self.config = new_config


class FakeUser:
    def __init__(self, *, is_admin: bool) -> None:
        self.is_admin = is_admin


class FakeConnection:
    def __init__(self, *, is_admin: bool) -> None:
        self.user = FakeUser(is_admin=is_admin)
        self.results: list[tuple[int, dict]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: dict) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class FakeConfigEntry:
    def __init__(self, entry_id: str) -> None:
        self.entry_id = entry_id


class FakeConfigEntries:
    def __init__(
        self,
        *,
        reload_result: bool = True,
        reload_error: Exception | None = None,
    ) -> None:
        self.reload_calls: list[str] = []
        self.entries = [FakeConfigEntry("entry-1")]
        self.reload_result = reload_result
        self.reload_error = reload_error

    def async_entries(self, domain: str):
        return list(self.entries)

    async def async_reload(self, entry_id: str) -> bool:
        self.reload_calls.append(entry_id)
        if self.reload_error is not None:
            raise self.reload_error
        return self.reload_result


class FakeHass:
    def __init__(
        self,
        storage: FakeStorage | None,
        *,
        config_entries: FakeConfigEntries | None = None,
    ) -> None:
        domain_data = {}
        if storage is not None:
            domain_data["storage"] = storage
        self.data = {DOMAIN: domain_data}
        self.config_entries = config_entries or FakeConfigEntries()


class ConfigEditorContractTests(unittest.IsolatedAsyncioTestCase):
    def _set_known_optimizer_kinds(self, *kinds: str) -> None:
        original = automation_config_module.KNOWN_OPTIMIZER_KINDS
        automation_config_module.KNOWN_OPTIMIZER_KINDS = frozenset(kinds)
        self.addCleanup(
            setattr,
            automation_config_module,
            "KNOWN_OPTIMIZER_KINDS",
            original,
        )

    def test_get_config_requires_admin(self) -> None:
        connection = FakeConnection(is_admin=False)

        ws_get_config(
            FakeHass(FakeStorage({"history_buckets": 60})),
            connection,
            {"id": 1, "type": "helman/get_config"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    def test_get_config_returns_config_for_admin(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_get_config(
            FakeHass(FakeStorage({"history_buckets": 60})),
            connection,
            {"id": 1, "type": "helman/get_config"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, {"history_buckets": 60})])

    def test_get_config_returns_automation_block_unchanged(self) -> None:
        connection = FakeConnection(is_admin=True)
        config = {
            "automation": {
                "enabled": False,
                "optimizers": [],
                "unknown_key": "preserve-me",
            }
        }

        ws_get_config(
            FakeHass(FakeStorage(config)),
            connection,
            {"id": 1, "type": "helman/get_config"},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, config)])

    def test_validate_config_returns_structured_report(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_validate_config(
            FakeHass(FakeStorage()),
            connection,
            {"id": 1, "type": "helman/validate_config", "config": _invalid_config()},
        )

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results[0][0], 1)
        self.assertFalse(connection.results[0][1]["valid"])
        self.assertIn("errors", connection.results[0][1])

    def test_validate_config_reports_unknown_optimizer_kind_for_automation_payload(self) -> None:
        connection = FakeConnection(is_admin=True)

        ws_validate_config(
            FakeHass(FakeStorage()),
            connection,
            {
                "id": 1,
                "type": "helman/validate_config",
                "config": {
                    "automation": {
                        "enabled": True,
                        "optimizers": [
                            {
                                "id": "export",
                                "kind": "does_not_exist",
                            }
                        ],
                    }
                },
            },
        )

        self.assertEqual(connection.errors, [])
        self.assertFalse(connection.results[0][1]["valid"])
        self.assertEqual(
            connection.results[0][1]["errors"][0]["section"],
            "automation",
        )
        self.assertEqual(
            connection.results[0][1]["errors"][0]["path"],
            "automation.optimizers[0].kind",
        )
        self.assertIn("does_not_exist", connection.results[0][1]["errors"][0]["message"])

    async def test_save_config_does_not_persist_invalid_document(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)

        await ws_save_config(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": _invalid_config()},
        )

        self.assertEqual(storage.saved_payloads, [])
        self.assertEqual(hass.config_entries.reload_calls, [])
        self.assertEqual(connection.errors, [])
        self.assertFalse(connection.results[0][1]["success"])
        self.assertFalse(connection.results[0][1]["reloadStarted"])

    async def test_save_config_persists_and_reloads_valid_document(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)

        await ws_save_config(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": {}},
        )

        self.assertEqual(storage.saved_payloads, [{}])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertEqual(connection.errors, [])
        self.assertTrue(connection.results[0][1]["success"])
        self.assertTrue(connection.results[0][1]["reloadStarted"])
        self.assertTrue(connection.results[0][1]["reloadSucceeded"])
        self.assertIsNone(connection.results[0][1]["reloadError"])

    async def test_save_config_persists_minimal_automation_config(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "automation": {
                "enabled": True,
                "optimizers": [],
            }
        }

        await ws_save_config(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [config])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertTrue(connection.results[0][1]["success"])

    async def test_save_config_preserves_optimizers_when_disabling_automation(self) -> None:
        self._set_known_optimizer_kinds("alpha")
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "automation": {
                "enabled": False,
                "optimizers": [
                    {
                        "id": "export",
                        "kind": "alpha",
                        "params": {"window_hours": 2},
                        "future_flag": True,
                    }
                ],
            }
        }

        await ws_save_config(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [config])
        self.assertEqual(
            storage.config["automation"]["optimizers"],
            config["automation"]["optimizers"],
        )
        self.assertTrue(connection.results[0][1]["success"])

    async def test_save_config_persists_surplus_appliance_optimizer(self) -> None:
        self._set_known_optimizer_kinds("export_price", "surplus_appliance")
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(storage)
        config = {
            "appliances": [
                {
                    "kind": "generic",
                    "id": "dishwasher",
                    "name": "Dishwasher",
                    "controls": {
                        "switch": {"entity_id": "switch.dishwasher"},
                    },
                    "projection": {
                        "strategy": "fixed",
                        "hourly_energy_kwh": 1.2,
                    },
                }
            ],
            "automation": {
                "enabled": True,
                "optimizers": [
                    {
                        "id": "preheat-living-room",
                        "kind": "surplus_appliance",
                        "enabled": True,
                        "params": {
                            "appliance_id": "dishwasher",
                            "action": "on",
                            "min_surplus_buffer_pct": 5,
                        },
                    }
                ],
            }
        }

        await ws_save_config(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": config},
        )

        self.assertEqual(storage.saved_payloads, [config])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertTrue(connection.results[0][1]["success"])

    async def test_save_config_reports_reload_failure_after_persisting_document(self) -> None:
        storage = FakeStorage()
        connection = FakeConnection(is_admin=True)
        hass = FakeHass(
            storage,
            config_entries=FakeConfigEntries(
                reload_error=RuntimeError("reload failed"),
            ),
        )

        await ws_save_config(
            hass,
            connection,
            {"id": 1, "type": "helman/save_config", "config": {}},
        )

        self.assertEqual(storage.saved_payloads, [{}])
        self.assertEqual(hass.config_entries.reload_calls, ["entry-1"])
        self.assertEqual(connection.errors, [])
        self.assertFalse(connection.results[0][1]["success"])
        self.assertTrue(connection.results[0][1]["reloadStarted"])
        self.assertFalse(connection.results[0][1]["reloadSucceeded"])
        self.assertEqual(connection.results[0][1]["reloadError"], "reload failed")


if __name__ == "__main__":
    unittest.main()
