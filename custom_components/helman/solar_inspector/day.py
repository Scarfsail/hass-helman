from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.util import dt as dt_util

from ..recorder_states import numeric_timeline
from ..slot_grid import (
    SLOT,
    SLOT_LABELS,
    day_slots,
    slot_to_minutes,
)
from ..slot_grid import (
    floor_to_slot as _current_slot_start,
)
from ..solar_bias_correction.models import (
    BatterySocPoint,
    SolarBiasApplianceComponent,
    SolarBiasFactorPoint,
    SolarBiasHouseBreakdownPoint,
    SolarBiasImpactPoint,
    SolarBiasInspectorPoint,
    SolarBiasInspectorSeries,
    SolarBiasInspectorTotals,
    SolarBiasMoneyPoint,
    SolarBiasMoneyTotals,
    SolarBiasPricePoint,
    SolarBiasProfile,
)
from ..solar_bias_correction.statistics_day import StatisticsDay

_LOGGER = logging.getLogger(__name__)


@dataclass
class DayMeters:
    reads_statistics: bool
    slot_energy_by_entity: dict[str, dict[datetime, float]]
    actuals_by_slot: dict[str, float]
    statistics_day: StatisticsDay
    breakdown_consumers_for_day: list[dict]
    solar_meter_entity_id: str | None
    meter_entity_ids: list[str]


@dataclass
class DaySolar:
    raw_points: list[dict[str, Any]]
    corrected_points: list[dict[str, Any]]
    actual_points: list[SolarBiasInspectorPoint]
    invalidated_points: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]
    has_profile: bool


@dataclass
class DayForecastAndActualSeries:
    house_forecast_points: list[dict]
    house_actual_points: list[dict]
    house_actual_breakdown_points: list[dict]
    house_forecast_breakdown_points: list[SolarBiasHouseBreakdownPoint]
    battery_soc_forecast_points: list[dict]
    battery_soc_actual_points: list[dict]
    grid_forecast_points: list[dict]
    grid_actual_series: tuple[list[dict], list[dict], list[dict]]
    battery_forecast_points: list[dict]
    battery_actual_points: list[dict]
    grid_import_forecast_points: list[dict]
    grid_export_forecast_points: list[dict]
    recorded_import_price_points: list[dict]
    recorded_export_price_points: list[dict]
    numeric_history_by_entity: dict[str, dict[str, float]]
    bounds_entity_ids: tuple[str | None, str | None]


@dataclass
class DayPriceRails:
    import_price_by_slot: dict[str, float]
    export_price_by_slot: dict[str, float]
    price_unit: str | None
    money_actual_points: list[SolarBiasMoneyPoint]
    money_forecast_points: list[SolarBiasMoneyPoint]


def _consumer_own_energy(
    consumer: dict,
    energy_by_entity: dict[str, dict[datetime, float]],
    *,
    slot: timedelta,
) -> dict[datetime, float]:
    """A consumer's own energy per slot: its meter minus its metered children."""
    from ..shared_meter_fit import own_energy_changes

    return own_energy_changes(
        energy_by_entity.get(consumer["energy_entity_id"]) or {},
        [
            energy_by_entity.get(child) or {}
            for child in consumer["metered_children"]
        ],
        slot=slot,
    )


def _normalize_consumers(raw_consumers: Any, *, deferrable: bool) -> list[dict]:
    result: list[dict] = []
    for consumer in raw_consumers or []:
        if not isinstance(consumer, dict):
            continue
        entity_id = consumer.get("energy_entity_id")
        if not isinstance(entity_id, str) or not entity_id.strip():
            continue
        eid = entity_id.strip()
        switch = consumer.get("switch_entity_id")
        power = consumer.get("power_entity_id")
        raw_ids = consumer.get("ids")
        raw_children = consumer.get("metered_children")
        result.append(
            {
                "energy_entity_id": eid,
                "label": consumer.get("label", eid),
                "switch_entity_id": switch if isinstance(switch, str) and switch else None,
                "power_entity_id": power if isinstance(power, str) and power else None,
                "deferrable": deferrable,
                "ids": [
                    controllable_id
                    for controllable_id in (
                        raw_ids if isinstance(raw_ids, list) else ()
                    )
                    if isinstance(controllable_id, str) and controllable_id
                ],
                "metered_children": [
                    child
                    for child in (
                        raw_children if isinstance(raw_children, list) else ()
                    )
                    if isinstance(child, str) and child
                ],
            }
        )
    return result


def _consumer_slot_map(
    by_slot_utc: dict[datetime, float], target_date: date
) -> dict[str, float]:
    by_slot: dict[str, float] = {}
    for slot_start_utc, kwh in by_slot_utc.items():
        slot_local = dt_util.as_local(slot_start_utc)
        if slot_local.date() != target_date:
            continue
        slot = f"{slot_local.hour:02d}:{slot_local.minute:02d}"
        by_slot[slot] = kwh * 1000.0
    return by_slot

