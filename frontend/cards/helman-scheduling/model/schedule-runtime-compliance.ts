import type { LocalizeFunction } from "../../localize/localize";
import type { RuntimeActionKind, RuntimeOutcome } from "../../helman-api";
import { getScheduleApplianceById, type ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import { getScheduleApplianceActionPresentation } from "./schedule-appliance-action-presentation";
import {
    getScheduleActionLabel,
    getScheduleErrorLabel,
    getScheduleReasonLabel,
} from "./schedule-labels";
import type {
    ScheduleApplianceAction,
    ScheduleApplianceRuntime,
    ScheduleInverterRuntime,
    ScheduleSlot,
} from "../schedule-types";
import {
    areScheduleActionsEqual,
    isScheduleApplianceActionEnabled,
    isTargetScheduleAction,
} from "../schedule-types";

export type ScheduleRuntimeComplianceState =
    | "execution_disabled"
    | "runtime_unavailable"
    | "on_plan"
    | "off_plan";

export type ScheduleRuntimeComplianceSeverity = "success" | "warning" | "error";

export interface ScheduleRuntimeComplianceIssue {
    key: string;
    actorLabel: string;
    actualLabel: string;
    reasonLabel: string | null;
}

export interface ScheduleRuntimeComplianceModel {
    state: ScheduleRuntimeComplianceState;
    severity: ScheduleRuntimeComplianceSeverity;
    icon: string;
    summaryLabel: string;
    issues: ScheduleRuntimeComplianceIssue[];
}

export function buildScheduleRuntimeComplianceModel({
    slot,
    appliances,
    executionEnabled,
    localize,
}: {
    slot: ScheduleSlot;
    appliances: readonly ScheduleApplianceMetadata[];
    executionEnabled: boolean;
    localize: LocalizeFunction;
}): ScheduleRuntimeComplianceModel {
    if (!executionEnabled) {
        return {
            state: "execution_disabled",
            severity: "warning",
            icon: "mdi:pause-circle-outline",
            summaryLabel: localize("scheduling.now.execution_disabled"),
            issues: [],
        };
    }

    if (slot.runtime === null) {
        return {
            state: "runtime_unavailable",
            severity: "warning",
            icon: "mdi:help-circle-outline",
            summaryLabel: localize("scheduling.now.runtime_unavailable"),
            issues: [],
        };
    }

    const issues: ScheduleRuntimeComplianceIssue[] = [];
    const inverterIssue = _buildInverterIssue({
        slot,
        runtime: slot.runtime.inverter,
        localize,
    });
    if (inverterIssue) {
        issues.push(inverterIssue);
    }

    const applianceIds = new Set([
        ...Object.keys(slot.assignments.appliances),
        ...Object.keys(slot.runtime.appliances),
    ]);
    const applianceOrder = new Map(
        appliances.map((appliance) => [appliance.id, appliance.order] as const),
    );
    const sortedApplianceIds = [...applianceIds].sort((leftId, rightId) => {
        const leftOrder = applianceOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = applianceOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
        }
        return leftId.localeCompare(rightId);
    });
    for (const applianceId of sortedApplianceIds) {
        const appliance = getScheduleApplianceById(appliances, applianceId);
        const plannedAction = slot.assignments.appliances[applianceId]?.action ?? null;
        const runtime = slot.runtime.appliances[applianceId] ?? null;
        if (plannedAction === null) {
            const unexpectedIssue = runtime
                ? _buildUnexpectedApplianceIssue({
                    applianceId,
                    appliance,
                    runtime,
                    localize,
                })
                : null;
            if (unexpectedIssue) {
                issues.push(unexpectedIssue);
            }
            continue;
        }

        const applianceIssue = _buildApplianceIssue({
            applianceId,
            appliance,
            plannedAction,
            runtime,
            localize,
        });
        if (applianceIssue) {
            issues.push(applianceIssue);
        }
    }

    if (issues.length === 0) {
        return {
            state: "on_plan",
            severity: "success",
            icon: "mdi:check-circle-outline",
            summaryLabel: localize("scheduling.now.compliance_ok"),
            issues: [],
        };
    }

    return {
        state: "off_plan",
        severity: "error",
        icon: "mdi:alert-circle-outline",
        summaryLabel: localize("scheduling.now.compliance_off"),
        issues,
    };
}

