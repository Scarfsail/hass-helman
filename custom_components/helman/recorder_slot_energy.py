from __future__ import annotations

import logging
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import (
    get_significant_states,
    state_changes_during_period,
)
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .config_read import read_float
from .energy_units import normalize_energy_to_kwh
from .energy_unwrap import (
    _ENERGY_TOLERANCE_KWH,
    _EnergyObservation,
    _build_unwrapped_energy_observations,
)
from .slot_grid import slot_starts

_LOGGER = logging.getLogger(__name__)

#: How long after a slot has ended its boundary sample can still move.
#:
#: A boundary reading is settled once every write that could claim it is in the
#: past, which is one slot after the boundary itself -- but the recorder commits
#: a row some time after the instant it stamps it with, so a write made just
#: before a slot ended can still land in the database after it has. The margin
#: is what keeps a settled prefix from freezing a sample the recorder had not
#: finished writing; two extra quarter-hour boundaries is a cheap price for it.
_BOUNDARY_WRITE_SETTLE_WINDOW = timedelta(minutes=30)


def _carry_staleness_limit(interval_minutes: int) -> timedelta:
    """How old a carried meter reading can be before it is distrusted.

    A recorder gap -- Home Assistant restarted, the container down, the
    database locked -- carries the last reading forward to every boundary
    inside the gap with nothing to say it is stale, which zeroes the gap's
    slots and dumps the whole outage's energy on the first slot that sees a
    fresh reading. The limit is a multiple of the slot rather than the slot
    itself: a meter that only publishes on change can be legitimately quiet
    for a stretch longer than one interval, and a limit of exactly one slot
    would flag that as a gap. The floor keeps a coarse grid -- hourly
    long-term statistics backfill, in particular -- from inheriting an
    implausibly long staleness window just because its slot is big.
    """
    return timedelta(minutes=max(2 * interval_minutes, 30))


@dataclass(frozen=True)
class _BoundarySample:
    """A boundary's carried meter value, and when the reading behind it was real.

    ``observed_at`` is the last real observation's timestamp, independent of
    which boundary the value happened to be carried to. A staleness
    judgement -- and a resumed :class:`TodaySlotEnergyReader` read's staleness
    clock -- needs the reading's own age, not the boundary it lands on, which
    is why the two travel together instead of the boundary sample being a
    bare float.
    """

    value_kwh: float
    observed_at: datetime | None


#: How many windows one raw-history read covers when a caller wants several.
#:
#: The recorder answers one query at a time on one thread, so a ninety-day
#: training window read a day at a time is ninety serial round-trips. A week of
#: one meter's raw states is a few thousand rows, which is small enough to hold
#: and large enough to make the trip worth taking -- and bounding the chunk is
#: what keeps a long window from turning into one unbounded read.
_MAX_WINDOWS_PER_HISTORY_READ = 7


class _RestampedState:
    """A recorder row moved to a window's start, the way the recorder does it.

    ``include_start_time_state`` hands back the last row before the window
    stamped at the window start rather than at its own instant. A window carved
    out of a wider read has to do the same, or its opening carry arrives older
    than the recorder would have reported it and the first boundaries read as
    stale for no reason.
    """

    __slots__ = ("attributes", "last_updated", "state")

    def __init__(self, source: Any, instant: datetime) -> None:
        self.last_updated = instant
        self.state = getattr(source, "state", None)
        self.attributes = getattr(source, "attributes", None)


@dataclass(frozen=True)
class _SlotWindowPlan:
    local_slot_starts: list[datetime]
    utc_boundaries: list[datetime]
    query_start: datetime
    query_end: datetime
    staleness_limit: timedelta


def _plan_slot_window(
    local_start: datetime,
    local_end: datetime,
    *,
    interval_minutes: int,
) -> _SlotWindowPlan | None:
    local_slot_starts = slot_starts(
        local_start,
        local_end,
        interval_minutes=interval_minutes,
    )
    if not local_slot_starts:
        return None
    local_boundaries = [*local_slot_starts, local_end]
    utc_boundaries = [dt_util.as_utc(boundary) for boundary in local_boundaries]
    staleness_limit = _carry_staleness_limit(interval_minutes)
    return _SlotWindowPlan(
        local_slot_starts=local_slot_starts,
        utc_boundaries=utc_boundaries,
        query_start=utc_boundaries[0] - staleness_limit,
        query_end=utc_boundaries[-1],
        staleness_limit=staleness_limit,
    )


