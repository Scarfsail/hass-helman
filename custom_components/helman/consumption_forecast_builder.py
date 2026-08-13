from __future__ import annotations

import functools
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_CANONICAL_RESOLUTION,
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    HOUSE_FORECAST_DEFAULT_TRAINING_WINDOW_DAYS,
    HOUSE_FORECAST_MODEL_ID,
    MAX_FORECAST_DAYS,
)
from .consumption_forecast_profiles import (
    NEGATIVE_RESIDUAL_THRESHOLD,
    ZERO_BAND,
    HouseConsumptionProfile,
    HourOfWeekWinsorizedMeanProfile,
)
from .consumption_forecast_statistics import ForecastBand
from .controllables.config import read_deferrable_consumers
from .recorder_hourly_series import (
    TodaySlotEnergyReader,
    get_local_current_slot_start,
    get_today_completed_local_slots,
)

_LOGGER = logging.getLogger(__name__)


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
    def __init__(
        self,
        hass: HomeAssistant,
        config: dict,
        slot_history: TodaySlotEnergyReader,
    ) -> None:
        self._hass = hass
        self._config = config
        # Injected because a builder lives for one refresh: a cache of today's
        # slots is only worth anything to something that outlives it.
        self._slot_history = slot_history

    async def build(
        self,
        reference_time: datetime | None = None,
        *,
        profile: HouseConsumptionProfile | None,
        trained_at: str | None = None,
        last_outcome: str | None = None,
        forecast_days: int = MAX_FORECAST_DAYS,
    ) -> dict[str, Any]:
        """Assemble the payload from an already-fitted profile.

        Profile-driven on purpose: the multi-day fit belongs to the nightly
        training batch, and this runs four times an hour. Without a profile the
        answer is ``unavailable`` — never a fit here, which is the 56-day
        recorder scan this path exists to be rid of. The only queries left are
        today-scoped.
        """
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
        consumers_config = read_deferrable_consumers(self._config)
        config_fingerprint = self._build_config_fingerprint(
            total_energy_entity_id=total_energy_entity_id,
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            consumers_config=consumers_config,
        )
        local_now = dt_util.as_local(reference_time) if reference_time else dt_util.now()
        canonical_resolution = FORECAST_CANONICAL_RESOLUTION
        horizon_hours = forecast_days * 24

        if total_energy_entity_id is None or profile is None:
            return self._make_payload(
                status="not_configured"
                if total_energy_entity_id is None
                else "unavailable",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                config_fingerprint=config_fingerprint,
                resolution=canonical_resolution,
                horizon_hours=horizon_hours,
                source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
                forecast_days_available=forecast_days,
                trained_at=trained_at,
                last_outcome=last_outcome,
            )

        actual_history = await self._build_actual_history(
            total_energy_entity_id=total_energy_entity_id,
            consumers_config=consumers_config,
            reference_time=local_now,
        )

        # Assembling the forecast series across the whole horizon is pure CPU
        # with no I/O. Run it in the executor so it never blocks the event loop;
        # this build runs on every slot-aligned refresh.
        return await self._hass.async_add_executor_job(
            functools.partial(
                self.assemble,
                profile,
                actual_history=actual_history,
                consumers_config=consumers_config,
                local_now=local_now,
                forecast_days=forecast_days,
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                config_fingerprint=config_fingerprint,
                canonical_resolution=canonical_resolution,
                horizon_hours=horizon_hours,
                trained_at=trained_at,
                last_outcome=last_outcome,
            )
        )

    def assemble(
        self,
        profile: HouseConsumptionProfile,
        *,
        local_now: datetime,
        consumers_config: list[dict[str, Any]],
        actual_history: list[dict[str, Any]],
        forecast_days: int,
        training_window_days: int,
        min_history_days: int,
        config_fingerprint: str,
        canonical_resolution: Any,
        horizon_hours: int,
        trained_at: str | None = None,
        last_outcome: str | None = None,
    ) -> dict[str, Any]:
        """Assemble the forecast payload from an already-fitted profile.

        Pure CPU: runs in a worker thread via ``async_add_executor_job`` and
        MUST NOT touch ``self._hass`` or perform any I/O.
        """
        if profile.history_days < min_history_days:
            _LOGGER.warning(
                "House consumption forecast insufficient_history: "
                "%d days available, %d required",
                profile.history_days,
                min_history_days,
            )
            return self._make_payload(
                status="insufficient_history",
                training_window_days=training_window_days,
                min_history_days=min_history_days,
                history_days=profile.history_days,
                config_fingerprint=config_fingerprint,
                resolution=canonical_resolution,
                horizon_hours=horizon_hours,
                source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
                forecast_days_available=forecast_days,
                trained_at=trained_at,
                last_outcome=last_outcome,
            )

        # A consumer the profile never saw forecasts zero rather than raising:
        # the profile and the live config are supposed to agree -- a mismatch is
        # fingerprint-stale -- but a hard failure here would blank the whole
        # payload over one missing series. Say so once, not 672 times.
        missing_series = [
            consumer["energy_entity_id"]
            for consumer in consumers_config
            if consumer["energy_entity_id"] not in profile.consumers
        ]
        if missing_series:
            _LOGGER.warning(
                "House consumption profile has no series for %s; forecasting zero",
                ", ".join(missing_series),
            )

        current_slot_start = get_local_current_slot_start(
            local_now,
            interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
        )
        current_slot = self._build_forecast_entry(
            current_slot_start,
            non_deferrable_bands=profile.non_deferrable,
            consumers_config=consumers_config,
            consumer_bands=profile.consumers,
            interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
        )

        series = self._build_series(
            current_slot_start=current_slot_start,
            non_deferrable_bands=profile.non_deferrable,
            consumers_config=consumers_config,
            consumer_bands=profile.consumers,
            forecast_days=forecast_days,
        )

        return self._make_payload(
            status="available",
            training_window_days=training_window_days,
            min_history_days=min_history_days,
            history_days=profile.history_days,
            model=HOUSE_FORECAST_MODEL_ID,
            config_fingerprint=config_fingerprint,
            actual_history=actual_history,
            current_slot=current_slot,
            series=series,
            resolution=canonical_resolution,
            horizon_hours=horizon_hours,
            source_granularity_minutes=self._CANONICAL_GRANULARITY_MINUTES,
            forecast_days_available=forecast_days,
            trained_at=trained_at,
            last_outcome=last_outcome,
        )

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
            if non_deferrable < NEGATIVE_RESIDUAL_THRESHOLD:
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
        return await self._slot_history.async_query_slot_energy_changes(
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

    @staticmethod
    def _build_forecast_entry(
        forecast_dt: datetime,
        *,
        non_deferrable_bands: list[ForecastBand],
        consumers_config: list[dict[str, Any]],
        consumer_bands: dict[str, list[ForecastBand]],
        interval_minutes: int = 60,
    ) -> dict[str, Any]:
        slot = HourOfWeekWinsorizedMeanProfile.slot_index(
            forecast_dt.weekday(),
            forecast_dt.hour,
        )
        scale = interval_minutes / 60
        non_deferrable_band = ConsumptionForecastBuilder._scale_band(
            non_deferrable_bands[slot].to_dict(),
            scale=scale,
        )

        deferrable_list: list[dict[str, Any]] = []
        for consumer in consumers_config:
            eid = consumer["energy_entity_id"]
            bands = consumer_bands.get(eid)
            consumer_band = ConsumptionForecastBuilder._scale_band(
                (bands[slot] if bands is not None else ZERO_BAND).to_dict(),
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
        non_deferrable_bands: list[ForecastBand],
        consumers_config: list[dict[str, Any]],
        consumer_bands: dict[str, list[ForecastBand]],
        forecast_days: int,
    ) -> list[dict[str, Any]]:
        series: list[dict[str, Any]] = []
        slot_duration = timedelta(minutes=self._CANONICAL_GRANULARITY_MINUTES)
        forecast_start_utc = dt_util.as_utc(current_slot_start) + slot_duration
        total_slots = forecast_days * self._SLOTS_PER_DAY
        for index in range(total_slots):
            forecast_dt = dt_util.as_local(
                forecast_start_utc + (slot_duration * index)
            )
            series.append(
                self._build_forecast_entry(
                    forecast_dt,
                    non_deferrable_bands=non_deferrable_bands,
                    consumers_config=consumers_config,
                    consumer_bands=consumer_bands,
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
        history_days: int = 0,
        model: str | None = None,
        config_fingerprint: str | None = None,
        actual_history: list[dict[str, Any]] | None = None,
        current_slot: dict[str, Any] | None = None,
        series: list | None = None,
        trained_at: str | None = None,
        last_outcome: str | None = None,
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
            # When the profile behind this payload was fitted and how that fit
            # went. `build_house_forecast_response` copies unknown keys through
            # and `_has_matching_forecast_snapshot` does not compare them, so
            # both are additive.
            "trainedAt": trained_at,
            "lastOutcome": last_outcome,
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
