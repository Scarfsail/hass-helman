"""One day's measured series read from long-term statistics instead of raw states.

The day view's ordinary source is raw recorder states, at fifteen minutes. The
recorder purges those at ``purge_keep_days``, while the hourly long-term
statistics the month and year views read are kept indefinitely -- so there is a
wide band of days that draw fine as a bar in an aggregate view and had nothing
at all to show when opened. This module is that band's source: the same
:func:`~..recorder_statistics_span.query_hourly_statistics` read the span views
already use, aimed at a single day and shaped so the day view's existing
mapping code cannot tell where the numbers came from.

Two design points carry the whole module.

**Everything a caller gets back is already in the shape the raw path produced.**
The cumulative meters come back as ``{entity_id: {utc_slot_start: kwh}}`` --
byte-identical in shape to
``_load_slot_energy_kwh_for_entities``, only with hour starts where that has
quarter-hour starts -- so ``_load_house_actual_for_date``,
``_load_grid_actual_for_date``, ``_load_battery_actual_for_date`` and the
consumer breakdown all work unchanged. The four series that are not meter
energy come back as the same lists of dicts their own loaders returned. Nothing
downstream of the caller learns that a day was drawn at sixty minutes rather
than fifteen; only the payload's ``dataGranularityMinutes`` says so, and only
because the chart has to be told what width to draw.

**One read, not one per series.** The recorder serves from a single executor
thread, so a query per meter is a serial round-trip per meter however the awaits
are arranged -- the same reasoning the span read and the batched slot-energy
read are both built on. Every id the day needs goes into one call.

A statistics-only day still comes back without its solar forecast, and the
reason has changed rather than gone away. It used to be that the curve lived
in the daily-energy entity's ``wh_period_15m`` attribute and attributes are
never compiled into statistics. Helman now publishes the curve as an entity
of its own (``sensor.helman_solar_forecast_current``), which the recorder
does compile -- but ``load_archived_forecast_points`` reads that entity's
*raw states*, and a day is statistics-only precisely because its raw states
are gone. So the day is still an actuals day: what happened, without the
forecast it was compared against.

#173 is what closes this, by teaching the readers to splice a states window
with a statistics tail. Until then the back-filled statistics
(``solar_forecast_backfill``) are written and unread.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
import logging
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

#: The width of one statistics row, and therefore of every point this module
#: emits. Named rather than repeated so the payload's granularity field and the
#: arithmetic that turns a mean power into an energy stay the same number.
HOUR_MINUTES = 60


@dataclass(frozen=True)
class StatisticsDay:
    """One day's measured series, in the shapes the raw-state path returns.

    Empty everywhere is a valid answer and the one a failed read produces: a day
    the recorder has no statistics for draws nothing, exactly as a purged day
    drew nothing before this module existed.
    """

    #: ``{entity_id: {utc_hour_start: kwh}}`` for every cumulative meter asked
    #: for -- the house, both grid sides, both battery sides and one per house
    #: consumer. Same shape as the batched raw read, one hour wide.
    energy_kwh_by_entity: dict[str, dict[datetime, float]] = field(default_factory=dict)
    #: Solar actuals as ``{"HH:MM": wh}``, the shape ``load_actuals_for_day``
    #: returns.
    solar_actuals_by_slot: dict[str, float] = field(default_factory=dict)
    #: ``[{"slot": "HH:MM", "pct": float}]``, the hour's mean state of charge.
    battery_soc_points: list[dict] = field(default_factory=list)
    #: ``[{"timestamp": iso_local, "wh": float}]`` for the house forecast.
    house_forecast_points: list[dict] = field(default_factory=list)
    #: ``[{"slot": "HH:MM", "value": float}]`` per rail.
    import_price_points: list[dict] = field(default_factory=list)
    export_price_points: list[dict] = field(default_factory=list)


async def load_statistics_day(
    hass: HomeAssistant,
    target_date: date,
    *,
    local_tz: ZoneInfo,
    solar_entity_id: str | None,
    meter_entity_ids: list[str],
    battery_soc_entity_id: str | None,
    house_forecast_entity_id: str,
    import_price_entity_id: str | None,
    export_price_entity_id: str | None,
    export_price_fallback_entity_id: str | None,
) -> StatisticsDay:
    """Every measured series the day view draws, from one statistics read.

    ``meter_entity_ids`` is the caller's own cumulative-meter roster -- the same
    list the raw path batches -- and comes back keyed by entity id whether or not
    the recorder had anything for it, so the caller's ``.get(entity_id) or {}``
    lookups behave as they always did.

    The export rate comes from two entities rather than one -- Helman's own
    mirror and the configured sell-price entity, resolved hour by hour because
    the seam between them falls mid-history. The import rail needs no fallback:
    the config fill the caller applies afterwards covers every hour it missed.

    No ``tail_start``: a day old enough to be read from statistics is by
    definition fully compiled, so there is no hour in progress to top up from the
    short-term table.
    """
    from ..recorder_statistics_span import (
        SpanStatistics,
        prefer_rows,
        query_hourly_statistics,
    )

    local_start = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
    local_end = local_start + timedelta(days=1)
    try:
        span = await query_hourly_statistics(
            hass,
            [
                solar_entity_id,
                *meter_entity_ids,
                battery_soc_entity_id,
                house_forecast_entity_id,
                import_price_entity_id,
                export_price_entity_id,
                export_price_fallback_entity_id,
            ],
            local_start=local_start,
            local_end=local_end,
        )
    except Exception:
        _LOGGER.exception("Failed to load statistics for inspector day %s", target_date)
        span = SpanStatistics(rows={}, energy_kwh={})

    return StatisticsDay(
        energy_kwh_by_entity={
            entity_id: span.energy_for(entity_id) for entity_id in meter_entity_ids
        },
        solar_actuals_by_slot=_energy_wh_by_slot(
            span.energy_for(solar_entity_id), target_date
        ),
        battery_soc_points=[
            {"slot": slot, "pct": value}
            for slot, value in _mean_by_slot(
                span.rows_for(battery_soc_entity_id), target_date
            ).items()
        ],
        house_forecast_points=_house_forecast_points(
            span.rows_for(house_forecast_entity_id), target_date
        ),
        import_price_points=_rail_points(
            span.rows_for(import_price_entity_id), target_date
        ),
        export_price_points=_rail_points(
            # The same hour-by-hour resolution the span aggregates apply to
            # the export rate, from the same helper: the seam between Helman's
            # mirror and the configured sell-price entity falls mid-history.
            prefer_rows(
                span.rows_for(export_price_entity_id),
                span.rows_for(export_price_fallback_entity_id),
            ),
            target_date,
        ),
    )


def _local_hours(
    rows_by_utc_hour: dict[datetime, Any], target_date: date
) -> list[tuple[datetime, Any]]:
    """The day's hours in order, as ``(local_hour_start, value)``.

    Keyed by UTC on the way in and filtered by *local* date on the way out, which
    is the only ordering that survives a 25-hour day: the autumn fall-back hour
    occurs twice with one local wall clock, and two entries keyed by that clock
    would have collapsed into one before anything could add them up.
    """
    hours: list[tuple[datetime, Any]] = []
    for utc_hour, value in sorted(rows_by_utc_hour.items()):
        local_hour = dt_util.as_local(utc_hour)
        if local_hour.date() != target_date:
            continue
        hours.append((local_hour, value))
    return hours


def _energy_wh_by_slot(
    energy_kwh_by_utc_hour: dict[datetime, float], target_date: date
) -> dict[str, float]:
    """Hourly kWh as ``{"HH:MM": wh}``, accumulating a repeated local hour.

    ``+=`` rather than assignment for the fall-back day's twice-lived hour: both
    occurrences really happened and both metered energy, so the label they share
    carries their sum. That is the same convention ``_money_points`` documents
    for the 15-minute grid, applied to the coarser one.
    """
    by_slot: dict[str, float] = {}
    for local_hour, kwh in _local_hours(energy_kwh_by_utc_hour, target_date):
        slot = local_hour.strftime("%H:%M")
        by_slot[slot] = by_slot.get(slot, 0.0) + kwh * 1000.0
    return by_slot


def _mean_of(row: Any) -> float | None:
    """A statistics row's ``mean`` as a float, or ``None`` for a row without one.

    A row can arrive present but empty -- the span read emits one for an hour it
    folded short-term rows onto whether or not any carried a mean -- so presence
    is not a reading.
    """
    if not isinstance(row, dict):
        return None
    value = row.get("mean")
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _mean_by_slot(
    rows_by_utc_hour: dict[datetime, Any], target_date: date
) -> dict[str, float]:
    """Hourly means as ``{"HH:MM": mean}``, the later occurrence winning a tie.

    Last-wins rather than the sum ``_energy_wh_by_slot`` takes, because a mean is
    a level and not a quantity: two readings of the same clock hour do not add
    up, and the newer one is the one the raw path's hold-forward sampler would
    also have landed on.
    """
    by_slot: dict[str, float] = {}
    for local_hour, row in _local_hours(rows_by_utc_hour, target_date):
        mean = _mean_of(row)
        if mean is None:
            continue
        by_slot[local_hour.strftime("%H:%M")] = mean
    return by_slot


def _house_forecast_points(
    rows_by_utc_hour: dict[datetime, Any], target_date: date
) -> list[dict]:
    """The house forecast sensor's hourly mean W as the hour's Wh.

    The sensor publishes power, so an hour's mean W *is* that hour's Wh -- no
    scaling, which is the one arithmetic the raw path has to do (W times a
    quarter hour) and this one does not.
    """
    points: list[dict] = []
    for local_hour, row in _local_hours(rows_by_utc_hour, target_date):
        mean_w = _mean_of(row)
        if mean_w is None:
            continue
        points.append({"timestamp": local_hour.isoformat(), "wh": mean_w})
    return points


def _rail_points(
    rows_by_utc_hour: dict[datetime, Any], target_date: date
) -> list[dict]:
    """A price rail's hourly mean, held across the four slots of its hour.

    Held forward rather than emitted at ``HH:00`` alone, because the caller fills
    whatever the rail leaves empty from the configured import windows: a rail
    with holes at ``:15``, ``:30`` and ``:45`` would come back showing the
    recorded rate on the hour and the configured tariff between the hours, three
    quarters of a rail that never existed. A rate applies across its hour, so
    stating it across its hour is what the data actually says.
    """
    points: list[dict] = []
    for local_hour, row in _local_hours(rows_by_utc_hour, target_date):
        mean = _mean_of(row)
        if mean is None:
            continue
        for offset in range(0, HOUR_MINUTES, 15):
            points.append(
                {
                    "slot": (local_hour + timedelta(minutes=offset)).strftime("%H:%M"),
                    "value": mean,
                }
            )
    return points
