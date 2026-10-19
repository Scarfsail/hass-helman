"""Every platform's entity ids and unique ids, pinned.

The recorder keys history and long-term statistics on the entity id, and the
registry matches an entity to its row by the unique id, so either moving would
strand a user's history. Each platform's ``async_setup_entry`` runs for real,
the sensor platform against the real coordinator, which adds the tree-sized
unmeasured and share sensors itself.
"""

from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from custom_components.helman import select as select_module
from custom_components.helman import sensor as sensor_module
from custom_components.helman import switch as switch_module
from custom_components.helman.tree_builder import TreeIndex
from custom_components.helman.vendors import PROFILES, VendorDevice
from tests._fakes import FakeConfigEntry, FakeHass, make_coordinator

ENTRY_ID = "entry-1"

TREE = {
    "sources": [
        {
            "id": f"sensor.{source}_power",
            "powerSensorId": f"sensor.{source}_power",
            "sourceType": source,
            "ratioSensorId": f"sensor.helman_{source}_source_ratio",
            "children": [],
        }
        for source in ("solar", "battery", "grid")
    ],
    "consumers": [
        {
            "id": "house",
            "powerSensorId": "sensor.house_power",
            "children": [
                {
                    "id": "house_unmeasured",
                    "powerSensorId": "sensor.helman_unmeasured_power_house",
                    "isUnmeasured": True,
                    "children": [],
                },
                {
                    "id": "klima",
                    "powerSensorId": "sensor.helman_share_power_klima",
                    "isEstimated": True,
                    "displayName": "Klima",
                    "children": [],
                },
            ],
        }
    ],
}

SENSOR_IDS = {
    ("sensor.helman_battery_time_to_full", "battery_time_to_full"),
    ("sensor.helman_battery_time_to_empty", "battery_time_to_empty"),
    ("sensor.helman_unmeasured_power_house", "unmeasured_power_house"),
    ("sensor.helman_share_power_klima", "share_power_klima"),
    ("sensor.helman_consumer_total_power", "consumer_total_power"),
    ("sensor.helman_house_supply_power", "house_supply_power"),
    ("sensor.helman_house_consumption_power", "house_consumption_power"),
    ("sensor.helman_house_consumption_power_l1", "house_consumption_power_l1"),
    ("sensor.helman_house_consumption_power_l2", "house_consumption_power_l2"),
    ("sensor.helman_house_consumption_power_l3", "house_consumption_power_l3"),
    ("sensor.helman_solar_source_ratio", "solar_source_ratio"),
    ("sensor.helman_battery_source_ratio", "battery_source_ratio"),
    ("sensor.helman_grid_source_ratio", "grid_source_ratio"),
    ("sensor.helman_solar_forecast_today", "solar_forecast_today"),
    ("sensor.helman_solar_forecast_tomorrow", "solar_forecast_tomorrow"),
    *(
        (f"sensor.helman_solar_forecast_d{day}", f"solar_forecast_d{day}")
        for day in range(2, 8)
    ),
    ("sensor.helman_solar_forecast_today_remaining", "solar_forecast_today_remaining"),
    (
        "sensor.helman_house_consumption_forecast_current",
        "house_consumption_forecast_current",
    ),
    ("sensor.helman_solar_forecast_current", "solar_forecast_current"),
    ("sensor.helman_solar_forecast_current_corrected", "solar_forecast_current_corrected"),
    ("sensor.helman_battery_soc_forecast_current", "battery_soc_forecast_current"),
    ("sensor.helman_battery_net_forecast_current", "battery_net_forecast_current"),
    ("sensor.helman_grid_net_forecast_current", "grid_net_forecast_current"),
    ("sensor.helman_grid_import_forecast_current", "grid_import_forecast_current"),
    ("sensor.helman_grid_export_forecast_current", "grid_export_forecast_current"),
    ("sensor.helman_grid_import_price", "grid_import_price"),
    ("sensor.helman_grid_export_price", "grid_export_price"),
}


def _ids(entities) -> set[tuple[str, str]]:
    return {(entity.entity_id, entity.unique_id) for entity in entities}


def _setup(platform, entry, hass=None) -> list:
    added: list = []
    with (
        patch("homeassistant.helpers.entity_registry.async_get", return_value=Mock()),
        patch(
            "homeassistant.helpers.entity_registry.async_entries_for_config_entry",
            return_value=[],
        ),
    ):
        asyncio.run(platform.async_setup_entry(hass, entry, added.extend))
    return added


class EntityIdentityTests(unittest.TestCase):
    def test_sensor_platform(self) -> None:
        hass = FakeHass()
        coordinator = make_coordinator(_hass=hass)
        coordinator._tree_index = TreeIndex.from_tree(TREE)
        coordinator.get_device_tree = AsyncMock(return_value=TREE)
        entry = FakeConfigEntry(ENTRY_ID, runtime_data=coordinator)

        added = _setup(sensor_module, entry, hass)

        self.assertEqual(len(added), len(SENSOR_IDS))
        self.assertEqual(
            _ids(added),
            {(entity_id, f"{ENTRY_ID}_{suffix}") for entity_id, suffix in SENSOR_IDS},
        )

    def test_select_platform(self) -> None:
        entry = FakeConfigEntry(ENTRY_ID, runtime_data=SimpleNamespace(config={}))
        with patch.object(
            select_module,
            "find_mode_vendor",
            return_value=(PROFILES["solax_inverter"], None),
        ):
            added = _setup(select_module, entry)

        self.assertEqual(
            _ids(added), {("select.helman_inverter_mode", "helman_inverter_mode")}
        )

    def test_switch_platform(self) -> None:
        entry = FakeConfigEntry(ENTRY_ID, runtime_data=SimpleNamespace(config={}))
        device = VendorDevice(
            path="devices.consumers[0]",
            device={"kind": "ev_charger", "id": "garage-ev", "name": "Garage EV"},
            profile=PROFILES["solax_ev_charger"],
            entry=None,
            device_id="charger-device",
        )
        with patch.object(
            switch_module, "find_charging_devices", return_value=[("garage-ev", device)]
        ):
            added = _setup(switch_module, entry)

        self.assertEqual(
            _ids(added),
            {("switch.helman_ev_charging_garage_ev", "helman_ev_charging_garage-ev")},
        )


if __name__ == "__main__":
    unittest.main()
