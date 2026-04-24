from __future__ import annotations

from datetime import datetime
import hashlib
from typing import Dict, List

from .models import (
    BiasConfig,
    TrainerSample,
    SolarActualsWindow,
    SolarBiasProfile,
    SolarBiasMetadata,
    TrainingOutcome,
)

_DAY_FORECAST_FLOOR_WH = 100.0
_DAY_RATIO_MIN = 0.05
_DAY_RATIO_MAX = 5.0
_SLOT_FORECAST_SUM_FLOOR_WH = 50.0
_ALL_SLOTS = [f"{h:02d}:{m:02d}" for h in range(24) for m in (0, 15, 30, 45)]


def compute_fingerprint(cfg: BiasConfig) -> str:
    """Compute a deterministic fingerprint of the training-relevant parts of BiasConfig.

    Only min_history_days, clamp_min and clamp_max are included. training_time and enabled
    must NOT affect the fingerprint.
    """
    payload = f"min_history_days={cfg.min_history_days};clamp_min={cfg.clamp_min};clamp_max={cfg.clamp_max}"
    h = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"sha256:{h}"


def _median(values: List[float]) -> float | None:
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


def train(
    samples: list[TrainerSample],
    actuals: SolarActualsWindow,
    cfg: BiasConfig,
    now: datetime,
) -> TrainingOutcome:
    fingerprint = compute_fingerprint(cfg)

    usable_samples: List[TrainerSample] = []
    dropped_days: List[Dict[str, str]] = []

    for s in samples:
        if s.forecast_wh < _DAY_FORECAST_FLOOR_WH:
            dropped_days.append({"date": s.date, "reason": "day_forecast_too_low"})
            continue

        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        sum_actual = sum(day_actuals.values())

        # Avoid division by zero - forecast_wh already > 0 due to previous check
        ratio = sum_actual / s.forecast_wh if s.forecast_wh else 0.0
        if ratio < _DAY_RATIO_MIN or ratio > _DAY_RATIO_MAX:
            dropped_days.append({"date": s.date, "reason": "day_ratio_out_of_band"})
            continue

        usable_samples.append(s)

    usable_days = len(usable_samples)

    trained_at = now.isoformat()

    if usable_days < cfg.min_history_days:
        profile = SolarBiasProfile(factors={}, omitted_slots=list(_ALL_SLOTS))
        metadata = SolarBiasMetadata(
            trained_at=trained_at,
            training_config_fingerprint=fingerprint,
            usable_days=usable_days,
            dropped_days=dropped_days,
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=len(_ALL_SLOTS),
            last_outcome="insufficient_history",
            error_reason=None,
        )
        return TrainingOutcome(profile=profile, metadata=metadata)

    # Accumulate per-slot forecast and actual sums
    slot_forecast_sums: Dict[str, float] = {slot: 0.0 for slot in _ALL_SLOTS}
    slot_actual_sums: Dict[str, float] = {slot: 0.0 for slot in _ALL_SLOTS}

    for s in usable_samples:
        per_slot_forecast = s.forecast_wh / len(_ALL_SLOTS)
        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        for slot in _ALL_SLOTS:
            slot_forecast_sums[slot] += per_slot_forecast
            slot_actual_sums[slot] += day_actuals.get(slot, 0.0)

    factors: Dict[str, float] = {}
    omitted_slots: List[str] = []

    for slot in _ALL_SLOTS:
        fcast = slot_forecast_sums[slot]
        if fcast < _SLOT_FORECAST_SUM_FLOOR_WH:
            omitted_slots.append(slot)
            continue

        raw = slot_actual_sums[slot] / fcast if fcast else 0.0
        clamped = max(cfg.clamp_min, min(raw, cfg.clamp_max))
        factors[slot] = clamped

    factor_values = list(factors.values())
    factor_min = min(factor_values) if factor_values else None
    factor_max = max(factor_values) if factor_values else None
    factor_median = _median(factor_values) if factor_values else None

    profile = SolarBiasProfile(factors=factors, omitted_slots=omitted_slots)
    metadata = SolarBiasMetadata(
        trained_at=trained_at,
        training_config_fingerprint=fingerprint,
        usable_days=usable_days,
        dropped_days=dropped_days,
        factor_min=factor_min,
        factor_max=factor_max,
        factor_median=factor_median,
        omitted_slot_count=len(omitted_slots),
        last_outcome="profile_trained",
        error_reason=None,
    )

    return TrainingOutcome(profile=profile, metadata=metadata)
