"""Helman's inverter mode select applies the SolaX profile's writes."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch

import pytest
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.restore_state import RestoreEntity

from custom_components.helman import select as select_module
from custom_components.helman.scheduling import actuation as actuation_module
from custom_components.helman.select import HelmanInverterModeSelect
from custom_components.helman.vendors import PROFILES

USE_MODE = "select.solax_charger_use_mode"
MANUAL_MODE = "select.solax_manual_mode_select"
EXPORT_LIMIT = "number.solax_export_control_user_limit"

#: The prod registry on 2026-10-09: unique id → entity id.
SOLAX_CONTROLS = {
    "SolaX_charger_use_mode": USE_MODE,
    "SolaX_manual_mode_select": MANUAL_MODE,
    "SolaX_export_control_user_limit": EXPORT_LIMIT,
}

#: The issue's table, as the prod automation ``rezim_fv_solax_rezimy`` writes
#: it: the use mode, then the manual mode, then the export limit.
EXPECTED_CALLS = {
    "normal": [(USE_MODE, "Self Use Mode"), (EXPORT_LIMIT, 9900)],
    "charge_to_target_soc": [
        (USE_MODE, "Manual Mode"),
        (MANUAL_MODE, "Force Charge"),
        (EXPORT_LIMIT, 9900),
    ],
    "discharge_to_target_soc": [
        (USE_MODE, "Manual Mode"),
        (MANUAL_MODE, "Force Discharge"),
        (EXPORT_LIMIT, 9900),
    ],
    "stop_charging": [(USE_MODE, "Feedin Priority"), (EXPORT_LIMIT, 9900)],
    "stop_discharging": [
        (USE_MODE, "Manual Mode"),
        (MANUAL_MODE, "Stop Charge and Discharge"),
        (EXPORT_LIMIT, 9900),
    ],
    "stop_export": [(USE_MODE, "Self Use Mode"), (EXPORT_LIMIT, 0)],
}

VENDOR_ENTRY = NS(entry_id="solax-entry", title="SolaX", options={}, data={})


def _resolve(_hass, _profile, entry, templates):
    return {
        template: SOLAX_CONTROLS.get(template[1].format(name=entry.title))
        for template in templates
    }


def build(states=None, *, grid=None):
    """A select over fake hass; ``states`` maps entity id → state string."""
    calls: list[tuple[str, object]] = []

    async def async_call(domain, service, data, *, blocking):
        assert blocking is True
        assert (domain, service) == (
            ("number", "set_value") if domain == "number" else ("select", "select_option")
        )
        calls.append((data["entity_id"], data.get("option", data.get("value"))))

    hass = NS(
        states=NS(
            get=lambda entity_id: (
                NS(state=states[entity_id]) if entity_id in (states or {}) else None
            )
        ),
        services=NS(async_call=AsyncMock(side_effect=async_call)),
    )
    coordinator = NS(
        config={
            "energy_nodes": {
                "grid": {"max_allowed_export_power": 9900} if grid is None else grid
            }
        }
    )
    entity = HelmanInverterModeSelect(
        coordinator, NS(entry_id="helman-entry"), PROFILES["solax_inverter"], VENDOR_ENTRY
    )
    entity.hass = hass
    entity.async_write_ha_state = Mock()
    return entity, calls


def select(entity, option):
    with patch.object(select_module, "resolve_unique_ids", side_effect=_resolve):
        asyncio.run(entity.async_select_option(option))


def test_identity():
    entity, _calls = build()

    assert entity.unique_id == "helman_inverter_mode"
    assert entity.entity_id == "select.helman_inverter_mode"
    assert entity.translation_key == "inverter_mode"
    assert entity.options == [
        "normal",
        "stop_charging",
        "stop_discharging",
        "charge_to_target_soc",
        "discharge_to_target_soc",
        "stop_export",
    ]


@pytest.mark.parametrize("option", list(EXPECTED_CALLS))
def test_each_option_writes_the_table_in_order(option):
    entity, calls = build(
        {USE_MODE: "Back Up Mode", MANUAL_MODE: "unknown", EXPORT_LIMIT: "5000"}
    )

    select(entity, option)

    assert calls == EXPECTED_CALLS[option]
    assert entity.current_option == option
    entity.async_write_ha_state.assert_called_once()


def test_an_entity_already_in_its_target_state_is_skipped():
    entity, calls = build(
        {USE_MODE: "Manual Mode", MANUAL_MODE: "Force Charge", EXPORT_LIMIT: "9900.0"}
    )

    select(entity, "stop_discharging")

    assert calls == [(MANUAL_MODE, "Stop Charge and Discharge")]


def test_a_failed_write_surfaces_and_keeps_the_last_option():
    entity, _calls = build()
    entity._attr_current_option = "normal"
    entity.hass.services.async_call = AsyncMock(side_effect=RuntimeError("modbus"))

    with pytest.raises(HomeAssistantError, match=USE_MODE):
        select(entity, "stop_charging")

    assert entity.current_option == "normal"
    entity.async_write_ha_state.assert_not_called()


def test_a_stalled_write_times_out_and_releases_the_lock():
    entity, _calls = build()

    async def stall(*_args, **_kwargs):
        await asyncio.sleep(3600)

    entity.hass.services.async_call = AsyncMock(side_effect=stall)

    with patch.object(actuation_module, "SERVICE_CALL_TIMEOUT_SECONDS", 0.01), pytest.raises(
        HomeAssistantError, match="Timed out"
    ):
        select(entity, "stop_charging")

    assert not entity._lock.locked()


def test_without_an_export_cap_nothing_is_written():
    entity, calls = build(grid={})

    with pytest.raises(HomeAssistantError, match="max_allowed_export_power"):
        select(entity, "normal")

    assert calls == []


def test_stop_export_needs_no_export_cap():
    entity, calls = build(grid={})

    select(entity, "stop_export")

    assert calls == EXPECTED_CALLS["stop_export"]


def test_an_unresolved_vendor_entity_writes_nothing():
    entity, calls = build()

    with patch.object(
        select_module,
        "resolve_unique_ids",
        side_effect=lambda hass, profile, entry, templates: dict.fromkeys(templates),
    ), pytest.raises(HomeAssistantError, match="charger_use_mode"):
        asyncio.run(entity.async_select_option("normal"))

    assert calls == []


def test_restore_shows_the_last_option_without_applying_it():
    entity, calls = build()

    with (
        patch.object(RestoreEntity, "async_added_to_hass", AsyncMock()),
        patch.object(
            HelmanInverterModeSelect,
            "async_get_last_state",
            AsyncMock(return_value=NS(state="stop_export")),
        ),
    ):
        asyncio.run(entity.async_added_to_hass())

    assert entity.current_option == "stop_export"
    assert calls == []
    entity.hass.services.async_call.assert_not_called()


@pytest.mark.parametrize(
    ("states", "expected"),
    [
        ({USE_MODE: "Manual Mode", MANUAL_MODE: "Force Charge", EXPORT_LIMIT: "9900.0"},
         "charge_to_target_soc"),
        ({USE_MODE: "Self Use Mode", MANUAL_MODE: "Force Charge", EXPORT_LIMIT: "0"},
         "stop_export"),
        ({USE_MODE: "Back Up Mode", MANUAL_MODE: "Force Charge", EXPORT_LIMIT: "9900"}, None),
    ],
)
def test_without_a_restored_state_the_vendor_state_is_the_option(states, expected):
    entity, calls = build(states)

    with (
        patch.object(RestoreEntity, "async_added_to_hass", AsyncMock()),
        patch.object(
            HelmanInverterModeSelect, "async_get_last_state", AsyncMock(return_value=None)
        ),
        patch.object(select_module, "resolve_unique_ids", side_effect=_resolve),
    ):
        asyncio.run(entity.async_added_to_hass())

    assert entity.current_option == expected
    assert calls == []


def _setup(config, registered=None):
    added: list = []
    registry = NS(
        async_get_entity_id=lambda domain, platform, unique_id: registered,
        async_remove=Mock(),
    )
    hass = NS(
        data={"helman": {"coordinator": NS(config=config)}},
        config_entries=NS(
            async_get_entry=lambda entry_id: NS(
                entry_id=entry_id,
                domain="solax_modbus",
                disabled_by=None,
                source="user",
            )
        ),
    )
    with patch("homeassistant.helpers.entity_registry.async_get", return_value=registry):
        asyncio.run(
            select_module.async_setup_entry(hass, NS(entry_id="helman-entry"), added.extend)
        )
    return added, registry


def test_the_select_exists_only_with_the_solax_profile():
    assert _setup({"energy_nodes": {"inverter": {}}})[0] == []

    profile = {"id": "solax_inverter", "entry_id": "solax-entry"}
    [entity], _registry = _setup({"energy_nodes": {"inverter": {"profile": profile}}})
    assert isinstance(entity, HelmanInverterModeSelect)


def test_back_on_custom_the_registered_select_is_removed():
    added, registry = _setup(
        {"energy_nodes": {"inverter": {}}}, registered="select.helman_inverter_mode"
    )

    assert added == []
    registry.async_remove.assert_called_once_with("select.helman_inverter_mode")
