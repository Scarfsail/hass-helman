from __future__ import annotations

from collections.abc import Iterator
from datetime import date, datetime
from typing import Any

from homeassistant.util.dt import as_local

from typing import TYPE_CHECKING

from ..slot_grid import floor_to_slot
from .models import LiveDayRatio

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


def live_day_ratio(
    adjusted_points: list[dict[str, Any]],
    actual_history: list[dict[str, Any]],
    now: datetime,
    cfg: BiasConfig,
) -> LiveDayRatio | None:
    """How today has produced so far against its profile-corrected forecast.

    Only elapsed slots that ``actual_history`` holds an entry for count, on
    both sides: a slot the meter reader left out is no evidence, not zero
    production, while an explicit ``0.0`` is a measured zero. The elapsed
    share is taken over those matched slots too, so missing evidence lowers
    the trust instead of only being skipped. ``None`` when today carries no
    corrected energy or nothing matched has elapsed yet.
    """
    current_slot = floor_to_slot(now)
    today = current_slot.date()
    actual_by_ts = {
        ts: value for ts, value in _today_values(actual_history, today)
    }

    day_corrected = 0.0
    corrected_elapsed = 0.0
    actual_elapsed = 0.0
    for ts, value in _today_values(adjusted_points, today):
        day_corrected += value
        if ts < current_slot and ts in actual_by_ts:
            corrected_elapsed += value
            actual_elapsed += actual_by_ts[ts]

    if day_corrected <= 0 or corrected_elapsed <= 0:
        return None

    ratio = actual_elapsed / corrected_elapsed
    applied_ratio = min(
        max(ratio, cfg.live_day_ratio_min_ratio), cfg.live_day_ratio_max_ratio
    )
    elapsed_share = corrected_elapsed / day_corrected
    weight = min(1.0, elapsed_share / cfg.live_day_ratio_full_confidence_share)
    return LiveDayRatio(
        ratio=ratio,
        applied_ratio=applied_ratio,
        weight=weight,
        factor=applied_ratio**weight,
        elapsed_share=elapsed_share,
    )


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
