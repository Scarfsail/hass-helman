from __future__ import annotations
from _ha_stubs import stub_module
from pathlib import Path
import pytest
import sys
import types
from _fakes import _bias_service_config


import importlib
import asyncio
from datetime import datetime


# Tests for SolarBiasCorrectionStore (TDD: start with failing tests)


def _make_fake_store_backend():
    # simple in-memory backend keyed by storage key
    storage_data: dict[str, dict] = {}

    class FakeStore:
        def __init__(self, hass, version, key):
            self.hass = hass
            self.version = version
            self.key = key
            self._async_migrate_func = self._default_async_migrate_func

        async def async_load(self):
            # return stored document or None
            return storage_data.get(self.key)

        async def async_save(self, data):
            storage_data[self.key] = data

        async def _default_async_migrate_func(
            self, old_major_version, old_minor_version, old_data
        ):
            raise NotImplementedError

    return FakeStore


def _make_versioned_fake_store_backend():
    storage_data: dict[str, dict] = {}

    class FakeStore:
        def __init__(self, hass, version, key):
            self.hass = hass
            self.version = version
            self.key = key
            self._async_migrate_func = self._default_async_migrate_func

        async def async_load(self):
            stored = storage_data.get(self.key)
            if stored is None:
                return None

            stored_version = stored["version"]
            stored_minor_version = stored.get("minor_version", 1)
            payload = stored["data"]

            if stored_version != self.version:
                migrated = await self._async_migrate_func(
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

        async def _default_async_migrate_func(
            self, old_major_version, old_minor_version, old_data
        ):
            raise NotImplementedError

    return FakeStore, storage_data


def _load_service_module():
    return importlib.import_module("custom_components.helman.solar_bias_correction.service")


def test_initial_profile_is_none_after_load(monkeypatch):
    async def _inner():
        # Import module under test and monkeypatch the underlying HA storage.Store
        storage_mod = importlib.import_module("custom_components.helman.storage")
        # Ensure we have the latest module implementation (tests may import it earlier)

        FakeStore = _make_fake_store_backend()
        monkeypatch.setattr(storage_mod.storage, "Store", FakeStore)

        # Ensure class exists (will fail until implemented)
        store = storage_mod.SolarBiasCorrectionStore(object())

        await store.async_load()

        assert store.profile is None

    asyncio.run(_inner())


def test_save_and_reload_roundtrip(monkeypatch):
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        FakeStore = _make_fake_store_backend()
        monkeypatch.setattr(storage_mod.storage, "Store", FakeStore)

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


def test_load_accepts_v1_payload(monkeypatch):
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        FakeStore = _make_fake_store_backend()
        monkeypatch.setattr(storage_mod.storage, "Store", FakeStore)

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


def test_load_migrates_outer_store_version_1_to_2(monkeypatch):
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        FakeStore, storage_data = _make_versioned_fake_store_backend()
        monkeypatch.setattr(storage_mod.storage, "Store", FakeStore)

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


def test_store_init_uses_constructor_supported_by_home_assistant_core(monkeypatch):
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")

        class StrictStore:
            def __init__(self, hass, version, key):
                self.hass = hass
                self.version = version
                self.key = key
                self._async_migrate_func = self._default_async_migrate_func

            async def async_load(self):
                return None

            async def async_save(self, data):
                return None

            async def _default_async_migrate_func(
                self, old_major_version, old_minor_version, old_data
            ):
                raise NotImplementedError

        monkeypatch.setattr(storage_mod.storage, "Store", StrictStore)

        store = storage_mod.SolarBiasCorrectionStore(object())

        assert store._store._async_migrate_func == store._async_migrate_store

    asyncio.run(_inner())


def test_unsupported_version_is_treated_as_no_profile(monkeypatch):
    async def _inner():
        storage_mod = importlib.import_module("custom_components.helman.storage")
        FakeStore = _make_fake_store_backend()
        monkeypatch.setattr(storage_mod.storage, "Store", FakeStore)

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


def test_metadata_from_dict_defaults_missing_invalidation_fields(monkeypatch):
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


def test_metadata_from_dict_reads_invalidation_fields(monkeypatch):
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


def test_serialize_state_writes_version_2(monkeypatch):
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
     config=_bias_service_config(cfg),)
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


def test_training_explainability_from_dict_parses_valid_snapshot(monkeypatch):
    service_mod = _load_service_module()

    parsed = service_mod._training_explainability_from_dict(
        {
            "trainedAt": "2026-04-25T03:00:00+02:00",
            "aggregationMethod": "ratio_of_sums",
            "slots": {
                "12:00": {
                    "factor": 1.34,
                    "rawRatio": 1.34,
                    "clamped": False,
                    "forecastSumWh": 1500,
                    "actualSumWh": 2010,
                    "rows": [
                        {
                            "date": "2026-04-21",
                            "forecastWh": 520,
                            "actualWh": 610,
                            "ratio": 1.1730769231,
                            "status": "included",
                            "reason": None,
                        }
                    ],
                }
            },
        }
    )

    assert parsed is not None
    assert parsed.trained_at == "2026-04-25T03:00:00+02:00"
    assert parsed.aggregation_method == "ratio_of_sums"
    assert parsed.slots["12:00"].rows[0].status == "included"


def test_training_explainability_from_dict_preserves_interpolation_metadata(monkeypatch):
    service_mod = _load_service_module()

    parsed = service_mod._training_explainability_from_dict(
        {
            "trainedAt": "2026-04-25T03:00:00+02:00",
            "aggregationMethod": "ratio_of_sums",
            "slots": {
                "16:00": {
                    "factor": 1.054,
                    "rawRatio": None,
                    "clamped": False,
                    "forecastSumWh": 0,
                    "actualSumWh": 0,
                    "interpolated": True,
                    "interpolationAnchors": {"left": "14:00", "right": "16:15"},
                    "rows": [
                        {
                            "date": "",
                            "forecastWh": None,
                            "actualWh": None,
                            "ratio": None,
                            "status": "interpolated",
                            "reason": "left=14:00,right=16:15",
                        }
                    ],
                }
            },
        }
    )

    assert parsed is not None
    slot = parsed.slots["16:00"]
    assert slot.interpolated is True
    assert slot.interpolation_anchors == ("14:00", "16:15")


def test_training_explainability_from_dict_returns_none_for_missing_snapshot(monkeypatch):
    service_mod = _load_service_module()

    assert service_mod._training_explainability_from_dict(None) is None


def test_async_train_saves_version_2_payload(monkeypatch):
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
        service = service_mod.SolarBiasCorrectionService(hass, store, cfg, config=_bias_service_config(cfg),)

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
