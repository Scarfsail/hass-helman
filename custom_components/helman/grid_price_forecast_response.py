from __future__ import annotations

from copy import deepcopy
from typing import Any

from .forecast_response import read_entries, slice_to_horizon

_PRICE_CHANNEL_FIELDS = (
    ("export", "exportPriceUnit", "currentExportPrice", "exportPricePoints"),
    ("import", "importPriceUnit", "currentImportPrice", "importPricePoints"),
)


def build_grid_price_forecast_response(
    snapshot: dict[str, Any],
    *,
    forecast_days: int,
) -> dict[str, Any]:
    response: dict[str, Any] = {}

    for (
        channel_key,
        unit_field,
        current_price_field,
        points_field,
    ) in _PRICE_CHANNEL_FIELDS:
        channel = _read_channel(snapshot.get(channel_key))
        response[unit_field] = channel.get("unit")
        response[current_price_field] = channel.get("currentPrice")
        response[points_field] = slice_to_horizon(
            read_entries(channel.get("points")),
            forecast_days=forecast_days,
        )

    return response


def _read_channel(raw_value: Any) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        return {}

    return {
        key: deepcopy(value)
        for key, value in raw_value.items()
    }