async def query_cumulative_slot_energy_changes(
    hass: HomeAssistant,
    entity_id: str,
    *,
    local_start: datetime,
    local_end: datetime,
    interval_minutes: int,
    liveness_instants: Sequence[datetime] | None = None,
) -> dict[datetime, float]:
    """One cumulative meter's per-slot energy deltas.

    ``liveness_instants`` is the recorder write trace that tells a quiet meter
    apart from a recorder outage (see :func:`_is_carry_stale`). A single-entity
    read cannot gather one -- the entity's own silence is the thing being
    judged -- so a caller that has one from elsewhere has to hand it over.
    :func:`query_cumulative_slot_energy_changes_for_entities` returns exactly
    that, which is where the inspector's solar read gets its trace.
    """
    plan = _plan_slot_window(local_start, local_end, interval_minutes=interval_minutes)
    if plan is None:
        return {}

    default_unit = None
    current_state = hass.states.get(entity_id)
    if current_state is not None:
        default_unit = current_state.attributes.get("unit_of_measurement")

    # A sensor's unit does not change across its history, so once the live
    # state has given us one the attributes join buys nothing. Without one the
    # join is the only source of a unit, and dropping it would normalize every
    # row to None and hand back an empty history.
    no_attributes = default_unit is not None

    sorted_liveness_instants = (
        None if liveness_instants is None else sorted(liveness_instants)
    )

    def _query_and_parse() -> dict[datetime, float]:
        history = state_changes_during_period(
            hass,
            plan.query_start,
            plan.query_end,
            entity_id,
            no_attributes,
            False,
            None,
            True,
        )
        return _slot_energy_changes_from_states(
            _states_for_entity(history, entity_id),
            default_unit=default_unit,
            utc_boundaries=plan.utc_boundaries,
            staleness_limit=plan.staleness_limit,
            liveness_instants=sorted_liveness_instants,
        )

    return await get_instance(hass).async_add_executor_job(_query_and_parse)


async def query_cumulative_slot_energy_changes_for_windows(
    hass: HomeAssistant,
    entity_id: str,
    windows: Sequence[tuple[datetime, datetime]],
    *,
    interval_minutes: int,
    max_windows_per_read: int = _MAX_WINDOWS_PER_HISTORY_READ,
) -> list[dict[datetime, float]]:
    """One meter's per-slot deltas for several windows, a few windows per read.

    Window for window, the same result
    :func:`query_cumulative_slot_energy_changes` returns for each of them on its
    own. Each window is still parsed, unwrapped and sampled by itself, over its
    own staleness lookback and with its own opening carry, so counter resets and
    boundary sampling see exactly the rows the single-window read would have
    seen. The only thing that changes is how many times the recorder is asked.

    Returns one dict per window, in the order the windows were given. A window
    with no slots in it comes back empty, matching the singular function.
    """
    results: list[dict[datetime, float]] = [{} for _ in windows]
    if not entity_id or not windows:
        return results

    prepared: dict[int, _SlotWindowPlan] = {}
    for index, (local_start, local_end) in enumerate(windows):
        plan = _plan_slot_window(
            local_start,
            local_end,
            interval_minutes=interval_minutes,
        )
        if plan is not None:
            prepared[index] = plan

    if not prepared:
        return results

    default_unit = None
    current_state = hass.states.get(entity_id)
    if current_state is not None:
        default_unit = current_state.attributes.get("unit_of_measurement")
    # See the singular query for why the attributes join can only be dropped
    # once the live state has supplied a unit.
    no_attributes = default_unit is not None

    indices = sorted(prepared)
    chunks = [
        indices[offset : offset + max_windows_per_read]
        for offset in range(0, len(indices), max_windows_per_read)
    ]

    for chunk in chunks:
        query_start = min(prepared[index].query_start for index in chunk)
        query_end = max(prepared[index].query_end for index in chunk)

        def _query_and_parse(
            chunk: list[int] = chunk,
            query_start: datetime = query_start,
            query_end: datetime = query_end,
        ) -> dict[int, dict[datetime, float]]:
            history = state_changes_during_period(
                hass,
                query_start,
                query_end,
                entity_id,
                no_attributes,
                False,
                None,
                True,
            )
            states = [
                state
                for state in _states_for_entity(history, entity_id)
                if getattr(state, "last_updated", None) is not None
            ]
            instants = [dt_util.as_utc(state.last_updated) for state in states]
            return {
                index: _slot_energy_changes_from_states(
                    _states_within(
                        states,
                        instants,
                        prepared[index].query_start,
                        prepared[index].query_end,
                        query_start=query_start,
                    ),
                    default_unit=default_unit,
                    utc_boundaries=prepared[index].utc_boundaries,
                    staleness_limit=prepared[index].staleness_limit,
                )
                for index in chunk
            }

        for index, values in (
            await get_instance(hass).async_add_executor_job(_query_and_parse)
        ).items():
            results[index] = values

    return results


