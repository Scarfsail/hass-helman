from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Callable, TypeVar

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import (
    get_significant_states,
    state_changes_during_period,
)
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .config_read import read_float
from .energy_unwrap import (
    _INITIAL_UNWRAP_STATE,
    _TRANSIENT_REBOUND_WINDOW,
    _UnwrapState,
    _unwrap_energy_observations,
)
from .recorder_slot_energy import (
    _BOUNDARY_WRITE_SETTLE_WINDOW,
    _BoundarySample,
    _build_slot_energy_changes_from_boundaries,
    _carry_staleness_limit,
    _parse_energy_observations,
    _sample_energy_observations_at_boundaries,
    _states_for_entity,
)
from .slot_grid import (
    _get_local_day_start,
    floor_to_slot as get_local_current_slot_start,
    slot_starts as _build_local_slot_starts_until,
)


def get_today_completed_local_slots(
    reference_time: datetime,
    *,
    interval_minutes: int,
) -> list[datetime]:
    current_slot_start = get_local_current_slot_start(
        reference_time,
        interval_minutes=interval_minutes,
    )
    local_day_start = _get_local_day_start(reference_time)
    return _build_local_slot_starts_until(
        local_day_start,
        current_slot_start,
        interval_minutes=interval_minutes,
    )


def get_today_completed_local_slot_boundaries(
    reference_time: datetime,
    *,
    interval_minutes: int,
) -> list[datetime]:
    current_slot_start = get_local_current_slot_start(
        reference_time,
        interval_minutes=interval_minutes,
    )
    completed_slots = get_today_completed_local_slots(
        reference_time,
        interval_minutes=interval_minutes,
    )
    return [*completed_slots, current_slot_start]


@dataclass(frozen=True)
class _FrozenDayPrefix:
    """What a kept prefix of today has to agree on before it can be resumed.

    The three fields are the whole of the reuse key. ``local_date`` restarts
    the series at local midnight -- which is also what a timezone change moves
    -- ``interval_minutes`` because a prefix sampled on one grid says nothing
    about another, and ``frozen_through`` because a prefix reaching past the
    window that is being asked for is a clock that stepped backwards. The
    entity is the key the prefix is stored under, so a reconfigured entity id
    simply finds nothing.
    """

    local_date: date
    interval_minutes: int
    frozen_through: datetime


_FrozenPrefixT = TypeVar("_FrozenPrefixT", bound=_FrozenDayPrefix)


def _take_resumable_prefix(
    frozen_by_entity: dict[str, _FrozenPrefixT],
    entity_id: str,
    *,
    local_date: date,
    interval_minutes: int,
    utc_end: datetime,
) -> _FrozenPrefixT | None:
    """The kept prefix this read may resume from, dropping it if it may not.

    A new local day restarts the series, a different interval samples a
    different grid, and a clock that stepped backwards leaves the prefix ahead
    of the window. Any of them and the prefix cannot be resumed, so it is
    discarded and the day is read in full once.
    """
    frozen = frozen_by_entity.get(entity_id)
    if frozen is None:
        return None

    if (
        frozen.local_date != local_date
        or frozen.interval_minutes != interval_minutes
        or frozen.frozen_through > utc_end
    ):
        del frozen_by_entity[entity_id]
        return None

    return frozen


def _freeze_prefix(
    frozen_by_entity: dict[str, Any],
    entity_id: str,
    *,
    freeze_at: datetime | None,
    previously_frozen_through: datetime | None,
    factory: Callable[[datetime], Any],
) -> None:
    """Freeze a settled prefix into the entity cache if it has advanced."""
    if freeze_at is None or (
        previously_frozen_through is not None
        and freeze_at <= previously_frozen_through
    ):
        return

    frozen_by_entity[entity_id] = factory(freeze_at)


@dataclass(frozen=True)
class _FrozenSlotBoundaries(_FrozenDayPrefix):
    """A day's settled boundary samples, and where to resume reading them."""

    samples: dict[datetime, _BoundarySample]
    unwrap_state: _UnwrapState


