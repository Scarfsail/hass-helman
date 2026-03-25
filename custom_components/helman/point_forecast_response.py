from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from .forecast_aggregation import (
    aggregate_averaged_points,
    aggregate_summed_points,
    get_aggregation_group_size,
    get_forecast_resolution,
)


def build_solar_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    return _build_point_forecast_response(
        snapshot,
        granularity=granularity,
        forecast_days=forecast_days,
        aggregation_mode="sum",
        include_actual_history=True,
    )


def build_grid_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    return _build_point_forecast_response(
        snapshot,
        granularity=granularity,
        forecast_days=forecast_days,
        aggregation_mode="average",
        include_actual_history=False,
    )


def _build_point_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
    aggregation_mode: str,
    include_actual_history: bool,
) -> dict[str, Any]:
    group_size = get_aggregation_group_size(
        source_granularity_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        target_granularity_minutes=granularity,
    )
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in {"points", "actualHistory", "resolution", "horizonHours"}
    }
    response["resolution"] = get_forecast_resolution(granularity)
    response["horizonHours"] = forecast_days * 24

    target_count = forecast_days * 24 * 60 // granularity
    response["points"] = _build_points(
        snapshot.get("points"),
        aggregation_mode=aggregation_mode,
        group_size=group_size,
        target_count=target_count,
    )
    if include_actual_history:
        response["actualHistory"] = _build_history(
            snapshot.get("actualHistory"),
            group_size=group_size,
        )
    return response


def _build_points(
    raw_points: Any,
    *,
    aggregation_mode: str,
    group_size: int,
    target_count: int,
) -> list[dict[str, Any]]:
    canonical_points = _expand_points(
        raw_points,
        expansion_mode="split" if aggregation_mode == "sum" else "repeat",
    )
    if target_count <= 0:
        return []
    if group_size == 1:
        return canonical_points[:target_count]

    complete_length = len(canonical_points) - (len(canonical_points) % group_size)
    if complete_length <= 0:
        return []

    aggregate_points = (
        aggregate_summed_points
        if aggregation_mode == "sum"
        else aggregate_averaged_points
    )
    return aggregate_points(
        canonical_points[:complete_length],
        group_size=group_size,
    )[:target_count]


def _build_history(
    raw_history: Any,
    *,
    group_size: int,
) -> list[dict[str, Any]]:
    canonical_history = _expand_points(raw_history, expansion_mode="split")
    if group_size == 1:
        return canonical_history

    complete_length = len(canonical_history) - (len(canonical_history) % group_size)
    if complete_length <= 0:
        return []
    return aggregate_summed_points(
        canonical_history[:complete_length],
        group_size=group_size,
    )


def _expand_points(
    raw_points: Any,
    *,
    expansion_mode: str,
) -> list[dict[str, Any]]:
    parsed_points = _read_points(raw_points)
    if not parsed_points:
        return []

    split_factor = _get_point_split_factor(parsed_points)
    expanded: list[dict[str, Any]] = []
    for point_start, point_value in parsed_points:
        slot_value = point_value / split_factor if expansion_mode == "split" else point_value
        for split_index in range(split_factor):
            slot_start = _advance_slots(point_start, slot_count=split_index)
            expanded.append(
                {
                    "timestamp": slot_start.isoformat(),
                    "value": round(slot_value, 4),
                }
            )
    return expanded


def _read_points(raw_points: Any) -> list[tuple[datetime, float]]:
    if not isinstance(raw_points, list):
        return []

    points: list[tuple[datetime, float]] = []
    for point in raw_points:
        if not isinstance(point, dict):
            continue

        timestamp = _parse_timestamp(point.get("timestamp"))
        value = _read_float(point.get("value"))
        if timestamp is None or value is None:
            continue

        points.append((dt_util.as_local(timestamp), value))

    points.sort(key=lambda item: dt_util.as_utc(item[0]))
    return points


def _get_point_split_factor(
    points: list[tuple[datetime, float]],
) -> int:
    if len(points) < 2:
        return 1

    candidate_intervals: list[int] = []
    for index in range(1, len(points)):
        delta_seconds = (
            dt_util.as_utc(points[index][0]) - dt_util.as_utc(points[index - 1][0])
        ).total_seconds()
        if delta_seconds <= 0:
            continue
        candidate_intervals.append(int(round(delta_seconds / 60)))

    if not candidate_intervals:
        return 1

    interval_minutes = min(candidate_intervals)
    if interval_minutes < FORECAST_CANONICAL_GRANULARITY_MINUTES:
        return 1
    if interval_minutes % FORECAST_CANONICAL_GRANULARITY_MINUTES != 0:
        return 1
    return interval_minutes // FORECAST_CANONICAL_GRANULARITY_MINUTES


def _advance_slots(value: datetime, *, slot_count: int) -> datetime:
    return dt_util.as_local(
        dt_util.as_utc(value)
        + timedelta(
            minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * slot_count
        )
    )


def _parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)


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
