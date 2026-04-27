from __future__ import annotations

from datetime import datetime
import hashlib
import logging
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
_ALGORITHM_VERSION = "trimmed_mean_of_daily_ratios_v1+15min_v1"
_LOGGER = logging.getLogger(__name__)


def compute_fingerprint(cfg: BiasConfig) -> str:
    """Compute a deterministic fingerprint of the training-relevant parts of BiasConfig.

    Includes the algorithm version so training changes force a re-train. training_time
    and enabled must NOT affect the fingerprint.
    """
    payload = (
        f"algo={_ALGORITHM_VERSION};"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max}"
    )
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


def _trimmed_mean(values: List[float]) -> float | None:
    """Drop one min and max value when enough samples exist; otherwise use plain mean."""
    n = len(values)
    if n == 0:
        return None
    if n < 3:
        return sum(values) / n
    sorted_values = sorted(values)
    trimmed = sorted_values[1:-1]
    return sum(trimmed) / len(trimmed)


def _slot_to_minutes(slot: str) -> int:
    h, m = slot.split(":")
    return int(h) * 60 + int(m)


def _aggregate_actuals_into_forecast_slot(
    day_actuals: dict[str, float],
    *,
    forecast_slot: str,
    forecast_slot_keys: list[str],
) -> float:
    """Sum every actual whose slot start falls in [forecast_slot, next_forecast_slot)."""
    start = _slot_to_minutes(forecast_slot)
    idx = forecast_slot_keys.index(forecast_slot)
    if idx + 1 < len(forecast_slot_keys):
        end = _slot_to_minutes(forecast_slot_keys[idx + 1])
    else:
        end = 24 * 60  # last forecast slot of day extends to end of day
    total = 0.0
    for actual_slot, value in day_actuals.items():
        try:
            minutes = _slot_to_minutes(actual_slot)
        except (ValueError, AttributeError):
            continue
        if start <= minutes < end:
            total += value
    return total


def _serialize_invalidated_slots_by_date(
    invalidated_slots_by_date: dict[str, set[str]],
) -> dict[str, list[str]]:
    serialized: dict[str, list[str]] = {}
    for date, slots in invalidated_slots_by_date.items():
        if not slots:
            continue
        serialized[date] = sorted(slots, key=_slot_to_minutes)
    return serialized


def train(
    samples: list[TrainerSample],
    actuals: SolarActualsWindow,
    cfg: BiasConfig,
    now: datetime,
) -> TrainingOutcome:
    fingerprint = compute_fingerprint(cfg)
    invalidated_slots_by_date = _serialize_invalidated_slots_by_date(
        actuals.invalidated_slots_by_date
    )
    invalidated_slot_count = sum(
        len(slots) for slots in invalidated_slots_by_date.values()
    )
    _LOGGER.info(
        "Solar bias training run includes %s invalidated training slots",
        invalidated_slot_count,
    )

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
            dropped_days.append(
                {
                    "date": s.date,
                    "reason": "day_ratio_out_of_band",
                    "forecast_wh": f"{s.forecast_wh:.3f}",
                    "actual_wh": f"{sum_actual:.3f}",
                    "ratio": f"{ratio:.6f}",
                }
            )
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
            invalidated_slots_by_date={},
            invalidated_slot_count=0,
            error_reason=None,
        )
        return TrainingOutcome(profile=profile, metadata=metadata)

    # Determine the union of forecast slot keys across usable days.
    forecast_slot_keys: set[str] = set()
    for s in usable_samples:
        forecast_slot_keys.update(s.slot_forecast_wh.keys())

    # Collect per-slot daily ratios while retaining the existing summed-forecast floor gate.
    slot_forecast_sums: Dict[str, float] = {slot: 0.0 for slot in forecast_slot_keys}
    slot_daily_ratios: Dict[str, List[float]] = {
        slot: [] for slot in forecast_slot_keys
    }

    sorted_forecast_slots = sorted(forecast_slot_keys, key=_slot_to_minutes)
    for s in usable_samples:
        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        invalidated_slots = actuals.invalidated_slots_by_date.get(s.date, set())
        for slot in sorted_forecast_slots:
            if slot in invalidated_slots:
                continue
            day_forecast = s.slot_forecast_wh.get(slot, 0.0)
            slot_forecast_sums[slot] += day_forecast
            if day_forecast <= 0.0:
                continue
            day_actual = _aggregate_actuals_into_forecast_slot(
                day_actuals,
                forecast_slot=slot,
                forecast_slot_keys=sorted_forecast_slots,
            )
            slot_daily_ratios[slot].append(day_actual / day_forecast)

    factors: Dict[str, float] = {}
    omitted_slots: List[str] = []

    for slot in sorted_forecast_slots:
        fcast = slot_forecast_sums[slot]
        if fcast < _SLOT_FORECAST_SUM_FLOOR_WH:
            omitted_slots.append(slot)
            continue

        raw = _trimmed_mean(slot_daily_ratios[slot])
        if raw is None:
            omitted_slots.append(slot)
            continue
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
        invalidated_slots_by_date=invalidated_slots_by_date,
        invalidated_slot_count=invalidated_slot_count,
        error_reason=None,
    )

    return TrainingOutcome(profile=profile, metadata=metadata)
