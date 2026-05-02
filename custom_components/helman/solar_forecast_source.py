from __future__ import annotations

from copy import deepcopy
from typing import Any

from homeassistant.components.energy.websocket_api import async_get_energy_platforms

from .const import DOMAIN


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
) -> dict[str, Any]:
    migrated = deepcopy(config)
    power_devices = migrated.get("power_devices")
    if not isinstance(power_devices, dict):
        return migrated

    solar = power_devices.get("solar")
    if not isinstance(solar, dict):
        return migrated

    forecast = solar.get("forecast")
    if not isinstance(forecast, dict):
        return migrated

    forecast.pop("daily_energy_entity_ids", None)
    normalized_source_config_entry_id = None
    if isinstance(inferred_source_config_entry_id, str):
        normalized_source_config_entry_id = inferred_source_config_entry_id.strip()
    if normalized_source_config_entry_id:
        forecast["source_config_entry_id"] = normalized_source_config_entry_id
    return migrated


async def async_list_supported_solar_forecast_entries(hass) -> list[dict[str, str]]:
    supported_domains = set(await async_get_energy_platforms(hass))
    domain_data = hass.data.get(DOMAIN, {})
    helman_entry_id = domain_data.get("entry_id")
    payload: list[dict[str, str]] = []

    for entry in hass.config_entries.async_entries():
        if helman_entry_id is None and entry.domain == DOMAIN:
            continue
        if not is_supported_solar_forecast_entry(
            hass,
            entry.entry_id,
            supported_domains=supported_domains,
            helman_entry_id=helman_entry_id,
        ):
            continue
        payload.append(
            {"entry_id": entry.entry_id, "title": entry.title, "domain": entry.domain}
        )

    payload.sort(key=lambda item: (item["title"].lower(), item["entry_id"]))
    return payload
