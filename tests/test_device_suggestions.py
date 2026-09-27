"""Suggestions retain ambiguity while ranking explicit registry evidence."""

from types import SimpleNamespace as NS
from unittest.mock import patch
import pytest
from custom_components.helman.controllables.suggestions import suggest_entities


def entry(
    entity_id, device_class=None, labels=(), device_id="breaker", has_entity_name=False
):
    return NS(
        entity_id=entity_id,
        domain=entity_id.split(".")[0],
        device_id=device_id,
        disabled_by=None,
        device_class=device_class,
        original_device_class=None,
        labels=labels,
        name=None,
        original_name=None,
        has_entity_name=has_entity_name,
    )


def test_candidates_rank_labels_and_device_names_without_discarding_ambiguity():
    entries = [
        entry("sensor.energy", "energy"),
        entry("sensor.power", "power", ["power"]),
    ]
    entries += [
        entry(f"switch.breaker_{index}", labels=["control"] if index == 3 else [])
        for index in range(6)
    ]
    states = {"switch.breaker_2": NS(attributes={"friendly_name": "AC breaker"})}
    registry = NS(async_get=lambda entity_id: entries[0])
    labels = NS(
        async_get_label=lambda id: NS(
            name={"power": "Preferred power", "control": "Preferred switch"}[id]
        )
    )
    devices = NS(async_get=lambda id: NS(name="Breaker", name_by_user="AC breaker"))
    hass = NS(states=NS(get=states.get))
    config = {
        "devices": {
            "power_sensor_label": "Preferred power",
            "power_switch_label": "Preferred switch",
        }
    }
    with (
        patch(
            "custom_components.helman.controllables.suggestions.er.async_get",
            return_value=registry,
        ),
        patch(
            "custom_components.helman.controllables.suggestions.er.async_entries_for_device",
            return_value=entries,
        ),
        patch(
            "custom_components.helman.controllables.suggestions.lr.async_get",
            return_value=labels,
        ),
        patch(
            "custom_components.helman.controllables.suggestions.dr.async_get",
            return_value=devices,
        ),
    ):
        result = suggest_entities(hass, ["sensor.energy"], config)
    assert len(result["switch"]) == 6
    assert [c["entityId"] for c in result["switch"][:2]] == [
        "switch.breaker_3",
        "switch.breaker_2",
    ]
    assert result["switch"][0]["reasons"] == [
        {"code": "same_device"},
        {"code": "label", "value": "Preferred switch"},
    ]
    assert result["switch"][1]["reasons"][-1] == {"code": "name_match"}
    assert result["power"][0]["reasons"] == [
        {"code": "same_device"},
        {"code": "device_class_power"},
        {"code": "label", "value": "Preferred power"},
    ]
    assert result["energy"][0]["entityId"] == "sensor.energy"


def test_without_registry_device_there_is_no_inference():
    hass = NS()
    for anchor in (None, entry("sensor.energy", device_id=None)):
        with patch(
            "custom_components.helman.controllables.suggestions.er.async_get",
            return_value=NS(async_get=lambda id: anchor),
        ):
            assert suggest_entities(hass, ["sensor.energy"], {}) == {
                "energy": [],
                "power": [],
                "switch": [],
            }


@pytest.mark.parametrize(
    "config", [{"power_devices": None}, {"power_devices": {"house": None}}]
)
def test_nullable_optional_sections_do_not_block_same_device_suggestions(config):
    energy = entry("sensor.energy", "energy")
    registry = NS(async_get=lambda entity_id: energy)
    with (
        patch(
            "custom_components.helman.controllables.suggestions.er.async_get",
            return_value=registry,
        ),
        patch(
            "custom_components.helman.controllables.suggestions.er.async_entries_for_device",
            return_value=[energy],
        ),
        patch(
            "custom_components.helman.controllables.suggestions.lr.async_get",
            return_value=NS(),
        ),
        patch(
            "custom_components.helman.controllables.suggestions.dr.async_get",
            return_value=NS(async_get=lambda device_id: None),
        ),
    ):
        result = suggest_entities(
            NS(states=NS(get=lambda entity_id: None)), ["sensor.energy"], config
        )
    assert result["energy"][0]["entityId"] == "sensor.energy"


def test_an_anchor_without_an_ha_device_falls_through_to_the_next():
    # A utility-meter helper has no HA device; the switch beside it does.
    helper = entry("sensor.boiler_energy", device_id=None)
    power = entry("sensor.shelly_power", "power", device_id="shelly")
    switch = entry("switch.shelly", device_id="shelly")
    by_id = {e.entity_id: e for e in (helper, power, switch)}
    seen_devices = []

    def entries_for_device(registry, device_id):
        seen_devices.append(device_id)
        return [power, switch]

    with (
        patch(
            "custom_components.helman.controllables.suggestions.er.async_get",
            return_value=NS(async_get=by_id.get),
        ),
        patch(
            "custom_components.helman.controllables.suggestions.er.async_entries_for_device",
            side_effect=entries_for_device,
        ),
        patch(
            "custom_components.helman.controllables.suggestions.lr.async_get",
            return_value=NS(),
        ),
        patch(
            "custom_components.helman.controllables.suggestions.dr.async_get",
            return_value=NS(async_get=lambda device_id: None),
        ),
    ):
        result = suggest_entities(
            NS(states=NS(get=lambda entity_id: None)),
            ["sensor.boiler_energy", "sensor.missing", " switch.shelly "],
            {},
        )
    assert seen_devices == ["shelly"]
    assert result["power"][0]["entityId"] == "sensor.shelly_power"


def test_a_switch_named_after_its_device_matches_without_a_state():
    # During setup there are no states yet; an entity named after its HA
    # device has no name of its own in the registry.
    energy = entry("sensor.boiler_energy", "energy")
    switch = entry("switch.boiler", has_entity_name=True)
    with (
        patch(
            "custom_components.helman.controllables.suggestions.er.async_get",
            return_value=NS(async_get=lambda entity_id: energy),
        ),
        patch(
            "custom_components.helman.controllables.suggestions.er.async_entries_for_device",
            return_value=[energy, switch],
        ),
        patch(
            "custom_components.helman.controllables.suggestions.lr.async_get",
            return_value=NS(),
        ),
        patch(
            "custom_components.helman.controllables.suggestions.dr.async_get",
            return_value=NS(async_get=lambda id: NS(name="Boiler", name_by_user=None)),
        ),
    ):
        result = suggest_entities(
            NS(states=NS(get=lambda entity_id: None)), ["sensor.boiler_energy"], {}
        )
    assert result["switch"][0]["name"] == "Boiler"
    assert result["switch"][0]["reasons"][-1] == {"code": "name_match"}
