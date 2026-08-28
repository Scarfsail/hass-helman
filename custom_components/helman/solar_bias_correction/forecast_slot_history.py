"""Read the per-slot solar forecast back out of Helman's own forecast sensor.

``sensor.helman_solar_forecast_current`` publishes the raw forecast for the
slot in progress, in W, on the slot-aligned refresh beat. Its recorder history
is therefore a stair-step of what the provider said about each slot *while that
slot had not yet begun* — the measurement the bias trainer is fitted to. This
module turns that history back into ``HH:MM -> Wh`` maps.

Two things about the read are easy to get wrong, and both produce plausible
numbers rather than an error:

* **Sample a moment into the slot, not at its boundary.** The refresh fires at
  ``:00/:15/:30/:45`` and the write lands milliseconds later, so a timeline
  sampled exactly at the boundary still holds the *previous* slot's value.
  Sampling :01 into the slot catches the boundary write while staying clear of
  the provider's mid-slot republications, which arrive hours apart. It is the
  same rule the writer uses from the other side, where ``record_points``
  floored ``now`` to the minute so a boundary write counted for the slot
  starting then.
* **Hold the last value forward.** Home Assistant records a row only when the
  state actually changes, so two consecutive slots forecast alike share one
  row. Treating a slot with no row of its own as missing would blank every
  flat stretch of the curve — most of the night, and every overcast hour.

One recorder read serves a whole window. The trainer asks for thirty days at
once rather than thirty times for one.
"""

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
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_instance = None  # type: ignore[assignment]
    get_significant_states = None  # type: ignore[assignment]

#: The entity this module reads. Helman publishes it; see
#: ``HelmanSolarForecastCurrentSensor``.
SOLAR_FORECAST_CURRENT_ENTITY = "sensor.helman_solar_forecast_current"

_SLOT_MINUTES = 15
_SLOTS_PER_DAY = 24 * 60 // _SLOT_MINUTES
_SLOT_FRACTION_OF_HOUR = _SLOT_MINUTES / 60
#: How far into a slot the timeline is sampled. See the module docstring.
_SAMPLE_OFFSET = timedelta(minutes=1)


async def load_forecast_slots_for_window(
    hass: HomeAssistant,
    *,
    first_date: date,
    last_date: date,
) -> dict[str, dict[str, float]]:
    """``{"YYYY-MM-DD": {"HH:MM": wh}}`` for every day in the inclusive range.

    A day the sensor was not publishing on simply does not appear, which the
    trainer already treats as "no sample for this day".
    """
    if get_significant_states is None or get_instance is None:
        return {}
    if last_date < first_date:
        return {}

    local_tz = ZoneInfo(str(hass.config.time_zone))
    window_start = datetime.combine(first_date, time.min, tzinfo=local_tz)
    window_end = datetime.combine(last_date, time.min, tzinfo=local_tz) + timedelta(days=1)

    timeline = await _load_timeline(hass, window_start, window_end)
    if not timeline:
        return {}

    days: dict[str, dict[str, float]] = {}
    cursor = 0
    current_value: float | None = None
    day = first_date
    while day <= last_date:
        day_start = datetime.combine(day, time.min, tzinfo=local_tz)
        slots: dict[str, float] = {}
        for slot_index in range(_SLOTS_PER_DAY):
            slot_start = day_start + timedelta(minutes=slot_index * _SLOT_MINUTES)
            sample_at = slot_start + _SAMPLE_OFFSET
            while cursor < len(timeline) and timeline[cursor][0] <= sample_at:
                current_value = timeline[cursor][1]
                cursor += 1
            if current_value is None:
                continue
            slots[f"{slot_start.hour:02d}:{slot_start.minute:02d}"] = (
                current_value * _SLOT_FRACTION_OF_HOUR
            )
        if slots:
            days[day.isoformat()] = slots
        day += timedelta(days=1)
    return days


async def load_forecast_slots_for_day(
    hass: HomeAssistant,
    target_date: date,
) -> dict[str, float]:
    """The ``HH:MM -> Wh`` map for one day, empty when nothing was recorded."""
    days = await load_forecast_slots_for_window(
        hass, first_date=target_date, last_date=target_date
    )
    return days.get(target_date.isoformat(), {})


async def _load_timeline(
    hass: HomeAssistant,
    window_start: datetime,
    window_end: datetime,
) -> list[tuple[datetime, float]]:
    """(instant, W) pairs across the window, oldest first.

    ``include_start_time_state`` matters: a window opening mid-flat-stretch has
    no row of its own until the value next moves, and without the synthesised
    boundary state every slot before that move would read as missing.
    """
    recorder = get_instance(hass)
    if recorder is None:
        # No recorder instance: early setup, or a test standing the rest of the
        # integration up without one. No history to read is not an error.
        return []
    states_by_entity = await recorder.async_add_executor_job(
        partial(
            get_significant_states,
            hass,
            dt_util.as_utc(window_start),
            dt_util.as_utc(window_end),
            [SOLAR_FORECAST_CURRENT_ENTITY],
            include_start_time_state=True,
            significant_changes_only=False,
        )
    )
    states = _states_for_entity(states_by_entity)
    timeline: list[tuple[datetime, float]] = []
    for state in states:
        try:
            value_w = float(getattr(state, "state", None))
        except (TypeError, ValueError):
            continue
        stamp = getattr(state, "last_changed", None) or getattr(
            state, "last_updated", None
        )
        if stamp is None:
            continue
        timeline.append((dt_util.as_local(stamp), value_w))
    timeline.sort(key=lambda pair: pair[0])
    return timeline


def _states_for_entity(states_by_entity: Any) -> list[Any]:
    if not isinstance(states_by_entity, dict):
        return []
    return (
        states_by_entity.get(SOLAR_FORECAST_CURRENT_ENTITY)
        or states_by_entity.get(SOLAR_FORECAST_CURRENT_ENTITY.lower())
        or []
    )
