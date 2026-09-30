"""One device's usage record, learned from its recorder history.

HA-free: the appliance energy job reads the history, slices it per device and
hands over what it measured -- a metered device's meter deltas per local day
and its power sensor's states, a meterless child's share of its meter per
segment -- and this module turns that into the record stored under the
device's ``deviceKey``::

    {"daily_kwh": {"mean", "median", "min", "max", "days"},
     "runs_per_day": float,
     "run_minutes": {"median", "min", "max"},
     "run_kwh": {"median", "min", "max"},
     "running_kw": float,
     "on_kwh_per_hour": float}

Every key is left out when history does not answer it. ``daily_kwh`` covers
the complete local days in the window, zero days included. A run clipped by
either edge of the window is left out of the run figures, since its length is
unknown, but its energy still counts toward ``running_kw``: energy over the
hours the device actually drew. ``on_kwh_per_hour`` is the job's estimate --
energy per hour the running signal is on, idle on-time included -- which is
what a ``history_average`` forecast uses.

A device with a power sensor runs while it draws above a standby floor it
learns itself: the lowest hourly mean power over hours its readings fully
cover. One idle hour sets it, and a short dip barely moves a loaded hour.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Sequence
from datetime import datetime, time, timedelta, timezone, tzinfo
from statistics import mean, median
from typing import Any

from ..power_polarity import watts_for_value_type

#: A device runs while its power is above the standby floor by at least this
#: much, in W ...
RUNNING_MARGIN_W = 10.0
#: ... or by this share of the span from the floor to its loaded power, when
#: that is more.
RUNNING_MARGIN_FRACTION = 0.05
#: The time-weighted percentile of power that stands for the loaded power.
LOADED_POWER_PERCENTILE = 0.95
#: An off-gap shorter than this is merged into the run around it -- the
#: hysteresis that keeps a compressor's brief pause from splitting a run.
MERGE_OFF_GAP = timedelta(minutes=2)
#: A run shorter than this is dropped as a blip.
MIN_RUN = timedelta(minutes=1)

#: ``(start, end, value)``: W for a power reading, kWh for energy.
Piece = tuple[datetime, datetime, float]
Span = tuple[datetime, datetime]

_HOUR = timedelta(hours=1)


def metered_record(
    *,
    window_start: datetime,
    window_end: datetime,
    daily_kwh: Sequence[float],
    power_states: Sequence[Any] | None = None,
    power_value_type: str = "default",
    running: Sequence[Span] | None = None,
    on_kwh_per_hour: float | None = None,
) -> dict[str, Any] | None:
    """The record of a device with its own meter.

    ``daily_kwh`` is its meter's change over each complete local day, so a
    parent's includes its metered children. Runs come only from a power
    sensor's ``power_states``: above the standby floor, and within
    ``running`` -- its running signal's active intervals -- when it has one.
    """
    runs: list[Piece] = []
    covered_start = window_start
    if power_states is not None:
        pieces = power_pieces(power_states, power_value_type, window_start, window_end)
        runs = power_runs(pieces, running)
        if pieces:
            # The recorder may hold less than the window (purged after 10
            # days by default): runs per day count only the time it covers.
            covered_start = pieces[0][0]
    return _record(covered_start, window_end, daily_kwh, runs, on_kwh_per_hour)


def member_record(
    *,
    window_start: datetime,
    window_end: datetime,
    local_tz: tzinfo,
    member_energy: Sequence[Piece],
    on_kwh_per_hour: float | None,
) -> dict[str, Any] | None:
    """The record of a meterless child, from its share of the meter.

    ``member_energy`` is what the split handed it per segment it ran in, so its
    record cannot drift from its estimate or its live share. It runs while its
    signal is active: touching segments are one run. ``window_start`` is where
    its meter's history begins, so days the recorder no longer holds are not
    counted as zero days.
    """
    runs: list[Piece] = []
    for start, end, kwh in member_energy:
        if runs and runs[-1][1] == start:
            runs[-1] = (runs[-1][0], end, runs[-1][2] + kwh)
        else:
            runs.append((start, end, kwh))
    daily = _energy_by_day(
        member_energy, local_midnights(window_start, window_end, local_tz)
    )
    return _record(window_start, window_end, daily, runs, on_kwh_per_hour)


def local_midnights(
    window_start: datetime, window_end: datetime, local_tz: tzinfo
) -> list[datetime]:
    """Every local midnight inside the window, edges included.

    Consecutive pairs are its complete local days.
    """
    midnights: list[datetime] = []
    day = window_start.astimezone(local_tz).date()
    while (midnight := datetime.combine(day, time.min, tzinfo=local_tz)) <= window_end:
        if midnight >= window_start:
            midnights.append(midnight)
        day += timedelta(days=1)
    return midnights


def power_pieces(
    states: Sequence[Any],
    value_type: str,
    window_start: datetime,
    window_end: datetime,
) -> list[Piece]:
    """Each power reading carried forward until the next state.

    Home Assistant records only changes, so 0 W held all night is a single
    sample. A state that is no number (``unavailable``, ``unknown``) ends the
    carry, and the time until the next reading is a gap: no piece covers it.
    """
    pieces: list[Piece] = []
    carried: tuple[datetime, float] | None = None
    for state in states:
        updated = getattr(state, "last_updated", None)
        if updated is None:
            continue
        if updated >= window_end:
            break
        instant = max(updated, window_start)
        if carried is not None and instant > carried[0]:
            pieces.append((carried[0], instant, carried[1]))
        raw = _read_float(getattr(state, "state", None))
        carried = (
            None if raw is None else (instant, watts_for_value_type(raw, value_type))
        )
    if carried is not None and window_end > carried[0]:
        pieces.append((carried[0], window_end, carried[1]))
    return pieces


def power_runs(
    pieces: Sequence[Piece], running: Sequence[Span] | None = None
) -> list[Piece]:
    """``(start, end, kWh)`` per run the carried power shows.

    A device runs while its power is above ``floor + max(10 W, 5 % × (p95 −
    floor))``, and inside ``running`` when that is given. Off-gaps shorter than
    :data:`MERGE_OFF_GAP` are merged into the run around them and runs shorter
    than :data:`MIN_RUN` dropped. A run's energy is its carried power
    integrated over it, merged gaps included.
    """
    if not pieces:
        return []
    floor = _standby_floor(pieces)
    threshold = floor + max(
        RUNNING_MARGIN_W,
        RUNNING_MARGIN_FRACTION * (_percentile(pieces, LOADED_POWER_PERCENTILE) - floor),
    )
    above: list[Span] = [(start, end) for start, end, watts in pieces if watts > threshold]
    if running is not None:
        above = _intersect(above, running)

    merged: list[Span] = []
    for start, end in above:
        if merged and start - merged[-1][1] < MERGE_OFF_GAP:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    spans = [(start, end) for start, end in merged if end - start >= MIN_RUN]
    return [
        (start, end, kwh)
        for (start, end), kwh in zip(spans, _energy_within(pieces, spans))
    ]


def _standby_floor(pieces: Sequence[Piece]) -> float:
    """The lowest hourly time-weighted mean over hours fully covered.

    Without one fully covered hour, the lowest reading.
    """
    covered: dict[datetime, float] = {}
    watt_seconds: dict[datetime, float] = {}
    for start, end, watts in pieces:
        cursor = start
        while cursor < end:
            hour = cursor.astimezone(timezone.utc).replace(
                minute=0, second=0, microsecond=0
            )
            stop = min(end, hour + _HOUR)
            seconds = (stop - cursor).total_seconds()
            covered[hour] = covered.get(hour, 0.0) + seconds
            watt_seconds[hour] = watt_seconds.get(hour, 0.0) + watts * seconds
            cursor = stop
    full_hours = [
        watt_seconds[hour] / seconds
        for hour, seconds in covered.items()
        if seconds >= _HOUR.total_seconds() - 1e-6
    ]
    if full_hours:
        return min(full_hours)
    return min(watts for _start, _end, watts in pieces)


def _percentile(pieces: Sequence[Piece], fraction: float) -> float:
    """The time-weighted ``fraction`` percentile of the carried power."""
    ordered = sorted(pieces, key=lambda piece: piece[2])
    reach = fraction * sum((end - start).total_seconds() for start, end, _ in ordered)
    elapsed = 0.0
    for start, end, watts in ordered:
        elapsed += (end - start).total_seconds()
        if elapsed >= reach:
            return watts
    return ordered[-1][2]


def _intersect(spans: Sequence[Span], others: Sequence[Span]) -> list[Span]:
    """Where two sorted, disjoint span lists overlap."""
    out: list[Span] = []
    index = other_index = 0
    while index < len(spans) and other_index < len(others):
        start = max(spans[index][0], others[other_index][0])
        end = min(spans[index][1], others[other_index][1])
        if start < end:
            out.append((start, end))
        if spans[index][1] < others[other_index][1]:
            index += 1
        else:
            other_index += 1
    return out


def _energy_within(pieces: Sequence[Piece], spans: Sequence[Span]) -> list[float]:
    """kWh of carried power within each of the sorted, disjoint ``spans``."""
    energies: list[float] = []
    first = 0
    for start, end in spans:
        while first < len(pieces) and pieces[first][1] <= start:
            first += 1
        kwh = 0.0
        index = first
        while index < len(pieces) and pieces[index][0] < end:
            piece_start, piece_end, watts = pieces[index]
            seconds = (min(piece_end, end) - max(piece_start, start)).total_seconds()
            if seconds > 0:
                kwh += watts * seconds / 3_600_000
            index += 1
        energies.append(kwh)
    return energies


def _energy_by_day(
    segments: Sequence[Piece], midnights: Sequence[datetime]
) -> list[float]:
    """Each complete local day's share of the segments' energy, pro rata."""
    totals = [0.0] * max(len(midnights) - 1, 0)
    for start, end, kwh in segments:
        seconds = (end - start).total_seconds()
        if seconds <= 0:
            continue
        day = max(bisect_right(midnights, start) - 1, 0)
        while day < len(totals) and midnights[day] < end:
            overlap = (
                min(end, midnights[day + 1]) - max(start, midnights[day])
            ).total_seconds()
            if overlap > 0:
                totals[day] += kwh * overlap / seconds
            day += 1
    return totals


def _record(
    window_start: datetime,
    window_end: datetime,
    daily_kwh: Sequence[float],
    runs: Sequence[Piece],
    on_kwh_per_hour: float | None,
) -> dict[str, Any] | None:
    record: dict[str, Any] = {}
    if daily_kwh:
        record["daily_kwh"] = {
            "mean": round(mean(daily_kwh), 4),
            **_spread(daily_kwh),
            "days": len(daily_kwh),
        }
    complete = [run for run in runs if window_start < run[0] and run[1] < window_end]
    if complete:
        window_days = (window_end - window_start) / timedelta(days=1)
        record["runs_per_day"] = round(len(complete) / window_days, 4)
        record["run_minutes"] = _spread(
            [(end - start) / timedelta(minutes=1) for start, end, _ in complete],
            digits=1,
        )
        record["run_kwh"] = _spread([kwh for _start, _end, kwh in complete])
    running_hours = sum((end - start) / _HOUR for start, end, _ in runs)
    if running_hours > 0:
        record["running_kw"] = round(
            sum(kwh for _start, _end, kwh in runs) / running_hours, 4
        )
    if on_kwh_per_hour is not None:
        record["on_kwh_per_hour"] = on_kwh_per_hour
    return record or None


def _spread(values: Sequence[float], *, digits: int = 4) -> dict[str, float]:
    return {
        "median": round(median(values), digits),
        "min": round(min(values), digits),
        "max": round(max(values), digits),
    }


def _read_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None
