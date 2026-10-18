from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .appliance_runtime_history import _build_active_state_intervals
from .energy_unwrap import (
    _ENERGY_TOLERANCE_KWH,
    _EnergyObservation,
    _build_unwrapped_energy_observations,
)
from .recorder_slot_energy import (
    _parse_energy_observations,
    _sample_energy_observations_at_boundaries,
)
from .shared_meter_split import fit_member_weights, split_own_power


@dataclass(frozen=True)
class SharedMeterFit:
    """What one meter's history taught about the devices splitting it.

    ``estimates`` is each member's kWh per running hour, ``None`` where history
    did not answer. ``weights`` is each member's learned power in kW, ``None``
    for one that did not run long enough -- the ratio the live split shares
    own power in. ``member_energy`` is the energy the split handed each member
    per segment it ran in, ``(start, end, kWh)`` in time order, which is what
    its estimate sums up. All three are keyed by member, every member present.
    """

    estimates: Mapping[str, float | None]
    weights: Mapping[str, float | None]
    member_energy: Mapping[str, list[tuple[datetime, datetime, float]]]


def _estimate_shared_meter_hourly_energy_kwh(
    members: Mapping[str, tuple[list[Any], tuple[str, ...]]],
    energy_states: list[Any],
    window_start: datetime,
    window_end: datetime,
    default_unit: Any,
    *,
    metered_children: Sequence[tuple[list[Any], Any]] = (),
    tolerance: float | None = None,
    previous_weights: Mapping[str, float | None] | None = None,
) -> SharedMeterFit:
    """Split one meter among whichever members were running, by learned power.

    Several devices behind one meter -- four air conditioners on one breaker,
    a pump next to a heater -- each need their own when-running figure, but
    the meter only knows their total. Each member is ``(activity entity
    states, active states)``.

    Every member's active-interval boundaries, and the window's two edges,
    together cut the window into segments, and within one segment the set of
    running members is constant. With more than one member, the segments first
    teach each member's power -- see
    :func:`.shared_meter_split.fit_member_weights`, which also takes the
    standby out of the time nobody runs. Then every segment where members run
    hands each of them its :func:`.shared_meter_split.split_own_power` share
    of the segment's energy, in the parent's ``tolerance`` mode, and the
    segment's full duration as running hours; each member's estimate is its
    accumulated energy over its own hours. That is the very split the live
    share sensors make with the same weights, so a figure means what its live
    share means: in the capped mode, the excess stays out of both. A member
    without a learned weight takes the mean of the others, and one member
    takes all of it -- the lone device's plain when-active average. A member
    this window teaches nothing (idle all winter) keeps its
    ``previous_weights`` entry instead, in the split and in the answer, since
    its power has not changed and the live split reads the stored weight.

    Segments with a missing sample or a negative delta are skipped, the same
    way the single-device average always skipped them. A member's estimate is
    ``None`` when it never ran or what it accumulated rounds to nothing, the
    same two "history did not answer" cases a lone device has.

    What is split is the meter's *own* energy -- see
    :func:`own_energy_observations` -- sampled at the segment boundaries, so a
    meter with ``metered_children`` (each ``(states, default unit)``) hands its
    members only what those children did not measure, and the exact
    per-segment allocation is kept -- and handed back as ``member_energy``, so
    a device's usage record is built from the very energy its estimate is.
    """
    intervals_by_member = {
        key: _build_active_state_intervals(
            states=states,
            window_start=window_start,
            window_end=window_end,
            active_states=active_states,
        )
        for key, (states, active_states) in members.items()
    }
    previous_weights = previous_weights or {}
    nothing = SharedMeterFit(
        estimates={key: None for key in members},
        weights={key: previous_weights.get(key) for key in members},
        member_energy={key: [] for key in members},
    )
    if not any(intervals_by_member.values()):
        return nothing

    observations = _parse_energy_observations(
        energy_states,
        default_unit=default_unit,
    )
    if not observations:
        return nothing

    boundaries = sorted(
        {window_start, window_end}
        | {
            boundary
            for intervals in intervals_by_member.values()
            for interval in intervals
            for boundary in interval
        }
    )
    # These boundaries are active-state transitions, not a fixed slot grid, so
    # the staleness limit's "multiple of the interval" shape does not apply --
    # this estimator is out of scope for the carry-staleness rule and keeps
    # the plain carry-forward.
    own_deltas = own_energy_observations(
        _observation_pairs(observations),
        [
            _observation_pairs(
                _parse_energy_observations(states, default_unit=child_unit)
            )
            for states, child_unit in metered_children
        ],
        boundaries,
    )

    #: ``(running members, duration h, own kWh)``, nobody-running ones included.
    segments: list[tuple[tuple[str, ...], float, float]] = []
    #: Each segment's ``(start, end)``, in step with ``segments``.
    spans: list[tuple[datetime, datetime]] = []
    # Each member's intervals are sorted and disjoint, and every one of their
    # ends is a boundary, so walking the segments in order only ever advances a
    # per-member cursor: a segment is running for a member exactly when it lies
    # inside that member's current interval.
    cursors = {key: 0 for key in members}
    for segment_start, segment_end in zip(boundaries, boundaries[1:]):
        running: list[str] = []
        for key, intervals in intervals_by_member.items():
            index = cursors[key]
            while index < len(intervals) and intervals[index][1] <= segment_start:
                index += 1
            cursors[key] = index
            if index < len(intervals) and intervals[index][0] <= segment_start:
                running.append(key)

        delta = own_deltas.get(segment_start)
        if delta is None:
            continue

        duration_hours = (segment_end - segment_start).total_seconds() / 3600
        if duration_hours <= 0:
            continue
        segments.append((tuple(running), duration_hours, delta))
        spans.append((segment_start, segment_end))

    # Rounded before the split, so the estimates below use exactly the weights
    # the live split will read back from the store.
    # Fitted for a lone member too: its ratio split hands it all own power
    # either way, but a capped split needs its weight.
    fitted = fit_member_weights(segments)
    weights: dict[str, float | None] = {
        key: (
            previous_weights.get(key)
            if (weight := fitted.get(key)) is None
            else round(weight, 4)
        )
        for key in members
    }

    energy_kwh = {key: 0.0 for key in members}
    active_hours = {key: 0.0 for key in members}
    member_energy: dict[str, list[tuple[datetime, datetime, float]]] = {
        key: [] for key in members
    }
    for (running, duration_hours, delta), (start, end) in zip(segments, spans):
        # Power in and out, in W as the live split takes it.
        shares_w = split_own_power(
            delta / duration_hours * 1000, running, weights, tolerance=tolerance
        )
        for key, share_w in shares_w.items():
            share_kwh = share_w * duration_hours / 1000
            energy_kwh[key] += share_kwh
            active_hours[key] += duration_hours
            member_energy[key].append((start, end, share_kwh))

    estimates: dict[str, float | None] = {key: None for key in members}
    for key in members:
        if active_hours[key] <= 0 or energy_kwh[key] <= _ENERGY_TOLERANCE_KWH:
            continue
        estimates[key] = round(energy_kwh[key] / active_hours[key], 4)
    return SharedMeterFit(
        estimates=estimates, weights=weights, member_energy=member_energy
    )


