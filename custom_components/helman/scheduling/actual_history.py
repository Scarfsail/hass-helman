"""What the controllable entities actually did earlier today.

The schedule prunes every slot that has elapsed, so it cannot answer "when did
the boiler really run this morning?" -- and even if it kept the plan, the plan
is not the answer: execution can fail, and a person can flip a switch by hand.
The recorder holds what really happened, so that is where this reads from.

The result is bucketed onto the schedule's own slot grid. The card draws the
past on the same time axis as the plan, and a run that is still going has to
meet its scheduled continuation without a seam.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, TypedDict

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..recorder_hourly_series import (
    get_local_current_slot_start,
    get_today_completed_local_slots,
)

# States that say nothing about what the entity was doing.
_UNKNOWN_STATES = {"unknown", "unavailable", ""}


class ActualHistorySlot(TypedDict):
    """One elapsed slot in which an entity was doing something."""

    slot: str
    state: str
    ratio: float


async def build_entity_actual_history(
    hass: HomeAssistant,
    *,
    entity_id: str,
    normal_state: str,
    reference_time: datetime,
    interval_minutes: int,
) -> list[ActualHistorySlot]:
    """Today's elapsed slots in which the entity was away from its resting state.

    Only whole elapsed slots are reported: the slot running now belongs to the
    schedule, which the card already draws, and reporting it here would draw it
    twice.

    ``ratio`` is the share of the slot the entity actually spent away from rest,
    so a run that covers a quarter of a slot still shows up, and the totals stay
    honest about it.
    """
    completed_slots = get_today_completed_local_slots(
        reference_time,
        interval_minutes=interval_minutes,
    )
    if not completed_slots:
        return []

    window_start = dt_util.as_utc(completed_slots[0])
    window_end = dt_util.as_utc(
        get_local_current_slot_start(reference_time, interval_minutes=interval_minutes)
    )
    states = await _async_read_entity_states(
        hass,
        entity_id=entity_id,
        window_start=window_start,
        window_end=window_end,
    )
    intervals = _build_non_normal_intervals(
        states=states,
        window_start=window_start,
        window_end=window_end,
        normal_state=normal_state,
    )
    if not intervals:
        return []

    slot_duration = timedelta(minutes=interval_minutes)
    history: list[ActualHistorySlot] = []
    for slot_start in completed_slots:
        slot_start_utc = dt_util.as_utc(slot_start)
        slot_end_utc = slot_start_utc + slot_duration
        overlap_seconds_by_state: dict[str, float] = {}
        for interval_start, interval_end, state in intervals:
            overlap_seconds = (
                min(interval_end, slot_end_utc) - max(interval_start, slot_start_utc)
            ).total_seconds()
            if overlap_seconds > 0:
                overlap_seconds_by_state[state] = (
                    overlap_seconds_by_state.get(state, 0.0) + overlap_seconds
                )

        if not overlap_seconds_by_state:
            continue

        # The state the entity spent most of the slot in is the one the slot is
        # labelled with -- a slot holds one action in the schedule, and the past
        # is drawn in the same vocabulary.
        state = max(overlap_seconds_by_state.items(), key=lambda item: item[1])[0]
        total_seconds = sum(overlap_seconds_by_state.values())
        history.append(
            ActualHistorySlot(
                slot=slot_start.isoformat(timespec="seconds"),
                state=state,
                ratio=round(
                    min(total_seconds / slot_duration.total_seconds(), 1.0),
                    3,
                ),
            )
        )

    return history


async def _async_read_entity_states(
    hass: HomeAssistant,
    *,
    entity_id: str,
    window_start: datetime,
    window_end: datetime,
) -> list[Any]:
    recorder = get_instance(hass)
    history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            window_start,
            window_end,
            entity_id,
            True,
            False,
            None,
            True,
        )
    )
    return history.get(entity_id) or history.get(entity_id.lower()) or []


def _build_non_normal_intervals(
    *,
    states: list[Any],
    window_start: datetime,
    window_end: datetime,
    normal_state: str,
) -> list[tuple[datetime, datetime, str]]:
    """The stretches the entity spent away from its resting state.

    Written against ``normalState`` rather than against a per-kind list of "on"
    values, because that is the one definition of "doing something" the whole
    integration already shares: the inverter's configured normal mode, and off
    for every appliance.
    """
    if window_end <= window_start:
        return []

    intervals: list[tuple[datetime, datetime, str]] = []
    open_state: str | None = None
    open_start: datetime | None = None
    for state in states:
        last_updated = getattr(state, "last_updated", None)
        if last_updated is None:
            continue

        updated_at = dt_util.as_utc(last_updated)
        if updated_at > window_end:
            break

        value = getattr(state, "state", None)
        next_state = (
            value.strip()
            if isinstance(value, str) and value.strip().lower() not in _UNKNOWN_STATES
            else None
        )
        if next_state is not None and next_state == normal_state:
            next_state = None

        if next_state == open_state:
            continue

        if open_state is not None and open_start is not None:
            interval_end = min(updated_at, window_end)
            if interval_end > open_start:
                intervals.append((open_start, interval_end, open_state))

        open_state = next_state
        open_start = max(updated_at, window_start) if next_state is not None else None

    if open_state is not None and open_start is not None and window_end > open_start:
        intervals.append((open_start, window_end, open_state))

    return intervals
