from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if "custom_components" not in sys.modules:
    custom_components_pkg = types.ModuleType("custom_components")
    sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

if "custom_components.helman" not in sys.modules:
    helman_pkg = types.ModuleType("custom_components.helman")
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]
    sys.modules["custom_components.helman"] = helman_pkg

if "homeassistant" not in sys.modules:
    sys.modules["homeassistant"] = types.ModuleType("homeassistant")

core_mod = types.ModuleType("homeassistant.core")
core_mod.HomeAssistant = type("HomeAssistant", (), {})
sys.modules["homeassistant.core"] = core_mod

helpers_mod = types.ModuleType("homeassistant.helpers")
sys.modules["homeassistant.helpers"] = helpers_mod
storage_stub = types.ModuleType("homeassistant.helpers.storage")
sys.modules["homeassistant.helpers.storage"] = storage_stub


def _install_fake_store_backend():
    """One in-memory document per storage key, surviving a store re-creation
    so a "restart" can be simulated."""
    documents: dict[str, dict] = {}

    class FakeStore:
        def __init__(self, hass, version, key):
            self.version = version
            self.key = key

        async def async_load(self):
            return documents.get(self.key)

        async def async_save(self, data):
            documents[self.key] = data

    storage_stub.Store = FakeStore
    return documents


def _load_storage_module():
    storage_mod = importlib.import_module("custom_components.helman.storage")
    return importlib.reload(storage_mod)


def test_profile_survives_a_round_trip_through_the_store():
    async def _inner():
        _install_fake_store_backend()
        storage_mod = _load_storage_module()

        store = storage_mod.TrainingArtifactsStore(object())
        await store.async_load()
        assert store.house_consumption is None

        await store.async_record_house_consumption(
            data={"schema_version": 1, "history_days": 42},
            fingerprint="fp-1",
            trained_at="2026-08-01T03:00:00+02:00",
            last_outcome="profile_trained",
        )

        reloaded = storage_mod.TrainingArtifactsStore(object())
        await reloaded.async_load()
        assert reloaded.house_consumption == {
            "data": {"schema_version": 1, "history_days": 42},
            "fingerprint": "fp-1",
            "trained_at": "2026-08-01T03:00:00+02:00",
            "last_outcome": "profile_trained",
            "error_reason": None,
        }

    asyncio.run(_inner())


def test_failed_refit_preserves_the_previous_profile():
    """The rule that makes "older than 48 h, refit fails" keep serving with a
    banner instead of blanking."""

    async def _inner():
        _install_fake_store_backend()
        storage_mod = _load_storage_module()

        store = storage_mod.TrainingArtifactsStore(object())
        await store.async_load()
        await store.async_record_house_consumption(
            data={"schema_version": 1, "history_days": 42},
            fingerprint="fp-1",
            trained_at="2026-08-01T03:00:00+02:00",
            last_outcome="profile_trained",
        )

        await store.async_record_house_consumption_failure(
            last_outcome="training_failed",
            error_reason="recorder exploded",
        )

        section = store.house_consumption
        assert section["data"] == {"schema_version": 1, "history_days": 42}
        assert section["trained_at"] == "2026-08-01T03:00:00+02:00"
        assert section["fingerprint"] == "fp-1"
        assert section["last_outcome"] == "training_failed"
        assert section["error_reason"] == "recorder exploded"

    asyncio.run(_inner())


def test_a_document_from_an_unsupported_version_is_ignored():
    async def _inner():
        documents = _install_fake_store_backend()
        storage_mod = _load_storage_module()
        documents[storage_mod.TRAINING_ARTIFACTS_STORAGE_KEY] = {
            "version": 99,
            "house_consumption": {"data": {"schema_version": 1}},
        }

        store = storage_mod.TrainingArtifactsStore(object())
        await store.async_load()

        assert store.house_consumption is None

    asyncio.run(_inner())


def test_first_ever_failure_records_an_outcome_without_data():
    async def _inner():
        _install_fake_store_backend()
        storage_mod = _load_storage_module()

        store = storage_mod.TrainingArtifactsStore(object())
        await store.async_load()
        await store.async_record_house_consumption_failure(
            last_outcome="entity_missing",
            error_reason="sensor.gone",
        )

        section = store.house_consumption
        assert section["data"] is None
        assert section["last_outcome"] == "entity_missing"

    asyncio.run(_inner())
