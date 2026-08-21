"""Hourly long-term statistics for a span of days, in ONE recorder read.

The sibling :mod:`recorder_hourly_series` reads raw states, which is the right
grain for a single day: it sees every meter tick and can unwrap a counter that
resets at midnight. It is the wrong grain for a month or a year. A year of raw
state changes for a handful of fast-updating meters is millions of rows to end
up with a few hundred numbers, and rows -- not queries -- are what makes a wide
span unaffordable.

Home Assistant's hourly long-term statistics hold ~8760 rows per entity per year
and already carry everything an aggregate view needs: the meter reading at each
hour's end, and the min/max/mean of a measurement. This module is the one read
that fetches them.

Three things about that API are easy to get wrong, and each of them produces
plausible-looking numbers rather than an error:

* **``change`` is not trustworthy for a meter that ever glitches, and this
  module therefore does not use it.** ``change`` is derived from ``sum``, and
  ``sum`` is maintained by the statistics compiler's own reset detection: a
  ``total_increasing`` sensor that goes briefly unavailable and returns reads as
  a counter reset, so the compiler adds the meter's *entire lifetime total* into
  that hour. Observed on a real inverter feed, where one hour's ``change`` came
  back as 49202.5 kWh -- exactly the meter's lifetime reading -- against
  neighbouring hours of 2-6 kWh, and one hour carried two such resets at once.
  ``StatisticsRow["sum"]`` is corrupted by the same accounting and is no safer.
  Per-hour energy here is instead the difference between consecutive
  ``state`` readings, run through
  :func:`~.recorder_hourly_series.unwrap_cumulative_energy_series` so that this
  integration applies one reset convention everywhere -- the same one the raw
  state path applies, including its transient-drop suppression.
* ``StatisticsRow["start"]`` and ``["end"]`` are POSIX ``float`` timestamps, not
  datetimes -- unlike every other recorder helper in this integration. This
  module converts them once, here, so no caller has to remember; and it converts
  through ``datetime.fromtimestamp`` rather than by dividing the timestamp, so
  a 25-hour local day keeps all twenty-five of its hours.
* A window's first hour has no predecessor to difference against, so its energy
  would simply be missing. :data:`_SEED_PAD` is the defence: the query starts one
  hour early, that hour seeds the first real delta, and it is never folded into a
  bucket itself.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

#: What a span read asks for.
#:
#: ``state`` is the meter reading at the hour's end, from which energy is
#: differenced; ``min``/``max`` are the exact bounds of a measurement over the
#: hour (better than scanning raw states, which silently misses anything purged);
#: and ``mean`` is how a price sensor's hour is valued. ``change`` and ``sum`` are
#: deliberately absent -- see this module's docstring. One set for every entity in
#: the call: ``_extract_metadata_and_discard_impossible_columns`` ORs
#: ``has_mean``/``has_sum`` across the requested ids, so mixing sum-only meters
#: with mean/min/max sensors in one query is safe -- each row simply carries the
#: columns its own metadata supports.
STATISTICS_TYPES: set[str] = {"state", "min", "max", "mean"}

#: Displayed energy unit. Meters recorded in Wh come back converted, so every
#: energy figure this module returns is in kWh regardless of how the meter
#: records. Non-energy statistics (a SoC percentage, a price) have no energy unit
#: class and pass through untouched.
STATISTICS_UNITS: dict[str, str] = {"energy": "kWh"}

#: How far before the window the query actually starts.
#:
#: Energy is the difference between consecutive hourly meter readings, so the
#: window's first hour needs the reading that precedes it or it has no delta at
#: all. One extra hour per entity supplies exactly that, at the cost of one row,
#: and it is dropped before anything is folded into a bucket.
_SEED_PAD = timedelta(hours=1)


@dataclass(frozen=True)
class SpanStatistics:
    """One span read's results, already split by how each column must be used.

    ``rows`` and ``energy_kwh`` are separate because they answer different
    questions and carry different hazards: a row's ``min``/``max``/``mean``
    describe the hour on their own, while energy only exists as a difference
    between two hours and has to survive a meter reset in between. Keeping the
    derivation here means no caller can reach for the raw cumulative columns and
    get it wrong.

    Both maps are keyed by statistic id, then by the hour's **UTC** instant --
    deliberately not a local one, because Python compares two aware datetimes
    that share a ``tzinfo`` object by their wall clock alone, so the autumn
    fall-back day's repeated local hour would collide into a single key and
    silently drop an hour. Callers convert to local time when they fold, which is
    where the local date has to be decided anyway.
    """

    #: ``{statistic_id: {utc_hour_start: row}}``, the padded hour excluded.
    rows: dict[str, dict[datetime, dict[str, Any]]]
    #: ``{statistic_id: {utc_hour_start: kwh}}``, energy accumulated *during*
    #: that hour, the padded hour excluded.
    energy_kwh: dict[str, dict[datetime, float]]

    def rows_for(self, statistic_id: str | None) -> dict[datetime, dict[str, Any]]:
        """One entity's hourly rows, or an empty map for an unconfigured one."""
        if not statistic_id:
            return {}
        return self.rows.get(statistic_id) or {}

    def energy_for(self, statistic_id: str | None) -> dict[datetime, float]:
        """One entity's hourly energy, or an empty map for an unconfigured one."""
        if not statistic_id:
            return {}
        return self.energy_kwh.get(statistic_id) or {}


