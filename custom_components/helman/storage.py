from __future__ import annotations
from typing import Any
from homeassistant.helpers import storage
from homeassistant.core import HomeAssistant
from .const import (
    FORECAST_SNAPSHOT_STORAGE_KEY,
    FORECAST_SNAPSHOT_STORAGE_VERSION,
    SCHEDULE_STORAGE_KEY,
    SCHEDULE_STORAGE_VERSION,
    STORAGE_KEY,
    STORAGE_VERSION,
)

DEFAULT_CONFIG: dict[str, Any] = {
    "history_buckets": 60,
    "history_bucket_duration": 1,
    "sources_title": "Energy Sources",
    "consumers_title": "Energy Consumers",
    "others_group_label": "Others",
    "groups_title": "Group by:",
    "show_others_group": True,
    "device_label_text": {},
    "power_devices": {},
}


class HelmanStorage:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._config: dict[str, Any] = {}
        self._snapshot_store = storage.Store(
            hass, FORECAST_SNAPSHOT_STORAGE_VERSION, FORECAST_SNAPSHOT_STORAGE_KEY
        )
        self._snapshot: dict[str, Any] | None = None
        self._schedule_store = storage.Store(
            hass, SCHEDULE_STORAGE_VERSION, SCHEDULE_STORAGE_KEY
        )
        self._schedule_document: dict[str, Any] | None = None

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._config = {**DEFAULT_CONFIG, **(stored or {})}
        self._snapshot = await self._snapshot_store.async_load()
        self._schedule_document = await self._schedule_store.async_load()

    @property
    def config(self) -> dict[str, Any]:
        return self._config

    @property
    def forecast_snapshot(self) -> dict[str, Any] | None:
        return self._snapshot

    @property
    def schedule_document(self) -> dict[str, Any] | None:
        return self._schedule_document

    async def async_save(self, new_config: dict[str, Any]) -> None:
        self._config = new_config
        await self._store.async_save(new_config)

    async def async_save_snapshot(self, snapshot: dict[str, Any]) -> None:
        self._snapshot = snapshot
        await self._snapshot_store.async_save(snapshot)

    async def async_save_schedule_document(
        self, schedule_document: dict[str, Any]
    ) -> None:
        self._schedule_document = schedule_document
        await self._schedule_store.async_save(schedule_document)


class SolarBiasCorrectionStore:
    """Persistence for solar bias correction profiles.

    Persisted payload shape (v1/v2):
      {"version": 1|2, "profile": {...}, "metadata": {...}}
    """

    def __init__(self, hass: HomeAssistant) -> None:
        from .const import (
            SOLAR_BIAS_STORAGE_KEY,
            SOLAR_BIAS_STORAGE_VERSION,
            SOLAR_BIAS_SUPPORTED_STORE_VERSION,
        )

        self._store = storage.Store(
            hass,
            SOLAR_BIAS_STORAGE_VERSION,
            SOLAR_BIAS_STORAGE_KEY,
            async_migrate_func=self._async_migrate_store,
        )
        self._profile: dict[str, Any] | None = None
        self._supported_versions = {1, SOLAR_BIAS_SUPPORTED_STORE_VERSION}

    async def _async_migrate_store(
        self,
        old_major_version: int,
        _old_minor_version: int,
        old_data: dict[str, Any],
    ) -> dict[str, Any]:
        if old_major_version == 1:
            return old_data

        raise NotImplementedError

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if not stored:
            self._profile = None
            return

        # Version gating: unsupported versions are treated as no profile
        version = stored.get("version")
        if version not in self._supported_versions:
            self._profile = None
            return

        self._profile = stored

    @property
    def profile(self) -> dict[str, Any] | None:
        return self._profile

    async def async_save(self, payload: dict[str, Any]) -> None:
        self._profile = payload
        await self._store.async_save(payload)
