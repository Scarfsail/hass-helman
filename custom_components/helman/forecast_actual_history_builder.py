from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant

from .battery_state import read_battery_entity_config
from .consumption_forecast_builder import (
    ConsumptionForecastBuilder,
    _NEGATIVE_RESIDUAL_THRESHOLD,
)
from .recorder_hourly_series import (
    get_today_completed_local_hours,
    query_hour_boundary_state_values,
    query_hourly_energy_changes,
)

_LOGGER = logging.getLogger(__name__)


class ForecastActualHistoryBuilder:
    def __init__(self, hass: HomeAssistant, config: dict[str, Any]) -> None:
        self._hass = hass
        self._config = config

    async def build(self, reference_time: datetime) -> dict[str, list[dict[str, Any]]]:
        return {
            "solar": await self._build_solar_actual_history(reference_time),
            "house_consumption": await self._build_house_actual_history(reference_time),
            "battery_capacity": await self._build_battery_actual_history(reference_time),
        }

    async def _build_solar_actual_history(
        self, reference_time: datetime
    ) -> list[dict[str, Any]]:
        entity_id = self._read_solar_actual_energy_entity_id()
        if entity_id is None:
            return []

        try:
            values_by_hour = await query_hourly_energy_changes(
                self._hass,
                entity_id,
                reference_time,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build solar actual history for %s",
                entity_id,
            )
            return []

        return [
            {
                "timestamp": hour_start.isoformat(),
                "value": round(value_kwh * 1000, 4),
            }
            for hour_start, value_kwh in values_by_hour.items()
        ]

    async def _build_house_actual_history(
        self, reference_time: datetime
    ) -> list[dict[str, Any]]:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._config.get("power_devices")
        )
        house_config = ConsumptionForecastBuilder._read_dict(power_devices.get("house"))
        forecast_config = ConsumptionForecastBuilder._read_dict(house_config.get("forecast"))
        total_energy_entity_id = ConsumptionForecastBuilder._read_entity_id(
            forecast_config.get("total_energy_entity_id")
        )
        if total_energy_entity_id is None:
            return []

        try:
            house_by_hour = await query_hourly_energy_changes(
                self._hass,
                total_energy_entity_id,
                reference_time,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build house actual history for %s",
                total_energy_entity_id,
            )
            return []

        consumers_config = ConsumptionForecastBuilder._read_deferrable_consumers(
            forecast_config.get("deferrable_consumers")
        )
        consumers_by_hour: dict[str, dict[datetime, float]] = {}
        for consumer in consumers_config:
            entity_id = consumer["energy_entity_id"]
            try:
                consumers_by_hour[entity_id] = await query_hourly_energy_changes(
                    self._hass,
                    entity_id,
                    reference_time,
                )
            except Exception:
                _LOGGER.warning(
                    "Failed to build actual history for deferrable consumer %s",
                    entity_id,
                )
                consumers_by_hour[entity_id] = {}

        actual_history: list[dict[str, Any]] = []
        for hour_start in get_today_completed_local_hours(reference_time):
            house_total = house_by_hour.get(hour_start)
            if house_total is None:
                continue

            deferrable_consumers: list[dict[str, Any]] = []
            deferrable_sum = 0.0
            for consumer in consumers_config:
                entity_id = consumer["energy_entity_id"]
                value = max(
                    0.0,
                    consumers_by_hour.get(entity_id, {}).get(hour_start, 0.0),
                )
                deferrable_sum += value
                deferrable_consumers.append(
                    {
                        "entityId": entity_id,
                        "label": consumer["label"],
                        "value": round(value, 4),
                    }
                )

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

    async def _build_battery_actual_history(
        self, reference_time: datetime
    ) -> list[dict[str, Any]]:
        entity_config = read_battery_entity_config(self._config)
        if entity_config is None:
            return []

        try:
            boundary_samples = await query_hour_boundary_state_values(
                self._hass,
                entity_config.capacity_entity_id,
                reference_time,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build battery actual history for %s",
                entity_config.capacity_entity_id,
            )
            return []

        actual_history: list[dict[str, Any]] = []
        for hour_start in get_today_completed_local_hours(reference_time):
            end_hour = hour_start + timedelta(hours=1)
            start_soc = boundary_samples.get(hour_start)
            end_soc = boundary_samples.get(end_hour)
            if not _is_valid_soc(start_soc) or not _is_valid_soc(end_soc):
                continue

            actual_history.append(
                {
                    "timestamp": hour_start.isoformat(),
                    "startSocPct": round(start_soc, 2),
                    "socPct": round(end_soc, 2),
                }
            )

        return actual_history

    def _read_solar_actual_energy_entity_id(self) -> str | None:
        power_devices = ConsumptionForecastBuilder._read_dict(
            self._config.get("power_devices")
        )
        solar_config = ConsumptionForecastBuilder._read_dict(power_devices.get("solar"))
        forecast_config = ConsumptionForecastBuilder._read_dict(
            solar_config.get("forecast")
        )
        entities = ConsumptionForecastBuilder._read_dict(solar_config.get("entities"))

        return (
            ConsumptionForecastBuilder._read_entity_id(
                forecast_config.get("total_energy_entity_id")
            )
            or ConsumptionForecastBuilder._read_entity_id(entities.get("today_energy"))
        )


def _is_valid_soc(value: float | None) -> bool:
    return value is not None and 0 <= value <= 100
