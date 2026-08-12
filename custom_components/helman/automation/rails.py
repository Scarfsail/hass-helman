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
from ..scheduling.schedule import (
    format_slot_id,
    iter_horizon_slot_ids,
    parse_slot_id,
)

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


def slot_bucket_starts(slot_id: str) -> tuple[datetime, ...]:
    """The forecast bucket starts a schedule slot spans, in order."""
    slot_start = parse_slot_id(slot_id)
    return tuple(
        slot_start + timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES * index)
        for index in range(
            SCHEDULE_SLOT_MINUTES // FORECAST_CANONICAL_GRANULARITY_MINUTES
        )
    )


def _next_local_midnight(timestamp: datetime) -> datetime:
    """Local midnight of the day *after* ``timestamp``'s.

    Stepping through the day in UTC and re-flooring keeps the answer right
    across a DST boundary, where the day is 23 or 25 hours long: 36 hours from
    a day's midnight lands mid-morning of the next day either way.
    """
    local_day_start = dt_util.as_local(timestamp).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    return dt_util.as_local(
        dt_util.as_utc(local_day_start) + timedelta(hours=36)
    ).replace(hour=0, minute=0, second=0, microsecond=0)


def read_export_price_by_bucket(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float]:
    """``{bucket_start: price}`` over the horizon, read as a step function.

    Unlike the fixed import-price windows, the export feed is whatever the
    configured sensor publishes as timestamped attributes — no fixed grid, no
    alignment validation, no guaranteed 15-minute spacing. The feed this was
    written against publishes **hourly** points, so a bucket-exact lookup finds
    a price for ``:00`` and nothing for ``:15``, ``:30``, ``:45``.

    Prices are a step function, so a bucket takes the most recent point at or
    before its start — the same reading :func:`..trace.price_points_to_slots`
    already gives the inspector's ``exportPrice`` rail. Reading them by exact
    lookup instead is what let an hourly feed mark only the top-of-hour slot,
    leaving the ``:30`` slot of a negative-priced hour unprotected while the
    inspector displayed the negative price against it.

    Only the published ``points`` are read; ``currentPrice`` is a separate
    reading of the bucket containing ``now`` and is left to callers, which today
    take it as an independent contributor rather than as an override.

    The step does **not** run past the end of the local day holding the last
    point. Export tariffs are published a day at a time, so the final point of a
    published day governs until midnight and the feed says nothing beyond it.
    Carrying it further would authorise tomorrow's slots on today's last price;
    absent from the map means *unknown*, which every caller reads as "not below
    the threshold" rather than as a price.
    """
    forecast = snapshot.context.export_price_forecast
    points: list[tuple[datetime, float]] = []
    raw_points = forecast.get("points")
    if isinstance(raw_points, list):
        for point in raw_points:
            if not isinstance(point, dict):
                continue
            timestamp = parse_timestamp(point.get("timestamp"))
            value = read_optional_float(point.get("value"))
            if timestamp is None or value is None:
                continue
            points.append((timestamp, value))
    points.sort(key=lambda item: dt_util.as_utc(item[0]))

    price_by_bucket: dict[datetime, float] = {}
    if points:
        coverage_end = _next_local_midnight(points[-1][0])
        index = 0
        current: float | None = None
        for slot_id in iter_horizon_slot_ids(snapshot.context.now):
            for bucket_start in slot_bucket_starts(slot_id):
                while index < len(points) and points[index][0] <= bucket_start:
                    current = points[index][1]
                    index += 1
                if current is not None and bucket_start < coverage_end:
                    price_by_bucket[bucket_start] = current
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

    if not forecast_covers_horizon(
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
    """``{bucket_start: availableSurplusKwh}`` keyed by canonical bucket start.

    Keys are floored to the bucket grid, as in
    :func:`read_soc_by_bucket_covering_horizon`. The series' **first** point is
    stamped with the raw run instant rather than a bucket start — it covers only
    the remainder of the bucket in progress — so keying by the timestamp
    verbatim produced one key no caller can ever construct. Callers look
    buckets up by flooring a slot start, which meant the bucket covering *now*
    always missed: the slot being executed could never be found solar-covered,
    and lost every coverage tie-break to future slots for no real reason.

    ``None`` when the grid forecast carries no usable series. Callers that must
    not act on a forecast stopping short of the horizon check coverage
    themselves; this reader does not.
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
        surplus_by_bucket[canonical_bucket_start(timestamp)] = available
    return surplus_by_bucket or None


def read_available_surplus_by_bucket_covering_horizon(
    snapshot: "OptimizationSnapshot",
) -> dict[datetime, float] | None:
    """As :func:`read_available_surplus_by_bucket`, but refusing partial coverage.

    A ``partial`` grid forecast *truncates* rather than pads, so a caller gating
    slots on surplus would find every slot past the truncation uncovered — a
    verdict indistinguishable from a genuine "no sun there". ``None`` means
    "unknown", which such a caller must turn into a raise rather than an empty
    mask. Callers that only *rank* on surplus want the softer reader.
    """
    from ..scheduling.schedule import build_horizon_end

    if not forecast_covers_horizon(
        snapshot.grid_forecast,
        required_coverage_until=build_horizon_end(snapshot.context.now),
    ):
        return None
    return read_available_surplus_by_bucket(snapshot)


def read_when_active_hourly_energy_kwh(
    snapshot: "OptimizationSnapshot",
    appliance_id: str,
) -> float | None:
    """The appliance's own demand while it runs, in kWh per hour, or ``None``.

    Not a forecast series, but the same shape of question: one value an
    optimizer or a condition mask reads off the snapshot rather than deriving.
    """
    from ..appliances.climate_appliance import ClimateApplianceRuntime
    from ..appliances.generic_appliance import GenericApplianceRuntime
    from ..appliances.projection_builder import get_when_active_demand_profile

    resolved = snapshot.context.when_active_hourly_energy_kwh_by_appliance_id.get(
        appliance_id
    )
    if resolved is None:
        return None
    appliance = snapshot.context.appliance_registry.get_appliance(appliance_id)
    if not isinstance(
        appliance, (GenericApplianceRuntime, ClimateApplianceRuntime)
    ):
        return None
    profile = get_when_active_demand_profile(
        appliance=appliance,
        resolved_hourly_energy_kwh=resolved,
    )
    return None if profile is None else profile.hourly_energy_kwh


def slot_solar_coverage_pct(
    *,
    slot_id: str,
    reference_time: datetime,
    available_surplus_by_bucket: dict[datetime, float],
    demand_hourly_energy: float,
) -> float | None:
    """What share of the slot's own demand the projected surplus covers, in %.

    The **worst** bucket decides. Every 15-minute bucket the slot spans has to
    clear the caller's threshold, because sampling one end would authorise a
    slot on a value that holds for half of it.

    ``None`` when the answer is not knowable: no demand to cover (the slot has
    fully elapsed) or a bucket missing from the rail. Callers treat that as "not
    covered" — the same fail-closed reading ``_min_soc_mask`` gives a missing
    bucket — so a gap can never *authorise* a slot.
    """
    from ..appliances.projection_builder import build_when_active_demand_slices

    if demand_hourly_energy <= 0:
        return None
    demand_slices = build_when_active_demand_slices(
        slot_id=slot_id,
        reference_time=reference_time,
        hourly_energy_kwh=demand_hourly_energy,
    )
    if not demand_slices:
        return None
    worst_ratio: float | None = None
    for demand_slice in demand_slices:
        available = available_surplus_by_bucket.get(demand_slice.bucket_start)
        if available is None:
            return None
        ratio = available / demand_slice.energy_kwh
        worst_ratio = ratio if worst_ratio is None else min(worst_ratio, ratio)
    return None if worst_ratio is None else worst_ratio * 100


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


def read_forecast_soc_at(
    snapshot: "OptimizationSnapshot", timestamp: datetime
) -> float | None:
    """Forecast state of charge (percent) *entering* ``timestamp``, or ``None``.

    A bucket's ``socPct`` is the level it *ends* at, so the answer is the last
    bucket that starts strictly before ``timestamp``. ``None`` means the series
    says nothing — either it carries no SoC at all, or ``timestamp`` is at or
    before its first bucket, where the caller's own live reading is the better
    answer anyway.

    An optimizer sizing a *future* day cannot use the battery's reading at run
    time: an overnight discharge sits between the two, so tonight's SoC
    understates tomorrow morning's gap and the day is sized against a battery
    that is already nearly full. This reads the same series the surplus comes
    from, so the need and the surplus covering it are quoted against one
    forecast.
    """
    raw_series = snapshot.battery_forecast.get("series")
    if not isinstance(raw_series, list):
        return None
    target = dt_util.as_utc(timestamp)
    soc: float | None = None
    latest: datetime | None = None
    for point in raw_series:
        if not isinstance(point, dict):
            continue
        point_start = parse_timestamp(point.get("timestamp"))
        if point_start is None:
            continue
        point_utc = dt_util.as_utc(point_start)
        if point_utc >= target or (latest is not None and point_utc <= latest):
            continue
        value = read_optional_float(point.get("socPct"))
        if value is None:
            continue
        soc = value
        latest = point_utc
    return soc


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


def forecast_covers_horizon(
    forecast: dict[str, Any],
    *,
    required_coverage_until: datetime,
) -> bool:
    """Whether a forecast payload is complete enough to gate decisions on.

    ``partial`` truncates rather than pads, so the caller has to know how far it
    actually reaches before treating a missing tail as a negative answer.
    """
    status = forecast.get("status")
    if status == "available":
        return True
    if status != "partial":
        return False
    coverage_until = parse_timestamp(forecast.get("coverageUntil"))
    if coverage_until is None:
        return False
    return coverage_until >= required_coverage_until
