from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone


@dataclass(frozen=True)
class StateSample:
    timestamp: datetime
    value: float | None


@dataclass(frozen=True)
class InvalidationInputs:
    """Everything the curtailment test reads, in UTC.

    ``grid_power_samples_utc`` carries ``power_devices.grid.entities.power``
    with its house convention: **positive is export**, negative is import (see
    ``tree_builder``, which reads the grid node's export side as the positive
    part). The test only ever looks at the positive side.
    """

    max_battery_soc_percent: float
    max_export_w: float
    max_actual_forecast_ratio: float
    soc_samples_utc: list[StateSample]
    grid_power_samples_utc: list[StateSample]
    slot_actuals_by_date: dict[str, dict[str, float]]
    forecast_slot_wh_by_date: dict[str, dict[str, float]]
    forecast_slot_starts_by_date: dict[str, list[datetime]]
    slot_keys_by_date: dict[str, list[str]]


def compute_invalidated_slots_for_window(
    inputs: InvalidationInputs,
) -> dict[str, set[str]]:
    """Infer inverter clipping from what the installation already measures.

    A slot is curtailed when all three hold:

    1. **Peak battery SoC >= the configured threshold** — there is nowhere left
       to put the energy.
    2. **Peak grid export <= ``max_export_w``** — and nothing went out either,
       so the only remaining sink is the house.
    3. **Actual <= ``max_actual_forecast_ratio`` x the historical per-slot
       forecast** — the slot underdelivered against what was predicted for it
       at the start of that day.

    Battery full plus no export plus underdelivery means the inverter was
    throttling PV, which is what the retired ``export_enabled_entity_id``
    boolean was a proxy for. Rule (3) is what keeps a cloudy full-battery slot
    with a hungry house out of the set: there the house absorbs everything, so
    (1) and (2) both hold, but actual tracks forecast.

    Every rule needs positive evidence: a slot with no SoC reading, no grid
    reading, no forecast, or no actual is left alone rather than invalidated.
    """
    if not inputs.forecast_slot_starts_by_date:
        return {}

    soc_samples = sorted(inputs.soc_samples_utc, key=lambda sample: sample.timestamp)
    grid_samples = sorted(
        inputs.grid_power_samples_utc, key=lambda sample: sample.timestamp
    )
    invalidated_slots_by_date: dict[str, set[str]] = {}

    for day in sorted(inputs.forecast_slot_starts_by_date):
        slot_starts = inputs.forecast_slot_starts_by_date.get(day, [])
        slot_keys = inputs.slot_keys_by_date.get(day, [])
        if len(slot_starts) != len(slot_keys):
            continue
        day_actuals = inputs.slot_actuals_by_date.get(day, {})
        day_forecast = inputs.forecast_slot_wh_by_date.get(day, {})
        if not day_actuals or not day_forecast:
            continue

        invalidated_slots: set[str] = set()
        for index, (slot_start, slot_key) in enumerate(zip(slot_starts, slot_keys)):
            slot_end = _resolve_slot_end(day, slot_starts, index)

            peak_soc = _peak_numeric_value(
                soc_samples,
                slot_start=slot_start,
                slot_end=slot_end,
            )
            if peak_soc is None or peak_soc < inputs.max_battery_soc_percent:
                continue

            peak_export_w = _peak_numeric_value(
                grid_samples,
                slot_start=slot_start,
                slot_end=slot_end,
            )
            if peak_export_w is None or peak_export_w > inputs.max_export_w:
                continue

            forecast_wh = day_forecast.get(slot_key)
            actual_wh = day_actuals.get(slot_key)
            if forecast_wh is None or forecast_wh <= 0 or actual_wh is None:
                continue
            if actual_wh > forecast_wh * inputs.max_actual_forecast_ratio:
                continue

            invalidated_slots.add(slot_key)

        if invalidated_slots:
            invalidated_slots_by_date[day] = invalidated_slots

    return invalidated_slots_by_date


def _resolve_slot_end(
    day: str,
    slot_starts: list[datetime],
    index: int,
) -> datetime:
    """Where a slot stops, half-open.

    The day's last slot has no successor to stop at, so it stops one grid step
    after itself -- the step read off the grid rather than assumed, because the
    caller builds a 24-hour grid for a day served from hourly statistics and a
    96-slot one for a day served from raw states. Falling back to the next UTC
    midnight instead, as this did, hands the last slot of a day everything up to
    two hours of the *next* day's samples in any zone east of UTC, so an evening
    slot is judged on the following midnight's state.
    """
    if index + 1 < len(slot_starts):
        return slot_starts[index + 1]
    if len(slot_starts) >= 2:
        return slot_starts[-1] + (slot_starts[-1] - slot_starts[-2])
    return datetime.combine(
        date.fromisoformat(day) + timedelta(days=1),
        datetime.min.time(),
        tzinfo=timezone.utc,
    )


def _peak_numeric_value(
    samples: list[StateSample],
    *,
    slot_start: datetime,
    slot_end: datetime,
) -> float | None:
    values = _segment_values(samples, slot_start=slot_start, slot_end=slot_end)
    numeric_values = [float(value) for value in values if value is not None]
    if not numeric_values:
        return None
    return max(numeric_values)


