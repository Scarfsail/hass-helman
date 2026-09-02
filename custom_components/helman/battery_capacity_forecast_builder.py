from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .battery_slot_simulation import (
    is_baseline_schedule_action,
    is_supported_schedule_action,
    round_energy,
    simulate_schedule_action_slot,
    simulate_slot,
    slot_end,
)
from .battery_state import (
    BatteryForecastSettings,
    BatteryLiveState,
    read_battery_entity_config,
    read_battery_forecast_settings,
)
from .const import (
    BATTERY_CAPACITY_FORECAST_MODEL_ID,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    FORECAST_CANONICAL_RESOLUTION,
    MAX_FORECAST_DAYS,
)
from .recorder_hourly_series import get_local_current_slot_start
from .scheduling.schedule import EMPTY_SCHEDULE_ACTION

_CANONICAL_SLOT_DURATION = timedelta(minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES)
_CANONICAL_SLOT_HOURS = FORECAST_CANONICAL_GRANULARITY_MINUTES / 60
_LOGGER = logging.getLogger(__name__)

if TYPE_CHECKING:
    from .scheduling.forecast_overlay import ScheduleForecastOverlay


@dataclass(frozen=True)
class _BatteryForecastSlotInput:
    slot_start: datetime
    slot_key: datetime
    duration_hours: float
    solar_kwh: float
    baseline_house_kwh: float


