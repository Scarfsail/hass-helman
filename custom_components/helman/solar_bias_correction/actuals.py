from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, time, timedelta, timezone
import logging
from typing import Any
from zoneinfo import ZoneInfo

try:
    from homeassistant.components.recorder import get_instance
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_instance = lambda hass: None  # type: ignore[assignment]

try:
    from homeassistant.components.recorder.history import state_changes_during_period
except Exception:  # pragma: no cover - Home Assistant API compatibility
    state_changes_during_period = None  # type: ignore[assignment]
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..const import DOMAIN
from .models import BiasConfig, SolarActualsWindow
from .forecast_history import load_historical_per_slot_forecast
from .slot_invalidation import (
    InvalidationInputs,
    StateSample,
    compute_invalidated_slots_for_window,
)
try:
    from ..recorder_hourly_series import (
        get_local_current_slot_start,
        query_cumulative_slot_energy_changes,
    )
except Exception:  # pragma: no cover - test stub compatibility
    def get_local_current_slot_start(
        local_now: datetime,
        interval_minutes: int,
    ) -> datetime:
        floored_minute = (local_now.minute // interval_minutes) * interval_minutes
        return local_now.replace(
            minute=floored_minute,
            second=0,
            microsecond=0,
        )

    async def query_cumulative_slot_energy_changes(
        hass: HomeAssistant,
        entity_id: str,
        *,
        local_start: datetime,
        local_end: datetime,
        interval_minutes: int,
    ) -> dict[datetime, float]:
        del hass, entity_id, local_start, local_end, interval_minutes
        return {}


_LOGGER = logging.getLogger(__name__)


async def load_actuals_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float]:
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None:
        return {}
    return await _read_day_slot_actuals(
        hass,
        entity_id,
        target_date,
        local_now=local_now,
    )


async def load_actuals_window(
    hass: HomeAssistant, cfg: BiasConfig, days: int
) -> SolarActualsWindow:
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None or days <= 0:
        return SolarActualsWindow(
            slot_actuals_by_date={},
            invalidated_slots_by_date={},
        )

    local_now = dt_util.as_local(datetime.now(timezone.utc))
    slot_actuals_by_date: dict[str, dict[str, float]] = {}

    for offset in range(days, 0, -1):
        target_date = local_now.date() - timedelta(days=offset)
        slot_actuals_by_date[str(target_date)] = await _read_day_slot_actuals(
            hass,
            entity_id,
            target_date,
            local_now=local_now,
        )

    invalidated_slots_by_date = await _load_invalidated_slots_for_window(
        hass,
        cfg,
        slot_actuals_by_date,
        local_now=local_now,
    )
    return SolarActualsWindow(
        slot_actuals_by_date=slot_actuals_by_date,
        invalidated_slots_by_date=invalidated_slots_by_date,
    )


async def _read_day_slot_actuals(
    hass: HomeAssistant,
    entity_id: str,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float]:
    local_start = datetime.combine(target_date, time.min, tzinfo=local_now.tzinfo)
    local_end = local_start + timedelta(days=1)
    if target_date == local_now.date():
        local_end = min(
            local_end,
            get_local_current_slot_start(local_now, interval_minutes=15),
        )
    values_by_slot = await query_cumulative_slot_energy_changes(
        hass,
        entity_id,
        local_start=local_start,
        local_end=local_end,
        interval_minutes=15,
    )
    return {
        dt_util.as_local(slot_start).strftime("%H:%M"): round(value_kwh * 1000.0, 4)
        for slot_start, value_kwh in sorted(values_by_slot.items())
    }


def _read_entity_id(raw_value: Any) -> str | None:
    if isinstance(raw_value, str):
        entity_id = raw_value.strip()
        if entity_id:
            return entity_id
    return None


async def _load_invalidated_slots_for_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    local_now: datetime,
) -> dict[str, set[str]]:
    max_battery_soc_percent = cfg.slot_invalidation_max_battery_soc_percent
    export_entity_id = _read_entity_id(cfg.slot_invalidation_export_enabled_entity_id)
    if max_battery_soc_percent is None or export_entity_id is None:
        return {}

    soc_entity_id = _read_battery_soc_entity_id_from_runtime_config(hass)
    if soc_entity_id is None:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but power_devices.battery.entities.capacity is unavailable at runtime; skipping invalidation for this training window"
        )
        return {}

    forecast_slot_starts_by_date, slot_keys_by_date = _build_slot_invalidation_inputs(
        hass,
        await _load_forecast_slot_maps_for_window(
            hass,
            cfg,
            slot_actuals_by_date,
            local_now=local_now,
        ),
    )
    if not forecast_slot_starts_by_date:
        return {}

    window_start_utc = min(
        slot_start
        for slot_starts in forecast_slot_starts_by_date.values()
        for slot_start in slot_starts
    )
    window_end_utc = max(
        _resolve_day_end_utc(hass, day) for day in forecast_slot_starts_by_date
    )

    soc_samples_utc = await _load_state_samples_for_entity(
        hass,
        soc_entity_id,
        window_start_utc,
        window_end_utc,
        parser=_parse_numeric_state_value,
    )
    export_samples_utc = await _load_state_samples_for_entity(
        hass,
        export_entity_id,
        window_start_utc,
        window_end_utc,
        parser=_parse_bool_state_value,
    )
    return compute_invalidated_slots_for_window(
        InvalidationInputs(
            max_battery_soc_percent=max_battery_soc_percent,
            soc_samples_utc=soc_samples_utc,
            export_samples_utc=export_samples_utc,
            forecast_slot_starts_by_date=forecast_slot_starts_by_date,
            slot_keys_by_date=slot_keys_by_date,
        )
    )


