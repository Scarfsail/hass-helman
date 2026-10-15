from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .config_read import parse_timestamp, read_float
from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
)
from .slot_grid import expand_points_to_grid


def build_solar_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
    corrected_points: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    internal_fields = {"raw" + "Points", "corrected" + "Points"}
    public_snapshot = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in internal_fields
    }
    response = _build_point_forecast_response(
        public_snapshot,
        forecast_days=forecast_days,
        aggregation_mode="sum",
        include_actual_history=True,
    )
    if corrected_points:
        response["adjustedPoints"] = _build_points(
            corrected_points,
            aggregation_mode="sum",
            target_count=_target_count(forecast_days),
        )
    return response


def build_price_channel_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
    unit_field: str,
    current_price_field: str,
    points_field: str,
) -> dict[str, Any]:
    response = _build_point_forecast_response(
        snapshot,
        forecast_days=forecast_days,
        aggregation_mode="average",
        include_actual_history=False,
    )
    return {
        unit_field: response.get("unit"),
        current_price_field: response.get("currentPrice"),
        points_field: response.get("points", []),
    }


def _target_count(forecast_days: int) -> int:
    return forecast_days * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES


def _build_point_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
    aggregation_mode: str,
    include_actual_history: bool,
) -> dict[str, Any]:
    response = {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in {"points", "actualHistory", "resolution", "horizonHours"}
    }

    response["points"] = _build_points(
        snapshot.get("points"),
        aggregation_mode=aggregation_mode,
        target_count=_target_count(forecast_days),
    )
    if include_actual_history:
        response["actualHistory"] = _expand_points(
            snapshot.get("actualHistory"), expansion_mode="split"
        )
    return response


def _build_points(
    raw_points: Any,
    *,
    aggregation_mode: str,
    target_count: int,
) -> list[dict[str, Any]]:
    """The snapshot's points on the canonical grid, clipped to the horizon.

    ``_expand_points`` still matters: a feed publishing coarser than canonical
    (an hourly solar or price series) is split or repeated down onto the grid.
    Only the reverse direction -- rolling canonical buckets up into a coarser
    response -- is gone.
    """
    if target_count <= 0:
        return []
    return _expand_points(
        raw_points,
        expansion_mode="split" if aggregation_mode == "sum" else "repeat",
    )[:target_count]


def _expand_points(
    raw_points: Any,
    *,
    expansion_mode: str,
) -> list[dict[str, Any]]:
    return expand_points_to_grid(_read_points(raw_points), expansion_mode=expansion_mode)


def _read_points(raw_points: Any) -> list[tuple[datetime, float]]:
    if not isinstance(raw_points, list):
        return []

    points: list[tuple[datetime, float]] = []
    for point in raw_points:
        if not isinstance(point, dict):
            continue

        timestamp = parse_timestamp(point.get("timestamp"))
        value = read_float(point.get("value"))
        if timestamp is None or value is None:
            continue

        points.append((dt_util.as_local(timestamp), value))

    points.sort(key=lambda item: dt_util.as_utc(item[0]))
    return points
