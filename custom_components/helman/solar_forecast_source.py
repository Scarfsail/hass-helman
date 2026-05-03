from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timezone
import importlib
import logging
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.components.energy.websocket_api import async_get_energy_platforms
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def _normalize_source_config_entry_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _get_solar_section(config: dict[str, Any]) -> dict[str, Any] | None:
    power_devices = config.get("power_devices")
    if not isinstance(power_devices, dict):
        return None
    solar = power_devices.get("solar")
    return solar if isinstance(solar, dict) else None


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

    # Move forecast-level total_energy_entity_id to bias_correction where it is now read.
    old_tee = forecast.pop("total_energy_entity_id", None)
    if isinstance(old_tee, str):
        old_tee = old_tee.strip()
    if old_tee:
        bias_cfg = forecast.setdefault("bias_correction", {})
        if not isinstance(bias_cfg, dict):
            bias_cfg = {}
            forecast["bias_correction"] = bias_cfg
        if not bias_cfg.get("total_energy_entity_id"):
            bias_cfg["total_energy_entity_id"] = old_tee

    solar = _get_solar_section(migrated)
    if solar is not None and isinstance(solar.get("entities"), dict):
        solar["entities"].pop("remaining_today_energy_forecast", None)

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


async def async_discover_provider_daily_forecast_entities(
    hass,
    source_config_entry_id: str | None,
) -> list[str]:
    """Stub kept for import compatibility — replaced by wh_hours in Task 4."""
    return []


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

    raw = await loader(hass, source_config_entry_id)
    raw_dict = raw if isinstance(raw, dict) else {}
    wh_hours = _normalize_wh_hours(raw_dict.get("wh_hours"))
    return {"wh_hours": wh_hours}


def build_points_from_wh_hours(raw_wh_hours: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_wh_hours, dict):
        return []

    points_with_sort_keys: list[tuple[datetime, dict[str, Any]]] = []
    for raw_timestamp, raw_value in raw_wh_hours.items():
        timestamp = _parse_wh_timestamp(raw_timestamp)
        value = _parse_wh_value(raw_value)
        if timestamp is None or value is None:
            continue

        utc_timestamp = timestamp.astimezone(timezone.utc)
        points_with_sort_keys.append(
            (utc_timestamp, {"timestamp": raw_timestamp, "value": value})
        )

    points_with_sort_keys.sort(key=lambda item: item[0])
    return [point for _, point in points_with_sort_keys]


def slice_wh_hours_by_local_date(
    raw_wh_hours: Any,
    *,
    local_tz: ZoneInfo,
    target_date: date,
) -> list[dict[str, Any]]:
    if not isinstance(raw_wh_hours, dict):
        return []

    matched: list[tuple[datetime, dict[str, Any]]] = []
    for raw_timestamp, raw_value in raw_wh_hours.items():
        ts = _parse_wh_timestamp(raw_timestamp)
        value = _parse_wh_value(raw_value)
        if ts is None or value is None:
            continue

        local_ts = ts.astimezone(local_tz)
        if local_ts.date() != target_date:
            continue

        utc_ts = ts.astimezone(timezone.utc)
        matched.append((utc_ts, {"timestamp": raw_timestamp, "value": value}))

    matched.sort(key=lambda item: item[0])
    return [point for _, point in matched]


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


def _normalize_wh_hours(raw_wh_hours: Any) -> dict[str, float]:
    if not isinstance(raw_wh_hours, dict):
        return {}
    result: dict[str, float] = {}
    for raw_key, raw_value in raw_wh_hours.items():
        if not isinstance(raw_key, str):
            continue
        value = _parse_wh_value(raw_value)
        if value is None:
            continue
        result[raw_key] = value
    return result


def _parse_wh_value(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)
    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _parse_wh_timestamp(raw_key: Any) -> datetime | None:
    if not isinstance(raw_key, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw_key.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
