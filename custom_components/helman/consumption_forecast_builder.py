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
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_GRANULARITY_OPTIONS,
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
)
from .consumption_forecast_profiles import HourOfWeekWinsorizedMeanProfile
from .forecast_aggregation import get_forecast_resolution
from .recorder_hourly_series import (
    get_local_current_slot_start,
    get_today_completed_local_hours,
    get_today_completed_local_slots,
    query_cumulative_hourly_energy_changes,
    query_slot_energy_changes,
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


@dataclass(frozen=True)
class _ConsumerSlotHistoryData:
    entity_id: str
    label: str
    values_by_slot: dict[datetime, float]
    query_succeeded: bool


class ConsumptionForecastBuilder:
    """Builds the house_consumption forecast payload."""

    _CANONICAL_GRANULARITY_MINUTES = FORECAST_CANONICAL_GRANULARITY_MINUTES
    _SLOTS_PER_HOUR = 60 // _CANONICAL_GRANULARITY_MINUTES
    _SLOTS_PER_DAY = 24 * _SLOTS_PER_HOUR
    _MAX_ALIGNMENT_PADDING_SLOTS = (
        max(FORECAST_GRANULARITY_OPTIONS) // _CANONICAL_GRANULARITY_MINUTES
    ) - 1

    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config

    async def build(
        self,
        reference_time: datetime | None = None,
        *,
        forecast_days: int = MAX_FORECAST_DAYS,
        padding_slots: int = 0,
    ) -> dict[str, Any]:
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
        canonical_resolution = get_forecast_resolution(
            self._CANONICAL_GRANULARITY_MINUTES
        )
        horizon_hours = forecast_days * 24
        alignment_padding_slots = max(0, padding_slots)

        if total_energy_entity_id is None:
            return self._make_payload(
                status="not_configured",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                config_fingerprint=config_fingerprint,
                resolution=canonical_resolution,
                horizon_hours=horizon_hours,
                source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
                forecast_days_available=forecast_days,
                alignment_padding_slots=alignment_padding_slots,
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
                resolution=canonical_resolution,
                horizon_hours=horizon_hours,
                source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
                forecast_days_available=forecast_days,
                alignment_padding_slots=alignment_padding_slots,
            )

        history_days = self._compute_history_days(
            house_rows,
            today_local=local_now.date(),
        )

        if history_days < min_history_days:
            _LOGGER.warning(
                "House consumption forecast insufficient_history: "
                "%d days available, %d required",
                history_days,
                min_history_days,
            )
            return self._make_payload(
                status="insufficient_history",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                history_days=history_days,
                config_fingerprint=config_fingerprint,
                resolution=canonical_resolution,
                horizon_hours=horizon_hours,
                source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
                forecast_days_available=forecast_days,
                alignment_padding_slots=alignment_padding_slots,
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

        current_slot_start = get_local_current_slot_start(
            local_now,
            interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
        )
        current_slot = self._build_forecast_entry(
            current_slot_start,
            non_deferrable_profile=non_deferrable_profile,
            consumers_config=consumers_config,
            consumer_profiles=consumer_profiles,
            interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
        )

        series = self._build_series(
            current_slot_start=current_slot_start,
            non_deferrable_profile=non_deferrable_profile,
            consumers_config=consumers_config,
            consumer_profiles=consumer_profiles,
            forecast_days=forecast_days,
            padding_slots=alignment_padding_slots,
        )

        actual_history = await self._build_actual_history(
            total_energy_entity_id=total_energy_entity_id,
            consumers_config=consumers_config,
            reference_time=local_now,
        )

        return self._make_payload(
            status="available",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            history_days=history_days,
            model=HOUSE_FORECAST_MODEL_ID,
            config_fingerprint=config_fingerprint,
            actual_history=actual_history,
            current_slot=current_slot,
            series=series,
            resolution=canonical_resolution,
            horizon_hours=horizon_hours,
            source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
            forecast_days_available=forecast_days,
            alignment_padding_slots=alignment_padding_slots,
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

    async def _build_actual_history(
        self,
        *,
        total_energy_entity_id: str,
        consumers_config: list[dict[str, Any]],
        reference_time: datetime,
    ) -> list[dict[str, Any]]:
        try:
            house_by_slot = await self._query_slot_history(
                total_energy_entity_id,
                reference_time=reference_time,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to query Recorder slot history for %s",
                total_energy_entity_id,
            )
            return []

        consumers = await self._query_consumer_slot_histories(
            consumers_config,
            reference_time=reference_time,
        )
        return self._build_slot_actual_history(
            house_by_slot=house_by_slot,
            consumers=consumers,
            completed_slots=get_today_completed_local_slots(
                reference_time,
                interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
            ),
        )

    def _build_slot_actual_history(
        self,
        *,
        house_by_slot: dict[datetime, float],
        consumers: list[_ConsumerSlotHistoryData],
        completed_slots: list[datetime],
    ) -> list[dict[str, Any]]:
        actual_history: list[dict[str, Any]] = []
        for slot_start in completed_slots:
            timestamp_key = dt_util.as_utc(slot_start)
            house_total = house_by_slot.get(timestamp_key)
            if house_total is None:
                continue

            deferrable_consumers: list[dict[str, Any]] = []
            deferrable_sum = 0.0
            skip_hour = False
            for consumer in consumers:
                if not consumer.query_succeeded:
                    skip_hour = True
                    break

                value = consumer.values_by_slot.get(timestamp_key)
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
                    "timestamp": slot_start.isoformat(),
                    "nonDeferrable": {
                        "value": round(max(0.0, non_deferrable), 4),
                    },
                    "deferrableConsumers": deferrable_consumers,
                }
            )

        return actual_history

    async def _query_slot_history(
        self,
        entity_id: str,
        *,
        reference_time: datetime,
    ) -> dict[datetime, float]:
        return await query_slot_energy_changes(
            self._hass,
            entity_id,
            reference_time,
            interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
        )

    async def _query_consumer_slot_histories(
        self,
        consumers_config: list[dict[str, Any]],
        *,
        reference_time: datetime,
    ) -> list[_ConsumerSlotHistoryData]:
        consumer_histories: list[_ConsumerSlotHistoryData] = []
        for consumer in consumers_config:
            entity_id = consumer["energy_entity_id"]
            try:
                values_by_slot = await self._query_slot_history(
                    entity_id,
                    reference_time=reference_time,
                )
            except Exception:
                _LOGGER.warning(
                    "Failed to query slot history for deferrable consumer %s, using empty",
                    entity_id,
                )
                consumer_histories.append(
                    _ConsumerSlotHistoryData(
                        entity_id=entity_id,
                        label=consumer["label"],
                        values_by_slot={},
                        query_succeeded=False,
                    )
                )
                continue

            consumer_histories.append(
                _ConsumerSlotHistoryData(
                    entity_id=entity_id,
                    label=consumer["label"],
                    values_by_slot=values_by_slot,
                    query_succeeded=True,
                )
            )

        return consumer_histories

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
        interval_minutes: int = 60,
    ) -> dict[str, Any]:
        weekday = forecast_dt.weekday()
        hour = forecast_dt.hour
        scale = interval_minutes / 60
        non_deferrable_band = ConsumptionForecastBuilder._scale_band(
            non_deferrable_profile.forecast(weekday, hour).to_dict(),
            scale=scale,
        )

        deferrable_list: list[dict[str, Any]] = []
        for consumer in consumers_config:
            eid = consumer["energy_entity_id"]
            consumer_band = ConsumptionForecastBuilder._scale_band(
                consumer_profiles[eid].forecast(weekday, hour).to_dict(),
                scale=scale,
            )
            deferrable_list.append({
                "entityId": eid,
                "label": consumer["label"],
                **consumer_band,
            })

        return {
            "timestamp": forecast_dt.isoformat(),
            "nonDeferrable": non_deferrable_band,
            "deferrableConsumers": deferrable_list,
        }

    def _build_series(
        self,
        *,
        current_slot_start: datetime,
        non_deferrable_profile: HourOfWeekWinsorizedMeanProfile,
        consumers_config: list[dict[str, Any]],
        consumer_profiles: dict[str, HourOfWeekWinsorizedMeanProfile],
        forecast_days: int,
        padding_slots: int,
    ) -> list[dict[str, Any]]:
        series: list[dict[str, Any]] = []
        slot_duration = timedelta(minutes=self._CANONICAL_GRANULARITY_MINUTES)
        forecast_start_utc = dt_util.as_utc(current_slot_start) + slot_duration
        total_slots = (forecast_days * self._SLOTS_PER_DAY) + max(0, padding_slots)
        for index in range(total_slots):
            forecast_dt = dt_util.as_local(
                forecast_start_utc + (slot_duration * index)
            )
            series.append(
                self._build_forecast_entry(
                    forecast_dt,
                    non_deferrable_profile=non_deferrable_profile,
                    consumers_config=consumers_config,
                    consumer_profiles=consumer_profiles,
                    interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
                )
            )
        return series

    @staticmethod
    def _make_payload(
        *,
        status: str,
        training_window_days: int,
        min_history_days: int,
        resolution: str,
        horizon_hours: int,
        source_granularity_minutes: int,
        forecast_days_available: int,
        alignment_padding_slots: int = 0,
        history_days: int = 0,
        model: str | None = None,
        config_fingerprint: str | None = None,
        actual_history: list[dict[str, Any]] | None = None,
        current_slot: dict[str, Any] | None = None,
        series: list | None = None,
    ) -> dict[str, Any]:
        payload = {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "unit": "kWh",
            "resolution": resolution,
            "horizonHours": horizon_hours,
            "trainingWindowDays": training_window_days,
            "historyDaysAvailable": history_days,
            "requiredHistoryDays": min_history_days,
            "model": model,
            "configFingerprint": config_fingerprint,
            "actualHistory": actual_history if actual_history is not None else [],
            "series": series if series is not None else [],
            "sourceGranularityMinutes": source_granularity_minutes,
            "forecastDaysAvailable": forecast_days_available,
            "alignmentPaddingSlots": alignment_padding_slots,
        }
        if current_slot is not None:
            payload["currentSlot"] = current_slot
        return payload

    @staticmethod
    def _scale_band(
        band: dict[str, Any],
        *,
        scale: float,
    ) -> dict[str, Any]:
        return {
            key: round(float(value) * scale, 4)
            for key, value in band.items()
            if isinstance(value, (int, float))
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
