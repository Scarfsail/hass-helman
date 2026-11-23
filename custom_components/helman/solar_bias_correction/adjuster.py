from __future__ import annotations

import math
from collections.abc import Iterator
from datetime import date, datetime
from typing import Any

from homeassistant.util.dt import as_local

from typing import TYPE_CHECKING

from ..slot_grid import floor_to_slot
from .models import LiveDayRatio, TodayGauge

if TYPE_CHECKING:
    from .models import BiasConfig, SolarBiasProfile


def _parse_timestamp(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        # datetime.fromisoformat handles offsets like +00:00
        return datetime.fromisoformat(raw)
    except Exception:
        return None


def _local_slot_key(ts: datetime) -> str:
    # Convert to local timezone-aware datetime
    local = as_local(ts)
    # floor to 15-minute boundary
    minute = (local.minute // 15) * 15
    return f"{local.hour:02d}:{minute:02d}"


def adjust(raw_points: list[dict[str, Any]], profile: SolarBiasProfile) -> list[dict[str, Any]]:
    """Return a new list of adjusted points using the provided profile.

    - Preserves timestamp strings unchanged.
    - Uses as_local() to compute the local slot.
    - Missing factor defaults to 1.0.
    - Adjusted value is clamped to non-negative values.
    - Does not mutate input list or its dicts.
    - If timestamp is unparseable or value missing, returns a copied point unchanged.
    """
    if not raw_points:
        return []

    adjusted: list[dict[str, Any]] = []
    for point in raw_points:
        # copy to avoid mutating original
        p = dict(point)

        ts_raw = p.get("timestamp")
        value = p.get("value")

        ts = _parse_timestamp(ts_raw)
        if ts is None or value is None:
            adjusted.append(p)
            continue

        try:
            slot = _local_slot_key(ts)
        except Exception:
            # If as_local or slot computation fails, preserve as-is
            adjusted.append(p)
            continue

        factor = profile.factors.get(slot, 1.0)

        try:
            raw_val = float(value)
        except Exception:
            adjusted.append(p)
            continue

        adjusted_value = max(0.0, raw_val * float(factor))

        p["value"] = adjusted_value
        adjusted.append(p)

    return adjusted


def _today_values(
    points: list[dict[str, Any]], today: date
) -> Iterator[tuple[datetime, float]]:
    for point in points:
        ts = _parse_timestamp(point.get("timestamp"))
        value = point.get("value")
        if ts is None or value is None or as_local(ts).date() != today:
            continue
        yield ts, float(value)


def _matched_elapsed_slots(
    points: list[dict[str, Any]],
    actual_history: list[dict[str, Any]],
    current_slot: datetime,
) -> Iterator[tuple[datetime, float, float]]:
    """Today's elapsed slots ``actual_history`` holds an entry for.

    Yields ``(timestamp, forecast, actual)``. A slot the meter reader left out
    is no evidence, not zero production, while an explicit ``0.0`` is a
    measured zero.
    """
    today = current_slot.date()
    actual_by_ts = {
        ts: value for ts, value in _today_values(actual_history, today)
    }
    for ts, value in _today_values(points, today):
        if ts < current_slot and ts in actual_by_ts:
            yield ts, value, actual_by_ts[ts]


def live_day_ratio(
    adjusted_points: list[dict[str, Any]],
    actual_history: list[dict[str, Any]],
    now: datetime,
    cfg: BiasConfig,
) -> LiveDayRatio | None:
    """How today has produced so far against its profile-corrected forecast.

    Only the matched elapsed slots count, on both sides (see
    :func:`_matched_elapsed_slots`). The elapsed share is taken over those
    matched slots too, so missing evidence lowers the trust instead of only
    being skipped. ``None`` when today carries no corrected energy or nothing
    matched has elapsed yet.
    """
    current_slot = floor_to_slot(now)
    day_corrected = sum(
        value for _, value in _today_values(adjusted_points, current_slot.date())
    )
    corrected_elapsed = 0.0
    actual_elapsed = 0.0
    for _, corrected, actual in _matched_elapsed_slots(
        adjusted_points, actual_history, current_slot
    ):
        corrected_elapsed += corrected
        actual_elapsed += actual

    if day_corrected <= 0 or corrected_elapsed <= 0:
        return None

    ratio = actual_elapsed / corrected_elapsed
    applied_ratio = _clamp_ratio(ratio, cfg)
    elapsed_share = corrected_elapsed / day_corrected
    weight = min(1.0, elapsed_share / cfg.live_day_ratio_full_confidence_share)
    return LiveDayRatio(
        ratio=ratio,
        applied_ratio=applied_ratio,
        weight=weight,
        factor=applied_ratio**weight,
        elapsed_share=elapsed_share,
    )


def _clamp_ratio(ratio: float, cfg: BiasConfig) -> float:
    return min(max(ratio, cfg.live_day_ratio_min_ratio), cfg.live_day_ratio_max_ratio)


#: How far the uncorrected gap ``g`` must stray from 1 before the gauge calls
#: the rest of today likely lower or higher.
_DIRECTION_THRESHOLD = 0.05


def today_gauge(
    raw_points: list[dict[str, Any]],
    corrected_points: list[dict[str, Any]],
    final_points: list[dict[str, Any]],
    actual_history: list[dict[str, Any]],
    live: LiveDayRatio | None,
    now: datetime,
    cfg: BiasConfig,
) -> TodayGauge:
    """Every number the solar day gauge draws, for today.

    The before-now sums run over the matched elapsed slots the live day ratio
    uses, and are ``None`` with the trust while ``live`` is; the rest of today
    runs from the current slot, where
    :func:`apply_live_day_ratio` starts scaling. ``corrected_points`` are the
    profile-only points, ``final_points`` the same after the live ratio.

    Trust is a heuristic from today's own data: ``g`` is the part of today's
    miss the live correction has not taken up (``r / factor``), ``s`` how much
    each elapsed hour's ratio swung around ``r``, energy-weighted on a log
    scale. Trust is ``e^-sqrt(ln(g)^2 + s^2)`` and the likely rest of today
    ``final_rest * g * e^(-/+s)``.
    """
    current_slot = floor_to_slot(now)
    today = current_slot.date()

    raw_rest = sum(v for ts, v in _today_values(raw_points, today) if ts >= current_slot)
    final_rest = sum(
        v for ts, v in _today_values(final_points, today) if ts >= current_slot
    )
    gauge = TodayGauge(at=current_slot, raw_rest=raw_rest, final_rest=final_rest)
    # ``live`` is None until a matched elapsed slot carries corrected energy:
    # the night and dawn show the rest of today only.
    if live is None:
        return gauge

    matched = list(
        _matched_elapsed_slots(corrected_points, actual_history, current_slot)
    )
    raw_by_ts = dict(_today_values(raw_points, today))
    gauge.raw_so_far = sum(raw_by_ts.get(ts, 0.0) for ts, _, _ in matched)
    gauge.corrected_so_far = sum(corrected for _, corrected, _ in matched)
    gauge.actual_so_far = sum(actual for _, _, actual in matched)

    factor = live.factor if cfg.live_day_ratio_enabled else 1.0
    # Clamped to the live ratio's bounds, so a noisy first slot at dawn cannot
    # blow the range up; the ratio itself stays unclamped, so the miss the
    # correction cannot take up past its cap still shows.
    gap = _clamp_ratio(live.ratio / factor, cfg)
    swing = _hourly_swing(matched, live.ratio, cfg)
    gauge.trust = math.exp(-math.hypot(math.log(gap), swing))
    gauge.likely_low = final_rest * gap * math.exp(-swing)
    gauge.likely_high = final_rest * gap * math.exp(swing)
    if gap < 1 - _DIRECTION_THRESHOLD:
        gauge.direction = "lower"
    elif gap > 1 + _DIRECTION_THRESHOLD:
        gauge.direction = "higher"
    return gauge


def _hourly_swing(
    matched: list[tuple[datetime, float, float]], ratio: float, cfg: BiasConfig
) -> float:
    """Energy-weighted RMS of ``ln(r_h / r)`` over the elapsed local hours.

    Each ratio is clamped to the live ratio's bounds first, so an hour of
    zero production swings by a finite amount; an hour with no corrected
    energy carries no weight and is skipped.
    """
    hours: dict[str, list[float]] = {}
    for ts, corrected, actual in matched:
        # The isoformat keeps its offset, so the repeated hour of a DST
        # fall-back stays two buckets.
        hour = as_local(ts).replace(minute=0, second=0, microsecond=0).isoformat()
        bucket = hours.setdefault(hour, [0.0, 0.0])
        bucket[0] += corrected
        bucket[1] += actual

    reference = _clamp_ratio(ratio, cfg)
    weight_sum = 0.0
    weighted = 0.0
    for corrected, actual in hours.values():
        if corrected <= 0:
            continue
        log_swing = math.log(_clamp_ratio(actual / corrected, cfg) / reference)
        weight_sum += corrected
        weighted += corrected * log_swing**2
    return math.sqrt(weighted / weight_sum) if weight_sum > 0 else 0.0


def apply_live_day_ratio(
    adjusted_points: list[dict[str, Any]],
    live: LiveDayRatio,
    now: datetime,
) -> list[dict[str, Any]]:
    """Scale today's current and later slots by ``live.factor``.

    Same contract as :func:`adjust`: new dicts, non-negative values. Elapsed
    slots keep their profile-only value and other days are untouched.
    """
    current_slot = floor_to_slot(now)
    today = current_slot.date()
    scaled: list[dict[str, Any]] = []
    for point in adjusted_points:
        p = dict(point)
        ts = _parse_timestamp(p.get("timestamp"))
        value = p.get("value")
        if (
            ts is not None
            and value is not None
            and ts >= current_slot
            and as_local(ts).date() == today
        ):
            p["value"] = max(0.0, float(value) * live.factor)
        scaled.append(p)
    return scaled
