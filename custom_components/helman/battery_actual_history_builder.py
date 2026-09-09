from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from .recorder_hourly_series import (
    TodaySlotBoundaryStateReader,
    get_today_completed_local_slots,
)


async def build_battery_actual_history(
    boundary_history: TodaySlotBoundaryStateReader,
    capacity_entity_id: str,
    reference_time: datetime,
    *,
    interval_minutes: int = 60,
) -> list[dict[str, Any]]:
    """Today's per-slot SoC trajectory, read through the shared reader.

    ``boundary_history`` is the coordinator's reader rather than a plain
    ``hass``: the completed part of today's boundary series is the same for
    every consumer of it, so warming the forecast and gathering the automation
    inputs in the same run cost one settled read and two tails.
    """
    boundary_samples = await boundary_history.async_query_slot_boundary_state_values(
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
