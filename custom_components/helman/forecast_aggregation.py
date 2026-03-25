from __future__ import annotations

from typing import Any, Sequence

_BATTERY_SUM_FIELDS = (
    "durationHours",
    "solarKwh",
    "baselineHouseKwh",
    "netKwh",
    "chargedKwh",
    "dischargedKwh",
    "importedFromGridKwh",
    "exportedToGridKwh",
)
_BATTERY_LAST_FIELDS = ("remainingEnergyKwh", "socPct")
_BATTERY_OR_FIELDS = (
    "hitMinSoc",
    "hitMaxSoc",
    "limitedByChargePower",
    "limitedByDischargePower",
)
_HOUSE_BAND_FIELDS = ("value", "lower", "upper")
_RESOLUTION_BY_GRANULARITY = {
    15: "quarter_hour",
    30: "half_hour",
    60: "hour",
}


def get_aggregation_group_size(
    *,
    source_granularity_minutes: int,
    target_granularity_minutes: int,
) -> int:
    if source_granularity_minutes <= 0 or target_granularity_minutes <= 0:
        raise ValueError("Granularity values must be positive")
    if target_granularity_minutes < source_granularity_minutes:
        raise ValueError("Target granularity must not be finer than source granularity")
    if target_granularity_minutes % source_granularity_minutes != 0:
        raise ValueError(
            "Target granularity must be a whole multiple of source granularity"
        )
    return target_granularity_minutes // source_granularity_minutes


def get_forecast_resolution(granularity_minutes: int) -> str:
    resolution = _RESOLUTION_BY_GRANULARITY.get(granularity_minutes)
    if resolution is None:
        raise ValueError(
            f"Unsupported forecast granularity for resolution mapping: {granularity_minutes}"
        )
    return resolution


def aggregate_summed_points(
    points: Sequence[dict[str, Any]],
    *,
    group_size: int,
) -> list[dict[str, Any]]:
    return _aggregate_points(points, group_size=group_size, mode="sum")


def aggregate_averaged_points(
    points: Sequence[dict[str, Any]],
    *,
    group_size: int,
) -> list[dict[str, Any]]:
    return _aggregate_points(points, group_size=group_size, mode="average")


def aggregate_house_entries(
    entries: Sequence[dict[str, Any]],
    *,
    group_size: int,
) -> list[dict[str, Any]]:
    aggregated: list[dict[str, Any]] = []
    for chunk in _chunk_entries(entries, group_size):
        aggregated.append(
            {
                "timestamp": _require_timestamp(chunk[0]),
                "nonDeferrable": _aggregate_house_band(
                    [_require_dict(entry.get("nonDeferrable"), "nonDeferrable") for entry in chunk]
                ),
                "deferrableConsumers": _aggregate_deferrable_consumers(
                    [
                        _require_list(
                            entry.get("deferrableConsumers"),
                            "deferrableConsumers",
                        )
                        for entry in chunk
                    ]
                ),
            }
        )
    return aggregated


def aggregate_battery_series(
    entries: Sequence[dict[str, Any]],
    *,
    group_size: int,
) -> list[dict[str, Any]]:
    aggregated: list[dict[str, Any]] = []
    for chunk in _chunk_entries(entries, group_size):
        item = {"timestamp": _require_timestamp(chunk[0])}
        for field in _BATTERY_SUM_FIELDS:
            if any(field in entry for entry in chunk):
                _require_all_fields(chunk, field)
                item[field] = _round(
                    sum(_require_number(entry.get(field), field) for entry in chunk)
                )
        for field in _BATTERY_LAST_FIELDS:
            if any(field in entry for entry in chunk):
                _require_all_fields(chunk, field)
                item[field] = chunk[-1][field]
        for field in _BATTERY_OR_FIELDS:
            if any(field in entry for entry in chunk):
                _require_all_fields(chunk, field)
                item[field] = any(bool(entry[field]) for entry in chunk)
        aggregated.append(item)
    return aggregated


