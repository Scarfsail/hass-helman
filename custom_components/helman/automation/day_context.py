"""Per-calendar-day context for day-scoped automation rules (A3).

A ``DayContext`` classifies a calendar day (surplus / tight / deficit) and
carries the price statistics and import-band segmentation the day-scoped rules
read. It is recomputed on every automation run — and, since #264, once per
optimizer, over the house view that optimizer actually plans against, because
an appliance must not find its own carried-over lane in the denominator that
decides whether it may run.

Stability no longer comes from freezing a day the first time it is seen (which
pinned every day to a forecast taken up to 35 hours before the day ended).
It comes from a deadband around the two thresholds: ``previous_bands`` carries
the band the last run emitted for this day *and this optimizer*, and a ratio
hovering at a threshold keeps the band it already had. See ``_classify``.

Today's figures are whole-day figures: the forecast series starts at ``now``,
so the elapsed part is added from the actual histories the input bundle already
carries. Without that, every day decays toward deficit through the afternoon on
a forecast that has not moved at all.

The builder here is pure: it consumes already-parsed forecast series/points and
returns a ``dict[date, DayContext]``. The pipeline adapts each snapshot into
these inputs; the coordinator owns the hysteresis store.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..const import (
    DAY_CLASSIFICATION_DEFICIT,
    DAY_CLASSIFICATION_SURPLUS,
    DAY_CLASSIFICATION_TIGHT,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    IMPORT_BAND_LEVEL_CHEAP,
    IMPORT_BAND_LEVEL_EXPENSIVE,
)

_PRICE_TOLERANCE = 1e-9
_SOC_FULL_TOLERANCE_PCT = 1.0
#: Hysteresis half-width around both classification thresholds (#264).
#:
#: The classification is recomputed every run, so a day whose ratio sits on a
#: threshold would otherwise flip band every 15 minutes and hand the day-scoped
#: rules a different answer each time. A band is only left once the ratio has
#: moved this far past the threshold that would change it; see ``_classify``.
#:
#: Deliberately a module constant rather than config: it is a property of how
#: noisy a solar/house ratio is over a run interval, not a user preference, and
#: the thresholds it damps are the configurable part.
_CLASSIFICATION_DEADBAND_RATIO = 0.05


@dataclass(frozen=True)
class ImportBand:
    level: str  # IMPORT_BAND_LEVEL_CHEAP | IMPORT_BAND_LEVEL_EXPENSIVE
    start: datetime
    end: datetime


@dataclass(frozen=True)
class DayContext:
    local_date: date
    classification: str
    predicted_solar_kwh: float
    predicted_consumption_kwh: float
    export_price_min: float | None
    export_price_max: float | None
    import_bands: tuple[ImportBand, ...]
    #: Solar over consumption for the whole day, as the classification saw it.
    #: ``inf`` where a day has consumption of zero and any solar at all.
    ratio: float = 0.0
    #: The optimizer whose house view produced ``predicted_consumption_kwh``,
    #: or ``None`` for the canonical run-wide computation reported to the UI.
    #: Two optimizers legitimately hold different bands for the same day in the
    #: same run (#264), so a trace has to name which denominator it used.
    denominator_optimizer_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "localDate": self.local_date.isoformat(),
            "classification": self.classification,
            "predictedSolarKwh": self.predicted_solar_kwh,
            "predictedConsumptionKwh": self.predicted_consumption_kwh,
            "ratio": None if self.ratio == float("inf") else self.ratio,
            "denominatorOptimizerId": self.denominator_optimizer_id,
            "exportPriceMin": self.export_price_min,
            "exportPriceMax": self.export_price_max,
            "importBands": [
                {
                    "level": band.level,
                    "start": band.start.isoformat(),
                    "end": band.end.isoformat(),
                }
                for band in self.import_bands
            ],
        }


def build_day_contexts(
    *,
    battery_series: list[dict[str, Any]],
    export_price_points: list[dict[str, Any]],
    import_price_points: list[dict[str, Any]],
    battery_max_soc: float | None,
    deficit_below_ratio: float,
    surplus_above_ratio: float,
    solar_actual_history: list[dict[str, Any]] | None = None,
    house_actual_history: list[dict[str, Any]] | None = None,
    previous_bands: Mapping[date, str] | None = None,
    denominator_optimizer_id: str | None = None,
) -> dict[date, DayContext]:
    """Build one ``DayContext`` per calendar day with both forecast and prices.

    A day is emitted only when it has both solar/house forecast coverage and
    export price points — so tomorrow appears only once tomorrow's prices have
    arrived.

    The two ``*_actual_history`` payloads supply today's elapsed part; the
    forecast series only covers from ``now`` on, so without them today's figures
    shrink through the day and every day drifts toward deficit by evening
    regardless of weather (#264). Only today carries actuals — a future day's
    series already spans midnight to midnight — so nothing else is touched.

    ``previous_bands`` is the band each day held on the previous run *for this
    same denominator*; it feeds the deadband in ``_classify``.
    """
    previous_bands = previous_bands or {}

    solar_by_date, consumption_by_date, max_baseline_soc_by_date = (
        _aggregate_battery_series_by_date(battery_series)
    )
    _add_elapsed_actuals(
        solar_by_date=solar_by_date,
        consumption_by_date=consumption_by_date,
        solar_actual_history=solar_actual_history or [],
        house_actual_history=house_actual_history or [],
        covered_dates=set(solar_by_date) | set(consumption_by_date),
    )
    export_points_by_date = _group_points_by_date(export_price_points)
    import_points_by_date = _group_points_by_date(import_price_points)

    day_contexts: dict[date, DayContext] = {}
    for local_date in sorted(solar_by_date):
        day_export_points = export_points_by_date.get(local_date)
        if not day_export_points:
            continue

        predicted_solar_kwh = solar_by_date[local_date]
        predicted_consumption_kwh = consumption_by_date.get(local_date, 0.0)

        export_values = [value for _, value in day_export_points]
        export_price_min = min(export_values)
        export_price_max = max(export_values)

        import_bands = _build_import_bands(
            import_points_by_date.get(local_date, [])
        )

        ratio = _solar_to_consumption_ratio(
            predicted_solar_kwh=predicted_solar_kwh,
            predicted_consumption_kwh=predicted_consumption_kwh,
        )
        classification = _classify(
            ratio=ratio,
            max_baseline_soc_pct=max_baseline_soc_by_date.get(local_date),
            battery_max_soc=battery_max_soc,
            deficit_below_ratio=deficit_below_ratio,
            surplus_above_ratio=surplus_above_ratio,
            previous_band=previous_bands.get(local_date),
        )

        day_contexts[local_date] = DayContext(
            local_date=local_date,
            classification=classification,
            predicted_solar_kwh=predicted_solar_kwh,
            predicted_consumption_kwh=predicted_consumption_kwh,
            export_price_min=export_price_min,
            export_price_max=export_price_max,
            import_bands=import_bands,
            ratio=ratio,
            denominator_optimizer_id=denominator_optimizer_id,
        )

    return day_contexts


def _solar_to_consumption_ratio(
    *,
    predicted_solar_kwh: float,
    predicted_consumption_kwh: float,
) -> float:
    if predicted_consumption_kwh <= 0:
        return float("inf") if predicted_solar_kwh > 0 else 0.0
    return predicted_solar_kwh / predicted_consumption_kwh


def _classify(
    *,
    ratio: float,
    max_baseline_soc_pct: float | None,
    battery_max_soc: float | None,
    deficit_below_ratio: float,
    surplus_above_ratio: float,
    previous_band: str | None = None,
) -> str:
    """Map a whole-day ratio onto a band, damped by the band it already held.

    With no previous band this is the plain threshold mapping. With one, each
    threshold is displaced by ``_CLASSIFICATION_DEADBAND_RATIO`` *away* from the
    band currently held, so leaving a band costs more than staying in it:
    travelling down out of tight takes a ratio below ``deficit_below_ratio -
    deadband``, and travelling back up out of deficit takes one above
    ``deficit_below_ratio + deadband``. Symmetrically at
    ``surplus_above_ratio`` (#264).
    """
    deficit_threshold = deficit_below_ratio
    surplus_threshold = surplus_above_ratio
    if previous_band == DAY_CLASSIFICATION_DEFICIT:
        deficit_threshold += _CLASSIFICATION_DEADBAND_RATIO
    elif previous_band is not None:
        deficit_threshold -= _CLASSIFICATION_DEADBAND_RATIO
    if previous_band == DAY_CLASSIFICATION_SURPLUS:
        surplus_threshold -= _CLASSIFICATION_DEADBAND_RATIO
    elif previous_band is not None:
        surplus_threshold += _CLASSIFICATION_DEADBAND_RATIO

    if ratio >= surplus_threshold:
        classification = DAY_CLASSIFICATION_SURPLUS
    elif ratio <= deficit_threshold:
        classification = DAY_CLASSIFICATION_DEFICIT
    else:
        classification = DAY_CLASSIFICATION_TIGHT

    # v1 refinement (resolution 1): a surplus day must actually reach full in the
    # baseline simulation; if it does not, demote surplus -> tight. Ratio can
    # never *promote*.
    if (
        classification == DAY_CLASSIFICATION_SURPLUS
        and battery_max_soc is not None
        and max_baseline_soc_pct is not None
        and max_baseline_soc_pct < battery_max_soc - _SOC_FULL_TOLERANCE_PCT
    ):
        classification = DAY_CLASSIFICATION_TIGHT

    return classification


def _build_import_bands(
    day_import_points: list[tuple[datetime, float]],
) -> tuple[ImportBand, ...]:
    if not day_import_points:
        return ()

    granularity = _infer_granularity(day_import_points)
    cheap_level_value = min(value for _, value in day_import_points)

    bands: list[ImportBand] = []
    current_level: str | None = None
    band_start: datetime | None = None
    band_end: datetime | None = None
    for point_time, value in day_import_points:
        level = (
            IMPORT_BAND_LEVEL_CHEAP
            if abs(value - cheap_level_value) <= _PRICE_TOLERANCE
            else IMPORT_BAND_LEVEL_EXPENSIVE
        )
        if level != current_level:
            if current_level is not None and band_start is not None and band_end is not None:
                bands.append(
                    ImportBand(
                        level=current_level,
                        start=band_start,
                        end=band_end + granularity,
                    )
                )
            current_level = level
            band_start = point_time
        band_end = point_time

    if current_level is not None and band_start is not None and band_end is not None:
        bands.append(
            ImportBand(
                level=current_level,
                start=band_start,
                end=band_end + granularity,
            )
        )
    return tuple(bands)


def _aggregate_battery_series_by_date(
    battery_series: list[dict[str, Any]],
) -> tuple[dict[date, float], dict[date, float], dict[date, float]]:
    solar_by_date: dict[date, float] = {}
    consumption_by_date: dict[date, float] = {}
    max_baseline_soc_by_date: dict[date, float] = {}
    for point in battery_series:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        if timestamp is None:
            continue
        local_date = timestamp.date()
        solar_kwh = _read_optional_float(point.get("solarKwh"))
        if solar_kwh is not None:
            solar_by_date[local_date] = solar_by_date.get(local_date, 0.0) + solar_kwh
        house_kwh = _read_optional_float(point.get("baselineHouseKwh"))
        if house_kwh is not None:
            consumption_by_date[local_date] = (
                consumption_by_date.get(local_date, 0.0) + house_kwh
            )
        # `baselineSocPct` is only attached when the schedule carries a
        # non-normal *inverter* action; appliance placements do not produce it.
        # On an unadjusted series `socPct` *is* the baseline trajectory, so the
        # fallback is exact rather than approximate — without it the
        # surplus -> tight demotion below is silently inert on most runs (#264).
        baseline_soc = _read_optional_float(point.get("baselineSocPct"))
        if baseline_soc is None:
            baseline_soc = _read_optional_float(point.get("socPct"))
        if baseline_soc is not None:
            max_baseline_soc_by_date[local_date] = max(
                max_baseline_soc_by_date.get(local_date, baseline_soc),
                baseline_soc,
            )
    return solar_by_date, consumption_by_date, max_baseline_soc_by_date


def _add_elapsed_actuals(
    *,
    solar_by_date: dict[date, float],
    consumption_by_date: dict[date, float],
    solar_actual_history: list[dict[str, Any]],
    house_actual_history: list[dict[str, Any]],
    covered_dates: set[date],
) -> None:
    """Fold today's completed slots into the per-day forecast totals (#264).

    Both payloads hold only today's completed slots, and the forecast series
    starts at the slot in progress, so the two halves meet without overlapping.
    Dates the series does not cover are ignored anyway — a stale payload cannot
    invent a day — but the guard keeps that explicit.

    Solar actual values are Wh per slot; the series is kWh. The house total adds
    the deferrable consumers back onto ``nonDeferrable`` because the forecast
    half sums ``baselineHouseKwh``, which is the *adjusted* non-deferrable house
    and so already carries the appliance load scheduled into it. Elapsed is a
    fact and is taken whole, including runtime the optimizer deciding this day
    has already had.
    """
    for entry in solar_actual_history:
        if not isinstance(entry, dict):
            continue
        timestamp = _parse_timestamp(entry.get("timestamp"))
        value_wh = _read_optional_float(entry.get("value"))
        if timestamp is None or value_wh is None:
            continue
        local_date = timestamp.date()
        if local_date not in covered_dates:
            continue
        solar_by_date[local_date] = solar_by_date.get(local_date, 0.0) + (
            value_wh / 1000.0
        )

    for entry in house_actual_history:
        if not isinstance(entry, dict):
            continue
        timestamp = _parse_timestamp(entry.get("timestamp"))
        if timestamp is None:
            continue
        local_date = timestamp.date()
        if local_date not in covered_dates:
            continue
        non_deferrable = entry.get("nonDeferrable")
        slot_kwh = (
            _read_optional_float(non_deferrable.get("value"))
            if isinstance(non_deferrable, dict)
            else None
        )
        if slot_kwh is None:
            continue
        consumers = entry.get("deferrableConsumers")
        if isinstance(consumers, list):
            for consumer in consumers:
                if not isinstance(consumer, dict):
                    continue
                consumer_kwh = _read_optional_float(consumer.get("value"))
                if consumer_kwh is not None:
                    slot_kwh += consumer_kwh
        consumption_by_date[local_date] = (
            consumption_by_date.get(local_date, 0.0) + slot_kwh
        )


def _group_points_by_date(
    points: list[dict[str, Any]],
) -> dict[date, list[tuple[datetime, float]]]:
    grouped: dict[date, list[tuple[datetime, float]]] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = _parse_timestamp(point.get("timestamp"))
        value = _read_optional_float(point.get("value"))
        if timestamp is None or value is None:
            continue
        grouped.setdefault(timestamp.date(), []).append((timestamp, value))
    for day_points in grouped.values():
        day_points.sort(key=lambda item: dt_util.as_utc(item[0]))
    return grouped


def _infer_granularity(points: list[tuple[datetime, float]]) -> timedelta:
    if len(points) >= 2:
        delta = dt_util.as_utc(points[1][0]) - dt_util.as_utc(points[0][0])
        if delta.total_seconds() > 0:
            return delta
    return timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    parsed = dt_util.parse_datetime(value)
    if parsed is None or parsed.tzinfo is None:
        return None
    return dt_util.as_local(parsed)


def _read_optional_float(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