def _filter_points_to_local_date(
    points: list[dict[str, Any]],
    target_date: date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    """Return points whose timestamp falls on `target_date` in `timezone`, preserving native granularity."""
    parse_datetime = getattr(dt_util, "parse_datetime", datetime.fromisoformat)
    filtered: list[tuple[datetime, dict[str, Any]]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str) or isinstance(value, bool):
            continue
        if not isinstance(value, (int, float)):
            continue
        parsed_timestamp = parse_datetime(timestamp)
        if parsed_timestamp is None:
            continue
        local_timestamp = dt_util.as_local(parsed_timestamp).astimezone(timezone)
        if local_timestamp.date() != target_date:
            continue
        filtered.append((local_timestamp, {"timestamp": timestamp, "value": float(value)}))
    filtered.sort(key=lambda item: item[0])
    return [point for _, point in filtered]


def _copy_points(raw_points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(point) for point in raw_points]


def _inspector_points(raw_points: list[dict[str, Any]]) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str):
            continue
        try:
            value_wh = float(value)
        except (TypeError, ValueError):
            continue
        points.append(SolarBiasInspectorPoint(timestamp=timestamp, value_wh=value_wh))
    return points


def _sum_point_values(raw_points: list[dict[str, Any]]) -> float:
    total = 0.0
    for point in raw_points:
        try:
            total += float(point.get("value"))
        except (TypeError, ValueError):
            continue
    return total


def _partition_actual_points(
    actual_points: list[SolarBiasInspectorPoint],
    *,
    invalidated_slots: set[str],
) -> tuple[list[SolarBiasInspectorPoint], list[SolarBiasInspectorPoint]]:
    """Split actuals into kept vs invalidated using the actuals' own 15-min slot key.

    Both `actual_points` and `invalidated_slots` are at 15-minute granularity,
    so the comparison is direct. Earlier code mapped each actual to the
    *containing* forecast-published slot, which silently coarsened to hourly
    when raw forecast was hourly and dropped 15-min invalidations on the floor.
    """
    actual: list[SolarBiasInspectorPoint] = []
    invalidated: list[SolarBiasInspectorPoint] = []
    for point in actual_points:
        point_slot = point.timestamp[11:16]
        if point_slot in invalidated_slots:
            invalidated.append(point)
            continue
        actual.append(point)
    return actual, invalidated


def _factor_points_for_profile(
    profile: SolarBiasProfile | None,
) -> list[SolarBiasFactorPoint]:
    if profile is None:
        return []
    return [
        SolarBiasFactorPoint(slot=slot, factor=float(factor))
        for slot, factor in sorted(profile.factors.items())
    ]


def _impact_points_for_day(
    raw_points: list[dict[str, Any]],
    corrected_points: list[dict[str, Any]],
) -> list[SolarBiasImpactPoint]:
    corrected_by_slot: dict[str, float] = {}
    for point in corrected_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        try:
            corrected_by_slot[timestamp[11:16]] = float(point.get("value"))
        except (TypeError, ValueError):
            continue

    impact: list[SolarBiasImpactPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        slot = timestamp[11:16]
        try:
            raw_wh = float(point.get("value"))
        except (TypeError, ValueError):
            continue
        corrected_wh = corrected_by_slot.get(slot)
        if corrected_wh is None:
            continue
        # Effective factor: corrected/raw. At 15-min granularity this equals
        # profile.factors[slot]; at hourly granularity (today/future buckets
        # aggregating four 15-min slots) it reflects the raw-weighted average
        # of the underlying sub-slot factors actually applied.
        effective_factor: float | None
        if raw_wh > 0.0:
            effective_factor = corrected_wh / raw_wh
        else:
            effective_factor = None
        impact.append(
            SolarBiasImpactPoint(
                slot=slot,
                raw_wh=raw_wh,
                corrected_wh=corrected_wh,
                impact_wh=corrected_wh - raw_wh,
                factor=effective_factor,
            )
        )
    return impact


def _actual_points_for_date(
    actuals_by_slot: dict[str, float],
    target_date: date,
    local_tz: ZoneInfo,
) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for slot, value in sorted(actuals_by_slot.items()):
        try:
            hour, minute = [int(part) for part in slot.split(":", 1)]
            timestamp = datetime.combine(
                target_date,
                time(hour=hour, minute=minute),
                tzinfo=local_tz,
            )
            points.append(
                SolarBiasInspectorPoint(
                    timestamp=timestamp.isoformat(),
                    value_wh=float(value),
                )
            )
        except (TypeError, ValueError):
            continue
    return points


def _numeric_history_by_slot(
    states: list,
    target_date: date,
    *,
    local_start: datetime,
    local_tz: ZoneInfo,
) -> dict[str, float]:
    """One numeric entity's recorder rows, sampled onto the day's 15-minute slots.

    A slot takes the last value the entity held at or before its start, so an
    entity that goes unavailable holds its previous reading rather than leaving
    a hole. Slots before the entity's first reading are absent, as are slots the
    clock has not reached yet.
    """
    timeline = numeric_timeline(states)
    if not timeline:
        return {}

    local_now = datetime.now(local_tz)
    is_today = target_date == local_now.date()
    by_slot: dict[str, float] = {}
    cursor = 0
    current: float | None = None
    for slot_start in day_slots(target_date, tzinfo=local_tz, wall_clock=True):
        if is_today and slot_start > local_now:
            break
        while cursor < len(timeline) and timeline[cursor][0] <= slot_start:
            current = timeline[cursor][1]
            cursor += 1
        if current is None:
            continue
        by_slot[f"{slot_start.hour:02d}:{slot_start.minute:02d}"] = current
    return by_slot


def _house_forecast_points_from_snapshot(
    snapshot: dict | None,
    target_date: date,
    *,
    next_slot: datetime | None = None,
) -> list[dict]:
    """Extract 15-min house forecast Wh points for target_date from a cached snapshot.

    The snapshot is the adjusted house forecast, the one the battery simulation
    ran against: its nonDeferrable is the whole house, scheduled appliance
    demand included. Its deferrableConsumers band is the model's own account of
    those same appliances and must not be added on top.

    The snapshot series values are in kWh per canonical slot; convert to Wh.
    Pass next_slot for today so past slots are excluded and forecast starts
    seamlessly after the last actual slot.
    """
    if not isinstance(snapshot, dict):
        return []
    if snapshot.get("status") != "available":
        return []
    points: list[dict] = []
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=next_slot.tzinfo if next_slot else None)
        if ts.date() != target_date:
            continue
        if next_slot is not None and ts < next_slot:
            continue
        nd = entry.get("nonDeferrable") or {}
        nd_kwh = nd.get("value") if isinstance(nd, dict) else None
        if nd_kwh is None:
            continue
        try:
            nd_kwh = float(nd_kwh)
        except (TypeError, ValueError):
            continue
        points.append({"timestamp": ts_raw, "wh": nd_kwh * 1000})
    return points


