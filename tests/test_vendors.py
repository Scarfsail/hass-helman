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
    resolve_unique_ids,
    resolve_vendor_config,
)
from custom_components.helman.vendors.profile import (
    CHARGE_DEVICE_PATH,
    MODE_DEVICE_PATH,
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
    unique_id,
    entity_id,
    *,
    platform="solax_modbus",
    entry_id=ENTRY_ID,
    disabled_by=None,
    device_id=None,
):
    return NS(
        unique_id=unique_id,
        entity_id=entity_id,
        platform=platform,
        config_entry_id=entry_id,
        disabled_by=disabled_by,
        device_id=device_id,
    )


def solax_registry():
    return [registry_entry(*row) for row in dict(SOLAX_ROWS.values()).items()]


def config_entry(
    *,
    entry_id=ENTRY_ID,
    title="SolaX",
    data=None,
    options=None,
    domain="solax_modbus",
    disabled_by=None,
    source="user",
):
    return NS(
        entry_id=entry_id,
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
def registry(entries, devices=None):
    """The entity registry ``entries``, and HA devices ``{device id: entry ids}``."""
    ha_devices = {
        device_id: NS(id=device_id, config_entries=set(entry_ids))
        for device_id, entry_ids in (devices or {}).items()
    }

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
        patch(
            "homeassistant.helpers.entity_registry.async_entries_for_device",
            side_effect=lambda _registry, device_id: [
                entry for entry in entries if entry.device_id == device_id
            ],
        ),
        patch(
            "homeassistant.helpers.device_registry.async_get",
            return_value=NS(async_get=ha_devices.get),
        ),
    ):
        yield


def solax_document(**inverter_extra):
    return {
        "energy_nodes": {
            "inverter": {
                "profile": {"id": "solax_inverter", "entry_id": ENTRY_ID},
                **inverter_extra,
            },
            "battery": {"forecast": {"charge_efficiency": 0.95}},
        },
    }


def value_at(document, dotted):
    for key in dotted.split("."):
        document = document.get(key) if isinstance(document, dict) else None
    return document


def resolve(document, *, entries=None, hass_entries=None, devices=None):
    hass = fake_hass(hass_entries if hass_entries is not None else [config_entry()])
    with registry(solax_registry() if entries is None else entries, devices):
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
        ("energy_nodes", "vendor_entity_unresolved", "energy_nodes.inverter.profile")
    ]


