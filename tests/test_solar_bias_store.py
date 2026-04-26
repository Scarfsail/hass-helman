from __future__ import annotations

import importlib
import sys
import asyncio
from datetime import datetime

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
    def __init__(self, hass, version, key, *args, **kwargs):
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
        def __init__(self, hass, version, key, *args, **kwargs):
            self.hass = hass
            self.version = version
            self.key = key
            self.async_migrate_func = kwargs.get("async_migrate_func")

        async def async_load(self):
            # return stored document or None
            return storage_data.get(self.key)

        async def async_save(self, data):
            storage_data[self.key] = data

    return FakeStore


def _make_versioned_fake_store_backend():
    storage_data: dict[str, dict] = {}

    class FakeStore:
        def __init__(self, hass, version, key, *args, **kwargs):
            self.hass = hass
            self.version = version
            self.key = key
            self.async_migrate_func = kwargs.get("async_migrate_func")

        async def async_load(self):
            stored = storage_data.get(self.key)
            if stored is None:
                return None

            stored_version = stored["version"]
            stored_minor_version = stored.get("minor_version", 1)
            payload = stored["data"]

            if stored_version != self.version:
                if self.async_migrate_func is None:
                    raise NotImplementedError
                migrated = await self.async_migrate_func(
                    stored_version,
                    stored_minor_version,
                    payload,
                )
                storage_data[self.key] = {
                    "version": self.version,
                    "minor_version": 1,
                    "data": migrated,
                }
                return migrated

            return payload

        async def async_save(self, data):
            storage_data[self.key] = {
                "version": self.version,
                "minor_version": 1,
                "data": data,
            }

    return FakeStore, storage_data


def _install_service_import_stubs() -> None:
    util_mod = sys.modules.get("homeassistant.util")
    if util_mod is None:
        util_mod = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_mod

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    dt_mod.now = lambda: None
    dt_mod.as_local = lambda value: value
    util_mod.dt = dt_mod

    actuals_mod = types.ModuleType(
        "custom_components.helman.solar_bias_correction.actuals"
    )

    async def _load_actuals_window(*args, **kwargs):
        return None

    async def _load_actuals_for_day(*args, **kwargs):
        return {}

    actuals_mod.load_actuals_window = _load_actuals_window
    actuals_mod.load_actuals_for_day = _load_actuals_for_day
    sys.modules[actuals_mod.__name__] = actuals_mod

    forecast_history_mod = types.ModuleType(
        "custom_components.helman.solar_bias_correction.forecast_history"
    )

    async def _load_forecast_points_for_day(*args, **kwargs):
        return []

    async def _load_trainer_samples(*args, **kwargs):
        return []

    forecast_history_mod.load_forecast_points_for_day = _load_forecast_points_for_day
    forecast_history_mod.load_trainer_samples = _load_trainer_samples
    sys.modules[forecast_history_mod.__name__] = forecast_history_mod


def _load_service_module():
    _install_service_import_stubs()
    sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)
    return importlib.import_module("custom_components.helman.solar_bias_correction.service")


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


def test_load_accepts_v1_payload():
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        importlib.reload(storage_mod)
        FakeStore = _make_fake_store_backend()
        sys.modules["homeassistant.helpers.storage"].Store = FakeStore

        v1_payload = {
            "version": 1,
            "profile": {"08:00": 1.12},
            "metadata": {
                "trained_at": "2026-04-24T03:00:04+02:00",
                "training_config_fingerprint": "sha256:deadbeef",
                "usable_days": 12,
                "dropped_days": [],
                "omitted_slot_count": 0,
                "last_outcome": "profile_trained",
            },
        }

        store = storage_mod.SolarBiasCorrectionStore(object())
        await store._store.async_save(v1_payload)

        reloaded = storage_mod.SolarBiasCorrectionStore(object())
        await reloaded.async_load()

        assert reloaded.profile == v1_payload

    asyncio.run(_inner())


def test_load_migrates_outer_store_version_1_to_2():
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        importlib.reload(storage_mod)
        FakeStore, storage_data = _make_versioned_fake_store_backend()
        sys.modules["homeassistant.helpers.storage"].Store = FakeStore

        storage_data["helman.solar_bias_correction"] = {
            "version": 1,
            "minor_version": 1,
            "data": {
                "version": 1,
                "profile": {"08:00": 1.12},
                "metadata": {
                    "trained_at": "2026-04-24T03:00:04+02:00",
                    "training_config_fingerprint": "sha256:deadbeef",
                    "usable_days": 12,
                    "dropped_days": [],
                    "omitted_slot_count": 0,
                    "last_outcome": "profile_trained",
                },
            },
        }

        store = storage_mod.SolarBiasCorrectionStore(object())
        await store.async_load()

        assert store.profile == storage_data["helman.solar_bias_correction"]["data"]
        assert storage_data["helman.solar_bias_correction"]["version"] == 2

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