def _house_forecast_current_slot_points(
    snapshot: dict | None, target_date: date
) -> list[dict]:
    """The snapshot's `currentSlot` entry as a base point, if it is on this day.

    Same shape as the series entries — `build_adjusted_house_forecast` adds
    demand to it exactly as it does to them — but it is held apart from the
    series, so it has to be asked for by name. At most one point.
    """
    if not isinstance(snapshot, dict) or snapshot.get("status") != "available":
        return []
    entry = snapshot.get("currentSlot")
    if not isinstance(entry, dict):
        return []
    ts_raw = entry.get("timestamp")
    if not isinstance(ts_raw, str):
        return []
    try:
        ts = datetime.fromisoformat(ts_raw)
    except ValueError:
        return []
    if ts.date() != target_date:
        return []
    non_deferrable = entry.get("nonDeferrable")
    value = non_deferrable.get("value") if isinstance(non_deferrable, dict) else None
    try:
        wh = float(value) * 1000
    except (TypeError, ValueError):
        return []
    return [{"timestamp": ts_raw, "wh": wh}]


def _live_price_rail(
    channel: Any,
    target_date: date,
    timezone: ZoneInfo,
) -> dict[str, float]:
    """The live price feed's points for one day, keyed by local ``HH:MM`` slot.

    The two channels do not have the same reach, and assuming they do was a
    bug. The import channel is built forward from the slot in progress, so it
    answers only for what is still ahead. The export channel is the ingested
    day-ahead schedule, which carries the whole day at its own resolution —
    *including hours that have already elapsed* — because that is how a
    day-ahead spot feed publishes. This helper hands both back whole; cutting
    the export rail at the slot in progress, so a schedule cannot restate an
    elapsed hour the recorder already answered, is the caller's job.

    Each point is carried forward across the slots that follow it until the next
    one, so an hourly feed fills the quarter-hours between its points rather
    than leaving three of every four empty for something coarser to guess at.
    Slots before the feed's first point stay absent, which is what leaves the
    elapsed half of a day to the recorder.
    """
    if not isinstance(channel, dict):
        return {}
    by_slot: dict[str, float] = {}
    for point in channel.get("points") or []:
        if not isinstance(point, dict):
            continue
        raw_timestamp = point.get("timestamp")
        if not isinstance(raw_timestamp, str):
            continue
        try:
            parsed = datetime.fromisoformat(raw_timestamp)
        except ValueError:
            continue
        local_timestamp = parsed.astimezone(timezone)
        if local_timestamp.date() != target_date:
            continue
        try:
            value = float(point.get("value"))
        except (TypeError, ValueError):
            continue
        by_slot[local_timestamp.strftime("%H:%M")] = value
    if not by_slot:
        return {}

    filled: dict[str, float] = {}
    carried: float | None = None
    for label in SLOT_LABELS:
        if label in by_slot:
            carried = by_slot[label]
        if carried is not None:
            filled[label] = carried
    return filled


def _fill_import_rail_from_config(
    by_slot: dict[str, float],
    windows,
) -> None:
    """Price every slot the rail is still missing straight from the window table.

    In place and per slot, never per day: the day the import sensor ships and
    the day recorder retention runs out are each covered in part, so anything
    coarser would either blank the covered half or overwrite recorded truth with
    today's tariff.

    Imported lazily, like the other cross-module helpers here — the builder
    module pulls in Home Assistant's core, which several importers of this
    module deliberately do without.
    """
    from ..grid_price_forecast_builder import (
        GridImportPriceConfigError,
        lookup_grid_import_price,
    )

    for slot in SLOT_LABELS:
        minute_of_day = slot_to_minutes(slot)
        if slot in by_slot:
            continue
        try:
            by_slot[slot] = lookup_grid_import_price(
                windows=windows,
                minute_of_day=minute_of_day,
            )
        except GridImportPriceConfigError:
            _LOGGER.debug(
                "No import price window covers %s; leaving the slot empty", slot
            )


def _price_points(by_slot: dict[str, float]) -> list[SolarBiasPricePoint]:
    """Order a slot-keyed rail into the payload's drawable sequence."""
    return [
        SolarBiasPricePoint(slot=slot, value=value)
        for slot, value in sorted(by_slot.items())
    ]


