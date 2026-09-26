from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_sensor_module():
    for module_name in [
        "custom_components.helman.sensor",
        "custom_components.helman.const",
        "homeassistant",
        "homeassistant.components",
        "homeassistant.components.sensor",
        "homeassistant.config_entries",
        "homeassistant.const",
        "homeassistant.core",
        "homeassistant.helpers",
        "homeassistant.helpers.entity_platform",
    ]:
        sys.modules.pop(module_name, None)

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

    homeassistant_pkg = types.ModuleType("homeassistant")
    sys.modules["homeassistant"] = homeassistant_pkg
    components_pkg = types.ModuleType("homeassistant.components")
    sys.modules["homeassistant.components"] = components_pkg

    sensor_mod = types.ModuleType("homeassistant.components.sensor")
    sensor_mod.SensorDeviceClass = type(
        "SensorDeviceClass",
        (),
        {
            "DURATION": "duration",
            "POWER": "power",
            "ENERGY": "energy",
            "BATTERY": "battery",
        },
    )
    sensor_mod.SensorStateClass = type(
        "SensorStateClass",
        (),
        {"MEASUREMENT": "measurement"},
    )

    class SensorEntity:
        def __init__(self) -> None:
            self.hass = None
            self.entity_id = None

        async def async_added_to_hass(self) -> None:
            return None

        def async_write_ha_state(self) -> None:
            return None

    sensor_mod.SensorEntity = SensorEntity
    sys.modules["homeassistant.components.sensor"] = sensor_mod

    config_entries_mod = types.ModuleType("homeassistant.config_entries")
    config_entries_mod.ConfigEntry = type("ConfigEntry", (), {})
    sys.modules["homeassistant.config_entries"] = config_entries_mod

    const_mod = types.ModuleType("homeassistant.const")
    const_mod.UnitOfTime = type("UnitOfTime", (), {"MINUTES": "min"})
    sys.modules["homeassistant.const"] = const_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    sys.modules["homeassistant.core"] = core_mod

    helpers_pkg = types.ModuleType("homeassistant.helpers")
    helpers_pkg.__path__ = []  # mark as package so sub-imports work
    sys.modules["homeassistant.helpers"] = helpers_pkg
    entity_platform_mod = types.ModuleType("homeassistant.helpers.entity_platform")
    entity_platform_mod.AddEntitiesCallback = object
    sys.modules["homeassistant.helpers.entity_platform"] = entity_platform_mod

    device_registry_mod = types.ModuleType("homeassistant.helpers.device_registry")
    device_registry_mod.DeviceEntryType = type("DeviceEntryType", (), {"SERVICE": "service"})
    device_registry_mod.DeviceInfo = dict
    sys.modules["homeassistant.helpers.device_registry"] = device_registry_mod

    return importlib.import_module("custom_components.helman.sensor")


class _FakeHass:
    def __init__(self) -> None:
        self.states = type("S", (), {"get": staticmethod(lambda *_: None)})()


class _FakeEntry:
    entry_id = "abc"


class _FakeCoordinator:
    def register_sensor_ready(self) -> None: ...


def _install(sensor) -> list[float | None]:
    written: list[float | None] = []
    sensor.hass = _FakeHass()
    sensor.async_write_ha_state = lambda: written.append(sensor.native_value)
    return written


def test_unmeasured_skips_small_delta() -> None:
    sensor_module = _load_sensor_module()
    sensor = sensor_module.HelmanUnmeasuredPowerSensor(
        _FakeCoordinator(), _FakeEntry(), _FakeHass(), "node", None
    )
    written = _install(sensor)
    sensor.update_value(100.0)
    sensor.update_value(100.0 + (sensor_module._HYSTERESIS_W - 0.1))
    assert written == [100]


def test_unmeasured_emits_on_large_delta() -> None:
    sensor_module = _load_sensor_module()
    sensor = sensor_module.HelmanUnmeasuredPowerSensor(
        _FakeCoordinator(), _FakeEntry(), _FakeHass(), "node", None
    )
    written = _install(sensor)
    sensor.update_value(100.0)
    sensor.update_value(100.0 + sensor_module._HYSTERESIS_W + 1)
    assert len(written) == 2


def test_consumption_total_hysteresis() -> None:
    sensor_module = _load_sensor_module()
    sensor = sensor_module.HelmanConsumptionTotalSensor(_FakeCoordinator(), _FakeEntry())
    written = _install(sensor)
    sensor.update_value(50.0)
    sensor.update_value(50.0 + 0.5)
    assert written == [50]


def test_production_total_hysteresis() -> None:
    sensor_module = _load_sensor_module()
    sensor = sensor_module.HelmanProductionTotalSensor(_FakeCoordinator(), _FakeEntry())
    written = _install(sensor)
    sensor.update_value(800.0)
    sensor.update_value(800.0 + 0.5)
    assert written == [800]


def _share_sensor(sensor_module):
    return sensor_module.HelmanSharePowerSensor(
        _FakeCoordinator(),
        _FakeEntry(),
        "klima-obyvak",
        "sensor.helman_share_power_klima_obyvak",
        "Klima Obyvák",
    )


def test_share_sensor_takes_the_tree_s_entity_id_and_the_device_name() -> None:
    sensor = _share_sensor(_load_sensor_module())
    assert sensor.entity_id == "sensor.helman_share_power_klima_obyvak"
    assert sensor._attr_unique_id == "abc_share_power_klima-obyvak"
    assert sensor._attr_name == "Share — Klima Obyvák"


def test_share_none_publishes_unavailable_once_then_recovers() -> None:
    sensor = _share_sensor(_load_sensor_module())
    written = _install(sensor)
    sensor.update_value(400.0)
    assert sensor.available
    sensor.update_value(None)
    sensor.update_value(None)
    assert not sensor.available
    sensor.update_value(400.0)
    assert sensor.available
    assert written == [400, None, 400]


def test_unmeasured_none_is_unavailable_even_with_a_readable_parent() -> None:
    sensor_module = _load_sensor_module()
    hass = _FakeHass()
    hass.states = type(
        "S", (), {"get": staticmethod(lambda *_: types.SimpleNamespace(state="1000", attributes={}))}
    )()
    sensor = sensor_module.HelmanUnmeasuredPowerSensor(
        _FakeCoordinator(), _FakeEntry(), hass, "node", "sensor.parent_power"
    )
    sensor.hass = hass
    sensor.update_value(0.0)
    assert sensor.available
    sensor.update_value(None)
    assert not sensor.available
