from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util


def get_local_current_hour_start(reference_time: datetime) -> datetime:
    return dt_util.as_local(reference_time).replace(minute=0, second=0, microsecond=0)


def get_today_completed_local_hours(reference_time: datetime) -> list[datetime]:
    current_hour_start = get_local_current_hour_start(reference_time)
    local_midnight = current_hour_start.replace(hour=0)
    hours: list[datetime] = []
    cursor = local_midnight
    while cursor < current_hour_start:
        hours.append(cursor)
        cursor += timedelta(hours=1)
    return hours


def get_today_completed_local_hour_boundaries(reference_time: datetime) -> list[datetime]:
    completed_hours = get_today_completed_local_hours(reference_time)
    if not completed_hours:
        return [get_local_current_hour_start(reference_time)]
    return [*completed_hours, completed_hours[-1] + timedelta(hours=1)]


async def query_hourly_energy_changes(
    hass: HomeAssistant,
    entity_id: str,
    reference_time: datetime,
) -> dict[datetime, float]:
    completed_hours = get_today_completed_local_hours(reference_time)
    if not completed_hours:
        return {}

    start_time = dt_util.as_utc(completed_hours[0])
    end_time = dt_util.as_utc(completed_hours[-1] + timedelta(hours=1))
    rows = await get_instance(hass).async_add_executor_job(
        statistics_during_period,
        hass,
        start_time,
        end_time,
        {entity_id},
        "hour",
        {"energy": "kWh"},
        {"change"},
    )
    return _rows_to_local_hour_map(
        rows.get(entity_id, []),
        valid_hours=set(completed_hours),
    )


async def query_hour_boundary_state_values(
    hass: HomeAssistant,
    entity_id: str,
    reference_time: datetime,
) -> dict[datetime, float]:
    boundaries = get_today_completed_local_hour_boundaries(reference_time)
    if not boundaries:
        return {}

    history = await get_instance(hass).async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            dt_util.as_utc(boundaries[0]),
            None,
            entity_id,
            True,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []
    return _sample_state_values_at_boundaries(states, boundaries)


def _rows_to_local_hour_map(
    rows: list[dict[str, Any]],
    *,
    valid_hours: set[datetime],
) -> dict[datetime, float]:
    values_by_hour: dict[datetime, float] = {}
    for row in rows:
        ts = row.get("start")
        value = _read_float(row.get("change"))
        if not isinstance(ts, (int, float)) or value is None:
            continue

        local_hour = dt_util.as_local(dt_util.utc_from_timestamp(ts)).replace(
            minute=0, second=0, microsecond=0
        )
        if local_hour in valid_hours:
            values_by_hour[local_hour] = value

    return values_by_hour


def _sample_state_values_at_boundaries(
    states: list[Any],
    boundaries: list[datetime],
) -> dict[datetime, float]:
    if not states or not boundaries:
        return {}

    samples: dict[datetime, float] = {}
    state_index = 0
    latest_value: float | None = None

    for boundary in boundaries:
        boundary_utc = dt_util.as_utc(boundary)
        while state_index < len(states):
            state = states[state_index]
            last_updated = getattr(state, "last_updated", None)
            if last_updated is None:
                state_index += 1
                continue

            state_updated_utc = dt_util.as_utc(last_updated)
            if state_updated_utc > boundary_utc:
                break

            parsed_value = _read_float(getattr(state, "state", None))
            if parsed_value is not None:
                latest_value = parsed_value
            state_index += 1

        if latest_value is not None:
            samples[boundary] = latest_value

    return samples


def _read_float(raw_value: Any) -> float | None:
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