class TodaySlotEnergyReader:
    """Today's per-slot energy deltas, re-reading only what is new.

    A completed slot is immutable — its value is the difference between two
    readings that are both in the past — so re-reading the day on every refresh
    re-derives 95 known values at 23:45 to learn one. Boundary samples old
    enough to have settled are kept and only the tail is queried again.

    Two things keep this from being a plain memo of the boundary samples. The
    unwrap that lifts a resetting counter into a monotonic series carries state
    across the whole day, so a resumed read has to pick up where the frozen
    prefix left off — a daily meter resets at midnight, which puts every day on
    that path. And a drop is only known to be a reset rather than a transient
    dip once the rebound window has passed without a rebound, so the newest
    boundaries cannot be frozen yet.

    Instances have to outlive a single refresh to be worth anything; the
    coordinator owns one.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._frozen_by_entity: dict[str, _FrozenSlotBoundaries] = {}

    async def async_query_slot_energy_changes(
        self,
        entity_id: str,
        reference_time: datetime,
        *,
        interval_minutes: int,
    ) -> dict[datetime, float]:
        local_day_start = _get_local_day_start(reference_time)
        local_end = get_local_current_slot_start(
            reference_time,
            interval_minutes=interval_minutes,
        )
        local_slot_starts = _build_local_slot_starts_until(
            local_day_start,
            local_end,
            interval_minutes=interval_minutes,
        )
        if not local_slot_starts:
            return {}

        utc_boundaries = [
            dt_util.as_utc(boundary) for boundary in [*local_slot_starts, local_end]
        ]
        utc_end = utc_boundaries[-1]
        frozen = _take_resumable_prefix(
            self._frozen_by_entity,
            entity_id,
            local_date=local_day_start.date(),
            interval_minutes=interval_minutes,
            utc_end=utc_end,
        )
        freeze_at = self._find_freeze_boundary(utc_boundaries, utc_end=utc_end)

        staleness_limit = _carry_staleness_limit(interval_minutes)
        # A resumed read already has the frozen prefix's carry stamped with
        # its own observation timestamp (see ``_freeze``), so its staleness
        # clock is already correct without widening. Only a cold read is
        # exposed to the recorder's start-time replay erasing the reading's
        # true age, so only it needs the lookback.
        query_start = (
            frozen.frozen_through
            if frozen
            else utc_boundaries[0] - staleness_limit
        )
        resume_state = frozen.unwrap_state if frozen else _INITIAL_UNWRAP_STATE
        carried_value = frozen.samples.get(frozen.frozen_through) if frozen else None
        pending_boundaries = [
            boundary
            for boundary in utc_boundaries
            if frozen is None or boundary > frozen.frozen_through
        ]

        default_unit = None
        current_state = self._hass.states.get(entity_id)
        if current_state is not None:
            default_unit = current_state.attributes.get("unit_of_measurement")

        # Same conditional join as the full-day read: the unit is stable across
        # a sensor's history, so the live state's sample makes the join
        # redundant, and without one the join is the only source of a unit.
        no_attributes = default_unit is not None

        def _query_and_parse() -> tuple[dict[datetime, _BoundarySample], _UnwrapState]:
            history = state_changes_during_period(
                self._hass,
                query_start,
                utc_end,
                entity_id,
                no_attributes,
                False,
                None,
                True,
            )
            states = history.get(entity_id) or history.get(entity_id.lower()) or []
            observations = _parse_energy_observations(states, default_unit=default_unit)
            if frozen is not None:
                # Whatever the recorder replays at the window start is already
                # folded into the resumed unwrap state and the carried sample.
                observations = [
                    observation
                    for observation in observations
                    if observation.updated_at > frozen.frozen_through
                ]

            unwrapped, unwrap_state = _unwrap_energy_observations(
                observations,
                resume_state=resume_state,
                freeze_at=freeze_at,
            )
            return (
                _sample_energy_observations_at_boundaries(
                    unwrapped,
                    pending_boundaries,
                    carried_value=carried_value,
                    staleness_limit=staleness_limit,
                ),
                unwrap_state,
            )

        pending_samples, unwrap_state = await get_instance(
            self._hass
        ).async_add_executor_job(_query_and_parse)

        samples = {**(frozen.samples if frozen else {}), **pending_samples}
        self._freeze(
            entity_id,
            local_date=local_day_start.date(),
            interval_minutes=interval_minutes,
            freeze_at=freeze_at,
            previously_frozen_through=frozen.frozen_through if frozen else None,
            samples=samples,
            unwrap_state=unwrap_state,
        )
        return _build_slot_energy_changes_from_boundaries(utc_boundaries, samples)

    @staticmethod
    def _find_freeze_boundary(
        utc_boundaries: list[datetime],
        *,
        utc_end: datetime,
    ) -> datetime | None:
        """The newest boundary whose sample can never change again.

        A drop at or before it must have had the full rebound window inside the
        queried span to be classified, and strictly inside: the recorder's end
        bound is exclusive, so a rebound landing exactly on ``utc_end`` would be
        invisible now and visible on the next read.
        """
        settled = [
            boundary
            for boundary in utc_boundaries
            if boundary + _TRANSIENT_REBOUND_WINDOW < utc_end
        ]
        return settled[-1] if settled else None

    def _freeze(
        self,
        entity_id: str,
        *,
        local_date: date,
        interval_minutes: int,
        freeze_at: datetime | None,
        previously_frozen_through: datetime | None,
        samples: dict[datetime, _BoundarySample],
        unwrap_state: _UnwrapState,
    ) -> None:
        _freeze_prefix(
            self._frozen_by_entity,
            entity_id,
            freeze_at=freeze_at,
            previously_frozen_through=previously_frozen_through,
            factory=lambda at: _FrozenSlotBoundaries(
                local_date=local_date,
                interval_minutes=interval_minutes,
                frozen_through=at,
                samples={
                    boundary: value
                    for boundary, value in samples.items()
                    if boundary <= at
                },
                unwrap_state=unwrap_state,
            ),
        )


@dataclass(frozen=True)
class _FrozenBoundaryValues(_FrozenDayPrefix):
    """A day's settled boundary readings of one numeric entity.

    ``carried_value`` is the reading in force at ``frozen_through``. A boundary
    with no write inside its own slot lives off the last one before it, which
    can be hours old and can be hidden from the resumed window by an
    ``unavailable`` row the recorder replays in its place -- so the value is
    kept rather than re-derived.
    """

    values: dict[datetime, float]
    carried_value: float | None


class TodaySlotBoundaryStateReader:
    """Today's numeric state at every slot boundary, re-reading only what is new.

    The counterpart of :class:`TodaySlotEnergyReader` for an entity whose state
    *is* the value -- battery state of charge is the one this exists for. It
    keeps the numeric-state semantics of
    :func:`_sample_rate_values_at_boundaries` exactly: a boundary takes the
    first write made inside its own slot and falls back to the last reading
    before it, and nothing here unwraps a counter or looks for a reset, because
    a percentage that falls has simply fallen.

    That sampling rule is also what settles a boundary: once its own slot has
    ended, no future write can claim it, so everything but the newest couple of
    boundaries is kept and only the tail is queried again. Instances have to
    outlive a single refresh to be worth anything; the coordinator owns one and
    hands it to every consumer of the same series.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._frozen_by_entity: dict[str, _FrozenBoundaryValues] = {}

    async def async_query_slot_boundary_state_values(
        self,
        entity_id: str,
        reference_time: datetime,
        *,
        interval_minutes: int,
    ) -> dict[datetime, float]:
        local_boundaries = get_today_completed_local_slot_boundaries(
            reference_time,
            interval_minutes=interval_minutes,
        )
        if not local_boundaries:
            return {}

        boundaries = [dt_util.as_utc(boundary) for boundary in local_boundaries]
        slot_duration = timedelta(minutes=interval_minutes)
        # The newest boundary prefers a write made inside its own slot, so the
        # window has to reach one slot past it -- and no further. The read this
        # replaces left the end open, which asks the recorder for every row to
        # the end of the table when the last one that can matter is this.
        utc_end = boundaries[-1] + slot_duration
        local_date = _get_local_day_start(reference_time).date()
        frozen = _take_resumable_prefix(
            self._frozen_by_entity,
            entity_id,
            local_date=local_date,
            interval_minutes=interval_minutes,
            utc_end=utc_end,
        )
        # Resume at the frozen boundary and retain its cached carry. The
        # recorder's opening replay precedes that boundary, so it may be older
        # than a real write exactly on the boundary that we already sampled.
        query_start = frozen.frozen_through if frozen else boundaries[0]
        pending_boundaries = [
            boundary
            for boundary in boundaries
            if frozen is None or boundary > frozen.frozen_through
        ]
        freeze_at = self._find_freeze_boundary(
            boundaries,
            slot_duration=slot_duration,
        )

        carried_value = frozen.carried_value if frozen else None

        def _query_and_parse() -> tuple[dict[datetime, float], float | None]:
            history = state_changes_during_period(
                self._hass,
                query_start,
                utc_end,
                entity_id,
                True,
                False,
                None,
                True,
            )
            parsed = _parse_state_values(_states_for_entity(history, entity_id))
            if frozen is not None:
                parsed = [item for item in parsed if item[0] > query_start]
            # This reader serves the live rail, whose slots are all inside the
            # running process's own day, so a carry here needs no provenance:
            # the flag is projected away and the cached shape stays floats.
            return (
                {
                    boundary: sample.value
                    for boundary, sample in _sample_rate_values_from_parsed(
                        parsed,
                        pending_boundaries,
                        interval_minutes=interval_minutes,
                        carried_value=carried_value,
                    ).items()
                },
                None
                if freeze_at is None
                else _value_in_force_at(parsed, freeze_at, fallback=carried_value),
            )

        pending_values, carry_at_freeze = await get_instance(
            self._hass
        ).async_add_executor_job(_query_and_parse)
        values = {**(frozen.values if frozen else {}), **pending_values}
        self._freeze(
            entity_id,
            local_date=local_date,
            interval_minutes=interval_minutes,
            freeze_at=freeze_at,
            previously_frozen_through=frozen.frozen_through if frozen else None,
            values=values,
            carried_value=carry_at_freeze,
        )
        return values

    @staticmethod
    def _find_freeze_boundary(
        boundaries: list[datetime],
        *,
        slot_duration: timedelta,
    ) -> datetime | None:
        """The newest boundary whose reading can never change again.

        The margin is measured from the read, which is inside the last
        boundary's own slot -- not from ``utc_end``, which is that slot's end
        and so up to a whole slot in the future. Measuring against the end
        would spend the write margin on time that has not passed yet, leaving
        nothing of it at an interval of thirty minutes or more, and a reading
        the recorder commits late would be frozen stale -- see
        ``_BOUNDARY_WRITE_SETTLE_WINDOW``.
        """
        read_at = boundaries[-1]
        settled = [
            boundary
            for boundary in boundaries
            if boundary + slot_duration + _BOUNDARY_WRITE_SETTLE_WINDOW <= read_at
        ]
        return settled[-1] if settled else None

    def _freeze(
        self,
        entity_id: str,
        *,
        local_date: date,
        interval_minutes: int,
        freeze_at: datetime | None,
        previously_frozen_through: datetime | None,
        values: dict[datetime, float],
        carried_value: float | None,
    ) -> None:
        _freeze_prefix(
            self._frozen_by_entity,
            entity_id,
            freeze_at=freeze_at,
            previously_frozen_through=previously_frozen_through,
            factory=lambda at: _FrozenBoundaryValues(
                local_date=local_date,
                interval_minutes=interval_minutes,
                frozen_through=at,
                values={
                    boundary: value
                    for boundary, value in values.items()
                    if boundary <= at
                },
                carried_value=carried_value,
            ),
        )


