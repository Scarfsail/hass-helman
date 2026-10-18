from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from ..device_reports.dataset import price_hourly_series
from ..solar_bias_correction.statistics_day import finite_mean
from ..span_buckets import add_months, bucket_key, bucket_keys
from .day import _consumer_own_energy, _round_kwh, _round_wh

#: How many buckets one span read may return, per bucket size.
_MAX_AGGREGATE_BUCKETS = {"day": 366, "month": 13}

def _last_day_of_month(anchor: date) -> date:
    return add_months(anchor, 1) - timedelta(days=1)


def _trim_span_to_cap(start_date: date, end_date: date, bucket: str) -> date:
    """Move the span's start forward until it fits :data:`_MAX_AGGREGATE_BUCKETS`.

    The recent end is what a reader is looking at, so the far end is what gets
    dropped -- the same choice the day pills have always made.
    """
    cap = _MAX_AGGREGATE_BUCKETS[bucket]
    if bucket == "day":
        return max(start_date, end_date - timedelta(days=cap - 1))
    return max(start_date, add_months(end_date.replace(day=1), -(cap - 1)))


def _resolve_span_bounds(
    raw_start_date: str,
    raw_end_date: str,
    bucket: str,
    local_tz: ZoneInfo,
    local_now: datetime,
) -> tuple[str, date, date, datetime, datetime, datetime | None]:
    """Snap bucket edges, trim to cap and calculate local start/end and tail start."""
    valid_bucket = bucket if bucket in _MAX_AGGREGATE_BUCKETS else "day"
    start_date = date.fromisoformat(raw_start_date)
    end_date = date.fromisoformat(raw_end_date)

    if valid_bucket == "month":
        start_date = start_date.replace(day=1)
        end_date = _last_day_of_month(end_date)
    end_date = min(end_date, local_now.date())
    if end_date < start_date:
        local_start = datetime.combine(start_date, time(0, 0), tzinfo=local_tz)
        local_end = datetime.combine(end_date + timedelta(days=1), time(0, 0), tzinfo=local_tz)
        return valid_bucket, start_date, end_date, local_start, local_end, None

    start_date = _trim_span_to_cap(start_date, end_date, valid_bucket)
    local_start = datetime.combine(start_date, time(0, 0), tzinfo=local_tz)
    local_end = datetime.combine(end_date + timedelta(days=1), time(0, 0), tzinfo=local_tz)

    tail_start = None
    if end_date == local_now.date():
        newest_bucket_start = end_date if valid_bucket == "day" else end_date.replace(day=1)
        tail_start = max(
            local_start,
            datetime.combine(newest_bucket_start, time(0, 0), tzinfo=local_tz),
        )

    return valid_bucket, start_date, end_date, local_start, local_end, tail_start


def _energy_by_bucket(
    hourly_kwh: dict[datetime, float],
    bucket: str,
    local_tz: ZoneInfo,
) -> dict[str, float]:
    """A meter's energy per bucket, folded from its per-hour energy.

    The hourly figures arrive already differenced and reset-unwrapped from
    :mod:`..recorder_statistics_span`; the only thing left to decide here is
    which local day or month each UTC hour belongs to. Deliberately not the
    statistics ``change`` column -- see that module's docstring for what that
    column does to a meter that glitches.

    A bucket appears here only if at least one of its hours reported energy, so a
    caller can tell "nothing recorded" from "recorded zero".
    """
    totals: dict[str, float] = {}
    for utc_hour, kwh in hourly_kwh.items():
        key = bucket_key(utc_hour, bucket, local_tz)
        totals[key] = totals.get(key, 0.0) + kwh
    return totals


def _soc_bounds_by_bucket(
    rows: dict[datetime, dict[str, Any]],
    bucket: str,
    local_tz: ZoneInfo,
) -> dict[str, tuple[float | None, float | None]]:
    """The lowest and highest SoC each bucket reached.

    Statistics carry the true per-hour min and max, so folding them is exact --
    strictly better than scanning raw states, which sees only what has not been
    purged yet and quietly reports the surviving extremes as the day's.

    The cost of that exactness: ``min``/``max`` exist only for an entity Home
    Assistant compiles statistics for, which means a SoC sensor declaring
    ``state_class: measurement``. A template or REST sensor without one reports
    ``None`` for every bucket here, where the raw-state scan this replaced would
    have read any numeric sensor. The pills draw such a battery as having no SoC
    history at all rather than showing a wrong one, which is the safer of the two
    failures but is a behaviour change worth knowing about.
    """
    bounds: dict[str, tuple[float | None, float | None]] = {}
    for utc_hour, row in rows.items():
        low_value = row.get("min")
        high_value = row.get("max")
        if low_value is None and high_value is None:
            continue
        key = bucket_key(utc_hour, bucket, local_tz)
        low, high = bounds.get(key, (None, None))
        if low_value is not None:
            low = low_value if low is None else min(low, low_value)
        if high_value is not None:
            high = high_value if high is None else max(high, high_value)
        bounds[key] = (low, high)
    return bounds


