from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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


try:
    import voluptuous as vol  # noqa: F401
except ModuleNotFoundError:
    _install_voluptuous_stub()


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

    solar_bias_pkg = sys.modules.get("custom_components.helman.solar_bias_correction")
    if solar_bias_pkg is None:
        solar_bias_pkg = types.ModuleType("custom_components.helman.solar_bias_correction")
        sys.modules["custom_components.helman.solar_bias_correction"] = solar_bias_pkg
    solar_bias_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "solar_bias_correction")
    ]

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
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-24T03:00:00+02:00")
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod

    service_mod = types.ModuleType(
        "custom_components.helman.solar_bias_correction.service"
    )

    class TrainingInProgressError(RuntimeError):
        pass

    class BiasNotConfiguredError(RuntimeError):
        pass

    service_mod.TrainingInProgressError = TrainingInProgressError
    service_mod.BiasNotConfiguredError = BiasNotConfiguredError
    sys.modules[service_mod.__name__] = service_mod


_install_import_stubs()

from custom_components.helman.const import DOMAIN  # noqa: E402


class FakeConnection:
    def __init__(self, *, is_admin: bool = True) -> None:
        self.user = SimpleNamespace(is_admin=is_admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class FakeHass:
    def __init__(self, coordinator) -> None:
        self.data = {DOMAIN: {"coordinator": coordinator}}


def _load_websocket_modules(testcase: unittest.TestCase):
    for module_name in (
        "custom_components.helman.solar_bias_correction.websocket",
        "custom_components.helman.websockets",
    ):
        sys.modules.pop(module_name, None)

    try:
        solar_bias_ws = importlib.import_module(
            "custom_components.helman.solar_bias_correction.websocket"
        )
    except ModuleNotFoundError as err:
        testcase.fail(f"solar bias websocket module missing: {err}")

    try:
        websockets_mod = importlib.import_module("custom_components.helman.websockets")
    except ModuleNotFoundError as err:
        testcase.fail(f"helman websockets module missing: {err}")

    return solar_bias_ws, websockets_mod


class SolarBiasWebsocketTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.solar_bias_ws, self.websockets_mod = _load_websocket_modules(self)

    def test_status_returns_service_payload(self) -> None:
        payload = {"status": "applied", "enabled": True}
        service = SimpleNamespace(get_status_payload=Mock(return_value=payload))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_status(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/status"},
        )

        service.get_status_payload.assert_called_once_with()
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    def test_status_requires_admin(self) -> None:
        service = SimpleNamespace(get_status_payload=Mock())
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        self.solar_bias_ws.ws_get_solar_bias_status(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/status"},
        )

        service.get_status_payload.assert_not_called()
        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    def test_status_returns_not_loaded_when_service_or_coordinator_missing(self) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(_solar_bias_service=None),
                [
                    (
                        1,
                        "not_loaded",
                        "Helman solar bias correction service not available",
                    )
                ],
            ),
        )

        for coordinator, expected_error in cases:
            with self.subTest(coordinator=coordinator):
                connection = FakeConnection()

                self.solar_bias_ws.ws_get_solar_bias_status(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/status"},
                )

                self.assertEqual(connection.results, [])
                self.assertEqual(connection.errors, expected_error)

    async def test_train_now_returns_fresh_payload_on_success(self) -> None:
        payload = {"status": "applied", "trainedAt": "2026-04-24T03:00:00+02:00"}
        service = SimpleNamespace(async_train=AsyncMock(return_value=payload))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_train_solar_bias_now(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        service.async_train.assert_awaited_once_with()
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    async def test_train_now_requires_admin(self) -> None:
        service = SimpleNamespace(async_train=AsyncMock())
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        await self.solar_bias_ws.ws_train_solar_bias_now(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        service.async_train.assert_not_awaited()
        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    async def test_train_now_returns_not_loaded_when_missing(self) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(_solar_bias_service=None),
                [
                    (
                        1,
                        "not_loaded",
                        "Helman solar bias correction service not available",
                    )
                ],
            ),
        )

        for coordinator, expected_error in cases:
            with self.subTest(coordinator=coordinator):
                connection = FakeConnection()

                await self.solar_bias_ws.ws_train_solar_bias_now(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/train_now"},
                )

                self.assertEqual(connection.results, [])
                self.assertEqual(connection.errors, expected_error)

    async def test_train_now_returns_training_in_progress(self) -> None:
        training_in_progress_error, _ = self.solar_bias_ws._get_training_error_types()
        service = SimpleNamespace(
            async_train=AsyncMock(
                side_effect=training_in_progress_error(
                    "Solar bias training already in progress"
                )
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_train_solar_bias_now(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "training_in_progress", "Solar bias training already in progress")],
        )

    async def test_train_now_returns_bias_correction_not_configured(self) -> None:
        _, bias_not_configured_error = self.solar_bias_ws._get_training_error_types()
        service = SimpleNamespace(
            async_train=AsyncMock(
                side_effect=bias_not_configured_error(
                    "Solar bias correction is disabled"
                )
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_train_solar_bias_now(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/train_now"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [
                (
                    1,
                    "bias_correction_not_configured",
                    "Solar bias correction is disabled",
                )
            ],
        )

    async def test_train_now_returns_internal_error_and_logs(self) -> None:
        service = SimpleNamespace(
            async_train=AsyncMock(
                return_value={
                    "status": "training_failed",
                    "errorReason": "boom",
                    "trainedAt": "2026-04-24T03:00:00+02:00",
                }
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        with self.assertLogs(
            "custom_components.helman.solar_bias_correction.websocket",
            level="ERROR",
        ) as captured:
            await self.solar_bias_ws.ws_train_solar_bias_now(
                FakeHass(coordinator),
                connection,
                {"id": 1, "type": "helman/solar_bias/train_now"},
            )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "internal_error", "Unexpected solar bias training failure")],
        )
        self.assertIn("Unexpected solar bias training failure", captured.output[0])

    async def test_train_now_returns_internal_error_when_service_raises_unexpected_exception(self) -> None:
        service = SimpleNamespace(async_train=AsyncMock(side_effect=RuntimeError("boom")))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        with self.assertLogs(
            "custom_components.helman.solar_bias_correction.websocket",
            level="ERROR",
        ) as captured:
            await self.solar_bias_ws.ws_train_solar_bias_now(
                FakeHass(coordinator),
                connection,
                {"id": 1, "type": "helman/solar_bias/train_now"},
            )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "internal_error", "Unexpected solar bias training failure")],
        )
        self.assertIn("Unexpected solar bias training failure", captured.output[0])

    def test_profile_returns_persisted_profile_shape(self) -> None:
        service = SimpleNamespace(
            get_profile_payload=Mock(
                return_value={
                    "trainedAt": "2026-04-24T03:00:00+02:00",
                    "factors": {"08:00": 1.1, "08:30": 0.9},
                    "omittedSlots": ["07:30", "09:00"],
                }
            )
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        self.assertEqual(
            connection.results,
            [
                (
                    1,
                    {
                        "trainedAt": "2026-04-24T03:00:00+02:00",
                        "factors": {"08:00": 1.1, "08:30": 0.9},
                        "omittedSlots": ["07:30", "09:00"],
                    },
                )
            ],
        )
        self.assertEqual(connection.errors, [])

    def test_profile_requires_admin(self) -> None:
        service = SimpleNamespace(get_profile_payload=Mock())
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        service.get_profile_payload.assert_not_called()
        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    def test_profile_returns_no_profile_before_training(self) -> None:
        service = SimpleNamespace(get_profile_payload=Mock(return_value=None))
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        self.solar_bias_ws.ws_get_solar_bias_profile(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/profile"},
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors, [(1, "no_profile", "No solar bias profile available")])

    def test_profile_returns_not_loaded_when_missing(self) -> None:
        cases = (
            (
                None,
                [(1, "not_loaded", "Helman coordinator not available")],
            ),
            (
                SimpleNamespace(_solar_bias_service=None),
                [
                    (
                        1,
                        "not_loaded",
                        "Helman solar bias correction service not available",
                    )
                ],
            ),
        )

        for coordinator, expected_error in cases:
            with self.subTest(coordinator=coordinator):
                connection = FakeConnection()

                self.solar_bias_ws.ws_get_solar_bias_profile(
                    FakeHass(coordinator),
                    connection,
                    {"id": 1, "type": "helman/solar_bias/profile"},
                )

                self.assertEqual(connection.results, [])
                self.assertEqual(connection.errors, expected_error)

    def test_registration_wiring_includes_solar_bias_handlers(self) -> None:
        registered: list[object] = []
        self.websockets_mod.async_register_command = lambda hass, command: registered.append(
            command
        )

        self.websockets_mod.async_register_websocket_commands(object())

        self.assertIn(self.solar_bias_ws.ws_get_solar_bias_status, registered)
        self.assertIn(self.solar_bias_ws.ws_train_solar_bias_now, registered)
        self.assertIn(self.solar_bias_ws.ws_get_solar_bias_profile, registered)


if __name__ == "__main__":
    unittest.main()
