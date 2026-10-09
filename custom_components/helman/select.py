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
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import (
    DOMAIN,
    INVERTER_MODE_ENTITY_ID,
    INVERTER_MODE_UNIQUE_ID,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from .controllables.spec import CONTROLLABLE_KIND_INVERTER, CONTROLLABLE_SPECS
from .vendors import VendorProfile, find_mode_vendor, resolve_unique_ids


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN]["coordinator"]
    mode_vendor = find_mode_vendor(hass, coordinator.config)
    if mode_vendor is None:
        # Back on Custom: drop the select, or a picker would still offer it.
        from homeassistant.helpers import entity_registry as er

        registry = er.async_get(hass)
        entity_id = registry.async_get_entity_id("select", DOMAIN, INVERTER_MODE_UNIQUE_ID)
        if entity_id is not None:
            registry.async_remove(entity_id)
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
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Helman",
            entry_type=DeviceEntryType.SERVICE,
        )
        self.entity_id = INVERTER_MODE_ENTITY_ID
        self._attr_unique_id = INVERTER_MODE_UNIQUE_ID
        self._attr_options = list(
            CONTROLLABLE_SPECS[CONTROLLABLE_KIND_INVERTER].action_option_attrs
        )
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
                    await self._async_write(entity_id, target)
            self._attr_current_option = option
            self.async_write_ha_state()

    def _vendor_option(self) -> str | None:
        """The first option whose writes the vendor entities already match."""
        for option in self.options:
            try:
                writes = self._writes(option)
            except HomeAssistantError:
                continue
            if all(self._in_target(entity_id, target) for entity_id, target in writes):
                return option
        return None

    def _writes(self, option: str) -> list[tuple[str, str | float]]:
        """The vendor writes for ``option``, in order, as ``(entity id, target)``.

        Everything is resolved before the first write, so a missing entity or
        setting fails the option without applying half of it.
        """
        profile = self._profile
        if option == SCHEDULE_ACTION_STOP_EXPORT:
            export_limit: Any = 0
        else:
            export_limit = (
                self._coordinator.config.get("energy_nodes", {})
                .get("grid", {})
                .get("max_allowed_export_power")
            )
            if export_limit is None:
                raise HomeAssistantError(
                    "energy_nodes.grid.max_allowed_export_power is not configured; "
                    f"the {profile.label} profile restores the export limit to it"
                )
        writes = [*profile.modes[option]]
        if profile.export_limit is not None:
            writes.append((profile.export_limit, export_limit))
        entity_ids = resolve_unique_ids(
            self.hass, profile, self._vendor_entry, [template for template, _ in writes]
        )
        missing = sorted({template for template, _ in writes if entity_ids[template] is None})
        if missing:
            raise HomeAssistantError(
                f"The {profile.label} profile cannot apply {option!r}: no "
                f"{profile.platform} entity for {', '.join(missing)}"
            )
        return [(entity_ids[template], target) for template, target in writes]

    def _in_target(self, entity_id: str, target: str | float) -> bool:
        state = self.hass.states.get(entity_id)
        if state is None:
            return False
        if entity_id.startswith("number."):
            return _as_float(state.state) == float(target)
        return state.state == target

    async def _async_write(self, entity_id: str, target: str | float) -> None:
        """Set one vendor entity."""
        domain = entity_id.partition(".")[0]
        if domain == "number":
            service, data = "set_value", {"value": target}
        else:
            service, data = "select_option", {"option": target}
        try:
            await self.hass.services.async_call(
                domain, service, {"entity_id": entity_id, **data}, blocking=True
            )
        except HomeAssistantError:
            raise
        except Exception as err:
            raise HomeAssistantError(
                f"Failed to set {entity_id} to {target!r}: {err}"
            ) from err


def _as_float(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None
