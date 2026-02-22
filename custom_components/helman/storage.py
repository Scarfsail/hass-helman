from __future__ import annotations
from typing import Any
from homeassistant.helpers import storage
from homeassistant.core import HomeAssistant
from .const import DOMAIN, STORAGE_VERSION, STORAGE_KEY

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

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._config = {**DEFAULT_CONFIG, **(stored or {})}

    @property
    def config(self) -> dict[str, Any]:
        return self._config

    async def async_save(self, new_config: dict[str, Any]) -> None:
        self._config = new_config
        await self._store.async_save(new_config)
