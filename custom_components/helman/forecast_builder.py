from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES
from .recorder_hourly_series import query_slot_energy_changes

_LOGGER = logging.getLogger(__name__)


class HelmanForecastBuilder:
    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self._hass = hass
        self._config = config
        self._local_tz = ZoneInfo(str(hass.config.time_zone))

    async def build(self, reference_time: datetime | None = None) -> dict[str, Any]:
        effective_reference_time = reference_time or datetime.now(self._local_tz)
        return {
            "solar": await self._build_solar_forecast(effective_reference_time),
            "grid": self._build_grid_forecast(),
        }

    async def _build_solar_forecast(self, reference_time: datetime) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        solar_config = self._read_dict(power_devices.get("solar"))
        solar_forecast = self._read_dict(solar_config.get("forecast"))

        daily_entity_ids = self._read_entity_id_list(
            solar_forecast.get("daily_energy_entity_ids")
        )[:8]

        if not daily_entity_ids:
            return {
                "status": "not_configured",
                "unit": None,
                "actualHistory": [],
                "points": [],
            }

        today = reference_time.astimezone(self._local_tz).date()
        points_with_sort_keys: list[tuple[datetime, dict[str, Any]]] = []
        entities_with_points = 0
        for index, entity_id in enumerate(daily_entity_ids):
            expected_date = today + timedelta(days=index)
            entity_points = self._extract_hourly_solar_points(entity_id, expected_date)
            if entity_points:
                entities_with_points += 1
            points_with_sort_keys.extend(entity_points)

        points_with_sort_keys.sort(key=lambda item: item[0])
        points = [point for _, point in points_with_sort_keys]
        unit = self._read_first_unit(daily_entity_ids)

        if entities_with_points == len(daily_entity_ids):
            status = "available"
        elif entities_with_points > 0:
            status = "partial"
            _LOGGER.warning(
                "Solar forecast partial: %d/%d daily energy entities have points",
                entities_with_points,
                len(daily_entity_ids),
            )
        else:
            status = "unavailable"
            _LOGGER.warning(
                "Solar forecast unavailable: none of %d daily energy entities "
                "have forecast points",
                len(daily_entity_ids),
            )

        remaining_today_entity_id = self._read_entity_id(
            self._read_dict(solar_config.get("entities")).get("remaining_today_energy_forecast")
        )
        actual_history = await self._build_solar_actual_history(
            reference_time,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )

        return {
            "status": status,
            "unit": unit,
            "remainingTodayEnergyEntityId": remaining_today_entity_id,
            "actualHistory": actual_history,
            "points": points,
        }

    async def _build_solar_actual_history(
        self,
        reference_time: datetime,
        *,
        interval_minutes: int = 60,
    ) -> list[dict[str, Any]]:
        entity_id = self._read_solar_actual_energy_entity_id()
        if entity_id is None:
            return []

        try:
            values_by_slot = await query_slot_energy_changes(
                self._hass,
                entity_id,
                reference_time,
                interval_minutes=interval_minutes,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build solar actual history for %s",
                entity_id,
            )
            return []

        return [
            {
                "timestamp": dt_util.as_local(slot_start).isoformat(),
                "value": round(value_kwh * 1000, 4),
            }
            for slot_start, value_kwh in sorted(values_by_slot.items())
        ]

    def _extract_hourly_solar_points(
        self, entity_id: str, expected_date: date
    ) -> list[tuple[datetime, dict[str, Any]]]:
        state = self._get_state(entity_id)
        if state is None:
            return []

        wh_period = state.attributes.get("wh_period")
        if not isinstance(wh_period, dict):
            return []

        points: list[tuple[datetime, dict[str, Any]]] = []
        for raw_key, raw_value in wh_period.items():
            value = self._parse_float(raw_value)
            if value is None:
                continue

            parsed_timestamp = self._parse_attribute_timestamp(raw_key)
            if parsed_timestamp is None:
                continue

            if parsed_timestamp.astimezone(self._local_tz).date() != expected_date:
                continue

            points.append(
                (
                    parsed_timestamp,
                    {
                        "timestamp": parsed_timestamp.isoformat(),
                        "value": value,
                    },
                )
            )

        return points

    def _build_grid_forecast(self) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        grid_config = self._read_dict(power_devices.get("grid"))
        grid_forecast = self._read_dict(grid_config.get("forecast"))

        sell_price_entity_id = self._read_entity_id(
            grid_forecast.get("sell_price_entity_id")
        )
        if sell_price_entity_id is None:
            return {
                "status": "not_configured",
                "unit": None,
                "currentSellPrice": None,
                "points": [],
            }

        state = self._get_state(sell_price_entity_id)
        current_sell_price = self._parse_float(state.state) if state else None
        unit = (
            self._read_unit_from_state(state)
            if state is not None
            else None
        )

        points_with_sort_keys: list[tuple[datetime, dict[str, Any]]] = []
        if state is not None:
            for key, raw_value in state.attributes.items():
                parsed_timestamp = self._parse_attribute_timestamp(key)
                if parsed_timestamp is None:
                    continue

                value = self._parse_float(raw_value)
                if value is None:
                    continue

                points_with_sort_keys.append(
                    (
                        parsed_timestamp,
                        {
                            "timestamp": parsed_timestamp.isoformat(),
                            "value": value,
                        },
                    )
                )

        points_with_sort_keys.sort(key=lambda item: item[0])
        points = [point for _, point in points_with_sort_keys]

        if current_sell_price is not None and points:
            status = "available"
        elif current_sell_price is not None or points:
            status = "partial"
            _LOGGER.warning(
                "Grid forecast partial: current_sell_price=%s, points_count=%d",
                current_sell_price,
                len(points),
            )
        else:
            status = "unavailable"
            _LOGGER.warning(
                "Grid forecast unavailable: no sell price and no forecast points "
                "for %s",
                sell_price_entity_id,
            )

        return {
            "status": status,
            "unit": unit,
            "currentSellPrice": current_sell_price,
            "points": points,
        }

    def _get_state(self, entity_id: str | None):
        if entity_id is None:
            return None
        return self._hass.states.get(entity_id)

    def _read_entity_state_float(self, entity_id: str | None) -> float | None:
        state = self._get_state(entity_id)
        if state is None:
            return None
        return self._parse_float(state.state)

    @staticmethod
    def _parse_float(raw_value: Any) -> float | None:
        if isinstance(raw_value, bool) or raw_value is None:
            return None

        if isinstance(raw_value, (int, float)):
            return float(raw_value)

        if isinstance(raw_value, str):
            stripped = raw_value.strip()
            if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
                return None

            try:
                return float(stripped)
            except ValueError:
                return None

        return None

    @staticmethod
    def _read_entity_id(raw_value: Any) -> str | None:
        if isinstance(raw_value, str) and raw_value.strip():
            return raw_value.strip()
        return None

    @staticmethod
    def _read_dict(raw_value: Any) -> dict[str, Any]:
        if isinstance(raw_value, dict):
            return raw_value
        return {}

    def _read_entity_id_list(self, raw_value: Any) -> list[str]:
        if not isinstance(raw_value, list):
            return []

        entity_ids: list[str] = []
        for item in raw_value:
            entity_id = self._read_entity_id(item)
            if entity_id is not None:
                entity_ids.append(entity_id)
        return entity_ids

    def _read_first_unit(self, entity_ids: list[str | None]) -> str | None:
        for entity_id in entity_ids:
            state = self._get_state(entity_id)
            unit = self._read_unit_from_state(state)
            if unit is not None:
                return unit
        return None

    def _read_solar_actual_energy_entity_id(self) -> str | None:
        power_devices = self._read_dict(self._config.get("power_devices"))
        solar_config = self._read_dict(power_devices.get("solar"))
        forecast_config = self._read_dict(solar_config.get("forecast"))
        entities = self._read_dict(solar_config.get("entities"))

        return (
            self._read_entity_id(forecast_config.get("total_energy_entity_id"))
            or self._read_entity_id(entities.get("today_energy"))
        )

    @staticmethod
    def _read_unit_from_state(state) -> str | None:
        if state is None:
            return None

        unit = state.attributes.get("unit_of_measurement")
        if isinstance(unit, str) and unit:
            return unit
        return None

    def _parse_attribute_timestamp(self, raw_key: Any) -> datetime | None:
        if not isinstance(raw_key, str):
            return None

        try:
            parsed = datetime.fromisoformat(raw_key.replace("Z", "+00:00"))
        except ValueError:
            return None

        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=self._local_tz)

        return parsed
