from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .models import BiasConfig, SolarActualsWindow
from ..recorder_hourly_series import (
    get_local_current_slot_start,
    query_cumulative_slot_energy_changes,
)


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
        return SolarActualsWindow(slot_actuals_by_date={})

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

    return SolarActualsWindow(slot_actuals_by_date=slot_actuals_by_date)


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
