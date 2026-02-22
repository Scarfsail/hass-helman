from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN]["coordinator"]
    async_add_entities([HelmanPowerSummarySensor(coordinator, entry)])


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
        self._coordinator.set_sensor(self)

    def update_snapshot(self, snapshot: dict) -> None:
        """Called by coordinator whenever power values change."""
        self._snapshot = snapshot
        self.async_write_ha_state()
