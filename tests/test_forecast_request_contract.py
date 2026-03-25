from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")


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

from custom_components.helman.const import (  # noqa: E402
    DEFAULT_FORECAST_DAYS,
    DEFAULT_FORECAST_GRANULARITY_MINUTES,
    DOMAIN,
)
from custom_components.helman.websockets import (  # noqa: E402
    GET_FORECAST_REQUEST_SCHEMA,
    ws_get_forecast,
)


class FakeCoordinator:
    def __init__(self) -> None:
        self.calls: list[dict[str, int]] = []
        self.response = {"ok": True}

    async def get_forecast(self, *, granularity: int, forecast_days: int) -> dict:
        self.calls.append(
            {
                "granularity": granularity,
                "forecast_days": forecast_days,
            }
        )
        return self.response


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


class ForecastRequestContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_call_still_succeeds(self):
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {"id": 1, **GET_FORECAST_REQUEST_SCHEMA({"type": "helman/get_forecast"})}

        await ws_get_forecast(FakeHass(coordinator), connection, msg)

        self.assertEqual(
            coordinator.calls,
            [
                {
                    "granularity": DEFAULT_FORECAST_GRANULARITY_MINUTES,
                    "forecast_days": DEFAULT_FORECAST_DAYS,
                }
            ],
        )
        self.assertEqual(connection.results, [(1, {"ok": True})])
        self.assertEqual(connection.errors, [])

    async def test_explicit_hourly_request_matches_default_path(self):
        default_msg = GET_FORECAST_REQUEST_SCHEMA({"type": "helman/get_forecast"})
        explicit_msg = GET_FORECAST_REQUEST_SCHEMA(
            {
                "type": "helman/get_forecast",
                "granularity": 60,
                "forecast_days": 7,
            }
        )
        self.assertEqual(default_msg, explicit_msg)

        coordinator = FakeCoordinator()
        connection = FakeConnection()
        await ws_get_forecast(
            FakeHass(coordinator),
            connection,
            {"id": 1, **default_msg},
        )
        await ws_get_forecast(
            FakeHass(coordinator),
            connection,
            {"id": 2, **explicit_msg},
        )

        self.assertEqual(
            coordinator.calls,
            [
                {"granularity": 60, "forecast_days": 7},
                {"granularity": 60, "forecast_days": 7},
            ],
        )
        self.assertEqual(
            connection.results,
            [
                (1, {"ok": True}),
                (2, {"ok": True}),
            ],
        )

    async def test_non_default_request_is_forwarded_once_increment_supports_it(self):
        coordinator = FakeCoordinator()
        connection = FakeConnection()
        msg = {
            "id": 1,
            **GET_FORECAST_REQUEST_SCHEMA(
                {
                    "type": "helman/get_forecast",
                    "granularity": 15,
                    "forecast_days": 1,
                }
            ),
        }

        await ws_get_forecast(FakeHass(coordinator), connection, msg)

        self.assertEqual(
            coordinator.calls,
            [{"granularity": 15, "forecast_days": 1}],
        )
        self.assertEqual(connection.results, [(1, {"ok": True})])
        self.assertEqual(connection.errors, [])

    def test_invalid_granularity_is_rejected(self):
        with self.assertRaises(vol.Invalid):
            GET_FORECAST_REQUEST_SCHEMA(
                {"type": "helman/get_forecast", "granularity": 10}
            )

    def test_invalid_forecast_days_is_rejected(self):
        with self.assertRaises(vol.Invalid):
            GET_FORECAST_REQUEST_SCHEMA(
                {"type": "helman/get_forecast", "forecast_days": 0}
            )

        with self.assertRaises(vol.Invalid):
            GET_FORECAST_REQUEST_SCHEMA(
                {"type": "helman/get_forecast", "forecast_days": 15}
            )

        with self.assertRaises(vol.Invalid):
            GET_FORECAST_REQUEST_SCHEMA(
                {"type": "helman/get_forecast", "forecast_days": "7"}
            )


if __name__ == "__main__":
    unittest.main()
