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
    SolarBiasContributionRow,
    SolarBiasSlotExplainability,
    SolarBiasTrainingExplainability,
)

_DAY_FORECAST_FLOOR_WH = 100.0
_DAY_RATIO_MIN = 0.05
_DAY_RATIO_MAX = 5.0
_SLOT_FORECAST_SUM_FLOOR_WH = 50.0
_ALL_SLOTS = [f"{h:02d}:{m:02d}" for h in range(24) for m in (0, 15, 30, 45)]
_ALGORITHM_VERSION = "configurable_aggregation_v1+15min_v1+curtailment_inference_v1"
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
        f"clamp_max={cfg.clamp_max};"
        f"min_valid_slot_days={cfg.min_valid_slot_days};"
        f"aggregation_method={cfg.aggregation_method};"
        "slot_invalidation_max_battery_soc_percent="
        f"{cfg.slot_invalidation_max_battery_soc_percent};"
        "slot_invalidation_curtailment_max_export_w="
        f"{cfg.slot_invalidation_curtailment_max_export_w};"
        "slot_invalidation_curtailment_max_actual_forecast_ratio="
        f"{cfg.slot_invalidation_curtailment_max_actual_forecast_ratio};"
        "slot_invalidation_data_glitch_max_slot_wh="
        f"{cfg.slot_invalidation_data_glitch_max_slot_wh};"
        "slot_invalidation_data_glitch_min_neighbour_forecast_wh="
        f"{cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh};"
        "slot_invalidation_data_glitch_backfill_max_minutes="
        f"{cfg.slot_invalidation_data_glitch_backfill_max_minutes};"
        "max_interpolated_consecutive_slots="
        f"{cfg.max_interpolated_consecutive_slots}"
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


def _training_day_totals(
    sample: TrainerSample,
    day_actuals: dict[str, float],
    invalidated_slots: set[str],
) -> tuple[float, float]:
    forecast_slot_keys = sorted(sample.slot_forecast_wh, key=_slot_to_minutes)
    if not forecast_slot_keys:
        return sample.forecast_wh, sum(day_actuals.values())

    forecast_total = 0.0
    actual_total = 0.0
    for slot in forecast_slot_keys:
        if slot in invalidated_slots:
            continue
        forecast_total += sample.slot_forecast_wh.get(slot, 0.0)
        actual_total += _aggregate_actuals_into_forecast_slot(
            day_actuals,
            forecast_slot=slot,
            forecast_slot_keys=forecast_slot_keys,
        )
    return forecast_total, actual_total


def _interpolate_omitted_slots(
    *,
    sorted_forecast_slots: list[str],
    factors: Dict[str, float],
    omitted_slots: List[str],
    omitted_slot_reasons: Dict[str, str],
    max_run: int,
) -> dict[str, tuple[str | None, str | None]]:
    """Fill short runs of slots omitted for `slot_insufficient_valid_days` via linear interpolation.

    Mutates `factors`, `omitted_slots`, and `omitted_slot_reasons` in place. Returns a mapping
    {slot: (left_anchor_slot_or_None, right_anchor_slot_or_None)} for every interpolated slot.
    """
    if max_run <= 0:
        return {}

    eligible_reason = "slot_insufficient_valid_days"
    eligible: set[str] = {
        slot
        for slot in omitted_slots
        if omitted_slot_reasons.get(slot) == eligible_reason
    }
    if not eligible:
        return {}

    anchor_factors: dict[str, float] = dict(factors)
    interpolated: dict[str, tuple[str | None, str | None]] = {}

    i = 0
    n = len(sorted_forecast_slots)
    while i < n:
        if sorted_forecast_slots[i] not in eligible:
            i += 1
            continue
        j = i
        while j < n and sorted_forecast_slots[j] in eligible:
            j += 1
        run = sorted_forecast_slots[i:j]
        run_len = len(run)

        if run_len <= max_run:
            left_idx = i - 1
            left_slot: str | None = None
            left_value = 0.0
            while left_idx >= 0:
                candidate = sorted_forecast_slots[left_idx]
                if candidate in anchor_factors:
                    left_slot = candidate
                    left_value = anchor_factors[candidate]
                    break
                left_idx -= 1

            right_idx = j
            right_slot: str | None = None
            right_value = 0.0
            while right_idx < n:
                candidate = sorted_forecast_slots[right_idx]
                if candidate in anchor_factors:
                    right_slot = candidate
                    right_value = anchor_factors[candidate]
                    break
                right_idx += 1

            for offset, slot in enumerate(run, start=1):
                value = left_value + (right_value - left_value) * offset / (run_len + 1)
                factors[slot] = value
                interpolated[slot] = (left_slot, right_slot)

            run_set = set(run)
            for slot in run:
                omitted_slot_reasons.pop(slot, None)
            omitted_slots[:] = [s for s in omitted_slots if s not in run_set]

        i = j

    return interpolated


