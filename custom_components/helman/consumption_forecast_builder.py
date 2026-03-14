from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import (
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
)
from .consumption_forecast_profiles import HourOfWeekWinsorizedMeanProfile

_LOGGER = logging.getLogger(__name__)

# Threshold for "materially negative" residual (kWh).
# Tiny negatives (>= threshold) are clamped to 0; values below are dropped.
_NEGATIVE_RESIDUAL_THRESHOLD = -0.01


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
        min_history_days = self._read_positive_int(
            forecast_config.get("min_history_days"),
            HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
        )
        training_window_days = self._read_positive_int(
            forecast_config.get("training_window_days"),
            HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
        )

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
        non_deferrable_profile = HourOfWeekWinsorizedMeanProfile()
        consumer_profiles: dict[str, HourOfWeekWinsorizedMeanProfile] = {
            eid: HourOfWeekWinsorizedMeanProfile() for eid in consumer_rows
        }

        for ts, house_value in house_by_ts.items():
            local_dt = dt_util.as_local(dt_util.utc_from_timestamp(ts))
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

            non_deferrable_profile.add(weekday, hour, max(0.0, residual))

            # Feed each consumer profile
            for eid, profile in consumer_profiles.items():
                value = consumers_by_ts[eid].get(ts, 0.0)
                profile.add(weekday, hour, max(0.0, value))

        # Generate forecast series starting from the next full hour
        series: list[dict[str, Any]] = []
        forecast_start = (dt_util.now() + timedelta(hours=1)).replace(
            minute=0, second=0, microsecond=0
        )

        for i in range(self._HORIZON_HOURS):
            forecast_dt = forecast_start + timedelta(hours=i)
            weekday = forecast_dt.weekday()
            hour = forecast_dt.hour

            non_deferrable_band = non_deferrable_profile.forecast(weekday, hour)

            deferrable_list: list[dict[str, Any]] = []
            for consumer in consumers_config:
                eid = consumer["energy_entity_id"]
                consumer_band = consumer_profiles[eid].forecast(weekday, hour)
                deferrable_list.append({
                    "entityId": eid,
                    "label": consumer["label"],
                    **consumer_band.to_dict(),
                })

            series.append({
                "timestamp": forecast_dt.isoformat(),
                "nonDeferrable": non_deferrable_band.to_dict(),
                "deferrableConsumers": deferrable_list,
            })

        return self._make_payload(
            status="available",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            history_days=history_days,
            model=HOUSE_FORECAST_MODEL_ID,
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
    def _read_positive_int(raw_value: Any, default: int) -> int:
        if isinstance(raw_value, bool):
            return default
        if isinstance(raw_value, int) and raw_value > 0:
            return raw_value
        if isinstance(raw_value, float) and raw_value.is_integer() and raw_value > 0:
            return int(raw_value)
        return default

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