def _money_by_bucket(
    import_kwh_by_hour: dict[datetime, float],
    export_kwh_by_hour: dict[datetime, float],
    import_rate: dict[datetime, float],
    export_rate: dict[datetime, float],
    *,
    bucket: str,
    local_tz: ZoneInfo,
) -> dict[str, tuple[float | None, float | None, float | None, float | None]]:
    """Cost and gain per bucket, priced hour by hour, with the kWh each priced.

    Never a bucket's kWh times a bucket's mean rate: the expensive hours are
    rarely the ones the house imported in, which is the same reason
    :func:`_money_points` prices the day per slot.

    The rates arrive already resolved per hour by
    :func:`~..span_history.read_span_history`, with the inspector day's
    precedence -- recorded history first. The import rate is the price sensor
    Helman publishes, whose hourly ``mean`` is real tariff history from the day
    the feature shipped; the configured window table fills only the hours
    statistics have nothing for, per hour and never per bucket, because the
    sensor's ship date and the recorder's retention edge each fall mid-span and
    anything coarser would either blank a covered stretch or overwrite recorded
    truth with today's tariff.

    Known limitation, stated rather than engineered around: the window table is
    keyed on minute-of-day and holds no history, so buckets older than the price
    sensor are priced at *today's* tariff. That is the approximation the day view
    already makes for a pre-sensor day; a year view simply shows more of them. An
    approximate cost is more useful here than a hole.

    A second one, in the same spirit: an hour with neither a recorded rate nor a
    window covering it contributes its energy to no total at all, so a bucket
    straddling the price sensor's ship date reports the cost of the hours it
    could price without saying which those were. ``None`` is reserved for a
    bucket nothing in which could be priced. A setup with import windows
    configured -- the normal one -- always has the fallback and never lands
    here.

    The export rate has no such fill -- there is no table to fall back on, since
    a spot export price is not derivable from config. Its rows come from the
    mirror Helman publishes for exactly this reason (the configured sell-price
    entity typically declares no ``state_class`` and so has no statistics at
    all), and from that mirror alone: an hour Helman recorded nothing for is
    unpriced and its ``gain`` is None -- the honest answer,
    since "earned nothing" is a claim the data does not support. The day view
    lets the *live* export feed override the recorder; history has no live feed,
    so that does not carry over.

    Returns ``{bucket_key: (cost, gain, cost_kwh, gain_kwh)}``: either side
    None where nothing in the bucket could be priced, and the kWh each side
    priced beside it.
    """
    def key_for(utc_hour: datetime) -> str:
        return bucket_key(utc_hour, bucket, local_tz)

    cost = price_hourly_series(import_kwh_by_hour, import_rate, key_fn=key_for)
    gain = price_hourly_series(export_kwh_by_hour, export_rate, key_fn=key_for)

    return {
        key: (
            cost[key].amount if key in cost else None,
            gain[key].amount if key in gain else None,
            cost[key].priced_kwh if key in cost else None,
            gain[key].priced_kwh if key in gain else None,
        )
        for key in cost.keys() | gain.keys()
    }


def _house_forecast_by_bucket(
    rows: dict[datetime, dict[str, Any]],
    bucket: str,
    local_tz: ZoneInfo,
) -> dict[str, float]:
    """The house forecast predicted per bucket, in kWh.

    The sensor publishes power, so an hour's mean W *is* that hour's Wh -- the
    arithmetic :func:`statistics_day._house_forecast_points` does for the day
    view past raw retention. A bucket with no hour carrying a mean is absent,
    which the payload reports as ``None`` rather than as a zero forecast.
    """
    by_bucket: dict[str, float] = {}
    for utc_hour, row in rows.items():
        mean_w = finite_mean(row)
        if mean_w is None:
            continue
        key = bucket_key(utc_hour, bucket, local_tz)
        by_bucket[key] = by_bucket.get(key, 0.0) + mean_w / 1000.0
    return by_bucket


