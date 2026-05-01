from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..const import (
    SOLAR_BIAS_DEFAULT_ENABLED,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS,
    SOLAR_BIAS_DEFAULT_TRAINING_TIME,
    SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    SOLAR_BIAS_DEFAULT_CLAMP_MAX,
    SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS,
    SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD,
)


@dataclass
class BiasConfig:
    enabled: bool
    min_history_days: int
    training_time: str
    clamp_min: float
    clamp_max: float
    daily_energy_entity_ids: list[str]
    total_energy_entity_id: str | None
    min_valid_slot_days: int = SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    aggregation_method: str = SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD
    slot_invalidation_max_battery_soc_percent: float | None = None
    slot_invalidation_export_enabled_entity_id: str | None = None
    slot_invalidation_data_glitch_max_slot_wh: float | None = None
    slot_invalidation_data_glitch_min_neighbour_forecast_wh: float = 200.0
    slot_invalidation_data_glitch_backfill_max_minutes: int = 120
    max_training_window_days: int = SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS


@dataclass
class TrainerSample:
    date: str
    forecast_wh: float
    slot_forecast_wh: dict[str, float]


@dataclass
class SolarActualsWindow:
    slot_actuals_by_date: dict[str, dict[str, float]]
    invalidated_slots_by_date: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class SolarBiasProfile:
    factors: dict[str, float]
    omitted_slots: list[str]


@dataclass
class SolarBiasMetadata:
    trained_at: str
    training_config_fingerprint: str
    usable_days: int
    dropped_days: list[dict[str, str]]
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    omitted_slot_count: int
    last_outcome: str
    invalidated_slots_by_date: dict[str, list[str]] = field(default_factory=dict)
    invalidated_slot_count: int = 0
    error_reason: str | None = None


@dataclass
class TrainingOutcome:
    profile: SolarBiasProfile
    metadata: SolarBiasMetadata
    explainability: SolarBiasTrainingExplainability | None = None


@dataclass
class SolarBiasExplainability:
    fallback_reason: str | None
    trained_at: str | None
    usable_days: int
    dropped_days: int
    omitted_slot_count: int
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    error: str | None = None


@dataclass
class SolarBiasAdjustmentResult:
    status: str
    effective_variant: str | None
    adjusted_points: list[dict[str, Any]]
    explainability: SolarBiasExplainability | None


@dataclass
class SolarBiasInspectorPoint:
    timestamp: str
    value_wh: float


@dataclass
class SolarBiasFactorPoint:
    slot: str
    factor: float


@dataclass
class SolarBiasImpactPoint:
    slot: str
    raw_wh: float | None
    corrected_wh: float | None
    impact_wh: float | None
    factor: float | None


@dataclass
class SolarBiasContributionRow:
    date: str
    forecast_wh: float | None
    actual_wh: float | None
    ratio: float | None
    status: str
    reason: str | None = None


@dataclass
class SolarBiasSlotExplainability:
    factor: float | None
    raw_ratio: float | None
    clamped: bool
    forecast_sum_wh: float
    actual_sum_wh: float
    rows: list[SolarBiasContributionRow]


@dataclass
class SolarBiasTrainingExplainability:
    trained_at: str
    aggregation_method: str
    slots: dict[str, SolarBiasSlotExplainability]


@dataclass
class SolarBiasInspectorSeries:
    raw: list[SolarBiasInspectorPoint]
    corrected: list[SolarBiasInspectorPoint]
    actual: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]
    invalidated: list[SolarBiasInspectorPoint] = field(default_factory=list)
    impact: list[SolarBiasImpactPoint] = field(default_factory=list)


@dataclass
class SolarBiasInspectorTotals:
    raw_wh: float | None
    corrected_wh: float | None
    actual_wh: float | None


@dataclass
class SolarBiasInspectorAvailability:
    has_raw_forecast: bool
    has_corrected_forecast: bool
    has_actuals: bool
    has_profile: bool
    has_invalidated: bool = False


