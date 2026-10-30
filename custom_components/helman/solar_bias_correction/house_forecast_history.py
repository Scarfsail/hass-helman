from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..recorder_states import numeric_timeline, read_states
from ..slot_grid import SLOT_MINUTES, day_slots
from .forecast_slot_sampling import resolve_forecast_slot_values

HOUSE_FORECAST_CURRENT_ENTITY = "sensor.helman_house_consumption_forecast_current"

_SLOT_FRACTION_OF_HOUR = SLOT_MINUTES / 60  # 0.25


async def load_house_forecast_points_for_day(
    hass: HomeAssistant,
    target_date: date,
    *,
    until: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return per-15min house forecast slot points for target_date.

    Reads the recorder history of the house forecast sensor (W = Wh/h), resolves
    each slot to the value published *for* it -- see
    :func:`resolve_forecast_slot_values` for why the boundary write lands just
    after the slot start and a ``<= slot_start`` sweep drew the curve one slot
    late -- and converts the W value into the slot's Wh (W * 0.25 h).

    Returns a list of {"timestamp": ISO local time, "wh": float}.
    Empty list if no recorder data for the day.
    """
    local_tz = ZoneInfo(str(hass.config.time_zone))
    day_start_local = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
    day_end_local = day_start_local + timedelta(days=1)

    states_by_entity = await read_states(
        hass,
        [HOUSE_FORECAST_CURRENT_ENTITY],
        day_start_local,
        until or day_end_local,
        include_start_state=True,
        no_attributes=True,
    )
    states = states_by_entity.get(HOUSE_FORECAST_CURRENT_ENTITY) or []
    if not states:
        return []

    # Build a list of (instant_local, value_w) pairs. Non-numeric rows are kept
    # as hold-breakers -- see :func:`resolve_forecast_slot_values` for why.
    timeline = numeric_timeline(states, keep_non_numeric=True)
    if not timeline:
        return []

    slot_starts = [dt_util.as_utc(slot) for slot in day_slots(target_date, tzinfo=local_tz)
                   if until is None or dt_util.as_utc(slot) < dt_util.as_utc(until)]
    timeline = sorted((dt_util.as_utc(instant), value) for instant, value in timeline)

    return [
        {"timestamp": slot_start.astimezone(local_tz).isoformat(), "wh": value_w * _SLOT_FRACTION_OF_HOUR}
        for slot_start, value_w in resolve_forecast_slot_values(
            timeline, slot_starts, slot_minutes=SLOT_MINUTES
        ).items()
    ]
