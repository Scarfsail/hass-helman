"""Hourly long-term statistics for a span of days, in one recorder read plus a tail.

The sibling :mod:`recorder_hourly_series` reads raw states, which is the right
grain for a single day: it sees every meter tick and can unwrap a counter that
resets at midnight. It is the wrong grain for a month or a year. A year of raw
state changes for a handful of fast-updating meters is millions of rows to end
up with a few hundred numbers, and rows -- not queries -- are what makes a wide
span unaffordable.

Home Assistant's hourly long-term statistics hold ~8760 rows per entity per year
and already carry everything an aggregate view needs: the meter reading at each
hour's end, and the min/max/mean of a measurement. This module is the one read
that fetches them -- and, in :func:`query_oldest_statistics_date`, the one that
asks the same table how far back it goes, so that a history view's floor is the
data rather than a guess made elsewhere.

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
  integration applies one reset convention everywhere rather than inheriting a
  second one from the statistics compiler. That function's glitch suppression is
  sized for the samples it is given, which is why :data:`_REBOUND_WINDOW` is
  passed explicitly here: on hourly samples the raw-state default could never
  fire, and a single dipped reading would rebuild the very artefact this
  module exists to avoid.
* ``StatisticsRow["start"]`` and ``["end"]`` are POSIX ``float`` timestamps, not
  datetimes -- unlike every other recorder helper in this integration. This
  module converts them once, here, so no caller has to remember; and it converts
  through ``datetime.fromtimestamp`` rather than by dividing the timestamp, so
  a 25-hour local day keeps all twenty-five of its hours.
* A window's first hour has no predecessor to difference against, so its energy
  would simply be missing. :data:`_SEED_PAD` is the defence: the query starts one
  hour early, that hour seeds the first real delta, and it is never folded into a
  bucket itself.

One more thing about the *newest* hours, which is why this module is one read
plus a short second one rather than the single read it started as. Long-term
statistics only exist for hours that have both ended and been compiled, so the
bucket in progress is short by up to ~2 hours -- measured on a live instance at
13:54 local, the newest hourly reading was stamped 12:00, with 4.7 kWh of solar
missing from the day's column. Just after midnight the current day has no
completed hour at all and would read as a gap, and these views are history-only,
so nothing draws in its place. ``statistics_during_period`` serves the
short-term table on ``period="5minute"`` with the same ``state`` column, so
:data:`TAIL_PERIOD` is the same read, the same unwrap and the same differencing
against a finer table -- not a second data source. The tail rows are folded onto
their containing hour and merged in *before* energy is differenced, so nothing
downstream learns that the split happened: :class:`SpanStatistics` keeps its
shape and its hourly keys.

This module also owns the other direction, in
:func:`query_spliced_hourly_energy`: a window deeper than ``purge_keep_days``,
served from the statistics table where the raw states have been purged and from
the raw states where they survive. It belongs here because the splice is this
module's read joined to its sibling's, and because the seam is a question about
statistics keys -- see that function for where the two meet and why.

:func:`query_oldest_state_date` is the small read both of those joins hang on
-- where an entity's raw states begin -- and it is cached here, per entity, for
the same six hours the service layer trusts its own history floor. Every caller
passes through it, which is the point: the recorder answers from one database
thread, so a probe re-issued per view is a serial round trip in front of the
read that view came for.

:func:`query_price_history` is the same join made for *rates* rather than
meters, and it is the single reader every historical price in this integration
goes through. A rate needs neither differencing nor a whole-day seam, so the two
tiers meet wherever the data does: raw states wherever they exist, the
containing hour's ``mean`` for every slot they do not.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone, tzinfo
import logging
import math
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .recorder_hourly_series import query_cumulative_hourly_energy_changes

_LOGGER = logging.getLogger(__name__)

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

#: How long a dipped hourly reading has to climb back before it is called a
#: glitch rather than a counter reset.
#:
#: One hour, because that is the spacing of the samples: the meter blinking
#: unavailable and returning shows up as one low reading with a normal one an
#: hour later, and the suppression has to be able to see that neighbour. The
#: raw-state default of thirty minutes is shorter than the interval and would
#: silently classify every such blink as a reset, lifting the rest of the series
#: by the meter's whole reading -- the artefact, rebuilt on the path meant to
#: avoid it. A genuine reset is unaffected: a meter that restarts at zero does
#: not climb back past its old total within the hour.
_REBOUND_WINDOW = timedelta(hours=1)

#: How far back the history probe starts looking.
#:
#: The Unix epoch, because "as far back as anything could possibly go" is the
#: only honest answer -- the probe's whole job is to find out where the data
#: begins, so any tighter guess would be the very assumption it exists to
#: replace. Widening the window costs nothing by itself: what bounds the read is
#: how many rows the entities actually own, not how far back it reaches.
#:
#: Those rows are not free, though, and the comment would be dishonest if it
#: stopped there. ``statistics_during_period`` reduces *after* fetching, so a
#: month-period read still selects every hourly row in range and builds a dict
#: per row before collapsing them -- on six meters and five years, a few hundred
#: thousand of each, on the recorder's executor thread. That is the price of the
#: only honest answer, it is paid once per :data:`_HISTORY_FLOOR_TTL` rather
#: than per request, and it is the same order as the read a year view already
#: performs every time it opens. If it ever proves too much on a small host, the
#: fix is to probe fewer meters -- not to guess a shallower epoch.
_HISTORY_PROBE_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

#: How long one entity's raw-coverage answer is trusted before it is asked again.
#:
#: The same six hours :data:`~.solar_bias_correction.service._HISTORY_FLOOR_TTL`
#: gives the same class of question, and for the same reason: where an entity's
#: raw states begin moves only when a purge trims the far end or a back-fill
#: extends it, and neither is urgent. What the TTL buys is that the probe stops
#: being a round trip per request. It is one indexed row, but the recorder serves
#: every query from a single database thread, so issuing it again on every
#: inspector day open and every span read queues behind -- and in front of -- the
#: reads those views actually came for.
_OLDEST_STATE_TTL = timedelta(hours=6)

#: How long a *failed* probe is left alone before it is tried again.
#:
#: A failure is not an answer, so it must not pin one for six hours: a moment's
#: unavailability would otherwise leave every caller behaving as though the
#: entity's coverage were whatever the failure made it look like. Nor is it free
#: to retry immediately -- a recorder failing under load would be asked again by
#: every request, on the one executor thread the views' own reads queue behind.
#: Five minutes is the same compromise, and the same number, the history floor
#: draws in :data:`~.solar_bias_correction.service._HISTORY_FLOOR_RETRY`.
_OLDEST_STATE_RETRY = timedelta(minutes=5)

#: Where the probe cache lives inside ``hass.data[DOMAIN]``.
#:
#: Not a module global: this integration's per-instance state hangs off
#: ``hass.data`` under its domain key, and a global would outlive the config
#: entry that populated it -- a reload would inherit a stale set of answers with
#: nothing left to invalidate them. :func:`clear_oldest_state_probe_cache` is
#: what unloading calls, next to the coordinator it drops.
_OLDEST_STATE_CACHE_KEY = "oldest_state_probes"


@dataclass
class _OldestStateProbe:
    """One entity's cached raw-coverage answer, and how it was arrived at.

    ``instant`` is deliberately the raw ``datetime`` rather than the local date
    the caller asked for: the date depends on the caller's ``local_tz`` and the
    instant does not, so caching the instant means two callers in different
    zones cannot be served each other's rounding.

    ``error`` is the other half of "a failure is not an answer". Without it a
    failed probe would have to cache *something*, and the only value available
    is ``None`` -- which already means "this entity has no raw states at all",
    the most consequential answer here since it is what skips the raw read
    entirely. Holding the exception instead keeps the two apart and preserves
    this function's contract: a failure reaches the caller as a raised
    exception, just without a round trip behind it, until
    :data:`_OLDEST_STATE_RETRY` has passed -- unless an answer was learned
    earlier, which outlives the blip and is served in its place.
    """

    #: The oldest raw state's instant, or ``None`` for "there are none".
    instant: datetime | None = None
    #: Whether ``instant`` is an answer at all. ``None`` is a real answer here
    #: and the field's initial value both, so the two need telling apart before
    #: a remembered answer can stand in for a later failure.
    answered: bool = False
    #: The last probe's failure, re-raised until the retry window elapses and
    #: only while nothing better has ever been learned.
    error: BaseException | None = None
    #: When the last attempt was made; ``None`` for "never asked".
    probed_at: datetime | None = None
    #: How long that attempt's outcome is trusted for.
    lifetime: timedelta = _OLDEST_STATE_TTL
    #: Held across the probe so concurrent callers await one read rather than
    #: racing it. A day open asks about several entities at once and the price
    #: reader asks about two of them together.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def is_stale(self, now: datetime) -> bool:
        if self.probed_at is None:
            return True
        return now - self.probed_at >= self.lifetime


def _oldest_state_probes(hass: HomeAssistant) -> dict[str, _OldestStateProbe]:
    """The probe cache for this Home Assistant instance, created on first use."""
    return hass.data.setdefault(DOMAIN, {}).setdefault(_OLDEST_STATE_CACHE_KEY, {})


def clear_oldest_state_probe_cache(hass: HomeAssistant) -> None:
    """Forget every cached answer, so a reload starts from the recorder again."""
    hass.data.get(DOMAIN, {}).pop(_OLDEST_STATE_CACHE_KEY, None)


#: The recorder period that serves the short-term statistics table.
#:
#: Same function, same ``state`` column, same five-minute rows the energy
#: dashboard's "today" figure is built from. Rows here are purged on
#: ``purge_keep_days`` (~10 days by default), which is exactly the recent end
#: where the tail needs them; everything older is only ever asked of the hourly
#: table.
TAIL_PERIOD = "5minute"

#: How far back from now the tail read is allowed to reach.
#:
#: The tail exists to fill hours the hourly compiler has not produced yet, and
#: those are always the last one or two. A caller naming the newest *bucket* --
#: the current month, say -- would otherwise ask for ~9000 five-minute rows per
#: entity to fix two hours, so the requested start is clamped to this window
#: before the query is issued. Six hours is generous against the ~2-hour worst
#: case observed, and still cheap: ~72 rows per entity.
_MAX_TAIL_SPAN = timedelta(hours=6)


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
    tail_start: datetime | None = None,
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

    ``tail_start`` names the local instant from which the hourly table cannot be
    trusted to be complete -- in practice the start of the bucket in progress.
    Pass it only when the window actually reaches the present; a span entirely in
    the past is fully compiled and costs no second query. It is clamped to
    :data:`_MAX_TAIL_SPAN` and floored to the hour, and the rows it brings back
    *fill* hours the hourly read had nothing for rather than replacing hours it
    did. A compiled hour is complete by construction, while the tail's view of it
    depends on the short-term table being equally intact, so there is nothing to
    win by overwriting and a ragged edge to lose by it.
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

    def _query(
        window_start: datetime, window_end: datetime, period: str
    ) -> dict[str, list[dict[str, Any]]]:
        return statistics_during_period(
            hass,
            window_start,
            window_end,
            set(unique_ids),
            period,
            STATISTICS_UNITS,
            STATISTICS_TYPES,
        )

    executor = get_instance(hass).async_add_executor_job
    raw = await executor(_query, utc_start, utc_end, "hour")

    utc_tail_start = _tail_window_start(tail_start, utc_end)
    tail_by_hour: dict[str, dict[datetime, dict[str, Any]]] = {}
    if utc_tail_start is not None:
        raw_tail = await executor(_query, utc_tail_start, utc_end, TAIL_PERIOD)
        for statistic_id, entity_rows in (raw_tail or {}).items():
            tail_by_hour[statistic_id] = _fold_to_hours(entity_rows or [])

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

        # Fill, never overwrite -- see the docstring. Merging here, before the
        # energy differencing below, is what keeps the tail invisible: the hour
        # in progress becomes an ordinary reading that the previous compiled
        # hour is differenced against, so the two tables telescope instead of
        # meeting at a seam somebody downstream would have to reason about.
        for utc_hour, row in tail_by_hour.pop(statistic_id, {}).items():
            by_hour.setdefault(utc_hour, row)

        rows[statistic_id] = {
            utc_hour: row
            for utc_hour, row in by_hour.items()
            if local_start <= utc_hour < local_end
        }
        energy[statistic_id] = _hourly_energy_kwh(
            by_hour, local_start=local_start, local_end=local_end
        )

    # An entity whose hourly table is empty -- one that started reporting within
    # the tail window -- never entered the loop above, so its tail rows are still
    # sitting here.
    for statistic_id, by_hour in tail_by_hour.items():
        if statistic_id not in rows:
            continue
        rows[statistic_id] = {
            utc_hour: row
            for utc_hour, row in by_hour.items()
            if local_start <= utc_hour < local_end
        }
        energy[statistic_id] = _hourly_energy_kwh(
            by_hour, local_start=local_start, local_end=local_end
        )

    return SpanStatistics(rows=rows, energy_kwh=energy)


async def query_spliced_hourly_energy(
    hass: HomeAssistant,
    entity_ids: Sequence[str | None],
    *,
    local_start: datetime,
    local_end: datetime,
) -> dict[str, dict[datetime, float]]:
    """Hourly energy over a window that outlives the raw states, per entity.

    Same shape as :func:`~.recorder_hourly_series.query_cumulative_hourly_energy_changes`
    -- ``{hour_start: kwh}``, keyed by the hour's UTC instant -- for callers that
    ask for more history than ``purge_keep_days`` leaves behind. A trainer
    configured for 56 days reads eight from raw states on a stock recorder and
    calls the result "not enough history", while the same entity's hourly
    long-term statistics still hold every one of the other forty-eight (issue
    #173). This splices the two: statistics for the tail, raw states for the
    recent part, one map per entity as if a single table had held it all.

    **Where the two meet is probed, never assumed.**
    :func:`query_oldest_state_date` is one indexed ``LIMIT 1`` read per entity,
    cached there for hours, and it answers the only question that matters --
    where this entity's raw states actually begin. ``recorder.keep_days`` is *not* that date: a recreated
    database, a late-added entity or ``auto_purge: false`` each break the
    correspondence, and on the instance this was written for all eight days of
    raw history come from the database's creation date rather than from any
    purge.

    **The splice lands on the local midnight after that date, not on it.** Raw
    states begin part-way through their first day, and an hour whose opening
    reading predates them has no delta to be computed from -- it would come back
    missing, not wrong, leaving a ragged hole up to a day wide exactly at the
    seam. Statistics were compiled for that day while its states still existed,
    so handing the whole day to them costs nothing and closes the hole. From the
    next midnight on, raw states are complete, and they win every hour they
    cover: they see every meter tick, and the recent window is where resets and
    glitches actually happen.

    **The tail is one read for every entity together.** ``statistics_during_period``
    takes a set of ids, so a training run's tail costs one round trip on the
    recorder's single DB thread however many consumers it has. Only the recent
    part stays per-entity, because the raw reader is.

    Keys are normalised here rather than by the caller, because the two sources
    disagree about them: :class:`SpanStatistics` is keyed by the hour's **UTC**
    instant on purpose (see its docstring) and the raw reader keys by the UTC
    instant of each local slot start. Both are instants, so the autumn fall-back
    day's repeated local hour stays two distinct keys on both sides of the
    splice and all twenty-five hours survive -- which is exactly what folding
    either side to local wall-clock time would destroy.

    An entity the recorder has no statistics for -- one with no ``state_class``
    -- contributes an empty tail and is served entirely from raw states, which is
    today's behaviour unchanged.
    """
    unique_ids = list(dict.fromkeys(entity_id for entity_id in entity_ids if entity_id))
    if not unique_ids or local_end <= local_start:
        return {entity_id: {} for entity_id in unique_ids}

    local_tz = dt_util.as_local(local_start).tzinfo or timezone.utc
    splice_by_entity: dict[str, datetime] = {}
    for entity_id in unique_ids:
        oldest = await query_oldest_state_date(hass, entity_id, local_tz=local_tz)
        splice_by_entity[entity_id] = _splice_instant(
            oldest, local_start=local_start, local_end=local_end, local_tz=local_tz
        )

    # One statistics read, spanning as far forward as the deepest splice needs;
    # each entity keeps only the hours before its own. When every entity's raw
    # states already cover the whole window the deepest splice is the window's
    # own start, and there is no tail to read -- skipping the call keeps the
    # recorder round trip off the common case of a short window.
    statistics_end = max(splice_by_entity.values())
    statistics = (
        await query_hourly_statistics(
            hass, unique_ids, local_start=local_start, local_end=statistics_end
        )
        if statistics_end > local_start
        else None
    )

    spliced: dict[str, dict[datetime, float]] = {}
    for entity_id in unique_ids:
        splice = splice_by_entity[entity_id]
        merged = (
            {
                _as_utc(hour): kwh
                for hour, kwh in statistics.energy_for(entity_id).items()
                if hour < splice
            }
            if statistics is not None
            else {}
        )
        if splice < local_end:
            recent = await query_cumulative_hourly_energy_changes(
                hass, entity_id, local_start=splice, local_end=local_end
            )
            # Raw states win outright, so an hour both sources carry is counted
            # once, with the reading that saw every tick of it.
            merged.update({_as_utc(hour): kwh for hour, kwh in recent.items()})
        spliced[entity_id] = merged

    return spliced


def _splice_instant(
    oldest_state_date: date | None,
    *,
    local_start: datetime,
    local_end: datetime,
    local_tz: tzinfo,
) -> datetime:
    """The instant raw states take over from statistics, clamped to the window.

    ``None`` -- the recorder holds no raw state at all for this entity -- puts
    the splice at the window's end, which is the honest reading of it: there is
    no recent part, and statistics serve the whole window.
    """
    if oldest_state_date is None:
        return local_end
    splice = datetime.combine(
        oldest_state_date + timedelta(days=1), time.min, tzinfo=local_tz
    )
    return min(max(splice, local_start), local_end)


def _as_utc(hour: datetime) -> datetime:
    """One hour key, as the UTC instant both sources really mean.

    The two readers hand back aware datetimes in different zones for the same
    hour. Aware datetimes compare and hash by their instant, so a merged dict
    would already behave -- but it would hold keys in two zones and hand the
    caller whichever one arrived first, which is a trap for the next reader of
    the map rather than a bug in this one.
    """
    return hour.astimezone(timezone.utc)


#: The grid a resolved price rate is expressed on.
#:
#: Fifteen minutes, because that is the grid every consumer of a rate already
#: draws and bills on -- the inspector day's rail, the money calculation's slots
#: -- and because it is the finest grain any tier here can honestly claim: raw
#: states are sampled onto it, and an hourly mean spread across it says only
#: what it already said about its own hour.
PRICE_SLOT_MINUTES = 15


@dataclass(frozen=True)
class PriceHistory:
    """One price entity's recorded rate, slot by slot, over a requested window.

    A slot no tier covered is *absent*. Never zero, never interpolated from its
    neighbours: a rate nobody recorded is a fact about the recorder, and a
    fabricated one would be silently spent by whatever prices energy with it.

    "Covered" includes the raw tier's carry-forward, which is the sampling
    convention the day rail has always used and which this reader keeps: a rate
    is a level, so the last state written before a slot is the rate in force
    during it, however long ago it was written. A sensor that publishes only on
    change is the normal case and would otherwise resolve almost nothing.

    A carry is only that good while the recorder was actually running, though.
    Across an outage the same mechanism draws the last state before the outage
    flat over hours nothing observed, which is a fabricated rate wearing a
    recorded one's clothes -- so a carried slot is kept only where something
    proves the recorder was up, and dropped where nothing does. The three things
    that prove it, and the one risk that is accepted, are in
    :func:`query_price_history`.
    """

    #: ``{utc_slot_start: rate}``. Keyed by the slot's **UTC** instant, the same
    #: convention :class:`SpanStatistics` keeps and for the same reason: the
    #: autumn fall-back day lives its 02:00 twice, at two different rates, and a
    #: local wall-clock key would collapse them into one.
    by_slot: dict[datetime, float]

    def hourly_means(self) -> dict[datetime, dict[str, Any]]:
        """The resolved rates folded to one statistics-shaped row per hour.

        ``{utc_hour_start: {"mean": rate}}`` -- the shape
        :meth:`SpanStatistics.rows_for` hands back, so an hourly consumer prices
        with this exactly as it priced with the statistics table before there
        was a tier below it.

        Duration-weighted, which on a fixed grid is the plain mean of the slots
        the hour actually resolved: every slot stands for the same fifteen
        minutes. Averaging the raw *writes* instead would weight a minute in
        which the price was republished three times as heavily as the fifty-nine
        around it. An hour no slot resolved contributes no row at all rather than
        a zero.
        """
        by_hour: dict[datetime, list[float]] = {}
        for slot, rate in self.by_slot.items():
            by_hour.setdefault(_floor_to_hour(slot), []).append(rate)
        return {
            hour: {"mean": sum(rates) / len(rates)} for hour, rates in by_hour.items()
        }


async def query_price_history(
    hass: HomeAssistant,
    entity_ids: Sequence[str | None],
    *,
    local_start: datetime,
    local_end: datetime,
    statistics_rows: dict[str, dict[datetime, dict[str, Any]]] | None = None,
) -> dict[str, PriceHistory]:
    """Helman's own price entities, resolved slot by slot from the best tier.

    The one reader every historical price goes through -- the inspector day's
    two rails and the span views' money alike -- so that "what did this cost"
    has a single answer whichever view asks it. The entity ids are Helman's own
    (:data:`~.const.GRID_IMPORT_PRICE_ENTITY_ID` and
    :data:`~.const.GRID_EXPORT_PRICE_ENTITY_ID`); the third-party entity an
    export rate is *ingested* from is not a history source and is not read here.

    **Two tiers, resolved per slot rather than per day.**

    * **Raw recorder states win wherever they exist.** They are the finest thing
      the recorder holds and they are sampled with the rate convention
      :func:`~.recorder_hourly_series.query_slot_boundary_state_values_for_entities`
      already applies to a rail: the first write inside a slot, else the value
      carried forward into it -- subject to the trust rule below, which is what
      keeps a carry from spanning an outage.
    * **Hourly statistics fill the slots raw left empty, and only those.** An
      hour's ``mean`` represents that hour and no other, so it is stated across
      the hour's own slots -- which is what makes a day that begins in one tier
      and ends in the other come out whole, and an hour half-covered by raw
      states come out whole too.

    There is deliberately no third tier between them. Home Assistant keeps the
    five-minute short-term table for a *shorter* window than it keeps raw
    states, so it can only ever cover intervals the raw tier already did.

    **A carry is trusted only where the recorder can be shown to have been up.**
    A slot that took a write of its own is *observed* and is always right. A slot
    living off a carry is right only if the recorder was recording through it,
    and three things prove that. They are checked in this order because that is
    cheapest first, and because the first of them answers nearly every hour:

    1. **An earlier slot of the same hour was observed.** The raw pass already
       knows this, so it costs nothing. Both rates move on the hour on a spot
       market, so almost every hour of almost every day stops here and the
       statistics read below stays off the common path. *Earlier*, because a
       write vouches for the recorder from itself onward and says nothing about
       what preceded it -- an entity's republish after a restart must not acquit
       the stale slots ahead of it in the same hour.
    2. **The slot lies at or after the current recorder run's start.** See
       :func:`_recorder_recording_start`: the running process's own knowledge of
       when it began, which is exactly the evidence the statistics compiler
       cannot yet give for the hour in progress.
    3. **The slot's own hour has a finite ``mean`` row in hourly statistics.**
       Home Assistant compiles a row for every hour an entity held a numeric
       state, rewritten or not, so an hour with no row is an hour nothing
       observed. Both entities this reader serves declare a ``MEASUREMENT``
       state class, so a missing row is a missing hour rather than an entity the
       compiler never had anything to say about. A statistics read that *failed*
       says nothing either way and condemns nothing, which is why an empty
       ``statistics_rows`` hand-over is re-read rather than believed.

    A carried slot failing all three is dropped, and stays absent: the condition
    for dropping it -- no statistics row for its hour -- is the same condition
    under which the statistics tier has nothing to fill it with either. Nothing
    is put in its place. The day-ahead schedule is not a history source (#133):
    an elapsed slot answers from the recorder or not at all.

    Accepted: a slot just after a restart holds the carry from before an outage
    until the entity republishes, because clause 2 trusts the live run without
    asking how old the carried write is. Requiring the recorder to have been live
    continuously between the carried write and the slot would empty slots whose
    rate is perfectly well known, and buys little against entities that
    republish on startup.

    Accepted too: the hour an outage *ended* in keeps its carry once that hour
    has been compiled, because the compiler writes a row for a partial hour just
    as it does for a whole one, and clause 3 cannot tell the two apart. It is at
    most one hour, at the edge of the gap rather than across it, and the
    alternative -- refusing to let a statistics row speak for the hour holding
    the run start -- would empty three quarters of an hour after every routine
    restart, which is the far commoner event.

    Age is deliberately not a clause. Both price sensors publish on change, so a
    genuinely flat rate writes no rows for hours, and any cap on the carry's age
    would empty slots whose value is not in doubt. Uptime evidence answers the
    question that is actually being asked; age does not.

    **Coverage is probed, not assumed.**
    :func:`query_oldest_state_date` is one indexed ``LIMIT 1`` read per entity
    -- and cached there, so a day open pays it once rather than once per rail --
    and answers where this entity's raw states actually begin, which is what
    bounds the raw read: without it a year-wide request would scan the raw table
    across a year to find the fortnight of it that survives a purge.
    ``recorder.keep_days`` is not that date -- see
    :func:`query_spliced_hourly_energy`, which probes for the same reason.

    Unlike that splice there is no whole-day seam. Energy is a difference
    between two meter readings and an hour whose opening reading predates the
    raw states has none; a rate is a level, so the first slot a state exists for
    is usable on its own and the tiers meet wherever the data does.

    ``statistics_rows`` lets a caller that has already read this window's hourly
    statistics -- the span aggregates read every entity they need in one call --
    hand them over instead of paying for a second query. Omit it and the
    statistics tier reads for itself, and only if some slot actually needs it.

    Each tier degrades on its own: a recorder that cannot serve the raw read
    leaves the statistics tier to answer the whole window, and vice versa. An
    entity the recorder has nothing for at either tier comes back with an empty
    map rather than going missing.
    """
    unique_ids = list(dict.fromkeys(entity_id for entity_id in entity_ids if entity_id))
    if not unique_ids or local_end <= local_start:
        return {entity_id: PriceHistory(by_slot={}) for entity_id in unique_ids}

    local_tz = dt_util.as_local(local_start).tzinfo or timezone.utc
    slot_starts = _price_slot_starts(local_start, local_end)

    resolved: dict[str, dict[datetime, float]] = {
        entity_id: {} for entity_id in unique_ids
    }
    #: Slots living off a carry that clause 1 could not vouch for, and which the
    #: clauses below have to acquit or drop.
    unproven: dict[str, list[datetime]] = {entity_id: [] for entity_id in unique_ids}
    raw_start = await _raw_price_window_start(
        hass, unique_ids, local_start=local_start, local_end=local_end, local_tz=local_tz
    )
    if raw_start is not None and raw_start < local_end:
        from .recorder_hourly_series import (
            query_slot_boundary_state_values_for_entities,
        )

        try:
            raw_by_entity = await query_slot_boundary_state_values_for_entities(
                hass,
                unique_ids,
                local_start=raw_start,
                local_end=local_end,
                interval_minutes=PRICE_SLOT_MINUTES,
            )
        except Exception:
            _LOGGER.debug("Raw price history unavailable", exc_info=True)
            raw_by_entity = {}
        for entity_id in unique_ids:
            samples = {
                _as_utc(slot): sample
                for slot, sample in (raw_by_entity.get(entity_id) or {}).items()
                if _is_finite(sample.value)
            }
            resolved[entity_id] = {
                slot: sample.value for slot, sample in samples.items()
            }
            # Clause 1, and free: an hour that took a write was an hour the
            # recorder was running, so the slots that follow that write are
            # carrying a rate across a silence and not across an outage. On a
            # spot market both rates move on the hour, which is why this answers
            # almost every hour of almost every day and keeps the statistics
            # read below off the common path.
            #
            # Only the slots that *follow* the write, though. A write vouches
            # for the recorder from itself onward and says nothing about what
            # came before it, so an hour whose first write is the entity's
            # republish after a restart does not thereby acquit the stale slots
            # ahead of it -- which is exactly the recovery hour of the outage
            # this rule exists for.
            first_observed_by_hour: dict[datetime, datetime] = {}
            for slot, sample in samples.items():
                if not sample.observed:
                    continue
                hour = _floor_to_hour(slot)
                first = first_observed_by_hour.get(hour)
                if first is None or slot < first:
                    first_observed_by_hour[hour] = slot
            for slot, sample in samples.items():
                if sample.observed:
                    continue
                first = first_observed_by_hour.get(_floor_to_hour(slot))
                if first is None or slot < first:
                    unproven[entity_id].append(slot)

    if any(unproven.values()):
        # Clause 2, one attribute read: the running recorder's own account of
        # when it started. ``None`` is not evidence of an outage, it is the
        # absence of evidence either way, and it disarms the rule rather than
        # emptying a day because the attribute moved.
        recording_start = _recorder_recording_start(hass)
        unproven = (
            {}
            if recording_start is None
            else {
                entity_id: [slot for slot in slots if slot < recording_start]
                for entity_id, slots in unproven.items()
            }
        )

    unfilled = {
        entity_id: [slot for slot in slot_starts if slot not in resolved[entity_id]]
        for entity_id in unique_ids
    }
    rows: dict[str, dict[datetime, dict[str, Any]]] | None = None
    if any(unfilled.values()) or any(unproven.values()):
        rows = statistics_rows
        # An empty hand-over is not an answer. A caller that already ate a failed
        # statistics read passes ``{}`` on (``solar_bias_correction.service``
        # builds an empty :class:`SpanStatistics` on exception and hands over its
        # rows), and taking that silence for "the compiler recorded nothing"
        # would condemn carries on the strength of a query that never ran. Read
        # for ourselves instead: that tells a failure from a real emptiness.
        if not rows:
            try:
                rows = (
                    await query_hourly_statistics(
                        hass, unique_ids, local_start=local_start, local_end=local_end
                    )
                ).rows
            except Exception:
                _LOGGER.debug("Hourly price statistics unavailable", exc_info=True)
                rows = None

    if rows:
        for entity_id, slots in unfilled.items():
            entity_rows = rows.get(entity_id) or {}
            if not entity_rows:
                continue
            for slot in slots:
                mean = _finite_mean(entity_rows.get(_floor_to_hour(slot)))
                if mean is not None:
                    resolved[entity_id][slot] = mean
        for entity_id, slots in unproven.items():
            # Clause 3, and the verdict. An entity with no rows at all is not
            # skipped the way the fill above skips it: no row for the hour is
            # exactly the evidence that condemns the carry. Both entities this
            # reader serves declare ``SensorStateClass.MEASUREMENT``, so the
            # compiler writes them a row for every hour they held a state and a
            # missing one really does mean a missing hour.
            entity_rows = rows.get(entity_id) or {}
            for slot in slots:
                if _finite_mean(entity_rows.get(_floor_to_hour(slot))) is None:
                    resolved[entity_id].pop(slot, None)

    return {
        entity_id: PriceHistory(by_slot=resolved[entity_id]) for entity_id in unique_ids
    }


def _price_slot_starts(local_start: datetime, local_end: datetime) -> list[datetime]:
    """Every slot the window covers, as UTC instants.

    Stepped in UTC rather than on the wall clock, which is what gives a spring
    day 92 slots and an autumn day 100 -- and what keeps these keys comparable
    with the ones the raw sampler hands back, since it walks the same window the
    same way.
    """
    step = timedelta(minutes=PRICE_SLOT_MINUTES)
    cursor = dt_util.as_utc(local_start)
    end = dt_util.as_utc(local_end)
    slots: list[datetime] = []
    while cursor < end:
        slots.append(cursor)
        cursor += step
    return slots


async def _raw_price_window_start(
    hass: HomeAssistant,
    entity_ids: Sequence[str],
    *,
    local_start: datetime,
    local_end: datetime,
    local_tz: tzinfo,
) -> datetime | None:
    """Where the raw read may begin, or ``None`` for "no entity has raw states".

    The earliest raw state across the entities, floored to its local midnight
    and clamped into the window: they share one batched read, so the read has to
    open early enough for whichever of them reaches back furthest. Clamping to
    ``local_end`` is what turns "these states all begin after the window" into
    no read at all.
    """
    starts: list[datetime] = []
    for entity_id in entity_ids:
        try:
            oldest = await query_oldest_state_date(hass, entity_id, local_tz=local_tz)
        except Exception:
            _LOGGER.debug(
                "Raw price coverage probe failed for %s", entity_id, exc_info=True
            )
            continue
        if oldest is None:
            continue
        starts.append(datetime.combine(oldest, time.min, tzinfo=local_tz))
    if not starts:
        return None
    return min(max(min(starts), local_start), local_end)


def _recorder_recording_start(hass: HomeAssistant) -> datetime | None:
    """When the running recorder began recording, as a UTC instant.

    The evidence the statistics compiler cannot give: an hour still in progress
    has no statistics row and never will until it ends, so a rate carried across
    it would be condemned by clause 3 alone. The recorder's own run start says
    the process has been writing since before that slot, which is the whole of
    what clause 2 needs to know.

    Read off ``recorder_runs_manager`` -- the live object's account of itself --
    rather than the ``recorder_runs`` *table*, which cannot answer this
    truthfully. ``end_incomplete_runs`` back-fills an unfinished run's ``end``
    with the next startup time, so a crash or a power cut reads back out of that
    table as continuous recording, which is the case that matters most here.

    ``None`` on every failure -- no recorder, an attribute that moved, a value
    that is not an instant -- and ``None`` means no live-run evidence and no
    condemnation, leaving the carry the benefit of the doubt it had before this
    rule existed. Emptying a day because an internal attribute was renamed is
    the worse failure of the two.
    """
    try:
        recording_start = get_instance(hass).recorder_runs_manager.recording_start
    except Exception:
        _LOGGER.debug("Recorder run start unavailable", exc_info=True)
        return None
    if not isinstance(recording_start, datetime):
        return None
    return dt_util.as_utc(recording_start)


def _floor_to_hour(instant: datetime) -> datetime:
    """The start of the hour an instant falls in, keyed as the instant is."""
    return instant.replace(minute=0, second=0, microsecond=0)


def _is_finite(value: Any) -> bool:
    """Whether a sampled rate is a number that can price anything.

    Zero and negative rates pass -- a spot market really does pay to take power
    away -- while ``nan`` and the infinities do not: they are what a corrupted
    reading parses to, and multiplying a kilowatt-hour by one poisons every
    total it reaches.
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _finite_mean(row: Any) -> float | None:
    """A statistics row's ``mean``, or ``None`` where it has no usable one.

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
        mean = float(value)
    except (TypeError, ValueError):
        return None
    return mean if math.isfinite(mean) else None


async def query_statistics_unit(hass: HomeAssistant, statistic_id: str) -> str | None:
    """The unit the recorder archived an entity's statistics in, or ``None``.

    The last place a price's unit can be read once the sensor itself is not
    holding one -- a restart before the entity has published, say. The metadata
    table keeps one row per statistic id, so this is a keyed lookup rather than
    a scan however deep the history is.

    The import is deferred like every other reach into the recorder: it need not
    be set up, and every way of it not answering is the same answer here.
    """
    try:
        from homeassistant.components.recorder.statistics import get_metadata

        def _query() -> dict[str, Any]:
            return get_metadata(hass, statistic_ids={statistic_id})

        raw = await get_instance(hass).async_add_executor_job(_query)
    except Exception:
        _LOGGER.debug(
            "No statistics metadata available for %s", statistic_id, exc_info=True
        )
        return None
    entry = (raw or {}).get(statistic_id)
    metadata = entry[1] if isinstance(entry, tuple) and len(entry) == 2 else entry
    unit = (metadata or {}).get("unit_of_measurement") if metadata else None
    return unit if isinstance(unit, str) and unit else None


async def query_oldest_statistics_date(
    hass: HomeAssistant,
    statistic_ids: Sequence[str | None],
    *,
    local_tz: tzinfo,
) -> date | None:
    """The local date the oldest statistics for these entities begin on.

    This is how far back a history view can honestly be browsed, and it is a
    question only the recorder can answer. Nothing else in this integration
    knows it: a training window, a forecast horizon or a purge setting are all
    guesses that happen to be shaped like an answer.

    ``statistic_ids`` may contain ``None`` and duplicates, the same latitude
    :func:`query_hourly_statistics` gives its callers and for the same reason --
    the ids arrive from optional config providers. ``None`` comes back when none
    of the named entities has a single statistics row, which is the ordinary
    state of a fresh install and not an error.

    Two choices keep this affordable on a database holding years of history, and
    both are load-bearing rather than tidy:

    * **``types`` is empty.** ``_generate_select_columns_for_types_stmt`` adds a
      column per requested type and none otherwise, so the statement selects
      ``metadata_id, start_ts`` and nothing else. The scan stays two narrow
      columns wide however deep the history is.
    * **``period="month"``.** The reduction happens in Python either way, so this
      buys nothing in SQL; what it buys is the return value. A month's worth of
      hourly rows collapses to one row whose ``start`` is local midnight on the
      first of that month, so the earliest row *is* the answer, already floored,
      and a handful of rows per entity crosses back rather than thousands.

    Like every other statistics read here, ``start`` arrives as a POSIX float
    rather than a datetime, and the conversion goes through
    ``datetime.fromtimestamp`` so the local date is the one the recorder bucketed
    by.
    """
    unique_ids = list(dict.fromkeys(sid for sid in statistic_ids if sid))
    if not unique_ids:
        return None

    def _query() -> dict[str, list[dict[str, Any]]]:
        return statistics_during_period(
            hass,
            _HISTORY_PROBE_EPOCH,
            None,
            set(unique_ids),
            "month",
            None,
            set(),
        )

    raw = await get_instance(hass).async_add_executor_job(_query)

    # The oldest across all of them, not per entity: one meter installed later
    # than another does not move the floor forward, because the earlier meter's
    # months are still drawable.
    oldest: float | None = None
    for entity_rows in (raw or {}).values():
        for row in entity_rows or []:
            start = row.get("start")
            if start is None:
                continue
            if oldest is None or start < oldest:
                oldest = start
    if oldest is None:
        return None
    return datetime.fromtimestamp(oldest, tz=local_tz).date()


async def query_oldest_statistics_day(
    hass: HomeAssistant,
    statistic_ids: Sequence[str | None],
    *,
    local_tz: tzinfo,
) -> date | None:
    """The local date the oldest statistics row actually falls on.

    :func:`query_oldest_statistics_date` answers a *month*: its ``period="month"``
    read returns local midnight on the first of the month the oldest row lands
    in, which is the right floor for a view that browses by day within a month
    and is cheap however deep the history is. It is the wrong answer for anyone
    who subtracts it from today and calls the result a depth -- an entity first
    recorded on the 28th reads as thirty days of history on the 31st.

    That rounding was harmless while the number was only displayed. It stopped
    being harmless when the badge began *judging* against it (#186): a
    month-floored depth clears a fourteen-day requirement for an entity three
    days old, which is the false green #169 exists to remove, wearing different
    clothes.

    So this narrows the month to its day, in two bounded reads rather than one
    unbounded one: the month probe first (a handful of rows per entity, whatever
    the depth), then a ``period="day"`` read confined to that month alone -- at
    most thirty-one rows of two narrow columns. Probing days from the epoch
    directly would be one query rather than two, and would grow a row per day of
    history for as long as the instance lives.

    ``None`` when the month probe finds nothing, and the month's own first day
    when the narrowing read comes back empty -- a month that exists but whose
    days do not is not a shape this understands, and reporting the floor it
    already has is better than reporting no history at all.
    """
    month_start = await query_oldest_statistics_date(
        hass, statistic_ids, local_tz=local_tz
    )
    if month_start is None:
        return None

    unique_ids = list(dict.fromkeys(sid for sid in statistic_ids if sid))
    if not unique_ids:
        return None

    window_start = datetime.combine(month_start, time.min, tzinfo=local_tz)
    # 32 days clears the longest month from its first, and the read is bounded
    # by the end instant rather than by a month arithmetic this does not need.
    window_end = window_start + timedelta(days=32)

    def _query() -> dict[str, list[dict[str, Any]]]:
        return statistics_during_period(
            hass,
            window_start,
            window_end,
            set(unique_ids),
            "day",
            None,
            set(),
        )

    raw = await get_instance(hass).async_add_executor_job(_query)
    oldest: float | None = None
    for entity_rows in (raw or {}).values():
        for row in entity_rows or []:
            start = row.get("start")
            if start is None:
                continue
            if oldest is None or start < oldest:
                oldest = start
    if oldest is None:
        return month_start
    return datetime.fromtimestamp(oldest, tz=local_tz).date()


@dataclass(frozen=True)
class HistoryDepths:
    """How much history the recorder holds for one entity, in both tables.

    ``0`` in either field means "the recorder holds nothing there": there is
    no meaningful difference, for a badge or a table, between "no rows" and
    "zero days of rows".
    """

    statistics_days: int
    raw_states_days: int


async def query_history_depths(
    hass: HomeAssistant,
    entity_id: str,
    *,
    today_local: date,
    local_tz: tzinfo,
) -> HistoryDepths:
    """Both tables' depth for one entity, so a caller can show -- or judge -- either.

    This used to be one number, picked by falling back from statistics to raw
    states, and the fallback hid the very gap the caller needed to see: raw
    states are pruned by ``purge_keep_days`` while long-term statistics survive
    indefinitely, so a shallow, pruned entity looked perfectly deep (issue
    #169). Both probes therefore run unconditionally rather than
    short-circuiting -- the same two queries the fallback already issued in its
    worst case (no statistics), just no longer conditional on the first coming
    back empty.

    **What the two numbers mean has moved on, and the split still matters.**
    Since #183 every trainer reads a *spliced* window -- statistics for the
    tail, raw states for the recent part -- so neither number alone is "how far
    back training can reach"; the deeper of the two is, and
    :mod:`entity_inspection.history` is where that judgement is made (#186).
    What is reported here stays two separate facts, because a caller that wants
    to show the gap and a caller that wants to judge against it need the same
    pair.

    The statistics side goes through :func:`query_oldest_statistics_day` rather
    than :func:`query_oldest_statistics_date` precisely because it is subtracted
    from a date here: the month-floored answer would inflate a young entity's
    depth by up to a month, which a judging caller reads as history it does not
    have.

    **The arithmetic matches the trainer's.** Whole days between the local date
    the oldest sample falls on and ``today_local``, which is exactly what
    :func:`~.consumption_forecast_profiles._compute_history_days` computes from
    rows a training run already fetched. The two exist separately only because
    neither call site can use the other's input without a second round trip --
    the trainer already holds the rows, the editor holds nothing but an entity
    id. ``tests/test_entity_inspection.py`` pins the agreement.
    """
    statistics_oldest = await query_oldest_statistics_day(
        hass, [entity_id], local_tz=local_tz
    )
    states_oldest = await query_oldest_state_date(hass, entity_id, local_tz=local_tz)
    statistics_days = (
        max(0, (today_local - statistics_oldest).days)
        if statistics_oldest is not None
        else 0
    )
    raw_states_days = (
        max(0, (today_local - states_oldest).days) if states_oldest is not None else 0
    )
    return HistoryDepths(statistics_days=statistics_days, raw_states_days=raw_states_days)


async def query_oldest_state_date(
    hass: HomeAssistant,
    entity_id: str,
    *,
    local_tz: tzinfo,
) -> date | None:
    """The local date of the oldest raw state the recorder still holds.

    One question, several callers. :func:`query_history_depths` reports it,
    :func:`query_spliced_hourly_energy` and :func:`query_price_history` bound
    their raw reads with it, and the bias trainer's forecast-slot window and
    actuals tail splice on it -- which is why this is public and why it is a
    probe rather than an inference from ``recorder.keep_days``: that setting
    says when rows are deleted, not when this entity's first row was written.

    ``limit=1`` on an ascending scan from the epoch is a single indexed row --
    the query does not grow with how much history there is -- and
    ``include_start_time_state`` is off because there is nothing before the
    epoch to carry in and asking for it costs a second lookup.

    **Cheap is not the same as free, so the answer is cached here rather than by
    any one caller.** The recorder serves every query from one database executor
    thread, so each probe is a serial round trip whatever the awaits look like,
    and a single inspector day open asks this several times over -- both price
    entities, the meters a spliced window covers, the forecast entity. Caching
    inside the probe is what lets every one of those callers benefit without
    knowing it is cached at all; a cache in the price reader would have left the
    others paying. :data:`_OLDEST_STATE_TTL` is how long an answer stands,
    :data:`_OLDEST_STATE_RETRY` how long a failure does, and ``None`` -- "this
    entity has no raw states" -- is held like any other answer, because it is the
    one that skips a whole raw read.

    The lock is not an optimisation either. Two views mounting together ask about
    the same entity within the same tick; without it both would queue their own
    read on the recorder's single thread and the second would learn nothing the
    first was not already fetching.

    The import is deferred like every other reach into the recorder: it need not
    be set up, and the caller treats a failure as "the recorder cannot say" --
    which is why a cached failure is re-raised rather than turned into an answer,
    for as long as there is no earlier answer to serve instead.
    """
    instant = await _async_oldest_state_instant(hass, entity_id)
    if instant is None:
        return None
    return instant.astimezone(local_tz).date()


async def _async_oldest_state_instant(
    hass: HomeAssistant, entity_id: str
) -> datetime | None:
    """The cached instant this entity's raw states begin at, probing if stale.

    Double-checked under the entity's own lock, the pattern
    :meth:`~.solar_bias_correction.service.SolarBiasCorrectionService._async_history_floor`
    already uses for the history floor: whoever queued behind a probe wants its
    answer, not a second read of the same row.
    """
    probes = _oldest_state_probes(hass)
    probe = probes.get(entity_id)
    if probe is None:
        probe = probes[entity_id] = _OldestStateProbe()

    if probe.is_stale(dt_util.now()):
        async with probe.lock:
            if probe.is_stale(dt_util.now()):
                await _async_refresh_oldest_state_probe(hass, entity_id, probe)

    if probe.error is not None and not probe.answered:
        # Cleared rather than raised as it stands: raising an exception that
        # already carries a traceback appends to it, so one held instance would
        # grow a frame per request through the retry window and pin every frame
        # it came from -- the recorder closure and its `hass` among them -- in
        # `hass.data` for the whole of it.
        raise probe.error.with_traceback(None)
    return probe.instant


async def _async_refresh_oldest_state_probe(
    hass: HomeAssistant, entity_id: str, probe: _OldestStateProbe
) -> None:
    """Ask the recorder again, and remember how the asking went.

    An answer -- an instant, or ``None`` for an entity the recorder holds no raw
    state for -- clears any remembered failure and stands for the full TTL. A
    failure is remembered as a failure and holds the recorder off until
    :data:`_OLDEST_STATE_RETRY` has passed. It leaves any previous answer alone,
    and that answer still serves: a coverage date already learned is better than
    a hard failure for callers that have no guard, and a blip the recorder has
    already recovered from should not fail every span read for five minutes.
    Only an entity nothing has ever been learned about raises.

    The stamp is written in both outcomes rather than in a ``finally``, which is
    what
    :meth:`~.solar_bias_correction.service.SolarBiasCorrectionService._async_refresh_history_floor`
    does and for the reason it does: a ``BaseException`` -- a cancelled request
    is the ordinary one -- skips ``except Exception`` but not ``finally``, and
    would leave this probe stamped fresh, answerless and unasked for six hours.
    """
    try:
        probe.instant = await _probe_oldest_state_instant(hass, entity_id)
    except Exception as err:
        # Held rather than swallowed: a caller with nothing better still gets it
        # raised, from _async_oldest_state_instant, through the retry window.
        probe.error = err
        probe.lifetime = _OLDEST_STATE_RETRY
        probe.probed_at = dt_util.now()
        return
    probe.answered = True
    probe.error = None
    probe.lifetime = _OLDEST_STATE_TTL
    probe.probed_at = dt_util.now()


async def _probe_oldest_state_instant(
    hass: HomeAssistant, entity_id: str
) -> datetime | None:
    """The one indexed read, uncached: the oldest raw state's instant."""
    from homeassistant.components.recorder.history import state_changes_during_period

    def _query() -> dict[str, list[Any]]:
        return state_changes_during_period(
            hass,
            _HISTORY_PROBE_EPOCH,
            None,
            entity_id,
            no_attributes=True,
            descending=False,
            limit=1,
            include_start_time_state=False,
        )

    raw = await get_instance(hass).async_add_executor_job(_query)
    states = (raw or {}).get(entity_id) or (raw or {}).get(entity_id.lower()) or []
    if not states:
        return None
    return getattr(states[0], "last_changed", None) or getattr(
        states[0], "last_updated", None
    )


def _tail_window_start(
    tail_start: datetime | None, utc_end: datetime
) -> datetime | None:
    """The UTC instant the short-term read starts at, or ``None`` for no read.

    Two clamps, both load-bearing. The span is capped at :data:`_MAX_TAIL_SPAN`
    back from *now* rather than back from the window's end, because the window
    ends at the end of today -- a fixed offset from that would ask for nothing at
    all before six in the evening. And the result is floored to the hour so that
    every hour the tail reports on is *wholly* inside the read; a half-covered
    hour would look like a complete reading and quietly under-report.
    """
    if tail_start is None:
        return None
    floor = dt_util.as_utc(dt_util.now()) - _MAX_TAIL_SPAN
    start = max(dt_util.as_utc(tail_start), floor).replace(
        minute=0, second=0, microsecond=0
    )
    return start if start < utc_end else None


def _fold_to_hours(entity_rows: list[dict[str, Any]]) -> dict[datetime, dict[str, Any]]:
    """Collapse short-term rows onto the hour that contains them.

    The result has to be indistinguishable from a compiled hourly row, because
    that is exactly what it is used as. ``state`` therefore takes the *last*
    reading of the hour -- the hourly table's own convention, and the one the
    differencing above depends on -- while ``min``/``max`` take the extremes and
    ``mean`` the plain average of the five-minute means, which are equal-length
    samples. An hour still in progress folds however many samples it has so far,
    which is the point: its energy is what has been measured, not zero and not a
    gap.
    """
    buckets: dict[datetime, list[dict[str, Any]]] = {}
    for row in entity_rows:
        start = row.get("start")
        if start is None:
            continue
        instant = datetime.fromtimestamp(start, tz=timezone.utc)
        buckets.setdefault(instant.replace(minute=0, second=0, microsecond=0), []).append(
            row
        )

    folded: dict[datetime, dict[str, Any]] = {}
    for utc_hour, group in buckets.items():
        group.sort(key=lambda item: item["start"])
        row: dict[str, Any] = {
            "start": utc_hour.timestamp(),
            "end": (utc_hour + timedelta(hours=1)).timestamp(),
        }
        states = [value for value in (item.get("state") for item in group) if value is not None]
        if states:
            row["state"] = states[-1]
        minima = [value for value in (item.get("min") for item in group) if value is not None]
        if minima:
            row["min"] = min(minima)
        maxima = [value for value in (item.get("max") for item in group) if value is not None]
        if maxima:
            row["max"] = max(maxima)
        means = [value for value in (item.get("mean") for item in group) if value is not None]
        if means:
            row["mean"] = sum(means) / len(means)
        folded[utc_hour] = row
    return folded


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
    rest of the series instead of producing one enormous negative step, while a
    drop too shallow to be a reset -- or one that recovers an hour later -- is
    discarded as the glitch it is rather than counted as a reset. A gap in
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

    unwrapped = unwrap_cumulative_energy_series(
        samples, rebound_window=_REBOUND_WINDOW
    )

    energy: dict[datetime, float] = {}
    previous_value: float | None = None
    for utc_hour, value in unwrapped:
        if previous_value is not None and local_start <= utc_hour < local_end:
            energy[utc_hour] = value - previous_value
        previous_value = value
    return energy
