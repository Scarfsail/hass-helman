from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import importlib.util
import pathlib

# Load const.py directly to avoid importing package __init__ which depends on Home Assistant
repo_helman_dir = pathlib.Path(__file__).resolve().parents[1]
const_path = repo_helman_dir / "const.py"
spec = importlib.util.spec_from_file_location("helman_const", str(const_path))
const = importlib.util.module_from_spec(spec)
spec.loader.exec_module(const)  # type: ignore


@dataclass
class BiasConfig:
    enabled: bool
    min_history_days: int
    training_time: str
    clamp_min: float
    clamp_max: float
    daily_energy_entity_ids: List[str]
    total_energy_entity_id: Optional[str]


@dataclass
class TrainerSample:
    date: str
    forecast_wh: float


@dataclass
class SolarActualsWindow:
    slot_actuals_by_date: Dict[str, List[float]]


@dataclass
class SolarBiasProfile:
    factors: Dict[str, float]
    omitted_slots: int


@dataclass
class SolarBiasMetadata:
    trained_at: str
    training_config_fingerprint: str
    usable_days: int
    dropped_days: int
    factor_min: float
    factor_max: float
    factor_median: float
    omitted_slot_count: int
    last_outcome: str
    error_reason: Optional[str] = None


@dataclass
class TrainingOutcome:
    profile: SolarBiasProfile
    metadata: SolarBiasMetadata


@dataclass
class SolarBiasExplainability:
    fallback_reason: Optional[str]
    trained_at: Optional[str]
    usable_days: int
    dropped_days: int
    omitted_slot_count: int
    factor_min: Optional[float]
    factor_max: Optional[float]
    factor_median: Optional[float]
    error: Optional[str] = None


@dataclass
class SolarBiasAdjustmentResult:
    status: str
    effective_variant: Optional[str]
    adjusted_points: List[float]
    explainability: Optional[SolarBiasExplainability]


def read_bias_config(config: Dict[str, Any]) -> BiasConfig:
    forecast = (
        config.get("power_devices", {}).get("solar", {}).get("forecast", {})
    )
    bias = forecast.get("bias_correction") or {}

    enabled = bias.get("enabled", const.SOLAR_BIAS_DEFAULT_ENABLED)
    min_history_days = bias.get(
        "min_history_days", const.SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS
    )
    training_time = bias.get("training_time", const.SOLAR_BIAS_DEFAULT_TRAINING_TIME)
    clamp_min = bias.get("clamp_min", const.SOLAR_BIAS_DEFAULT_CLAMP_MIN)
    clamp_max = bias.get("clamp_max", const.SOLAR_BIAS_DEFAULT_CLAMP_MAX)

    daily_energy_entity_ids = forecast.get("daily_energy_entity_ids") or []
    total_energy_entity_id = forecast.get("total_energy_entity_id")

    return BiasConfig(
        enabled=enabled,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        daily_energy_entity_ids=daily_energy_entity_ids,
        total_energy_entity_id=total_energy_entity_id,
    )
