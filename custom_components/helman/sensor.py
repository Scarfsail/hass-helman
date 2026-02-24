from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN]["coordinator"]

    tree = await coordinator.get_device_tree()
    qualifying_nodes = coordinator.collect_qualifying_nodes(tree)

    battery_entities = (
        coordinator.config.get("power_devices", {})
        .get("battery", {})
        .get("entities", {})
    )
    required_battery_ids = [
        v for k, v in battery_entities.items()
        if k in {"remaining_energy", "capacity", "min_soc", "max_soc"} and v
    ]

    battery_time = HelmanBatteryTimeSensor(coordinator, entry, required_battery_ids)
    unmeasured_sensors: dict[str, HelmanUnmeasuredPowerSensor] = {
        node_id: HelmanUnmeasuredPowerSensor(coordinator, entry, node_id, parent_sensor_id)
        for node_id, parent_sensor_id in qualifying_nodes.items()
    }
    total_power = HelmanTotalPowerSensor(coordinator, entry)

    coordinator.set_sensors(
        battery_time=battery_time,
        unmeasured_sensors=unmeasured_sensors,
        total_power=total_power,
    )
    coordinator.set_entity_factory(
        entry,
        async_add_entities,
        lambda node_id, parent_id: HelmanUnmeasuredPowerSensor(
            coordinator, entry, node_id, parent_id
        ),
    )

    async_add_entities([battery_time] + list(unmeasured_sensors.values()) + [total_power])


class HelmanBatteryTimeSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _unrecorded_attributes = frozenset({"target_time", "mode", "target_soc"})

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        required_entity_ids: list[str],
    ) -> None:
        self._coordinator = coordinator
        self._required_entity_ids = required_entity_ids
        self._attr_unique_id = f"{entry.entry_id}_battery_time_to_target"
        self._attr_name = "Helman Battery Time to Target"
        self._minutes: float | None = None
        self._target_time_iso: str = ""
        self._mode: str = "idle"
        self._target_soc: int | None = None

    @property
    def available(self) -> bool:
        if not self.hass:
            return False
        if not self._required_entity_ids:
            # No battery configured — sensor is present but will always show None/idle
            return True
        for entity_id in self._required_entity_ids:
            state = self.hass.states.get(entity_id)
            if state is None or state.state in ("unavailable", "unknown", "none"):
                return False
        return True

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
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanUnmeasuredPowerSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        node_id: str,
        parent_sensor_id: str | None,
    ) -> None:
        self._coordinator = coordinator
        self._parent_sensor_id = parent_sensor_id
        self._attr_unique_id = f"{entry.entry_id}_{node_id}_unmeasured_power"
        self._attr_name = f"Helman {node_id.replace('_', ' ').title()} Unmeasured Power"
        self._value: float | None = None

    @property
    def available(self) -> bool:
        if not self.hass or not self._parent_sensor_id:
            return False
        state = self.hass.states.get(self._parent_sensor_id)
        if state is None or state.state in ("unavailable", "unknown", "none"):
            return False
        try:
            float(state.state)
        except ValueError:
            return False
        return True

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, watts: float) -> None:
        self._value = watts
        if self.hass is not None:
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
        if self.hass is not None:
            self.async_write_ha_state()
