from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

if TYPE_CHECKING:
    from .schedule import ScheduleAction, ScheduleActionDict

ScheduleExecutionReason = Literal["scheduled", "target_soc_reached"]
ScheduleRuntimeState = Literal["applied", "error"]


class ActiveSlotRuntimeDict(TypedDict):
    status: ScheduleRuntimeState
    executedAction: NotRequired["ScheduleActionDict"]
    reason: NotRequired[ScheduleExecutionReason]
    errorCode: NotRequired[str]


@dataclass(frozen=True)
class ActiveSlotRuntimeStatus:
    status: ScheduleRuntimeState
    executed_action: "ScheduleAction | None" = None
    reason: ScheduleExecutionReason | None = None
    error_code: str | None = None


@dataclass(frozen=True)
class ScheduleExecutionStatus:
    active_slot_id: str | None = None
    active_slot_runtime: ActiveSlotRuntimeStatus | None = None


def active_slot_runtime_to_dict(
    runtime: ActiveSlotRuntimeStatus,
) -> ActiveSlotRuntimeDict:
    from .schedule import action_to_dict

    payload: ActiveSlotRuntimeDict = {"status": runtime.status}
    if runtime.executed_action is not None:
        payload["executedAction"] = action_to_dict(runtime.executed_action)
    if runtime.reason is not None:
        payload["reason"] = runtime.reason
    if runtime.error_code is not None:
        payload["errorCode"] = runtime.error_code
    return payload