def own_energy_observations(
    meter: Sequence[tuple[datetime, float]],
    metered_children: Sequence[Sequence[tuple[datetime, float]]],
    timestamps: Sequence[datetime],
) -> dict[datetime, float]:
    """A meter's *own* energy between consecutive ``timestamps``.

    Own energy is the meter's reading minus its metered children's readings:
    what the meter measured that no sub-meter behind it did. Each argument is a
    cumulative series of ``(instant, kWh)`` readings; every series is unwrapped
    first (resets and glitches handled per meter, see
    :func:`_build_unwrapped_energy_observations`), then sampled at the caller's
    ``timestamps`` (sorted) by carrying the last reading forward — activity
    transitions for a shared-meter split, slot boundaries for the baseline. The
    answer is keyed by each interval's start. An interval is left out when the
    meter has no reading at either end, or when the own delta is negative
    beyond float noise (children reading ahead of their parent), the way a
    negative meter delta always was. A child with no reading at either end
    (a sub-meter newer than its parent, a statistics gap) subtracts nothing:
    dropping the parent's interval instead would push its energy into whatever
    the caller treats a missing interval as. Totals are the caller's to
    aggregate, afterwards.

    A meter with no metered children is its own energy, unchanged.
    """
    samples = [
        _sample_energy_observations_at_boundaries(
            _build_unwrapped_energy_observations(
                [
                    _EnergyObservation(updated_at=instant, value_kwh=value)
                    for instant, value in sorted(series, key=lambda pair: pair[0])
                ]
            ),
            list(timestamps),
        )
        for series in (meter, *metered_children)
    ]
    own: dict[datetime, float] = {}
    for start, end in zip(timestamps, timestamps[1:]):
        delta = 0.0
        for index, sampled in enumerate(samples):
            start_sample = sampled.get(start)
            end_sample = sampled.get(end)
            if start_sample is None or end_sample is None:
                if index == 0:
                    break
                continue
            change = end_sample.value_kwh - start_sample.value_kwh
            delta += change if index == 0 else -change
        else:
            # Tolerance rather than zero: a sub-meter that measured everything
            # leaves float noise, not a negative reading.
            if delta >= -_ENERGY_TOLERANCE_KWH:
                own[start] = max(delta, 0.0)
    return own