def _bucket_house_breakdown(
    consumers: list[dict],
    consumer_kwh_by_entity: dict[str, dict[str, float]],
    key: str,
    house_wh: float | None,
) -> dict[str, Any] | None:
    """One bucket's house split into per-consumer parts and the remainder.

    The bucket-level twin of :func:`_build_house_actual_breakdown`, and
    deliberately the same arithmetic: each consumer's energy over the bucket,
    clamped at zero, and a remainder that is the house total minus their sum,
    clamped at zero so a meter that momentarily over-reports never reads
    negative. The payload keys match ``_house_breakdown_payload``'s appliance
    shape exactly, so the frontend parses a bucket's breakdown with the types it
    already has for a slot's.

    ``None`` -- and so no panel at all -- where there is nothing to split by or
    nothing to split: no consumers configured, or a bucket the house meter
    reported no energy for.
    """
    if not consumers or house_wh is None:
        return None
    appliances: list[dict[str, Any]] = []
    measured_sum = 0.0
    for consumer in consumers:
        entity_id = consumer.get("energy_entity_id")
        by_bucket = consumer_kwh_by_entity.get(entity_id) or {}
        wh = max(0.0, float(by_bucket.get(key, 0.0)) * 1000.0)
        measured_sum += wh
        appliances.append(
            {
                "entityId": entity_id,
                "label": consumer["label"],
                "wh": round(wh, 4),
                "switchEntityId": consumer.get("switch_entity_id"),
                "powerEntityId": consumer.get("power_entity_id"),
                "deferrable": bool(consumer.get("deferrable")),
                "controllableIds": list(consumer.get("ids") or ()),
            }
        )
    return {
        "unmeasuredWh": round(max(0.0, float(house_wh) - measured_sum), 4),
        "appliances": appliances,
    }


def _fold_span_aggregates_days(
    history: Any,
    meters: Any,
    soc_entity: str | None,
    house_forecast_entity: str | None,
    breakdown_consumers: list[dict],
    start_date: date,
    end_date: date,
    bucket: str,
    local_tz: ZoneInfo,
    *,
    house_forecast: bool,
) -> list[dict[str, Any]]:
    """Fold energy series, SoC, house forecast, and money into span bucket rows."""
    solar_kwh = _energy_by_bucket(history.energy_for(meters.solar), bucket, local_tz)
    imported_kwh = _energy_by_bucket(
        history.energy_for(meters.grid_import), bucket, local_tz
    )
    exported_kwh = _energy_by_bucket(
        history.energy_for(meters.grid_export), bucket, local_tz
    )
    house_kwh = _energy_by_bucket(history.energy_for(meters.house), bucket, local_tz)
    charged_kwh = _energy_by_bucket(
        history.energy_for(meters.battery_charge), bucket, local_tz
    )
    discharged_kwh = _energy_by_bucket(
        history.energy_for(meters.battery_discharge), bucket, local_tz
    )
    soc_by_bucket = _soc_bounds_by_bucket(
        history.rows_for(soc_entity), bucket, local_tz
    )
    house_forecast_kwh = _house_forecast_by_bucket(
        history.rows_for(house_forecast_entity), bucket, local_tz
    )
    consumer_kwh_by_entity = {
        consumer["energy_entity_id"]: _energy_by_bucket(
            _consumer_own_energy(
                consumer, history.energy_kwh, slot=timedelta(hours=1)
            ),
            bucket,
            local_tz,
        )
        for consumer in breakdown_consumers
    }
    money_by_bucket = _money_by_bucket(
        history.energy_for(meters.grid_import),
        history.energy_for(meters.grid_export),
        history.import_rate,
        history.export_rate,
        bucket=bucket,
        local_tz=local_tz,
    )

    days: list[dict[str, Any]] = []
    for key in bucket_keys(start_date, end_date, bucket):
        min_pct, max_pct = soc_by_bucket.get(key, (None, None))
        cost, gain, cost_kwh, gain_kwh = money_by_bucket.get(
            key, (None, None, None, None)
        )
        row: dict[str, Any] = {
            "date": key,
            "solarWh": _round_wh(solar_kwh.get(key)),
            "gridImportKwh": _round_kwh(imported_kwh.get(key)),
            "gridExportKwh": _round_kwh(exported_kwh.get(key)),
            "batteryMinSocPct": min_pct,
            "batteryMaxSocPct": max_pct,
            "houseWh": _round_wh(house_kwh.get(key)),
            "batteryChargeWh": _round_wh(charged_kwh.get(key)),
            "batteryDischargeWh": _round_wh(discharged_kwh.get(key)),
            "moneyCost": None if cost is None else round(cost, 3),
            "moneyGain": None if gain is None else round(gain, 3),
            "moneyCostKwh": _round_kwh(cost_kwh),
            "moneyGainKwh": _round_kwh(gain_kwh),
            "houseBreakdown": _bucket_house_breakdown(
                breakdown_consumers,
                consumer_kwh_by_entity,
                key,
                _round_wh(house_kwh.get(key)),
            ),
        }
        if house_forecast:
            row["houseForecastWh"] = _round_wh(house_forecast_kwh.get(key))
        days.append(row)
    return days