def _states_within(
    states: list[Any],
    instants: list[datetime],
    window_start: datetime,
    window_end: datetime,
    *,
    query_start: datetime,
) -> list[Any]:
    """The rows a read of ``(window_start, window_end)`` alone would have returned.

    ``instants`` is ``states`` mapped to UTC, ascending, so the slice is two
    bisections rather than a scan of the whole chunk per window. The recorder
    keeps rows stamped after the start and strictly before the end, and carries
    the last row stamped strictly before the start; the carry is prepended
    restamped, which is what ``include_start_time_state`` does with it.
    """
    # At the outer query's start, a row stamped exactly there is its opening
    # replay, not a real boundary write. Keep it for every window sharing that
    # start; interior windows still exclude real writes at their start.
    if window_start == query_start:
        return states[: bisect_left(instants, window_end)]
    before = bisect_left(instants, window_start)
    first = bisect_right(instants, window_start)
    last = bisect_left(instants, window_end)
    within = states[first:last]
    if before == 0:
        return within
    return [_RestampedState(states[before - 1], window_start), *within]


@dataclass(frozen=True)
class SlotEnergyBatch:
    """A batched meter read: the per-entity deltas, and what the read saw of the recorder.

    ``liveness_instants`` is every observation timestamp the read touched,
    across every entity in it, sorted. It is the batch's own evidence that the
    recorder was recording at those moments, which is what tells a quiet meter
    apart from an outage (see :func:`_is_carry_stale`). It travels with the
    deltas so that a caller reading one more meter on its own can pass the
    trace to that read rather than fall back on age alone, which is issue #208:
    the inspector's solar series took it that way until it began reading the
    solar column out of the batch itself.
    """

    by_entity: dict[str, dict[datetime, float]]
    liveness_instants: list[datetime]


async def query_cumulative_slot_energy_changes_for_entities(
    hass: HomeAssistant,
    entity_ids: Sequence[str],
    *,
    local_start: datetime,
    local_end: datetime,
    interval_minutes: int,
) -> SlotEnergyBatch:
    """The per-slot energy deltas of several cumulative meters, in ONE recorder read.

    Same per-entity shape and same semantics as
    :func:`query_cumulative_slot_energy_changes`, for a set of entities that
    share a window and a grid. The recorder runs its queries on a single DB
    executor thread, so N separate calls are N serial round-trips no matter how
    they are awaited; ``get_significant_states`` takes a list of entity ids,
    which turns them into one.

    Returns a :class:`SlotEnergyBatch` whose ``by_entity`` is keyed by entity
    id. An entity the recorder has nothing for maps to ``{}``, matching the
    singular function.
    """
    unique_entity_ids = list(dict.fromkeys(eid for eid in entity_ids if eid))
    if not unique_entity_ids:
        return SlotEnergyBatch(by_entity={}, liveness_instants=[])

    plan = _plan_slot_window(
        local_start,
        local_end,
        interval_minutes=interval_minutes,
    )
    if plan is None:
        return SlotEnergyBatch(
            by_entity={entity_id: {} for entity_id in unique_entity_ids},
            liveness_instants=[],
        )

    default_units: dict[str, str | None] = {}
    for entity_id in unique_entity_ids:
        current_state = hass.states.get(entity_id)
        default_units[entity_id] = (
            None
            if current_state is None
            else current_state.attributes.get("unit_of_measurement")
        )

    # One query has to serve every entity, so the attributes join can only be
    # dropped when no entity needs it — see the singular function for why an
    # entity without a live unit needs it at all.
    no_attributes = all(unit is not None for unit in default_units.values())

    def _query_and_parse() -> SlotEnergyBatch:
        history = get_significant_states(
            hass,
            plan.query_start,
            plan.query_end,
            entity_ids=unique_entity_ids,
            filters=None,
            include_start_time_state=True,
            # The singular query reads real state changes only; this one has to
            # read the same rows or it is not the same function. Left False, an
            # attribute-only write — a utility_meter republishing last_period
            # while its value stands still — becomes an extra observation, and
            # the unwrap reads a dip it would have ignored as the series' last
            # reading as a counter reset, inventing a slot the size of the whole
            # meter. None of these entities is in a significant domain, so True
            # applies exactly the filter the singular query applies.
            significant_changes_only=True,
            minimal_response=False,
            no_attributes=no_attributes,
            compressed_state_format=False,
        )
        # Parse every entity first, then sample: an entity's carry is judged
        # against what the *whole* batch saw of the recorder, so the trace has
        # to be complete before the first boundary is judged. The unwrap runs
        # here rather than inside the sampler for the same reason — it is the
        # step that turns rows into observations, and the trace is built from
        # those.
        observations_by_entity = {
            entity_id: _build_unwrapped_energy_observations(
                _parse_energy_observations(
                    _states_for_entity(history, entity_id),
                    default_unit=default_units[entity_id],
                )
            )
            for entity_id in unique_entity_ids
        }
        liveness_instants = sorted(
            observation.updated_at
            for observations in observations_by_entity.values()
            for observation in observations
        )
        by_entity = {}
        for entity_id, observations in observations_by_entity.items():
            boundary_samples = _sample_energy_observations_at_boundaries(
                observations,
                plan.utc_boundaries,
                staleness_limit=plan.staleness_limit,
                liveness_instants=liveness_instants,
            )
            by_entity[entity_id] = _build_slot_energy_changes_from_boundaries(
                plan.utc_boundaries, boundary_samples
            )
        return SlotEnergyBatch(
            by_entity=by_entity, liveness_instants=liveness_instants
        )

    return await get_instance(hass).async_add_executor_job(_query_and_parse)


