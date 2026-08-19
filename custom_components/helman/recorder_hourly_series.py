from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .energy_units import normalize_energy_to_kwh

_TRANSIENT_REBOUND_WINDOW = timedelta(minutes=30)
_ENERGY_TOLERANCE_KWH = 1e-6


@dataclass(frozen=True)
class _EnergyObservation:
    updated_at: datetime
    value_kwh: float


@dataclass(frozen=True)
class _UnwrapState:
    """Where the unwrap of a resetting counter stands part-way through a series.

    ``offset_kwh`` is what every later reading is lifted by, ``segment_value_kwh``
    the running maximum reset detection compares against. Both are meaningless
    on their own and useless apart, so they travel together.
    """

    offset_kwh: float
    segment_value_kwh: float | None


_INITIAL_UNWRAP_STATE = _UnwrapState(offset_kwh=0.0, segment_value_kwh=None)


def get_local_current_slot_start(
    reference_time: datetime,
    *,
    interval_minutes: int,
) -> datetime:
    validated_interval_minutes = _validate_interval_minutes(interval_minutes)
    local_day_start = _get_local_day_start(reference_time)
    local_reference = dt_util.as_local(reference_time)
    slot_duration_seconds = validated_interval_minutes * 60
    # Floor from local midnight in UTC so DST gaps/repeated hours normalize to
    # real local slot boundaries instead of synthetic wall-clock timestamps.
    elapsed_seconds = max(
        0.0,
        (
            dt_util.as_utc(local_reference) - dt_util.as_utc(local_day_start)
        ).total_seconds(),
    )
    slot_index = int(elapsed_seconds // slot_duration_seconds)
    slot_start_utc = dt_util.as_utc(local_day_start) + timedelta(
        seconds=slot_index * slot_duration_seconds
    )
    return dt_util.as_local(slot_start_utc)


def get_local_current_hour_start(reference_time: datetime) -> datetime:
    return get_local_current_slot_start(reference_time, interval_minutes=60)


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


def get_today_completed_local_hours(reference_time: datetime) -> list[datetime]:
    return get_today_completed_local_slots(reference_time, interval_minutes=60)


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


async def query_slot_energy_changes(
    hass: HomeAssistant,
    entity_id: str,
    reference_time: datetime,
    *,
    interval_minutes: int,
) -> dict[datetime, float]:
    return await query_cumulative_slot_energy_changes(
        hass,
        entity_id,
        local_start=_get_local_day_start(reference_time),
        local_end=get_local_current_slot_start(
            reference_time,
            interval_minutes=interval_minutes,
        ),
        interval_minutes=interval_minutes,
    )


async def query_cumulative_slot_energy_changes(
    hass: HomeAssistant,
    entity_id: str,
    *,
    local_start: datetime,
    local_end: datetime,
    interval_minutes: int,
) -> dict[datetime, float]:
    local_slot_starts = _build_local_slot_starts_until(
        local_start,
        local_end,
        interval_minutes=interval_minutes,
    )
    if not local_slot_starts:
        return {}

    local_boundaries = [*local_slot_starts, local_end]
    utc_boundaries = [dt_util.as_utc(boundary) for boundary in local_boundaries]
    default_unit = None
    current_state = hass.states.get(entity_id)
    if current_state is not None:
        default_unit = current_state.attributes.get("unit_of_measurement")

    # A sensor's unit does not change across its history, so once the live
    # state has given us one the attributes join buys nothing. Without one the
    # join is the only source of a unit, and dropping it would normalize every
    # row to None and hand back an empty history.
    no_attributes = default_unit is not None

    def _query_and_parse() -> dict[datetime, float]:
        history = state_changes_during_period(
            hass,
            utc_boundaries[0],
            utc_boundaries[-1],
            entity_id,
            no_attributes,
            False,
            None,
            True,
        )
        states = history.get(entity_id) or history.get(entity_id.lower()) or []
        observations = _build_unwrapped_energy_observations(
            _parse_energy_observations(states, default_unit=default_unit)
        )
        boundary_samples = _sample_energy_observations_at_boundaries(
            observations, utc_boundaries
        )
        return _build_slot_energy_changes_from_boundaries(
            utc_boundaries, boundary_samples
        )

    return await get_instance(hass).async_add_executor_job(_query_and_parse)


async def query_cumulative_hourly_energy_changes(
    hass: HomeAssistant,
    entity_id: str,
    *,
    local_start: datetime,
    local_end: datetime,
) -> dict[datetime, float]:
    return await query_cumulative_slot_energy_changes(
        hass,
        entity_id,
        local_start=local_start,
        local_end=local_end,
        interval_minutes=60,
    )


@dataclass(frozen=True)
class _FrozenSlotBoundaries:
    """A day's settled boundary samples, and where to resume reading them."""

    local_date: date
    interval_minutes: int
    frozen_through: datetime
    samples: dict[datetime, float]
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
        frozen = self._take_resumable_prefix(
            entity_id,
            local_date=local_day_start.date(),
            interval_minutes=interval_minutes,
            utc_end=utc_end,
        )
        freeze_at = self._find_freeze_boundary(utc_boundaries, utc_end=utc_end)

        query_start = frozen.frozen_through if frozen else utc_boundaries[0]
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

        def _query_and_parse() -> tuple[dict[datetime, float], _UnwrapState]:
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

    def _take_resumable_prefix(
        self,
        entity_id: str,
        *,
        local_date: date,
        interval_minutes: int,
        utc_end: datetime,
    ) -> _FrozenSlotBoundaries | None:
        frozen = self._frozen_by_entity.get(entity_id)
        if frozen is None:
            return None

        if (
            frozen.local_date != local_date
            or frozen.interval_minutes != interval_minutes
            or frozen.frozen_through > utc_end
        ):
            # A new local day restarts the series, and a clock that stepped
            # backwards leaves the prefix ahead of the window. Either way the
            # prefix cannot be resumed and the day is read in full once.
            del self._frozen_by_entity[entity_id]
            return None

        return frozen

    def _freeze(
        self,
        entity_id: str,
        *,
        local_date: date,
        interval_minutes: int,
        freeze_at: datetime | None,
        previously_frozen_through: datetime | None,
        samples: dict[datetime, float],
        unwrap_state: _UnwrapState,
    ) -> None:
        if freeze_at is None or (
            previously_frozen_through is not None
            and freeze_at <= previously_frozen_through
        ):
            return

        self._frozen_by_entity[entity_id] = _FrozenSlotBoundaries(
            local_date=local_date,
            interval_minutes=interval_minutes,
            frozen_through=freeze_at,
            samples={
                boundary: value
                for boundary, value in samples.items()
                if boundary <= freeze_at
            },
            unwrap_state=unwrap_state,
        )


async def query_slot_boundary_state_values(
    hass: HomeAssistant,
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
    history = await get_instance(hass).async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            boundaries[0],
            None,
            entity_id,
            True,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []
    return _sample_rate_values_at_boundaries(
        states, boundaries, interval_minutes=interval_minutes
    )


async def query_slot_boundary_state_values_for_range(
    hass: HomeAssistant,
    entity_id: str,
    *,
    local_start: datetime,
    local_end: datetime,
    interval_minutes: int,
) -> dict[datetime, float]:
    """Sample an entity's recorded state at every slot boundary in a date range.

    The same read as :func:`query_slot_boundary_state_values`, freed of its
    hardcoded "today": the caller names the window the way
    :func:`query_cumulative_slot_energy_changes` does, so a day that ended a
    week ago can be sampled as readily as the one in progress.

    Boundaries are the slot *starts* in ``[local_start, local_end)``. Each takes
    the first state written *inside* its own slot, and only falls back to the
    last state before it when the slot contains no write at all — see
    :func:`_sample_rate_values_at_boundaries` for why a rate needs that rather
    than the plain carry-forward a meter gets. Slots before the entity's first
    ever reading are absent rather than guessed.
    """
    local_boundaries = _build_local_slot_starts_until(
        local_start,
        local_end,
        interval_minutes=interval_minutes,
    )
    if not local_boundaries:
        return {}

    boundaries = [dt_util.as_utc(boundary) for boundary in local_boundaries]
    utc_end = dt_util.as_utc(local_end)
    history = await get_instance(hass).async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            boundaries[0],
            utc_end,
            entity_id,
            True,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []
    return _sample_rate_values_at_boundaries(
        states, boundaries, interval_minutes=interval_minutes
    )


async def estimate_average_hourly_energy_when_switch_on(
    hass: HomeAssistant,
    *,
    switch_entity_id: str,
    energy_entity_id: str,
    reference_time: datetime,
    lookback_days: int,
) -> float | None:
    return await _estimate_average_hourly_energy_when_entity_active(
        hass,
        entity_id=switch_entity_id,
        energy_entity_id=energy_entity_id,
        reference_time=reference_time,
        lookback_days=lookback_days,
        active_states=("on",),
    )


async def estimate_average_hourly_energy_when_climate_active(
    hass: HomeAssistant,
    *,
    climate_entity_id: str,
    energy_entity_id: str,
    reference_time: datetime,
    lookback_days: int,
) -> float | None:
    return await _estimate_average_hourly_energy_when_entity_active(
        hass,
        entity_id=climate_entity_id,
        energy_entity_id=energy_entity_id,
        reference_time=reference_time,
        lookback_days=lookback_days,
        active_states=("heat", "cool"),
    )


async def query_active_hours_by_local_date(
    hass: HomeAssistant,
    *,
    entity_id: str,
    active_states: tuple[str, ...],
    local_start: datetime,
    local_end: datetime,
) -> dict[date, float]:
    """Return active-state hours bucketed by local calendar date.

    Reads the entity's recorded state changes over ``[local_start, local_end]``
    and sums, per local calendar day, the hours the entity spent in any of
    ``active_states``. Intervals spanning midnight are split at the local day
    boundary so each day gets only its own share.
    """
    if local_end <= local_start:
        return {}

    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)

    recorder = get_instance(hass)
    entity_history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            True,
            False,
            None,
            True,
        )
    )
    entity_states = (
        entity_history.get(entity_id) or entity_history.get(entity_id.lower()) or []
    )
    active_intervals = _build_active_state_intervals(
        states=entity_states,
        window_start=utc_start,
        window_end=utc_end,
        active_states=active_states,
    )
    return _bucket_interval_hours_by_local_date(active_intervals)


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


