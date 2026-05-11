from __future__ import annotations

import time

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_HYSTERESIS_W: float = 5.0
_HYSTERESIS_MAX_GAP_S: float = 30.0


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

    battery_time_to_full = HelmanBatteryTimeSensor(coordinator, entry, required_battery_ids, "charging")
    battery_time_to_empty = HelmanBatteryTimeSensor(coordinator, entry, required_battery_ids, "discharging")
    unmeasured_sensors: dict[str, HelmanUnmeasuredPowerSensor] = {
        node_id: HelmanUnmeasuredPowerSensor(coordinator, entry, node_id, parent_sensor_id)
        for node_id, parent_sensor_id in qualifying_nodes.items()
    }
    total_power = HelmanConsumptionTotalSensor(coordinator, entry)
    production_total = HelmanProductionTotalSensor(coordinator, entry)
    forecast_entities = [
        HelmanSolarForecastEnergySensor(coordinator, entry, "today", day_offset=0),
        HelmanSolarForecastEnergySensor(coordinator, entry, "tomorrow", day_offset=1),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d2", day_offset=2),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d3", day_offset=3),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d4", day_offset=4),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d5", day_offset=5),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d6", day_offset=6),
        HelmanSolarForecastEnergySensor(coordinator, entry, "d7", day_offset=7),
        HelmanSolarForecastRemainingSensor(coordinator, entry),
    ]

    source_ratio_sensors: dict[str, HelmanSourceRatioSensor] = {
        node["powerSensorId"]: HelmanSourceRatioSensor(coordinator, entry, node["sourceType"])
        for node in tree.get("sources", [])
        if node.get("ratioSensorId") and node.get("powerSensorId") and node.get("sourceType")
    }

    coordinator.set_sensors(
        battery_time_to_full=battery_time_to_full,
        battery_time_to_empty=battery_time_to_empty,
        unmeasured_sensors=unmeasured_sensors,
        total_power=total_power,
        production_total=production_total,
        source_ratio_sensors=source_ratio_sensors,
        forecast_sensors=forecast_entities,
    )
    coordinator.set_entity_factory(
        entry,
        async_add_entities,
        lambda node_id, parent_id: HelmanUnmeasuredPowerSensor(
            coordinator, entry, node_id, parent_id
        ),
    )

    async_add_entities(
        [battery_time_to_full, battery_time_to_empty]
        + list(unmeasured_sensors.values())
        + [total_power, production_total]
        + list(source_ratio_sensors.values())
        + forecast_entities
    )

    house_consumption_forecast_current_sensor = HelmanHouseConsumptionForecastCurrentSensor(
        coordinator, entry,
    )
    async_add_entities([house_consumption_forecast_current_sensor])
    coordinator.register_house_consumption_forecast_current_sensor(
        house_consumption_forecast_current_sensor,
    )


class HelmanBatteryTimeSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _unrecorded_attributes = frozenset({"target_time", "target_soc"})

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        required_entity_ids: list[str],
        direction: str,
    ) -> None:
        self._coordinator = coordinator
        self._required_entity_ids = required_entity_ids
        suffix = "to_full" if direction == "charging" else "to_empty"
        label = "Full" if direction == "charging" else "Empty"
        self._attr_unique_id = f"{entry.entry_id}_battery_{suffix}"
        self._attr_name = f"Helman Battery Time to {label}"
        self._minutes: float | None = None
        self._target_time_iso: str = ""
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
            "target_soc": self._target_soc,
        }

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(
        self,
        minutes: float | None,
        target_time: str,
        target_soc: int | None,
    ) -> None:
        self._minutes = minutes
        self._target_time_iso = target_time
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

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False

    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanConsumptionTotalSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_consumption_total"
        self._attr_name = "Helman Consumption Total"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False

    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanProductionTotalSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_production_total"
        self._attr_name = "Helman Production Total"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False

    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanSourceRatioSensor(SensorEntity):
    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "%"

    def __init__(self, coordinator, entry: ConfigEntry, source_type: str) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_{source_type}_source_ratio"
        self._attr_name = f"Helman {source_type.title()} Source Ratio"
        self.entity_id = f"sensor.helman_{source_type}_source_ratio"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return self._value

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, pct: float) -> None:
        self._value = round(pct, 1)
        if self.hass is not None:
            self.async_write_ha_state()


class HelmanSolarForecastEnergySensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "kWh"
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator,
        entry: ConfigEntry,
        key: str,
        *,
        day_offset: int,
    ) -> None:
        self._coordinator = coordinator
        self._day_offset = day_offset
        self.entity_id = f"sensor.helman_energy_production_{key}"
        self._attr_unique_id = f"{entry.entry_id}_energy_production_{key}"
        self._attr_translation_key = f"energy_production_{key}"

    @property
    def available(self) -> bool:
        return self._coordinator.get_solar_forecast_day_total(self._day_offset) is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_solar_forecast_day_total(self._day_offset)


class HelmanSolarForecastRemainingSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "kWh"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = "sensor.helman_energy_production_today_remaining"
        self._attr_unique_id = f"{entry.entry_id}_energy_production_today_remaining"
        self._attr_translation_key = "energy_production_today_remaining"

    @property
    def available(self) -> bool:
        return self._coordinator.get_solar_forecast_today_remaining() is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_solar_forecast_today_remaining()


class HelmanHouseConsumptionForecastCurrentSensor(SensorEntity):
    """Publishes the forecasted house consumption for the *current* 15-min slot.

    The state value is the slot's energy expressed in Wh-per-hour (i.e. W).
    A slot forecast of 250 Wh is published as `1000` because 250 Wh / 0.25 h = 1000 Wh/h.
    Reading the recorder history of this entity over a past day yields a stair-step
    series of past forecast values, one step per slot.
    """

    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = "sensor.helman_house_consumption_forecast_current"
        self._attr_unique_id = f"{entry.entry_id}_house_consumption_forecast_current"
        self._attr_translation_key = "house_consumption_forecast_current"

    @property
    def available(self) -> bool:
        return self._coordinator.get_house_consumption_forecast_current_w() is not None

    @property
    def native_value(self) -> float | None:
        value = self._coordinator.get_house_consumption_forecast_current_w()
        if value is None:
            return None
        return round(value, 1)
