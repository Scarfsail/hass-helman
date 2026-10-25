from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .config_read import read_entity_id, read_float, read_mapping
from .const import (
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID,
)
from .forecast_response import parse_ts
from .today_slot_readers import TodaySlotEnergyReader
from .slot_grid import (
    SLOT_MINUTES,
    SLOTS_PER_DAY,
    SLOTS_PER_HOUR,
    day_slots,
    split_hour_by_weights,
)

_LOGGER = logging.getLogger(__name__)


def solar_slot_map(solar_forecast: dict[str, Any]) -> dict[datetime, float]:
    """Map canonical solar points onto {local slot start datetime: value in Wh}."""
    points = solar_forecast.get("points")
    if not isinstance(points, list):
        return {}

    by_slot: dict[datetime, float] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = parse_ts(point.get("timestamp"))
        value = read_float(point.get("value"))
        if timestamp is None or value is None:
            continue
        slot_start = dt_util.as_local(timestamp)
        by_slot[slot_start] = by_slot.get(slot_start, 0.0) + value

    return by_slot


class SolarForecastBuilder:
    def __init__(
        self,
        hass: HomeAssistant,
        config: dict,
        slot_history: TodaySlotEnergyReader,
        *,
        export_price_snapshot: dict[str, Any] | None = None,
    ) -> None:
        self._hass = hass
        self._config = config
        self._slot_history = slot_history
        tz_name = getattr(getattr(hass, "config", None), "time_zone", None) or "UTC"
        self._local_tz = ZoneInfo(str(tz_name))

    async def build(self, reference_time: datetime | None = None) -> dict[str, Any]:
        effective_reference_time = reference_time or datetime.now(self._local_tz)
        return await self._build_solar_forecast(effective_reference_time)

    async def _build_solar_forecast(self, reference_time: datetime) -> dict[str, Any]:
        daily_entity_ids = read_solar_forecast_entities(self._config)[:8]

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
            entity_points = self._extract_solar_points(entity_id, expected_date)
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

        actual_history = await self._build_solar_actual_history(
            reference_time,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )

        return {
            "status": status,
            "unit": unit,
            "remainingTodayEnergyEntityId": SOLAR_REMAINING_TODAY_ENERGY_ENTITY_ID,
            "actualHistory": actual_history,
            "points": points,
        }

    async def _build_solar_actual_history(
        self,
        reference_time: datetime,
        *,
        interval_minutes: int,
    ) -> list[dict[str, Any]]:
        entity_id = self._read_solar_actual_energy_entity_id()
        if entity_id is None:
            return []

        try:
            values_by_slot = await self._slot_history.async_query_slot_energy_changes(
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

    def _extract_solar_points(
        self, entity_id: str, expected_date: date
    ) -> list[tuple[datetime, dict[str, Any]]]:
        state = self._get_state(entity_id)
        if state is None:
            return []

        values = self._read_canonical_solar_values(state)
        if not values:
            return []

        expected_slots = self._build_local_slots_for_date(expected_date)
        if not expected_slots:
            return []

        # The values are anchored positionally from local midnight, so a short
        # or long series silently shifts or truncates the whole curve. A DST
        # transition day with a normal 24-hour (SLOTS_PER_DAY) source is
        # normalized onto the local wall-clock slot axis below.
        if len(values) not in (len(expected_slots), SLOTS_PER_DAY):
            _LOGGER.warning(
                "Solar forecast for %s on %s has %d values for %d slots; "
                "anchoring from local midnight will %s",
                entity_id,
                expected_date,
                len(values),
                len(expected_slots),
                "truncate it"
                if len(values) > len(expected_slots)
                else "leave the end of the day uncovered",
            )

        points: list[tuple[datetime, dict[str, Any]]] = []
        if len(values) == SLOTS_PER_DAY and len(expected_slots) != SLOTS_PER_DAY:
            for slot_start in expected_slots:
                if slot_start.fold == 1:
                    value = 0.0
                else:
                    slot_index = (
                        slot_start.hour * 60 + slot_start.minute
                    ) // SLOT_MINUTES
                    value = values[slot_index]
                points.append(
                    (
                        slot_start,
                        {
                            "timestamp": slot_start.isoformat(),
                            "value": value,
                        },
                    )
                )
        else:
            for slot_start, value in zip(expected_slots, values):
                points.append(
                    (
                        slot_start,
                        {
                            "timestamp": slot_start.isoformat(),
                            "value": value,
                        },
                    )
                )

        return points

    def _read_canonical_solar_values(self, state) -> list[float]:
        """Return the day's Wh values on the canonical grid, in chronological order.

        Prefers the source's own 15-minute series. When only the hourly series
        is published, each hour is split across its four slots using the
        upstream ``watts`` samples, so the intra-hour shape survives.

        Values are returned positionally rather than keyed by their source
        timestamps: those offsets go stale across a DST change and would shift a
        whole day by an hour (see ``b62ac2d``). ``_extract_solar_points``
        re-anchors them onto the expected local axis instead.
        """
        attributes = getattr(state, "attributes", {})
        if not isinstance(attributes, dict):
            return []

        quarter_hourly = self._read_sorted_series(attributes.get("wh_period_15m"))
        if quarter_hourly:
            return quarter_hourly

        hourly = self._read_sorted_series(attributes.get("wh_period"))
        if not hourly:
            return []

        watts = self._read_sorted_series(attributes.get("watts"))
        return self._expand_hourly_values(hourly, watts)

    def _read_sorted_series(self, raw_series: Any) -> list[float]:
        """Parse a ``{timestamp: value}`` attribute into values ordered by time."""
        if not isinstance(raw_series, dict):
            return []

        parsed: list[tuple[datetime, float]] = []
        for raw_key, raw_value in raw_series.items():
            value = self._parse_float(raw_value)
            if value is None:
                continue

            parsed_timestamp = self._parse_attribute_timestamp(raw_key)
            if parsed_timestamp is None:
                continue

            parsed.append((parsed_timestamp, value))

        parsed.sort(key=lambda item: dt_util.as_utc(item[0]))
        return [value for _, value in parsed]

    @staticmethod
    def _expand_hourly_values(hourly: list[float], watts: list[float]) -> list[float]:
        """Expand hourly Wh onto the canonical grid, weighted by ``watts``.

        ``watts`` is consumed positionally, four samples per hour, for the same
        reason the values themselves are. An hour without a full set of samples
        falls back to an even split, which ``split_hour_by_weights`` produces
        from all-zero weights.
        """
        expanded: list[float] = []
        for index, hour_wh in enumerate(hourly):
            start = index * SLOTS_PER_HOUR
            sub_weights = watts[start : start + SLOTS_PER_HOUR]
            if len(sub_weights) != SLOTS_PER_HOUR:
                sub_weights = [0.0] * SLOTS_PER_HOUR
            expanded.extend(split_hour_by_weights(hour_wh, sub_weights))

        return expanded

    def _build_local_slots_for_date(self, expected_date: date) -> list[datetime]:
        return day_slots(expected_date, tzinfo=self._local_tz)

    def _get_state(self, entity_id: str | None):
        if entity_id is None:
            return None
        return self._hass.states.get(entity_id)

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


    def _read_first_unit(self, entity_ids: list[str | None]) -> str | None:
        for entity_id in entity_ids:
            state = self._get_state(entity_id)
            unit = self._read_unit_from_state(state)
            if unit is not None:
                return unit
        return None

    def _read_solar_actual_energy_entity_id(self) -> str | None:
        energy_nodes = read_mapping(self._config.get("energy_nodes"))
        solar_config = read_mapping(energy_nodes.get("solar"))
        forecast_config = read_mapping(solar_config.get("forecast"))
        entities = read_mapping(solar_config.get("entities"))

        return read_entity_id(
            forecast_config.get("total_energy_entity_id")
        ) or read_entity_id(entities.get("today_energy"))

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


def read_solar_forecast_entities(config: dict[str, Any]) -> list[str]:
    """Configured daily solar sources, in forecast-day order."""
    energy_nodes = read_mapping(config.get("energy_nodes"))
    solar = read_mapping(energy_nodes.get("solar"))
    forecast = read_mapping(solar.get("forecast"))
    raw = forecast.get("daily_energy_entity_ids")
    if not isinstance(raw, list):
        return []
    return [entity for value in raw if (entity := read_entity_id(value)) is not None]


HelmanForecastBuilder = SolarForecastBuilder
