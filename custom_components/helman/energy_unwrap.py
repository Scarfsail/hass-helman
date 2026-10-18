from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

#: How long a dipped reading has to climb back before the dip is called a
#: glitch rather than a counter reset.
#:
#: It has to be read against the spacing of the samples it is applied to: a
#: rebound can only be *seen* in a later sample, so a window shorter than one
#: sample interval can never fire at all. Thirty minutes suits raw states, which
#: arrive every few minutes. Anything sampling more coarsely -- hourly long-term
#: statistics, in particular -- must pass its own window or lose the suppression
#: silently, which is why every function on this path takes it as an argument.
_TRANSIENT_REBOUND_WINDOW = timedelta(minutes=30)
_ENERGY_TOLERANCE_KWH = 1e-6

#: How far a reading has to fall below the segment's maximum to be called a
#: counter reset rather than a dip.
#:
#: The same fraction Home Assistant's own ``total_increasing`` handling uses
#: (``sensor.recorder.reset_detected``): a reset takes the counter back to
#: roughly zero, so a genuine one is nowhere near the old value, while a drop
#: inside the last tenth is the meter wobbling.
#:
#: Without it, a lifetime meter is a trap. A charger reporting 9143.2 kWh to one
#: decimal ticks back to 9143.1, never returns -- so no rebound window of any
#: length suppresses it -- and the reset branch lifts every later reading by the
#: whole 9143.2, handing the slot the drop falls in the meter's entire lifetime
#: reading as if it were a quarter-hour's energy. The magnitude of that error is
#: the meter's own value, which is why the threshold has to be relative to it
#: rather than an absolute number of kWh.
_RESET_FRACTION = 0.9


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


def unwrap_cumulative_energy_series(
    samples: list[tuple[datetime, float]],
    *,
    rebound_window: timedelta = _TRANSIENT_REBOUND_WINDOW,
) -> list[tuple[datetime, float]]:
    """Lift a resetting cumulative meter into a monotonic series.

    The public door onto :func:`_unwrap_energy_observations`, for callers that
    hold plain ``(instant, kWh)`` pairs rather than recorder ``State`` rows --
    hourly long-term statistics, in particular. There is exactly one reset
    convention in this integration and it lives here: a genuine reset lifts
    every later reading by the segment's maximum, while a drop that stays
    within :data:`_RESET_FRACTION` of that maximum, or that climbs back within
    ``rebound_window``, is discarded as a glitch rather than treated as a reset.
    Long-term statistics apply their own, different convention, which is why
    anything reading them comes back through this function.

    **Pass a ``rebound_window`` of at least one sample interval.** A rebound is
    only visible in a later sample, so the default -- sized for raw states,
    which arrive every few minutes -- can never fire on a coarser series, and
    the suppression would be lost without any error to say so. See
    :data:`_TRANSIENT_REBOUND_WINDOW`.

    Input need not be sorted; output is sorted by instant.
    """
    observations = [
        _EnergyObservation(updated_at=instant, value_kwh=value)
        for instant, value in sorted(samples, key=lambda pair: pair[0])
    ]
    unwrapped = _build_unwrapped_energy_observations(
        observations, rebound_window=rebound_window
    )
    return [(item.updated_at, item.value_kwh) for item in unwrapped]


def _build_unwrapped_energy_observations(
    observations: list[_EnergyObservation],
    *,
    rebound_window: timedelta = _TRANSIENT_REBOUND_WINDOW,
) -> list[_EnergyObservation]:
    unwrapped, _state = _unwrap_energy_observations(
        observations, rebound_window=rebound_window
    )
    return unwrapped


def _unwrap_energy_observations(
    observations: list[_EnergyObservation],
    *,
    resume_state: _UnwrapState = _INITIAL_UNWRAP_STATE,
    freeze_at: datetime | None = None,
    rebound_window: timedelta = _TRANSIENT_REBOUND_WINDOW,
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
        elif observation.value_kwh >= _RESET_FRACTION * segment_value_kwh:
            # Too shallow to be a reset, whatever it does next: drop the
            # reading, keep the segment. A counter that restarted would be
            # near zero, not a hair below where it was.
            pass
        elif _is_transient_drop(
            observations,
            drop_index=index,
            pre_drop_value_kwh=segment_value_kwh,
            rebound_window=rebound_window,
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
    rebound_window: timedelta,
) -> bool:
    drop_observation = observations[drop_index]
    rebound_deadline = drop_observation.updated_at + rebound_window

    for candidate in observations[drop_index + 1 :]:
        if candidate.updated_at > rebound_deadline:
            break

        if candidate.value_kwh >= pre_drop_value_kwh - _ENERGY_TOLERANCE_KWH:
            return True

    return False
