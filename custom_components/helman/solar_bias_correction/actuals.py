from __future__ import annotations

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
from ..power_polarity import is_power_inverted
from .forecast_slot_history import load_forecast_slots_for_window
from .models import BiasConfig, SolarActualsWindow
from .slot_invalidation import (
    InvalidationInputs,
    StateSample,
    compute_data_glitch_invalidations,
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
    hass: HomeAssistant,
    cfg: BiasConfig,
    days: int,
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
) -> dict[str, set[str]]:
    forecast_slot_starts_by_date, slot_keys_by_date = _build_day_grid_slot_inputs(
        hass,
        slot_actuals_by_date,
    )
    if not forecast_slot_starts_by_date:
        return {}

    # Resolved before anything is read: a curtailment run that cannot resolve
    # its entities needs no forecast window either.
    curtailment_entities = _resolve_curtailment_entities(hass, cfg)

    # Both layers test actuals against the same archived forecast the trainer
    # is fitted to, so the window is gathered once and shared.
    forecast_slot_wh_by_date = await _load_recorded_forecast_window(
        hass,
        cfg,
        slot_actuals_by_date,
        curtailment_entities=curtailment_entities,
    )

    curtailment = await _load_curtailment_invalidations(
        hass,
        cfg,
        curtailment_entities,
        slot_actuals_by_date,
        forecast_slot_wh_by_date,
        forecast_slot_starts_by_date,
        slot_keys_by_date,
    )
    data_glitch = _load_data_glitch_invalidations(
        hass,
        cfg,
        slot_actuals_by_date,
        forecast_slot_wh_by_date,
    )
    return _union_invalidations(curtailment, data_glitch)


def _union_invalidations(
    *layers: dict[str, set[str]],
) -> dict[str, set[str]]:
    merged: dict[str, set[str]] = {}
    for layer in layers:
        for day, slots in layer.items():
            if not slots:
                continue
            merged.setdefault(day, set()).update(slots)
    return merged


def _resolve_curtailment_entities(
    hass: HomeAssistant,
    cfg: BiasConfig,
) -> tuple[str, str] | None:
    """``(battery SoC entity, grid power entity)`` when curtailment can run.

    None when the SoC threshold is unset — the rule is off — or when either
    sensor is missing from the runtime config, which is worth a warning: the
    user asked for curtailment invalidation and is not getting it.
    """
    if cfg.slot_invalidation_max_battery_soc_percent is None:
        return None

    soc_entity_id = _read_battery_soc_entity_id_from_runtime_config(hass)
    if soc_entity_id is None:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but power_devices.battery.entities.capacity is unavailable at runtime; skipping curtailment invalidation for this training window"
        )
        return None

    grid_power_entity_id = _read_grid_power_entity_id_from_runtime_config(hass)
    if grid_power_entity_id is None:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but power_devices.grid.entities.power is unavailable at runtime; skipping curtailment invalidation for this training window"
        )
        return None

    return (soc_entity_id, grid_power_entity_id)


async def _load_recorded_forecast_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    curtailment_entities: tuple[str, str] | None,
) -> dict[str, dict[str, float]]:
    """Per-slot forecast for each day in the window, at the slot's own horizon.

    Read only when a rule actually needs it: curtailment's underdelivery test
    and the data-glitch zero-with-neighbour rule. One recorder read spans the
    whole window, and it is the same read the trainer is fitted from, so a
    capped slot is judged against the number the fit used.
    """
    needed = (
        curtailment_entities is not None
        or cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh > 0
    )
    if not needed:
        return {}

    dates: list[date] = []
    for day in slot_actuals_by_date:
        try:
            dates.append(date.fromisoformat(day))
        except ValueError:
            continue
    if not dates:
        return {}

    return await load_forecast_slots_for_window(
        hass, first_date=min(dates), last_date=max(dates)
    )


async def _load_curtailment_invalidations(
    hass: HomeAssistant,
    cfg: BiasConfig,
    curtailment_entities: tuple[str, str] | None,
    slot_actuals_by_date: dict[str, dict[str, float]],
    forecast_slot_wh_by_date: dict[str, dict[str, float]],
    forecast_slot_starts_by_date: dict[str, list[datetime]],
    slot_keys_by_date: dict[str, list[str]],
) -> dict[str, set[str]]:
    max_battery_soc_percent = cfg.slot_invalidation_max_battery_soc_percent
    if curtailment_entities is None or max_battery_soc_percent is None:
        return {}
    soc_entity_id, grid_power_entity_id = curtailment_entities

    if not forecast_slot_wh_by_date:
        _LOGGER.warning(
            "Solar bias slot invalidation is configured, but no archived per-slot forecast is available for the training window; curtailment invalidation cannot tell clipping from a cloudy slot and is skipped"
        )
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
    )
    grid_power_samples_utc = await _load_state_samples_for_entity(
        hass,
        grid_power_entity_id,
        window_start_utc,
        window_end_utc,
    )
    # ``InvalidationInputs`` is documented as positive-is-export, and the test
    # downstream only ever looks at the positive side. A grid sensor configured
    # the other way round would therefore read every export as an import: the
    # curtailment filter inverts, invalidating exporting slots and keeping
    # genuinely curtailed ones. Normalise here rather than widening that
    # contract, which several call sites rely on.
    if _read_grid_power_inverted_from_runtime_config(hass):
        grid_power_samples_utc = [
            StateSample(
                timestamp=sample.timestamp,
                value=None if sample.value is None else -sample.value,
            )
            for sample in grid_power_samples_utc
        ]
    return compute_invalidated_slots_for_window(
        InvalidationInputs(
            max_battery_soc_percent=max_battery_soc_percent,
            max_export_w=cfg.slot_invalidation_curtailment_max_export_w,
            max_actual_forecast_ratio=(
                cfg.slot_invalidation_curtailment_max_actual_forecast_ratio
            ),
            soc_samples_utc=soc_samples_utc,
            grid_power_samples_utc=grid_power_samples_utc,
            slot_actuals_by_date=slot_actuals_by_date,
            forecast_slot_wh_by_date=forecast_slot_wh_by_date,
            forecast_slot_starts_by_date=forecast_slot_starts_by_date,
            slot_keys_by_date=slot_keys_by_date,
        )
    )


