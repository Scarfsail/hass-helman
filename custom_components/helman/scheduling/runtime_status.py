from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

from ..controllables.config import CONTROLLABLE_ID_INVERTER

if TYPE_CHECKING:
    from .schedule import ScheduleAction, ScheduleActionDict

ScheduleExecutionReason = Literal["scheduled", "target_soc_reached"]
RuntimeActionKind = Literal["apply", "slot_stop", "noop"]
RuntimeOutcome = Literal["success", "failed", "skipped"]


class ControllableRuntimeDict(TypedDict):
    actionKind: RuntimeActionKind
    outcome: RuntimeOutcome
    executedAction: NotRequired["ScheduleActionDict"]
    reason: NotRequired[ScheduleExecutionReason]
    errorCode: NotRequired[str]
    message: NotRequired[str]
    updatedAt: NotRequired[str]


class ActiveSlotRuntimeBranchDict(TypedDict):
    controllables: dict[str, ControllableRuntimeDict]
    reconciledAt: NotRequired[str]


class ScheduleRuntimeDict(TypedDict):
    activeSlotId: str
    controllables: dict[str, ControllableRuntimeDict]
    reconciledAt: NotRequired[str]


@dataclass(frozen=True)
class ControllableRuntimeStatus:
    action_kind: RuntimeActionKind
    outcome: RuntimeOutcome
    executed_action: "ScheduleAction | None" = None
    reason: ScheduleExecutionReason | None = None
    error_code: str | None = None
    message: str | None = None
    updated_at: str | None = None


InverterRuntimeStatus = ControllableRuntimeStatus


@dataclass(frozen=True)
class ActiveSlotRuntimeStatus:
    inverter: ControllableRuntimeStatus | None = None
    appliances: dict[str, ControllableRuntimeStatus] = field(default_factory=dict)
    reconciled_at: str | None = None

    @property
    def executed_action(self) -> "ScheduleAction | None":
        return None if self.inverter is None else self.inverter.executed_action


@dataclass(frozen=True)
class ScheduleExecutionStatus:
    active_slot_id: str | None = None
    active_slot_runtime: ActiveSlotRuntimeStatus | None = None


def controllable_runtime_to_dict(
    runtime: ControllableRuntimeStatus,
) -> ControllableRuntimeDict:
    # Deferred: ``schedule`` reaches this module through the appliance drivers.
    from .schedule import action_to_dict

    payload: ControllableRuntimeDict = {
        "actionKind": runtime.action_kind,
        "outcome": runtime.outcome,
    }
    if runtime.executed_action is not None:
        payload["executedAction"] = action_to_dict(runtime.executed_action)
    if runtime.reason is not None:
        payload["reason"] = runtime.reason
    if runtime.error_code is not None:
        payload["errorCode"] = runtime.error_code
    if runtime.message is not None:
        payload["message"] = runtime.message
    if runtime.updated_at is not None:
        payload["updatedAt"] = runtime.updated_at
    return payload


def active_slot_runtime_to_dict(
    runtime: ActiveSlotRuntimeStatus,
) -> ActiveSlotRuntimeBranchDict:
    controllables: dict[str, ControllableRuntimeDict] = {
        appliance_id: controllable_runtime_to_dict(appliance_runtime)
        for appliance_id, appliance_runtime in runtime.appliances.items()
    }
    if runtime.inverter is not None:
        controllables[CONTROLLABLE_ID_INVERTER] = controllable_runtime_to_dict(
            runtime.inverter
        )
    payload: ActiveSlotRuntimeBranchDict = {"controllables": controllables}
    if runtime.reconciled_at is not None:
        payload["reconciledAt"] = runtime.reconciled_at
    return payload


def schedule_execution_status_to_dict(
    execution_status: ScheduleExecutionStatus,
) -> ScheduleRuntimeDict | None:
    if (
        execution_status.active_slot_id is None
        or execution_status.active_slot_runtime is None
    ):
        return None

    runtime = active_slot_runtime_to_dict(execution_status.active_slot_runtime)
    payload: ScheduleRuntimeDict = {
        "activeSlotId": execution_status.active_slot_id,
        "controllables": runtime["controllables"],
    }
    if "reconciledAt" in runtime:
        payload["reconciledAt"] = runtime["reconciledAt"]
    return payload