@dataclass
class SolarBiasInspectorDay:
    date: str
    timezone: str
    status: str
    effective_variant: str | None
    trained_at: str | None
    min_date: str
    max_date: str
    series: SolarBiasInspectorSeries
    totals: SolarBiasInspectorTotals
    availability: SolarBiasInspectorAvailability
    is_today: bool
    is_future: bool
    training_explainability: SolarBiasTrainingExplainability | None = None


def inspector_day_to_payload(day: SolarBiasInspectorDay) -> dict[str, Any]:
    return {
        "date": day.date,
        "timezone": day.timezone,
        "status": day.status,
        "effectiveVariant": day.effective_variant,
        "trainedAt": day.trained_at,
        "range": {
            "minDate": day.min_date,
            "maxDate": day.max_date,
            "canGoPrevious": day.date > day.min_date,
            "canGoNext": day.date < day.max_date,
            "isToday": day.is_today,
            "isFuture": day.is_future,
        },
        "series": {
            "raw": [_inspector_point_payload(point) for point in day.series.raw],
            "corrected": [
                _inspector_point_payload(point) for point in day.series.corrected
            ],
            "actual": [_inspector_point_payload(point) for point in day.series.actual],
            "invalidated": [
                _inspector_point_payload(point) for point in day.series.invalidated
            ],
            "factors": [
                {"slot": point.slot, "factor": point.factor}
                for point in day.series.factors
            ],
            "impact": [_impact_point_payload(point) for point in day.series.impact],
        },
        "totals": {
            "rawWh": day.totals.raw_wh,
            "correctedWh": day.totals.corrected_wh,
            "actualWh": day.totals.actual_wh,
        },
        "availability": {
            "hasRawForecast": day.availability.has_raw_forecast,
            "hasCorrectedForecast": day.availability.has_corrected_forecast,
            "hasActuals": day.availability.has_actuals,
            "hasProfile": day.availability.has_profile,
            "hasInvalidated": day.availability.has_invalidated,
        },
        "trainingExplainability": training_explainability_to_payload(
            day.training_explainability
        ),
    }


def _inspector_point_payload(point: SolarBiasInspectorPoint) -> dict[str, Any]:
    return {"timestamp": point.timestamp, "valueWh": point.value_wh}


def _impact_point_payload(point: SolarBiasImpactPoint) -> dict[str, Any]:
    return {
        "slot": point.slot,
        "rawWh": point.raw_wh,
        "correctedWh": point.corrected_wh,
        "impactWh": point.impact_wh,
        "factor": point.factor,
    }


def training_explainability_to_payload(
    explainability: SolarBiasTrainingExplainability | None,
) -> dict[str, Any] | None:
    if explainability is None:
        return None
    return {
        "trainedAt": explainability.trained_at,
        "aggregationMethod": explainability.aggregation_method,
        "slots": {
            slot: {
                "factor": details.factor,
                "rawRatio": details.raw_ratio,
                "clamped": details.clamped,
                "forecastSumWh": details.forecast_sum_wh,
                "actualSumWh": details.actual_sum_wh,
                "rows": [
                    {
                        "date": row.date,
                        "forecastWh": row.forecast_wh,
                        "actualWh": row.actual_wh,
                        "ratio": row.ratio,
                        "status": row.status,
                        "reason": row.reason,
                    }
                    for row in details.rows
                ],
            }
            for slot, details in sorted(explainability.slots.items())
        },
    }


