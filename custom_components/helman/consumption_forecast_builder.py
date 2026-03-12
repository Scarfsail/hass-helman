from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

# Recency weighting: exponential decay half-life in days
_WEIGHT_HALF_LIFE_DAYS = 14.0

# Minimum data points in a slot before falling back to same-hour-any-day
_MIN_SLOT_POINTS = 2

# Threshold for "materially negative" residual (kWh).
# Tiny negatives (>= threshold) are clamped to 0; values below are dropped.
_NEGATIVE_RESIDUAL_THRESHOLD = -0.01


def _weighted_percentile(
    sorted_pairs: list[tuple[float, float]],
    total_weight: float,
    percentile: float,
) -> float:
    """Compute a weighted percentile from pre-sorted (value, weight) pairs."""
    if not sorted_pairs:
        return 0.0
    if len(sorted_pairs) == 1:
        return sorted_pairs[0][0]

    target = percentile * total_weight
    cumulative = 0.0

    for i, (value, weight) in enumerate(sorted_pairs):
        cumulative += weight
        if cumulative >= target:
            if i == 0 or weight == 0:
                return value
            prev_value = sorted_pairs[i - 1][0]
            prev_cumulative = cumulative - weight
            fraction = max(0.0, min(1.0, (target - prev_cumulative) / weight))
            return prev_value + fraction * (value - prev_value)

    return sorted_pairs[-1][0]


class HourOfWeekProfile:
    """168-slot statistical profile for hour-of-week forecasting.

    Each slot accumulates (value, weight) pairs. The forecast for a slot
    is the weighted mean with 10th/90th weighted percentile bands.
    If a slot has fewer than _MIN_SLOT_POINTS data points, the forecast
    falls back to aggregating all 7 days for that hour.
    """

    SLOTS = 168  # 7 days x 24 hours

    def __init__(self) -> None:
        self._values: list[list[float]] = [[] for _ in range(self.SLOTS)]
        self._weights: list[list[float]] = [[] for _ in range(self.SLOTS)]

    @staticmethod
    def slot_index(weekday: int, hour: int) -> int:
        """Convert (weekday 0=Mon, hour 0-23) to slot index 0-167."""
        return weekday * 24 + hour

    def add(self, weekday: int, hour: int, value: float, weight: float) -> None:
        idx = self.slot_index(weekday, hour)
        self._values[idx].append(value)
        self._weights[idx].append(weight)

    def forecast(self, weekday: int, hour: int) -> tuple[float, float, float]:
        """Return (value, lower, upper) for the given slot."""
        idx = self.slot_index(weekday, hour)
        values = self._values[idx]
        weights = self._weights[idx]

        if len(values) >= _MIN_SLOT_POINTS:
            return self._weighted_stats(values, weights)

        # Fallback: same hour, any day of week
        all_values: list[float] = []
        all_weights: list[float] = []
        for day in range(7):
            fidx = self.slot_index(day, hour)
            all_values.extend(self._values[fidx])
            all_weights.extend(self._weights[fidx])

        if not all_values:
            return (0.0, 0.0, 0.0)

        return self._weighted_stats(all_values, all_weights)

    @staticmethod
    def _weighted_stats(
        values: list[float], weights: list[float]
    ) -> tuple[float, float, float]:
        """Weighted mean + weighted 10th/90th percentiles."""
        paired = sorted(zip(values, weights), key=lambda x: x[0])
        total_weight = sum(w for _, w in paired)

        if total_weight == 0:
            return (0.0, 0.0, 0.0)

        mean = sum(v * w for v, w in paired) / total_weight
        lower = _weighted_percentile(paired, total_weight, 0.10)
        upper = _weighted_percentile(paired, total_weight, 0.90)

        return (round(mean, 4), round(lower, 4), round(upper, 4))


