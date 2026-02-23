from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
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

    power_summary = HelmanPowerSummarySensor(coordinator, entry)
    battery_time = HelmanBatteryTimeSensor(coordinator, entry)
    unmeasured = HelmanUnmeasuredPowerSensor(coordinator, entry)

    coordinator.set_sensors(
        power_summary=power_summary,
        battery_time=battery_time,
        unmeasured=unmeasured,
    )

    async_add_entities([power_summary, battery_time, unmeasured])


class HelmanPowerSummarySensor(SensorEntity):
    _attr_should_poll = False
    _attr_name = "Helman Power Summary"
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_power_summary"
        self._snapshot: dict = {}

    @property
    def native_value(self) -> int:
        return self._snapshot.get("house_power", 0)

    @property
    def extra_state_attributes(self) -> dict:
        return self._snapshot

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_snapshot(self, snapshot: dict) -> None:
        """Called by coordinator whenever power values change."""
        self._snapshot = snapshot
        self.async_write_ha_state()


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
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_unmeasured_house_power"
        self._attr_name = "Helman Unmeasured House Power"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, watts: float) -> None:
        self._value = watts
        self.async_write_ha_state()
