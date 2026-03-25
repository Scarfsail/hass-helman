from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .recorder_hourly_series import (
    get_today_completed_local_slots,
    query_slot_boundary_state_values,
)


async def build_battery_actual_history(
    hass: HomeAssistant,
    capacity_entity_id: str,
    reference_time: datetime,
    *,
    interval_minutes: int = 60,
) -> list[dict[str, Any]]:
    boundary_samples = await query_slot_boundary_state_values(
        hass,
        capacity_entity_id,
        reference_time,
        interval_minutes=interval_minutes,
    )

    actual_history: list[dict[str, Any]] = []
    slot_duration = timedelta(minutes=interval_minutes)
    for slot_start in get_today_completed_local_slots(
        reference_time,
        interval_minutes=interval_minutes,
    ):
        start_boundary_utc = dt_util.as_utc(slot_start)
        end_boundary_utc = start_boundary_utc + slot_duration
        start_soc = boundary_samples.get(start_boundary_utc)
        end_soc = boundary_samples.get(end_boundary_utc)
        if not _is_valid_soc(start_soc) or not _is_valid_soc(end_soc):
            continue

        actual_history.append(
            {
                "timestamp": slot_start.isoformat(),
                "startSocPct": round(start_soc, 2),
                "socPct": round(end_soc, 2),
            }
        )

    return actual_history


def _is_valid_soc(value: Any) -> bool:
    return isinstance(value, (int, float)) and 0 <= float(value) <= 100
