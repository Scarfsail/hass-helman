"""Snapshot readers shared by every optimizer.

The "rails" are the forecast series an optimizer reads to decide: prices, SoC,
surplus. Every optimizer used to carry its own private copy of these parsers
(five identical ``_parse_timestamp``, two identical ``_build_price_by_bucket_start``,
two ``_canonical_bucket_start`` differing only in whether the granularity was
hardcoded). They live here once so an optimizer module contains only its own
decision logic.

Nothing here validates config; see :mod:`.fields` for that.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from ..const import FORECAST_CANONICAL_GRANULARITY_MINUTES, SCHEDULE_SLOT_MINUTES
from ..scheduling.schedule import format_slot_id

if TYPE_CHECKING:
    from .snapshot import OptimizationSnapshot

_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)


def parse_timestamp(value: object) -> datetime | None:
    """Parse a forecast point's ISO timestamp into local time, or ``None``."""
    if not isinstance(value, str):
        return None
    parsed = dt_util.parse_datetime(value)
    if parsed is None or parsed.tzinfo is None:
        return None
    return dt_util.as_local(parsed)


def read_optional_float(value: object) -> float | None:
    """Coerce a forecast value to ``float``, or ``None`` when it is not numeric."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def canonical_bucket_start(
    timestamp: datetime,
    *,
    granularity_minutes: int = FORECAST_CANONICAL_GRANULARITY_MINUTES,
) -> datetime:
    """Floor ``timestamp`` to its forecast bucket start, in local time.

    Bucketing is anchored at local midnight (not at the epoch) so a DST shift
    cannot slide the grid off the day boundary.
    """
    local_reference = dt_util.as_local(timestamp)
    local_day_start = local_reference.replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    slot_duration_seconds = granularity_minutes * 60
    elapsed_seconds = max(
        0.0,
        (
            dt_util.as_utc(local_reference) - dt_util.as_utc(local_day_start)
        ).total_seconds(),
    )
    slot_index = int(elapsed_seconds // slot_duration_seconds)
    slot_start_utc = dt_util.as_utc(local_day_start) + timedelta(
        seconds=slot_index * slot_duration_seconds
    )
    return dt_util.as_local(slot_start_utc)


def read_price_by_bucket(price_forecast: dict[str, Any]) -> dict[datetime, float]:
    """``{bucket_start: price}`` from an import/export price forecast payload."""
    points = price_forecast.get("points")
    if not isinstance(points, list):
        return {}
    price_by_bucket: dict[datetime, float] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        value = read_optional_float(point.get("value"))
        if timestamp is None or value is None:
            continue
        price_by_bucket[timestamp] = value
    return price_by_bucket


def read_soc_by_bucket(
    snapshot: "OptimizationSnapshot",
) -> list[tuple[datetime, float]]:
    """The projected battery SoC trajectory, ascending by bucket start."""
    raw_series = snapshot.battery_forecast.get("series")
    if not isinstance(raw_series, list):
        return []
    soc_by_bucket: list[tuple[datetime, float]] = []
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        soc_pct = read_optional_float(point.get("socPct"))
        if timestamp is None or soc_pct is None:
            continue
        soc_by_bucket.append((timestamp, soc_pct))
    soc_by_bucket.sort(key=lambda item: dt_util.as_utc(item[0]))
    return soc_by_bucket


def read_soc_by_bucket_covering_horizon(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float] | None:
    """``{bucket_start: socPct}``, or ``None`` unless the forecast spans the horizon.

    As :func:`read_soc_by_bucket`, but keyed for lookup and refusing partial
    coverage: a caller gating slots on SoC must not read a trajectory that stops
    halfway through the horizon, because the slots past the end would silently
    look ineligible rather than unknown.
    """
    from ..scheduling.schedule import build_horizon_end

    if not _forecast_covers_horizon(
        snapshot.battery_forecast,
        required_coverage_until=build_horizon_end(snapshot.context.now),
    ):
        return None
    soc_by_bucket = {
        canonical_bucket_start(timestamp): soc_pct
        for timestamp, soc_pct in read_soc_by_bucket(snapshot)
    }
    return soc_by_bucket or None


def read_available_surplus_by_bucket(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float] | None:
    """``{bucket_start: availableSurplusKwh}`` keyed by the forecast's own timestamps.

    ``None`` when the grid forecast carries no usable series. Use
    :func:`read_available_surplus_by_bucket_covering_horizon` when the caller
    must not act on a forecast that stops short of the schedule horizon.
    """
    raw_series = snapshot.grid_forecast.get("series")
    if not isinstance(raw_series, list):
        return None
    surplus_by_bucket: dict[datetime, float] = {}
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        available = read_optional_float(point.get("availableSurplusKwh"))
        if timestamp is None or available is None:
            continue
        surplus_by_bucket[timestamp] = available
    return surplus_by_bucket or None


def read_available_surplus_by_bucket_covering_horizon(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float] | None:
    """As :func:`read_available_surplus_by_bucket`, but refuses partial coverage.

    Returns ``None`` unless the adjusted house forecast is available and both the
    battery and grid forecasts reach the end of the schedule horizon. Keys are
    floored to the grid forecast's *source* granularity so they line up with the
    demand slices a caller compares them against.
    """
    from ..scheduling.schedule import build_horizon_end

    if snapshot.adjusted_house_forecast.get("status") != "available":
        return None

    required_coverage_until = build_horizon_end(snapshot.context.now)
    if not _forecast_covers_horizon(
        snapshot.battery_forecast,
        required_coverage_until=required_coverage_until,
    ):
        return None
    if not _forecast_covers_horizon(
        snapshot.grid_forecast,
        required_coverage_until=required_coverage_until,
    ):
        return None

    raw_series = snapshot.grid_forecast.get("series")
    if not isinstance(raw_series, list):
        return None

    source_granularity_minutes = snapshot.grid_forecast.get("sourceGranularityMinutes")
    if (
        not isinstance(source_granularity_minutes, int)
        or source_granularity_minutes <= 0
    ):
        source_granularity_minutes = FORECAST_CANONICAL_GRANULARITY_MINUTES

    surplus_by_bucket: dict[datetime, float] = {}
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        available_surplus_kwh = read_optional_float(point.get("availableSurplusKwh"))
        if timestamp is None or available_surplus_kwh is None:
            continue
        bucket_start = canonical_bucket_start(
            timestamp,
            granularity_minutes=source_granularity_minutes,
        )
        surplus_by_bucket[bucket_start] = available_surplus_kwh
    return surplus_by_bucket


def read_clipped_surplus_by_bucket(
    snapshot: "OptimizationSnapshot",
    *,
    max_charge_power_kw: float,
) -> list[tuple[datetime, float]]:
    """Solar-minus-baseline-house surplus per bucket, clipped to charge power.

    What the battery could actually absorb from each bucket's surplus — the
    figure charge_hold sizes its hold against.
    """
    raw_series = snapshot.battery_forecast.get("series")
    if not isinstance(raw_series, list):
        return []

    surplus_by_bucket: list[tuple[datetime, float]] = []
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        timestamp = parse_timestamp(point.get("timestamp"))
        solar_kwh = read_optional_float(point.get("solarKwh"))
        house_kwh = read_optional_float(point.get("baselineHouseKwh"))
        if timestamp is None or solar_kwh is None or house_kwh is None:
            continue
        duration_hours = read_optional_float(point.get("durationHours"))
        if duration_hours is None or duration_hours <= 0:
            duration_hours = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
        raw_surplus = max(0.0, solar_kwh - house_kwh)
        surplus_by_bucket.append(
            (timestamp, min(raw_surplus, max_charge_power_kw * duration_hours))
        )
    return surplus_by_bucket


def horizon_slots_between(
    start: datetime,
    end: datetime,
    *,
    horizon_start: datetime,
    horizon_end: datetime,
) -> list[str]:
    """Slot ids of ``[start, end)`` that also fall inside the schedule horizon."""
    slots: list[str] = []
    cursor = start
    while cursor < end:
        if horizon_start <= cursor < horizon_end:
            slots.append(format_slot_id(cursor))
        cursor += _SLOT_DURATION
    return slots


def _forecast_covers_horizon(
    forecast: dict[str, Any],
    *,
    required_coverage_until: datetime,
) -> bool:
    status = forecast.get("status")
    if status == "available":
        return True
    if status != "partial":
        return False
    coverage_until = parse_timestamp(forecast.get("coverageUntil"))
    if coverage_until is None:
        return False
    return coverage_until >= required_coverage_until
