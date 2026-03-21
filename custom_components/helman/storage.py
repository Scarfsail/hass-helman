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
