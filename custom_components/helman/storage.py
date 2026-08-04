from __future__ import annotations
import hashlib
import json
import logging
from typing import Any
from homeassistant.helpers import storage
from homeassistant.core import HomeAssistant
from .automation.migration import migrate_config_document, needs_migration
from .const import (
    CONFIG_DOCUMENT_VERSION,
    DOMAIN,
    FORECAST_SNAPSHOT_STORAGE_KEY,
    FORECAST_SNAPSHOT_STORAGE_VERSION,
    SCHEDULE_STORAGE_KEY,
    SCHEDULE_STORAGE_VERSION,
    STORAGE_KEY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

# Nightly training artifacts. Deliberately not folded into
# `helman.forecast_snapshot`: that store holds outputs and is rewritten every
# 15 minutes behind a hash guard, while these are written once a day and have a
# lifetime and a versioning story of their own.
TRAINING_ARTIFACTS_STORAGE_KEY = f"{DOMAIN}.training_artifacts"
TRAINING_ARTIFACTS_STORAGE_VERSION = 1

DEFAULT_CONFIG: dict[str, Any] = {
    "history_buckets": 60,
    "history_bucket_duration": 5,
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
        self._solar_snapshot: dict[str, Any] | None = None
        self._schedule_store = storage.Store(
            hass, SCHEDULE_STORAGE_VERSION, SCHEDULE_STORAGE_KEY
        )
        self._schedule_document: dict[str, Any] | None = None

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._config = {**DEFAULT_CONFIG, **(stored or {})}
        await self._async_migrate_config()
        snapshot_document = await self._snapshot_store.async_load()
        if isinstance(snapshot_document, dict) and "house" in snapshot_document:
            self._snapshot = snapshot_document.get("house")
            solar_snapshot = snapshot_document.get("solar")
            self._solar_snapshot = (
                solar_snapshot if isinstance(solar_snapshot, dict) else None
            )
        else:
            self._snapshot = (
                snapshot_document if isinstance(snapshot_document, dict) else None
            )
            self._solar_snapshot = None
        self._schedule_document = await self._schedule_store.async_load()

    async def _async_migrate_config(self) -> None:
        """Bring a stored config up to the current document version, once.

        Persists only when something actually changed, so a config already at
        the current version never rewrites the store on every start.
        """
        if not needs_migration(self._config):
            return
        migrated, migrated_optimizer_ids = migrate_config_document(self._config)
        # Not every step reshapes optimizers any more, so only name them when
        # some were actually rewritten.
        if migrated_optimizer_ids:
            _LOGGER.info(
                "Migrated Helman config to version %s; optimizers moved to the "
                "target/params/conditions shape: %s",
                CONFIG_DOCUMENT_VERSION,
                ", ".join(migrated_optimizer_ids),
            )
        else:
            _LOGGER.info(
                "Migrated Helman config to version %s", CONFIG_DOCUMENT_VERSION
            )
        self._config = migrated
        await self._store.async_save(migrated)

    @property
    def config(self) -> dict[str, Any]:
        return self._config

    @property
    def forecast_snapshot(self) -> dict[str, Any] | None:
        return self._snapshot

    @property
    def solar_forecast_snapshot(self) -> dict[str, Any] | None:
        return self._solar_snapshot

    @property
    def schedule_document(self) -> dict[str, Any] | None:
        return self._schedule_document

    async def async_save(self, new_config: dict[str, Any]) -> None:
        self._config = new_config
        await self._store.async_save(new_config)

    async def async_save_snapshot(self, snapshot: dict[str, Any]) -> None:
        await self.async_save_snapshots(
            house_snapshot=snapshot,
            solar_snapshot=self._solar_snapshot,
        )

    async def async_save_snapshots(
        self,
        *,
        house_snapshot: dict[str, Any],
        solar_snapshot: dict[str, Any] | None,
    ) -> None:
        new_hash = self._snapshot_hash(house_snapshot, solar_snapshot)
        if new_hash == getattr(self, "_last_saved_hash", None):
            self._snapshot = house_snapshot
            self._solar_snapshot = solar_snapshot
            return
        self._snapshot = house_snapshot
        self._solar_snapshot = solar_snapshot
        self._last_saved_hash = new_hash
        await self._snapshot_store.async_save(
            {"house": house_snapshot, "solar": solar_snapshot}
        )

    @staticmethod
    def _snapshot_hash(
        house_snapshot: dict[str, Any] | None,
        solar_snapshot: dict[str, Any] | None,
    ) -> str:
        payload = json.dumps(
            {"house": house_snapshot, "solar": solar_snapshot},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha1(payload.encode("utf-8")).hexdigest()

    async def async_save_schedule_document(
        self, schedule_document: dict[str, Any]
    ) -> None:
        self._schedule_document = schedule_document
        await self._schedule_store.async_save(schedule_document)


class TrainingArtifactsStore:
    """Persistence for what the nightly training batch produces.

    Persisted payload shape (v1)::

        {"version": 1,
         "house_consumption": {"data": {...}, "fingerprint": str,
                               "trained_at": str, "last_outcome": str,
                               "error_reason": str | None},
         "appliance_energy":  {"data": {appliance_id: kwh_per_hour},
                               "fingerprint": str, "trained_at": str,
                               "last_outcome": str, "error_reason": str | None}}

    Every section is the same shape, so they share the read/write helpers below.
    No store version bump for ``appliance_energy``: a document written before it
    existed simply has no such key, and a missing section already means "nothing
    trained yet" to every reader.

    Solar bias keeps its own store: the bias service already owns its
    fingerprint, ``trained_at`` and ``last_outcome`` there, and a second copy
    would be two sources of truth that drift.
    """

    HOUSE_CONSUMPTION = "house_consumption"
    APPLIANCE_ENERGY = "appliance_energy"

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(
            hass,
            TRAINING_ARTIFACTS_STORAGE_VERSION,
            TRAINING_ARTIFACTS_STORAGE_KEY,
        )
        self._document: dict[str, Any] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if (
            not isinstance(stored, dict)
            or stored.get("version") != TRAINING_ARTIFACTS_STORAGE_VERSION
        ):
            self._document = {}
            return
        self._document = stored

    @property
    def house_consumption(self) -> dict[str, Any] | None:
        return self._read_section(self.HOUSE_CONSUMPTION)

    @property
    def appliance_energy(self) -> dict[str, Any] | None:
        return self._read_section(self.APPLIANCE_ENERGY)

    async def async_record_house_consumption(
        self,
        *,
        data: dict[str, Any],
        fingerprint: str,
        trained_at: str,
        last_outcome: str,
    ) -> None:
        """Store a freshly fitted profile, replacing whatever was there."""
        await self._async_record(
            self.HOUSE_CONSUMPTION,
            data=data,
            fingerprint=fingerprint,
            trained_at=trained_at,
            last_outcome=last_outcome,
        )

    async def async_record_house_consumption_failure(
        self,
        *,
        last_outcome: str,
        error_reason: str | None,
    ) -> None:
        """Record a failed refit **without** dropping the previous profile."""
        await self._async_record_failure(
            self.HOUSE_CONSUMPTION,
            last_outcome=last_outcome,
            error_reason=error_reason,
        )

    async def async_record_appliance_energy(
        self,
        *,
        data: dict[str, float],
        fingerprint: str,
        trained_at: str,
        last_outcome: str,
    ) -> None:
        """Store freshly resolved per-appliance when-active hourly energy."""
        await self._async_record(
            self.APPLIANCE_ENERGY,
            data=data,
            fingerprint=fingerprint,
            trained_at=trained_at,
            last_outcome=last_outcome,
        )

    async def async_record_appliance_energy_failure(
        self,
        *,
        last_outcome: str,
        error_reason: str | None,
    ) -> None:
        """Record a failed resolve without dropping the previous estimates."""
        await self._async_record_failure(
            self.APPLIANCE_ENERGY,
            last_outcome=last_outcome,
            error_reason=error_reason,
        )

    def _read_section(self, name: str) -> dict[str, Any] | None:
        section = self._document.get(name)
        return section if isinstance(section, dict) else None

    async def _async_record(
        self,
        name: str,
        *,
        data: Any,
        fingerprint: str,
        trained_at: str,
        last_outcome: str,
    ) -> None:
        await self._async_write_section(name, {
            "data": data,
            "fingerprint": fingerprint,
            "trained_at": trained_at,
            "last_outcome": last_outcome,
            "error_reason": None,
        })

    async def _async_record_failure(
        self,
        name: str,
        *,
        last_outcome: str,
        error_reason: str | None,
    ) -> None:
        """Record a failure while preserving whatever was last trained.

        The same rule the bias service applies in ``_should_preserve_profile``:
        a fit that could not run does not make the last one wrong. This is what
        makes "older than 48 h, refit fails" keep serving with a banner instead
        of blanking the card.
        """
        previous = self._read_section(name) or {}
        await self._async_write_section(name, {
            **{
                key: previous.get(key)
                for key in ("data", "fingerprint", "trained_at")
            },
            "last_outcome": last_outcome,
            "error_reason": error_reason,
        })

    async def _async_write_section(self, name: str, section: dict[str, Any]) -> None:
        self._document = {
            **self._document,
            "version": TRAINING_ARTIFACTS_STORAGE_VERSION,
            name: section,
        }
        await self._store.async_save(self._document)


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
        )
        self._store._async_migrate_func = self._async_migrate_store
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