def aggregate_battery_history_entries(
    entries: Sequence[dict[str, Any]],
    *,
    group_size: int,
) -> list[dict[str, Any]]:
    aggregated: list[dict[str, Any]] = []
    for chunk in _chunk_entries(entries, group_size):
        _require_all_fields(chunk, "startSocPct")
        _require_all_fields(chunk, "socPct")
        aggregated.append(
            {
                "timestamp": _require_timestamp(chunk[0]),
                "startSocPct": chunk[0]["startSocPct"],
                "socPct": chunk[-1]["socPct"],
            }
        )
    return aggregated


def _aggregate_points(
    points: Sequence[dict[str, Any]],
    *,
    group_size: int,
    mode: str,
) -> list[dict[str, Any]]:
    aggregated: list[dict[str, Any]] = []
    for chunk in _chunk_entries(points, group_size):
        values = [_require_number(point.get("value"), "value") for point in chunk]
        aggregate_value = sum(values)
        if mode == "average":
            aggregate_value /= len(values)
        aggregated.append(
            {
                "timestamp": _require_timestamp(chunk[0]),
                "value": _round(aggregate_value),
            }
        )
    return aggregated


def _aggregate_house_band(bands: Sequence[dict[str, Any]]) -> dict[str, Any]:
    aggregated: dict[str, Any] = {}
    for field in _HOUSE_BAND_FIELDS:
        if any(field in band for band in bands):
            _require_all_fields(bands, field)
            aggregated[field] = _round(
                sum(_require_number(band.get(field), field) for band in bands)
            )
    return aggregated


def _aggregate_deferrable_consumers(
    consumer_groups: Sequence[list[Any]],
) -> list[dict[str, Any]]:
    if not consumer_groups:
        return []

    first_group = [_require_dict(consumer, "deferrableConsumers[]") for consumer in consumer_groups[0]]
    expected_ids = [_require_entity_id(consumer) for consumer in first_group]
    consumer_maps = [_build_consumer_map(group) for group in consumer_groups]
    for consumer_map in consumer_maps[1:]:
        if set(consumer_map) != set(expected_ids):
            raise ValueError("Grouped house entries must contain the same deferrable consumers")

    aggregated: list[dict[str, Any]] = []
    for entity_id, template_consumer in zip(expected_ids, first_group):
        matches = [consumer_map[entity_id] for consumer_map in consumer_maps]
        item = {"entityId": entity_id, "label": template_consumer.get("label")}
        item.update(_aggregate_house_band(matches))
        aggregated.append(item)
    return aggregated


def _build_consumer_map(consumers: list[Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for consumer in consumers:
        consumer_dict = _require_dict(consumer, "deferrableConsumers[]")
        entity_id = _require_entity_id(consumer_dict)
        result[entity_id] = consumer_dict
    return result


def _chunk_entries(
    entries: Sequence[dict[str, Any]],
    group_size: int,
) -> list[list[dict[str, Any]]]:
    if group_size <= 0:
        raise ValueError("group_size must be positive")
    if len(entries) % group_size != 0:
        raise ValueError(
            "Grouped entries length must be divisible by the aggregation group size"
        )
    return [
        list(entries[index : index + group_size])
        for index in range(0, len(entries), group_size)
    ]


def _require_all_fields(entries: Sequence[dict[str, Any]], field: str) -> None:
    if not all(field in entry for entry in entries):
        raise ValueError(f"Grouped entries are missing required field '{field}'")


def _require_timestamp(entry: dict[str, Any]) -> str:
    timestamp = entry.get("timestamp")
    if not isinstance(timestamp, str):
        raise ValueError("Grouped entries must contain a string timestamp")
    return timestamp


def _require_entity_id(entry: dict[str, Any]) -> str:
    entity_id = entry.get("entityId")
    if not isinstance(entity_id, str):
        raise ValueError("Grouped house consumer entries must contain entityId")
    return entity_id


def _require_number(raw_value: Any, field: str) -> float:
    if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
        raise ValueError(f"Field '{field}' must be numeric")
    return float(raw_value)


def _round(value: float) -> float:
    return round(value, 4)


def _require_dict(raw_value: Any, field: str) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        raise ValueError(f"Field '{field}' must be an object")
    return raw_value


def _require_list(raw_value: Any, field: str) -> list[Any]:
    if not isinstance(raw_value, list):
        raise ValueError(f"Field '{field}' must be a list")
    return raw_value