def _segment_values(
    samples: list[StateSample],
    *,
    slot_start: datetime,
    slot_end: datetime,
) -> list[float | None]:
    """Return the values that describe the slot's state.

    Slot half-open as [slot_start, slot_end). A sample exactly at slot_start
    replaces the carry rather than joining it: the new state takes effect at
    that instant, so the previous slot's value never described any part of
    this one. The carry is the most recent KNOWN sample with timestamp <
    slot_start; transient None values (HA `unknown`/`unavailable`) before
    slot_start are ignored so a sub-second blip cannot wipe out the last known
    state. A sample a fraction of a second *after* slot_start does not replace
    it — the carry did describe that fraction.
    """
    values: list[float | None] = []
    current_value: float | None = None

    for sample in samples:
        if sample.timestamp < slot_start:
            if sample.value is not None:
                current_value = sample.value
            continue
        if sample.timestamp >= slot_end:
            break
        if not values and sample.timestamp > slot_start:
            values.append(current_value)
        values.append(sample.value)

    if not values:
        values.append(current_value)

    return values


_SLOT_MINUTES = 15


def _slot_to_minutes(slot_key: str) -> int:
    hour_text, minute_text = slot_key.split(":", 1)
    return int(hour_text) * 60 + int(minute_text)


def _has_nonzero_neighbour_within_minutes(
    slot_key: str,
    day_actuals: dict[str, float],
    *,
    radius_minutes: int,
) -> bool:
    target = _slot_to_minutes(slot_key)
    for other_key, other_value in day_actuals.items():
        if other_key == slot_key:
            continue
        try:
            other_minutes = _slot_to_minutes(other_key)
        except (AttributeError, ValueError):
            continue
        if abs(other_minutes - target) > radius_minutes:
            continue
        if other_value > 0:
            return True
    return False


def compute_data_glitch_invalidations(
    *,
    slot_actuals_by_date: dict[str, dict[str, float]],
    forecast_slot_wh_by_date: dict[str, dict[str, float]],
    max_slot_wh: float | None,
    min_neighbour_forecast_wh: float,
    backfill_max_minutes: int,
) -> dict[str, set[str]]:
    """Detect implausible cumulative-energy artefacts in the actuals window.

    Three rules, all per-day:

    1. **Spike rule.** Any slot whose actual exceeds `max_slot_wh` is bogus
       (a 15-min slot cannot exceed PV inverter max output by definition).
       Invalidated unconditionally.

    2. **Backfill rule.** Whenever rule (1) flags a spike, walk backwards
       through earlier slots that day. As long as the actual is `0` and the
       backfill walk has not exceeded `backfill_max_minutes`, invalidate
       those zero slots too — they almost certainly hold the energy that the
       cumulative meter dumped at the spike.

    3. **Sanity floor for zero-with-known-production days.** Independently
       of rule (2), invalidate any slot whose actual is `0` and whose
       historical-forecast Wh is `>= min_neighbour_forecast_wh` *and* which
       has a non-zero neighbour within ±60 minutes the same day. Catches
       isolated recorder gaps during sunny periods, including the case
       where the missing energy never reappears as a single backfill spike.

    `max_slot_wh` of None disables rule (1) and (2). Rule (3) is independent
    and runs whenever forecast data is provided.

    Returns a date-string → set-of-slot-keys map ready to be unioned with
    the curtailment-based invalidation set.
    """
    invalidated_by_date: dict[str, set[str]] = {}
    radius = 60  # minutes; rule (3) neighbour window

    for day in sorted(slot_actuals_by_date):
        day_actuals = slot_actuals_by_date.get(day, {})
        if not day_actuals:
            continue
        day_forecast = forecast_slot_wh_by_date.get(day, {})
        invalidated_for_day: set[str] = set()

        sorted_slots = sorted(day_actuals, key=_slot_to_minutes)

        # Rule 1 + 2: spike + backfill
        if max_slot_wh is not None and max_slot_wh > 0:
            for index, slot_key in enumerate(sorted_slots):
                actual = day_actuals.get(slot_key, 0.0)
                if actual <= max_slot_wh:
                    continue
                invalidated_for_day.add(slot_key)
                # Walk backwards while preceding slots are zero, within the
                # configured backfill window.
                spike_minutes = _slot_to_minutes(slot_key)
                for back_index in range(index - 1, -1, -1):
                    back_key = sorted_slots[back_index]
                    back_actual = day_actuals.get(back_key, 0.0)
                    if back_actual != 0:
                        break
                    if (
                        spike_minutes - _slot_to_minutes(back_key)
                        > backfill_max_minutes
                    ):
                        break
                    invalidated_for_day.add(back_key)

        # Rule 3: zero + non-zero neighbour + substantial forecast
        if day_forecast and min_neighbour_forecast_wh > 0:
            for slot_key in sorted_slots:
                actual = day_actuals.get(slot_key, 0.0)
                if actual != 0:
                    continue
                forecast_wh = day_forecast.get(slot_key, 0.0)
                if forecast_wh < min_neighbour_forecast_wh:
                    continue
                if _has_nonzero_neighbour_within_minutes(
                    slot_key,
                    day_actuals,
                    radius_minutes=radius,
                ):
                    invalidated_for_day.add(slot_key)

        if invalidated_for_day:
            invalidated_by_date[day] = invalidated_for_day

    return invalidated_by_date
