"""Suggestions retain ambiguity while ranking explicit registry evidence."""

from types import SimpleNamespace as NS
from unittest.mock import patch
from custom_components.helman.controllables.suggestions import suggest_entities


def entry(entity_id, device_class=None, labels=(), device_id="breaker"):
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
        "power_devices": {
            "house": {
                "power_sensor_label": "Preferred power",
                "power_switch_label": "Preferred switch",
            }
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
        result = suggest_entities(hass, "sensor.energy", config)
    assert len(result["switch"]) == 6
    assert [c["entityId"] for c in result["switch"][:2]] == [
        "switch.breaker_3",
        "switch.breaker_2",
    ]
    assert result["switch"][0]["reasons"] == [
        "Same Home Assistant device",
        "Label: Preferred switch",
    ]
    assert result["switch"][1]["reasons"][-1] == "Friendly name matches device name"
    assert result["power"][0]["reasons"] == [
        "Same Home Assistant device",
        "Device class: power",
        "Label: Preferred power",
    ]
    assert result["energy"][0]["entityId"] == "sensor.energy"


def test_without_registry_device_there_is_no_inference():
    hass = NS()
    for anchor in (None, entry("sensor.energy", device_id=None)):
        with patch(
            "custom_components.helman.controllables.suggestions.er.async_get",
            return_value=NS(async_get=lambda id: anchor),
        ):
            assert suggest_entities(hass, "sensor.energy", {}) == {
                "energy": [],
                "power": [],
                "switch": [],
            }
