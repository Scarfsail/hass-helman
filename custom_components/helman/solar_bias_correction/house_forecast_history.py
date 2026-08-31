from __future__ import annotations

from datetime import date, datetime, time, timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .forecast_slot_sampling import resolve_forecast_slot_values

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

    Reads the recorder history of the house forecast sensor (W = Wh/h), resolves
    each slot to the value published *for* it -- see
    :func:`resolve_forecast_slot_values` for why the boundary write lands just
    after the slot start and a ``<= slot_start`` sweep drew the curve one slot
    late -- and converts the W value into the slot's Wh (W * 0.25 h).

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

    # Build a list of (instant_local, value_w) pairs. Non-numeric rows are
    # dropped rather than kept as hold-breakers -- unchanged from before.
    timeline: list[tuple[datetime, float | None]] = []
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

    slot_starts = [
        day_start_local + timedelta(minutes=slot_index * _SLOT_MINUTES)
        for slot_index in range(_SLOTS_PER_DAY)
    ]
    return [
        {"timestamp": slot_start.isoformat(), "wh": value_w * _SLOT_FRACTION_OF_HOUR}
        for slot_start, value_w in resolve_forecast_slot_values(
            timeline, slot_starts, slot_minutes=_SLOT_MINUTES
        ).items()
    ]
