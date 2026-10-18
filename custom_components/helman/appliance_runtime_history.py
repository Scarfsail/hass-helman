from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import get_significant_states
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .controllables.config import is_active_state
from .recorder_slot_energy import _BOUNDARY_WRITE_SETTLE_WINDOW, _states_for_entity
from .slot_grid import _get_local_day_start

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ApplianceRuntimeRequest:
    """One appliance's runtime-history question.

    ``key`` is what the answer comes back under -- the appliance id. It is not
    part of the reuse key, because two appliances watching the same entity for
    the same states are asking the same question of the recorder and must share
    one read; ``entity_id`` and ``active_states`` are, because two appliances
    watching the same entity for *different* states are not.

    ``lookback_days`` is this appliance's own requirement: the answer covers
    ``lookback_days`` days back from today, and nothing earlier, even when a
    neighbour on the same entity asked for more.
    """

    key: str
    entity_id: str
    active_states: tuple[str, ...]
    lookback_days: int


@dataclass(frozen=True)
class _SettledRuntimeDays:
    """One entity/active-state pair's completed days, and what they cover.

    ``hours_by_date`` holds every date in ``[covered_from, settled_through]``
    explicitly, zeros included, so a resumed read can tell a day that was read
    and found idle from a day that was never read. The range is contiguous by
    construction -- it only ever grows forward from a window that was read in
    one piece -- which is what lets the next read start at
    ``settled_through + 1`` and simply concatenate.

    ``tz_key`` is the local timezone the days were carved by. Moving it moves
    every day boundary, so a change discards the prefix rather than mixing two
    griddings of the same hours.
    """

    tz_key: str
    covered_from: date
    settled_through: date
    hours_by_date: dict[date, float]


def _local_midnight(day: date, tzinfo: Any) -> datetime:
    """Local midnight of ``day``, offset resolved for that date."""
    if tzinfo is None:
        return datetime.combine(day, time.min)
    return datetime.combine(day, time.min, tzinfo=tzinfo)


