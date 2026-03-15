from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import (
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
)
from .consumption_forecast_profiles import HourOfWeekWinsorizedMeanProfile
from .recorder_hourly_series import (
    get_today_completed_local_hours,
    query_cumulative_hourly_energy_changes,
)

_LOGGER = logging.getLogger(__name__)

# Threshold for "materially negative" residual (kWh).
# Tiny negatives (>= threshold) are clamped to 0; values below are dropped.
_NEGATIVE_RESIDUAL_THRESHOLD = -0.01


@dataclass(frozen=True)
class _ConsumerHistoryData:
    entity_id: str
    label: str
    values_by_ts: dict[int, float]
    query_succeeded: bool


class ConsumptionForecastBuilder:
    """Builds the house_consumption forecast payload."""

    _HORIZON_HOURS = 168

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def build(self, reference_time: datetime | None = None) -> dict[str, Any]:
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
        consumers_config = self._read_deferrable_consumers(
            forecast_config.get("deferrable_consumers")
        )
        config_fingerprint = self._build_config_fingerprint(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            consumers_config=consumers_config,
        )
        local_now = dt_util.as_local(reference_time) if reference_time else dt_util.now()

        if total_energy_entity_id is None:
            return self._make_payload(
                status="not_configured",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                config_fingerprint=config_fingerprint,
            )

        # Query house total hourly history
        try:
            house_rows = await self._query_hourly_history(
                total_energy_entity_id,
                training_window_days,
                reference_time=local_now,
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
                config_fingerprint=config_fingerprint,
            )

        history_days = self._compute_history_days(
            house_rows,
            today_local=local_now.date(),
        )

        if history_days < min_history_days:
            return self._make_payload(
                status="insufficient_history",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                history_days=history_days,
                config_fingerprint=config_fingerprint,
            )

        consumer_histories = await self._query_consumer_histories(
            consumers_config,
            training_window_days,
            reference_time=local_now,
        )

        house_by_ts = self._rows_to_dict(house_rows)
        (
            non_deferrable_profile,
            consumer_profiles,
        ) = self._build_profiles(
            house_by_ts,
            consumer_histories,
        )

        current_hour = self._build_forecast_entry(
            local_now.replace(minute=0, second=0, microsecond=0),
            non_deferrable_profile=non_deferrable_profile,
            consumers_config=consumers_config,
            consumer_profiles=consumer_profiles,
        )

        # Generate forecast series starting from the next full hour
        series: list[dict[str, Any]] = []
        forecast_start = (local_now + timedelta(hours=1)).replace(
            minute=0, second=0, microsecond=0
        )

        for i in range(self._HORIZON_HOURS):
            forecast_dt = forecast_start + timedelta(hours=i)
            series.append(
                self._build_forecast_entry(
                    forecast_dt,
                    non_deferrable_profile=non_deferrable_profile,
                    consumers_config=consumers_config,
                    consumer_profiles=consumer_profiles,
                )
            )

        actual_history = self._build_actual_history(
            house_by_ts=house_by_ts,
            consumers=consumer_histories,
            completed_hours=get_today_completed_local_hours(local_now),
        )

        return self._make_payload(
            status="available",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            history_days=history_days,
            model=HOUSE_FORECAST_MODEL_ID,
            config_fingerprint=config_fingerprint,
            actual_history=actual_history,
            current_hour=current_hour,
            series=series,
        )

    async def _query_consumer_histories(
        self,
        consumers_config: list[dict[str, Any]],
        training_window_days: int,
        *,
        reference_time: datetime,
    ) -> list[_ConsumerHistoryData]:
        consumer_histories: list[_ConsumerHistoryData] = []
        for consumer in consumers_config:
            entity_id = consumer["energy_entity_id"]
            try:
                rows = await self._query_hourly_history(
                    entity_id,
                    training_window_days,
                    reference_time=reference_time,
                )
            except Exception:
                _LOGGER.warning(
                    "Failed to query history for deferrable consumer %s, using empty",
                    entity_id,
                )
                consumer_histories.append(
                    _ConsumerHistoryData(
                        entity_id=entity_id,
                        label=consumer["label"],
                        values_by_ts={},
                        query_succeeded=False,
                    )
                )
                continue

            consumer_histories.append(
                _ConsumerHistoryData(
                    entity_id=entity_id,
                    label=consumer["label"],
                    values_by_ts=self._rows_to_dict(rows),
                    query_succeeded=True,
                )
            )

        return consumer_histories

    def _build_profiles(
        self,
        house_by_ts: dict[int, float],
        consumers: list[_ConsumerHistoryData],
    ) -> tuple[
        HourOfWeekWinsorizedMeanProfile,
        dict[str, HourOfWeekWinsorizedMeanProfile],
    ]:
        non_deferrable_profile = HourOfWeekWinsorizedMeanProfile()
        consumer_profiles: dict[str, HourOfWeekWinsorizedMeanProfile] = {
            consumer.entity_id: HourOfWeekWinsorizedMeanProfile()
            for consumer in consumers
        }

        for ts, house_value in house_by_ts.items():
            local_dt = dt_util.as_local(dt_util.utc_from_timestamp(ts))
            weekday = local_dt.weekday()
            hour = local_dt.hour
            deferrable_sum = sum(
                consumer.values_by_ts.get(ts, 0.0) for consumer in consumers
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
            for consumer in consumers:
                consumer_profiles[consumer.entity_id].add(
                    weekday,
                    hour,
                    max(0.0, consumer.values_by_ts.get(ts, 0.0)),
                )

        return non_deferrable_profile, consumer_profiles

    def _build_actual_history(
        self,
        *,
        house_by_ts: dict[int, float],
        consumers: list[_ConsumerHistoryData],
        completed_hours: list[datetime],
    ) -> list[dict[str, Any]]:
        actual_history: list[dict[str, Any]] = []
        for hour_start in completed_hours:
            timestamp_key = int(dt_util.as_utc(hour_start).timestamp())
            house_total = house_by_ts.get(timestamp_key)
            if house_total is None:
                continue

            deferrable_consumers: list[dict[str, Any]] = []
            deferrable_sum = 0.0
            skip_hour = False
            for consumer in consumers:
                if not consumer.query_succeeded:
                    skip_hour = True
                    break

                value = consumer.values_by_ts.get(timestamp_key)
                if value is None:
                    skip_hour = True
                    break

                normalized_value = max(0.0, value)
                deferrable_sum += normalized_value
                deferrable_consumers.append(
                    {
                        "entityId": consumer.entity_id,
                        "label": consumer.label,
                        "value": round(normalized_value, 4),
                    }
                )

            if skip_hour:
                continue

            non_deferrable = house_total - deferrable_sum
            if non_deferrable < _NEGATIVE_RESIDUAL_THRESHOLD:
                continue

            actual_history.append(
                {
                    "timestamp": hour_start.isoformat(),
                    "nonDeferrable": {
                        "value": round(max(0.0, non_deferrable), 4),
                    },
                    "deferrableConsumers": deferrable_consumers,
                }
            )

        return actual_history

    async def _query_hourly_history(
        self,
        entity_id: str,
        training_window_days: int,
        *,
        reference_time: datetime,
    ) -> list[dict]:
        """Query Recorder-backed hourly cumulative deltas and return raw rows."""
        local_current_hour = reference_time.replace(
            minute=0,
            second=0,
            microsecond=0,
        )
        local_midnight = local_current_hour.replace(hour=0)
        values_by_hour = await query_cumulative_hourly_energy_changes(
            self._hass,
            entity_id,
            local_start=local_midnight - timedelta(days=training_window_days),
            local_end=local_current_hour,
        )
        return [
            {
                "start": hour_start.timestamp(),
                "change": change,
            }
            for hour_start, change in sorted(values_by_hour.items())
        ]

    @staticmethod
    def _compute_history_days(
        rows: list[dict],
        *,
        today_local: date,
    ) -> int:
        """Compute number of days of history from Recorder rows."""
        if not rows:
            return 0
        oldest_ts = min(row["start"] for row in rows)
        oldest_local = dt_util.as_local(dt_util.utc_from_timestamp(oldest_ts))
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
    def _build_forecast_entry(
        forecast_dt: datetime,
        *,
        non_deferrable_profile: HourOfWeekWinsorizedMeanProfile,
        consumers_config: list[dict[str, Any]],
        consumer_profiles: dict[str, HourOfWeekWinsorizedMeanProfile],
    ) -> dict[str, Any]:
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

        return {
            "timestamp": forecast_dt.isoformat(),
            "nonDeferrable": non_deferrable_band.to_dict(),
            "deferrableConsumers": deferrable_list,
        }

    @staticmethod
    def _make_payload(
        *,
        status: str,
        training_window_days: int,
        min_history_days: int,
        history_days: int = 0,
        model: str | None = None,
        config_fingerprint: str | None = None,
        actual_history: list[dict[str, Any]] | None = None,
        current_hour: dict[str, Any] | None = None,
        series: list | None = None,
    ) -> dict[str, Any]:
        payload = {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "unit": "kWh",
            "resolution": "hour",
            "horizonHours": 168,
            "trainingWindowDays": training_window_days,
            "historyDaysAvailable": history_days,
            "requiredHistoryDays": min_history_days,
            "model": model,
            "configFingerprint": config_fingerprint,
            "actualHistory": actual_history if actual_history is not None else [],
            "series": series if series is not None else [],
        }
        if current_hour is not None:
            payload["currentHour"] = current_hour
        return payload

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

    @staticmethod
    def _build_config_fingerprint(
        *,
        total_energy_entity_id: str | None,
        training_window_days: int,
        min_history_days: int,
        consumers_config: list[dict[str, Any]],
    ) -> str:
        fingerprint_payload = {
            "total_energy_entity_id": total_energy_entity_id,
            "training_window_days": training_window_days,
            "min_history_days": min_history_days,
            "model": HOUSE_FORECAST_MODEL_ID,
            "deferrable_consumers": sorted(
                [
                    {
                        "energy_entity_id": consumer["energy_entity_id"],
                        "label": consumer["label"],
                    }
                    for consumer in consumers_config
                ],
                key=lambda consumer: consumer["energy_entity_id"],
            ),
        }
        serialized = json.dumps(
            fingerprint_payload,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