async def _estimate_average_hourly_energy_when_entity_active(
    hass: HomeAssistant,
    *,
    entity_id: str,
    energy_entity_id: str,
    reference_time: datetime,
    lookback_days: int,
    active_states: tuple[str, ...],
) -> float | None:
    if (
        isinstance(lookback_days, bool)
        or not isinstance(lookback_days, int)
        or lookback_days <= 0
    ):
        raise ValueError("lookback_days must be a positive integer")

    local_end = dt_util.as_local(reference_time)
    local_start = local_end - timedelta(days=lookback_days)
    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)

    current_energy_state = hass.states.get(energy_entity_id)
    default_unit = None
    if current_energy_state is not None:
        default_unit = current_energy_state.attributes.get("unit_of_measurement")

    # A sensor's unit does not change across its history, so once the live
    # state has given us one the attributes join buys nothing. Without one the
    # join is the only source of a unit, and dropping it would normalize every
    # row to None and hand back an empty history.
    energy_no_attributes = default_unit is not None

    recorder = get_instance(hass)
    entity_history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            True,
            False,
            None,
            True,
        )
    )
    energy_history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            energy_entity_id,
            energy_no_attributes,
            False,
            None,
            True,
        )
    )

    entity_states = (
        entity_history.get(entity_id) or entity_history.get(entity_id.lower()) or []
    )
    energy_states = (
        energy_history.get(energy_entity_id)
        or energy_history.get(energy_entity_id.lower())
        or []
    )
    return _estimate_average_hourly_energy_kwh_for_active_intervals(
        entity_states=entity_states,
        energy_states=energy_states,
        window_start=utc_start,
        window_end=utc_end,
        default_unit=default_unit,
        active_states=active_states,
    )


