"""The move off the old shared ``Helman`` device, on HA's real registries.

An install upgraded from one hub device holds every Helman row on it. Adding
the entities again through a real entity platform moves each row to its node,
consumer or real hardware device, and :func:`remove_stale_devices` then
retires the hub. Everything the user set on a row survives the move, and the
hardware device it links to stays its own integration's.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from types import MappingProxyType
from unittest.mock import AsyncMock, patch

from homeassistant.config_entries import ConfigEntries, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    area_registry as ar,
)
from homeassistant.helpers import (
    device_registry as dr,
)
from homeassistant.helpers import (
    entity_registry as er,
)
from homeassistant.helpers import (
    floor_registry as fr,
)
from homeassistant.helpers import (
    label_registry as lr,
)
from homeassistant.helpers.entity_platform import EntityPlatform

from custom_components.helman.const import DOMAIN
from custom_components.helman.entity import (
    consumer_device_binding,
    remove_stale_devices,
)
from custom_components.helman.select import HelmanInverterModeSelect
from custom_components.helman.sensor import (
    HelmanBatteryTimeSensor,
    HelmanShareEnergySensor,
    HelmanSharePowerSensor,
    HelmanUnmeasuredPowerSensor,
)
from custom_components.helman.switch import HelmanEvChargingSwitch
from custom_components.helman.vendors import PROFILES, VendorDevice

CHARGER = {"kind": "ev_charger", "id": "garage-ev", "name": "Garage EV"}
CONFIG = {
    "devices": {
        "consumers": [
            {
                "id": "boiler",
                "name": "Boiler",
                "consumption": {"energy_entity_id": "sensor.boiler_energy"},
                "children": [
                    {"id": "pump", "consumption": {"power_entity_id": "sensor.pump_power"}}
                ],
            },
            CHARGER,
        ]
    }
}


def _config_entry(domain: str, entry_id: str) -> ConfigEntry:
    return ConfigEntry(
        data={},
        discovery_keys=MappingProxyType({}),
        domain=domain,
        entry_id=entry_id,
        minor_version=1,
        options={},
        source="user",
        subentries_data=None,
        title=domain,
        unique_id=None,
        version=1,
    )


async def _hass(tmp_path) -> HomeAssistant:
    hass = HomeAssistant(str(tmp_path))
    hass.config_entries = ConfigEntries(hass, {})
    dr.async_setup(hass)
    for registry in (lr, fr, ar, dr, er):
        await registry.async_load(hass, load_empty=True)
    return hass


async def _add(hass, entry, domain, entities) -> None:
    platform = EntityPlatform(
        hass=hass,
        logger=logging.getLogger(__name__),
        domain=domain,
        platform_name=DOMAIN,
        platform=None,
        scan_interval=timedelta(seconds=30),
        entity_namespace=None,
    )
    platform.config_entry = entry
    await platform.async_add_entities(entities)


async def _migrate(tmp_path) -> dict:
    hass = await _hass(tmp_path)
    helman = _config_entry(DOMAIN, "helman-entry")
    shelly = _config_entry("shelly", "shelly-entry")
    for entry in (helman, shelly):
        hass.config_entries._entries[entry.entry_id] = entry
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    area = ar.async_get(hass).async_create("Garage")

    hub = dev_reg.async_get_or_create(
        config_entry_id=helman.entry_id,
        identifiers={(DOMAIN, helman.entry_id)},
        name="Helman",
        entry_type=dr.DeviceEntryType.SERVICE,
    )
    hardware = dev_reg.async_get_or_create(
        config_entry_id=shelly.entry_id,
        identifiers={("shelly", "pump-relay")},
        name="Pump relay",
    )
    native = ent_reg.async_get_or_create(
        "sensor",
        "shelly",
        "pump-relay-power",
        config_entry=shelly,
        device_id=hardware.id,
        suggested_object_id="pump_power",
    )

    def helman_row(domain, unique_id, object_id, **changes):
        row = ent_reg.async_get_or_create(
            domain,
            DOMAIN,
            unique_id,
            config_entry=helman,
            device_id=hub.id,
            suggested_object_id=object_id,
        )
        return ent_reg.async_update_entity(row.entity_id, **changes) if changes else row

    share_power = helman_row(
        "sensor",
        "helman-entry_share_power_pump",
        "helman_share_power_pump",
        new_entity_id="sensor.my_pump_share",
        name="My pump share",
    )
    share_energy = helman_row(
        "sensor",
        "helman-entry_share_energy_pump",
        "helman_share_energy_pump",
        disabled_by=er.RegistryEntryDisabler.USER,
    )
    battery = helman_row(
        "sensor",
        "helman-entry_battery_time_to_full",
        "helman_battery_time_to_full",
        area_id=area.id,
    )
    unmeasured = helman_row(
        "sensor",
        "helman-entry_unmeasured_power_boiler_energy",
        "helman_unmeasured_power_boiler_energy",
    )
    mode = helman_row("select", "helman_inverter_mode", "helman_inverter_mode")
    charging = helman_row(
        "switch", "helman_ev_charging_garage-ev", "helman_ev_charging_garage_ev"
    )
    before = [share_power, share_energy, battery, unmeasured, mode, charging]

    charger = VendorDevice(
        path="devices.consumers[1]",
        device=CHARGER,
        profile=PROFILES["solax_ev_charger"],
        entry=None,
    )
    pump = consumer_device_binding(hass, helman, CONFIG, device_id="pump")
    with (
        patch.object(HelmanBatteryTimeSensor, "async_added_to_hass", AsyncMock()),
        patch.object(HelmanUnmeasuredPowerSensor, "async_added_to_hass", AsyncMock()),
        patch.object(HelmanSharePowerSensor, "async_added_to_hass", AsyncMock()),
        patch.object(HelmanShareEnergySensor, "async_added_to_hass", AsyncMock()),
        patch.object(HelmanInverterModeSelect, "async_added_to_hass", AsyncMock()),
        patch.object(HelmanEvChargingSwitch, "async_added_to_hass", AsyncMock()),
    ):
        await _add(
            hass,
            helman,
            "sensor",
            [
                HelmanBatteryTimeSensor(helman, [], "charging"),
                HelmanUnmeasuredPowerSensor(
                    helman,
                    "sensor.boiler_energy",
                    None,
                    binding=consumer_device_binding(
                        hass, helman, CONFIG, meter_entity_id="sensor.boiler_energy"
                    ),
                ),
                HelmanSharePowerSensor(
                    helman, "pump", "sensor.helman_share_power_pump", binding=pump
                ),
                HelmanShareEnergySensor(helman, "pump", binding=pump),
            ],
        )
        await _add(
            hass,
            helman,
            "select",
            [HelmanInverterModeSelect(None, helman, PROFILES["solax_inverter"], None)],
        )
        await _add(
            hass,
            helman,
            "switch",
            [
                HelmanEvChargingSwitch(
                    "garage-ev",
                    charger,
                    binding=consumer_device_binding(
                        hass, helman, CONFIG, device=CHARGER
                    ),
                )
            ],
        )
    remove_stale_devices(hass, helman)
    result = {
        "hass": hass,
        "dev_reg": dev_reg,
        "ent_reg": ent_reg,
        "hub": hub,
        "hardware": hardware,
        "native": native,
        "area": area,
        "before": before,
        "after": [ent_reg.async_get(row.entity_id) for row in before],
        "device_count": len(dev_reg.devices),
    }
    await hass.async_stop(force=True)
    return result


def _device(result, row):
    return result["dev_reg"].async_get(row.device_id)


def test_rows_keep_their_identity_and_settings_on_the_move(tmp_path) -> None:
    result = asyncio.run(_migrate(tmp_path))

    for before, after in zip(result["before"], result["after"], strict=True):
        assert after is not None, before.entity_id
        assert (after.id, after.entity_id, after.unique_id) == (
            before.id,
            before.entity_id,
            before.unique_id,
        )
        assert after.name == before.name
        assert after.area_id == before.area_id
        assert after.disabled_by == before.disabled_by
        assert after.device_id != result["hub"].id
    share_power, share_energy, battery, *_ = result["after"]
    assert (share_power.entity_id, share_power.name) == (
        "sensor.my_pump_share",
        "My pump share",
    )
    assert share_energy.disabled_by is er.RegistryEntryDisabler.USER
    assert battery.area_id == result["area"].id


def test_each_row_lands_on_its_node_consumer_or_hardware_device(tmp_path) -> None:
    result = asyncio.run(_migrate(tmp_path))
    share_power, share_energy, battery, unmeasured, mode, charging = result["after"]
    hardware = result["hardware"]

    assert _device(result, battery).name == "Helman Battery"
    assert _device(result, mode).name == "Helman Inverter"
    assert _device(result, unmeasured).identifiers == {
        (DOMAIN, "helman-entry_device_boiler")
    }
    assert _device(result, unmeasured).name == "Boiler"
    assert _device(result, charging).name == "Garage EV"
    assert share_power.device_id == share_energy.device_id == hardware.id
    linked = _device(result, share_power)
    assert linked.identifiers == hardware.identifiers
    assert linked.config_entries == hardware.config_entries == {"shelly-entry"}


def test_the_hub_goes_and_the_hardware_stays_its_integration_s_own(tmp_path) -> None:
    result = asyncio.run(_migrate(tmp_path))
    dev_reg = result["dev_reg"]

    assert dev_reg.async_get(result["hub"].id) is None
    assert dev_reg.async_get_device(identifiers={("shelly", "pump-relay")}) == (
        dev_reg.async_get(result["hardware"].id)
    )
    native = result["ent_reg"].async_get(result["native"].entity_id)
    assert native == result["native"]
    # The pump relay and four Helman devices: no duplicate of the hardware.
    assert result["device_count"] == 5
