"""Which HA device each Helman entity sits on, and the cleanup of the rest.

Node entities sit on the five ``Helman <Node>`` service devices. A consumer's
entities link to its real hardware device when it has one and fall back to a
Helman device named after it otherwise. :func:`remove_stale_devices` retires
the old shared hub and the Helman devices left without entities, and never
touches a device another integration owns. The registries are small fakes,
on both device-registry shapes.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch

import pytest

from custom_components.helman import select as select_module
from custom_components.helman import sensor as sensor_module
from custom_components.helman import switch as switch_module
from custom_components.helman.const import DOMAIN
from custom_components.helman.entity import (
    consumer_device_binding,
    device_owner_entry_ids,
    remove_stale_devices,
)
from custom_components.helman.tree_builder import TreeIndex
from custom_components.helman.vendors import PROFILES, VendorDevice
from tests._fakes import (
    FakeConfigEntries,
    FakeConfigEntry,
    FakeHass,
    FakeState,
    make_coordinator,
)
from tests.test_entity_identity import SENSOR_IDS, TREE

ENTRY_ID = "helman-entry"


class LegacyDevice:
    """A device on HA up to 2026.7: a set of owning entries."""

    def __init__(self, device_id, owners, identifiers=()) -> None:
        self.id = device_id
        self.config_entries = set(owners)
        self.primary_config_entry = next(iter(owners), None)
        self.identifiers = set(identifiers)


class ModernDevice:
    """A device on HA 2026.8+: one owner; reading the old set is an error here."""

    def __init__(self, device_id, owner, identifiers=()) -> None:
        self.id = device_id
        self.config_entry_id = owner
        self.identifiers = set(identifiers)

    @property
    def config_entries(self):
        raise AssertionError("the deprecated config_entries was read")


class FakeDeviceRegistry:
    def __init__(self, devices) -> None:
        self.devices = {device.id: device for device in devices}
        self.removed: list[str] = []

    def async_get_device(self, identifiers):
        return next(
            (d for d in self.devices.values() if d.identifiers & identifiers), None
        )

    def async_remove_device(self, device_id) -> None:
        self.removed.append(device_id)
        del self.devices[device_id]

    def entries_for_config_entry(self, entry_id):
        return [
            d
            for d in self.devices.values()
            if (
                d.config_entry_id == entry_id
                if isinstance(d, ModernDevice)
                else entry_id in d.config_entries
            )
        ]


class FakeRow:
    def __init__(
        self,
        entity_id,
        device_id,
        *,
        platform=DOMAIN,
        config_entry_id=ENTRY_ID,
        unique_id=None,
        name=None,
        disabled_by=None,
    ) -> None:
        self.entity_id = entity_id
        self.device_id = device_id
        self.platform = platform
        self.config_entry_id = config_entry_id
        self.unique_id = unique_id or entity_id
        self.name = name
        self.disabled_by = disabled_by


class FakeEntityRegistry:
    def __init__(self, rows) -> None:
        self._rows = {row.entity_id: row for row in rows}
        self.updates: list[tuple[str, dict]] = []

    def async_get(self, entity_id):
        return self._rows.get(entity_id)

    def async_update_entity(self, entity_id, **changes):
        self.updates.append((entity_id, dict(changes)))
        row = self._rows[entity_id]
        for name, value in changes.items():
            setattr(row, name, value)
        return row

    def entries_for_config_entry(self, entry_id):
        return [row for row in self._rows.values() if row.config_entry_id == entry_id]


@contextmanager
def registries(rows=(), devices=()):
    ent_reg = FakeEntityRegistry(rows)
    dev_reg = FakeDeviceRegistry(devices)
    with (
        patch("homeassistant.helpers.entity_registry.async_get", return_value=ent_reg),
        patch(
            "homeassistant.helpers.entity_registry.async_entries_for_config_entry",
            side_effect=lambda registry, entry_id: registry.entries_for_config_entry(
                entry_id
            ),
        ),
        patch("homeassistant.helpers.device_registry.async_get", return_value=dev_reg),
        patch(
            "homeassistant.helpers.device_registry.async_entries_for_config_entry",
            side_effect=lambda registry, entry_id: registry.entries_for_config_entry(
                entry_id
            ),
        ),
    ):
        yield ent_reg, dev_reg


def _hass(states=None) -> FakeHass:
    hass = FakeHass(states)
    hass.config_entries = FakeConfigEntries(
        [
            FakeConfigEntry(ENTRY_ID),
            FakeConfigEntry("other-helman"),
            FakeConfigEntry("shelly-entry", domain="shelly"),
        ]
    )
    return hass


ENTRY = FakeConfigEntry(ENTRY_ID)
RELAY = LegacyDevice("relay", {"shelly-entry"}, {("shelly", "relay")})


def _consumers(*devices) -> dict:
    return {"devices": {"consumers": list(devices)}}


def _node(entity) -> str:
    (identifier,) = entity.device_info["identifiers"]
    assert identifier[0] == DOMAIN
    return identifier[1].removeprefix(f"{ENTRY_ID}_")


# --- node and fallback assignment --------------------------------------------


def _node_of_sensor(suffix: str) -> str:
    if suffix.endswith("_klima"):
        return "device_klima"
    for node in ("solar", "battery", "grid"):
        if suffix.startswith(node):
            return node
    return "house"


def _setup(platform, entry, hass) -> list:
    added: list = []
    with registries():
        asyncio.run(platform.async_setup_entry(hass, entry, added.extend))
    return added


def test_every_sensor_sits_on_its_node_device() -> None:
    hass = _hass()
    coordinator = make_coordinator(_hass=hass)
    coordinator._tree_index = TreeIndex.from_tree(TREE)
    coordinator.get_device_tree = AsyncMock(return_value=TREE)
    entry = FakeConfigEntry(ENTRY_ID, runtime_data=coordinator)

    added = _setup(sensor_module, entry, hass)

    assert len(added) == len(SENSOR_IDS)
    for entity in added:
        suffix = entity.unique_id.removeprefix(f"{ENTRY_ID}_")
        assert _node(entity) == _node_of_sensor(suffix), entity.unique_id
    names = {e.device_info["name"] for e in added}
    assert names == {
        "Helman Solar",
        "Helman Battery",
        "Helman Grid",
        "Helman House",
        "Klima",
    }


def test_the_inverter_mode_select_sits_on_the_inverter_device() -> None:
    entry = FakeConfigEntry(ENTRY_ID, runtime_data=NS(config={}))
    with patch.object(
        select_module, "find_mode_vendor", return_value=(PROFILES["solax_inverter"], None)
    ):
        (select,) = _setup(select_module, entry, _hass())

    assert _node(select) == "inverter"
    assert select.device_info["name"] == "Helman Inverter"
    assert select.device_info["entry_type"] == "service"


def _charger(device) -> VendorDevice:
    return VendorDevice(
        path="devices.consumers[0]",
        device=device,
        profile=PROFILES["solax_ev_charger"],
        entry=None,
        device_id=device.get("profile", {}).get("device_id"),
    )


def test_the_ev_charging_switch_falls_back_to_a_device_named_after_the_charger() -> None:
    device = {"kind": "ev_charger", "id": "garage-ev", "name": "Garage EV"}
    entry = FakeConfigEntry(ENTRY_ID, runtime_data=NS(config=_consumers(device)))
    with patch.object(
        switch_module,
        "find_charging_devices",
        return_value=[("garage-ev", _charger(device))],
    ):
        (switch,) = _setup(switch_module, entry, _hass())

    assert _node(switch) == "device_garage-ev"
    assert switch.device_info["name"] == "Garage EV"
    assert switch.device_info["manufacturer"] == "Helman"
    assert switch.device_info.get("entry_type") is None
    assert switch.translation_key == "ev_charging"


def test_the_fallback_name_is_the_resolved_and_cleaned_device_name() -> None:
    hass = _hass({"sensor.pump_power": FakeState("1", attributes={"friendly_name": "Pump Power"})})
    config = {
        "devices": {
            "name_cleaner_regex": " Power$",
            "consumers": [
                {"id": "pump", "consumption": {"power_entity_id": "sensor.pump_power"}}
            ],
        }
    }
    with registries():
        binding = consumer_device_binding(hass, ENTRY, config, device_id="pump")

    assert binding.device_entry is None
    assert binding.device_info["name"] == "Pump"
    assert binding.device_info["identifiers"] == {(DOMAIN, f"{ENTRY_ID}_device_pump")}
    assert not binding.shared


def test_a_consumer_missing_from_the_config_is_named_by_its_fallback_name() -> None:
    with registries():
        binding = consumer_device_binding(
            _hass(), ENTRY, {}, device_id="klima", fallback_name="Klima"
        )

    assert binding.device_info["name"] == "Klima"


# --- linking to real hardware ------------------------------------------------


@pytest.mark.parametrize(
    "device",
    [
        {"id": "pump", "profile": {"id": "solax_ev_charger", "device_id": "relay"}},
        {"id": "pump", "consumption": {"power_entity_id": "sensor.relay_power"}},
        {"id": "pump", "consumption": {"energy_entity_id": "sensor.relay_energy"}},
        {"id": "pump", "controls": {"switch": {"entity_id": "switch.relay"}}},
    ],
    ids=["profile", "power", "energy", "control"],
)
def test_a_consumer_links_to_its_hardware_device(device) -> None:
    rows = [
        FakeRow(entity_id, "relay", platform="shelly", config_entry_id="shelly-entry")
        for entity_id in ("sensor.relay_power", "sensor.relay_energy", "switch.relay")
    ]
    with registries(rows, [RELAY]):
        binding = consumer_device_binding(
            _hass(), ENTRY, _consumers(device), device_id="pump"
        )
        sensor = sensor_module.HelmanSharePowerSensor(
            ENTRY, "pump", "sensor.helman_share_power_pump", binding=binding
        )

    assert binding.device_entry is RELAY
    assert binding.device_info is None
    assert sensor.device_entry is RELAY
    # Left unset, so the platform registers the entity on the device as it is.
    assert sensor.device_info is None
    assert sensor.translation_key == "share_power"
    assert RELAY.config_entries == {"shelly-entry"}


def _two_relay_rows():
    return [
        FakeRow(entity_id, "relay", platform="shelly", config_entry_id="shelly-entry")
        for entity_id in ("switch.relay_0", "switch.relay_1")
    ]


def _on_relay(device_id, channel, name=None):
    device = {"id": device_id, "controls": {"switch": {"entity_id": f"switch.relay_{channel}"}}}
    if name:
        device["name"] = name
    return device


def test_consumers_sharing_a_device_get_the_named_key() -> None:
    config = _consumers(_on_relay("pump", 0, "Pump"), _on_relay("heater", 1, "Heater"))
    with registries(_two_relay_rows(), [RELAY]):
        binding = consumer_device_binding(_hass(), ENTRY, config, device_id="pump")
        sensor = sensor_module.HelmanShareEnergySensor(ENTRY, "pump", binding=binding)

    assert binding.shared
    assert sensor.device_entry is RELAY
    assert sensor.translation_key == "share_energy_named"
    assert sensor.translation_placeholders == {"name": "Pump"}


def test_consumers_sharing_a_device_under_one_name_get_their_ids_appended() -> None:
    hass = _hass(
        {
            f"switch.relay_{channel}": FakeState("on", attributes={"friendly_name": "Relay"})
            for channel in (0, 1)
        }
    )
    config = _consumers(_on_relay("pump", 0), _on_relay("heater", 1))
    with registries(_two_relay_rows(), [RELAY]):
        pump = consumer_device_binding(hass, ENTRY, config, device_id="pump")
        heater = consumer_device_binding(hass, ENTRY, config, device_id="heater")

    assert (pump.name, heater.name) == ("Relay (pump)", "Relay (heater)")


def test_the_ev_charging_switch_on_a_shared_charger_gets_the_named_key() -> None:
    device = {
        "kind": "ev_charger",
        "id": "garage-ev",
        "name": "Garage EV",
        "profile": {"id": "solax_ev_charger", "device_id": "relay"},
    }
    config = _consumers(device, _on_relay("pump", 0, "Pump"))
    with registries(_two_relay_rows(), [RELAY]):
        switch = switch_module.HelmanEvChargingSwitch(
            "garage-ev",
            _charger(device),
            binding=consumer_device_binding(
                _hass(), ENTRY, config, device_id="garage-ev", device=device
            ),
        )

    assert switch.device_entry is RELAY
    assert switch.translation_key == "ev_charging_named"
    assert switch.translation_placeholders == {"name": "Garage EV"}


@pytest.mark.parametrize(
    ("row", "device"),
    [
        (FakeRow("sensor.pump_power", "relay"), RELAY),
        (
            FakeRow("sensor.pump_power", "relay", platform="template"),
            RELAY,
        ),
        (
            FakeRow("sensor.pump_power", "hub", platform="template", config_entry_id=None),
            LegacyDevice("hub", {"other-helman"}, {(DOMAIN, "other-helman")}),
        ),
        (
            FakeRow("sensor.pump_power", "gone", platform="template", config_entry_id=None),
            None,
        ),
    ],
    ids=["helman-platform", "helman-entry", "helman-device", "missing-device"],
)
def test_a_consumer_never_links_to_helman_itself(row, device) -> None:
    config = _consumers(
        {"id": "pump", "consumption": {"power_entity_id": "sensor.pump_power"}}
    )
    with registries([row], [device] if device else []):
        binding = consumer_device_binding(_hass(), ENTRY, config, device_id="pump")

    assert binding.device_entry is None
    assert _node(NS(device_info=binding.device_info)) == "device_pump"


def test_the_house_unmeasured_sensor_sits_on_the_house_device() -> None:
    hass = _hass()
    coordinator = make_coordinator(_hass=hass)
    entry = FakeConfigEntry(ENTRY_ID, runtime_data=coordinator)
    coordinator.get_device_tree = AsyncMock(return_value={"sources": [], "consumers": []})
    coordinator.set_entity_factory = Mock()
    coordinator._tree_index = TreeIndex.from_tree(TREE)
    coordinator._active_config = _consumers(
        {
            "id": "boiler",
            "consumption": {"energy_entity_id": "sensor.boiler_energy"},
            "children": [{"id": "pump", "consumption": {"energy_entity_id": "sensor.pump_energy"}}],
        }
    )
    rows = [
        FakeRow("sensor.boiler_energy", "relay", platform="shelly", config_entry_id="shelly-entry")
    ]
    with registries(rows, [RELAY]):
        asyncio.run(sensor_module.async_setup_entry(hass, entry, lambda _: None))
        unmeasured = coordinator.set_entity_factory.call_args.args[1]["unmeasured"]
        (house,) = unmeasured("house", "sensor.house_power")
        (nested,) = unmeasured("sensor.boiler_energy", "sensor.boiler_power")

    assert _node(house) == "house"
    assert house.translation_key == "unmeasured_power"
    assert nested.device_entry is RELAY
    assert nested.device_info is None
    assert nested.translation_key == "unmeasured_power"


def test_a_meterless_parents_unmeasured_sensor_sits_on_its_consumer_device() -> None:
    # The node of a meterless parent is its share-energy sensor.
    config = _consumers(
        {
            "id": "boiler",
            "consumption": {"energy_entity_id": "sensor.boiler_energy"},
            "children": [
                {
                    "id": "child",
                    "children": [
                        {"id": "grandchild", "consumption": {"energy_entity_id": "sensor.gc_energy"}}
                    ],
                }
            ],
        }
    )
    with registries():
        binding = consumer_device_binding(
            _hass(), ENTRY, config, meter_entity_id="sensor.helman_share_energy_child"
        )

    assert _node(NS(device_info=binding.device_info)) == "device_child"
    assert binding.name == "child"


def test_helmans_own_switch_never_names_its_charger() -> None:
    switch_id = "switch.helman_ev_charging_garage_ev"
    hass = _hass(
        {switch_id: FakeState("off", attributes={"friendly_name": "garage-ev EV charging"})}
    )
    device = {"kind": "ev_charger", "id": "garage-ev", "controls": {"charge": {"entity_id": switch_id}}}
    with registries([FakeRow(switch_id, "helman-device")]):
        binding = consumer_device_binding(
            hass, ENTRY, _consumers(device), device_id="garage-ev", device=device
        )

    assert binding.name == "garage-ev"


def test_the_consumer_counts_are_computed_once_per_tree_build() -> None:
    hass = _hass()
    coordinator = make_coordinator(_hass=hass)
    entry = FakeConfigEntry(ENTRY_ID, runtime_data=coordinator)
    coordinator.get_device_tree = AsyncMock(return_value={"sources": [], "consumers": []})
    coordinator.set_entity_factory = Mock()
    coordinator._tree_index = TreeIndex.from_tree(TREE)
    coordinator._active_config = _consumers(_on_relay("pump", 0), _on_relay("heater", 1))
    with (
        registries(),
        patch.object(
            sensor_module, "foreign_device_consumer_counts", return_value={}
        ) as counts,
    ):
        asyncio.run(sensor_module.async_setup_entry(hass, entry, lambda _: None))
        factories = coordinator.set_entity_factory.call_args.args[1]
        factories["share"]("pump", "sensor.helman_share_power_pump", "Pump")
        factories["share"]("heater", "sensor.helman_share_power_heater", "Heater")
        assert counts.call_count == 1
        coordinator._tree_index = TreeIndex.from_tree(TREE)
        factories["share"]("pump", "sensor.helman_share_power_pump", "Pump")
        assert counts.call_count == 2


def test_the_ev_charging_switches_share_one_consumer_count() -> None:
    devices = [
        {"kind": "ev_charger", "id": device_id, "name": device_id}
        for device_id in ("garage-ev", "drive-ev")
    ]
    entry = FakeConfigEntry(ENTRY_ID, runtime_data=NS(config=_consumers(*devices)))
    with (
        patch.object(
            switch_module,
            "find_charging_devices",
            return_value=[(d["id"], _charger(d)) for d in devices],
        ),
        patch.object(
            switch_module, "foreign_device_consumer_counts", return_value={}
        ) as counts,
    ):
        switches = _setup(switch_module, entry, _hass())

    assert len(switches) == 2
    assert counts.call_count == 1


# --- ownership and cleanup ---------------------------------------------------


def test_owner_ids_read_either_device_shape() -> None:
    assert device_owner_entry_ids(LegacyDevice("a", {"x", "y"})) == {"x", "y"}
    # Never touches the deprecated set when the single owner is there.
    assert device_owner_entry_ids(ModernDevice("b", "x")) == {"x"}
    assert device_owner_entry_ids(ModernDevice("c", None)) == set()


@pytest.mark.parametrize("device_type", [LegacyDevice, ModernDevice])
def test_cleanup_retires_the_hub_and_orphans_and_spares_foreign_devices(device_type) -> None:
    def device(device_id, owner, identifiers=()):
        if device_type is LegacyDevice:
            return LegacyDevice(device_id, {owner}, identifiers)
        return ModernDevice(device_id, owner, identifiers)

    hub = device("hub", ENTRY_ID, {(DOMAIN, ENTRY_ID)})
    house = device("house", ENTRY_ID, {(DOMAIN, f"{ENTRY_ID}_house")})
    orphan = device("orphan", ENTRY_ID, {(DOMAIN, f"{ENTRY_ID}_device_gone")})
    foreign = device("relay", "shelly-entry", {("shelly", "relay")})
    leftover = FakeRow(
        "sensor.helman_old", "hub", unique_id="old", name="Mine", disabled_by="user"
    )
    rows = [
        # Re-registered by platform setup: already on its node device.
        FakeRow("sensor.helman_consumer_total_power", "house"),
        leftover,
        FakeRow("sensor.helman_disabled", "house", disabled_by="user"),
        FakeRow("sensor.helman_share_power_pump", "relay"),
        FakeRow("sensor.relay_power", "relay", platform="shelly", config_entry_id="shelly-entry"),
    ]
    with registries(rows, [hub, house, orphan, foreign]) as (ent_reg, dev_reg):
        remove_stale_devices(_hass(), ENTRY)

    assert ent_reg.updates == [("sensor.helman_old", {"device_id": None})]
    assert (leftover.entity_id, leftover.unique_id, leftover.name, leftover.disabled_by) == (
        "sensor.helman_old",
        "old",
        "Mine",
        "user",
    )
    assert sorted(dev_reg.removed) == ["hub", "orphan"]
    assert set(dev_reg.devices) == {"house", "relay"}
    assert device_owner_entry_ids(foreign) == {"shelly-entry"}


def test_cleanup_spares_a_device_helman_shares_with_another_entry() -> None:
    shared = LegacyDevice("shared", {ENTRY_ID, "shelly-entry"})
    with registries([], [shared]) as (_ent_reg, dev_reg):
        remove_stale_devices(_hass(), ENTRY)

    assert dev_reg.removed == []
    assert shared.config_entries == {ENTRY_ID, "shelly-entry"}
