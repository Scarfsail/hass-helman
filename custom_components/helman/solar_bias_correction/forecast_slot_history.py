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

from dataclasses import dataclass, field
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

try:
    from ..recorder_statistics_span import (
        query_hourly_statistics,
        query_oldest_state_date,
    )
except Exception:  # pragma: no cover - Home Assistant API compatibility
    query_hourly_statistics = None  # type: ignore[assignment]
    query_oldest_state_date = None  # type: ignore[assignment]

#: The entity this module reads. Helman publishes it; see
#: ``HelmanSolarForecastCurrentSensor``.
SOLAR_FORECAST_CURRENT_ENTITY = "sensor.helman_solar_forecast_current"

_SLOT_MINUTES = 15
_SLOTS_PER_DAY = 24 * 60 // _SLOT_MINUTES
_SLOTS_PER_HOUR = 60 // _SLOT_MINUTES

#: What the statistics tail's ``mean`` is multiplied by to reach one slot's Wh.
#:
#: The rows come back from ``statistics_during_period`` converted to the unit
#: class's display unit, and :data:`~..recorder_statistics_span.STATISTICS_UNITS`
#: asks for kWh; the sensor records Wh. Both halves of that -- the ask and the
#: metadata's ``unit_class: "energy"`` -- have to hold for the factor to be
#: right, which is why ``test_solar_forecast_statistics_tail`` pins it against
#: what ``solar_forecast_backfill`` actually writes rather than asserting it
#: here.
_KWH_TO_WH = 1000.0


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


@dataclass(frozen=True)
class ForecastSlotWindow:
    """A window's recorded forecast, and which of its days are hour-grain.

    ``hourly_grain_dates`` is the honesty in the payload: for those days the
    four slots of an hour each carry a **quarter of the hour's forecast**, which
    is a weight rather than a measurement. Nothing here knows how the hour's
    energy was really distributed inside itself, and the readers must not read
    the quarters as if it did.
    """

    slots_by_date: dict[str, dict[str, float]]
    hourly_grain_dates: set[str] = field(default_factory=set)


async def load_spliced_forecast_slots_for_window(
    hass: HomeAssistant,
    *,
    first_date: date,
    last_date: date,
) -> ForecastSlotWindow:
    """The recorded forecast for a window deeper than ``purge_keep_days``.

    The sensor's raw states are what this module reads, and raw states are what
    the recorder purges -- eight days on the instance #173 was written from. A
    ninety-day training window would therefore find a forecast for eight of its
    days and, since a day with no forecast is no sample at all, train on eight.

    ``solar_forecast_backfill`` has been writing this same entity's hourly
    statistics since long before anything read them, precisely for this. So the
    tail comes from there: one wide statistics read for every day before the
    sensor's own states begin, and the existing per-slot state reader for every
    day after.

    **Where the two meet is probed, not assumed** --
    :func:`~..recorder_statistics_span.query_oldest_state_date`, the same probe
    the house window splices on, and the splice lands on the local midnight
    *after* the oldest state's date because states begin part-way through their
    first day.

    **What the tail's ``mean`` means.** The sensor's state is the *current
    slot's* energy in Wh, and the back-fill writes each hour's time-weighted
    mean of it. Four equal-length slots make up an hour, so that mean is the
    hour's average slot -- the hour's forecast energy is ``mean x 4``, and one
    slot's share of it is the mean itself. That is the whole conversion, and
    getting it wrong is invisible: a constant factor on every tail day's
    forecast, which the fit absorbs into factors that then misprice every future
    slot. The unit is the other half of it -- see :data:`_KWH_TO_WH`.

    **The quarters are weights, not shape.** Splitting the hour evenly is not a
    claim about within-hour production, and no reader may take it as one: it is
    what lets an hour's *one* ratio reach the four slots it covers with equal
    weight (#173's G3). ``hourly_grain_dates`` names every day it was done to.
    """
    if query_hourly_statistics is None or query_oldest_state_date is None:
        return ForecastSlotWindow(
            slots_by_date=await load_forecast_slots_for_window(
                hass, first_date=first_date, last_date=last_date
            )
        )
    if last_date < first_date:
        return ForecastSlotWindow(slots_by_date={})

    local_tz = ZoneInfo(str(hass.config.time_zone))
    oldest_state_date = await query_oldest_state_date(
        hass, SOLAR_FORECAST_CURRENT_ENTITY, local_tz=local_tz
    )
    # No raw state at all means the whole window is tail, which is the honest
    # reading of it rather than an error: the back-fill may still hold it.
    splice_date = (
        min(max(oldest_state_date + timedelta(days=1), first_date), last_date + timedelta(days=1))
        if oldest_state_date is not None
        else last_date + timedelta(days=1)
    )

    slots_by_date: dict[str, dict[str, float]] = {}
    hourly_grain_dates: set[str] = set()
    if splice_date > first_date:
        tail = await query_hourly_statistics(
            hass,
            [SOLAR_FORECAST_CURRENT_ENTITY],
            local_start=datetime.combine(first_date, time.min, tzinfo=local_tz),
            local_end=datetime.combine(splice_date, time.min, tzinfo=local_tz),
        )
        slots_by_date.update(
            _slots_from_hourly_rows(
                tail.rows_for(SOLAR_FORECAST_CURRENT_ENTITY), local_tz=local_tz
            )
        )
        hourly_grain_dates.update(slots_by_date)

    if splice_date <= last_date:
        slots_by_date.update(
            await load_forecast_slots_for_window(
                hass, first_date=splice_date, last_date=last_date
            )
        )

    return ForecastSlotWindow(
        slots_by_date=slots_by_date, hourly_grain_dates=hourly_grain_dates
    )


def _slots_from_hourly_rows(
    rows_by_utc_hour: dict[datetime, dict[str, Any]],
    *,
    local_tz: ZoneInfo,
) -> dict[str, dict[str, float]]:
    """Hourly statistics rows as the same ``{day: {"HH:MM": wh}}`` map.

    Rows are keyed by the hour's UTC instant, so the local date and hour are
    resolved per row rather than assumed -- and the autumn fall-back day's two
    01:00 hours are *added* into one set of slot keys rather than one silently
    replacing the other. The actuals side folds its repeated hour the same way,
    so the day's ratio is unchanged by the doubling; the slots of that one hour
    simply carry twice the weight of their neighbours.
    """
    days: dict[str, dict[str, float]] = {}
    for utc_hour, row in sorted(rows_by_utc_hour.items()):
        mean = row.get("mean")
        if mean is None:
            continue
        try:
            slot_wh = float(mean) * _KWH_TO_WH
        except (TypeError, ValueError):
            continue
        local_hour = utc_hour.astimezone(local_tz)
        slots = days.setdefault(local_hour.date().isoformat(), {})
        for index in range(_SLOTS_PER_HOUR):
            slot_key = f"{local_hour.hour:02d}:{index * _SLOT_MINUTES:02d}"
            slots[slot_key] = round(slots.get(slot_key, 0.0) + slot_wh, 4)
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
