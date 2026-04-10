from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

if TYPE_CHECKING:
    from .schedule import ScheduleAction, ScheduleActionDict

ScheduleExecutionReason = Literal["scheduled", "target_soc_reached"]
ScheduleRuntimeState = Literal["applied", "error"]
RuntimeActionKind = Literal["apply", "slot_stop", "noop"]
RuntimeOutcome = Literal["success", "failed", "skipped"]


class InverterRuntimeDict(TypedDict):
    actionKind: RuntimeActionKind
    outcome: RuntimeOutcome
    executedAction: NotRequired["ScheduleActionDict"]
    reason: NotRequired[ScheduleExecutionReason]
    errorCode: NotRequired[str]
    message: NotRequired[str]


class ApplianceRuntimeDict(TypedDict):
    actionKind: RuntimeActionKind
    outcome: RuntimeOutcome
    errorCode: NotRequired[str]
    message: NotRequired[str]
    updatedAt: NotRequired[str]


class ActiveSlotRuntimeBranchDict(TypedDict):
    appliances: dict[str, ApplianceRuntimeDict]
    inverter: NotRequired[InverterRuntimeDict]
    reconciledAt: NotRequired[str]


class ScheduleRuntimeDict(TypedDict):
    activeSlotId: str
    appliances: dict[str, ApplianceRuntimeDict]
    inverter: NotRequired[InverterRuntimeDict]
    reconciledAt: NotRequired[str]


@dataclass(frozen=True)
class InverterRuntimeStatus:
    action_kind: RuntimeActionKind
    outcome: RuntimeOutcome
    executed_action: "ScheduleAction | None" = None
    reason: ScheduleExecutionReason | None = None
    error_code: str | None = None
    message: str | None = None


@dataclass(frozen=True)
class ApplianceRuntimeStatus:
    action_kind: RuntimeActionKind
    outcome: RuntimeOutcome
    error_code: str | None = None
    message: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class ActiveSlotRuntimeStatus:
    inverter: InverterRuntimeStatus | None = None
    appliances: dict[str, ApplianceRuntimeStatus] = field(default_factory=dict)
    reconciled_at: str | None = None

    @classmethod
    def from_inverter(
        cls,
        *,
        action_kind: RuntimeActionKind,
        outcome: RuntimeOutcome,
        executed_action: "ScheduleAction | None" = None,
        reason: ScheduleExecutionReason | None = None,
        error_code: str | None = None,
        message: str | None = None,
        reconciled_at: str | None = None,
    ) -> "ActiveSlotRuntimeStatus":
        return cls(
            inverter=InverterRuntimeStatus(
                action_kind=action_kind,
                outcome=outcome,
                executed_action=executed_action,
                reason=reason,
                error_code=error_code,
                message=message,
            ),
            appliances={},
            reconciled_at=reconciled_at,
        )

    @property
    def status(self) -> ScheduleRuntimeState:
        if self.inverter is not None and self.inverter.outcome == "failed":
            return "error"
        if any(runtime.outcome == "failed" for runtime in self.appliances.values()):
            return "error"
        return "applied"

    @property
    def executed_action(self) -> "ScheduleAction | None":
        return None if self.inverter is None else self.inverter.executed_action

    @property
    def reason(self) -> ScheduleExecutionReason | None:
        return None if self.inverter is None else self.inverter.reason

    @property
    def error_code(self) -> str | None:
        return None if self.inverter is None else self.inverter.error_code


SlotRuntimeStatus = ActiveSlotRuntimeStatus


@dataclass(frozen=True)
class ScheduleExecutionStatus:
    active_slot_id: str | None = None
    active_slot_runtime: ActiveSlotRuntimeStatus | None = None


def active_slot_runtime_to_dict(
    runtime: ActiveSlotRuntimeStatus,
) -> ActiveSlotRuntimeBranchDict:
    payload: ActiveSlotRuntimeBranchDict = {
        "appliances": {
            appliance_id: _appliance_runtime_to_dict(appliance_runtime)
            for appliance_id, appliance_runtime in runtime.appliances.items()
        }
    }
    if runtime.inverter is not None:
        payload["inverter"] = _inverter_runtime_to_dict(runtime.inverter)
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
        "appliances": runtime["appliances"],
    }
    if "inverter" in runtime:
        payload["inverter"] = runtime["inverter"]
    if "reconciledAt" in runtime:
        payload["reconciledAt"] = runtime["reconciledAt"]
    return payload


def _inverter_runtime_to_dict(
    runtime: InverterRuntimeStatus,
) -> InverterRuntimeDict:
    payload: InverterRuntimeDict = {
        "actionKind": runtime.action_kind,
        "outcome": runtime.outcome,
    }
    if runtime.executed_action is not None:
        payload["executedAction"] = _schedule_action_to_dict(runtime.executed_action)
    if runtime.reason is not None:
        payload["reason"] = runtime.reason
    if runtime.error_code is not None:
        payload["errorCode"] = runtime.error_code
    if runtime.message is not None:
        payload["message"] = runtime.message
    return payload


def _schedule_action_to_dict(action: "ScheduleAction") -> "ScheduleActionDict":
    payload: ScheduleActionDict = {"kind": action.kind}
    if action.target_soc is not None:
        payload["targetSoc"] = action.target_soc
    if action.set_by is not None:
        payload["setBy"] = action.set_by
    return payload


def _appliance_runtime_to_dict(
    runtime: ApplianceRuntimeStatus,
) -> ApplianceRuntimeDict:
    payload: ApplianceRuntimeDict = {
        "actionKind": runtime.action_kind,
        "outcome": runtime.outcome,
    }
    if runtime.error_code is not None:
        payload["errorCode"] = runtime.error_code
    if runtime.message is not None:
        payload["message"] = runtime.message
    if runtime.updated_at is not None:
        payload["updatedAt"] = runtime.updated_at
    return payload
