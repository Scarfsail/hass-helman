"""Helman's own EV charging switch, driving the hardware profile's charging writes.

One per device whose hardware profile has ``charging``. The profile points the
device's ``controls.charge`` at it, so the executor, the card and the user's
own automations turn charging on and off the way they would a hand-made
template switch. Its state is the charger's, read from the profile's state
entity; turning it on or off writes the profile's commands.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN, EV_CHARGING_UNIQUE_ID_PREFIX
from .scheduling.actuation import async_write_vendor_entity
from .vendors import (
    VendorDevice,
    ev_charging_entity_id,
    ev_charging_unique_id,
    find_charging_devices,
    resolve_unique_ids,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN]["coordinator"]
    charging_devices = find_charging_devices(hass, coordinator.config)
    # A device back on Custom, or gone: drop its switch, or a picker would
    # still offer it.
    kept = {ev_charging_unique_id(device_id) for device_id, _ in charging_devices}
    registry = er.async_get(hass)
    for row in er.async_entries_for_config_entry(registry, entry.entry_id):
        if (
            row.domain == "switch"
            and row.unique_id.startswith(EV_CHARGING_UNIQUE_ID_PREFIX)
            and row.unique_id not in kept
        ):
            registry.async_remove(row.entity_id)
    async_add_entities(
        [
            HelmanEvChargingSwitch(entry, device_id, vendor_device)
            for device_id, vendor_device in charging_devices
        ]
    )


class HelmanEvChargingSwitch(SwitchEntity):
    """Whether the charger charges, named after the device it drives.

    On while the profile's state entity is in its on state, and unavailable
    while that entity is. A command write is repeated when the command select
    already shows it, so the charger acts on a command it already displays.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self, entry: ConfigEntry, device_id: str, vendor_device: VendorDevice
    ) -> None:
        # On the one shared Helman device, as every Helman entity is.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Helman",
            entry_type=DeviceEntryType.SERVICE,
        )
        self.entity_id = ev_charging_entity_id(device_id)
        self._attr_unique_id = ev_charging_unique_id(device_id)
        name = vendor_device.device.get("name")
        self._attr_name = name if isinstance(name, str) and name else device_id
        self._vendor_device = vendor_device
        self._entity_ids: dict[tuple[str, str], str | None] = {}
        self._untrack_state: Callable[[], None] | None = None
        # One command sequence at a time: interleaved, an on and an off could
        # leave the charger in either.
        self._lock = asyncio.Lock()

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._async_resolve()
        # A renamed vendor entity, or rows that reach the charger's device
        # after Helman loaded, are picked up without a reload.
        self.async_on_remove(
            self.hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED, self._async_registry_updated
            )
        )
        self.async_on_remove(self._async_untrack)

    @callback
    def _async_registry_updated(self, _event: Event) -> None:
        self._async_resolve()
        self.async_write_ha_state()

    @callback
    def _async_resolve(self) -> None:
        """Resolve the profile's entities and track the state entity."""
        vendor_device = self._vendor_device
        charging = vendor_device.profile.charging
        self._entity_ids = resolve_unique_ids(
            self.hass,
            vendor_device.profile,
            vendor_device.entry,
            charging.templates,
            device_id=vendor_device.device_id,
        )
        self._async_untrack()
        state_entity_id = self._entity_ids[charging.state[0]]
        if state_entity_id is not None:
            self._untrack_state = async_track_state_change_event(
                self.hass, [state_entity_id], self._async_state_changed
            )

    @callback
    def _async_untrack(self) -> None:
        if self._untrack_state is not None:
            self._untrack_state()
            self._untrack_state = None

    @callback
    def _async_state_changed(self, _event: Event) -> None:
        self.async_write_ha_state()

    @property
    def available(self) -> bool:
        state = self._state_entity_state()
        return state is not None and state.state != STATE_UNAVAILABLE

    @property
    def is_on(self) -> bool | None:
        state = self._state_entity_state()
        if state is None:
            return None
        return state.state == self._vendor_device.profile.charging.state[1]

    async def async_turn_on(self, **kwargs: Any) -> None:
        charging = self._vendor_device.profile.charging
        async with self._lock:
            await self._async_command(charging.on_option)

    async def async_turn_off(self, **kwargs: Any) -> None:
        charging = self._vendor_device.profile.charging
        async with self._lock:
            # Resolved before the first write, so a missing entity fails the
            # turn-off without applying half of it.
            after_off = [
                (self._entity_id(template), option)
                for template, option in charging.after_off
            ]
            await self._async_command(charging.off_option)
            for entity_id, option in after_off:
                await async_write_vendor_entity(self.hass, entity_id, option)

    async def _async_command(self, option: str) -> None:
        """Write ``option`` to the command select, twice if it already shows it."""
        entity_id = self._entity_id(self._vendor_device.profile.charging.command)
        state = self.hass.states.get(entity_id)
        await async_write_vendor_entity(self.hass, entity_id, option)
        if state is not None and state.state == option:
            await async_write_vendor_entity(self.hass, entity_id, option)

    def _state_entity_state(self) -> Any:
        entity_id = self._entity_ids.get(self._vendor_device.profile.charging.state[0])
        return None if entity_id is None else self.hass.states.get(entity_id)

    def _entity_id(self, template: tuple[str, str]) -> str:
        entity_id = self._entity_ids.get(template)
        if entity_id is None:
            profile = self._vendor_device.profile
            raise HomeAssistantError(
                f"The {profile.label} profile has no {profile.platform} "
                f"{template[0]} entity for {template[1]} on "
                f"{self._vendor_device.path}"
            )
        return entity_id
