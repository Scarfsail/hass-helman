from __future__ import annotations

import asyncio
from importlib import import_module
import pytest
from types import SimpleNamespace

#: What the energy manager hands out, and how often it was asked.
ENERGY_PREFERENCES = {
    "device_consumption": [{"stat_consumption": "sensor.oven_energy"}]
}
energy_requests: list[object] = []


async def _async_get_manager(hass):
    energy_requests.append(hass)
    return SimpleNamespace(data=ENERGY_PREFERENCES)


SUGGESTIONS = {
    "energy": [],
    "power": [{"entityId": "sensor.oven_power", "reasons": []}],
    "switch": [{"entityId": "switch.oven", "reasons": [{"code": "name_match"}]}],
}
suggestion_requests: list[tuple[object, list[str]]] = []


def _suggest_entities(hass, anchor_entity_ids, config):
    suggestion_requests.append((hass, list(anchor_entity_ids)))
    return SUGGESTIONS


_ENTITIES = {
    "sensor.oven_energy": SimpleNamespace(device_id="dev_oven", labels=set()),
    "switch.oven": SimpleNamespace(device_id="dev_oven", labels={"kitchen"}),
}


@pytest.fixture(autouse=True)
def _ha_dependencies(monkeypatch):
    from homeassistant.components.energy import data as energy_data
    from homeassistant.helpers import entity_registry, label_registry
    suggestions = import_module("custom_components.helman.controllables.suggestions")

    monkeypatch.setattr(energy_data, "async_get_manager", _async_get_manager)
    monkeypatch.setattr(suggestions, "suggest_entities", _suggest_entities)
    monkeypatch.setattr(entity_registry, "async_get", lambda hass: SimpleNamespace(
        entities=_ENTITIES, async_get=_ENTITIES.get
    ))
    monkeypatch.setattr(label_registry, "async_get", lambda hass: SimpleNamespace(
        async_get_label=lambda label_id: SimpleNamespace(name="Kitchen")
        if label_id == "kitchen" else None
    ))


from custom_components.helman.const import CONFIG_DOCUMENT_VERSION
from custom_components.helman.storage import HelmanStorage


class _FakeStore:
    def __init__(self) -> None:
        self.saved: list[dict] = []

    async def async_save(self, payload: dict) -> None:
        self.saved.append(payload)

    async def async_load(self) -> dict | None:
        return None


def test_save_snapshots_skips_when_unchanged(monkeypatch) -> None:
    storage = HelmanStorage.__new__(HelmanStorage)
    storage._snapshot_store = _FakeStore()
    storage._snapshot = None
    storage._solar_snapshot = None

    payload = {"a": 1}
    asyncio.run(storage.async_save_snapshots(house_snapshot=payload, solar_snapshot=None))
    asyncio.run(storage.async_save_snapshots(house_snapshot=payload, solar_snapshot=None))
    assert len(storage._snapshot_store.saved) == 1


class _StoredConfig(_FakeStore):
    def __init__(self, document: dict) -> None:
        super().__init__()
        self._document = document

    async def async_load(self) -> dict | None:
        return self._document


def _load(document: dict | None) -> HelmanStorage:
    storage = HelmanStorage.__new__(HelmanStorage)
    storage._hass = object()
    storage._store = _StoredConfig(document)
    storage._snapshot_store = _FakeStore()
    storage._schedule_store = _FakeStore()
    asyncio.run(storage.async_load())
    return storage


def test_a_partial_visualization_keeps_the_defaults_it_omits() -> None:
    # Regression (PR #302 review): the top-level merge replaced the whole nested
    # default object, so an omitted `history_bucket_duration` fell back to 5 s
    # in the tick and 1 s in the history payload.
    storage = _load(
        {"config_version": 18, "visualization": {"history_buckets": 90}}
    )

    visualization = storage.config["visualization"]
    assert visualization["history_buckets"] == 90
    assert visualization["history_bucket_duration"] == 5
    assert visualization["show_empty_groups"] is False
    assert visualization["show_others_group"] is True
    assert "power_sensor_name_cleaner_regex" not in visualization


def test_a_relocated_v17_value_still_beats_the_defaults() -> None:
    storage = _load({"config_version": 17, "history_bucket_duration": 2})

    assert storage.config["visualization"]["history_bucket_duration"] == 2
    assert "history_bucket_duration" not in storage.config


def test_an_upgrade_turns_ha_labels_into_device_groups() -> None:
    oven = {"id": "oven", "consumption": {"energy_entity_id": "sensor.oven_energy"}}

    storage = _load(
        {
            "config_version": 25,
            "visualization": {"device_label_text": {"Rooms": {"Kitchen": "K"}}},
            "devices": {"consumers": [oven]},
        }
    )

    expected = {
        "groupings": [
            {
                "id": "rooms",
                "name": "Rooms",
                "groups": [{"id": "kitchen", "name": "Kitchen", "short_name": "K"}],
            }
        ],
        "consumers": [{**oven, "groups": {"rooms": "kitchen"}}],
    }
    assert "device_label_text" not in storage.config["visualization"]
    assert storage.config["devices"] == expected
    assert storage._store.saved[-1]["devices"] == expected


def test_an_upgrade_imports_the_energy_devices() -> None:
    energy_requests.clear()

    storage = _load({"config_version": 20, "power_devices": {}})

    assert len(energy_requests) == 1
    # Imported by v21, then backfilled from the (stubbed) registry by v23.
    assert storage.config["devices"]["consumers"] == [
        {
            "id": "oven_energy",
            "consumption": {
                "energy_entity_id": "sensor.oven_energy",
                "power_entity_id": "sensor.oven_power",
            },
            "controls": {"switch": {"entity_id": "switch.oven"}},
        }
    ]


def test_a_fresh_install_starts_with_no_devices() -> None:
    energy_requests.clear()

    storage = _load(None)

    assert energy_requests == []
    assert "devices" not in storage.config


def test_a_current_document_never_reads_energy() -> None:
    energy_requests.clear()

    suggestion_requests.clear()

    _load({"config_version": CONFIG_DOCUMENT_VERSION})

    assert energy_requests == []
    assert suggestion_requests == []


def test_an_upgrade_backfills_power_and_switch_from_the_registry() -> None:
    suggestion_requests.clear()
    oven = {"id": "oven", "consumption": {"energy_entity_id": "sensor.oven_energy"}}

    storage = _load({"config_version": 22, "devices": {"items": [oven]}})

    assert [anchors for _hass, anchors in suggestion_requests] == [
        ["sensor.oven_energy"]
    ]
    assert suggestion_requests[0][0] is storage._hass
    expected = {
        "id": "oven",
        "consumption": {
            "energy_entity_id": "sensor.oven_energy",
            "power_entity_id": "sensor.oven_power",
        },
        "controls": {"switch": {"entity_id": "switch.oven"}},
    }
    assert storage.config["devices"]["consumers"] == [expected]
    assert storage._store.saved[-1]["devices"]["consumers"] == [expected]
