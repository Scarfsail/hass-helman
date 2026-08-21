"""Hourly long-term statistics for a span of days, in ONE recorder read.

The sibling :mod:`recorder_hourly_series` reads raw states, which is the right
grain for a single day: it sees every meter tick and can unwrap a counter that
resets at midnight. It is the wrong grain for a month or a year. A year of raw
state changes for a handful of fast-updating meters is millions of rows to end
up with a few hundred numbers, and rows -- not queries -- are what makes a wide
span unaffordable.

Home Assistant's hourly long-term statistics hold ~8760 rows per entity per year
and already carry everything an aggregate view needs: per-period energy, and the
min/max/mean of a measurement. This module is the one read that fetches them.

Three things about that API are easy to get wrong, and each of them produces
plausible-looking numbers rather than an error:

* ``StatisticsRow["sum"]`` is the meter's running total since its very first
  statistic, not the period's energy. The per-period delta is the separately
  requested ``"change"`` type, which is why :data:`STATISTICS_TYPES` asks for it.
  Never sum ``sum``.
* ``StatisticsRow["start"]`` and ``["end"]`` are POSIX ``float`` timestamps, not
  datetimes -- unlike every other recorder helper in this integration. This
  module converts them once, here, so no caller has to remember; and it converts
  through ``datetime.fromtimestamp`` rather than by dividing the timestamp, so
  a 25-hour local day keeps all twenty-five of its hours.
* ``change`` for the first row of the window is computed against a ``prev_sum``
  that defaults to zero when the recorder finds no earlier row -- so a window
  whose left edge has no statistic before it reads the meter's whole lifetime
  total as that hour's energy. :data:`_SEED_PAD` is the defence; see below.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

#: What a span read asks for. ``change`` is the per-hour energy of a cumulative
#: meter; ``min``/``max`` are the exact bounds of a measurement over the hour
#: (better than scanning raw states, which silently misses anything purged); and
#: ``mean`` is how a price sensor's hour is valued. One set for every entity in
#: the call: ``_extract_metadata_and_discard_impossible_columns`` ORs
#: ``has_mean``/``has_sum`` across the requested ids, so mixing sum-only meters
#: with mean/min/max sensors in one query is safe -- each row simply carries the
#: columns its own metadata supports.
STATISTICS_TYPES: set[str] = {"change", "min", "max", "mean"}

#: Displayed energy unit. Meters recorded in Wh come back converted, so every
#: ``change`` this module returns is in kWh regardless of how the meter records.
#: Non-energy statistics (a SoC percentage, a price) have no energy unit class
#: and pass through untouched.
STATISTICS_UNITS: dict[str, str] = {"energy": "kWh"}

#: How far before the window the query actually starts.
#:
#: ``_augment_result_with_change`` seeds its running ``prev_sum`` from the last
#: statistic *earlier* than ``start_time``, falling back to ``0`` when there is
#: none -- at which point the first returned row's ``change`` is its cumulative
#: ``sum``, i.e. the meter's entire life so far, dumped into the window's first
#: bucket. Asking for one extra hour and then discarding it moves that risk onto
#: a row nobody folds: rows after the first have their ``change`` computed
#: against the previous row's ``sum`` and are correct by construction. It costs
#: one row per entity and keeps the read at one query.
_SEED_PAD = timedelta(hours=1)


async def query_hourly_statistics(
    hass: HomeAssistant,
    statistic_ids: Sequence[str | None],
    *,
    local_start: datetime,
    local_end: datetime,
) -> dict[str, dict[datetime, dict[str, Any]]]:
    """Every entity's hourly statistics over ``[local_start, local_end)``, in one call.

    ``statistic_ids`` may contain ``None`` and duplicates -- unconfigured meters
    and providers that returned nothing are the normal case, and dropping them
    here keeps every call site from repeating the filter.

    Returns ``{statistic_id: {utc_hour_start: row}}``. The keys are UTC instants,
    and deliberately not local ones: Python compares two aware datetimes that
    share a ``tzinfo`` object by their wall clock alone, so the autumn fall-back
    day's repeated local hour would collide into a single key and silently drop
    an hour of energy. Callers convert to local time when they fold -- once per
    row, on the instant, which is where the local date has to be decided anyway.
    An entity the recorder has nothing for maps to ``{}`` rather than going
    missing.

    ``statistics_during_period`` is synchronous and touches the database, so it
    runs on the recorder's own executor.

    ``period="hour"`` is deliberate even when the caller wants days or months:
    ``_statistics_during_period_with_session`` always selects the hourly table
    and reduces in Python, so a coarser period pushes no work into SQL -- it only
    throws away the resolution that pricing energy per hour needs.
    """
    unique_ids = list(dict.fromkeys(sid for sid in statistic_ids if sid))
    if not unique_ids or local_end <= local_start:
        return {statistic_id: {} for statistic_id in unique_ids}

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

    by_entity: dict[str, dict[datetime, dict[str, Any]]] = {
        statistic_id: {} for statistic_id in unique_ids
    }
    for statistic_id, rows in (raw or {}).items():
        folded = by_entity.setdefault(statistic_id, {})
        for row in rows or []:
            start = row.get("start")
            if start is None:
                continue
            utc_hour = datetime.fromtimestamp(start, tz=timezone.utc)
            # The padded hour exists only to seed ``change``; counting it would
            # attribute energy from before the span to the span's first bucket.
            # The bounds are local-aware datetimes, which compare against a UTC
            # one on the instant -- the comparison a window edge means.
            if utc_hour < local_start or utc_hour >= local_end:
                continue
            folded[utc_hour] = row
    return by_entity