function _buildInverterIssue({
    slot,
    runtime,
    localize,
}: {
    slot: ScheduleSlot;
    runtime: ScheduleInverterRuntime | null;
    localize: LocalizeFunction;
}): ScheduleRuntimeComplianceIssue | null {
    const actorLabel = localize("scheduling.now.actor.inverter");
    const expectedLabel = getScheduleActionLabel(slot.assignments.inverter.action, localize);
    if (runtime === null) {
        return _createIssue({
            key: "inverter:missing",
            actorLabel,
            actualLabel: localize("scheduling.now.actual.status_unavailable"),
            reasonLabel: _buildExpectedReason(expectedLabel, localize),
        });
    }

    if (runtime.outcome === "failed") {
        return _createIssue({
            key: "inverter:failed",
            actorLabel,
            actualLabel: localize("scheduling.now.actual.failed"),
            reasonLabel: _buildFailureReason(runtime.errorCode, runtime.message, localize),
        });
    }

    const isSkippedNoop = runtime.actionKind === "noop" && runtime.outcome === "skipped";
    if (slot.assignments.inverter.action.kind === "empty" && isSkippedNoop) {
        return null;
    }

    if (
        slot.assignments.inverter.action.kind === "empty"
        && (runtime.actionKind === "slot_stop" || runtime.actionKind === "apply")
        && runtime.outcome === "success"
        && runtime.executedAction?.kind === "normal"
    ) {
        return null;
    }

    if (runtime.executedAction) {
        if (areScheduleActionsEqual(slot.assignments.inverter.action, runtime.executedAction)) {
            return null;
        }

        return _createIssue({
            key: `inverter:executed:${runtime.executedAction.kind}`,
            actorLabel,
            actualLabel: getScheduleActionLabel(runtime.executedAction, localize),
            reasonLabel: _buildExpectedReason(expectedLabel, localize),
        });
    }

    if (runtime.actionKind === "apply" && runtime.outcome === "success") {
        return null;
    }

    if (runtime.reason === "scheduled") {
        return null;
    }

    if (
        runtime.reason === "target_soc_reached"
        && isTargetScheduleAction(slot.assignments.inverter.action)
    ) {
        return null;
    }

    return _createIssue({
        key: `inverter:${runtime.reason ?? runtime.actionKind}:${runtime.outcome}`,
        actorLabel,
        actualLabel: _getActualStatusLabel({
            actionKind: runtime.actionKind,
            outcome: runtime.outcome,
            reason: runtime.reason,
            localize,
        }),
        reasonLabel: _buildExpectedReason(expectedLabel, localize),
    });
}

function _buildApplianceIssue({
    applianceId,
    appliance,
    plannedAction,
    runtime,
    localize,
}: {
    applianceId: string;
    appliance: ScheduleApplianceMetadata | null;
    plannedAction: ScheduleApplianceAction | null;
    runtime: ScheduleApplianceRuntime | null;
    localize: LocalizeFunction;
}): ScheduleRuntimeComplianceIssue | null {
    const actorLabel = appliance?.name ?? applianceId;
    const expectedLabel = _getExpectedApplianceLabel(appliance, plannedAction, localize);
    if (runtime === null) {
        return _createIssue({
            key: `${applianceId}:missing`,
            actorLabel,
            actualLabel: localize("scheduling.now.actual.status_unavailable"),
            reasonLabel: _buildExpectedReason(expectedLabel, localize),
        });
    }

    if (runtime.outcome === "failed") {
        return _createIssue({
            key: `${applianceId}:failed`,
            actorLabel,
            actualLabel: localize("scheduling.now.actual.failed"),
            reasonLabel: _buildFailureReason(runtime.errorCode, runtime.message, localize),
        });
    }

    const plannedEnabled = isScheduleApplianceActionEnabled(plannedAction) === true;
    const isSkippedNoop = runtime.outcome === "skipped" && runtime.actionKind === "noop";
    if (plannedEnabled && runtime.actionKind === "slot_stop") {
        return _createIssue({
            key: `${applianceId}:stopped`,
            actorLabel,
            actualLabel: localize("scheduling.now.actual.stopped"),
            reasonLabel: _buildExpectedReason(expectedLabel, localize),
        });
    }

    if (plannedEnabled && runtime.actionKind === "apply" && runtime.outcome === "success") {
        return null;
    }

    if (plannedEnabled && isSkippedNoop) {
        return null;
    }

    if (!plannedEnabled && (runtime.outcome === "success" || isSkippedNoop || runtime.actionKind === "slot_stop")) {
        return null;
    }

    return _createIssue({
        key: `${applianceId}:${runtime.actionKind}:${runtime.outcome}`,
        actorLabel,
        actualLabel: _getActualStatusLabel({
            actionKind: runtime.actionKind,
            outcome: runtime.outcome,
            localize,
        }),
        reasonLabel: _buildExpectedReason(expectedLabel, localize),
    });
}