def _energy_kwh_by_slot(points: list) -> dict[str, float]:
    """One direction's energy in kWh, keyed by the local ``HH:MM`` slot label.

    Takes the raw loader points -- ``{"timestamp", "wh"}`` -- as every other
    summing helper here does. The label is read off the timestamp's local time
    text rather than parsed into a datetime, which is what brings the energy
    series onto the same key the price rails are already built on.
    """
    by_slot: dict[str, float] = {}
    for point in points:
        timestamp = point["timestamp"]
        if not isinstance(timestamp, str) or len(timestamp) < 16:
            continue
        slot = timestamp[11:16]
        by_slot[slot] = by_slot.get(slot, 0.0) + point["wh"] / 1000.0
    return by_slot


def _money_points(
    import_points: list,
    export_points: list,
    import_price_by_slot: dict[str, float],
    export_price_by_slot: dict[str, float],
) -> list[SolarBiasMoneyPoint]:
    """Cost and gain per slot, for one vintage.

    Computed per slot and then summed, never as a day's energy times an average
    rate: the expensive hours are rarely the ones the house imported in.

    A slot appears when either direction has energy *and* a rate to value it at.
    A direction with energy but no rate contributes ``None`` rather than zero --
    a day past the recorder's reach has real exported kWh whose rate is simply
    unknown, and calling that "earned nothing" would be a claim the data does
    not support. That is per *direction*, not per slot: a slot the import rail
    priced and the export rail did not carries a cost and a ``None`` gain, and
    the card draws the em dash the missing rate earns.

    Known limitation, once a year: on the autumn DST fall-back day the local
    ``HH:MM`` labels repeat, so the repeated hour's two occurrences share four
    slot keys. Energy accumulates across both (right), while a rail holds one
    rate per label and therefore prices the combined kWh at whichever of the two
    hours was written last. The whole inspector keys slots by local label -- the
    rails arrive that way -- so this is the convention's cost rather than this
    helper's, and pricing money by timestamp alone would only make it disagree
    with the rail drawn above it.
    """
    imported = _energy_kwh_by_slot(import_points)
    exported = _energy_kwh_by_slot(export_points)
    points: list[SolarBiasMoneyPoint] = []
    for slot in SLOT_LABELS:
        import_kwh = imported.get(slot)
        export_kwh = exported.get(slot)
        cost_rate = import_price_by_slot.get(slot)
        gain_rate = export_price_by_slot.get(slot)
        priced_cost = import_kwh is not None and cost_rate is not None
        priced_gain = export_kwh is not None and gain_rate is not None
        if not priced_cost and not priced_gain:
            continue
        points.append(
            SolarBiasMoneyPoint(
                slot=slot,
                cost=import_kwh * cost_rate if priced_cost else None,
                gain=export_kwh * gain_rate if priced_gain else None,
            )
        )
    return points


def _money_totals(
    points: list[SolarBiasMoneyPoint],
) -> SolarBiasMoneyTotals | None:
    """Sum a money series, or None where the day priced nothing at all.

    Each direction is summed over the slots that priced it and is ``None`` where
    none did, so a vintage whose export rail is empty reports its import bill
    and an unknown gain rather than a gain of zero. ``net`` needs both sides and
    is ``None`` without them.

    A direction only *partly* priced sums the slots it could price, the same
    approximation the span aggregates make (:func:`_money_by_bucket`): the rails
    lose a rate at the edges of recorder retention, and a bill for the hours
    that have one is more use than a hole. Nothing on the day view distinguishes
    the two, which is why the whole-direction case gets the em dash instead.
    """
    if not points:
        return None
    cost = _direction_total(point.cost for point in points)
    gain = _direction_total(point.gain for point in points)
    net = None if cost is None or gain is None else cost - gain
    return SolarBiasMoneyTotals(cost=cost, gain=gain, net=net)


def _direction_total(values: Iterable[float | None]) -> float | None:
    """One direction's money summed, or None where no slot priced it."""
    total: float | None = None
    for value in values:
        if value is None:
            continue
        total = value if total is None else total + value
    return total


# --- Span aggregates: bucketing the hourly statistics ------------------------
#
# Everything below folds ``{utc_hour: StatisticsRow}`` maps -- what
# ``recorder_statistics_span.query_hourly_statistics`` returns -- into buckets
# keyed by an ISO date (:mod:`..span_buckets`). The hour keys are UTC instants (see that function for
# why they must not be local ones), so every fold converts before it keys. Day
# and month differ only in that key, so the folds themselves are written once.


def _round_wh(value_kwh: float | None) -> float | None:
    """kWh from statistics, reported as the payload's Wh."""
    return None if value_kwh is None else round(value_kwh * 1000.0, 1)


def _round_kwh(value_kwh: float | None) -> float | None:
    return None if value_kwh is None else round(value_kwh, 3)


def _next_slot_boundary(local_now: datetime) -> datetime:
    """Return the start of the first 15-min slot that begins after the slot containing now."""
    return _current_slot_start(local_now) + SLOT


def _minutes_into_day(cutoff: datetime | None, target_date: date) -> int:
    """Minutes past midnight of target_date at cutoff, or the full day.

    A cutoff on a later date (the 23:45 slot rolls over) covers the whole day.
    """
    if cutoff is None or cutoff.date() > target_date:
        return 24 * 60
    return cutoff.hour * 60 + cutoff.minute


