from __future__ import annotations

from typing import Any

from .models import SolarBiasAdjustmentResult


def build_bias_correction_payload(
    adjustment_result: SolarBiasAdjustmentResult,
) -> dict[str, Any]:
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

    return {
        "status": adjustment_result.status,
        "effectiveVariant": adjustment_result.effective_variant,
        "explainability": explainability_payload,
    }