class ApplianceRuntimeHistoryReader:
    """Per-appliance active-state hours per local day, read once and resumed.

    Two costs are being paid here, and each has its own fix.

    A read per appliance is a read per appliance: the recorder serves every
    query from one DB executor thread, so ten appliances are ten serial
    round-trips however the awaits are arranged. Appliances whose reads start at
    the same instant are asked for in one ``get_significant_states`` call, so
    the query count follows the number of distinct start instants -- one, once
    the settled prefixes have converged -- rather than the number of
    appliances. Each appliance's active-state interpretation is still applied to
    the rows on its own, so a switch one appliance counts as ``on`` and another
    counts as ``heat`` share the read without sharing the answer.

    And a completed local day's runtime can never change, so re-reading the full
    lookback on every refresh re-derives days that were settled before the
    integration started. Settled days are kept per entity/active-state pair and
    only the unsettled tail -- yesterday, once the recorder has had time to
    commit its last writes for them, and today so far -- is queried again. A day
    is only frozen after the window that produced it was read whole, so the
    carry into it and the split of an interval across its midnight are already
    in the number that is kept.

    Instances have to outlive a single refresh to be worth anything; the
    coordinator owns one.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._settled: dict[tuple[str, tuple[str, ...]], _SettledRuntimeDays] = {}

    async def async_query_active_hours_by_local_date(
        self,
        requests: Sequence[ApplianceRuntimeRequest],
        *,
        reference_time: datetime,
    ) -> dict[str, dict[date, float]]:
        """Answer every request, in as few recorder reads as the windows allow.

        Returns ``{request key: {local date: active hours}}``, carrying every
        date inside that request's own lookback and no other -- a day the
        appliance never ran is an explicit zero, because the consecutive-skip
        guard walks back until it finds a date that is absent. A request whose
        read failed is absent from the result *as a whole* rather than present
        as a window of zeros: a failure is not an idle appliance, and the caller
        has to be able to tell them apart.
        """
        local_now = dt_util.as_local(reference_time)
        tzinfo = local_now.tzinfo
        tz_key = str(tzinfo)
        today = local_now.date()
        settled_through_now = _settled_runtime_day(local_now)

        #: ``{(entity id, states): [request, ...]}``, empty state sets dropped —
        #: an appliance with nothing to count is idle by definition, and asking
        #: the recorder about it would buy a query for a guaranteed ``{}``.
        by_reuse_key: dict[
            tuple[str, tuple[str, ...]], list[ApplianceRuntimeRequest]
        ] = {}
        results: dict[str, dict[date, float]] = {}
        for request in requests:
            states = _normalize_active_states(request.active_states)
            if not request.entity_id or not states:
                # Idle by definition, which is not the same as unanswered: an
                # explicit window of zeros, exactly as a read of an entity that
                # never turned on would return.
                results[request.key] = {
                    local_date: 0.0
                    for local_date in _iter_dates(
                        today - timedelta(days=request.lookback_days), today
                    )
                }
                continue
            # Lowered, as the recorder stores it: ``state_changes_during_period``
            # lowered the id for us, ``get_significant_states`` looks it up in a
            # dict of states metadata and simply finds nothing. A configured
            # ``switch.Pool`` would come back as a full window of zeros -- and
            # freeze that way -- rather than as the runtime it actually had.
            by_reuse_key.setdefault(
                (request.entity_id.lower(), states), []
            ).append(request)

        # Anything no longer asked for is a reconfigured entity or active-state
        # set, or an appliance that left the automation; its prefix can never be
        # resumed again and would otherwise be kept for the process's lifetime.
        for stale_key in [key for key in self._settled if key not in by_reuse_key]:
            del self._settled[stale_key]

        #: ``{first date to read: {reuse key: resumable prefix or None}}``.
        by_read_start: dict[
            date, dict[tuple[str, tuple[str, ...]], _SettledRuntimeDays | None]
        ] = {}
        for reuse_key, group in by_reuse_key.items():
            needed_from = today - timedelta(
                days=max(request.lookback_days for request in group)
            )
            resumable = self._take_resumable(
                reuse_key,
                tz_key=tz_key,
                needed_from=needed_from,
                settled_through_now=settled_through_now,
            )
            read_from = (
                resumable.settled_through + timedelta(days=1)
                if resumable is not None
                else needed_from
            )
            by_read_start.setdefault(read_from, {})[reuse_key] = resumable

        for read_from, group in sorted(by_read_start.items()):
            await self._read_group(
                read_from=read_from,
                group=group,
                requests_by_reuse_key=by_reuse_key,
                results=results,
                local_now=local_now,
                tzinfo=tzinfo,
                tz_key=tz_key,
                today=today,
                settled_through_now=settled_through_now,
            )

        return results

    def _take_resumable(
        self,
        reuse_key: tuple[str, tuple[str, ...]],
        *,
        tz_key: str,
        needed_from: date,
        settled_through_now: date,
    ) -> _SettledRuntimeDays | None:
        """The kept prefix this read may resume from, dropping it if it may not.

        A different timezone regrids the days; a prefix reaching past what is
        settled *now* is a clock that stepped backwards; a prefix that starts
        after the day being asked for, or ends more than a day before it, leaves
        a hole no concatenation can fill. Any of them and the entity is read in
        full once.
        """
        frozen = self._settled.get(reuse_key)
        if frozen is None:
            return None
        if (
            frozen.tz_key != tz_key
            or frozen.settled_through > settled_through_now
            or frozen.covered_from > needed_from
            or frozen.settled_through + timedelta(days=1) < needed_from
        ):
            del self._settled[reuse_key]
            return None
        return frozen

    async def _read_group(
        self,
        *,
        read_from: date,
        group: dict[tuple[str, tuple[str, ...]], _SettledRuntimeDays | None],
        requests_by_reuse_key: dict[
            tuple[str, tuple[str, ...]], list[ApplianceRuntimeRequest]
        ],
        results: dict[str, dict[date, float]],
        local_now: datetime,
        tzinfo: Any,
        tz_key: str,
        today: date,
        settled_through_now: date,
    ) -> None:
        utc_start = dt_util.as_utc(_local_midnight(read_from, tzinfo))
        utc_end = dt_util.as_utc(local_now)
        if utc_end <= utc_start:
            # Nothing to read: only reachable when the clock sits exactly on a
            # local midnight the prefix already covers. The kept days still
            # answer the request.
            queried: dict[tuple[str, tuple[str, ...]], dict[date, float]] = {
                reuse_key: {} for reuse_key in group
            }
        else:
            entity_ids = list(dict.fromkeys(entity_id for entity_id, _ in group))
            reuse_keys = list(group)

            def _query_and_parse() -> dict[
                tuple[str, tuple[str, ...]], dict[date, float]
            ]:
                history = get_significant_states(
                    self._hass,
                    # Recorder bounds are exclusive. Include a transition at
                    # midnight, then clip intervals to the requested day below.
                    utc_start - timedelta(microseconds=1),
                    utc_end,
                    entity_ids=entity_ids,
                    filters=None,
                    include_start_time_state=True,
                    # Switches and climates: the rows a per-entity
                    # ``state_changes_during_period`` would have returned, plus
                    # (for the significant domains, climate among them) the
                    # attribute-only writes it filters out. Those carry the same
                    # state as the row before them, and an interval is delimited
                    # by a *change* of state, so they cannot move a boundary.
                    significant_changes_only=True,
                    minimal_response=False,
                    no_attributes=True,
                    compressed_state_format=False,
                )
                # Bucketing runs here rather than after the await: a multi-day
                # lookback over several entities is thousands of rows, and the
                # event loop should not be the thread that walks them.
                return {
                    (entity_id, states): _bucket_interval_hours_by_local_date(
                        _build_active_state_intervals(
                            states=_states_for_entity(history, entity_id),
                            window_start=utc_start,
                            window_end=utc_end,
                            active_states=states,
                        )
                    )
                    for entity_id, states in reuse_keys
                }

            try:
                queried = await get_instance(self._hass).async_add_executor_job(
                    _query_and_parse
                )
            except Exception:
                # The group's appliances stay out of the result, and their kept
                # prefixes stay exactly as they were, so the next refresh asks
                # the same question again. A failed read must never settle as a
                # day of zero runtime.
                _LOGGER.exception(
                    "Error reading appliance runtime history for %r",
                    sorted({entity_id for entity_id, _ in group}),
                )
                return

        for reuse_key, resumable in group.items():
            fresh = queried.get(reuse_key, {})
            combined = {**(resumable.hours_by_date if resumable else {}), **fresh}
            covered_from = resumable.covered_from if resumable else read_from
            # Only back as far as the widest lookback still asks for. The kept
            # prefix would otherwise hold every day it has ever seen, growing by
            # one a day for the life of the process while a one-day lookback
            # reads two of them.
            needed_from = today - timedelta(
                days=max(
                    request.lookback_days
                    for request in requests_by_reuse_key[reuse_key]
                )
            )
            covered_from = max(covered_from, min(needed_from, settled_through_now))
            self._freeze(
                reuse_key,
                tz_key=tz_key,
                covered_from=covered_from,
                settled_through=settled_through_now,
                combined=combined,
                previous=resumable,
            )
            for request in requests_by_reuse_key[reuse_key]:
                request_from = today - timedelta(days=request.lookback_days)
                # Every date in the window explicitly, zeros included: the
                # consecutive-skip guard walks back day by day and stops at the
                # first date it cannot find, so a fully idle day has to be
                # present as a zero rather than missing.
                results[request.key] = {
                    **{
                        local_date: 0.0
                        for local_date in _iter_dates(request_from, today)
                    },
                    **{
                        local_date: hours
                        for local_date, hours in combined.items()
                        if local_date >= request_from
                    },
                }

    def _freeze(
        self,
        reuse_key: tuple[str, tuple[str, ...]],
        *,
        tz_key: str,
        covered_from: date,
        settled_through: date,
        combined: dict[date, float],
        previous: _SettledRuntimeDays | None,
    ) -> None:
        if settled_through < covered_from:
            # Nothing has settled inside the window that was read. Whatever was
            # already kept (and was resumable, or this read would have started
            # earlier) still stands.
            if previous is not None:
                self._settled[reuse_key] = previous
            return

        self._settled[reuse_key] = _SettledRuntimeDays(
            tz_key=tz_key,
            covered_from=covered_from,
            settled_through=settled_through,
            hours_by_date={
                local_date: combined.get(local_date, 0.0)
                for local_date in _iter_dates(covered_from, settled_through)
            },
        )


def _settled_runtime_day(local_now: datetime) -> date:
    """The newest local day whose runtime total can never change again.

    Yesterday, once today has run long enough for the recorder to have
    committed the writes it stamped before midnight -- the same margin a
    boundary sample waits out, for the same reason. Before that the day just
    ended is still in flight and is read again.
    """
    day_start = _get_local_day_start(local_now)
    if local_now - day_start >= _BOUNDARY_WRITE_SETTLE_WINDOW:
        return day_start.date() - timedelta(days=1)
    return day_start.date() - timedelta(days=2)


def _normalize_active_states(active_states: Sequence[str]) -> tuple[str, ...]:
    """The active states as a reuse key: trimmed, lowered, deduplicated, ordered.

    ``_build_active_state_intervals`` compares against exactly this set, so two
    spellings of the same set have to land on one key or they would buy two
    reads of one question.
    """
    return tuple(
        sorted({state.strip().lower() for state in active_states if state.strip()})
    )


def _iter_dates(start: date, end: date) -> list[date]:
    dates: list[date] = []
    cursor = start
    while cursor <= end:
        dates.append(cursor)
        cursor += timedelta(days=1)
    return dates


def _bucket_interval_hours_by_local_date(
    intervals: list[tuple[datetime, datetime]],
) -> dict[date, float]:
    hours_by_date: dict[date, float] = {}
    for interval_start, interval_end in intervals:
        cursor = dt_util.as_local(interval_start)
        end = dt_util.as_local(interval_end)
        while cursor < end:
            day_start = _get_local_day_start(cursor)
            next_day_start = _get_local_day_start(day_start + timedelta(days=1, hours=1))
            segment_end = min(end, next_day_start)
            duration_hours = (
                dt_util.as_utc(segment_end) - dt_util.as_utc(cursor)
            ).total_seconds() / 3600
            if duration_hours > 0:
                local_day = cursor.date()
                hours_by_date[local_day] = (
                    hours_by_date.get(local_day, 0.0) + duration_hours
                )
            cursor = segment_end
    return hours_by_date


def _build_active_state_intervals(
    *,
    states: list[Any],
    window_start: datetime,
    window_end: datetime,
    active_states: tuple[str, ...],
) -> list[tuple[datetime, datetime]]:
    if not states or window_end <= window_start:
        return []

    normalized_active_states = {
        state.strip().lower() for state in active_states if state.strip()
    }
    intervals: list[tuple[datetime, datetime]] = []
    active_start: datetime | None = None
    for state in states:
        last_updated = getattr(state, "last_updated", None)
        if last_updated is None:
            continue

        updated_at = dt_util.as_utc(last_updated)
        if updated_at > window_end:
            break

        if is_active_state(getattr(state, "state", None), normalized_active_states):
            if active_start is None:
                active_start = max(updated_at, window_start)
            continue

        if active_start is None:
            continue

        interval_end = min(updated_at, window_end)
        if interval_end > active_start:
            intervals.append((active_start, interval_end))
        active_start = None

    if active_start is not None and window_end > active_start:
        intervals.append((active_start, window_end))

    return intervals
