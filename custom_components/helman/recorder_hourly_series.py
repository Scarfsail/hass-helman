from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
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


def get_today_completed_local_hour_boundaries(reference_time: datetime) -> list[datetime]:
    return get_today_completed_local_slot_boundaries(
        reference_time,
        interval_minutes=60,
    )


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


async def query_hourly_energy_changes(
    hass: HomeAssistant,
    entity_id: str,
    reference_time: datetime,
) -> dict[datetime, float]:
    return await query_slot_energy_changes(
        hass,
        entity_id,
        reference_time,
        interval_minutes=60,
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

    history = await get_instance(hass).async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_boundaries[0],
            utc_boundaries[-1],
            entity_id,
            False,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []
    observations = _build_unwrapped_energy_observations(
        _parse_energy_observations(
            states,
            default_unit=default_unit,
        )
    )
    boundary_samples = _sample_energy_observations_at_boundaries(
        observations,
        utc_boundaries,
    )
    return _build_slot_energy_changes_from_boundaries(
        utc_boundaries,
        boundary_samples,
    )


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
    return _sample_state_values_at_boundaries(states, boundaries)


async def query_hour_boundary_state_values(
    hass: HomeAssistant,
    entity_id: str,
    reference_time: datetime,
) -> dict[datetime, float]:
    return await query_slot_boundary_state_values(
        hass,
        entity_id,
        reference_time,
        interval_minutes=60,
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


def _build_hourly_energy_changes_from_boundaries(
    boundaries: list[datetime],
    samples: dict[datetime, float],
) -> dict[datetime, float]:
    return _build_slot_energy_changes_from_boundaries(boundaries, samples)


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
) -> dict[datetime, float]:
    if not observations or not boundaries:
        return {}

    samples: dict[datetime, float] = {}
    observation_index = 0
    latest_value: float | None = None

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


def _build_local_hour_starts_until(
    local_start: datetime,
    local_end: datetime,
) -> list[datetime]:
    return _build_local_slot_starts_until(
        local_start,
        local_end,
        interval_minutes=60,
    )


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
    if not observations:
        return []

    unwrapped: list[_EnergyObservation] = []
    offset_kwh = 0.0
    segment_value_kwh: float | None = None
    index = 0

    while index < len(observations):
        observation = observations[index]
        if segment_value_kwh is None:
            segment_value_kwh = max(observation.value_kwh, 0.0)
            unwrapped.append(
                _EnergyObservation(
                    updated_at=observation.updated_at,
                    value_kwh=offset_kwh + segment_value_kwh,
                )
            )
            index += 1
            continue

        if observation.value_kwh >= segment_value_kwh - _ENERGY_TOLERANCE_KWH:
            segment_value_kwh = max(segment_value_kwh, observation.value_kwh)
            unwrapped.append(
                _EnergyObservation(
                    updated_at=observation.updated_at,
                    value_kwh=offset_kwh + segment_value_kwh,
                )
            )
            index += 1
            continue

        if _is_transient_drop(
            observations,
            drop_index=index,
            pre_drop_value_kwh=segment_value_kwh,
        ):
            index += 1
            continue

        if index == len(observations) - 1:
            index += 1
            continue

        offset_kwh += segment_value_kwh
        segment_value_kwh = max(observation.value_kwh, 0.0)
        unwrapped.append(
            _EnergyObservation(
                updated_at=observation.updated_at,
                value_kwh=offset_kwh + segment_value_kwh,
            )
        )
        index += 1

    return unwrapped


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
