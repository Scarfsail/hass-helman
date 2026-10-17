"""Stable owner of appliance metadata refreshed from live Home Assistant states."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import replace
from functools import partial

from ..controllables.config import (
    entity_friendly_name,
    iter_device_paths,
    read_name_cleaner_regex,
    resolve_device_name,
)
from ..controllables.spec import CONTROLLABLE_KIND_CLIMATE
from .climate_appliance import ClimateApplianceRuntime, resolve_supported_climate_modes
from .state import AppliancesRuntimeRegistry

_UNAVAILABLE_ENTITY_STATES = {"unknown", "unavailable", "none"}


class AppliancesRegistryHolder:
    def __init__(
        self,
        hass,
        read_config: Callable[[], Mapping],
        current: AppliancesRuntimeRegistry | None = None,
    ) -> None:
        self._hass = hass
        self._read_config = read_config
        self.current = current if current is not None else AppliancesRuntimeRegistry()

    def refresh(self) -> None:
        """Resolve identity and climate capabilities from currently available states."""
        config = self._read_config()
        devices = {
            device["id"].strip(): device
            for _path, device, _parent in iter_device_paths(config)
            if isinstance(device, Mapping) and isinstance(device.get("id"), str)
        }
        cleaner = read_name_cleaner_regex(config)
        friendly_name = partial(entity_friendly_name, self._hass)
        refreshed_appliances = []
        changed = False

        for appliance in self.current.appliances:
            refreshed_appliance = appliance
            device = devices.get(appliance.id)
            if device is not None:
                name = resolve_device_name(
                    device,
                    friendly_name=friendly_name,
                    cleaner_regex=cleaner,
                )
                if name != appliance.name:
                    refreshed_appliance = replace(refreshed_appliance, name=name)
            if refreshed_appliance.kind == CONTROLLABLE_KIND_CLIMATE:
                refreshed_appliance = self._resolve_climate_appliance_capabilities(
                    refreshed_appliance
                )
            refreshed_appliances.append(refreshed_appliance)
            if refreshed_appliance != appliance:
                changed = True

        if changed:
            self.current = AppliancesRuntimeRegistry.from_appliances(
                refreshed_appliances
            )

    def _resolve_climate_appliance_capabilities(
        self,
        appliance: ClimateApplianceRuntime,
    ) -> ClimateApplianceRuntime:
        climate_state = self._hass.states.get(appliance.climate_entity_id)
        if climate_state is None:
            return appliance

        raw_state = getattr(climate_state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_ENTITY_STATES
        ):
            return appliance

        raw_attributes = getattr(climate_state, "attributes", {})
        if not isinstance(raw_attributes, Mapping):
            return appliance

        raw_hvac_modes = raw_attributes.get("hvac_modes")
        if not isinstance(raw_hvac_modes, (list, tuple)) or not raw_hvac_modes:
            return appliance

        hvac_modes: list[str] = []
        for raw_mode in raw_hvac_modes:
            if not isinstance(raw_mode, str) or not raw_mode.strip():
                return appliance
            hvac_modes.append(raw_mode.strip())

        supported_modes = resolve_supported_climate_modes(hvac_modes)
        stop_hvac_mode = "off" if "off" in hvac_modes else None
        return replace(
            appliance,
            supported_modes=supported_modes,
            stop_hvac_mode=stop_hvac_mode,
        )
