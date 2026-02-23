from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


def _collect_qualifying_node_ids(tree: dict) -> list[str]:
    """Return parent node IDs for every consumer node that has an isUnmeasured child."""
    result: list[str] = []

    def walk(nodes: list) -> None:
        for node in nodes:
            children = node.get("children", [])
            if any(c.get("isUnmeasured") for c in children):
                result.append(node["id"])
            walk(children)

    walk(tree.get("consumers", []))
    return result


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN]["coordinator"]

    tree = await coordinator.get_device_tree()
    qualifying_node_ids = _collect_qualifying_node_ids(tree)

    battery_time = HelmanBatteryTimeSensor(coordinator, entry)
    unmeasured_sensors: dict[str, HelmanUnmeasuredPowerSensor] = {
        node_id: HelmanUnmeasuredPowerSensor(coordinator, entry, node_id)
        for node_id in qualifying_node_ids
    }
    total_power = HelmanTotalPowerSensor(coordinator, entry)

    coordinator.set_sensors(
        battery_time=battery_time,
        unmeasured_sensors=unmeasured_sensors,
        total_power=total_power,
    )

    async_add_entities([battery_time] + list(unmeasured_sensors.values()) + [total_power])


class HelmanBatteryTimeSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_battery_time_to_target"
        self._attr_name = "Helman Battery Time to Target"
        self._minutes: float | None = None
        self._target_time_iso: str = ""
        self._mode: str = "idle"
        self._target_soc: int | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._minutes, 1) if self._minutes is not None else None

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "target_time": self._target_time_iso,
            "mode": self._mode,
            "target_soc": self._target_soc,
        }

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(
        self,
        minutes: float | None,
        target_time: str,
        mode: str,
        target_soc: int | None,
    ) -> None:
        self._minutes = minutes
        self._target_time_iso = target_time
        self._mode = mode
        self._target_soc = target_soc
        self.async_write_ha_state()


class HelmanUnmeasuredPowerSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry, node_id: str) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_{node_id}_unmeasured_power"
        self._attr_name = f"Helman {node_id.replace('_', ' ').title()} Unmeasured Power"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, watts: float) -> None:
        self._value = watts
        self.async_write_ha_state()


class HelmanTotalPowerSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_total_power"
        self._attr_name = "Helman Total Power"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, watts: float) -> None:
        self._value = watts
        self.async_write_ha_state()
