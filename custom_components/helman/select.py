"""Helman's own inverter mode select, driving the hardware profile's writes.

Created only when the inverter's hardware profile carries a mode table. The
profile points ``controls.mode`` at it with the action kinds as options, so the
executor, actual history, the roster and the card read and write it the way
they read and write a hand-made ``input_select``. Picking an option, whether
the executor or the user does it, applies the profile's vendor writes.
"""

from __future__ import annotations

import asyncio
from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import INVERTER_MODE_ENTITY_ID, INVERTER_MODE_UNIQUE_ID
from .entity import helman_device_info, remove_stale_entities
from .scheduling.schedule import INVERTER_ACTION_KINDS
from .scheduling.actuation import async_write_vendor_entity
from .vendors import VendorProfile, find_mode_vendor, resolve_unique_ids
from .vendors.modes import (
    ModeWritesError,
    bind_mode_writes,
    first_matching_option,
    mode_write_templates,
    register_matches,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    mode_vendor = find_mode_vendor(hass, coordinator.config)
    if mode_vendor is None:
        # Back on Custom: drop the select.
        remove_stale_entities(
            hass, entry, "select", lambda unique_id: unique_id == INVERTER_MODE_UNIQUE_ID
        )
        return
    profile, vendor_entry = mode_vendor
    async_add_entities(
        [HelmanInverterModeSelect(coordinator, entry, profile, vendor_entry)]
    )


class HelmanInverterModeSelect(SelectEntity, RestoreEntity):
    """The inverter's commanded mode, one option per schedule action kind.

    Shows the last commanded mode, not what the inverter is doing, the same as
    the ``input_select`` it replaces. After a restart it restores that option
    without applying it again.
    """

    _attr_has_entity_name = True
    _attr_translation_key = "inverter_mode"
    _attr_should_poll = False

    def __init__(
        self,
        coordinator: Any,
        entry: ConfigEntry,
        profile: VendorProfile,
        vendor_entry: Any | None,
    ) -> None:
        # On the one shared Helman device, as every Helman sensor is.
        self._attr_device_info = helman_device_info(entry)
        self.entity_id = INVERTER_MODE_ENTITY_ID
        self._attr_unique_id = INVERTER_MODE_UNIQUE_ID
        self._attr_options = list(INVERTER_ACTION_KINDS)
        self._attr_current_option = None
        self._coordinator = coordinator
        self._profile = profile
        self._vendor_entry = vendor_entry
        # One option's writes at a time: interleaved, two picks could leave
        # the inverter in a mix of both.
        self._lock = asyncio.Lock()

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None and last_state.state in self.options:
            self._attr_current_option = last_state.state
        else:
            # Nothing to restore (the first start under the profile): the
            # option the vendor entities are already in, so the executor has
            # a state to compare against rather than "unknown".
            self._attr_current_option = self._vendor_option()

    async def async_select_option(self, option: str) -> None:
        async with self._lock:
            for entity_id, target in self._writes(option):
                if not self._in_target(entity_id, target):
                    await async_write_vendor_entity(self.hass, entity_id, target)
            self._attr_current_option = option
            self.async_write_ha_state()

    def _vendor_option(self) -> str | None:
        """The first option whose writes the vendor entities already match."""
        bound = {}
        for option in self.options:
            try:
                bound[option] = self._writes(option)
            except HomeAssistantError:
                bound[option] = None
        return first_matching_option(bound, self.hass.states.get)

    def _writes(self, option: str) -> list[tuple[str, str | float]]:
        """The vendor writes for ``option``, in order, as ``(entity id, target)``.

        Everything is resolved before the first write, so a missing entity or
        setting fails the option without applying half of it.
        """
        profile = self._profile
        try:
            writes = mode_write_templates(profile, option, self._coordinator.config)
            entity_ids = resolve_unique_ids(
                self.hass,
                profile,
                self._vendor_entry,
                [template for template, _ in writes],
            )
            return bind_mode_writes(profile, option, writes, entity_ids)
        except ModeWritesError as err:
            raise HomeAssistantError(str(err)) from err

    def _in_target(self, entity_id: str, target: str | float) -> bool:
        return register_matches(self.hass.states.get(entity_id), entity_id, target) is True