@pytest.mark.parametrize(
    "entry", [config_entry(disabled_by="user"), config_entry(source="ignore")]
)
def test_a_disabled_or_ignored_config_entry_is_refused(entry):
    resolved, issues = resolve(solax_document(), hass_entries=[entry])

    assert value_at(resolved, "energy_nodes.battery.entities.capacity") is None
    assert [(i.code, i.path) for i in issues] == [
        ("invalid_choice", "energy_nodes.inverter.profile.entry_id")
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


def test_a_config_without_a_profile_resolves_to_itself():
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


def test_a_malformed_profile_is_reported():
    document = solax_document()
    document["energy_nodes"]["inverter"]["profile"] = {
        "id": "nope",
        "entry_id": ENTRY_ID,
    }
    _resolved, issues = resolve(document)
    assert [(i.section, i.code, i.path) for i in issues] == [
        ("energy_nodes", "invalid_choice", "energy_nodes.inverter.profile.id")
    ]

    document["energy_nodes"]["inverter"]["profile"] = {"id": "solax_inverter"}
    _resolved, issues = resolve(document)
    assert [(i.code, i.path) for i in issues] == [
        ("required", "energy_nodes.inverter.profile.entry_id")
    ]


def test_a_missing_entry_is_one_issue_and_the_profile_still_owns_its_paths():
    document = solax_document()
    document["energy_nodes"]["grid"] = {"entities": {"power": "sensor.grid"}}

    _resolved, issues = resolve(document, hass_entries=[config_entry(domain="other")])

    assert sorted((i.code, i.path) for i in issues) == [
        ("invalid_choice", "energy_nodes.inverter.profile.entry_id"),
        ("vendor_owned_key", "energy_nodes.grid.entities.power"),
    ]


def test_a_profile_only_goes_on_its_device_kind():
    document = {
        "devices": {
            "consumers": [
                {
                    "id": "heater",
                    "profile": {"id": "solax_inverter", "entry_id": ENTRY_ID},
                }
            ]
        }
    }

    _resolved, issues = resolve(document)

    assert [(i.section, i.code, i.path) for i in issues] == [
        ("devices", "invalid_choice", "devices.consumers[0].profile.id")
    ]


def test_get_vendors_describes_profiles_and_the_draft_devices():
    hass = fake_hass([config_entry()])
    entries = [e for e in solax_registry() if e.unique_id != "SolaX_battery_capacity"]
    with registry(entries):
        payload = describe_vendors(hass, solax_document())

    profile = next(p for p in payload["profiles"] if p["id"] == "solax_inverter")
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


def test_get_vendors_without_a_profile_lists_only_the_profiles():
    payload = describe_vendors(fake_hass([]), {"energy_nodes": {"inverter": {}}})

    assert payload["devices"] == {}
    assert payload["profiles"][0]["entries"] == []


# --- The SolaX EV charger: a device-bound profile -----------------------------

CHARGER_ENTRY_ID = "charger-entry"
CHARGER_DEVICE_ID = "charger-device"
DASHBOARD_DEVICE_ID = "charger-dashboard-device"


def charger_rows(
    name="SolaX_EV_Charger", *, entry_id=CHARGER_ENTRY_ID, device_id=CHARGER_DEVICE_ID
):
    """The charger's rows on its HA device, as prod had them on 2026-10-10.

    ``control_command`` is registered both as a sensor and as a select.
    """
    slug = name.lower()
    return [
        registry_entry(
            f"{name}_{key}",
            f"{domain}.{slug}_{key}",
            entry_id=entry_id,
            device_id=device_id,
        )
        for domain, key in (
            ("sensor", "charge_added_total"),
            ("sensor", "charge_power_total"),
            ("select", "charger_use_mode"),
            ("select", "eco_gear"),
            ("sensor", "run_mode"),
            ("sensor", "control_command"),
            ("select", "control_command"),
        )
    ]


def charger_entry(name="SolaX_EV_Charger", entry_id=CHARGER_ENTRY_ID):
    return config_entry(entry_id=entry_id, title=name)


def charger(device_id=CHARGER_DEVICE_ID, *, id="garage-ev", **extra):
    return {
        "kind": "ev_charger",
        "id": id,
        "name": "Garage EV",
        "profile": {"id": "solax_ev_charger", "device_id": device_id},
        **extra,
    }


def resolve_chargers(
    consumers, *, entries=None, hass_entries=None, devices=None, inverter=None
):
    return resolve(
        {
            "energy_nodes": {"inverter": inverter or {}},
            "devices": {"consumers": consumers},
        },
        entries=charger_rows() if entries is None else entries,
        hass_entries=[charger_entry()] if hass_entries is None else hass_entries,
        devices={CHARGER_DEVICE_ID: [CHARGER_ENTRY_ID]} if devices is None else devices,
    )


RESOLVED_CHARGER = {
    "consumption": {
        "energy_entity_id": "sensor.solax_ev_charger_charge_added_total",
        "power_entity_id": "sensor.solax_ev_charger_charge_power_total",
    },
    "controls": {
        "charge": {"entity_id": "switch.helman_ev_charging_garage_ev"},
        "use_mode": {
            "entity_id": "select.solax_ev_charger_charger_use_mode",
            "values": {
                "Fast": {"behavior": "fixed_max_power"},
                "ECO": {"behavior": "surplus_aware"},
            },
        },
        "eco_gear": {
            "entity_id": "select.solax_ev_charger_eco_gear",
            "values": {"6A": {"min_power_kw": 3.5}, "10A": {"min_power_kw": 6.9}},
        },
    },
}


def test_the_charger_resolves_on_its_ha_device():
    resolved, issues = resolve_chargers([charger()])

    assert issues == []
    [device] = resolved["devices"]["consumers"]
    assert {key: device[key] for key in ("consumption", "controls")} == RESOLVED_CHARGER
    # The rest stays the user's.
    assert device["name"] == "Garage EV"


def test_the_select_wins_a_unique_id_shared_with_a_sensor():
    profile = PROFILES["solax_ev_charger"]
    with registry(charger_rows(), {CHARGER_DEVICE_ID: [CHARGER_ENTRY_ID]}):
        resolved = resolve_unique_ids(
            None,
            profile,
            charger_entry(),
            [profile.charging.command, ("sensor", "{name}_control_command")],
            device_id=CHARGER_DEVICE_ID,
        )

    assert resolved == {
        ("select", "{name}_control_command"): "select.solax_ev_charger_control_command",
        ("sensor", "{name}_control_command"): "sensor.solax_ev_charger_control_command",
    }


def test_only_rows_on_the_bound_device_are_read():
    # The same entry's dashboard device registers a lookalike row.
    entries = [
        e for e in charger_rows() if e.unique_id != "SolaX_EV_Charger_eco_gear"
    ] + [
        registry_entry(
            "SolaX_EV_Charger_eco_gear",
            "select.dashboard_eco_gear",
            entry_id=CHARGER_ENTRY_ID,
            device_id=DASHBOARD_DEVICE_ID,
        )
    ]

    resolved, issues = resolve_chargers([charger()], entries=entries)

    assert (
        "entity_id" not in resolved["devices"]["consumers"][0]["controls"]["eco_gear"]
    )
    [issue] = issues
    assert (issue.code, issue.path) == (
        "vendor_entity_unresolved",
        "devices.consumers[0].profile",
    )
    assert "devices.consumers[0].controls.eco_gear.entity_id" in issue.message


def test_the_resolved_charger_validates():
    device = charger(
        schedulable=True,
        limits={"max_charging_power_kw": 11.0},
        vehicles=[
            {
                "id": "kona",
                "name": "Kona",
                "telemetry": {"soc_entity_id": "sensor.kona_soc"},
                "limits": {"battery_capacity_kwh": 64.0, "max_charging_power_kw": 11.0},
            }
        ],
    )
    resolved, issues = resolve_chargers([device])

    assert issues == []
    assert validate_config_document(resolved).errors == []


@pytest.mark.parametrize(
    ("stored", "path"),
    [
        (
            {"consumption": {"energy_entity_id": "sensor.ev_energy"}},
            "devices.consumers[0].consumption.energy_entity_id",
        ),
        (
            {"controls": {"charge": {"entity_id": "switch.ev_nabijeni"}}},
            "devices.consumers[0].controls.charge",
        ),
        (
            {"controls": {"use_mode": {"values": {"Fast": {}}}}},
            "devices.consumers[0].controls.use_mode",
        ),
    ],
)
def test_a_stored_owned_key_on_the_charger_is_refused(stored, path):
    resolved, issues = resolve_chargers([charger(**stored)])

    assert [(i.code, i.path, i.error) for i in issues] == [
        ("vendor_owned_key", path, True)
    ]
    # The profile still wins at runtime.
    assert (
        resolved["devices"]["consumers"][0]["controls"] == RESOLVED_CHARGER["controls"]
    )


def test_a_missing_device_id_is_required():
    device = charger()
    del device["profile"]["device_id"]

    resolved, issues = resolve_chargers([device])

    assert [(i.code, i.path) for i in issues] == [
        ("required", "devices.consumers[0].profile.device_id")
    ]
    # Helman's switch and the value maps are the profile's whatever the binding.
    controls = resolved["devices"]["consumers"][0]["controls"]
    assert controls["charge"] == RESOLVED_CHARGER["controls"]["charge"]
    assert "entity_id" not in controls["use_mode"]


@pytest.mark.parametrize(
    ("devices", "hass_entries"),
    [
        # No such HA device.
        ({}, [charger_entry()]),
        # An HA device of another integration.
        (
            {CHARGER_DEVICE_ID: ["other"]},
            [config_entry(entry_id="other", domain="other")],
        ),
        # Its solax_modbus entry is disabled.
        (None, [config_entry(entry_id=CHARGER_ENTRY_ID, disabled_by="user")]),
    ],
)
def test_an_unknown_device_is_an_invalid_choice(devices, hass_entries):
    _resolved, issues = resolve_chargers(
        [charger()], devices=devices, hass_entries=hass_entries
    )

    assert [(i.code, i.path) for i in issues] == [
        ("invalid_choice", "devices.consumers[0].profile.device_id")
    ]


def test_two_devices_on_one_ha_device_are_reported():
    resolved, issues = resolve_chargers([charger(), charger(id="second-ev")])

    assert [(i.code, i.path, i.error) for i in issues] == [
        ("duplicate_profile_device", "devices.consumers[1].profile.device_id", True)
    ]
    # The second is left unbound, so no second switch drives the charger.
    first, second = resolved["devices"]["consumers"]
    assert first["controls"]["eco_gear"]["entity_id"] == "select.solax_ev_charger_eco_gear"
    assert "entity_id" not in second["controls"].get("eco_gear", {})


@pytest.mark.parametrize("profile", PROFILES.values(), ids=lambda profile: profile.id)
def test_every_device_slot_a_profile_fills_is_declared_owned(profile):
    filled = [*profile.device_entities, *profile.device_values]
    if profile.modes:
        filled.append(MODE_DEVICE_PATH)
    if profile.charging is not None:
        filled.append(CHARGE_DEVICE_PATH)

    assert [
        path
        for path in filled
        if not any(
            path == owned or path.startswith(f"{owned}.")
            for owned in profile.device_paths
        )
    ] == []


def test_two_solax_chargers_resolve_independently():
    second_rows = charger_rows(
        "SolaX_EV_Charger_2", entry_id="second-entry", device_id="second-device"
    )
    resolved, issues = resolve_chargers(
        [charger(), charger("second-device", id="drive-ev")],
        entries=charger_rows() + second_rows,
        hass_entries=[
            charger_entry(),
            charger_entry("SolaX_EV_Charger_2", "second-entry"),
        ],
        devices={
            CHARGER_DEVICE_ID: [CHARGER_ENTRY_ID],
            "second-device": ["second-entry"],
        },
    )

    assert issues == []
    first, second = resolved["devices"]["consumers"]
    assert (
        first["controls"]["eco_gear"]["entity_id"] == "select.solax_ev_charger_eco_gear"
    )
    assert second["controls"]["eco_gear"]["entity_id"] == (
        "select.solax_ev_charger_2_eco_gear"
    )
    assert second["controls"]["charge"] == {
        "entity_id": "switch.helman_ev_charging_drive_ev"
    }
    # Each device has its own copy of the value maps.
    assert (
        first["controls"]["use_mode"]["values"]
        is not (second["controls"]["use_mode"]["values"])
    )


def test_a_solax_charger_resolves_next_to_a_custom_inverter():
    inverter = {"controls": {"mode": {"entity_id": "input_select.fv_mode"}}}

    resolved, issues = resolve_chargers([charger()], inverter=inverter)

    assert issues == []
    assert resolved["energy_nodes"]["inverter"] == inverter
    assert (
        resolved["devices"]["consumers"][0]["controls"] == RESOLVED_CHARGER["controls"]
    )


def test_a_solax_inverter_resolves_next_to_a_custom_charger():
    custom = {
        "kind": "ev_charger",
        "id": "garage-ev",
        "controls": {"charge": {"entity_id": "switch.ev_nabijeni"}},
        "consumption": {"energy_entity_id": "sensor.ev_energy"},
    }
    document = solax_document()
    document["devices"] = {"consumers": [custom]}

    resolved, issues = resolve(document)

    assert issues == []
    assert resolved["devices"]["consumers"] == [custom]
    assert value_at(resolved, "energy_nodes.solar.entities.power") == (
        "sensor.solax_pv_power_total"
    )


def test_get_vendors_describes_a_charger():
    hass = fake_hass([charger_entry()])
    document = {"devices": {"consumers": [charger()]}}
    with registry(charger_rows(), {CHARGER_DEVICE_ID: [CHARGER_ENTRY_ID]}):
        payload = describe_vendors(hass, document)

    device = payload["devices"]["devices.consumers[0]"]
    assert device["profile"] == "solax_ev_charger"
    assert device["ownedConfigPaths"] == []
    assert device["resolved"] == {
        "devices.consumers[0].consumption.energy_entity_id": (
            "sensor.solax_ev_charger_charge_added_total"
        ),
        "devices.consumers[0].consumption.power_entity_id": (
            "sensor.solax_ev_charger_charge_power_total"
        ),
        "devices.consumers[0].controls.use_mode.entity_id": (
            "select.solax_ev_charger_charger_use_mode"
        ),
        "devices.consumers[0].controls.eco_gear.entity_id": (
            "select.solax_ev_charger_eco_gear"
        ),
        "devices.consumers[0].controls.charge.entity_id": (
            "switch.helman_ev_charging_garage_ev"
        ),
    }
