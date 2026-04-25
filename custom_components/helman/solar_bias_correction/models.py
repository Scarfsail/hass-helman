from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..const import (
    SOLAR_BIAS_DEFAULT_ENABLED,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_TRAINING_TIME,
    SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    SOLAR_BIAS_DEFAULT_CLAMP_MAX,
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


@dataclass
class TrainerSample:
    date: str
    forecast_wh: float


@dataclass
class SolarActualsWindow:
    slot_actuals_by_date: dict[str, dict[str, float]]


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
    error_reason: str | None = None


@dataclass
class TrainingOutcome:
    profile: SolarBiasProfile
    metadata: SolarBiasMetadata


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


def read_bias_config(config: dict[str, Any]) -> BiasConfig:
    forecast = (
        config.get("power_devices", {}).get("solar", {}).get("forecast", {})
    )
    bias = forecast.get("bias_correction") or {}

    enabled = bias.get("enabled", SOLAR_BIAS_DEFAULT_ENABLED)
    min_history_days = bias.get(
        "min_history_days", SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS
    )
    training_time = bias.get("training_time", SOLAR_BIAS_DEFAULT_TRAINING_TIME)
    clamp_min = bias.get("clamp_min", SOLAR_BIAS_DEFAULT_CLAMP_MIN)
    clamp_max = bias.get("clamp_max", SOLAR_BIAS_DEFAULT_CLAMP_MAX)

    daily_energy_entity_ids = forecast.get("daily_energy_entity_ids") or []
    total_energy_entity_id = bias.get("total_energy_entity_id") or forecast.get(
        "total_energy_entity_id"
    )

    return BiasConfig(
        enabled=enabled,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        daily_energy_entity_ids=daily_energy_entity_ids,
        total_energy_entity_id=total_energy_entity_id,
    )
