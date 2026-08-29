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
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .recorder_hourly_series import query_cumulative_hourly_energy_changes

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
    :func:`query_oldest_state_date` is one indexed ``LIMIT 1`` read per entity
    and it answers the only question that matters -- where this entity's raw
    states actually begin. ``recorder.keep_days`` is *not* that date: a recreated
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


def prefer_rows(
    preferred: dict[datetime, dict[str, Any]],
    fallback: dict[datetime, dict[str, Any]],
) -> dict[datetime, dict[str, Any]]:
    """Two hourly series of the same quantity, merged hour by hour.

    Per hour rather than per series, for the reason the import rail already
    merges per hour: the seam between the two falls mid-span. Helman's export
    price mirror covers every hour from the moment it started publishing plus
    whatever its back-fill reached, and the configured sell-price entity covers
    whatever hours its own statistics happen to hold -- usually none, since such
    an entity typically declares no ``state_class``. Choosing one series for the
    whole span would either blank the hours only the other one covers or discard
    Helman's own record in favour of a third party's.

    Helman's own series wins where both have the hour *and its row carries a
    rate*. They mirror the same number, so they agree; where they somehow do
    not, the one Helman archived is the one it can account for. But a row is not
    the same as a reading: the span read folds five-minute tail rows onto their
    containing hour and emits a row whether or not any of them carried a mean,
    so the hour in progress can arrive present-but-empty -- and preferring it on
    presence alone would blank an hour the fallback could have priced.
    """
    if not fallback:
        return preferred
    if not preferred:
        return fallback
    merged = dict(fallback)
    for hour, row in preferred.items():
        if row.get("mean") is None and merged.get(hour, {}).get("mean") is not None:
            continue
        merged[hour] = row
    return merged


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
    states. That is the right answer for a caller that only wants to know "how
    far back can this be shown", and the wrong one for a caller that has to say
    how far back *training* can reach: every trainer reads raw states through
    :mod:`recorder_hourly_series`, which ``purge_keep_days`` prunes, while
    long-term statistics survive indefinitely -- so the fallback made a
    shallow, pruned entity look perfectly deep (issue #169).

    So both probes run unconditionally rather than short-circuiting -- the same
    two queries the fallback already issued in its worst case (no statistics),
    just no longer conditional on the first coming back empty.

    **The arithmetic matches the trainer's.** Whole days between the local date
    the oldest sample falls on and ``today_local``, which is exactly what
    :func:`~.consumption_forecast_profiles._compute_history_days` computes from
    rows a training run already fetched. The two exist separately only because
    neither call site can use the other's input without a second round trip --
    the trainer already holds the rows, the editor holds nothing but an entity
    id. ``tests/test_entity_inspection.py`` pins the agreement.
    """
    statistics_oldest = await query_oldest_statistics_date(
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

    Two callers, one question. :func:`query_history_depths` reports it, and
    :func:`query_spliced_hourly_energy` splices on it -- which is why this is
    public and why it is a probe rather than an inference from
    ``recorder.keep_days``: that setting says when rows are deleted, not when
    this entity's first row was written.

    ``limit=1`` on an ascending scan from the epoch is a single indexed row --
    the query does not grow with how much history there is -- and
    ``include_start_time_state`` is off because there is nothing before the
    epoch to carry in and asking for it costs a second lookup.

    The import is deferred like every other reach into the recorder: it need not
    be set up, and the caller treats a failure as "the recorder cannot say".
    """
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
    when = getattr(states[0], "last_changed", None) or getattr(
        states[0], "last_updated", None
    )
    if when is None:
        return None
    return when.astimezone(local_tz).date()


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