def test_metadata_from_dict_defaults_missing_invalidation_fields():
    service_mod = _load_service_module()

    metadata = service_mod._metadata_from_dict(
        {
            "trained_at": "2026-04-24T03:00:04+02:00",
            "training_config_fingerprint": "sha256:deadbeef",
            "usable_days": 12,
            "dropped_days": [],
            "factor_min": 0.8,
            "factor_max": 1.2,
            "factor_median": 1.0,
            "omitted_slot_count": 3,
            "last_outcome": "profile_trained",
            "error_reason": None,
        }
    )

    assert metadata is not None
    assert metadata.invalidated_slots_by_date == {}
    assert metadata.invalidated_slot_count == 0


def test_metadata_from_dict_reads_invalidation_fields():
    service_mod = _load_service_module()

    metadata = service_mod._metadata_from_dict(
        {
            "trained_at": "2026-04-24T03:00:04+02:00",
            "training_config_fingerprint": "sha256:deadbeef",
            "usable_days": 12,
            "dropped_days": [],
            "factor_min": 0.8,
            "factor_max": 1.2,
            "factor_median": 1.0,
            "omitted_slot_count": 3,
            "last_outcome": "profile_trained",
            "invalidated_slots_by_date": {
                "2026-04-20": ["10:00", "10:15"],
                "2026-04-21": ["11:30"],
            },
            "invalidated_slot_count": 3,
            "error_reason": None,
        }
    )

    assert metadata is not None
    assert metadata.invalidated_slots_by_date == {
        "2026-04-20": ["10:00", "10:15"],
        "2026-04-21": ["11:30"],
    }
    assert metadata.invalidated_slot_count == 3


def test_serialize_state_writes_version_2():
    service_mod = _load_service_module()
    models_mod = importlib.import_module(
        "custom_components.helman.solar_bias_correction.models"
    )

    class _DummyStore:
        profile = None

        async def async_save(self, payload):
            self.saved = payload

    cfg = models_mod.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        daily_energy_entity_ids=[],
        total_energy_entity_id=None,
        max_training_window_days=90,
    )
    service = service_mod.SolarBiasCorrectionService(
        type("Hass", (), {"bus": type("Bus", (), {"async_fire": lambda *args, **kwargs: None})()})(),
        _DummyStore(),
        cfg,
    )
    service._profile = models_mod.SolarBiasProfile(
        factors={"08:00": 1.12},
        omitted_slots=["08:15"],
    )
    service._metadata = models_mod.SolarBiasMetadata(
        trained_at="2026-04-24T03:00:04+02:00",
        training_config_fingerprint="sha256:deadbeef",
        usable_days=12,
        dropped_days=[],
        factor_min=0.8,
        factor_max=1.2,
        factor_median=1.0,
        omitted_slot_count=1,
        last_outcome="profile_trained",
        invalidated_slots_by_date={"2026-04-20": ["08:00"]},
        invalidated_slot_count=1,
        error_reason=None,
    )

    payload = service._serialize_state()

    assert payload["version"] == 2


def test_async_train_saves_version_2_payload():
    async def _inner():
        service_mod = _load_service_module()
        models_mod = importlib.import_module(
            "custom_components.helman.solar_bias_correction.models"
        )

        class _DummyStore:
            profile = None

            def __init__(self):
                self.saved_payloads = []

            async def async_save(self, payload):
                self.saved_payloads.append(payload)

        cfg = models_mod.BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=[],
            total_energy_entity_id=None,
            max_training_window_days=90,
        )
        store = _DummyStore()
        hass = type(
            "Hass",
            (),
            {"bus": type("Bus", (), {"async_fire": lambda *args, **kwargs: None})()},
        )()
        service = service_mod.SolarBiasCorrectionService(hass, store, cfg)

        async def _samples(*args, **kwargs):
            return ["sample"]

        async def _actuals(*args, **kwargs):
            return object()

        old_samples = service_mod.load_trainer_samples
        old_actuals = service_mod.load_actuals_window
        old_train = service_mod.train
        old_now = service_mod.dt_util.now
        service_mod.load_trainer_samples = _samples
        service_mod.load_actuals_window = _actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat(
            "2026-04-24T03:00:04+02:00"
        )
        service_mod.train = lambda *args, **kwargs: models_mod.TrainingOutcome(
            profile=models_mod.SolarBiasProfile(
                factors={"08:00": 1.12},
                omitted_slots=["08:15"],
            ),
            metadata=models_mod.SolarBiasMetadata(
                trained_at="2026-04-24T03:00:04+02:00",
                training_config_fingerprint="sha256:deadbeef",
                usable_days=12,
                dropped_days=[],
                factor_min=0.8,
                factor_max=1.2,
                factor_median=1.0,
                omitted_slot_count=1,
                last_outcome="profile_trained",
                invalidated_slots_by_date={"2026-04-20": ["08:00"]},
                invalidated_slot_count=1,
                error_reason=None,
            ),
        )
        try:
            await service.async_train()
        finally:
            service_mod.load_trainer_samples = old_samples
            service_mod.load_actuals_window = old_actuals
            service_mod.train = old_train
            service_mod.dt_util.now = old_now

        assert store.saved_payloads[-1]["version"] == 2

    asyncio.run(_inner())