def _points_from(points: list[dict], *, start: datetime | None) -> list[dict]:
    """Keep timestamped points that start at or after ``start``.

    The mirror of :func:`_points_before`, so a day spliced with both loses no
    slot and repeats none.
    """
    if start is None:
        return points
    kept: list[dict] = []
    for point in points:
        try:
            ts = datetime.fromisoformat(point["timestamp"])
        except (KeyError, TypeError, ValueError):
            continue
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        if ts >= start.replace(tzinfo=None):
            kept.append(point)
    return kept


def _points_before(points: list[dict], *, cutoff: datetime | None) -> list[dict]:
    """Drop timestamped points that start at or after cutoff."""
    if cutoff is None:
        return points
    kept: list[dict] = []
    for point in points:
        try:
            ts = datetime.fromisoformat(point["timestamp"])
        except (KeyError, TypeError, ValueError):
            continue
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        if ts < cutoff.replace(tzinfo=None):
            kept.append(point)
    return kept


def _slot_points_before(
    points: list[dict], *, cutoff: datetime | None, target_date: date
) -> list[dict]:
    """Drop ``{"slot": "HH:MM"}``-keyed points at or after cutoff.

    The counterpart of :func:`_points_before` for the SoC forecast series, whose
    points carry a slot label rather than a timestamp. ``_minutes_into_day``
    turns a cutoff that has rolled past midnight into the whole day, matching
    that helper's rule.
    """
    limit = _minutes_into_day(cutoff, target_date)
    kept = []
    for point in points:
        try:
            minutes = slot_to_minutes(point.get("slot", ""))
        except ValueError:
            continue
        if minutes < limit:
            kept.append(point)
    return kept


def _slot_energy_points(
    wh_by_slot_utc: dict[datetime, float],
    target_date: date,
) -> list[dict]:
    """Turn UTC-keyed slot energies into local per-slot inspector points.

    The slot in progress is kept: it is partial, so the chart must not draw it
    (see ``_drop_running_slot``), but the day's total is an accumulation and
    counts every Wh the meter has recorded.
    """
    points: list[dict] = []
    for slot_start_utc, wh in sorted(wh_by_slot_utc.items()):
        slot_local = dt_util.as_local(slot_start_utc)
        if slot_local.date() != target_date:
            continue
        points.append({"timestamp": slot_local.isoformat(), "wh": wh})
    return points


def _point_field(point: Any, name: str) -> Any:
    """Read a field off an inspector point, dict-shaped or dataclass-shaped."""
    return point.get(name) if isinstance(point, dict) else getattr(point, name, None)


def _drop_running_slot(points: list, *, running_slot: str | None) -> list:
    """Drop actual points in or after the slot in progress.

    A slot that has not finished has only partial actuals, and comparing a
    part-slot measurement against a whole-slot forecast is a category error. The
    aggregated buckets already apply this rule; applying it here applies it to
    every actual series at the native 15-minute width too.

    Points are matched on their local ``HH:MM`` slot, carried either as a ``slot``
    label or inside an ISO ``timestamp``; every series here is already filtered to
    the day in question, and ``running_slot`` is only set for today.
    """
    if running_slot is None:
        return points

    def _slot_of(point: Any) -> str | None:
        slot = _point_field(point, "slot")
        if isinstance(slot, str):
            return slot
        timestamp = _point_field(point, "timestamp")
        if isinstance(timestamp, str) and len(timestamp) >= 16:
            return timestamp[11:16]
        return None

    return [
        point
        for point in points
        if (slot := _slot_of(point)) is None or slot < running_slot
    ]


def _build_house_actual_breakdown(
    house_actual_points: list[dict],
    consumers: list[dict],
    consumer_slot_maps: list[dict],
) -> list[SolarBiasHouseBreakdownPoint]:
    """Split each house-actual slot into per-consumer parts and the remainder.

    The remainder is the house total minus every itemised consumer that slot,
    clamped at zero so a meter that momentarily over-reports never shows a
    negative figure. It is "what no individual meter accounted for" — deliberately
    NOT the forecast's non-deferrable base load, which remains a separate concept.
    With no consumers configured — or the consumer reads having failed and yielded
    no maps — the breakdown is empty and the panel falls back to the plain house
    figure.
    """
    if not consumers or len(consumer_slot_maps) != len(consumers):
        return []
    points: list[SolarBiasHouseBreakdownPoint] = []
    for point in house_actual_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str) or len(timestamp) < 16:
            continue
        slot = timestamp[11:16]
        house_wh = point.get("wh")
        if not isinstance(house_wh, (int, float)):
            continue
        appliances: list[SolarBiasApplianceComponent] = []
        measured_sum = 0.0
        for consumer, slot_map in zip(consumers, consumer_slot_maps):
            wh = max(0.0, float(slot_map.get(slot, 0.0)))
            measured_sum += wh
            appliances.append(
                SolarBiasApplianceComponent(
                    entity_id=consumer["energy_entity_id"],
                    label=consumer["label"],
                    value_wh=round(wh, 4),
                    switch_entity_id=consumer.get("switch_entity_id"),
                    power_entity_id=consumer.get("power_entity_id"),
                    deferrable=bool(consumer.get("deferrable")),
                    controllable_ids=list(consumer.get("ids") or ()),
                )
            )
        unmeasured_wh = round(max(0.0, float(house_wh) - measured_sum), 4)
        points.append(
            SolarBiasHouseBreakdownPoint(
                slot=slot, unmeasured_wh=unmeasured_wh, appliances=appliances
            )
        )
    return points