def read_bias_config(config: dict[str, Any]) -> BiasConfig:
    forecast = (
        config.get("power_devices", {}).get("solar", {}).get("forecast", {})
    )
    bias = forecast.get("bias_correction") or {}

    enabled = bias.get("enabled", SOLAR_BIAS_DEFAULT_ENABLED)
    min_history_days = bias.get(
        "min_history_days", SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS
    )
    max_training_window_days = bias.get(
        "max_training_window_days",
        bias.get(
            "training_window_days", SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS
        ),
    )
    training_time = bias.get("training_time", SOLAR_BIAS_DEFAULT_TRAINING_TIME)
    clamp_min = bias.get("clamp_min", SOLAR_BIAS_DEFAULT_CLAMP_MIN)
    clamp_max = bias.get("clamp_max", SOLAR_BIAS_DEFAULT_CLAMP_MAX)
    raw_min_valid_slot_days = bias.get(
        "min_valid_slot_days", SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    )
    min_valid_slot_days = SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    if isinstance(raw_min_valid_slot_days, (int, float)) and not isinstance(
        raw_min_valid_slot_days, bool
    ):
        min_valid_slot_days = int(raw_min_valid_slot_days)
    aggregation_method = bias.get("aggregation_method", SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD)
    slot_invalidation = bias.get("slot_invalidation") or {}

    daily_energy_entity_ids = forecast.get("daily_energy_entity_ids") or []
    total_energy_entity_id = bias.get("total_energy_entity_id") or forecast.get(
        "total_energy_entity_id"
    )
    max_battery_soc_percent = slot_invalidation.get("max_battery_soc_percent")
    slot_invalidation_max_battery_soc_percent = None
    if isinstance(max_battery_soc_percent, (int, float)) and not isinstance(
        max_battery_soc_percent, bool
    ):
        slot_invalidation_max_battery_soc_percent = float(max_battery_soc_percent)

    export_enabled_entity_id = slot_invalidation.get("export_enabled_entity_id")
    slot_invalidation_export_enabled_entity_id = None
    if isinstance(export_enabled_entity_id, str):
        export_enabled_entity_id = export_enabled_entity_id.strip()
        if export_enabled_entity_id:
            slot_invalidation_export_enabled_entity_id = export_enabled_entity_id

    glitch_max_slot_wh = slot_invalidation.get("data_glitch_max_slot_wh")
    slot_invalidation_data_glitch_max_slot_wh: float | None = None
    if isinstance(glitch_max_slot_wh, (int, float)) and not isinstance(
        glitch_max_slot_wh, bool
    ):
        slot_invalidation_data_glitch_max_slot_wh = float(glitch_max_slot_wh)

    glitch_min_neighbour = slot_invalidation.get(
        "data_glitch_min_neighbour_forecast_wh", 200.0
    )
    slot_invalidation_data_glitch_min_neighbour_forecast_wh = 200.0
    if isinstance(glitch_min_neighbour, (int, float)) and not isinstance(
        glitch_min_neighbour, bool
    ):
        slot_invalidation_data_glitch_min_neighbour_forecast_wh = float(
            glitch_min_neighbour
        )

    glitch_backfill = slot_invalidation.get("data_glitch_backfill_max_minutes", 120)
    slot_invalidation_data_glitch_backfill_max_minutes = 120
    if isinstance(glitch_backfill, (int, float)) and not isinstance(
        glitch_backfill, bool
    ):
        slot_invalidation_data_glitch_backfill_max_minutes = int(glitch_backfill)

    return BiasConfig(
        enabled=enabled,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        min_valid_slot_days=min_valid_slot_days,
        aggregation_method=aggregation_method,
        daily_energy_entity_ids=daily_energy_entity_ids,
        total_energy_entity_id=total_energy_entity_id,
        slot_invalidation_max_battery_soc_percent=(
            slot_invalidation_max_battery_soc_percent
        ),
        slot_invalidation_export_enabled_entity_id=(
            slot_invalidation_export_enabled_entity_id
        ),
        slot_invalidation_data_glitch_max_slot_wh=(
            slot_invalidation_data_glitch_max_slot_wh
        ),
        slot_invalidation_data_glitch_min_neighbour_forecast_wh=(
            slot_invalidation_data_glitch_min_neighbour_forecast_wh
        ),
        slot_invalidation_data_glitch_backfill_max_minutes=(
            slot_invalidation_data_glitch_backfill_max_minutes
        ),
        max_training_window_days=max_training_window_days,
    )
