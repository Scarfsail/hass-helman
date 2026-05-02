from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import importlib
import logging
from typing import Any

from homeassistant.components.energy.websocket_api import async_get_energy_platforms
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def _normalize_source_config_entry_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _get_forecast_section(config: dict[str, Any]) -> dict[str, Any] | None:
    power_devices = config.get("power_devices")
    if not isinstance(power_devices, dict):
        return None

    solar = power_devices.get("solar")
    if not isinstance(solar, dict):
        return None

    forecast = solar.get("forecast")
    return forecast if isinstance(forecast, dict) else None


def _get_legacy_daily_energy_entity_ids(forecast: dict[str, Any]) -> list[str]:
    legacy_ids = forecast.get("daily_energy_entity_ids")
    return legacy_ids if isinstance(legacy_ids, list) else []


def has_invalid_legacy_daily_energy_entity_ids(config: dict[str, Any]) -> bool:
    forecast = _get_forecast_section(config)
    if forecast is None or "daily_energy_entity_ids" not in forecast:
        return False
    return not isinstance(forecast.get("daily_energy_entity_ids"), list)


def is_supported_solar_forecast_entry(
    hass,
    config_entry_id: str | None,
    *,
    supported_domains: set[str],
    helman_entry_id: str | None,
) -> bool:
    if not isinstance(config_entry_id, str) or not config_entry_id.strip():
        return False

    entry = hass.config_entries.async_get_entry(config_entry_id.strip())
    if entry is None:
        return False

    if helman_entry_id is not None and entry.entry_id == helman_entry_id:
        return False

    return entry.domain in supported_domains


def infer_source_config_entry_id_from_legacy_entities(
    daily_energy_entity_ids: list[str],
    *,
    entity_entries: dict[str, Any],
    supported_entry_ids: set[str],
    helman_entry_id: str | None,
) -> str | None:
    candidate_ids: set[str] = set()

    for entity_id in daily_energy_entity_ids:
        entry = entity_entries.get(entity_id)
        config_entry_id = getattr(entry, "config_entry_id", None)
        if not isinstance(config_entry_id, str):
            continue
        if helman_entry_id is not None and config_entry_id == helman_entry_id:
            continue
        if config_entry_id in supported_entry_ids:
            candidate_ids.add(config_entry_id)

    return next(iter(candidate_ids)) if len(candidate_ids) == 1 else None


def migrate_legacy_solar_forecast_config(
    config: dict[str, Any],
    *,
    inferred_source_config_entry_id: str | None,
    preserve_existing_source_config_entry_id: bool = False,
) -> dict[str, Any]:
    migrated = deepcopy(config)
    forecast = _get_forecast_section(migrated)
    if forecast is None:
        return migrated

    forecast.pop("daily_energy_entity_ids", None)
    if preserve_existing_source_config_entry_id and "source_config_entry_id" in forecast:
        return migrated

    existing_source_config_entry_id = _normalize_source_config_entry_id(
        forecast.get("source_config_entry_id")
    )
    if existing_source_config_entry_id is None:
        forecast.pop("source_config_entry_id", None)
    else:
        forecast["source_config_entry_id"] = existing_source_config_entry_id

    inferred_source_config_entry_id = _normalize_source_config_entry_id(
        inferred_source_config_entry_id
    )
    if inferred_source_config_entry_id:
        forecast["source_config_entry_id"] = inferred_source_config_entry_id
    return migrated


async def async_list_supported_solar_forecast_entries(hass) -> list[dict[str, str]]:
    supported_domains = set(await async_get_energy_platforms(hass))
    payload: list[dict[str, str]] = []

    for entry in hass.config_entries.async_entries():
        if entry.domain == DOMAIN:
            continue
        if not is_supported_solar_forecast_entry(
            hass,
            entry.entry_id,
            supported_domains=supported_domains,
            helman_entry_id=None,
        ):
            continue
        payload.append(
            {"entry_id": entry.entry_id, "title": entry.title, "domain": entry.domain}
        )

    payload.sort(key=lambda item: (item["title"].lower(), item["entry_id"]))
    return payload


async def async_migrate_legacy_solar_forecast_config(
    hass, config: dict[str, Any]
) -> dict[str, Any]:
    registry = er.async_get(hass)
    supported = await async_list_supported_solar_forecast_entries(hass)
    supported_entry_ids = {item["entry_id"] for item in supported}
    helman_entry_id = hass.data.get(DOMAIN, {}).get("entry_id")

    forecast = _get_forecast_section(config) or {}
    if "source_config_entry_id" in forecast:
        return migrate_legacy_solar_forecast_config(
            config,
            inferred_source_config_entry_id=None,
            preserve_existing_source_config_entry_id=True,
        )

    legacy_ids = _get_legacy_daily_energy_entity_ids(forecast)
    inferred = infer_source_config_entry_id_from_legacy_entities(
        legacy_ids,
        entity_entries={entity_id: registry.async_get(entity_id) for entity_id in legacy_ids},
        supported_entry_ids=supported_entry_ids,
        helman_entry_id=helman_entry_id,
    )
    return migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=inferred,
    )


async def async_load_upstream_solar_forecast(
    hass, source_config_entry_id: str
) -> dict[str, Any] | None:
    config_entry = hass.config_entries.async_get_entry(source_config_entry_id)
    if config_entry is None or config_entry.domain == DOMAIN:
        return None

    loader = _load_energy_platform_loader(config_entry.domain)
    if loader is None:
        return None

    return await loader(hass, source_config_entry_id)


async def async_discover_provider_daily_forecast_entities(
    hass, source_config_entry_id: str | None
) -> list[str]:
    normalized_source_config_entry_id = _normalize_source_config_entry_id(
        source_config_entry_id
    )
    if normalized_source_config_entry_id is None:
        return []

    registry = er.async_get(hass)
    states = getattr(hass, "states", None)
    entities = getattr(registry, "entities", None)
    if not isinstance(entities, dict) or states is None:
        return []

    discovered: list[tuple[datetime, str]] = []
    for entry in entities.values():
        if getattr(entry, "config_entry_id", None) != normalized_source_config_entry_id:
            continue

        entity_id = getattr(entry, "entity_id", None)
        if not isinstance(entity_id, str) or not entity_id:
            continue

        state = states.get(entity_id)
        attributes = getattr(state, "attributes", None)
        wh_period = attributes.get("wh_period") if isinstance(attributes, dict) else None
        if not isinstance(wh_period, dict) or not wh_period:
            continue

        earliest = _earliest_wh_period_timestamp(wh_period)
        if earliest is None:
            continue

        discovered.append((earliest, entity_id))

    discovered.sort(key=lambda item: (item[0], item[1]))
    return [entity_id for _, entity_id in discovered]


def _load_energy_platform_loader(domain: str):
    for module_name in (
        f"custom_components.{domain}.energy",
        f"homeassistant.components.{domain}.energy",
    ):
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError as err:
            if err.name != module_name:
                _LOGGER.exception(
                    "Failed importing upstream energy platform module %s", module_name
                )
                return None
            continue

        loader = getattr(module, "async_get_solar_forecast", None)
        if callable(loader):
            return loader

    return None


def _earliest_wh_period_timestamp(wh_period: dict[str, Any]) -> datetime | None:
    timestamps = [
        parsed
        for raw_key in wh_period
        if (parsed := _parse_wh_period_timestamp(raw_key)) is not None
    ]
    return min(timestamps, default=None)


def _parse_wh_period_timestamp(raw_key: Any) -> datetime | None:
    if not isinstance(raw_key, str):
        return None

    try:
        parsed = datetime.fromisoformat(raw_key.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