def _build_slot_energy_changes_from_boundaries(
    boundaries: list[datetime],
    samples: dict[datetime, float],
) -> dict[datetime, float]:
    values_by_slot: dict[datetime, float] = {}
    for index, slot_start in enumerate(boundaries[:-1]):
        slot_end = boundaries[index + 1]
        start_value = samples.get(slot_start)
        end_value = samples.get(slot_end)
        if start_value is None or end_value is None:
            continue

        delta = end_value - start_value
        if delta < 0:
            continue

        values_by_slot[slot_start] = delta

    return values_by_slot


def _sample_rate_values_at_boundaries(
    states: list[Any],
    boundaries: list[datetime],
    *,
    interval_minutes: int,
) -> dict[datetime, float]:
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
    """
    if not states or not boundaries:
        return {}

    parsed: list[tuple[datetime, float]] = []
    for state in states:
        last_updated = getattr(state, "last_updated", None)
        if last_updated is None:
            continue
        value = _read_float(getattr(state, "state", None))
        if value is None:
            continue
        parsed.append((dt_util.as_utc(last_updated), value))
    if not parsed:
        return {}
    parsed.sort(key=lambda item: item[0])

    span = timedelta(minutes=interval_minutes)
    samples: dict[datetime, float] = {}
    index = 0
    carried: float | None = None
    for boundary in boundaries:
        # Everything written before this slot began is only a fallback for it.
        while index < len(parsed) and parsed[index][0] < boundary:
            carried = parsed[index][1]
            index += 1
        if index < len(parsed) and parsed[index][0] < boundary + span:
            samples[boundary] = parsed[index][1]
        elif carried is not None:
            samples[boundary] = carried
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

            parsed_value = _read_float(getattr(state, "state", None))
            if parsed_value is not None:
                latest_value = parsed_value
            state_index += 1

        if latest_value is not None:
            samples[boundary] = latest_value

    return samples


def _sample_energy_observations_at_boundaries(
    observations: list[_EnergyObservation],
    boundaries: list[datetime],
    *,
    carried_value: float | None = None,
) -> dict[datetime, float]:
    """Sample the series at each boundary, carrying the last value forward.

    ``carried_value`` is the value in force before the first observation, which
    a resumed read has from its frozen prefix. Without it a stretch of
    boundaries with no readings between them would go unsampled here and its
    slots would drop out of the result.
    """
    if not boundaries:
        return {}

    samples: dict[datetime, float] = {}
    observation_index = 0
    latest_value: float | None = carried_value

    for boundary in boundaries:
        while observation_index < len(observations):
            observation = observations[observation_index]
            if observation.updated_at > boundary:
                break

            latest_value = observation.value_kwh
            observation_index += 1

        if latest_value is not None:
            samples[boundary] = latest_value

    return samples


def _estimate_average_hourly_energy_kwh_for_active_intervals(
    *,
    entity_states: list[Any],
    energy_states: list[Any],
    window_start: datetime,
    window_end: datetime,
    default_unit: Any,
    active_states: tuple[str, ...],
) -> float | None:
    active_intervals = _build_active_state_intervals(
        states=entity_states,
        window_start=window_start,
        window_end=window_end,
        active_states=active_states,
    )
    if not active_intervals:
        return None

    observations = _build_unwrapped_energy_observations(
        _parse_energy_observations(
            energy_states,
            default_unit=default_unit,
        )
    )
    if not observations:
        return None

    boundaries = sorted(
        {boundary for interval in active_intervals for boundary in interval}
    )
    boundary_samples = _sample_energy_observations_at_boundaries(
        observations,
        boundaries,
    )

    total_energy_kwh = 0.0
    total_active_hours = 0.0
    for interval_start, interval_end in active_intervals:
        start_value = boundary_samples.get(interval_start)
        end_value = boundary_samples.get(interval_end)
        if start_value is None or end_value is None:
            continue

        delta = end_value - start_value
        if delta < 0:
            continue

        duration_hours = (interval_end - interval_start).total_seconds() / 3600
        if duration_hours <= 0:
            continue

        total_energy_kwh += delta
        total_active_hours += duration_hours

    if (
        total_active_hours <= 0
        or total_energy_kwh <= _ENERGY_TOLERANCE_KWH
    ):
        return None

    return round(total_energy_kwh / total_active_hours, 4)


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

        if _is_active_state(getattr(state, "state", None), normalized_active_states):
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


def _is_active_state(value: Any, active_states: set[str]) -> bool:
    return isinstance(value, str) and value.strip().lower() in active_states


def _get_local_day_start(reference_time: datetime) -> datetime:
    local_reference = dt_util.as_local(reference_time)
    tzinfo = local_reference.tzinfo
    if tzinfo is None:
        return local_reference.replace(hour=0, minute=0, second=0, microsecond=0)

    return datetime.combine(
        local_reference.date(),
        time.min,
        tzinfo=tzinfo,
    )


def _build_local_slot_starts_until(
    local_start: datetime,
    local_end: datetime,
    *,
    interval_minutes: int,
) -> list[datetime]:
    validated_interval_minutes = _validate_interval_minutes(interval_minutes)
    if local_end <= local_start:
        return []

    slots: list[datetime] = []
    cursor_utc = dt_util.as_utc(local_start)
    end_utc = dt_util.as_utc(local_end)
    while cursor_utc < end_utc:
        slots.append(dt_util.as_local(cursor_utc))
        cursor_utc += timedelta(minutes=validated_interval_minutes)

    return slots


def _validate_interval_minutes(interval_minutes: int) -> int:
    if (
        isinstance(interval_minutes, bool)
        or not isinstance(interval_minutes, int)
        or interval_minutes <= 0
    ):
        raise ValueError("interval_minutes must be a positive integer")
    return interval_minutes


def _read_float(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None

    if isinstance(raw_value, (int, float)):
        return float(raw_value)

    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None

    return None


def _read_energy_state_kwh(state: Any, *, default_unit: Any) -> float | None:
    parsed_value = _read_float(getattr(state, "state", None))
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


def _build_unwrapped_energy_observations(
    observations: list[_EnergyObservation],
) -> list[_EnergyObservation]:
    unwrapped, _state = _unwrap_energy_observations(observations)
    return unwrapped


def _unwrap_energy_observations(
    observations: list[_EnergyObservation],
    *,
    resume_state: _UnwrapState = _INITIAL_UNWRAP_STATE,
    freeze_at: datetime | None = None,
) -> tuple[list[_EnergyObservation], _UnwrapState]:
    """Lift a resetting counter into a monotonic series.

    ``resume_state`` continues an unwrap that was cut short earlier: the offset
    and the running segment maximum are carried across the whole series, so a
    window read on its own would restart both at zero and mis-read every
    reading after a reset. The returned state is the one in force after the
    last observation at or before ``freeze_at``, which is what a caller that
    intends to resume from that point has to keep.
    """
    unwrapped: list[_EnergyObservation] = []
    offset_kwh = resume_state.offset_kwh
    segment_value_kwh = resume_state.segment_value_kwh
    frozen_state = resume_state

    for index, observation in enumerate(observations):
        if segment_value_kwh is None:
            segment_value_kwh = max(observation.value_kwh, 0.0)
            unwrapped.append(
                _EnergyObservation(
                    updated_at=observation.updated_at,
                    value_kwh=offset_kwh + segment_value_kwh,
                )
            )
        elif observation.value_kwh >= segment_value_kwh - _ENERGY_TOLERANCE_KWH:
            segment_value_kwh = max(segment_value_kwh, observation.value_kwh)
            unwrapped.append(
                _EnergyObservation(
                    updated_at=observation.updated_at,
                    value_kwh=offset_kwh + segment_value_kwh,
                )
            )
        elif _is_transient_drop(
            observations,
            drop_index=index,
            pre_drop_value_kwh=segment_value_kwh,
        ):
            # A dip that came back: drop the reading, keep the segment.
            pass
        elif index == len(observations) - 1:
            # Nothing follows it yet, so a reset and a dip look the same.
            pass
        else:
            offset_kwh += segment_value_kwh
            segment_value_kwh = max(observation.value_kwh, 0.0)
            unwrapped.append(
                _EnergyObservation(
                    updated_at=observation.updated_at,
                    value_kwh=offset_kwh + segment_value_kwh,
                )
            )

        if freeze_at is not None and observation.updated_at <= freeze_at:
            frozen_state = _UnwrapState(
                offset_kwh=offset_kwh,
                segment_value_kwh=segment_value_kwh,
            )

    return unwrapped, frozen_state


def _is_transient_drop(
    observations: list[_EnergyObservation],
    *,
    drop_index: int,
    pre_drop_value_kwh: float,
) -> bool:
    drop_observation = observations[drop_index]
    rebound_deadline = drop_observation.updated_at + _TRANSIENT_REBOUND_WINDOW

    for candidate in observations[drop_index + 1 :]:
        if candidate.updated_at > rebound_deadline:
            break

        if candidate.value_kwh >= pre_drop_value_kwh - _ENERGY_TOLERANCE_KWH:
            return True

    return False
