from __future__ import annotations

import importlib
import sys
import asyncio

import pytest


# Tests for SolarBiasCorrectionStore (TDD: start with failing tests)

from pathlib import Path
import types

# Ensure Python can import the local custom_components package and a minimal
# homeassistant package used by the integration during import.
ROOT = Path(__file__).resolve().parents[1]

if "custom_components" not in sys.modules:
    custom_components_pkg = types.ModuleType("custom_components")
    sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

# Create a package module for custom_components.helman to allow importing
# submodules (like storage) without executing the package __init__.py.
if "custom_components.helman" not in sys.modules:
    helman_pkg = types.ModuleType("custom_components.helman")
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]
    sys.modules["custom_components.helman"] = helman_pkg

if "homeassistant" not in sys.modules:
    ha_pkg = types.ModuleType("homeassistant")
    sys.modules["homeassistant"] = ha_pkg

# minimal homeassistant.core with HomeAssistant type
core_mod = types.ModuleType("homeassistant.core")
core_mod.HomeAssistant = type("HomeAssistant", (), {})
sys.modules["homeassistant.core"] = core_mod

# minimal helpers.storage module
helpers_mod = types.ModuleType("homeassistant.helpers")
sys.modules["homeassistant.helpers"] = helpers_mod

storage_stub = types.ModuleType("homeassistant.helpers.storage")

class _DummyStore:
    def __init__(self, hass, version, key):
        self.hass = hass
        self.version = version
        self.key = key

    async def async_load(self):
        return None

    async def async_save(self, data):
        return None

storage_stub.Store = _DummyStore
sys.modules["homeassistant.helpers.storage"] = storage_stub


def _make_fake_store_backend():
    # simple in-memory backend keyed by storage key
    storage_data: dict[str, dict] = {}

    class FakeStore:
        def __init__(self, hass, version, key):
            self.hass = hass
            self.version = version
            self.key = key

        async def async_load(self):
            # return stored document or None
            return storage_data.get(self.key)

        async def async_save(self, data):
            storage_data[self.key] = data

    return FakeStore


def test_initial_profile_is_none_after_load():
    async def _inner():
        # Import module under test and monkeypatch the underlying HA storage.Store
        storage_mod = importlib.import_module("custom_components.helman.storage")
        # Ensure we have the latest module implementation (tests may import it earlier)
        importlib.reload(storage_mod)

        FakeStore = _make_fake_store_backend()
        sys.modules["homeassistant.helpers.storage"].Store = FakeStore

        # Ensure class exists (will fail until implemented)
        store = storage_mod.SolarBiasCorrectionStore(object())

        await store.async_load()

        assert store.profile is None

    asyncio.run(_inner())


def test_save_and_reload_roundtrip():
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        importlib.reload(storage_mod)
        FakeStore = _make_fake_store_backend()
        sys.modules["homeassistant.helpers.storage"].Store = FakeStore

        store = storage_mod.SolarBiasCorrectionStore(object())

        payload = {
            "version": 1,
            "profile": {"08:00": 1.12},
            "metadata": {
                "trained_at": "2026-04-24T03:00:04+02:00",
                "training_config_fingerprint": "sha256:deadbeef",
                "usable_days": 12,
            },
        }

        await store.async_save(payload)

        # New instance should read the persisted data
        store2 = storage_mod.SolarBiasCorrectionStore(object())
        await store2.async_load()

        assert store2.profile == payload

    asyncio.run(_inner())


def test_unsupported_version_is_treated_as_no_profile():
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        importlib.reload(storage_mod)
        FakeStore = _make_fake_store_backend()
        sys.modules["homeassistant.helpers.storage"].Store = FakeStore

        # Pre-populate backend with an unsupported version document
        bad_payload = {
            "version": 999,
            "profile": {"08:00": 0.5},
            "metadata": {},
        }

        # create a store and save the bad payload via its underlying Store
        store = storage_mod.SolarBiasCorrectionStore(object())
        # access underlying store instance and save directly
        await store._store.async_save(bad_payload)

        # New store should treat unsupported version as no profile
        store2 = storage_mod.SolarBiasCorrectionStore(object())
        await store2.async_load()

        assert store2.profile is None

    asyncio.run(_inner())
