from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any

from homeassistant.util import dt as dt_util

from .const import (
    HOUSE_FORECAST_DEFAULT_MIN_SLOT_POINTS,
    HOUSE_FORECAST_LOWER_PERCENTILE,
    HOUSE_FORECAST_UPPER_PERCENTILE,
)
from .consumption_forecast_statistics import ForecastBand, summarize_winsorized_values

_LOGGER = logging.getLogger(__name__)

# Bumped whenever the fit produces different numbers for unchanged input, so a
# profile fitted by an older algorithm is refused rather than served.
HOUSE_CONSUMPTION_PROFILE_SCHEMA_VERSION = 1

# Threshold for "materially negative" residual (kWh).
# Tiny negatives (>= threshold) are clamped to 0; values below are dropped.
NEGATIVE_RESIDUAL_THRESHOLD = -0.01

ZERO_BAND = ForecastBand(0.0, 0.0, 0.0)


class HourOfWeekWinsorizedMeanProfile:
    """168-slot hour-of-week profile with same-hour-any-day sparse fallback."""

    SLOTS = 168  # 7 days x 24 hours

    def __init__(
        self,
        *,
        min_slot_points: int = HOUSE_FORECAST_DEFAULT_MIN_SLOT_POINTS,
        lower_percentile: float = HOUSE_FORECAST_LOWER_PERCENTILE,
        upper_percentile: float = HOUSE_FORECAST_UPPER_PERCENTILE,
    ) -> None:
        self._min_slot_points = min_slot_points
        self._lower_percentile = lower_percentile
        self._upper_percentile = upper_percentile
        self._values: list[list[float]] = [[] for _ in range(self.SLOTS)]

    @staticmethod
    def slot_index(weekday: int, hour: int) -> int:
        """Convert (weekday 0=Mon, hour 0-23) to slot index 0-167."""
        return weekday * 24 + hour

    def add(self, weekday: int, hour: int, value: float) -> None:
        idx = self.slot_index(weekday, hour)
        self._values[idx].append(value)

    def forecast(self, weekday: int, hour: int) -> ForecastBand:
        """Return the center and spread for the given slot."""
        idx = self.slot_index(weekday, hour)
        values = self._values[idx]

        if len(values) >= self._min_slot_points:
            return self._summarize(values)

        same_hour_values: list[float] = []
        for day in range(7):
            same_hour_values.extend(self._values[self.slot_index(day, hour)])

        if not same_hour_values:
            return ForecastBand(0.0, 0.0, 0.0)

        return self._summarize(same_hour_values)

    def _summarize(self, values: list[float]) -> ForecastBand:
        return summarize_winsorized_values(
            values,
            lower_percentile=self._lower_percentile,
            upper_percentile=self._upper_percentile,
        )


@dataclass(frozen=True)
class ConsumerHistoryData:
    """One deferrable consumer's training-window history, keyed by row timestamp."""

    entity_id: str
    label: str
    values_by_ts: dict[int, float]
    query_succeeded: bool


@dataclass(frozen=True)
class HouseConsumptionProfile:
    """The fitted house-consumption model: 168 resolved bands per series.

    Resolved bands, not raw buckets. ``HourOfWeekWinsorizedMeanProfile.forecast``
    is not a lookup -- on a bucket below ``min_slot_points`` it pools the raw
    values of all seven days at that hour and re-winsorises them -- so a table
    of per-bucket summaries could not reproduce it. Materializing all 168
    answers at fit time bakes the fallback in, which is what makes the profile
    something that can be stored and replayed exactly.

    Both band tables are indexed by ``HourOfWeekWinsorizedMeanProfile.slot_index``.
    """

    schema_version: int
    history_days: int
    non_deferrable: list[ForecastBand]
    consumers: dict[str, list[ForecastBand]]


def rows_to_dict(rows: list[dict]) -> dict[int, float]:
    """Convert Recorder rows to {unix_timestamp: kWh_change} dict."""
    result: dict[int, float] = {}
    for row in rows:
        ts = row["start"]
        change = row.get("change")
        if change is not None:
            result[ts] = change
    return result