def own_energy_changes(
    meter_changes: Mapping[datetime, float],
    metered_children_changes: Sequence[Mapping[datetime, float]],
    *,
    slot: timedelta,
) -> dict[datetime, float]:
    """:func:`own_energy_observations` for callers that hold per-slot changes.

    The baseline fit and the forecast actuals read ``{slot start: kWh}`` rather
    than raw readings. With no metered children the meter's changes pass
    through untouched. Otherwise each series is rebuilt as a cumulative one over
    the meter's slots (a slot a child is missing subtracts nothing) and handed to the one own-energy definition, so there is no second
    arithmetic for the same question.
    """
    if not metered_children_changes:
        return dict(meter_changes)
    slots = sorted(meter_changes)
    boundaries = sorted({boundary for start in slots for boundary in (start, start + slot)})

    def cumulative(changes: Mapping[datetime, float]) -> list[tuple[datetime, float]]:
        total, series = 0.0, []
        for start in slots:
            series.append((start, total))
            total += max(0.0, changes.get(start, 0.0))
            series.append((start + slot, total))
        return series

    own = own_energy_observations(
        cumulative(meter_changes),
        [cumulative(changes) for changes in metered_children_changes],
        boundaries,
    )
    return {start: own[start] for start in slots if start in own}


def _observation_pairs(
    observations: list[_EnergyObservation],
) -> list[tuple[datetime, float]]:
    return [(item.updated_at, item.value_kwh) for item in observations]


def _lookback_window(
    reference_time: datetime, lookback_days: int
) -> tuple[datetime, datetime]:
    """``lookback_days`` back from ``reference_time``, as a UTC pair."""
    if (
        isinstance(lookback_days, bool)
        or not isinstance(lookback_days, int)
        or lookback_days <= 0
    ):
        raise ValueError("lookback_days must be a positive integer")

    local_end = dt_util.as_local(reference_time)
    local_start = local_end - timedelta(days=lookback_days)
    return dt_util.as_utc(local_start), dt_util.as_utc(local_end)


async def read_entity_history(
    hass: HomeAssistant,
    entity_id: str,
    utc_start: datetime,
    utc_end: datetime,
    *,
    meter: bool,
) -> tuple[list[Any], Any]:
    """One entity's state changes over the window, and a meter's live unit.

    One read on the recorder executor. The unit is ``None`` for anything but a
    meter. A sensor's unit does not change across its history, so once a
    meter's live state has given one the attributes join buys nothing. Without
    one the join is the only source of a unit, and dropping it would normalize
    every row to None and hand back an empty history. Anything else is read
    for its state alone.
    """
    unit = None
    if meter and (live := hass.states.get(entity_id)) is not None:
        unit = live.attributes.get("unit_of_measurement")
    no_attributes = not meter or unit is not None
    history = await get_instance(hass).async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            no_attributes,
            False,
            None,
            True,
        )
    )
    return history.get(entity_id) or history.get(entity_id.lower()) or [], unit
