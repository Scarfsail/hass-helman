from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..point_forecast_response import build_solar_forecast_response
from .models import SolarBiasAdjustmentResult


def compose_solar_bias_response(
    raw_snapshot: dict[str, Any],
    adjustment_result: SolarBiasAdjustmentResult,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    raw_response = build_solar_forecast_response(
        raw_snapshot,
        granularity=granularity,
        forecast_days=forecast_days,
    )
    adjusted_snapshot = deepcopy(raw_snapshot)
    adjusted_snapshot["points"] = deepcopy(adjustment_result.adjusted_points)
    adjusted_response = build_solar_forecast_response(
        adjusted_snapshot,
        granularity=granularity,
        forecast_days=forecast_days,
    )

    explainability = adjustment_result.explainability
    explainability_payload = {
        "fallbackReason": None,
        "trainedAt": None,
        "usableDays": 0,
        "droppedDays": 0,
        "omittedSlotCount": 0,
        "factorSummary": {
            "min": None,
            "max": None,
            "median": None,
        },
    }
    if explainability is not None:
        explainability_payload = {
            "fallbackReason": explainability.fallback_reason,
            "trainedAt": explainability.trained_at,
            "usableDays": explainability.usable_days,
            "droppedDays": explainability.dropped_days,
            "omittedSlotCount": explainability.omitted_slot_count,
            "factorSummary": {
                "min": explainability.factor_min,
                "max": explainability.factor_max,
                "median": explainability.factor_median,
            },
        }
        if explainability.error is not None:
            explainability_payload["error"] = explainability.error

    response = deepcopy(raw_response)
    response["adjustedPoints"] = deepcopy(adjusted_response.get("points", []))
    response["biasCorrection"] = {
        "status": adjustment_result.status,
        "effectiveVariant": adjustment_result.effective_variant,
        "explainability": explainability_payload,
    }
    return response
