"""Hardware profiles fill the config they own from the entity registry."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from types import SimpleNamespace as NS
from unittest.mock import patch

import pytest

from custom_components.helman.config_validation import validate_config_document
from custom_components.helman.controllables.spec import CONTROLLABLE_SPECS
from custom_components.helman.vendors import (
    PROFILES,
    describe_vendors,
    resolve_vendor_config,
)

ENTRY_ID = "solax-entry"
INVERTER_ACTION_KINDS = list(CONTROLLABLE_SPECS["inverter"].action_option_attrs)

#: The issue's table, as the prod registry had it on 2026-10-09: config path →
#: (unique id, entity id).
SOLAX_ROWS = {
    "energy_nodes.solar.entities.power": (
        "SolaX_pv_power_total",
        "sensor.solax_pv_power_total",
    ),
    "energy_nodes.solar.entities.today_energy": (
        "SolaX_today_s_solar_energy",
        "sensor.solax_today_s_solar_energy",
    ),
    "training.solar_bias.total_energy_entity_id": (
        "SolaX_total_solar_energy",
        "sensor.solax_total_solar_energy",
    ),
    "energy_nodes.battery.entities.power": (
        "SolaX Energy Dashboard_solax_battery_power",
        "sensor.solax_energy_dashboard_solax_battery_power",
    ),
    "energy_nodes.battery.entities.capacity": (
        "SolaX_battery_capacity",
        "sensor.solax_battery_capacity",
    ),
    "energy_nodes.battery.entities.remaining_energy": (
        "SolaX_remaining_battery_capacity",
        "sensor.solax_remaining_battery_capacity",
    ),
    "energy_nodes.battery.entities.min_soc": (
        "SolaX_selfuse_discharge_min_soc",
        "number.solax_selfuse_discharge_min_soc",
    ),
    "energy_nodes.battery.entities.max_soc": (
        "SolaX_battery_charge_upper_soc",
        "number.solax_battery_charge_upper_soc",
    ),
    "energy_nodes.battery.entities.today_charge_energy": (
        "SolaX_battery_input_energy_today",
        "sensor.solax_battery_input_energy_today",
    ),
    "energy_nodes.battery.entities.today_discharge_energy": (
        "SolaX_battery_output_energy_today",
        "sensor.solax_battery_output_energy_today",
    ),
    "energy_nodes.grid.entities.power": (
        "SolaX Energy Dashboard_solax_grid_power",
        "sensor.solax_energy_dashboard_solax_grid_power",
    ),
    "energy_nodes.grid.entities.today_import": (
        "SolaX_today_s_import_energy",
        "sensor.solax_today_s_import_energy",
    ),
    "energy_nodes.grid.entities.today_export": (
        "SolaX_today_s_export_energy",
        "sensor.solax_today_s_export_energy",
    ),
    "energy_nodes.house.entities.power": (
        "SolaX Energy Dashboard_solax_home_consumption_power",
        "sensor.solax_energy_dashboard_solax_home_consumption_power",
    ),
    "energy_nodes.house.entities.today_energy": (
        "SolaX Energy Dashboard_solax_home_consumption_energy",
        "sensor.solax_energy_dashboard_solax_home_consumption_energy",
    ),
    "energy_nodes.house.forecast.total_energy_entity_id": (
        "SolaX Energy Dashboard_solax_home_consumption_energy",
        "sensor.solax_energy_dashboard_solax_home_consumption_energy",
    ),
}


def registry_entry(
    unique_id, entity_id, *, platform="solax_modbus", entry_id=ENTRY_ID, disabled_by=None
):
    return NS(
        unique_id=unique_id,
        entity_id=entity_id,
        platform=platform,
        config_entry_id=entry_id,
        disabled_by=disabled_by,
    )


def solax_registry():
    return [registry_entry(*row) for row in dict(SOLAX_ROWS.values()).items()]


def config_entry(
    *,
    title="SolaX",
    data=None,
    options=None,
    domain="solax_modbus",
    disabled_by=None,
    source="user",
):
    return NS(
        entry_id=ENTRY_ID,
        domain=domain,
        title=title,
        data=data or {},
        options=options or {},
        disabled_by=disabled_by,
        source=source,
    )


def fake_hass(entries):
    by_id = {entry.entry_id: entry for entry in entries}
    return NS(
        config_entries=NS(
            async_get_entry=by_id.get,
            async_entries=lambda domain, **_: [e for e in entries if e.domain == domain],
        )
    )


@contextmanager
def registry(entries):
    def async_get_entity_id(domain, platform, unique_id):
        return next(
            (
                e.entity_id
                for e in entries
                if e.platform == platform
                and e.unique_id == unique_id
                and e.entity_id.startswith(f"{domain}.")
            ),
            None,
        )

    with (
        patch(
            "homeassistant.helpers.entity_registry.async_get",
            return_value=NS(async_get_entity_id=async_get_entity_id),
        ),
        patch(
            "homeassistant.helpers.entity_registry.async_entries_for_config_entry",
            side_effect=lambda _registry, entry_id: [
                entry for entry in entries if entry.config_entry_id == entry_id
            ],
        ),
    ):
        yield


def solax_document(**inverter_extra):
    return {
        "energy_nodes": {
            "inverter": {
                "vendor": {"profile": "solax_inverter", "entry_id": ENTRY_ID},
                **inverter_extra,
            },
            "battery": {"forecast": {"charge_efficiency": 0.95}},
        },
    }


def value_at(document, dotted):
    for key in dotted.split("."):
        document = document.get(key) if isinstance(document, dict) else None
    return document


def resolve(document, *, entries=None, hass_entries=None):
    hass = fake_hass(hass_entries if hass_entries is not None else [config_entry()])
    with registry(solax_registry() if entries is None else entries):
        return resolve_vendor_config(hass, document)


def test_every_row_of_the_solax_table_resolves():
    resolved, issues = resolve(solax_document())

    assert issues == []
    for path, (_unique_id, entity_id) in SOLAX_ROWS.items():
        assert value_at(resolved, path) == entity_id, path
    assert value_at(resolved, "energy_nodes.battery.entities.power_polarity") == (
        "positive_is_discharging"
    )
    assert value_at(resolved, "energy_nodes.grid.entities.power_polarity") == (
        "positive_is_import"
    )
    # Helman's own mode select, under its suggested id until it is registered.
    assert resolved["energy_nodes"]["inverter"]["controls"]["mode"] == {
        "entity_id": "select.helman_inverter_mode",
        "options": {kind: kind for kind in INVERTER_ACTION_KINDS},
    }
    # Site settings stay the user's.
    assert value_at(resolved, "energy_nodes.battery.forecast.charge_efficiency") == 0.95


def test_resolved_document_validates():
    document = solax_document()
    document["energy_nodes"]["grid"] = {"max_allowed_export_power": 9900}
    resolved, _issues = resolve(document)

    report = validate_config_document(resolved)

    assert report.errors == []


def test_a_renamed_entity_id_still_resolves():
    entries = solax_registry()
    entries = [
        registry_entry(e.unique_id, "number.my_min_soc")
        if e.unique_id == "SolaX_selfuse_discharge_min_soc"
        else e
        for e in entries
    ]

    resolved, issues = resolve(solax_document(), entries=entries)

    assert issues == []
    assert value_at(resolved, "energy_nodes.battery.entities.min_soc") == (
        "number.my_min_soc"
    )


def test_the_entry_name_comes_from_options_before_the_title():
    resolved, issues = resolve(
        solax_document(),
        hass_entries=[config_entry(title="My inverter", options={"name": "SolaX"})],
    )

    assert issues == []
    assert value_at(resolved, "energy_nodes.solar.entities.power") == (
        "sensor.solax_pv_power_total"
    )


def test_only_the_chosen_entry_on_the_vendor_platform_is_read():
    entries = [
        e for e in solax_registry() if e.unique_id != "SolaX_battery_capacity"
    ] + [
        registry_entry("SolaX_battery_capacity", "sensor.other_platform", platform="template"),
        registry_entry("SolaX_battery_capacity", "sensor.other_entry", entry_id="other"),
    ]

    resolved, issues = resolve(solax_document(), entries=entries)

    assert value_at(resolved, "energy_nodes.battery.entities.capacity") is None
    assert [(i.section, i.code, i.path) for i in issues] == [
        ("energy_nodes", "vendor_entity_unresolved", "energy_nodes.inverter.vendor")
    ]


@pytest.mark.parametrize(
    "entry", [config_entry(disabled_by="user"), config_entry(source="ignore")]
)
def test_a_disabled_or_ignored_config_entry_is_refused(entry):
    resolved, issues = resolve(solax_document(), hass_entries=[entry])

    assert value_at(resolved, "energy_nodes.battery.entities.capacity") is None
    assert [(i.code, i.path) for i in issues] == [
        ("invalid_choice", "energy_nodes.inverter.vendor.entry_id")
    ]


def test_a_disabled_entity_is_unresolved():
    entries = [
        e for e in solax_registry() if e.unique_id != "SolaX_battery_capacity"
    ] + [
        registry_entry(
            "SolaX_battery_capacity", "sensor.solax_battery_capacity", disabled_by="user"
        ),
    ]

    resolved, issues = resolve(solax_document(), entries=entries)

    assert value_at(resolved, "energy_nodes.battery.entities.capacity") is None
    assert [i.code for i in issues] == ["vendor_entity_unresolved"]


def test_an_unresolved_key_is_reported_and_leaves_the_slot_unset():
    entries = [e for e in solax_registry() if e.unique_id != "SolaX_battery_charge_upper_soc"]

    resolved, issues = resolve(solax_document(), entries=entries)

    assert value_at(resolved, "energy_nodes.battery.entities.max_soc") is None
    [issue] = issues
    assert issue.code == "vendor_entity_unresolved"
    assert not issue.error
    assert "energy_nodes.battery.entities.max_soc" in issue.message
    assert "SolaX_battery_charge_upper_soc" in issue.message


def test_a_stored_owned_key_is_refused():
    document = solax_document()
    document["energy_nodes"]["battery"]["entities"] = {
        "min_soc": "sensor.solax_battery_min_soc"
    }

    resolved, issues = resolve(document)

    [issue] = issues
    assert (issue.code, issue.path, issue.section, issue.error) == (
        "vendor_owned_key",
        "energy_nodes.battery.entities.min_soc",
        "energy_nodes",
        True,
    )
    # The profile still wins at runtime; validation is what refuses the save.
    assert value_at(resolved, "energy_nodes.battery.entities.min_soc") == (
        "number.solax_selfuse_discharge_min_soc"
    )


def test_the_mode_table_covers_every_inverter_action():
    assert list(PROFILES["solax_inverter"].modes) == INVERTER_ACTION_KINDS


def test_a_renamed_mode_select_still_resolves():
    entries = solax_registry() + [
        registry_entry(
            "helman_inverter_mode", "select.my_inverter_mode", platform="helman"
        )
    ]

    resolved, issues = resolve(solax_document(), entries=entries)

    assert issues == []
    assert resolved["energy_nodes"]["inverter"]["controls"]["mode"]["entity_id"] == (
        "select.my_inverter_mode"
    )


def test_a_stored_mode_control_is_refused():
    document = solax_document(
        controls={"mode": {"entity_id": "input_select.rezim_fv", "options": {}}}
    )

    resolved, issues = resolve(document)

    assert [(i.code, i.path, i.error) for i in issues] == [
        ("vendor_owned_key", "energy_nodes.inverter.controls.mode", True)
    ]
    assert resolved["energy_nodes"]["inverter"]["controls"]["mode"]["entity_id"] == (
        "select.helman_inverter_mode"
    )


def test_a_config_without_a_vendor_resolves_to_itself():
    document = {
        "energy_nodes": {
            "inverter": {},
            "battery": {"entities": {"min_soc": "sensor.min"}},
        },
    }
    original = deepcopy(document)

    # No hass at all: a document without a profile never reads it.
    resolved, issues = resolve_vendor_config(None, document)

    assert resolved == original
    assert resolved is not document
    assert issues == []


def test_a_malformed_vendor_is_reported():
    document = solax_document()
    document["energy_nodes"]["inverter"]["vendor"] = {"profile": "nope", "entry_id": ENTRY_ID}
    _resolved, issues = resolve(document)
    assert [(i.section, i.code, i.path) for i in issues] == [
        ("energy_nodes", "invalid_choice", "energy_nodes.inverter.vendor.profile")
    ]

    document["energy_nodes"]["inverter"]["vendor"] = {"profile": "solax_inverter"}
    _resolved, issues = resolve(document)
    assert [(i.code, i.path) for i in issues] == [
        ("required", "energy_nodes.inverter.vendor.entry_id")
    ]


def test_a_missing_entry_is_one_issue_and_the_profile_still_owns_its_paths():
    document = solax_document()
    document["energy_nodes"]["grid"] = {"entities": {"power": "sensor.grid"}}

    _resolved, issues = resolve(document, hass_entries=[config_entry(domain="other")])

    assert sorted((i.code, i.path) for i in issues) == [
        ("invalid_choice", "energy_nodes.inverter.vendor.entry_id"),
        ("vendor_owned_key", "energy_nodes.grid.entities.power"),
    ]


def test_a_profile_only_goes_on_its_device_kind():
    document = {
        "devices": {
            "consumers": [
                {
                    "id": "heater",
                    "vendor": {"profile": "solax_inverter", "entry_id": ENTRY_ID},
                }
            ]
        }
    }

    _resolved, issues = resolve(document)

    assert [(i.section, i.code, i.path) for i in issues] == [
        ("devices", "invalid_choice", "devices.consumers[0].vendor.profile")
    ]


def test_get_vendors_describes_profiles_and_the_draft_devices():
    hass = fake_hass([config_entry()])
    entries = [e for e in solax_registry() if e.unique_id != "SolaX_battery_capacity"]
    with registry(entries):
        payload = describe_vendors(hass, solax_document())

    [profile] = payload["profiles"]
    assert profile["id"] == "solax_inverter"
    assert profile["deviceKind"] == "inverter"
    assert profile["entries"] == [{"entryId": ENTRY_ID, "title": "SolaX"}]
    device = payload["devices"]["energy_nodes.inverter"]
    assert device["profile"] == "solax_inverter"
    assert device["ownedDevicePaths"] == ["controls.mode"]
    assert set(device["ownedConfigPaths"]) == set(SOLAX_ROWS) | {
        "energy_nodes.battery.entities.power_polarity",
        "energy_nodes.grid.entities.power_polarity",
    }
    assert device["resolved"]["energy_nodes.battery.entities.capacity"] is None
    assert device["resolved"]["energy_nodes.solar.entities.power"] == (
        "sensor.solax_pv_power_total"
    )
    assert device["resolved"]["energy_nodes.inverter.controls.mode.entity_id"] == (
        "select.helman_inverter_mode"
    )


def test_get_vendors_without_a_vendor_lists_only_the_profiles():
    payload = describe_vendors(fake_hass([]), {"energy_nodes": {"inverter": {}}})

    assert payload["devices"] == {}
    assert payload["profiles"][0]["entries"] == []
