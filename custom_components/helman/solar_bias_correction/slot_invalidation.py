from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone


@dataclass(frozen=True)
class StateSample:
    timestamp: datetime
    value: float | bool | None


@dataclass(frozen=True)
class InvalidationInputs:
    max_battery_soc_percent: float
    soc_samples_utc: list[StateSample]
    export_samples_utc: list[StateSample]
    forecast_slot_starts_by_date: dict[str, list[datetime]]
    slot_keys_by_date: dict[str, list[str]]


def compute_invalidated_slots_for_window(
    inputs: InvalidationInputs,
) -> dict[str, set[str]]:
    if not inputs.forecast_slot_starts_by_date:
        return {}

    soc_samples = sorted(inputs.soc_samples_utc, key=lambda sample: sample.timestamp)
    export_samples = sorted(inputs.export_samples_utc, key=lambda sample: sample.timestamp)
    invalidated_slots_by_date: dict[str, set[str]] = {}

    for day in sorted(inputs.forecast_slot_starts_by_date):
        slot_starts = inputs.forecast_slot_starts_by_date.get(day, [])
        slot_keys = inputs.slot_keys_by_date.get(day, [])
        if len(slot_starts) != len(slot_keys):
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

            export_values = _segment_values(
                export_samples,
                slot_start=slot_start,
                slot_end=slot_end,
            )
            if any(value is False for value in export_values):
                invalidated_slots.add(slot_key)

        if invalidated_slots:
            invalidated_slots_by_date[day] = invalidated_slots

    return invalidated_slots_by_date


def _resolve_slot_end(
    day: str,
    slot_starts: list[datetime],
    index: int,
) -> datetime:
    if index + 1 < len(slot_starts):
        return slot_starts[index + 1]
    next_midnight = datetime.combine(
        date.fromisoformat(day) + timedelta(days=1),
        datetime.min.time(),
        tzinfo=timezone.utc,
    )
    return next_midnight


def _peak_numeric_value(
    samples: list[StateSample],
    *,
    slot_start: datetime,
    slot_end: datetime,
) -> float | None:
    values = _segment_values(samples, slot_start=slot_start, slot_end=slot_end)
    numeric_values = [
        float(value)
        for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]
    if not numeric_values:
        return None
    return max(numeric_values)


def _segment_values(
    samples: list[StateSample],
    *,
    slot_start: datetime,
    slot_end: datetime,
) -> list[float | bool | None]:
    """Return the values that describe the slot's state.

    Slot half-open as [slot_start, slot_end). A sample exactly at slot_start
    is treated as the first in-window sample (the new state takes effect at
    that instant), not as the carry from the previous slot. The carry is the
    most recent KNOWN sample with timestamp < slot_start; transient
    None values (HA `unknown`/`unavailable`) before slot_start are ignored
    so a sub-second blip cannot wipe out the last known state.
    """
    values: list[float | bool | None] = []
    current_value: float | bool | None = None

    for sample in samples:
        if sample.timestamp < slot_start:
            if sample.value is not None:
                current_value = sample.value
            continue
        if sample.timestamp >= slot_end:
            break
        if not values:
            values.append(current_value)
        values.append(sample.value)

    if not values:
        values.append(current_value)

    return values
