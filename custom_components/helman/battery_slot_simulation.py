"""The battery physics for one forecast slot, as pure functions.

Extracted verbatim from :class:`BatteryCapacityForecastBuilder`, which still
owns everything *around* the simulation — reading config, assembling slot
inputs, stitching the series, shaping the payload — and calls in here for the
step itself.

The extraction exists because a second caller needs the same step. An optimizer
that has to answer "what would placing this appliance here do to the battery"
cannot reimplement the physics: two copies of a charge/discharge model drift
silently, and the disagreement would surface as an optimizer whose reasoning
contradicts the rails, the inspector and its own ``min_soc_pct`` condition. The
whole subtree already touched no instance state, so this is a move, not a
rewrite.

Everything here is pure: given the same inputs it returns the same slot payload
and the same end-of-slot energy, and it never reads ``hass``, the recorder or
the config.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .battery_state import BatteryForecastSettings, BatteryLiveState
from .const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_EMPTY,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
)
from .scheduling.action_resolution import resolve_executed_schedule_action
from .scheduling.schedule import ScheduleAction

EPSILON = 1e-9


@dataclass(frozen=True)
class ScheduleActionSimulationResult:
    slot: dict[str, Any]
    remaining_energy_kwh: float
    effective_action_kind: str


def simulate_schedule_action_slot(
    *,
    slot_start: datetime,
    duration_hours: float,
    solar_kwh: float,
    baseline_house_kwh: float,
    remaining_energy_kwh: float,
    live_state: BatteryLiveState,
    settings: BatteryForecastSettings,
    action: ScheduleAction,
) -> ScheduleActionSimulationResult:
    """One slot under one scheduled inverter action.

    The action is first resolved against the slot's *entry* SoC, because a
    target-SoC action that has already been reached executes as something else.
    """
    current_soc = calculate_soc_pct(
        remaining_energy_kwh,
        live_state.nominal_capacity_kwh,
    )
    effective_action = resolve_executed_schedule_action(
        action=action,
        current_soc=current_soc,
    ).executed_action

    if effective_action.kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC:
        slot, remaining_energy_kwh = _simulate_charge_to_target_slot(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            live_state=live_state,
            settings=settings,
            target_soc=_require_target_soc(effective_action),
        )
    elif effective_action.kind == SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC:
        slot, remaining_energy_kwh = _simulate_discharge_to_target_slot(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            live_state=live_state,
            settings=settings,
            target_soc=_require_target_soc(effective_action),
        )
    else:
        slot, remaining_energy_kwh = simulate_slot(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            live_state=live_state,
            settings=settings,
            action_kind=effective_action.kind,
        )

    return ScheduleActionSimulationResult(
        slot=slot,
        remaining_energy_kwh=remaining_energy_kwh,
        effective_action_kind=effective_action.kind,
    )


def simulate_slot(
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
    """One slot of plain self-consumption, optionally inhibited by an action."""
    energy_before_kwh = remaining_energy_kwh
    net_kwh = solar_kwh - baseline_house_kwh
    charged_kwh = 0.0
    discharged_kwh = 0.0
    imported_from_grid_kwh = 0.0
    exported_to_grid_kwh = 0.0
    available_surplus_kwh = 0.0
    limited_by_charge_power = False
    limited_by_discharge_power = False

    if net_kwh > EPSILON:
        if action_kind == SCHEDULE_ACTION_STOP_CHARGING:
            exported_to_grid_kwh = net_kwh
            available_surplus_kwh = net_kwh
        else:
            max_charge_input_kwh = (
                settings.max_charge_power_w / 1000
            ) * duration_hours
            headroom_kwh = max(0.0, live_state.max_energy_kwh - energy_before_kwh)
            input_needed_for_headroom_kwh = (
                headroom_kwh / settings.charge_efficiency
                if headroom_kwh > EPSILON
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
            available_surplus_kwh = max(
                0.0,
                net_kwh - actual_charge_input_kwh,
            )
            exported_to_grid_kwh = (
                0.0
                if action_kind == SCHEDULE_ACTION_STOP_EXPORT
                else available_surplus_kwh
            )
            limited_by_charge_power = (
                desired_charge_input_kwh - max_charge_input_kwh
            ) > EPSILON
            remaining_energy_kwh = min(
                live_state.max_energy_kwh,
                energy_before_kwh + charged_kwh,
            )
    elif net_kwh < -EPSILON:
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
                if actual_discharge_output_kwh > EPSILON
                else 0.0
            )
            imported_from_grid_kwh = max(
                0.0, deficit_kwh - actual_discharge_output_kwh
            )
            limited_by_discharge_power = (
                desired_discharge_output_kwh - max_discharge_output_kwh
            ) > EPSILON
            remaining_energy_kwh = max(
                live_state.min_energy_kwh,
                energy_before_kwh - discharged_kwh,
            )

    soc_pct = (remaining_energy_kwh / live_state.nominal_capacity_kwh) * 100
    hit_min_soc = (remaining_energy_kwh - live_state.min_energy_kwh) <= EPSILON
    hit_max_soc = (live_state.max_energy_kwh - remaining_energy_kwh) <= EPSILON

    return (
        make_simulated_slot_payload(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            charged_kwh=charged_kwh,
            discharged_kwh=discharged_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            imported_from_grid_kwh=imported_from_grid_kwh,
            exported_to_grid_kwh=exported_to_grid_kwh,
            available_surplus_kwh=available_surplus_kwh,
            hit_min_soc=hit_min_soc,
            hit_max_soc=hit_max_soc,
            limited_by_charge_power=limited_by_charge_power,
            limited_by_discharge_power=limited_by_discharge_power,
            soc_pct=soc_pct,
        ),
        remaining_energy_kwh,
    )


def _simulate_charge_to_target_slot(
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
    target_energy_kwh = _target_energy_kwh(
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
        max_charge_power_kw > EPSILON
        and input_needed_for_target_kwh > EPSILON
        and input_needed_for_target_kwh < (max_charge_input_kwh - EPSILON)
    ):
        forced_duration_hours = input_needed_for_target_kwh / max_charge_power_kw
        forced_solar_kwh = _split_slot_value(
            total_value=solar_kwh,
            total_duration_hours=duration_hours,
            partial_duration_hours=forced_duration_hours,
        )
        forced_house_kwh = _split_slot_value(
            total_value=baseline_house_kwh,
            total_duration_hours=duration_hours,
            partial_duration_hours=forced_duration_hours,
        )
        forced_slot, remaining_after_forced = _simulate_forced_charge_phase(
            slot_start=slot_start,
            duration_hours=forced_duration_hours,
            solar_kwh=forced_solar_kwh,
            baseline_house_kwh=forced_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            target_energy_kwh=target_energy_kwh,
            live_state=live_state,
            settings=settings,
        )
        stop_slot, remaining_after_stop = simulate_slot(
            slot_start=slot_end(slot_start, forced_duration_hours),
            duration_hours=duration_hours - forced_duration_hours,
            solar_kwh=solar_kwh - forced_solar_kwh,
            baseline_house_kwh=baseline_house_kwh - forced_house_kwh,
            remaining_energy_kwh=remaining_after_forced,
            live_state=live_state,
            settings=settings,
            action_kind=SCHEDULE_ACTION_STOP_DISCHARGING,
        )
        return (
            _merge_phase_slots(
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

    return _simulate_forced_charge_phase(
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
    target_energy_kwh = _target_energy_kwh(
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
        max_discharge_power_kw > EPSILON
        and output_needed_for_target_kwh > EPSILON
        and output_needed_for_target_kwh < (max_discharge_output_kwh - EPSILON)
    ):
        forced_duration_hours = output_needed_for_target_kwh / max_discharge_power_kw
        forced_solar_kwh = _split_slot_value(
            total_value=solar_kwh,
            total_duration_hours=duration_hours,
            partial_duration_hours=forced_duration_hours,
        )
        forced_house_kwh = _split_slot_value(
            total_value=baseline_house_kwh,
            total_duration_hours=duration_hours,
            partial_duration_hours=forced_duration_hours,
        )
        forced_slot, remaining_after_forced = _simulate_forced_discharge_phase(
            slot_start=slot_start,
            duration_hours=forced_duration_hours,
            solar_kwh=forced_solar_kwh,
            baseline_house_kwh=forced_house_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            target_energy_kwh=target_energy_kwh,
            live_state=live_state,
            settings=settings,
        )
        stop_slot, remaining_after_stop = simulate_slot(
            slot_start=slot_end(slot_start, forced_duration_hours),
            duration_hours=duration_hours - forced_duration_hours,
            solar_kwh=solar_kwh - forced_solar_kwh,
            baseline_house_kwh=baseline_house_kwh - forced_house_kwh,
            remaining_energy_kwh=remaining_after_forced,
            live_state=live_state,
            settings=settings,
            action_kind=SCHEDULE_ACTION_STOP_CHARGING,
        )
        return (
            _merge_phase_slots(
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

    return _simulate_forced_discharge_phase(
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
        if headroom_to_target_kwh > EPSILON
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
    available_surplus_kwh = max(
        0.0,
        solar_surplus_kwh - solar_to_battery_input_kwh,
    )
    imported_from_grid_kwh = grid_for_house_kwh + grid_to_battery_input_kwh
    exported_to_grid_kwh = available_surplus_kwh
    remaining_energy_kwh = min(
        live_state.max_energy_kwh,
        energy_before_kwh + charged_kwh,
    )

    return (
        make_simulated_slot_payload(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            charged_kwh=charged_kwh,
            discharged_kwh=0.0,
            remaining_energy_kwh=remaining_energy_kwh,
            imported_from_grid_kwh=imported_from_grid_kwh,
            exported_to_grid_kwh=exported_to_grid_kwh,
            available_surplus_kwh=available_surplus_kwh,
            hit_min_soc=(
                remaining_energy_kwh - live_state.min_energy_kwh
            ) <= EPSILON,
            hit_max_soc=(
                live_state.max_energy_kwh - remaining_energy_kwh
            ) <= EPSILON,
            limited_by_charge_power=(
                input_needed_for_target_kwh - max_charge_input_kwh
            ) > EPSILON,
            limited_by_discharge_power=False,
            soc_pct=calculate_soc_pct(
                remaining_energy_kwh,
                live_state.nominal_capacity_kwh,
            ),
        ),
        remaining_energy_kwh,
    )


def _simulate_forced_discharge_phase(
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
        if actual_discharge_output_kwh > EPSILON
        else 0.0
    )
    net_kwh = solar_kwh - baseline_house_kwh
    deficit_after_solar_kwh = max(0.0, -net_kwh)
    solar_surplus_kwh = max(0.0, net_kwh)
    available_surplus_kwh = solar_surplus_kwh
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
        make_simulated_slot_payload(
            slot_start=slot_start,
            duration_hours=duration_hours,
            solar_kwh=solar_kwh,
            baseline_house_kwh=baseline_house_kwh,
            charged_kwh=0.0,
            discharged_kwh=discharged_kwh,
            remaining_energy_kwh=remaining_energy_kwh,
            imported_from_grid_kwh=imported_from_grid_kwh,
            exported_to_grid_kwh=exported_to_grid_kwh,
            available_surplus_kwh=available_surplus_kwh,
            hit_min_soc=(
                remaining_energy_kwh - live_state.min_energy_kwh
            ) <= EPSILON,
            hit_max_soc=(
                live_state.max_energy_kwh - remaining_energy_kwh
            ) <= EPSILON,
            limited_by_charge_power=False,
            limited_by_discharge_power=(
                output_available_to_target_kwh - max_discharge_output_kwh
            ) > EPSILON,
            soc_pct=calculate_soc_pct(
                remaining_energy_kwh,
                live_state.nominal_capacity_kwh,
            ),
        ),
        remaining_energy_kwh,
    )


def _merge_phase_slots(
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
    imported_from_grid_kwh = sum(slot["importedFromGridKwh"] for slot in phase_slots)
    exported_to_grid_kwh = sum(slot["exportedToGridKwh"] for slot in phase_slots)
    available_surplus_kwh = sum(slot["availableSurplusKwh"] for slot in phase_slots)

    return make_simulated_slot_payload(
        slot_start=slot_start,
        duration_hours=duration_hours,
        solar_kwh=solar_kwh,
        baseline_house_kwh=baseline_house_kwh,
        charged_kwh=charged_kwh,
        discharged_kwh=discharged_kwh,
        remaining_energy_kwh=remaining_energy_kwh,
        imported_from_grid_kwh=imported_from_grid_kwh,
        exported_to_grid_kwh=exported_to_grid_kwh,
        available_surplus_kwh=available_surplus_kwh,
        hit_min_soc=(remaining_energy_kwh - live_state.min_energy_kwh) <= EPSILON,
        hit_max_soc=(live_state.max_energy_kwh - remaining_energy_kwh) <= EPSILON,
        limited_by_charge_power=any(
            slot["limitedByChargePower"] for slot in phase_slots
        ),
        limited_by_discharge_power=any(
            slot["limitedByDischargePower"] for slot in phase_slots
        ),
        soc_pct=calculate_soc_pct(
            remaining_energy_kwh,
            live_state.nominal_capacity_kwh,
        ),
    )


def make_simulated_slot_payload(
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
    available_surplus_kwh: float,
    hit_min_soc: bool,
    hit_max_soc: bool,
    limited_by_charge_power: bool,
    limited_by_discharge_power: bool,
    soc_pct: float,
) -> dict[str, Any]:
    return {
        "timestamp": slot_start.isoformat(),
        "durationHours": round(duration_hours, 4),
        "solarKwh": round_energy(solar_kwh),
        "baselineHouseKwh": round_energy(baseline_house_kwh),
        "netKwh": round_energy(solar_kwh - baseline_house_kwh),
        "chargedKwh": round_energy(charged_kwh),
        "dischargedKwh": round_energy(discharged_kwh),
        "remainingEnergyKwh": round_energy(remaining_energy_kwh),
        "socPct": round(soc_pct, 2),
        "importedFromGridKwh": round_energy(imported_from_grid_kwh),
        "exportedToGridKwh": round_energy(exported_to_grid_kwh),
        "availableSurplusKwh": round_energy(available_surplus_kwh),
        "hitMinSoc": hit_min_soc,
        "hitMaxSoc": hit_max_soc,
        "limitedByChargePower": limited_by_charge_power,
        "limitedByDischargePower": limited_by_discharge_power,
    }


def slot_end(slot_start: datetime, duration_hours: float) -> datetime:
    return slot_start + timedelta(hours=duration_hours)


def round_energy(value: float) -> float:
    return round(value, 4)


def calculate_soc_pct(
    remaining_energy_kwh: float,
    nominal_capacity_kwh: float,
) -> float:
    return (remaining_energy_kwh / nominal_capacity_kwh) * 100


def is_supported_schedule_action(action_kind: str) -> bool:
    """Whether the simulator models this action, rather than giving up on it."""
    return action_kind in {
        SCHEDULE_ACTION_EMPTY,
        SCHEDULE_ACTION_NORMAL,
        SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
        SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
        SCHEDULE_ACTION_STOP_CHARGING,
        SCHEDULE_ACTION_STOP_DISCHARGING,
        SCHEDULE_ACTION_STOP_EXPORT,
    }


def is_baseline_schedule_action(action_kind: str) -> bool:
    """Whether the action leaves the trajectory identical to no schedule at all."""
    return action_kind in {SCHEDULE_ACTION_EMPTY, SCHEDULE_ACTION_NORMAL}


def _split_slot_value(
    *,
    total_value: float,
    total_duration_hours: float,
    partial_duration_hours: float,
) -> float:
    if total_duration_hours <= EPSILON:
        return 0.0
    partial_fraction = min(
        1.0,
        max(0.0, partial_duration_hours / total_duration_hours),
    )
    return total_value * partial_fraction


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


def _require_target_soc(action: ScheduleAction) -> int:
    if action.target_soc is None:
        raise ValueError(f"Action '{action.kind}' requires target_soc")
    return action.target_soc