class BatteryCapacityForecastBuilder:
    """Builds the battery capacity forecast from pre-gathered inputs.

    Deliberately holds no ``hass``: every live and historical input arrives
    through ``build_with_history``, so there is no way for a recorder read to
    creep back into the builder and onto the card read path.
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self._config = config

    def build_with_history(
        self,
        *,
        solar_forecast: dict[str, Any],
        house_forecast: dict[str, Any],
        started_at: datetime,
        forecast_days: int = MAX_FORECAST_DAYS,
        schedule_overlay: ScheduleForecastOverlay | None = None,
        live_state: BatteryLiveState | None,
        actual_history: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Pure, synchronous forecast core.

        Never touches ``hass`` or the recorder: the live battery state and
        actual history are supplied by the caller. Safe to run in an executor.
        """
        horizon_hours = forecast_days * 24
        canonical_slot_count = (
            horizon_hours * 60
        ) // FORECAST_CANONICAL_GRANULARITY_MINUTES
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
                horizon_hours=horizon_hours,
            )

        if live_state is None:
            _LOGGER.warning("Battery forecast unavailable: live_state is None")
            return self._make_payload(
                status="unavailable",
                settings=settings,
                model=model,
                horizon_hours=horizon_hours,
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
                horizon_hours=horizon_hours,
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
                horizon_hours=horizon_hours,
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
                horizon_hours=horizon_hours,
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

        house_series_by_slot = self._build_house_series_map(house_forecast)
        current_slot_house_value = self._read_current_slot_house_value(
            house_forecast,
            current_slot_start,
            house_series_by_slot=house_series_by_slot,
        )
        if current_slot_house_value is None:
            _LOGGER.warning(
                "Battery forecast unavailable: the house forecast covers no "
                "slot at %s (its own anchor is %s)",
                current_slot_start.isoformat(),
                self._describe_house_anchor(house_forecast),
            )
            return self._make_payload(
                status="unavailable",
                settings=settings,
                live_state=live_state,
                model=model,
                horizon_hours=horizon_hours,
            )

        solar_by_slot = self._build_solar_slot_map(solar_forecast)

        slot_inputs_result = self._build_slot_inputs(
            canonical_slot_count=canonical_slot_count,
            started_at_local=started_at_local,
            current_slot_start=current_slot_start,
            next_slot_start=next_slot_start,
            first_duration_hours=first_duration_hours,
            current_slot_house_value=current_slot_house_value,
            house_series_by_slot=house_series_by_slot,
            solar_by_slot=solar_by_slot,
        )
        if slot_inputs_result is None:
            return self._make_payload(
                status="unavailable",
                settings=settings,
                live_state=live_state,
                model=model,
                horizon_hours=horizon_hours,
            )

        slot_inputs, coverage_until, partial_reason = slot_inputs_result
        baseline_series = self._simulate_series(
            slot_inputs=slot_inputs,
            live_state=live_state,
            settings=settings,
        )
        schedule_adjusted: bool | None = None
        schedule_adjustment_coverage_until: str | None = None
        series = baseline_series
        if schedule_overlay is not None:
            (
                series,
                schedule_adjusted,
                schedule_adjustment_coverage_until,
            ) = self._build_schedule_adjusted_series(
                slot_inputs=slot_inputs,
                baseline_series=baseline_series,
                schedule_overlay=schedule_overlay,
                live_state=live_state,
                settings=settings,
            )

        if partial_reason is not None:
            return self._make_payload(
                status="partial",
                settings=settings,
                live_state=live_state,
                model=model,
                horizon_hours=horizon_hours,
                started_at=started_at_local,
                partial_reason=partial_reason,
                coverage_until=coverage_until,
                actual_history=actual_history,
                series=series,
                baseline_series=baseline_series if schedule_overlay is not None else None,
                schedule_adjusted=schedule_adjusted,
                schedule_adjustment_coverage_until=schedule_adjustment_coverage_until,
            )

        return self._make_payload(
            status="available",
            settings=settings,
            live_state=live_state,
            model=model,
            horizon_hours=horizon_hours,
            started_at=started_at_local,
            coverage_until=coverage_until,
            actual_history=actual_history,
            series=series,
            baseline_series=baseline_series if schedule_overlay is not None else None,
            schedule_adjusted=schedule_adjusted,
            schedule_adjustment_coverage_until=schedule_adjustment_coverage_until,
        )

    def _build_slot_inputs(
        self,
        *,
        canonical_slot_count: int,
        started_at_local: datetime,
        current_slot_start: datetime,
        next_slot_start: datetime,
        first_duration_hours: float,
        current_slot_house_value: float,
        house_series_by_slot: dict[datetime, float],
        solar_by_slot: dict[datetime, float],
    ) -> tuple[list[_BatteryForecastSlotInput], str | None, str | None] | None:
        slot_inputs: list[_BatteryForecastSlotInput] = []
        coverage_until: str | None = None
        partial_reason: str | None = None
        next_slot_start_utc = dt_util.as_utc(next_slot_start)

        for slot_index in range(canonical_slot_count):
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
                    return None
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

            slot_inputs.append(
                _BatteryForecastSlotInput(
                    slot_start=slot_start,
                    slot_key=slot_key,
                    duration_hours=slot_duration_hours,
                    solar_kwh=solar_kwh,
                    baseline_house_kwh=baseline_house_kwh,
                )
            )
            coverage_until = slot_end(slot_start, slot_duration_hours).isoformat()

        return slot_inputs, coverage_until, partial_reason

    def _simulate_series(
        self,
        *,
        slot_inputs: list[_BatteryForecastSlotInput],
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
    ) -> list[dict[str, Any]]:
        series: list[dict[str, Any]] = []
        remaining_energy_kwh = live_state.current_remaining_energy_kwh

        for slot_input in slot_inputs:
            slot, remaining_energy_kwh = simulate_slot(
                slot_start=slot_input.slot_start,
                duration_hours=slot_input.duration_hours,
                solar_kwh=slot_input.solar_kwh,
                baseline_house_kwh=slot_input.baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=live_state,
                settings=settings,
            )
            series.append(slot)

        return series

    def _build_schedule_adjusted_series(
        self,
        *,
        slot_inputs: list[_BatteryForecastSlotInput],
        baseline_series: list[dict[str, Any]],
        schedule_overlay: ScheduleForecastOverlay,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
    ) -> tuple[list[dict[str, Any]], bool, str | None]:
        adjusted_series: list[dict[str, Any]] = []
        remaining_energy_kwh = live_state.current_remaining_energy_kwh
        has_non_normal_adjustment = False
        schedule_adjustment_coverage_until: str | None = None
        overlay_horizon_end_utc = dt_util.as_utc(schedule_overlay.horizon_end)

        for index, slot_input in enumerate(slot_inputs):
            action = EMPTY_SCHEDULE_ACTION
            if dt_util.as_utc(slot_input.slot_key) < overlay_horizon_end_utc:
                action = schedule_overlay.lookup_action(slot_input.slot_key)
                if not is_supported_schedule_action(action.kind):
                    if not has_non_normal_adjustment:
                        return baseline_series, False, None
                    return self._build_schedule_baseline_tail_fallback(
                        adjusted_series=adjusted_series,
                        baseline_series=baseline_series,
                        fallback_start_index=index,
                        schedule_adjustment_coverage_until=schedule_adjustment_coverage_until,
                    )

            result = simulate_schedule_action_slot(
                slot_start=slot_input.slot_start,
                duration_hours=slot_input.duration_hours,
                solar_kwh=slot_input.solar_kwh,
                baseline_house_kwh=slot_input.baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=live_state,
                settings=settings,
                action=action,
            )
            remaining_energy_kwh = result.remaining_energy_kwh
            if not is_baseline_schedule_action(result.effective_action_kind):
                has_non_normal_adjustment = True
                schedule_adjustment_coverage_until = slot_end(
                    slot_input.slot_start,
                    slot_input.duration_hours,
                ).isoformat()
            adjusted_series.append(result.slot)

        if not has_non_normal_adjustment:
            return baseline_series, False, None

        return (
            self._attach_baseline_comparison(adjusted_series, baseline_series),
            True,
            schedule_adjustment_coverage_until,
        )

    def _build_schedule_baseline_tail_fallback(
        self,
        *,
        adjusted_series: list[dict[str, Any]],
        baseline_series: list[dict[str, Any]],
        fallback_start_index: int,
        schedule_adjustment_coverage_until: str | None,
    ) -> tuple[list[dict[str, Any]], bool, str | None]:
        adjusted_series.extend(
            self._build_baseline_fallback_tail(baseline_series[fallback_start_index:])
        )
        return (
            self._attach_baseline_comparison(adjusted_series, baseline_series),
            True,
            schedule_adjustment_coverage_until,
        )

    def _build_baseline_fallback_tail(
        self,
        baseline_series: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return [dict(baseline_slot) for baseline_slot in baseline_series]

    def _attach_baseline_comparison(
        self,
        series: list[dict[str, Any]],
        baseline_series: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        adjusted_with_baseline: list[dict[str, Any]] = []
        for slot, baseline_slot in zip(series, baseline_series, strict=False):
            item = dict(slot)
            item["baselineSocPct"] = baseline_slot["socPct"]
            item["baselineRemainingEnergyKwh"] = baseline_slot[
                "remainingEnergyKwh"
            ]
            adjusted_with_baseline.append(item)
        return adjusted_with_baseline

    def _read_current_slot_house_value(
        self,
        house_forecast: dict[str, Any],
        current_slot_start: datetime,
        *,
        house_series_by_slot: dict[datetime, float],
    ) -> float | None:
        """The house demand for the slot this simulation starts in.

        The house payload is anchored on the *house build's* own slot: a
        ``currentSlot`` entry, then a ``series`` starting the slot after it. A
        battery build one slot past that anchor — the pipeline rebuilding
        mid-slot against the snapshot the previous beat left, which happens
        whenever an off-beat event invalidates the cache — finds its slot in the
        series, not in ``currentSlot``. Fall through to the series map rather
        than declaring the whole forecast unavailable, which is what used to
        take all five current-slot sensors down with it. See #204.

        The house series carries one slot more than the simulation's horizon
        needs, so a one-slot lag still reaches the end of the horizon. A larger
        one runs out at the tail and is refused there — a house snapshot half an
        hour stale is a real staleness condition, not a race.
        """
        current_slot = house_forecast.get("currentSlot")
        if not isinstance(current_slot, dict):
            current_slot = house_forecast.get("currentHour")

        if isinstance(current_slot, dict):
            timestamp = self._parse_timestamp(current_slot.get("timestamp"))
            if (
                timestamp is not None
                and dt_util.as_local(timestamp) == current_slot_start
            ):
                value = self._read_house_entry_value(current_slot)
                if value is not None:
                    return value

        return house_series_by_slot.get(current_slot_start)

    def _describe_house_anchor(self, house_forecast: dict[str, Any]) -> str:
        """The house payload's own current slot, for the unavailable warning."""
        current_slot = house_forecast.get("currentSlot")
        if not isinstance(current_slot, dict):
            current_slot = house_forecast.get("currentHour")
        if not isinstance(current_slot, dict):
            return "absent"
        timestamp = self._parse_timestamp(current_slot.get("timestamp"))
        return "unparseable" if timestamp is None else timestamp.isoformat()

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

        if slot_value_divisor == 1:
            for slot_start, value in parsed_points:
                by_slot[slot_start] = by_slot.get(slot_start, 0.0) + value
            return by_slot

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
        horizon_hours: int,
        live_state: BatteryLiveState | None = None,
        model: str | None = None,
        started_at: datetime | None = None,
        partial_reason: str | None = None,
        coverage_until: str | None = None,
        actual_history: list[dict[str, Any]] | None = None,
        series: list[dict[str, Any]] | None = None,
        baseline_series: list[dict[str, Any]] | None = None,
        schedule_adjusted: bool | None = None,
        schedule_adjustment_coverage_until: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "status": status,
            "generatedAt": dt_util.now().isoformat(),
            "startedAt": started_at.isoformat() if started_at is not None else None,
            "unit": "kWh",
            "resolution": FORECAST_CANONICAL_RESOLUTION,
            "horizonHours": horizon_hours,
            "sourceGranularityMinutes": FORECAST_CANONICAL_GRANULARITY_MINUTES,
            "model": model,
            "nominalCapacityKwh": (
                round_energy(
                    live_state.nominal_capacity_kwh
                )
                if live_state is not None
                else None
            ),
            "currentRemainingEnergyKwh": (
                round_energy(
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
        if baseline_series is not None:
            payload["baselineSeries"] = baseline_series
        if schedule_adjusted is not None:
            payload["scheduleAdjusted"] = schedule_adjusted
            payload["scheduleAdjustmentCoverageUntil"] = (
                schedule_adjustment_coverage_until
            )
        return payload

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