async def query_slot_boundary_state_values_for_entities(
    hass: HomeAssistant,
    entity_ids: Sequence[str],
    *,
    local_start: datetime,
    local_end: datetime,
    interval_minutes: int,
) -> dict[str, dict[datetime, RateSample]]:
    """Sample several entities' recorded states at every slot boundary, in ONE read.

    The caller names the window the way :func:`query_cumulative_slot_energy_changes`
    does, so a day that ended a week ago can be sampled as readily as the one in
    progress -- the difference from the today-scoped
    :class:`TodaySlotBoundaryStateReader`.

    Boundaries are the slot *starts* in ``[local_start, local_end)``. Each takes
    the first state written *inside* its own slot, and only falls back to the
    last state before it when the slot contains no write at all -- see
    :func:`_sample_rate_values_at_boundaries` for why a rate needs that rather
    than the plain carry-forward a meter gets. Slots before an entity's first
    ever reading are absent rather than guessed.

    The recorder runs its queries on a single DB executor thread, so N separate
    calls are N serial round-trips no matter how they are awaited;
    ``get_significant_states`` takes a list of entity ids, which turns them into
    one.

    Every sample says whether its slot was written to or lives off a carry --
    see :class:`RateSample`. The one production caller,
    :func:`~.recorder_statistics_span.query_price_history`, reads history from
    windows that may predate the running process, where a carry across an
    outage is indistinguishable from a quiet sensor unless the sample says
    which it was.

    Returns a map keyed by entity id. An entity the recorder has nothing for maps
    to ``{}``.
    """
    unique_entity_ids = list(dict.fromkeys(eid for eid in entity_ids if eid))
    if not unique_entity_ids:
        return {}

    local_boundaries = _build_local_slot_starts_until(
        local_start,
        local_end,
        interval_minutes=interval_minutes,
    )
    if not local_boundaries:
        return {entity_id: {} for entity_id in unique_entity_ids}

    boundaries = [dt_util.as_utc(boundary) for boundary in local_boundaries]
    utc_end = dt_util.as_utc(local_end)

    def _query_and_parse() -> dict[str, dict[datetime, RateSample]]:
        history = get_significant_states(
            hass,
            boundaries[0],
            utc_end,
            entity_ids=unique_entity_ids,
            filters=None,
            include_start_time_state=True,
            # The singular query reads real state changes only; this one has to
            # read the same rows or it is not the same function. These are rate
            # sensors, and no ``sensor`` is in a significant domain, so True
            # applies exactly the filter the singular query applies.
            significant_changes_only=True,
            minimal_response=False,
            no_attributes=True,
            compressed_state_format=False,
        )
        return {
            entity_id: _sample_rate_values_at_boundaries(
                _states_for_entity(history, entity_id),
                boundaries,
                # The read opens at the first boundary with
                # ``include_start_time_state``, so a row stamped exactly there is
                # its opening replay and not a write into that slot.
                replay_instant=boundaries[0],
                interval_minutes=interval_minutes,
            )
            for entity_id in unique_entity_ids
        }

    return await get_instance(hass).async_add_executor_job(_query_and_parse)


