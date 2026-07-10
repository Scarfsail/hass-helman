"""Per-calendar-day context for day-scoped automation rules (A3).

A ``DayContext`` classifies a calendar day (surplus / tight / deficit) and
carries the price statistics and import-band segmentation the day-scoped rules
read. It is computed framework-side once per automation run and — for its
stability-sensitive fields (classification, day-min window) — frozen per day by
``day_context_store`` so a rule's decision cannot flip mid-day.

The builder here is pure: it consumes already-parsed forecast series/points and
returns a ``dict[date, DayContext]``. The coordinator adapts the pinned bundle
and initial snapshot into these inputs and owns the freeze store.
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


@dataclass(frozen=True)
class ImportBand:
    level: str  # IMPORT_BAND_LEVEL_CHEAP | IMPORT_BAND_LEVEL_EXPENSIVE
    start: datetime
    end: datetime


@dataclass(frozen=True)
class DayMinWindow:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class FrozenDayContext:
    """The per-day fields frozen across runs of the same calendar day."""

    classification: str
    day_min_window: DayMinWindow | None


@dataclass(frozen=True)
class DayContext:
    local_date: date
    classification: str
    predicted_solar_kwh: float
    predicted_consumption_kwh: float
    export_price_min: float | None
    export_price_max: float | None
    day_min_window: DayMinWindow | None
    import_bands: tuple[ImportBand, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "localDate": self.local_date.isoformat(),
            "classification": self.classification,
            "predictedSolarKwh": self.predicted_solar_kwh,
            "predictedConsumptionKwh": self.predicted_consumption_kwh,
            "exportPriceMin": self.export_price_min,
            "exportPriceMax": self.export_price_max,
            "dayMinWindow": (
                None
                if self.day_min_window is None
                else {
                    "start": self.day_min_window.start.isoformat(),
                    "end": self.day_min_window.end.isoformat(),
                }
            ),
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
    frozen_overrides: Mapping[date, FrozenDayContext] | None = None,
) -> dict[date, DayContext]:
    """Build one ``DayContext`` per calendar day with both forecast and prices.

    A day is emitted only when it has both solar/house forecast coverage and
    export price points — so tomorrow appears only once tomorrow's prices have
    arrived. ``frozen_overrides`` pins the stability-sensitive fields
    (classification, day-min window) for days already frozen by the store.
    """
    frozen_overrides = frozen_overrides or {}

    solar_by_date, consumption_by_date, max_baseline_soc_by_date = (
        _aggregate_battery_series_by_date(battery_series)
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
        day_min_window = _build_day_min_window(day_export_points, export_price_min)

        import_bands = _build_import_bands(
            import_points_by_date.get(local_date, [])
        )

        override = frozen_overrides.get(local_date)
        if override is not None:
            classification = override.classification
            day_min_window = override.day_min_window
        else:
            classification = _classify(
                predicted_solar_kwh=predicted_solar_kwh,
                predicted_consumption_kwh=predicted_consumption_kwh,
                max_baseline_soc_pct=max_baseline_soc_by_date.get(local_date),
                battery_max_soc=battery_max_soc,
                deficit_below_ratio=deficit_below_ratio,
                surplus_above_ratio=surplus_above_ratio,
            )

        day_contexts[local_date] = DayContext(
            local_date=local_date,
            classification=classification,
            predicted_solar_kwh=predicted_solar_kwh,
            predicted_consumption_kwh=predicted_consumption_kwh,
            export_price_min=export_price_min,
            export_price_max=export_price_max,
            day_min_window=day_min_window,
            import_bands=import_bands,
        )

    return day_contexts


def _classify(
    *,
    predicted_solar_kwh: float,
    predicted_consumption_kwh: float,
    max_baseline_soc_pct: float | None,
    battery_max_soc: float | None,
    deficit_below_ratio: float,
    surplus_above_ratio: float,
) -> str:
    if predicted_consumption_kwh <= 0:
        ratio = float("inf") if predicted_solar_kwh > 0 else 0.0
    else:
        ratio = predicted_solar_kwh / predicted_consumption_kwh

    if ratio >= surplus_above_ratio:
        classification = DAY_CLASSIFICATION_SURPLUS
    elif ratio <= deficit_below_ratio:
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


def _build_day_min_window(
    day_export_points: list[tuple[datetime, float]],
    export_price_min: float,
) -> DayMinWindow | None:
    if not day_export_points:
        return None

    granularity = _infer_granularity(day_export_points)
    # First contiguous run of slots at the minimum export price.
    run_start: datetime | None = None
    run_end: datetime | None = None
    for point_time, value in day_export_points:
        if abs(value - export_price_min) <= _PRICE_TOLERANCE:
            if run_start is None:
                run_start = point_time
            run_end = point_time
        elif run_start is not None:
            break

    if run_start is None or run_end is None:
        return None
    return DayMinWindow(start=run_start, end=run_end + granularity)


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
        baseline_soc = _read_optional_float(point.get("baselineSocPct"))
        if baseline_soc is not None:
            max_baseline_soc_by_date[local_date] = max(
                max_baseline_soc_by_date.get(local_date, baseline_soc),
                baseline_soc,
            )
    return solar_by_date, consumption_by_date, max_baseline_soc_by_date


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
