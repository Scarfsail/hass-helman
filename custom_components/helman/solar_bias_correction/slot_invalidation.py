from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta


@dataclass(frozen=True)
class StateSample:
    timestamp: datetime
    value: float | bool | None


@dataclass(frozen=True)
class InvalidationInputs:
    slot_actuals_by_date: dict[str, dict[str, float]]
    max_battery_soc_percent: float | None
    battery_soc_samples: list[StateSample]
    export_enabled_samples: list[StateSample]
    slot_duration: timedelta


def compute_invalidated_slots_for_window(
    inputs: InvalidationInputs,
) -> dict[str, set[str]]:
    if not inputs.slot_actuals_by_date or inputs.max_battery_soc_percent is None:
        return {}

    battery_soc_samples = sorted(inputs.battery_soc_samples, key=lambda sample: sample.timestamp)
    export_enabled_samples = sorted(
        inputs.export_enabled_samples, key=lambda sample: sample.timestamp
    )
    tzinfo = _resolve_tzinfo(battery_soc_samples, export_enabled_samples)
    invalidated_slots_by_date: dict[str, set[str]] = {}

    for day in sorted(inputs.slot_actuals_by_date):
        invalidated_slots: set[str] = set()
        for slot in sorted(inputs.slot_actuals_by_date[day]):
            slot_start = _parse_slot_start(day, slot, tzinfo)
            slot_end = slot_start + inputs.slot_duration

            peak_soc = _peak_numeric_value(
                battery_soc_samples,
                slot_start=slot_start,
                slot_end=slot_end,
            )
            if peak_soc is None or peak_soc < inputs.max_battery_soc_percent:
                continue

            export_values = _segment_values(
                export_enabled_samples,
                slot_start=slot_start,
                slot_end=slot_end,
            )
            if not export_values or any(value is None for value in export_values):
                continue
            if any(value is False for value in export_values):
                invalidated_slots.add(slot)

        if invalidated_slots:
            invalidated_slots_by_date[day] = invalidated_slots

    return invalidated_slots_by_date


def _parse_slot_start(day: str, slot: str, tzinfo) -> datetime:
    slot_start = datetime.combine(date.fromisoformat(day), time.fromisoformat(slot))
    if tzinfo is not None:
        slot_start = slot_start.replace(tzinfo=tzinfo)
    return slot_start


def _resolve_tzinfo(
    battery_soc_samples: list[StateSample],
    export_enabled_samples: list[StateSample],
):
    for sample in [*battery_soc_samples, *export_enabled_samples]:
        if sample.timestamp.tzinfo is not None:
            return sample.timestamp.tzinfo
    return None


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
    values: list[float | bool | None] = []
    current_value: float | bool | None = None

    for sample in samples:
        if sample.timestamp <= slot_start:
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