class ConsumptionForecastBuilder:
    """Builds the house_consumption forecast payload."""

    _HORIZON_HOURS = 168

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def build(self) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        house_config = self._read_dict(power_devices.get("house"))
        forecast_config = self._read_dict(house_config.get("forecast"))

        total_energy_entity_id = self._read_entity_id(
            forecast_config.get("total_energy_entity_id")
        )
        min_history_days = forecast_config.get("min_history_days", 14)
        training_window_days = forecast_config.get("training_window_days", 42)

        if total_energy_entity_id is None:
            return self._make_payload(
                status="not_configured",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
            )

        # Query house total hourly history
        try:
            house_rows = await self._query_hourly_history(
                total_energy_entity_id, training_window_days
            )
        except Exception:
            _LOGGER.exception(
                "Failed to query Recorder statistics for %s",
                total_energy_entity_id,
            )
            return self._make_payload(
                status="unavailable",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
            )

        history_days = self._compute_history_days(house_rows)

        if history_days < min_history_days:
            return self._make_payload(
                status="insufficient_history",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                history_days=history_days,
            )

        # Read deferrable consumers and query their histories
        consumers_config = self._read_deferrable_consumers(
            forecast_config.get("deferrable_consumers")
        )
        consumer_rows: dict[str, list[dict]] = {}
        for consumer in consumers_config:
            eid = consumer["energy_entity_id"]
            try:
                consumer_rows[eid] = await self._query_hourly_history(
                    eid, training_window_days
                )
            except Exception:
                _LOGGER.warning(
                    "Failed to query history for deferrable consumer %s, using empty",
                    eid,
                )
                consumer_rows[eid] = []

        # Build time-indexed lookups: {unix_ts: kWh_change}
        house_by_ts = self._rows_to_dict(house_rows)
        consumers_by_ts: dict[str, dict[int, float]] = {
            eid: self._rows_to_dict(rows) for eid, rows in consumer_rows.items()
        }

        # Build hour-of-week profiles
        local_now = dt_util.now()
        non_deferrable_profile = HourOfWeekProfile()
        consumer_profiles: dict[str, HourOfWeekProfile] = {
            eid: HourOfWeekProfile() for eid in consumer_rows
        }

        for ts, house_value in house_by_ts.items():
            local_dt = dt_util.as_local(dt_util.utc_from_timestamp(ts))
            age_days = (local_now - local_dt).total_seconds() / 86400.0
            weight = 2.0 ** (-age_days / _WEIGHT_HALF_LIFE_DAYS)
            weekday = local_dt.weekday()
            hour = local_dt.hour

            # Compute non-deferrable residual
            deferrable_sum = sum(
                consumers_by_ts[eid].get(ts, 0.0) for eid in consumers_by_ts
            )
            residual = house_value - deferrable_sum

            if residual < _NEGATIVE_RESIDUAL_THRESHOLD:
                _LOGGER.debug(
                    "Dropping materially negative residual %.4f kWh at %s",
                    residual,
                    local_dt.isoformat(),
                )
                continue

            non_deferrable_profile.add(weekday, hour, max(0.0, residual), weight)

            # Feed each consumer profile
            for eid, profile in consumer_profiles.items():
                value = consumers_by_ts[eid].get(ts, 0.0)
                profile.add(weekday, hour, max(0.0, value), weight)

        # Generate forecast series starting from the next full hour
        series: list[dict[str, Any]] = []
        forecast_start = (local_now + timedelta(hours=1)).replace(
            minute=0, second=0, microsecond=0
        )

        for i in range(self._HORIZON_HOURS):
            forecast_dt = forecast_start + timedelta(hours=i)
            weekday = forecast_dt.weekday()
            hour = forecast_dt.hour

            nd_val, nd_lower, nd_upper = non_deferrable_profile.forecast(
                weekday, hour
            )

            deferrable_list: list[dict[str, Any]] = []
            for consumer in consumers_config:
                eid = consumer["energy_entity_id"]
                c_val, c_lower, c_upper = consumer_profiles[eid].forecast(
                    weekday, hour
                )
                deferrable_list.append({
                    "entityId": eid,
                    "label": consumer["label"],
                    "value": c_val,
                    "lower": c_lower,
                    "upper": c_upper,
                })

            series.append({
                "timestamp": forecast_dt.isoformat(),
                "nonDeferrable": {
                    "value": nd_val,
                    "lower": nd_lower,
                    "upper": nd_upper,
                },
                "deferrableConsumers": deferrable_list,
            })

        return self._make_payload(
            status="available",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            history_days=history_days,
            model="hour_of_week_baseline",
            series=series,
        )

    async def _query_hourly_history(
        self, entity_id: str, training_window_days: int
    ) -> list[dict]:
        """Query Recorder hourly statistics and return raw rows."""
        local_now = dt_util.now()
        local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        start_time = dt_util.as_utc(
            local_midnight - timedelta(days=training_window_days)
        )

        stat = await get_instance(self._hass).async_add_executor_job(
            statistics_during_period,
            self._hass,
            start_time,
            None,
            {entity_id},
            "hour",
            {"energy": "kWh"},
            {"change"},
        )

        return stat.get(entity_id, [])

    @staticmethod
    def _compute_history_days(rows: list[dict]) -> int:
        """Compute number of days of history from Recorder rows."""
        if not rows:
            return 0
        oldest_ts = min(row["start"] for row in rows)
        oldest_local = dt_util.as_local(dt_util.utc_from_timestamp(oldest_ts))
        today_local = dt_util.now().date()
        return (today_local - oldest_local.date()).days

    @staticmethod
    def _rows_to_dict(rows: list[dict]) -> dict[int, float]:
        """Convert Recorder rows to {unix_timestamp: kWh_change} dict."""
        result: dict[int, float] = {}
        for row in rows:
            ts = row["start"]
            change = row.get("change")
            if change is not None:
                result[ts] = change
        return result

    @staticmethod
    def _make_payload(
        *,
        status: str,
        training_window_days: int,
        min_history_days: int,
        history_days: int = 0,
        model: str | None = None,
        series: list | None = None,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "unit": "kWh",
            "resolution": "hour",
            "horizonHours": 168,
            "trainingWindowDays": training_window_days,
            "historyDaysAvailable": history_days,
            "requiredHistoryDays": min_history_days,
            "model": model,
            "series": series if series is not None else [],
        }

    @staticmethod
    def _read_dict(raw_value: Any) -> dict[str, Any]:
        if isinstance(raw_value, dict):
            return raw_value
        return {}

    @staticmethod
    def _read_entity_id(raw_value: Any) -> str | None:
        if isinstance(raw_value, str) and raw_value.strip():
            return raw_value.strip()
        return None

    @staticmethod
    def _read_deferrable_consumers(raw_value: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_value, list):
            return []
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in raw_value:
            if not isinstance(item, dict):
                continue
            entity_id = item.get("energy_entity_id")
            if not isinstance(entity_id, str) or not entity_id.strip():
                continue
            eid = entity_id.strip()
            if eid in seen:
                continue
            seen.add(eid)
            result.append({
                "energy_entity_id": eid,
                "label": item.get("label", eid),
            })
        return result
