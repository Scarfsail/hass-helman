"""Read the per-slot solar forecast back out of Helman's own forecast sensor.

``sensor.helman_solar_forecast_current`` publishes the raw forecast for the
slot in progress, in Wh, on the slot-aligned refresh beat. Its recorder history
is therefore a stair-step of what the provider said about each slot *while that
slot had not yet begun* — the measurement the bias trainer is fitted to. This
module turns that history back into ``HH:MM -> Wh`` maps, which is a regrouping
by day and slot rather than a conversion: the entity already carries the slot's
own energy.

Three things about the read are easy to get wrong, and each produces
plausible numbers rather than an error:

* **Prefer the slot's own write to a sampled instant.** The refresh fires at
  ``:00/:15/:30/:45`` but publishes at the *end* of a long rebuild, so how
  late the row lands is not knowable in advance. Taking the first numeric row
  inside the slot tolerates a slow write of up to a full slot, and still
  prefers the boundary write over the provider's mid-slot republications,
  which land later in the same slot and carry the revision this whole
  measurement exists to avoid.
* **Hold the last value forward when a slot has no row.** Home Assistant
  records a row only when the state actually changes — measured on this
  instance, a flat overnight stretch is one row for twelve slots. Treating a
  slot with no row of its own as missing would blank most of the night and
  every overcast hour.
* **Stop holding at an ``unavailable``.** Home Assistant writes one when the
  integration stops or the entity drops out, and carrying the last numeric
  value across that gap would mint forecast data for slots nothing was ever
  believed about — which the trainer would then fit to. A non-numeric row ends
  the hold; the next numeric one starts it again.

  A crash hard enough to leave no ``unavailable`` behind defeats this, because
  from the state history alone that gap is indistinguishable from a flat night.
  The residue is bounded by the day gates in the trainer rather than by
  anything here.

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
    standing: float | None = None
    day = first_date
    while day <= last_date:
        day_start = datetime.combine(day, time.min, tzinfo=local_tz)
        slots: dict[str, float] = {}
        for slot_index in range(_SLOTS_PER_DAY):
            slot_start = day_start + timedelta(minutes=slot_index * _SLOT_MINUTES)
            slot_end = slot_start + timedelta(minutes=_SLOT_MINUTES)
            # Everything before this slot only updates what is standing; an
            # ``unavailable`` among them clears it rather than being skipped.
            while cursor < len(timeline) and timeline[cursor][0] < slot_start:
                standing = timeline[cursor][1]
                cursor += 1
            # The slot's own writes. The first numeric one is the boundary
            # write, however late the rebuild published it; a republication
            # later in the same slot carries a revision and is passed over.
            slot_value: float | None = None
            while cursor < len(timeline) and timeline[cursor][0] < slot_end:
                value = timeline[cursor][1]
                if slot_value is None and value is not None:
                    slot_value = value
                standing = value
                cursor += 1
            resolved = slot_value if slot_value is not None else standing
            if resolved is None:
                continue
            slots[f"{slot_start.hour:02d}:{slot_start.minute:02d}"] = resolved
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
) -> list[tuple[datetime, float | None]]:
    """(instant, Wh or None) pairs across the window, oldest first.

    ``None`` is an ``unavailable`` or otherwise non-numeric row, kept rather
    than dropped so it can end a hold-forward instead of silently extending
    one across a stretch nothing was published in.

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
            # Only the state and its timestamp are read; this entity carries no
            # attributes worth materialising across a month of rows.
            no_attributes=True,
        )
    )
    states = _states_for_entity(states_by_entity)
    timeline: list[tuple[datetime, float | None]] = []
    for state in states:
        try:
            value_wh: float | None = float(getattr(state, "state", None))
        except (TypeError, ValueError):
            value_wh = None
        stamp = getattr(state, "last_updated", None) or getattr(
            state, "last_changed", None
        )
        if stamp is None:
            continue
        timeline.append((dt_util.as_local(stamp), value_wh))
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