def _forecast_appliance_component(
    appliance_id: str,
    energy_kwh: float,
    consumer: dict | None,
    metered_by_entity_id: dict[str, dict],
) -> SolarBiasApplianceComponent:
    """One scheduled appliance's row, named and flagged as its controllable is.

    A controllable the roster does not know at all keeps its id as a last-resort
    label — it is the only name there is — but never as an entity id, and it is
    reported non-deferrable rather than assumed shiftable.

    The switch and power sensor are borrowed from the meter's node only when
    the meter is this appliance's alone. A meter shared by several controllables
    is a whole circuit: its power sensor reads every device on it and its switch
    cuts them all, so neither may stand in for one device's box.
    """
    consumer = consumer or {}
    entity_id = consumer.get("energy_entity_id")
    metered = metered_by_entity_id.get(entity_id) if entity_id else None
    if metered is not None and len(metered.get("ids") or ()) > 1:
        metered = None
    return SolarBiasApplianceComponent(
        entity_id=entity_id,
        label=consumer.get("label") or appliance_id,
        value_wh=round(energy_kwh * 1000.0, 4),
        switch_entity_id=(metered or {}).get("switch_entity_id"),
        power_entity_id=(metered or {}).get("power_entity_id"),
        deferrable=bool(consumer.get("deferrable")),
        controllable_ids=[appliance_id],
    )


def _build_house_forecast_breakdown(
    composition: dict | None,
    consumers: list[dict],
    target_date: date,
    *,
    next_slot: datetime | None,
    metered_by_entity: list[dict] | None = None,
) -> list[SolarBiasHouseBreakdownPoint]:
    """Split each forecast slot into the base load plus every appliance scheduled in it.

    The two halves come off the same pipeline snapshot the adjusted forecast was
    built from: ``original_house_forecast`` is the house before any appliance was
    added, and ``demand_points`` is what the planner added to it. Since the
    adjusted nonDeferrable is exactly their sum, the parts reconcile with the
    houseForecast series the chart draws, slot for slot — the same guarantee the
    measured breakdown gives against houseActual.

    An appliance is named by the schedulable consumer sharing its controllable id,
    so a given device is one row with one name — and one deferrability — whether
    the slot is past or future. One with no meter configured still gets a row,
    named after the controllable and carrying no entity id: there is no sensor to
    open, and passing the bare id off as one would offer the card a more-info
    dialog for an entity that does not exist.

    ``metered_by_entity`` is the measured breakdown's own roster, already merged
    with the device tree, and is how a forecast row picks up the switch and power
    sensor its measured twin shows. It is empty on a day with no past half, which
    is also a day with no measured panel to look asymmetric beside.

    With no composition to read — a cold pipeline — the breakdown is empty and the
    card falls back to the plain forecast figure.
    """
    if not isinstance(composition, dict):
        return []
    original = composition.get("original_house_forecast")
    # The slot in progress is not in the snapshot's series — it rides alongside it
    # as `currentSlot`, and the planner schedules into it like any other. Reading
    # only the series would leave the slot the user is most likely looking at as
    # the one slot with no composition at all.
    base_points = _house_forecast_current_slot_points(original, target_date) + (
        _house_forecast_points_from_snapshot(original, target_date, next_slot=next_slot)
    )
    if not base_points:
        return []

    consumer_by_id = {
        consumer["id"]: consumer for consumer in consumers if consumer.get("id")
    }
    metered_by_entity_id = {
        consumer["energy_entity_id"]: consumer for consumer in metered_by_entity or []
    }
    # Slot ids are local ISO timestamps; the breakdown is keyed "HH:MM" like the
    # rest of the inspector, so convert once here and drop other days rather than
    # letting the same clock time on two dates collide.
    demand_by_slot: dict[str, dict[str, float]] = {}
    for demand_point in composition.get("demand_points") or ():
        try:
            slot_start = datetime.fromisoformat(demand_point.slot_id)
        except (AttributeError, TypeError, ValueError):
            continue
        if slot_start.date() != target_date:
            continue
        slot = slot_start.strftime("%H:%M")
        by_appliance = demand_by_slot.setdefault(slot, {})
        by_appliance[demand_point.appliance_id] = (
            by_appliance.get(demand_point.appliance_id, 0.0)
            # The whole slot's scheduled energy, not the part of it still to come:
            # the breakdown is drawn against a whole-slot forecast, so the slot in
            # progress must report the same figure at 13:16 as at 13:29.
            + float(demand_point.scheduled_energy_kwh)
        )

    points: list[SolarBiasHouseBreakdownPoint] = []
    for point in base_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str) or len(timestamp) < 16:
            continue
        slot = timestamp[11:16]
        appliances = [
            _forecast_appliance_component(
                appliance_id,
                energy_kwh,
                consumer_by_id.get(appliance_id),
                metered_by_entity_id,
            )
            for appliance_id, energy_kwh in demand_by_slot.get(slot, {}).items()
        ]
        points.append(
            SolarBiasHouseBreakdownPoint(
                slot=slot,
                unmeasured_wh=round(float(point["wh"]), 4),
                appliances=appliances,
            )
        )
    return points