def _load_data_glitch_invalidations(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    forecast_slot_wh_by_date: dict[str, dict[str, float]],
) -> dict[str, set[str]]:
    max_slot_wh = _resolve_data_glitch_max_slot_wh(hass, cfg)
    min_neighbour_forecast_wh = (
        cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh
    )
    backfill_max_minutes = cfg.slot_invalidation_data_glitch_backfill_max_minutes

    if max_slot_wh is None and min_neighbour_forecast_wh <= 0:
        return {}

    return compute_data_glitch_invalidations(
        slot_actuals_by_date=slot_actuals_by_date,
        # Rule (3) is the only one that reads the forecast, and a zero floor
        # turns it off; the shared window may still have been read for
        # curtailment.
        forecast_slot_wh_by_date=(
            forecast_slot_wh_by_date if min_neighbour_forecast_wh > 0 else {}
        ),
        max_slot_wh=max_slot_wh,
        min_neighbour_forecast_wh=min_neighbour_forecast_wh,
        backfill_max_minutes=backfill_max_minutes,
    )


def _resolve_data_glitch_max_slot_wh(
    hass: HomeAssistant,
    cfg: BiasConfig,
) -> float | None:
    if cfg.slot_invalidation_data_glitch_max_slot_wh is not None:
        return cfg.slot_invalidation_data_glitch_max_slot_wh
    solar_max_power_w = _read_solar_max_power_from_runtime_config(hass)
    if solar_max_power_w is None or solar_max_power_w <= 0:
        return None
    # 15-minute slot at full inverter output, with 5% headroom.
    return solar_max_power_w * 0.25 * 1.05


def _read_solar_max_power_from_runtime_config(hass: HomeAssistant) -> float | None:
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return None
    solar_config = runtime_config.get("power_devices", {}).get("solar", {})
    raw_value = solar_config.get("max_power")
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)
    if isinstance(raw_value, str):
        try:
            return float(raw_value.strip())
        except ValueError:
            return None
    return None


def _read_battery_soc_entity_id_from_runtime_config(hass: HomeAssistant) -> str | None:
    return _read_device_entity_id_from_runtime_config(hass, "battery", "capacity")


def _read_grid_power_entity_id_from_runtime_config(hass: HomeAssistant) -> str | None:
    """The signed grid power sensor.

    Its own convention is whatever ``power_polarity`` says; callers here
    normalise to positive-is-export via
    :func:`_read_grid_power_inverted_from_runtime_config`.
    """
    return _read_device_entity_id_from_runtime_config(hass, "grid", "power")


def _read_grid_power_inverted_from_runtime_config(hass: HomeAssistant) -> bool:
    """Whether the configured grid sensor reads positive-is-import."""
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return False
    power_devices = runtime_config.get("power_devices")
    if not isinstance(power_devices, dict):
        return False
    return is_power_inverted(power_devices.get("grid"), "grid")


def _read_device_entity_id_from_runtime_config(
    hass: HomeAssistant,
    device: str,
    entity_key: str,
) -> str | None:
    runtime_config = getattr(
        hass.data.get(DOMAIN, {}).get("coordinator"),
        "config",
        None,
    )
    if not isinstance(runtime_config, dict):
        return None

    device_config = runtime_config.get("power_devices", {}).get(device, {})
    entities = device_config.get("entities", {})
    if not isinstance(entities, dict):
        return None
    return _read_entity_id(entities.get(entity_key))


def _build_day_grid_slot_inputs(
    hass: HomeAssistant,
    slot_actuals_by_date: dict[str, dict[str, float]],
) -> tuple[dict[str, list[datetime]], dict[str, list[str]]]:
    """Produce the full 15-minute slot grid for every day in the window.

    Curtailment is inferred from physical state (battery SoC and grid export)
    read over the whole day, so the grid is the day's own 96 slots rather than
    whatever slots the historical forecast happens to publish.
    """
    local_tz = ZoneInfo(str(hass.config.time_zone))
    slot_starts_by_date: dict[str, list[datetime]] = {}
    slot_keys_by_date: dict[str, list[str]] = {}

    for day in sorted(slot_actuals_by_date):
        try:
            date.fromisoformat(day)
        except ValueError:
            continue

        day_slot_starts: list[datetime] = []
        day_slot_keys: list[str] = []
        for hour in range(24):
            for minute in (0, 15, 30, 45):
                slot_key = f"{hour:02d}:{minute:02d}"
                slot_start = _build_utc_slot_start(day, slot_key, local_tz)
                if slot_start is None:
                    continue
                day_slot_starts.append(slot_start)
                day_slot_keys.append(slot_key)

        if day_slot_starts:
            slot_starts_by_date[day] = day_slot_starts
            slot_keys_by_date[day] = day_slot_keys

    return slot_starts_by_date, slot_keys_by_date


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
    if not states:
        # A configured entity the recorder knows nothing about — typically one
        # that was renamed or deleted while the config kept pointing at it.
        # Without this the rule that reads it degrades to a silent no-op.
        _LOGGER.warning(
            "No recorder history for %s over the solar bias training window; the rules reading it cannot fire",
            entity_id,
        )

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
                value=_parse_numeric_state_value(getattr(state, "state", None)),
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