def _states_for_entity(history: Any, entity_id: str) -> list[Any]:
    return (history or {}).get(entity_id) or (history or {}).get(entity_id.lower()) or []


def _slot_energy_changes_from_states(
    states: list[Any],
    *,
    default_unit: str | None,
    utc_boundaries: list[datetime],
    staleness_limit: timedelta | None,
    liveness_instants: Sequence[datetime] | None = None,
) -> dict[datetime, float]:
    observations = _build_unwrapped_energy_observations(
        _parse_energy_observations(states, default_unit=default_unit)
    )
    boundary_samples = _sample_energy_observations_at_boundaries(
        observations,
        utc_boundaries,
        staleness_limit=staleness_limit,
        liveness_instants=liveness_instants,
    )
    return _build_slot_energy_changes_from_boundaries(utc_boundaries, boundary_samples)


def _build_slot_energy_changes_from_boundaries(
    boundaries: list[datetime],
    samples: dict[datetime, _BoundarySample],
) -> dict[datetime, float]:
    values_by_slot: dict[datetime, float] = {}
    for index, slot_start in enumerate(boundaries[:-1]):
        slot_end = boundaries[index + 1]
        start_sample = samples.get(slot_start)
        end_sample = samples.get(slot_end)
        if start_sample is None or end_sample is None:
            continue

        delta = end_sample.value_kwh - start_sample.value_kwh
        if delta < 0:
            continue

        values_by_slot[slot_start] = delta

    return values_by_slot


def _sample_energy_observations_at_boundaries(
    observations: list[_EnergyObservation],
    boundaries: list[datetime],
    *,
    carried_value: _BoundarySample | None = None,
    staleness_limit: timedelta | None = None,
    liveness_instants: Sequence[datetime] | None = None,
) -> dict[datetime, _BoundarySample]:
    """Sample the series at each boundary, carrying the last value forward.

    ``carried_value`` is the value in force before the first observation, which
    a resumed read has from its frozen prefix. Without it a stretch of
    boundaries with no readings between them would go unsampled here and its
    slots would drop out of the result.

    ``staleness_limit`` distrusts a carry that has stood too long -- see
    :func:`_is_carry_stale`. ``None`` disables the check and restores a plain
    carry-forward, for the one caller (the appliance active-hours estimator)
    whose boundaries are active-state transitions rather than a fixed slot
    grid, so the "multiple of the interval" shape the limit is expressed in
    does not apply to it.

    ``liveness_instants`` is the recorder's write trace across the window,
    which rescues a carry the staleness limit would otherwise condemn -- again
    see :func:`_is_carry_stale`.
    """
    if not boundaries:
        return {}

    samples: dict[datetime, _BoundarySample] = {}
    observation_index = 0
    latest_value = carried_value.value_kwh if carried_value is not None else None
    latest_value_at = carried_value.observed_at if carried_value is not None else None

    for boundary in boundaries:
        while observation_index < len(observations):
            observation = observations[observation_index]
            if observation.updated_at > boundary:
                break

            latest_value = observation.value_kwh
            latest_value_at = observation.updated_at
            observation_index += 1

        if latest_value is None:
            continue

        if staleness_limit is not None and _is_carry_stale(
            boundary=boundary,
            latest_value=latest_value,
            latest_value_at=latest_value_at,
            next_observation=(
                observations[observation_index]
                if observation_index < len(observations)
                else None
            ),
            staleness_limit=staleness_limit,
            liveness_instants=liveness_instants,
        ):
            continue

        samples[boundary] = _BoundarySample(
            value_kwh=latest_value, observed_at=latest_value_at
        )

    return samples


