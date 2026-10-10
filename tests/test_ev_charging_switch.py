"""Helman's EV charging switch drives the SolaX EV charger profile's writes."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch

import pytest

from custom_components.helman import switch as switch_module
from custom_components.helman.switch import HelmanEvChargingSwitch
from custom_components.helman.vendors import PROFILES, VendorDevice

RUN_MODE = "sensor.solax_ev_charger_run_mode"
COMMAND = "select.solax_ev_charger_control_command"
USE_MODE = "select.solax_ev_charger_charger_use_mode"

#: The charger device's registry on prod, 2026-10-10: (domain, unique id) →
#: entity id. ``control_command`` is a sensor too; the select is the one written.
CHARGER_ROWS = {
    ("sensor", "SolaX_EV_Charger_run_mode"): RUN_MODE,
    ("select", "SolaX_EV_Charger_control_command"): COMMAND,
    ("sensor", "SolaX_EV_Charger_control_command"): "sensor.solax_ev_charger_control_command",
    ("select", "SolaX_EV_Charger_charger_use_mode"): USE_MODE,
}

CHARGER_ENTRY = NS(entry_id="charger-entry", title="SolaX_EV_Charger", options={}, data={})


def _resolve(_hass, _profile, entry, templates, *, device_id):
    assert device_id == "charger-device"
    return {
        (domain, template): CHARGER_ROWS.get((domain, template.format(name=entry.title)))
        for domain, template in templates
    }


def vendor_device(device_id="garage-ev", name="Garage EV"):
    return VendorDevice(
        path="devices.consumers[0]",
        device={"kind": "ev_charger", "id": device_id, "name": name},
        profile=PROFILES["solax_ev_charger"],
        entry=CHARGER_ENTRY,
        device_id="charger-device",
    )


def build(states):
    """A switch over fake hass; ``states`` maps entity id → state string.

    Each write is applied to ``states``, as the charger's select would show it.
    """
    calls: list[tuple[str, str]] = []

    async def async_call(domain, service, data, *, blocking):
        assert blocking is True
        assert (domain, service) == ("select", "select_option")
        calls.append((data["entity_id"], data["option"]))
        states[data["entity_id"]] = data["option"]

    hass = NS(
        states=NS(
            get=lambda entity_id: (
                NS(state=states[entity_id]) if entity_id in states else None
            )
        ),
        services=NS(async_call=AsyncMock(side_effect=async_call)),
        bus=NS(async_listen=Mock(return_value=Mock())),
    )
    entity = HelmanEvChargingSwitch(NS(entry_id="helman-entry"), "garage-ev", vendor_device())
    entity.hass = hass
    entity.async_write_ha_state = Mock()
    entity.async_on_remove = Mock()
    track = Mock(return_value=Mock())
    with (
        patch.object(switch_module, "resolve_unique_ids", side_effect=_resolve),
        patch.object(switch_module, "async_track_state_change_event", track),
        patch.object(switch_module.SwitchEntity, "async_added_to_hass", AsyncMock()),
    ):
        asyncio.run(entity.async_added_to_hass())
    return entity, calls, track


def test_identity():
    entity, _calls, _track = build({})

    assert entity.unique_id == "helman_ev_charging_garage-ev"
    assert entity.entity_id == "switch.helman_ev_charging_garage_ev"
    assert entity.name == "Garage EV"


@pytest.mark.parametrize(
    ("run_mode", "available", "is_on"),
    [
        ("Charging", True, True),
        ("Available", True, False),
        ("unavailable", False, False),
    ],
)
def test_the_state_follows_the_run_mode(run_mode, available, is_on):
    entity, _calls, _track = build({RUN_MODE: run_mode})

    assert entity.available is available
    assert entity.is_on is is_on


def test_without_a_run_mode_entity_the_switch_is_unavailable():
    entity, _calls, _track = build({})

    assert entity.available is False
    assert entity.is_on is None


def test_a_registry_update_resolves_a_renamed_entity_again():
    renamed = "sensor.charger_run_mode"
    entity, _calls, track = build({RUN_MODE: "Available", renamed: "Charging"})
    [(_event, on_update)] = [call.args for call in entity.hass.bus.async_listen.call_args_list]
    old_untrack = track.return_value

    rows = {**CHARGER_ROWS, ("sensor", "SolaX_EV_Charger_run_mode"): renamed}
    with (
        patch.dict(CHARGER_ROWS, rows),
        patch.object(switch_module, "resolve_unique_ids", side_effect=_resolve),
        patch.object(switch_module, "async_track_state_change_event", track),
    ):
        on_update(NS())

    old_untrack.assert_called_once_with()
    assert track.call_args.args[1] == [renamed]
    assert entity.is_on is True
    entity.async_write_ha_state.assert_called_once()


def test_a_run_mode_change_writes_the_state():
    entity, _calls, track = build({RUN_MODE: "Available"})

    [(_hass, entity_ids, on_change)] = [call.args for call in track.call_args_list]
    assert entity_ids == [RUN_MODE]
    on_change(NS())
    entity.async_write_ha_state.assert_called_once()


@pytest.mark.parametrize(
    ("shown", "expected"),
    [
        ("Stop Charging", [(COMMAND, "Start Charging")]),
        ("Start Charging", [(COMMAND, "Start Charging"), (COMMAND, "Start Charging")]),
    ],
)
def test_turn_on_writes_the_start_command(shown, expected):
    entity, calls, _track = build({RUN_MODE: "Available", COMMAND: shown})

    asyncio.run(entity.async_turn_on())

    assert calls == expected


@pytest.mark.parametrize(
    ("shown", "expected"),
    [
        ("Start Charging", [(COMMAND, "Stop Charging"), (USE_MODE, "ECO")]),
        (
            "Stop Charging",
            [(COMMAND, "Stop Charging"), (COMMAND, "Stop Charging"), (USE_MODE, "ECO")],
        ),
    ],
)
def test_turn_off_writes_the_stop_command_then_eco(shown, expected):
    entity, calls, _track = build(
        {RUN_MODE: "Charging", COMMAND: shown, USE_MODE: "Fast"}
    )

    asyncio.run(entity.async_turn_off())

    assert calls == expected


def test_setup_adds_a_switch_per_charger_and_drops_stale_ones():
    added: list = []
    rows = [
        NS(domain="switch", unique_id="helman_ev_charging_garage-ev", entity_id="switch.a"),
        NS(domain="switch", unique_id="helman_ev_charging_gone", entity_id="switch.b"),
        NS(domain="select", unique_id="helman_inverter_mode", entity_id="select.c"),
    ]
    registry = NS(async_remove=Mock())
    hass = NS(data={"helman": {"coordinator": NS(config={})}})

    with (
        patch.object(
            switch_module,
            "find_charging_devices",
            return_value=[("garage-ev", vendor_device())],
        ),
        patch("homeassistant.helpers.entity_registry.async_get", return_value=registry),
        patch(
            "homeassistant.helpers.entity_registry.async_entries_for_config_entry",
            return_value=rows,
        ),
    ):
        asyncio.run(
            switch_module.async_setup_entry(hass, NS(entry_id="helman-entry"), added.extend)
        )

    [entity] = added
    assert entity.unique_id == "helman_ev_charging_garage-ev"
    registry.async_remove.assert_called_once_with("switch.b")
