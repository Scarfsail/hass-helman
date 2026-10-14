from __future__ import annotations

import importlib
import sys
import types



def _load_sensor_module():
    return importlib.import_module("custom_components.helman.sensor")


class _FakeHass:
    def __init__(self) -> None:
        self.data = {}
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
    sensor.async_write_ha_state = lambda: None
    sensor.update_value(0.0)
    assert sensor.available
    sensor.update_value(None)
    assert not sensor.available
