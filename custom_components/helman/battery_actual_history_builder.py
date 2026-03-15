from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .recorder_hourly_series import (
    get_today_completed_local_hours,
    query_hour_boundary_state_values,
)


async def build_battery_actual_history(
    hass: HomeAssistant,
    capacity_entity_id: str,
    reference_time: datetime,
) -> list[dict[str, Any]]:
    boundary_samples = await query_hour_boundary_state_values(
        hass,
        capacity_entity_id,
        reference_time,
    )

    actual_history: list[dict[str, Any]] = []
    for hour_start in get_today_completed_local_hours(reference_time):
        start_boundary_utc = dt_util.as_utc(hour_start)
        end_boundary_utc = start_boundary_utc + timedelta(hours=1)
        start_soc = boundary_samples.get(start_boundary_utc)
        end_soc = boundary_samples.get(end_boundary_utc)
        if not _is_valid_soc(start_soc) or not _is_valid_soc(end_soc):
            continue

        actual_history.append(
            {
                "timestamp": hour_start.isoformat(),
                "startSocPct": round(start_soc, 2),
                "socPct": round(end_soc, 2),
            }
        )

    return actual_history


def _is_valid_soc(value: Any) -> bool:
    return isinstance(value, (int, float)) and 0 <= float(value) <= 100