def _parse_state_values(states: list[Any]) -> list[tuple[datetime, float]]:
    """A recorder's rows as ``(instant, value)``, oldest first.

    Rows without a timestamp and rows whose state is not a number --
    ``unavailable`` and ``unknown``, which every sensor emits sooner or later --
    are dropped rather than read as a value.
    """
    parsed: list[tuple[datetime, float]] = []
    for state in states:
        last_updated = getattr(state, "last_updated", None)
        if last_updated is None:
            continue
        value = read_float(getattr(state, "state", None))
        if value is None:
            continue
        parsed.append((dt_util.as_utc(last_updated), value))
    parsed.sort(key=lambda item: item[0])
    return parsed


def _value_in_force_at(
    parsed: list[tuple[datetime, float]],
    instant: datetime,
    *,
    fallback: float | None,
) -> float | None:
    """The last reading written at or before ``instant``, else ``fallback``."""
    for parsed_instant, value in reversed(parsed):
        if parsed_instant <= instant:
            return value
    return fallback


@dataclass(frozen=True)
class RateSample:
    """One slot's sampled rate, and whether the slot itself was written to.

    ``observed`` is true exactly when the write that set ``value`` landed inside
    this slot, and false when the value was carried into it from an earlier
    write. Both are legitimate readings -- a rate is a level, so the last state
    written before a slot is the rate in force during it -- but they are not
    equally *evidenced*: a carried slot says only that nobody wrote anything,
    which is what a quiet sensor and a stopped recorder both look like from here.

    The distinction is the raw pass's own knowledge and costs nothing to keep,
    so it travels with the value rather than being reconstructed by whoever
    needs to judge a carry later. The judge is
    :func:`~.recorder_statistics_span.query_price_history`.
    """

    value: float
    observed: bool


