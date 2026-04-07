from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable

from homeassistant.util import dt as dt_util

from .projection_builder import ApplianceDemandPoint


def aggregate_appliance_demand_by_slot(
    demand_points: Iterable[ApplianceDemandPoint],
) -> dict[str, float]:
    demand_by_slot: dict[str, float] = {}
    for point in demand_points:
        demand_by_slot[point.slot_id] = round(
            demand_by_slot.get(point.slot_id, 0.0) + point.energy_kwh,
            4,
        )
    return demand_by_slot


def build_adjusted_house_forecast(
    *,
    house_forecast: dict[str, Any],
    demand_points: Iterable[ApplianceDemandPoint],
) -> dict[str, Any]:
    adjusted_forecast = deepcopy(house_forecast)
    if adjusted_forecast.get("status") != "available":
        return adjusted_forecast
    demand_by_slot = aggregate_appliance_demand_by_slot(demand_points)
    if not demand_by_slot:
        return adjusted_forecast

    entries_by_slot = _index_house_entries(adjusted_forecast)
    for slot_id, demand_kwh in demand_by_slot.items():
        entry = entries_by_slot.get(slot_id)
        if entry is None:
            raise ValueError(f"House forecast is missing slot {slot_id!r}")
        _add_demand_to_house_entry(entry, demand_kwh)

    return adjusted_forecast


def _index_house_entries(house_forecast: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entries_by_slot: dict[str, dict[str, Any]] = {}

    for field_name in ("currentSlot", "currentHour"):
        entry = house_forecast.get(field_name)
        if isinstance(entry, dict):
            slot_id = _entry_slot_id(entry)
            if slot_id is not None:
                entries_by_slot[slot_id] = entry

    series = house_forecast.get("series")
    if not isinstance(series, list):
        return entries_by_slot

    for entry in series:
        if not isinstance(entry, dict):
            continue
        slot_id = _entry_slot_id(entry)
        if slot_id is None:
            continue
        entries_by_slot[slot_id] = entry

    return entries_by_slot


def _entry_slot_id(entry: dict[str, Any]) -> str | None:
    timestamp = entry.get("timestamp")
    if not isinstance(timestamp, str):
        return None
    parsed_timestamp = dt_util.parse_datetime(timestamp)
    if parsed_timestamp is None:
        return None
    return dt_util.as_local(parsed_timestamp).isoformat()


def _add_demand_to_house_entry(entry: dict[str, Any], demand_kwh: float) -> None:
    non_deferrable = entry.get("nonDeferrable")
    if not isinstance(non_deferrable, dict):
        raise ValueError("House forecast entry is missing nonDeferrable")

    raw_value = non_deferrable.get("value")
    if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
        raise ValueError("House forecast entry has non-numeric nonDeferrable.value")

    non_deferrable["value"] = round(float(raw_value) + demand_kwh, 4)
    for band_name in ("lower", "upper"):
        raw_band_value = non_deferrable.get(band_name)
        if raw_band_value is None:
            continue
        if isinstance(raw_band_value, bool) or not isinstance(raw_band_value, (int, float)):
            raise ValueError(
                f"House forecast entry has non-numeric nonDeferrable.{band_name}"
            )
        non_deferrable[band_name] = round(float(raw_band_value) + demand_kwh, 4)