async def query_hourly_statistics(
    hass: HomeAssistant,
    statistic_ids: Sequence[str | None],
    *,
    local_start: datetime,
    local_end: datetime,
) -> SpanStatistics:
    """Every entity's hourly statistics over ``[local_start, local_end)``, in one call.

    ``statistic_ids`` may contain ``None`` and duplicates -- unconfigured meters
    and providers that returned nothing are the normal case, and dropping them
    here keeps every call site from repeating the filter. An entity the recorder
    has nothing for maps to an empty map rather than going missing.

    ``statistics_during_period`` is synchronous and touches the database, so it
    runs on the recorder's own executor.

    ``period="hour"`` is deliberate even when the caller wants days or months:
    ``_statistics_during_period_with_session`` always selects the hourly table
    and reduces in Python, so a coarser period pushes no work into SQL -- it only
    throws away the resolution that pricing energy per hour needs.
    """
    unique_ids = list(dict.fromkeys(sid for sid in statistic_ids if sid))
    empty = SpanStatistics(
        rows={statistic_id: {} for statistic_id in unique_ids},
        energy_kwh={statistic_id: {} for statistic_id in unique_ids},
    )
    if not unique_ids or local_end <= local_start:
        return empty

    utc_start = dt_util.as_utc(local_start) - _SEED_PAD
    utc_end = dt_util.as_utc(local_end)

    def _query() -> dict[str, list[dict[str, Any]]]:
        return statistics_during_period(
            hass,
            utc_start,
            utc_end,
            set(unique_ids),
            "hour",
            STATISTICS_UNITS,
            STATISTICS_TYPES,
        )

    raw = await get_instance(hass).async_add_executor_job(_query)

    rows: dict[str, dict[datetime, dict[str, Any]]] = {
        statistic_id: {} for statistic_id in unique_ids
    }
    energy: dict[str, dict[datetime, float]] = {
        statistic_id: {} for statistic_id in unique_ids
    }
    for statistic_id, entity_rows in (raw or {}).items():
        by_hour: dict[datetime, dict[str, Any]] = {}
        for row in entity_rows or []:
            start = row.get("start")
            if start is None:
                continue
            by_hour[datetime.fromtimestamp(start, tz=timezone.utc)] = row

        rows[statistic_id] = {
            utc_hour: row
            for utc_hour, row in by_hour.items()
            if local_start <= utc_hour < local_end
        }
        energy[statistic_id] = _hourly_energy_kwh(
            by_hour, local_start=local_start, local_end=local_end
        )

    return SpanStatistics(rows=rows, energy_kwh=energy)


def _hourly_energy_kwh(
    by_hour: dict[datetime, dict[str, Any]],
    *,
    local_start: datetime,
    local_end: datetime,
) -> dict[datetime, float]:
    """Energy accumulated during each in-window hour, from the meter readings.

    The reading stamped on an hour is the meter's value at that hour's end, so
    the energy *of* an hour is its reading minus the previous one -- which is why
    the query is padded by an hour and why the pad is only dropped here, after it
    has served as the first delta's left-hand side.

    The readings are unwrapped first, so a counter that resets mid-span lifts the
    rest of the series instead of producing one enormous negative step. A gap in
    the statistics -- Home Assistant down for a day -- leaves the energy that
    accumulated across it attributed to the first hour that reports again, which
    is what a cumulative meter genuinely tells us and what the raw state path
    does with the same gap.

    Hours whose reading is missing are skipped rather than treated as zero: a
    meter with no reading has not told us it produced nothing.
    """
    from .recorder_hourly_series import unwrap_cumulative_energy_series

    samples: list[tuple[datetime, float]] = []
    for utc_hour, row in by_hour.items():
        value = row.get("state")
        if value is None:
            continue
        try:
            samples.append((utc_hour, float(value)))
        except (TypeError, ValueError):
            continue
    if len(samples) < 2:
        return {}

    unwrapped = unwrap_cumulative_energy_series(samples)

    energy: dict[datetime, float] = {}
    previous_value: float | None = None
    for utc_hour, value in unwrapped:
        if previous_value is not None and local_start <= utc_hour < local_end:
            energy[utc_hour] = value - previous_value
        previous_value = value
    return energy