def _sample_rate_values_at_boundaries(
    states: list[Any],
    boundaries: list[datetime],
    *,
    interval_minutes: int,
    carried_value: float | None = None,
    replay_instant: datetime | None = None,
) -> dict[datetime, RateSample]:
    """Sample a rate entity per slot, preferring the write made inside the slot.

    A meter is sampled with a plain carry-forward — its value at the boundary is
    the reading that boundary had. A rate is not that: the state carries the
    price *in force*, and a producer publishing on the slot grid writes it a
    moment after the boundary it belongs to, not a moment before. Taking the
    last state at or before the boundary would then hand every slot its
    predecessor's price, shifting the whole rail one slot late at every change —
    which is wrong by a whole slot at exactly the boundaries that matter, the
    ones where the price moves.

    So the first write landing inside ``[boundary, boundary + interval)`` wins,
    and the carry-forward is the fallback for slots that contain no write, which
    is the normal case for an entity that only publishes on change. A write
    genuinely made part-way through a slot is credited to the whole of it; no
    single value can do better, and the alternative errs by a whole slot instead
    of part of one.

    ``replay_instant`` marks the read's opening replay so that it is not mistaken
    for such a write -- see :func:`_sample_rate_values_from_parsed`.
    """
    return _sample_rate_values_from_parsed(
        _parse_state_values(states),
        boundaries,
        interval_minutes=interval_minutes,
        carried_value=carried_value,
        replay_instant=replay_instant,
    )


