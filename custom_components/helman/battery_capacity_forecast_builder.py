from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

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
    BATTERY_CAPACITY_FORECAST_MODEL_ID,
    FORECAST_CANONICAL_GRANULARITY_MINUTES,
    MAX_FORECAST_DAYS,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
)
from .forecast_aggregation import get_forecast_resolution
from .recorder_hourly_series import get_local_current_slot_start
from .scheduling.action_resolution import resolve_executed_schedule_action
from .scheduling.schedule import NORMAL_SCHEDULE_ACTION, ScheduleAction

_EPSILON = 1e-9
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


@dataclass(frozen=True)
class _ScheduleActionSimulationResult:
    slot: dict[str, Any]
    remaining_energy_kwh: float
    effective_action_kind: str


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
        forecast_days: int = MAX_FORECAST_DAYS,
        schedule_overlay: ScheduleForecastOverlay | None = None,
    ) -> dict[str, Any]:
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

        live_state = read_battery_live_state(self._hass, entity_config)
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
                horizon_hours=horizon_hours,
            )

        house_series_by_slot = self._build_house_series_map(house_forecast)
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
            coverage_until = self._slot_end(slot_start, slot_duration_hours).isoformat()

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
            slot, remaining_energy_kwh = self._simulate_slot(
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
            action = NORMAL_SCHEDULE_ACTION
            if dt_util.as_utc(slot_input.slot_key) < overlay_horizon_end_utc:
                action = schedule_overlay.lookup_action(slot_input.slot_key)
                if not self._is_supported_schedule_action(action.kind):
                    if not has_non_normal_adjustment:
                        return baseline_series, False, None
                    return self._build_schedule_baseline_tail_fallback(
                        adjusted_series=adjusted_series,
                        baseline_series=baseline_series,
                        fallback_start_index=index,
                        schedule_adjustment_coverage_until=schedule_adjustment_coverage_until,
                    )

            result = self._simulate_schedule_action_slot(
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
            if result.effective_action_kind != SCHEDULE_ACTION_NORMAL:
                has_non_normal_adjustment = True
                schedule_adjustment_coverage_until = self._slot_end(
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

    def _simulate_schedule_action_slot(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
        action: ScheduleAction,
    ) -> _ScheduleActionSimulationResult:
        current_soc = self._calculate_soc_pct(
            remaining_energy_kwh,
            live_state.nominal_capacity_kwh,
        )
        effective_action = resolve_executed_schedule_action(
            action=action,
            current_soc=current_soc,
        ).executed_action

        if effective_action.kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC:
            slot, remaining_energy_kwh = self._simulate_charge_to_target_slot(
                slot_start=slot_start,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=live_state,
                settings=settings,
                target_soc=self._require_target_soc(effective_action),
            )
        elif effective_action.kind == SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC:
            slot, remaining_energy_kwh = self._simulate_discharge_to_target_slot(
                slot_start=slot_start,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=live_state,
                settings=settings,
                target_soc=self._require_target_soc(effective_action),
            )
        else:
            slot, remaining_energy_kwh = self._simulate_slot(
                slot_start=slot_start,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                live_state=live_state,
                settings=settings,
                action_kind=effective_action.kind,
            )

        return _ScheduleActionSimulationResult(
            slot=slot,
            remaining_energy_kwh=remaining_energy_kwh,
            effective_action_kind=effective_action.kind,
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
        action_kind: str = SCHEDULE_ACTION_NORMAL,
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
            if action_kind == SCHEDULE_ACTION_STOP_CHARGING:
                exported_to_grid_kwh = net_kwh
            else:
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
            if action_kind == SCHEDULE_ACTION_STOP_DISCHARGING:
                imported_from_grid_kwh = deficit_kwh
            else:
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
            self._make_simulated_slot_payload(
                slot_start=slot_start,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                charged_kwh=charged_kwh,
                discharged_kwh=discharged_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                imported_from_grid_kwh=imported_from_grid_kwh,
                exported_to_grid_kwh=exported_to_grid_kwh,
                hit_min_soc=hit_min_soc,
                hit_max_soc=hit_max_soc,
                limited_by_charge_power=limited_by_charge_power,
                limited_by_discharge_power=limited_by_discharge_power,
                soc_pct=soc_pct,
            ),
            remaining_energy_kwh,
        )

    def _simulate_charge_to_target_slot(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
        target_soc: int,
    ) -> tuple[dict[str, Any], float]:
        target_energy_kwh = self._target_energy_kwh(
            target_soc=target_soc,
            live_state=live_state,
        )
        input_needed_for_target_kwh = (
            max(0.0, target_energy_kwh - remaining_energy_kwh)
            / settings.charge_efficiency
        )
        max_charge_power_kw = settings.max_charge_power_w / 1000
        max_charge_input_kwh = max_charge_power_kw * duration_hours

        if (
            max_charge_power_kw > _EPSILON
            and input_needed_for_target_kwh > _EPSILON
            and input_needed_for_target_kwh < (max_charge_input_kwh - _EPSILON)
        ):
            forced_duration_hours = input_needed_for_target_kwh / max_charge_power_kw
            forced_solar_kwh = self._split_slot_value(
                total_value=solar_kwh,
                total_duration_hours=duration_hours,
                partial_duration_hours=forced_duration_hours,
            )
            forced_house_kwh = self._split_slot_value(
                total_value=baseline_house_kwh,
                total_duration_hours=duration_hours,
                partial_duration_hours=forced_duration_hours,
            )
            forced_slot, remaining_after_forced = self._simulate_forced_charge_phase(
                slot_start=slot_start,
                duration_hours=forced_duration_hours,
                solar_kwh=forced_solar_kwh,
                baseline_house_kwh=forced_house_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                target_energy_kwh=target_energy_kwh,
                live_state=live_state,
                settings=settings,
            )
            stop_slot, remaining_after_stop = self._simulate_slot(
                slot_start=self._slot_end(slot_start, forced_duration_hours),
                duration_hours=duration_hours - forced_duration_hours,
                solar_kwh=solar_kwh - forced_solar_kwh,
                baseline_house_kwh=baseline_house_kwh - forced_house_kwh,
                remaining_energy_kwh=remaining_after_forced,
                live_state=live_state,
                settings=settings,
                action_kind=SCHEDULE_ACTION_STOP_DISCHARGING,
            )
            return (
                self._merge_phase_slots(
                    slot_start=slot_start,
                    duration_hours=duration_hours,
                    solar_kwh=solar_kwh,
                    baseline_house_kwh=baseline_house_kwh,
                    remaining_energy_kwh=remaining_after_stop,
                    live_state=live_state,
                    phase_slots=(forced_slot, stop_slot),
                ),
                remaining_after_stop,
            )

        return self._simulate_forced_charge_phase(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            target_energy_kwh=target_energy_kwh,
            live_state=live_state,
            settings=settings,
        )

    def _simulate_discharge_to_target_slot(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
        target_soc: int,
    ) -> tuple[dict[str, Any], float]:
        target_energy_kwh = self._target_energy_kwh(
            target_soc=target_soc,
            live_state=live_state,
        )
        output_needed_for_target_kwh = max(
            0.0,
            remaining_energy_kwh - target_energy_kwh,
        ) * settings.discharge_efficiency
        max_discharge_power_kw = settings.max_discharge_power_w / 1000
        max_discharge_output_kwh = max_discharge_power_kw * duration_hours

        if (
            max_discharge_power_kw > _EPSILON
            and output_needed_for_target_kwh > _EPSILON
            and output_needed_for_target_kwh < (max_discharge_output_kwh - _EPSILON)
        ):
            forced_duration_hours = output_needed_for_target_kwh / max_discharge_power_kw
            forced_solar_kwh = self._split_slot_value(
                total_value=solar_kwh,
                total_duration_hours=duration_hours,
                partial_duration_hours=forced_duration_hours,
            )
            forced_house_kwh = self._split_slot_value(
                total_value=baseline_house_kwh,
                total_duration_hours=duration_hours,
                partial_duration_hours=forced_duration_hours,
            )
            forced_slot, remaining_after_forced = (
                self._simulate_forced_discharge_phase(
                    slot_start=slot_start,
                    duration_hours=forced_duration_hours,
                    solar_kwh=forced_solar_kwh,
                    baseline_house_kwh=forced_house_kwh,
                    remaining_energy_kwh=remaining_energy_kwh,
                    target_energy_kwh=target_energy_kwh,
                    live_state=live_state,
                    settings=settings,
                )
            )
            stop_slot, remaining_after_stop = self._simulate_slot(
                slot_start=self._slot_end(slot_start, forced_duration_hours),
                duration_hours=duration_hours - forced_duration_hours,
                solar_kwh=solar_kwh - forced_solar_kwh,
                baseline_house_kwh=baseline_house_kwh - forced_house_kwh,
                remaining_energy_kwh=remaining_after_forced,
                live_state=live_state,
                settings=settings,
                action_kind=SCHEDULE_ACTION_STOP_CHARGING,
            )
            return (
                self._merge_phase_slots(
                    slot_start=slot_start,
                    duration_hours=duration_hours,
                    solar_kwh=solar_kwh,
                    baseline_house_kwh=baseline_house_kwh,
                    remaining_energy_kwh=remaining_after_stop,
                    live_state=live_state,
                    phase_slots=(forced_slot, stop_slot),
                ),
                remaining_after_stop,
            )

        return self._simulate_forced_discharge_phase(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            target_energy_kwh=target_energy_kwh,
            live_state=live_state,
            settings=settings,
        )

    def _simulate_forced_charge_phase(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        target_energy_kwh: float,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
    ) -> tuple[dict[str, Any], float]:
        energy_before_kwh = remaining_energy_kwh
        headroom_to_target_kwh = max(0.0, target_energy_kwh - energy_before_kwh)
        input_needed_for_target_kwh = (
            headroom_to_target_kwh / settings.charge_efficiency
            if headroom_to_target_kwh > _EPSILON
            else 0.0
        )
        max_charge_input_kwh = (settings.max_charge_power_w / 1000) * duration_hours
        actual_charge_input_kwh = min(
            input_needed_for_target_kwh,
            max_charge_input_kwh,
        )
        charged_kwh = min(
            headroom_to_target_kwh,
            actual_charge_input_kwh * settings.charge_efficiency,
        )
        net_kwh = solar_kwh - baseline_house_kwh
        solar_surplus_kwh = max(0.0, net_kwh)
        grid_for_house_kwh = max(0.0, -net_kwh)
        solar_to_battery_input_kwh = min(solar_surplus_kwh, actual_charge_input_kwh)
        grid_to_battery_input_kwh = max(
            0.0,
            actual_charge_input_kwh - solar_to_battery_input_kwh,
        )
        imported_from_grid_kwh = grid_for_house_kwh + grid_to_battery_input_kwh
        exported_to_grid_kwh = max(
            0.0,
            solar_surplus_kwh - solar_to_battery_input_kwh,
        )
        remaining_energy_kwh = min(
            live_state.max_energy_kwh,
            energy_before_kwh + charged_kwh,
        )

        return (
            self._make_simulated_slot_payload(
                slot_start=slot_start,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                charged_kwh=charged_kwh,
                discharged_kwh=0.0,
                remaining_energy_kwh=remaining_energy_kwh,
                imported_from_grid_kwh=imported_from_grid_kwh,
                exported_to_grid_kwh=exported_to_grid_kwh,
                hit_min_soc=(
                    remaining_energy_kwh - live_state.min_energy_kwh
                ) <= _EPSILON,
                hit_max_soc=(
                    live_state.max_energy_kwh - remaining_energy_kwh
                ) <= _EPSILON,
                limited_by_charge_power=(
                    input_needed_for_target_kwh - max_charge_input_kwh
                ) > _EPSILON,
                limited_by_discharge_power=False,
                soc_pct=self._calculate_soc_pct(
                    remaining_energy_kwh,
                    live_state.nominal_capacity_kwh,
                ),
            ),
            remaining_energy_kwh,
        )

    def _simulate_forced_discharge_phase(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        target_energy_kwh: float,
        live_state: BatteryLiveState,
        settings: BatteryForecastSettings,
    ) -> tuple[dict[str, Any], float]:
        energy_before_kwh = remaining_energy_kwh
        energy_above_target_kwh = max(0.0, energy_before_kwh - target_energy_kwh)
        output_available_to_target_kwh = (
            energy_above_target_kwh * settings.discharge_efficiency
        )
        max_discharge_output_kwh = (
            settings.max_discharge_power_w / 1000
        ) * duration_hours
        actual_discharge_output_kwh = min(
            output_available_to_target_kwh,
            max_discharge_output_kwh,
        )
        discharged_kwh = (
            actual_discharge_output_kwh / settings.discharge_efficiency
            if actual_discharge_output_kwh > _EPSILON
            else 0.0
        )
        net_kwh = solar_kwh - baseline_house_kwh
        deficit_after_solar_kwh = max(0.0, -net_kwh)
        solar_surplus_kwh = max(0.0, net_kwh)
        imported_from_grid_kwh = max(
            0.0,
            deficit_after_solar_kwh - actual_discharge_output_kwh,
        )
        exported_to_grid_kwh = solar_surplus_kwh + max(
            0.0,
            actual_discharge_output_kwh - deficit_after_solar_kwh,
        )
        remaining_energy_kwh = max(
            live_state.min_energy_kwh,
            energy_before_kwh - discharged_kwh,
        )

        return (
            self._make_simulated_slot_payload(
                slot_start=slot_start,
                duration_hours=duration_hours,
                solar_kwh=solar_kwh,
                baseline_house_kwh=baseline_house_kwh,
                charged_kwh=0.0,
                discharged_kwh=discharged_kwh,
                remaining_energy_kwh=remaining_energy_kwh,
                imported_from_grid_kwh=imported_from_grid_kwh,
                exported_to_grid_kwh=exported_to_grid_kwh,
                hit_min_soc=(
                    remaining_energy_kwh - live_state.min_energy_kwh
                ) <= _EPSILON,
                hit_max_soc=(
                    live_state.max_energy_kwh - remaining_energy_kwh
                ) <= _EPSILON,
                limited_by_charge_power=False,
                limited_by_discharge_power=(
                    output_available_to_target_kwh - max_discharge_output_kwh
                ) > _EPSILON,
                soc_pct=self._calculate_soc_pct(
                    remaining_energy_kwh,
                    live_state.nominal_capacity_kwh,
                ),
            ),
            remaining_energy_kwh,
        )

    def _merge_phase_slots(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        remaining_energy_kwh: float,
        live_state: BatteryLiveState,
        phase_slots: tuple[dict[str, Any], dict[str, Any]],
    ) -> dict[str, Any]:
        charged_kwh = sum(slot["chargedKwh"] for slot in phase_slots)
        discharged_kwh = sum(slot["dischargedKwh"] for slot in phase_slots)
        imported_from_grid_kwh = sum(
            slot["importedFromGridKwh"] for slot in phase_slots
        )
        exported_to_grid_kwh = sum(slot["exportedToGridKwh"] for slot in phase_slots)

        return self._make_simulated_slot_payload(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            charged_kwh=charged_kwh,
            discharged_kwh=discharged_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            imported_from_grid_kwh=imported_from_grid_kwh,
            exported_to_grid_kwh=exported_to_grid_kwh,
            hit_min_soc=(remaining_energy_kwh - live_state.min_energy_kwh) <= _EPSILON,
            hit_max_soc=(
                live_state.max_energy_kwh - remaining_energy_kwh
            ) <= _EPSILON,
            limited_by_charge_power=any(
                slot["limitedByChargePower"] for slot in phase_slots
            ),
            limited_by_discharge_power=any(
                slot["limitedByDischargePower"] for slot in phase_slots
            ),
            soc_pct=self._calculate_soc_pct(
                remaining_energy_kwh,
                live_state.nominal_capacity_kwh,
            ),
        )

    def _make_simulated_slot_payload(
        self,
        *,
        slot_start: datetime,
        duration_hours: float,
        solar_kwh: float,
        baseline_house_kwh: float,
        charged_kwh: float,
        discharged_kwh: float,
        remaining_energy_kwh: float,
        imported_from_grid_kwh: float,
        exported_to_grid_kwh: float,
        hit_min_soc: bool,
        hit_max_soc: bool,
        limited_by_charge_power: bool,
        limited_by_discharge_power: bool,
        soc_pct: float,
    ) -> dict[str, Any]:
        return {
            "timestamp": slot_start.isoformat(),
            "durationHours": round(duration_hours, 4),
            "solarKwh": self._round_energy(solar_kwh),
            "baselineHouseKwh": self._round_energy(baseline_house_kwh),
            "netKwh": self._round_energy(solar_kwh - baseline_house_kwh),
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
        }

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
    def _calculate_soc_pct(
        remaining_energy_kwh: float,
        nominal_capacity_kwh: float,
    ) -> float:
        return (remaining_energy_kwh / nominal_capacity_kwh) * 100

    @staticmethod
    def _get_slot_fraction(duration_hours: float) -> float:
        return duration_hours / _CANONICAL_SLOT_HOURS

    @staticmethod
    def _split_slot_value(
        *,
        total_value: float,
        total_duration_hours: float,
        partial_duration_hours: float,
    ) -> float:
        if total_duration_hours <= _EPSILON:
            return 0.0
        partial_fraction = min(
            1.0,
            max(0.0, partial_duration_hours / total_duration_hours),
        )
        return total_value * partial_fraction

    @staticmethod
    def _target_energy_kwh(
        *,
        target_soc: int,
        live_state: BatteryLiveState,
    ) -> float:
        target_energy_kwh = (live_state.nominal_capacity_kwh * target_soc) / 100
        return min(
            live_state.max_energy_kwh,
            max(live_state.min_energy_kwh, target_energy_kwh),
        )

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
            "resolution": get_forecast_resolution(
                FORECAST_CANONICAL_GRANULARITY_MINUTES
            ),
            "horizonHours": horizon_hours,
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
        if baseline_series is not None:
            payload["baselineSeries"] = baseline_series
        if schedule_adjusted is not None:
            payload["scheduleAdjusted"] = schedule_adjusted
            payload["scheduleAdjustmentCoverageUntil"] = (
                schedule_adjustment_coverage_until
            )
        return payload

    @staticmethod
    def _is_supported_schedule_action(action_kind: str) -> bool:
        return action_kind in {
            SCHEDULE_ACTION_NORMAL,
            SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
            SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
            SCHEDULE_ACTION_STOP_CHARGING,
            SCHEDULE_ACTION_STOP_DISCHARGING,
        }

    @staticmethod
    def _require_target_soc(action: ScheduleAction) -> int:
        if action.target_soc is None:
            raise ValueError(f"Action '{action.kind}' requires target_soc")
        return action.target_soc

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
