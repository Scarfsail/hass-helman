from __future__ import annotations

from copy import deepcopy
from typing import Any

from .point_forecast_response import build_price_channel_response

_PRICE_CHANNEL_FIELDS = (
    ("export", "exportPriceUnit", "currentExportPrice", "exportPricePoints"),
    ("import", "importPriceUnit", "currentImportPrice", "importPricePoints"),
)


def build_grid_price_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    response: dict[str, Any] = {}

    for (
        channel_key,
        unit_field,
        current_price_field,
        points_field,
    ) in _PRICE_CHANNEL_FIELDS:
        response.update(
            build_price_channel_response(
                _read_channel(snapshot.get(channel_key)),
                granularity=granularity,
                forecast_days=forecast_days,
                unit_field=unit_field,
                current_price_field=current_price_field,
                points_field=points_field,
            )
        )

    return response


def _read_channel(raw_value: Any) -> dict[str, Any]:
    if not isinstance(raw_value, dict):
        return {}

    return {
        key: deepcopy(value)
        for key, value in raw_value.items()
    }
