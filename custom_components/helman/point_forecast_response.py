from __future__ import annotations

from typing import Any

from .forecast_response import envelope, read_entries, slice_to_horizon

_DROP_FIELDS = {
    "rawPoints",
    "correctedPoints",
    "points",
    "actualHistory",
    "resolution",
    "horizonHours",
}


def build_solar_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
    corrected_points: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Format the canonical solar snapshot for the public response.

    The response exposes the raw curve as ``points`` and the bias-adjusted
    curve as ``adjustedPoints`` when one is active.
    """
    response = envelope(snapshot, drop=_DROP_FIELDS)

    raw_points = snapshot.get("rawPoints")
    if not isinstance(raw_points, list):
        raw_points = snapshot.get("points")

    response["points"] = slice_to_horizon(
        read_entries(raw_points),
        forecast_days=forecast_days,
    )

    adjusted = corrected_points
    if adjusted is None and snapshot.get("rawPoints") is not None:
        # Internally, snapshot["points"] is the series consumers use (the adjusted
        # curve when active). If it differs from rawPoints, it is the adjusted series.
        candidate_adjusted = snapshot.get("points")
        if candidate_adjusted != snapshot.get("rawPoints"):
            adjusted = candidate_adjusted

    if adjusted:
        response["adjustedPoints"] = slice_to_horizon(
            read_entries(adjusted),
            forecast_days=forecast_days,
        )

    response["actualHistory"] = read_entries(snapshot.get("actualHistory"))
    return response