def _read_battery_soc_entity_id_from_runtime_config(hass: HomeAssistant) -> str | None:
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return None

    battery_config = runtime_config.get("power_devices", {}).get("battery", {})
    entities = battery_config.get("entities", {})
    if not isinstance(entities, dict):
        return None
    return _read_entity_id(entities.get("capacity"))


async def _load_forecast_slot_maps_for_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    local_now: datetime,
) -> dict[str, dict[str, float]]:
    forecast_slots_by_date: dict[str, dict[str, float]] = {}
    for day in sorted(slot_actuals_by_date):
        try:
            target_date = date.fromisoformat(day)
        except ValueError:
            continue
        day_forecast_slots = await load_historical_per_slot_forecast(
            hass,
            cfg,
            target_date,
            local_now=local_now,
        )
        if day_forecast_slots:
            forecast_slots_by_date[day] = day_forecast_slots
    return forecast_slots_by_date


def _build_slot_invalidation_inputs(
    hass: HomeAssistant,
    forecast_slots_by_date: dict[str, dict[str, float]],
) -> tuple[dict[str, list[datetime]], dict[str, list[str]]]:
    local_tz = ZoneInfo(str(hass.config.time_zone))
    forecast_slot_starts_by_date: dict[str, list[datetime]] = {}
    slot_keys_by_date: dict[str, list[str]] = {}

    for day in sorted(forecast_slots_by_date):
        day_forecast_slots = forecast_slots_by_date.get(day, {})
        slot_keys = sorted(day_forecast_slots, key=_slot_sort_key)
        if not slot_keys:
            continue

        day_slot_starts: list[datetime] = []
        day_slot_keys: list[str] = []
        for slot_key in slot_keys:
            slot_start = _build_utc_slot_start(day, slot_key, local_tz)
            if slot_start is None:
                continue
            day_slot_starts.append(slot_start)
            day_slot_keys.append(slot_key)

        if day_slot_starts:
            forecast_slot_starts_by_date[day] = day_slot_starts
            slot_keys_by_date[day] = day_slot_keys

    return forecast_slot_starts_by_date, slot_keys_by_date


def _build_utc_slot_start(
    day: str,
    slot_key: str,
    local_tz: ZoneInfo,
) -> datetime | None:
    try:
        target_date = date.fromisoformat(day)
        hour_text, minute_text = slot_key.split(":", 1)
        local_slot_start = datetime.combine(
            target_date,
            time(int(hour_text), int(minute_text)),
            tzinfo=local_tz,
        )
    except (TypeError, ValueError):
        return None
    return dt_util.as_utc(local_slot_start)


def _resolve_day_end_utc(hass: HomeAssistant, day: str) -> datetime:
    local_tz = ZoneInfo(str(hass.config.time_zone))
    local_day_end = datetime.combine(
        date.fromisoformat(day) + timedelta(days=1),
        time.min,
        tzinfo=local_tz,
    )
    return dt_util.as_utc(local_day_end)


async def _load_state_samples_for_entity(
    hass: HomeAssistant,
    entity_id: str,
    utc_start: datetime,
    utc_end: datetime,
    *,
    parser: Callable[[Any], float | bool | None],
) -> list[StateSample]:
    if state_changes_during_period is None:
        return []

    recorder = get_instance(hass)
    if recorder is None:
        return []

    history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            False,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []

    samples: list[StateSample] = []
    for state in states:
        timestamp = getattr(state, "last_updated", None) or getattr(
            state,
            "last_changed",
            None,
        )
        if timestamp is None:
            continue
        samples.append(
            StateSample(
                timestamp=dt_util.as_utc(timestamp),
                value=parser(getattr(state, "state", None)),
            )
        )
    return samples


def _parse_numeric_state_value(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)
    if isinstance(raw_value, str):
        value_text = raw_value.strip()
        if not value_text:
            return None
        try:
            return float(value_text)
        except ValueError:
            return None
    return None


def _parse_bool_state_value(raw_value: Any) -> bool | None:
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, str):
        value_text = raw_value.strip().lower()
        if value_text in {"on", "true", "1"}:
            return True
        if value_text in {"off", "false", "0"}:
            return False
    return None


def _slot_sort_key(slot_key: str) -> tuple[int, int]:
    try:
        hour_text, minute_text = slot_key.split(":", 1)
        return int(hour_text), int(minute_text)
    except (AttributeError, ValueError):
        return (99, 99)
