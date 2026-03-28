from __future__ import annotations

from dataclasses import dataclass

from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
)
from .runtime_status import ScheduleExecutionReason
from .schedule import ScheduleAction, ScheduleExecutionUnavailableError


@dataclass(frozen=True)
class ScheduleActionResolution:
    executed_action: ScheduleAction
    reason: ScheduleExecutionReason


def resolve_executed_schedule_action(
    *,
    action: ScheduleAction,
    current_soc: float | None,
) -> ScheduleActionResolution:
    if action.kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC:
        target_soc = _require_target_soc(action)
        if current_soc is None:
            raise ScheduleExecutionUnavailableError(
                "Battery live state is required to execute target schedule actions"
            )
        if current_soc >= target_soc:
            return ScheduleActionResolution(
                executed_action=ScheduleAction(
                    kind=SCHEDULE_ACTION_STOP_DISCHARGING
                ),
                reason="target_soc_reached",
            )
        return ScheduleActionResolution(executed_action=action, reason="scheduled")

    if action.kind == SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC:
        target_soc = _require_target_soc(action)
        if current_soc is None:
            raise ScheduleExecutionUnavailableError(
                "Battery live state is required to execute target schedule actions"
            )
        if current_soc <= target_soc:
            return ScheduleActionResolution(
                executed_action=ScheduleAction(kind=SCHEDULE_ACTION_STOP_CHARGING),
                reason="target_soc_reached",
            )
        return ScheduleActionResolution(executed_action=action, reason="scheduled")

    return ScheduleActionResolution(executed_action=action, reason="scheduled")


def _require_target_soc(action: ScheduleAction) -> int:
    if action.target_soc is None:
        raise ValueError(f"Action '{action.kind}' requires target_soc")
    return action.target_soc