def _build_training_explainability(
    *,
    usable_samples: list[TrainerSample],
    dropped_days: list[dict[str, str]],
    actuals: SolarActualsWindow,
    cfg: BiasConfig,
    trained_at: str,
    forecast_slot_keys: list[str],
    factors: dict[str, float],
    omitted_slots: list[str],
    omitted_slot_reasons: dict[str, str],
    slot_forecast_sums: dict[str, float],
    slot_actual_sums: dict[str, float],
    slot_raw_ratios: dict[str, float | None],
    interpolated_anchors: dict[str, tuple[str | None, str | None]] | None = None,
) -> SolarBiasTrainingExplainability:
    slots: dict[str, SolarBiasSlotExplainability] = {}
    omitted_slot_set = set(omitted_slots)

    for slot in forecast_slot_keys:
        rows: list[SolarBiasContributionRow] = []
        for sample in usable_samples:
            invalidated = actuals.invalidated_slots_by_date.get(sample.date, set())
            day_forecast = float(sample.slot_forecast_wh.get(slot, 0.0))
            if slot in invalidated:
                rows.append(
                    SolarBiasContributionRow(
                        date=sample.date,
                        forecast_wh=day_forecast,
                        actual_wh=None,
                        ratio=None,
                        status="invalidated",
                        reason="slot_invalidated",
                    )
                )
                continue
            if day_forecast <= 0.0:
                rows.append(
                    SolarBiasContributionRow(
                        date=sample.date,
                        forecast_wh=day_forecast,
                        actual_wh=None,
                        ratio=None,
                        status="forecast_zero",
                        reason="slot_forecast_zero",
                    )
                )
                continue
            day_actual = _aggregate_actuals_into_forecast_slot(
                actuals.slot_actuals_by_date.get(sample.date, {}),
                forecast_slot=slot,
                forecast_slot_keys=forecast_slot_keys,
            )
            rows.append(
                SolarBiasContributionRow(
                    date=sample.date,
                    forecast_wh=day_forecast,
                    actual_wh=day_actual,
                    ratio=day_actual / day_forecast,
                    status="included",
                    reason=None,
                )
            )

        for dropped in dropped_days:
            day = dropped.get("date")
            if not isinstance(day, str):
                continue
            rows.append(
                SolarBiasContributionRow(
                    date=day,
                    forecast_wh=None,
                    actual_wh=None,
                    ratio=None,
                    status="dropped_day",
                    reason=dropped.get("reason"),
                )
            )

        if cfg.aggregation_method == "trimmed_mean":
            ratio_rows = [
                row for row in rows
                if row.status == "included" and row.ratio is not None
            ]
            if len(ratio_rows) >= 3:
                sorted_ratio_rows = sorted(ratio_rows, key=lambda r: r.ratio)
                trimmed_rows = {id(sorted_ratio_rows[0]): "trimmed_mean_low", id(sorted_ratio_rows[-1]): "trimmed_mean_high"}
                rows = [
                    SolarBiasContributionRow(
                        date=row.date,
                        forecast_wh=row.forecast_wh,
                        actual_wh=row.actual_wh,
                        ratio=row.ratio,
                        status="trimmed",
                        reason=trimmed_rows[id(row)],
                    )
                    if id(row) in trimmed_rows
                    else row
                    for row in rows
                ]

        forecast_sum = float(slot_forecast_sums.get(slot, 0.0))
        actual_sum = float(slot_actual_sums.get(slot, 0.0))
        raw_ratio = slot_raw_ratios.get(slot)
        factor = factors.get(slot)

        is_interpolated = (
            interpolated_anchors is not None and slot in interpolated_anchors
        )
        anchors_for_slot: tuple[str | None, str | None] | None = None
        if is_interpolated and interpolated_anchors is not None:
            anchors_for_slot = interpolated_anchors[slot]
            left_label = anchors_for_slot[0] if anchors_for_slot[0] is not None else "edge_zero"
            right_label = anchors_for_slot[1] if anchors_for_slot[1] is not None else "edge_zero"
            rows = rows + [
                SolarBiasContributionRow(
                    date="",
                    forecast_wh=None,
                    actual_wh=None,
                    ratio=None,
                    status="interpolated",
                    reason=f"left={left_label},right={right_label}",
                )
            ]

        slots[slot] = SolarBiasSlotExplainability(
            factor=factor,
            raw_ratio=raw_ratio,
            clamped=(
                raw_ratio is not None
                and factor is not None
                and abs(float(factor) - raw_ratio) > 1e-12
            ),
            forecast_sum_wh=forecast_sum,
            actual_sum_wh=actual_sum,
            rows=rows
            + (
                [
                    SolarBiasContributionRow(
                        date="",
                        forecast_wh=None,
                        actual_wh=None,
                        ratio=None,
                        status="omitted_slot",
                        reason=omitted_slot_reasons.get(slot, "slot_forecast_sum_too_low"),
                    )
                ]
                if slot in omitted_slot_set
                else []
            ),
            interpolated=is_interpolated,
            interpolation_anchors=anchors_for_slot,
        )

    return SolarBiasTrainingExplainability(
        trained_at=trained_at,
        aggregation_method=cfg.aggregation_method,
        slots=slots,
    )


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
        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        invalidated_slots = actuals.invalidated_slots_by_date.get(s.date, set())
        day_forecast, sum_actual = _training_day_totals(
            s,
            day_actuals,
            invalidated_slots,
        )

        if day_forecast < _DAY_FORECAST_FLOOR_WH:
            dropped_days.append({"date": s.date, "reason": "day_forecast_too_low"})
            continue

        # Avoid division by zero - day_forecast already passed the floor gate.
        ratio = sum_actual / day_forecast if day_forecast else 0.0
        if ratio < _DAY_RATIO_MIN or ratio > _DAY_RATIO_MAX:
            dropped_days.append(
                {
                    "date": s.date,
                    "reason": "day_ratio_out_of_band",
                    "forecast_wh": f"{day_forecast:.3f}",
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
    slot_actual_sums: Dict[str, float] = {slot: 0.0 for slot in forecast_slot_keys}
    slot_valid_day_counts: Dict[str, int] = {slot: 0 for slot in forecast_slot_keys}
    if cfg.aggregation_method == "trimmed_mean":
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
            slot_valid_day_counts[slot] += 1
            day_actual = _aggregate_actuals_into_forecast_slot(
                day_actuals,
                forecast_slot=slot,
                forecast_slot_keys=sorted_forecast_slots,
            )
            slot_actual_sums[slot] += day_actual
            if cfg.aggregation_method == "trimmed_mean":
                slot_daily_ratios[slot].append(day_actual / day_forecast)

    factors: Dict[str, float] = {}
    omitted_slots: List[str] = []
    omitted_slot_reasons: Dict[str, str] = {}
    slot_raw_ratios: Dict[str, float | None] = {}

    for slot in sorted_forecast_slots:
        valid_day_count = slot_valid_day_counts[slot]
        if valid_day_count < cfg.min_valid_slot_days:
            omitted_slots.append(slot)
            omitted_slot_reasons[slot] = "slot_insufficient_valid_days"
            continue

        fcast = slot_forecast_sums[slot]
        if fcast < _SLOT_FORECAST_SUM_FLOOR_WH:
            omitted_slots.append(slot)
            omitted_slot_reasons[slot] = "slot_forecast_sum_too_low"
            continue

        raw = None
        if cfg.aggregation_method == "ratio_of_sums":
            raw = slot_actual_sums[slot] / fcast
        elif cfg.aggregation_method == "trimmed_mean":
            raw = _trimmed_mean(slot_daily_ratios[slot])

        if raw is None:
            omitted_slots.append(slot)
            omitted_slot_reasons[slot] = "slot_no_ratio"
            continue
        slot_raw_ratios[slot] = raw
        clamped = max(cfg.clamp_min, min(raw, cfg.clamp_max))
        factors[slot] = clamped

    interpolated_anchors = _interpolate_omitted_slots(
        sorted_forecast_slots=sorted_forecast_slots,
        factors=factors,
        omitted_slots=omitted_slots,
        omitted_slot_reasons=omitted_slot_reasons,
        max_run=cfg.max_interpolated_consecutive_slots,
    )
    interpolated_slot_count = len(interpolated_anchors)

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
        interpolated_slot_count=interpolated_slot_count,
    )

    explainability = _build_training_explainability(
        usable_samples=usable_samples,
        dropped_days=dropped_days,
        actuals=actuals,
        cfg=cfg,
        trained_at=trained_at,
        forecast_slot_keys=sorted_forecast_slots,
        factors=factors,
        omitted_slots=omitted_slots,
        omitted_slot_reasons=omitted_slot_reasons,
        slot_forecast_sums=slot_forecast_sums,
        slot_actual_sums=slot_actual_sums,
        slot_raw_ratios=slot_raw_ratios,
        interpolated_anchors=interpolated_anchors,
    )

    return TrainingOutcome(profile=profile, metadata=metadata, explainability=explainability)
