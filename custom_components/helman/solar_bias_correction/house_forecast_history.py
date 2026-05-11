from __future__ import annotations

from datetime import date, datetime, time, timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

try:
    from homeassistant.components.recorder import get_instance
    from homeassistant.components.recorder.history import get_significant_states
except Exception:  # pragma: no cover
    get_instance = None  # type: ignore[assignment]
    get_significant_states = None  # type: ignore[assignment]

HOUSE_FORECAST_CURRENT_ENTITY = "sensor.helman_house_consumption_forecast_current"
_SLOT_MINUTES = 15
_SLOTS_PER_DAY = 24 * 60 // _SLOT_MINUTES  # 96
_SLOT_FRACTION_OF_HOUR = _SLOT_MINUTES / 60  # 0.25


async def load_house_forecast_points_for_day(
    hass: HomeAssistant,
    target_date: date,
) -> list[dict[str, Any]]:
    """Return per-15min house forecast slot points for target_date.

    Reads the recorder history of the house forecast sensor (W = Wh/h) and
    holds-forward each value across the slot it covers, then converts the
    W value into the slot's Wh (W * 0.25 h).

    Returns a list of {"timestamp": ISO local time, "wh": float}.
    Empty list if no recorder data for the day.
    """
    if get_significant_states is None or get_instance is None:
        return []
    local_tz = ZoneInfo(str(hass.config.time_zone))
    day_start_local = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
    day_end_local = day_start_local + timedelta(days=1)
    start_utc = dt_util.as_utc(day_start_local)
    end_utc = dt_util.as_utc(day_end_local)

    states_by_entity = await get_instance(hass).async_add_executor_job(
        partial(
            get_significant_states,
            hass,
            start_utc,
            end_utc,
            [HOUSE_FORECAST_CURRENT_ENTITY],
            significant_changes_only=False,
        )
    )
    states = states_by_entity.get(HOUSE_FORECAST_CURRENT_ENTITY) or []
    if not states:
        return []

    # Build a list of (instant_local, value_w) pairs.
    timeline: list[tuple[datetime, float]] = []
    for state in states:
        raw = getattr(state, "state", None)
        try:
            value_w = float(raw)
        except (TypeError, ValueError):
            continue
        ts = getattr(state, "last_changed", None) or getattr(state, "last_updated", None)
        if ts is None:
            continue
        timeline.append((dt_util.as_local(ts), value_w))
    if not timeline:
        return []
    timeline.sort(key=lambda pair: pair[0])

    points: list[dict[str, Any]] = []
    cursor = 0
    current_value: float | None = None
    for slot_index in range(_SLOTS_PER_DAY):
        slot_start = day_start_local + timedelta(minutes=slot_index * _SLOT_MINUTES)
        # advance cursor while next change is <= slot_start
        while cursor < len(timeline) and timeline[cursor][0] <= slot_start:
            current_value = timeline[cursor][1]
            cursor += 1
        if current_value is None:
            continue
        slot_wh = current_value * _SLOT_FRACTION_OF_HOUR
        points.append(
            {
                "timestamp": slot_start.isoformat(),
                "wh": slot_wh,
            }
        )
    return points