def _sample_rate_values_from_parsed(
    parsed: list[tuple[datetime, float]],
    boundaries: list[datetime],
    *,
    interval_minutes: int,
    carried_value: float | None = None,
    replay_instant: datetime | None = None,
) -> dict[datetime, RateSample]:
    """:func:`_sample_rate_values_at_boundaries` over rows already parsed.

    ``carried_value`` is the reading in force before the window opened, which a
    resumed read holds from its settled prefix. It cannot be recovered from the
    window's own rows: the recorder replays whatever was last written, and a
    sensor that went ``unavailable`` before the window replays as nothing at
    all, which would drop every boundary that had been living off the carry.

    Every sample carries whether it was written inside its own slot or carried
    into it -- see :class:`RateSample`. A carry seeded by ``carried_value`` is
    no different from one seeded by a row in this window: neither slot was
    written to.

    ``replay_instant`` is the query start of a read made with
    ``include_start_time_state``, where a row stamped exactly there is the
    recorder's opening replay rather than a write. The recorder selects that row
    with a literal zero timestamp and Home Assistant stamps it with the query
    start, which erases the real age of whatever it replays -- so without this
    the first slot of every window would look written to, and an outage that
    began before the window would be vouched for by its own stale reading. The
    replayed value still seeds the carry, because it really is the reading in
    force; it just is not evidence of anything. A caller that has already
    stripped the replay itself passes ``carried_value`` instead, and the two are
    never both needed.
    """
    if not boundaries:
        return {}

    span = timedelta(minutes=interval_minutes)
    samples: dict[datetime, RateSample] = {}
    index = 0
    carried = carried_value
    if replay_instant is not None and parsed and parsed[0][0] == replay_instant:
        carried = parsed[0][1]
        index = 1
    for boundary in boundaries:
        # Everything written before this slot began is only a fallback for it.
        while index < len(parsed) and parsed[index][0] < boundary:
            carried = parsed[index][1]
            index += 1
        if index < len(parsed) and parsed[index][0] < boundary + span:
            samples[boundary] = RateSample(value=parsed[index][1], observed=True)
        elif carried is not None:
            samples[boundary] = RateSample(value=carried, observed=False)
    return samples


def _sample_state_values_at_boundaries(
    states: list[Any],
    boundaries: list[datetime],
) -> dict[datetime, float]:
    if not states or not boundaries:
        return {}

    samples: dict[datetime, float] = {}
    state_index = 0
    latest_value: float | None = None

    for boundary in boundaries:
        while state_index < len(states):
            state = states[state_index]
            last_updated = getattr(state, "last_updated", None)
            if last_updated is None:
                state_index += 1
                continue

            state_updated_utc = dt_util.as_utc(last_updated)
            if state_updated_utc > boundary:
                break

            parsed_value = read_float(getattr(state, "state", None))
            if parsed_value is not None:
                latest_value = parsed_value
            state_index += 1

        if latest_value is not None:
            samples[boundary] = latest_value

    return samples