function _buildUnexpectedApplianceIssue({
    applianceId,
    appliance,
    runtime,
    localize,
}: {
    applianceId: string;
    appliance: ScheduleApplianceMetadata | null;
    runtime: ScheduleApplianceRuntime;
    localize: LocalizeFunction;
}): ScheduleRuntimeComplianceIssue | null {
    if (runtime.outcome !== "failed" && runtime.actionKind === "noop") {
        return null;
    }

    const reasonLabel = runtime.outcome === "failed"
        ? `${_buildFailureReason(runtime.errorCode, runtime.message, localize)} · ${localize("scheduling.now.detail.no_scheduled_action")}`
        : localize("scheduling.now.detail.no_scheduled_action");

    return _createIssue({
        key: `${applianceId}:unexpected`,
        actorLabel: appliance?.name ?? applianceId,
        actualLabel: _getActualStatusLabel({
            actionKind: runtime.actionKind,
            outcome: runtime.outcome,
            localize,
        }),
        reasonLabel,
    });
}

function _getExpectedApplianceLabel(
    appliance: ScheduleApplianceMetadata | null,
    action: ScheduleApplianceAction,
    localize: LocalizeFunction,
): string {
    return getScheduleApplianceActionPresentation({
        appliance: appliance ?? {
            id: "unknown",
            name: "unknown",
            kind: "unknown",
            icon: "mdi:flash-outline",
            order: 0,
            supportsAuthoring: false,
        },
        action,
        localize,
    }).label;
}

function _getActualStatusLabel({
    actionKind,
    outcome,
    reason,
    localize,
}: {
    actionKind: RuntimeActionKind;
    outcome: RuntimeOutcome;
    reason?: "scheduled" | "target_soc_reached";
    localize: LocalizeFunction;
}): string {
    const reasonLabel = getScheduleReasonLabel(reason, localize);
    if (reasonLabel) {
        return reasonLabel;
    }

    if (outcome === "failed") {
        return localize("scheduling.now.actual.failed");
    }

    if (actionKind === "slot_stop") {
        return localize("scheduling.now.actual.stopped");
    }

    if (actionKind === "noop" || outcome === "skipped") {
        return localize("scheduling.now.actual.no_change");
    }

    return localize("scheduling.now.actual.applied");
}

function _buildFailureReason(
    errorCode: string | undefined,
    message: string | undefined,
    localize: LocalizeFunction,
): string {
    return getScheduleErrorLabel({
        code: errorCode,
        fallbackMessage: message,
        localize,
    });
}

function _buildExpectedReason(expectedLabel: string, localize: LocalizeFunction): string {
    return `${localize("scheduling.now.detail.expected")} ${expectedLabel}`;
}

function _createIssue({
    key,
    actorLabel,
    actualLabel,
    reasonLabel,
}: ScheduleRuntimeComplianceIssue): ScheduleRuntimeComplianceIssue {
    return {
        key,
        actorLabel,
        actualLabel,
        reasonLabel,
    };
}