def fit_house_profile(
    house_rows: list[dict],
    consumer_histories: list[ConsumerHistoryData],
    *,
    today_local: date,
) -> HouseConsumptionProfile:
    """Fit the hour-of-week profiles over a whole training window.

    Pure CPU: safe to run in a worker thread, touches no ``hass`` and does no
    I/O.
    """
    house_by_ts = rows_to_dict(house_rows)

    non_deferrable_profile = HourOfWeekWinsorizedMeanProfile()
    consumer_profiles: dict[str, HourOfWeekWinsorizedMeanProfile] = {
        consumer.entity_id: HourOfWeekWinsorizedMeanProfile()
        for consumer in consumer_histories
    }

    for ts, house_value in house_by_ts.items():
        local_dt = dt_util.as_local(dt_util.utc_from_timestamp(ts))
        weekday = local_dt.weekday()
        hour = local_dt.hour
        deferrable_sum = sum(
            consumer.values_by_ts.get(ts, 0.0) for consumer in consumer_histories
        )
        residual = house_value - deferrable_sum

        if residual < NEGATIVE_RESIDUAL_THRESHOLD:
            _LOGGER.debug(
                "Dropping materially negative residual %.4f kWh at %s",
                residual,
                local_dt.isoformat(),
            )
            continue

        non_deferrable_profile.add(weekday, hour, max(0.0, residual))
        for consumer in consumer_histories:
            consumer_profiles[consumer.entity_id].add(
                weekday,
                hour,
                max(0.0, consumer.values_by_ts.get(ts, 0.0)),
            )

    return HouseConsumptionProfile(
        schema_version=HOUSE_CONSUMPTION_PROFILE_SCHEMA_VERSION,
        history_days=_compute_history_days(house_rows, today_local=today_local),
        non_deferrable=_resolve_bands(non_deferrable_profile),
        consumers={
            entity_id: _resolve_bands(profile)
            for entity_id, profile in consumer_profiles.items()
        },
    )


def profile_to_dict(profile: HouseConsumptionProfile) -> dict[str, Any]:
    """Serialize a fitted profile for the training-artifacts store."""
    return {
        "schema_version": profile.schema_version,
        "history_days": profile.history_days,
        "non_deferrable": _bands_to_list(profile.non_deferrable),
        "consumers": {
            entity_id: _bands_to_list(bands)
            for entity_id, bands in profile.consumers.items()
        },
    }


def profile_from_dict(raw: Any) -> HouseConsumptionProfile | None:
    """Restore a stored profile, or ``None`` when it cannot be trusted.

    A profile that does not deserialize cleanly is treated exactly like a
    missing one: refit, rather than serve half a model.
    """
    if not isinstance(raw, dict):
        return None
    if raw.get("schema_version") != HOUSE_CONSUMPTION_PROFILE_SCHEMA_VERSION:
        return None

    history_days = raw.get("history_days")
    if not isinstance(history_days, int) or isinstance(history_days, bool):
        return None

    non_deferrable = _bands_from_list(raw.get("non_deferrable"))
    if non_deferrable is None:
        return None

    raw_consumers = raw.get("consumers")
    if not isinstance(raw_consumers, dict):
        return None
    consumers: dict[str, list[ForecastBand]] = {}
    for entity_id, raw_bands in raw_consumers.items():
        if not isinstance(entity_id, str):
            return None
        bands = _bands_from_list(raw_bands)
        if bands is None:
            return None
        consumers[entity_id] = bands

    return HouseConsumptionProfile(
        schema_version=HOUSE_CONSUMPTION_PROFILE_SCHEMA_VERSION,
        history_days=history_days,
        non_deferrable=non_deferrable,
        consumers=consumers,
    )


def _resolve_bands(profile: HourOfWeekWinsorizedMeanProfile) -> list[ForecastBand]:
    """Materialize the 168 answers ``forecast()`` would give."""
    return [
        profile.forecast(weekday, hour)
        for weekday in range(7)
        for hour in range(24)
    ]


def _bands_to_list(bands: list[ForecastBand]) -> list[list[float]]:
    return [[band.value, band.lower, band.upper] for band in bands]


def _bands_from_list(raw: Any) -> list[ForecastBand] | None:
    if not isinstance(raw, list) or len(raw) != HourOfWeekWinsorizedMeanProfile.SLOTS:
        return None
    bands: list[ForecastBand] = []
    for entry in raw:
        if not isinstance(entry, (list, tuple)) or len(entry) != 3:
            return None
        try:
            value, lower, upper = (float(item) for item in entry)
        except (TypeError, ValueError):
            return None
        bands.append(ForecastBand(value, lower, upper))
    return bands


def _compute_history_days(rows: list[dict], *, today_local: date) -> int:
    """Compute number of days of history from Recorder rows.

    The rows-based half of one measurement. Its twin,
    :func:`~.recorder_statistics_span.query_history_days`, asks the recorder the
    same question from an entity id, for callers that hold no rows -- and **the
    two must agree**: whole days between the local date of the oldest sample and
    ``today_local``, zero when there is nothing. This one exists because a
    training run has already fetched the window and re-asking the recorder would
    be a second round trip for a number it is holding.
    """
    if not rows:
        return 0
    oldest_ts = min(row["start"] for row in rows)
    oldest_local = dt_util.as_local(dt_util.utc_from_timestamp(oldest_ts))
    return (today_local - oldest_local.date()).days