def _house_forecast_total_for_slot(
    breakdown_points: list[SolarBiasHouseBreakdownPoint],
    *,
    slot_start: datetime | None,
) -> list[dict]:
    """The one slot's house forecast total, summed from its own composition.

    The slot in progress is the only slot whose total is not read from a series:
    the archive's sample of it predates the schedule the composition describes, so
    reading the two from different vintages is what made its deferrable share melt
    across the slot. Summing the parts instead makes the total agree with them by
    construction. At most one point, and none at all on a day that is not today or
    with no composition to sum.
    """
    if slot_start is None:
        return []
    slot = slot_start.strftime("%H:%M")
    for point in breakdown_points:
        if point.slot != slot:
            continue
        total_wh = point.unmeasured_wh + sum(
            appliance.value_wh for appliance in point.appliances
        )
        return [{"timestamp": slot_start.isoformat(), "wh": round(total_wh, 4)}]
    return []


def _iter_future_snapshot_entries(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> Iterator[tuple[datetime, dict]]:
    """Yield (local timestamp, entry) for snapshot slots on target_date not yet started."""
    if not isinstance(snapshot, dict):
        return
    next_slot = _next_slot_boundary(local_now)
    for entry in snapshot.get("series") or []:
        if not isinstance(entry, dict):
            continue
        ts_raw = entry.get("timestamp")
        if not isinstance(ts_raw, str):
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        ts_local = ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
        if ts_local.date() != target_date:
            continue
        if ts_local < next_slot:
            continue
        yield ts_local, entry


def _filter_battery_soc_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future battery SoC forecast slots for target_date from the snapshot."""
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        pct = entry.get("socPct")
        if pct is None:
            continue
        slot = f"{ts_local.hour:02d}:{ts_local.minute:02d}"
        points.append({"slot": slot, "pct": float(pct)})
    return points


def _filter_grid_forecast_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Extract future grid energy slots for target_date from the snapshot.

    Returns (net, imported, exported). Net is positive when exporting and
    negative when importing, matching gridNetKwh in the scheduling and forecast
    cards; the two sides are each positive magnitudes of their own direction.

    Both are produced because they answer different questions. The chart draws
    one signed series and wants the net; money has to price each side at its own
    rate, and a slot that both imported and exported cannot be recovered from
    the net after the fact.
    """
    net_points: list[dict] = []
    import_points: list[dict] = []
    export_points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        imported = entry.get("importedFromGridKwh")
        exported = entry.get("exportedToGridKwh")
        if imported is None and exported is None:
            continue
        timestamp = ts_local.isoformat()
        imported_wh = float(imported or 0.0) * 1000.0
        exported_wh = float(exported or 0.0) * 1000.0
        net_points.append({"timestamp": timestamp, "wh": exported_wh - imported_wh})
        import_points.append({"timestamp": timestamp, "wh": imported_wh})
        export_points.append({"timestamp": timestamp, "wh": exported_wh})
    return net_points, import_points, export_points


def _filter_battery_forecast_future(
    snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict]:
    """Extract future net battery energy slots for target_date from the snapshot.

    Positive is charging, negative is discharging, matching the sign of the
    archived batteryNetWh.
    """
    points: list[dict] = []
    for ts_local, entry in _iter_future_snapshot_entries(
        snapshot, target_date=target_date, local_now=local_now, timezone=timezone
    ):
        charged = entry.get("chargedKwh")
        discharged = entry.get("dischargedKwh")
        if charged is None and discharged is None:
            continue
        net_kwh = float(charged or 0.0) - float(discharged or 0.0)
        points.append({"timestamp": ts_local.isoformat(), "wh": net_kwh * 1000.0})
    return points


def _merge_battery_forecast_future(
    battery_forecast_series: tuple[
        list[dict], list[dict], list[dict], list[dict], list[dict]
    ],
    battery_snapshot: dict | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> tuple[list[dict], list[dict], list[dict], list[dict], list[dict]]:
    """Merge future battery and grid forecasts into recorded series."""
    (
        soc_points,
        grid_points,
        batt_points,
        import_points,
        export_points,
    ) = (list(s) for s in battery_forecast_series)
    soc_points += _filter_battery_soc_future(
        battery_snapshot,
        target_date=target_date,
        local_now=local_now,
        timezone=timezone,
    )
    future_net, future_import, future_export = _filter_grid_forecast_future(
        battery_snapshot,
        target_date=target_date,
        local_now=local_now,
        timezone=timezone,
    )
    grid_points += future_net
    import_points += future_import
    export_points += future_export
    batt_points += _filter_battery_forecast_future(
        battery_snapshot,
        target_date=target_date,
        local_now=local_now,
        timezone=timezone,
    )
    return soc_points, grid_points, batt_points, import_points, export_points



def _inspector_points_from_raw(raw: list[dict]) -> list[SolarBiasInspectorPoint]:
    return [
        SolarBiasInspectorPoint(timestamp=p["timestamp"], value_wh=float(p["wh"]))
        for p in raw
        if "timestamp" in p and "wh" in p
    ]


def _battery_soc_points_from_raw(raw: list[dict]) -> list[BatterySocPoint]:
    return [
        BatterySocPoint(slot=p["slot"], pct=float(p["pct"]))
        for p in raw
        if "slot" in p and "pct" in p
    ]


def _assemble_house_forecast_points(
    house_forecast_history_points: list[dict],
    current_slot_points: list[dict],
    snapshot: dict | None,
    target_date: date,
    *,
    current_slot_start: datetime | None,
    next_slot: datetime | None,
    need_past: bool,
    need_future: bool,
) -> list[dict]:
    points: list[dict] = []
    if need_past:
        points = _points_before(
            house_forecast_history_points,
            cutoff=current_slot_start if current_slot_points else next_slot,
        )
    points += current_slot_points
    if need_future:
        points += _house_forecast_points_from_snapshot(
            snapshot,
            target_date,
            next_slot=next_slot,
        )
    return points


def _build_day_house_forecast(
    composition: dict | None,
    scheduled_consumers: list[dict],
    target_date: date,
    *,
    current_slot_start: datetime | None,
    next_slot: datetime | None,
    breakdown_consumers: list[dict],
    house_forecast_history_points: list[dict],
    snapshot: dict | None,
    need_past: bool,
    need_future: bool,
) -> tuple[list[dict], list[SolarBiasHouseBreakdownPoint]]:
    breakdown_points: list[SolarBiasHouseBreakdownPoint] = []
    if need_future:
        breakdown_points = _build_house_forecast_breakdown(
            composition,
            scheduled_consumers,
            target_date,
            next_slot=next_slot,
            metered_by_entity=breakdown_consumers,
        )
    current_slot_points = _house_forecast_total_for_slot(
        breakdown_points, slot_start=current_slot_start
    )
    house_forecast_points = _assemble_house_forecast_points(
        house_forecast_history_points,
        current_slot_points,
        snapshot,
        target_date,
        current_slot_start=current_slot_start,
        next_slot=next_slot,
        need_past=need_past,
        need_future=need_future,
    )
    return house_forecast_points, breakdown_points


def _compose_inspector_series(
    solar: DaySolar,
    series: DayForecastAndActualSeries,
    price_rails: DayPriceRails,
    drawn_actual_points: list[SolarBiasInspectorPoint],
    drawn_invalidated_points: list[SolarBiasInspectorPoint],
    drawn_house_actual_points: list[dict],
    drawn_house_actual_breakdown_points: list[dict],
    drawn_battery_soc_actual_points: list[dict],
    drawn_grid_actual_points: list[dict],
    drawn_battery_actual_points: list[dict],
    drawn_money_actual_points: list[SolarBiasMoneyPoint],
) -> SolarBiasInspectorSeries:
    return SolarBiasInspectorSeries(
        raw=_inspector_points(solar.raw_points),
        corrected=_inspector_points(solar.corrected_points),
        actual=drawn_actual_points,
        invalidated=drawn_invalidated_points,
        factors=solar.factors,
        impact=_impact_points_for_day(
            solar.raw_points,
            solar.corrected_points,
        ),
        house_forecast=_inspector_points_from_raw(series.house_forecast_points),
        house_actual=_inspector_points_from_raw(drawn_house_actual_points),
        house_actual_breakdown=drawn_house_actual_breakdown_points,
        house_forecast_breakdown=series.house_forecast_breakdown_points,
        battery_soc_forecast=_battery_soc_points_from_raw(
            series.battery_soc_forecast_points
        ),
        battery_soc_actual=_battery_soc_points_from_raw(
            drawn_battery_soc_actual_points
        ),
        grid_forecast=_inspector_points_from_raw(series.grid_forecast_points),
        grid_actual=_inspector_points_from_raw(drawn_grid_actual_points),
        battery_forecast=_inspector_points_from_raw(series.battery_forecast_points),
        battery_actual=_inspector_points_from_raw(drawn_battery_actual_points),
        import_price=_price_points(price_rails.import_price_by_slot),
        export_price=_price_points(price_rails.export_price_by_slot),
        money_actual=drawn_money_actual_points,
        money_forecast=price_rails.money_forecast_points,
    )


def _compose_inspector_totals(
    solar: DaySolar,
    series: DayForecastAndActualSeries,
    price_rails: DayPriceRails,
    actuals_by_slot: dict[str, float],
    grid_actual_points: list[dict],
) -> SolarBiasInspectorTotals:
    return SolarBiasInspectorTotals(
        raw_wh=_sum_point_values(solar.raw_points) if solar.raw_points else None,
        corrected_wh=(
            _sum_point_values(solar.corrected_points) if solar.corrected_points else None
        ),
        actual_wh=sum(actuals_by_slot.values()) if actuals_by_slot else None,
        house_forecast_wh=(
            sum(p["wh"] for p in series.house_forecast_points)
            if series.house_forecast_points
            else None
        ),
        house_actual_wh=(
            sum(p["wh"] for p in series.house_actual_points)
            if series.house_actual_points
            else None
        ),
        grid_forecast_wh=(
            sum(p["wh"] for p in series.grid_forecast_points)
            if series.grid_forecast_points
            else None
        ),
        grid_actual_wh=(
            sum(p["wh"] for p in grid_actual_points)
            if grid_actual_points
            else None
        ),
        battery_forecast_wh=(
            sum(p["wh"] for p in series.battery_forecast_points)
            if series.battery_forecast_points
            else None
        ),
        battery_actual_wh=(
            sum(p["wh"] for p in series.battery_actual_points)
            if series.battery_actual_points
            else None
        ),
        money_actual=_money_totals(price_rails.money_actual_points),
        money_forecast=_money_totals(price_rails.money_forecast_points),
    )

