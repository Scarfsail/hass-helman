from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .battery_actual_history_builder import build_battery_actual_history
from .battery_state import (
    BatteryEntityConfig,
    BatteryForecastSettings,
    BatteryLiveState,
    read_battery_entity_config,
    read_battery_forecast_settings,
    read_battery_live_state,
)
from .const import (
    BATTERY_CAPACITY_FORECAST_HORIZON_HOURS,
    BATTERY_CAPACITY_FORECAST_MODEL_ID,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
)
from .forecast_aggregation import get_forecast_resolution
from .recorder_hourly_series import get_local_current_slot_start

_EPSILON = 1e-9
_CANONICAL_SLOT_DURATION = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
_CANONICAL_SLOT_HOURS = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
_CANONICAL_SLOT_COUNT = (
    BATTERY_CAPACITY_FORECAST_HORIZON_HOURS * 60
) // FORECAST_CANONICAL_GRANULARITY_MINUTES
_LOGGER = logging.getLogger(__name__)


class BatteryCapacityForecastBuilder:
    def __init__(self, hass: HomeAssistant, config: dict[str, Any]) -> None:
        self._hass = hass
        self._config = config

    async def build(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
    ) -> dict[str, Any]:
        settings = read_battery_forecast_settings(self._config)
        entity_config = read_battery_entity_config(self._config)
        model = (
            BATTERY_CAPACITY_FORECAST_MODEL_ID
            if entity_config is not None and settings.is_configured
            else None
        )

        if entity_config is None or not settings.is_configured:
            return self._make_payload(
                status="not_configured",
                settings=settings,
                model=model,
            )

        live_state = read_battery_live_state(self._hass, entity_config)
        if live_state is None:
            _LOGGER.warning("Battery forecast unavailable: live_state is None")
            return self._make_payload(
                status="unavailable",
                settings=settings,
                model=model,
            )

        house_status = house_forecast.get("status")
        if house_status == "insufficient_history":
            _LOGGER.warning(
                "Battery forecast insufficient_history: house forecast has insufficient history"
            )
            return self._make_payload(
                status="insufficient_history",
                settings=settings,
                live_state=live_state,
                model=model,
            )
        if house_status != "available":
            _LOGGER.warning(
                "Battery forecast unavailable: house_status=%s", house_status
            )
            return self._make_payload(
                status="unavailable",
                settings=settings,
                live_state=live_state,
                model=model,
            )

        solar_status = solar_forecast.get("status")
        if solar_status in {"not_configured", "unavailable"}:
            _LOGGER.warning(
                "Battery forecast unavailable: solar_status=%s", solar_status
            )
            return self._make_payload(
                status="unavailable",
                settings=settings,
                live_state=live_state,
                model=model,
            )

        actual_history = await self._build_actual_history(
            entity_config,
            started_at,
        )
        started_at_local = dt_util.as_local(started_at)
        current_slot_start = get_local_current_slot_start(
            started_at_local,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        next_slot_start = self._advance_slots(current_slot_start, slot_count=1)
        first_duration_hours = (
            next_slot_start - started_at_local
        ).total_seconds() / 3600

        current_slot_house_value = self._read_current_slot_house_value(
            house_forecast, current_slot_start
        )
        if current_slot_house_value is None:
            _LOGGER.warning(
                "Battery forecast unavailable: current_slot_house_value is None "
                "(current_slot_start=%s)",
                current_slot_start.isoformat(),
            )
            return self._make_payload(
                status="unavailable",
                settings=settings,
                live_state=live_state,
                model=model,
            )

        house_series_by_slot = self._build_house_series_map(house_forecast)
        solar_by_slot = self._build_solar_slot_map(solar_forecast)

        series: list[dict[str, Any]] = []
        coverage_until: str | None = None
        partial_reason: str | None = None
        remaining_energy_kwh = live_state.current_remaining_energy_kwh
        next_slot_start_utc = dt_util.as_utc(next_slot_start)

        for slot_index in range(_CANONICAL_SLOT_COUNT):
            if slot_index == 0:
                slot_start = started_at_local
                slot_duration_hours = first_duration_hours
                slot_key = current_slot_start
                baseline_house_kwh = (
                    current_slot_house_value
                    * self._get_slot_fraction(slot_duration_hours)
                )
            else:
                slot_key = dt_util.as_local(
                    next_slot_start_utc
                    + (_CANONICAL_SLOT_DURATION * (slot_index - 1))
                )
                slot_start = slot_key
                slot_duration_hours = _CANONICAL_SLOT_HOURS
                house_slot_value = house_series_by_slot.get(slot_key)
                if house_slot_value is None:
                    _LOGGER.warning(
                        "Battery forecast unavailable: house series missing "
                        "slot_index=%d slot_start=%s (map has %d keys, first=%s, last=%s)",
                        slot_index,
                        slot_key.isoformat(),
                        len(house_series_by_slot),
                        min(house_series_by_slot).isoformat() if house_series_by_slot else "N/A",
                        max(house_series_by_slot).isoformat() if house_series_by_slot else "N/A",
                    )
                    return self._make_payload(
                        status="unavailable",
                        settings=settings,
                        live_state=live_state,
                        model=model,
                    )
                baseline_house_kwh = house_slot_value

            solar_wh = solar_by_slot.get(slot_key)
            if solar_wh is None:
                partial_reason = (
                    "missing_current_hour_solar"
                    if slot_index == 0
                    else "solar_forecast_ended"
                )
                break

            solar_kwh = solar_wh / 1000
            if slot_index == 0:
                solar_kwh *= self._get_slot_fraction(slot_duration_hours)
            slot, remaining_energy_kwh = self._simulate_slot(
                slot_start=slot_start,
                duration_hours=slot_duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=live_state,
                settings=settings,
            )
            series.append(slot)
            coverage_until = self._slot_end(slot_start, slot_duration_hours).isoformat()

        if partial_reason is not None:
            return self._make_payload(
                status="partial",
                settings=settings,
                live_state=live_state,
                model=model,
                started_at=started_at_local,
                partial_reason=partial_reason,
                coverage_until=coverage_until,
                actual_history=actual_history,
                series=series,
            )

        return self._make_payload(
            status="available",
            settings=settings,
            live_state=live_state,
            model=model,
            started_at=started_at_local,
            coverage_until=coverage_until,
            actual_history=actual_history,
            series=series,
        )

    async def _build_actual_history(
        self,
        entity_config: BatteryEntityConfig,
        reference_time: datetime,
    ) -> list[dict[str, Any]]:
        try:
            return await build_battery_actual_history(
                self._hass,
                entity_config.capacity_entity_id,
                reference_time,
                interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            )
        except Exception:
            _LOGGER.exception(
                "Failed to build battery actual history for %s",
                entity_config.capacity_entity_id,
            )
            return []

    def _simulate_slot(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
    ) -> tuple[dict[str, Any], float]:
        energy_before_kwh = remaining_energy_kwh
        net_kwh = solar_kwh - baseline_house_kwh
        charged_kwh = 0.0
        discharged_kwh = 0.0
        imported_from_grid_kwh = 0.0
        exported_to_grid_kwh = 0.0
        limited_by_charge_power = False
        limited_by_discharge_power = False

        if net_kwh > _EPSILON:
            max_charge_input_kwh = (
                settings.max_charge_power_w / 1000
            ) * duration_hours
            headroom_kwh = max(0.0, live_state.max_energy_kwh - energy_before_kwh)
            input_needed_for_headroom_kwh = (
                headroom_kwh / settings.charge_efficiency
                if headroom_kwh > _EPSILON
                else 0.0
            )
            desired_charge_input_kwh = min(net_kwh, input_needed_for_headroom_kwh)
            actual_charge_input_kwh = min(
                desired_charge_input_kwh,
                max_charge_input_kwh,
            )
            charged_kwh = min(
                actual_charge_input_kwh * settings.charge_efficiency,
                headroom_kwh,
            )
            exported_to_grid_kwh = max(0.0, net_kwh - actual_charge_input_kwh)
            limited_by_charge_power = (
                desired_charge_input_kwh - max_charge_input_kwh
            ) > _EPSILON
            remaining_energy_kwh = min(
                live_state.max_energy_kwh,
                energy_before_kwh + charged_kwh,
            )
        elif net_kwh < -_EPSILON:
            deficit_kwh = -net_kwh
            max_discharge_output_kwh = (
                settings.max_discharge_power_w / 1000
            ) * duration_hours
            usable_battery_kwh = max(
                0.0, energy_before_kwh - live_state.min_energy_kwh
            )
            max_output_from_energy_kwh = (
                usable_battery_kwh * settings.discharge_efficiency
            )
            desired_discharge_output_kwh = min(
                deficit_kwh,
                max_output_from_energy_kwh,
            )
            actual_discharge_output_kwh = min(
                desired_discharge_output_kwh,
                max_discharge_output_kwh,
            )
            discharged_kwh = (
                actual_discharge_output_kwh / settings.discharge_efficiency
                if actual_discharge_output_kwh > _EPSILON
                else 0.0
            )
            imported_from_grid_kwh = max(
                0.0, deficit_kwh - actual_discharge_output_kwh
            )
            limited_by_discharge_power = (
                desired_discharge_output_kwh - max_discharge_output_kwh
            ) > _EPSILON
            remaining_energy_kwh = max(
                live_state.min_energy_kwh,
                energy_before_kwh - discharged_kwh,
            )

        soc_pct = (remaining_energy_kwh / live_state.nominal_capacity_kwh) * 100
        hit_min_soc = (
            remaining_energy_kwh - live_state.min_energy_kwh
        ) <= _EPSILON
        hit_max_soc = (
            live_state.max_energy_kwh - remaining_energy_kwh
        ) <= _EPSILON

        return (
            {
                "timestamp": slot_start.isoformat(),
                "durationHours": round(duration_hours, 4),
                "solarKwh": self._round_energy(solar_kwh),
                "baselineHouseKwh": self._round_energy(baseline_house_kwh),
                "netKwh": self._round_energy(net_kwh),
                "chargedKwh": self._round_energy(charged_kwh),
                "dischargedKwh": self._round_energy(discharged_kwh),
                "remainingEnergyKwh": self._round_energy(remaining_energy_kwh),
                "socPct": round(soc_pct, 2),
                "importedFromGridKwh": self._round_energy(imported_from_grid_kwh),
                "exportedToGridKwh": self._round_energy(exported_to_grid_kwh),
                "hitMinSoc": hit_min_soc,
                "hitMaxSoc": hit_max_soc,
                "limitedByChargePower": limited_by_charge_power,
                "limitedByDischargePower": limited_by_discharge_power,
            },
            remaining_energy_kwh,
        )

    def _read_current_slot_house_value(
        self, house_forecast: dict[str, Any], current_slot_start: datetime
    ) -> float | None:
        current_slot = house_forecast.get("currentSlot")
        if not isinstance(current_slot, dict):
            current_slot = house_forecast.get("currentHour")
        if not isinstance(current_slot, dict):
            return None

        timestamp = self._parse_timestamp(current_slot.get("timestamp"))
        if timestamp is None:
            return None

        if dt_util.as_local(timestamp) != current_slot_start:
            return None

        return self._read_house_entry_value(current_slot)

    def _build_house_series_map(self, house_forecast: dict[str, Any]) -> dict[datetime, float]:
        series = house_forecast.get("series")
        if not isinstance(series, list):
            return {}

        by_slot: dict[datetime, float] = {}
        for entry in series:
            if not isinstance(entry, dict):
                continue

            timestamp = self._parse_timestamp(entry.get("timestamp"))
            value = self._read_house_entry_value(entry)
            if timestamp is None or value is None:
                continue

            by_slot[dt_util.as_local(timestamp)] = value

        return by_slot

    def _build_solar_slot_map(self, solar_forecast: dict[str, Any]) -> dict[datetime, float]:
        points = solar_forecast.get("points")
        if not isinstance(points, list):
            return {}

        parsed_points: list[tuple[datetime, float]] = []
        for point in points:
            if not isinstance(point, dict):
                continue

            timestamp = self._parse_timestamp(point.get("timestamp"))
            value = self._read_float(point.get("value"))
            if timestamp is None or value is None:
                continue

            parsed_points.append((dt_util.as_local(timestamp), value))

        if not parsed_points:
            return {}

        split_factor = self._get_solar_point_split_factor(parsed_points)
        slot_value_divisor = split_factor if split_factor > 0 else 1
        by_slot: dict[datetime, float] = {}
        for slot_start, value in parsed_points:
            slot_value = value / slot_value_divisor
            for split_index in range(slot_value_divisor):
                expanded_slot_start = self._advance_slots(
                    slot_start,
                    slot_count=split_index,
                )
                by_slot[expanded_slot_start] = (
                    by_slot.get(expanded_slot_start, 0.0) + slot_value
                )

        return by_slot

    @staticmethod
    def _read_house_entry_value(entry: dict[str, Any]) -> float | None:
        non_deferrable = entry.get("nonDeferrable")
        if not isinstance(non_deferrable, dict):
            return None
        return BatteryCapacityForecastBuilder._read_float(non_deferrable.get("value"))

    @staticmethod
    def _parse_timestamp(raw_value: Any) -> datetime | None:
        if not isinstance(raw_value, str):
            return None
        return dt_util.parse_datetime(raw_value)

    @staticmethod
    def _advance_slots(value: datetime, *, slot_count: int) -> datetime:
        return dt_util.as_local(
            dt_util.as_utc(value) + (_CANONICAL_SLOT_DURATION * slot_count)
        )

    @staticmethod
    def _slot_end(slot_start: datetime, duration_hours: float) -> datetime:
        return slot_start + timedelta(hours=duration_hours)

    @staticmethod
    def _round_energy(value: float) -> float:
        return round(value, 4)

    @staticmethod
    def _get_slot_fraction(duration_hours: float) -> float:
        return duration_hours / _CANONICAL_SLOT_HOURS

    @staticmethod
    def _get_solar_point_split_factor(
        parsed_points: list[tuple[datetime, float]],
    ) -> int:
        if len(parsed_points) < 2:
            return 1

        candidate_intervals: list[int] = []
        for index in range(1, len(parsed_points)):
            delta_seconds = (
                dt_util.as_utc(parsed_points[index][0])
                - dt_util.as_utc(parsed_points[index - 1][0])
            ).total_seconds()
            if delta_seconds <= 0:
                continue
            candidate_intervals.append(int(round(delta_seconds / 60)))

        if not candidate_intervals:
            return 1

        interval_minutes = min(candidate_intervals)
        if interval_minutes < FORECAST_CANONICAL_GRANULARITY_MINUTES:
            return 1
        if interval_minutes % FORECAST_CANONICAL_GRANULARITY_MINUTES != 0:
            return 1
        return interval_minutes // FORECAST_CANONICAL_GRANULARITY_MINUTES

    @staticmethod
    def _make_payload(
        *,
        status: str,
        settings: BatteryForecastSettings,
        live_state: BatteryLiveState | None = None,
        model: str | None = None,
        started_at: datetime | None = None,
        partial_reason: str | None = None,
        coverage_until: str | None = None,
        actual_history: list[dict[str, Any]] | None = None,
        series: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "startedAt": started_at.isoformat() if started_at is not None else None,
            "unit": "kWh",
            "resolution": get_forecast_resolution(
                FORECAST_CANONICAL_GRANULARITY_MINUTES
            ),
            "horizonHours": BATTERY_CAPACITY_FORECAST_HORIZON_HOURS,
            "sourceGranularityMinutes": FORECAST_CANONICAL_GRANULARITY_MINUTES,
            "model": model,
            "nominalCapacityKwh": (
                BatteryCapacityForecastBuilder._round_energy(
                    live_state.nominal_capacity_kwh
                )
                if live_state is not None
                else None
            ),
            "currentRemainingEnergyKwh": (
                BatteryCapacityForecastBuilder._round_energy(
                    live_state.current_remaining_energy_kwh
                )
                if live_state is not None
                else None
            ),
            "currentSoc": round(live_state.current_soc, 2)
            if live_state is not None
            else None,
            "minSoc": round(live_state.min_soc, 2) if live_state is not None else None,
            "maxSoc": round(live_state.max_soc, 2) if live_state is not None else None,
            "chargeEfficiency": settings.charge_efficiency,
            "dischargeEfficiency": settings.discharge_efficiency,
            "maxChargePowerW": settings.max_charge_power_w,
            "maxDischargePowerW": settings.max_discharge_power_w,
            "partialReason": partial_reason,
            "coverageUntil": coverage_until,
            "actualHistory": actual_history if actual_history is not None else [],
            "series": series if series is not None else [],
        }

    @staticmethod
    def _read_float(raw_value: Any) -> float | None:
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