def _is_carry_stale(
    *,
    boundary: datetime,
    latest_value: float,
    latest_value_at: datetime | None,
    next_observation: _EnergyObservation | None,
    staleness_limit: timedelta,
    liveness_instants: Sequence[datetime] | None = None,
) -> bool:
    """Age alone does not condemn a carry -- the recorder has to have been down.

    Staleness alone would drop every night slot of an on-change meter that
    legitimately publishes nothing while the house is quiet, throwing away
    real zeros. Two things can rescue such a carry, and either is enough.

    ``liveness_instants`` is the decisive one (issue #208): timestamps at
    which *something* was written to the recorder, gathered across every
    entity of a batched read. One of them falling between the carried
    reading and this boundary proves the recorder was recording while this
    meter said nothing, which is a quiet meter and not an outage, so the
    boundary keeps its carry and the slot records its real zero. ``None``
    means the caller has no such evidence -- a single-entity read cannot
    produce any on its own -- and leaves the judgement to the clauses below.

    The other is the meter's own next reading matching what was carried
    (decision 5 of #182). It is kept because it is not wrong, but it is very
    nearly unreachable against a real recorder: Home Assistant writes no row
    for an unchanged state, and a meter publishes precisely *because* it
    moved, so the first reading after a quiet stretch essentially always
    differs. It cannot carry this on its own, which is what #208 was.

    A carry with no known age -- ``latest_value_at`` is ``None`` because
    nothing real has been seen yet -- can't be judged and is trusted as
    before. A stretch with no next reading at all, the window ending inside
    it, falls back on age: there is nothing left to compare against.
    """
    if latest_value_at is None or boundary - latest_value_at <= staleness_limit:
        return False
    if _recorder_was_live_between(liveness_instants, latest_value_at, boundary):
        return False
    if next_observation is None:
        return True
    return abs(next_observation.value_kwh - latest_value) > _ENERGY_TOLERANCE_KWH


def _recorder_was_live_between(
    liveness_instants: Sequence[datetime] | None,
    after: datetime,
    through: datetime,
) -> bool:
    """Did anything at all reach the recorder in ``(after, through]``?

    ``liveness_instants`` is sorted, so this is one bisection rather than a
    scan: a day of 15-minute slots asks it ~96 times per entity against a list
    holding every observation of every meter in the batch.
    """
    if not liveness_instants:
        return False
    index = bisect_right(liveness_instants, after)
    return index < len(liveness_instants) and liveness_instants[index] <= through


def _read_energy_state_kwh(state: Any, *, default_unit: Any) -> float | None:
    parsed_value = read_float(getattr(state, "state", None))
    if parsed_value is None:
        return None

    attributes = getattr(state, "attributes", None)
    raw_unit = default_unit
    if isinstance(attributes, dict):
        raw_unit = attributes.get("unit_of_measurement", default_unit)

    return normalize_energy_to_kwh(
        parsed_value,
        raw_unit,
        default_unit=default_unit,
    )


def _parse_energy_observations(
    states: list[Any],
    *,
    default_unit: Any,
) -> list[_EnergyObservation]:
    observations: list[_EnergyObservation] = []
    for state in states:
        last_updated = getattr(state, "last_updated", None)
        if last_updated is None:
            continue

        parsed_value = _read_energy_state_kwh(
            state,
            default_unit=default_unit,
        )
        if parsed_value is None:
            continue

        observations.append(
            _EnergyObservation(
                updated_at=dt_util.as_utc(last_updated),
                value_kwh=parsed_value,
            )
        )

    return observations
