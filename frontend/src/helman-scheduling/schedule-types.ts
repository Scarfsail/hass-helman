import type {
    ForecastGranularity,
    RuntimeActionKind,
    RuntimeOutcome,
    ScheduleApplianceActionDTO,
    ScheduleActionDTO,
    SchedulePayload,
    ScheduleRuntimeReason,
    ScheduleSetBy as ScheduleSetByDTO,
} from "../helman-api";

type WithoutSetBy<TValue> = TValue extends unknown ? Omit<TValue, "setBy"> : never;

export type ScheduleInverterAction = WithoutSetBy<ScheduleActionDTO>;
export type ScheduleAction = ScheduleInverterAction;
export type ScheduleActionKind = ScheduleInverterAction["kind"];
export type ScheduleApplianceAction = WithoutSetBy<ScheduleApplianceActionDTO>;
export type ScheduleEvChargerAction = Extract<ScheduleApplianceAction, { charge: boolean }>;
export type ScheduleGenericApplianceAction = Extract<ScheduleApplianceAction, { on: boolean }>;
export type ScheduleClimateApplianceAction = Extract<ScheduleApplianceAction, { mode: string }>;
export interface ScheduleDomains {
    inverter: ScheduleInverterAction;
    appliances: Record<string, ScheduleApplianceAction>;
}

export type ScheduleSetBy = ScheduleSetByDTO;

export interface ScheduleInverterAssignment {
    action: ScheduleInverterAction;
    setBy: ScheduleSetBy | null;
}

export interface ScheduleApplianceAssignment {
    action: ScheduleApplianceAction;
    setBy: ScheduleSetBy | null;
}

export interface ScheduleAssignments {
    inverter: ScheduleInverterAssignment;
    appliances: Record<string, ScheduleApplianceAssignment>;
}

export type ScheduleAuthorshipState = "none" | "user" | "automation" | "mixed";

export interface ScheduleActionAuthorshipSummary {
    state: ScheduleAuthorshipState;
    counts: {
        user: number;
        automation: number;
    };
}

export interface ScheduleRangeEditAuthorshipSummary {
    inverter: ScheduleActionAuthorshipSummary;
    appliances: Record<string, ScheduleActionAuthorshipSummary>;
}

export interface ScheduleInverterRuntime {
    actionKind: RuntimeActionKind;
    outcome: RuntimeOutcome;
    executedAction?: ScheduleInverterAction;
    reason?: ScheduleRuntimeReason;
    errorCode?: string;
    message?: string;
}

export interface ScheduleApplianceRuntime {
    actionKind: RuntimeActionKind;
    outcome: RuntimeOutcome;
    errorCode?: string;
    message?: string;
    updatedAt?: string;
}

export interface ScheduleRuntime {
    inverter: ScheduleInverterRuntime | null;
    appliances: Record<string, ScheduleApplianceRuntime>;
    reconciledAt?: string;
}

export interface ScheduleSlot {
    id: string;
    index: number;
    startMs: number;
    endMs: number | null;
    dayKey: string;
    timeLabel: string;
    endLabel: string | null;
    rangeLabel: string;
    assignments: ScheduleAssignments;
    runtime: ScheduleRuntime | null;
    isCurrent: boolean;
}

export interface ScheduleDisplaySlotBase {
    id: string;
    startMs: number;
    endMs: number | null;
    dayKey: string;
    timeLabel: string;
    endLabel: string | null;
    rangeLabel: string;
    isCurrent: boolean;
}

export interface ScheduleBackedDisplaySlot extends ScheduleDisplaySlotBase {
    source: "schedule";
    scheduleSlot: ScheduleSlot;
}

export interface ScheduleForecastOnlyDisplaySlot extends ScheduleDisplaySlotBase {
    source: "forecast_only";
    scheduleSlot: null;
}

export type ScheduleDisplaySlot =
    | ScheduleBackedDisplaySlot
    | ScheduleForecastOnlyDisplaySlot;

export interface ScheduleTimelineModel {
    slots: ScheduleDisplaySlot[];
    currentSlotId: string | null;
}

export interface ScheduleSlotDaySectionModel {
    dayKey: string;
    dayLabel: string;
    slots: ScheduleSlot[];
}

export interface ScheduleSlotToggleDetail {
    slotId: string;
    slotIds?: string[];
    shiftKey: boolean;
}

export interface ScheduleDialogOpenDetail {
    slotId: string;
    slotIds?: string[];
}

export interface ScheduleSelectionValueOption<TValue> {
    key: string;
    value: TValue;
    authorship: ScheduleActionAuthorshipSummary | null;
}

export interface ScheduleSelectionValueSummary<TValue> {
    state: "uniform" | "mixed";
    seedValue: TValue;
    distinctValues: ScheduleSelectionValueOption<TValue>[];
}

export interface ScheduleRangeEditSelectionSummary {
    inverter: ScheduleSelectionValueSummary<ScheduleAction>;
    appliances: Record<string, ScheduleSelectionValueSummary<ScheduleApplianceAction | null>>;
}

export interface ScheduleDialogState {
    selectedSlots: ScheduleSlot[];
    selectionSummary: ScheduleRangeEditSelectionSummary;
    authorshipSummary: ScheduleRangeEditAuthorshipSummary;
}

export type ScheduleInverterEditIntent =
    | { kind: "keep" }
    | { kind: "set_user"; action: ScheduleAction };

export type ScheduleApplianceEditIntent =
    | { kind: "keep" }
    | { kind: "set_user"; action: ScheduleApplianceAction }
    | { kind: "unset_user" };

export interface ScheduleRangeEditIntent {
    inverter: ScheduleInverterEditIntent;
    appliances: Record<string, ScheduleApplianceEditIntent>;
}

export interface ScheduleOwnerError {
    code: string | null;
    message: string;
}

export interface ScheduleOwnerSnapshot {
    schedule: SchedulePayload | null;
    loading: boolean;
    refreshing: boolean;
    writing: boolean;
    togglingExecution: boolean;
    error: ScheduleOwnerError | null;
    updatedAt: number | null;
    stale: boolean;
}

export interface NormalizedScheduleModel {
    slots: ScheduleSlot[];
    currentSlotId: string | null;
    currentDayKey: string | null;
    granularityMinutes: ForecastGranularity | null;
}

export interface ScheduleSlotPatch {
    id: string;
    domains: ScheduleDomains;
}

export function cloneScheduleInverterAction(action: ScheduleInverterAction): ScheduleInverterAction {
    return action.targetSoc === undefined
        ? { kind: action.kind }
        : { kind: action.kind, targetSoc: action.targetSoc };
}

export function cloneScheduleApplianceAction(
    action: ScheduleApplianceAction,
): ScheduleApplianceAction {
    return { ...action };
}

export function cloneScheduleDomains(domains: ScheduleDomains): ScheduleDomains {
    return {
        inverter: cloneScheduleInverterAction(domains.inverter),
        appliances: Object.fromEntries(
            Object.entries(domains.appliances).map(([applianceId, action]) => [
                applianceId,
                cloneScheduleApplianceAction(action),
            ]),
        ),
    };
}

export function cloneScheduleInverterRuntime(
    runtime: ScheduleInverterRuntime,
): ScheduleInverterRuntime {
    return {
        actionKind: runtime.actionKind,
        outcome: runtime.outcome,
        executedAction: runtime.executedAction
            ? cloneScheduleInverterAction(runtime.executedAction)
            : undefined,
        reason: runtime.reason,
        errorCode: runtime.errorCode,
        message: runtime.message,
    };
}

export function cloneScheduleApplianceRuntime(
    runtime: ScheduleApplianceRuntime,
): ScheduleApplianceRuntime {
    return {
        actionKind: runtime.actionKind,
        outcome: runtime.outcome,
        errorCode: runtime.errorCode,
        message: runtime.message,
        updatedAt: runtime.updatedAt,
    };
}

export function cloneScheduleRuntime(runtime: ScheduleRuntime): ScheduleRuntime {
    return {
        inverter: runtime.inverter
            ? cloneScheduleInverterRuntime(runtime.inverter)
            : null,
        appliances: Object.fromEntries(
            Object.entries(runtime.appliances).map(([applianceId, applianceRuntime]) => [
                applianceId,
                cloneScheduleApplianceRuntime(applianceRuntime),
            ]),
        ),
        reconciledAt: runtime.reconciledAt,
    };
}

export function isScheduleBackedDisplaySlot(
    slot: ScheduleDisplaySlot,
): slot is ScheduleBackedDisplaySlot {
    return slot.source === "schedule";
}

export function getScheduleActionIdentityKey(action: ScheduleInverterAction): string {
    return `${action.kind}:${action.targetSoc ?? ""}`;
}

export function getScheduleApplianceActionIdentityKey(
    action: ScheduleApplianceAction,
): string {
    return Object.entries(action)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, value]) => `${key}:${String(value)}`)
        .join("|");
}

export function areScheduleActionsEqual(
    left: ScheduleInverterAction,
    right: ScheduleInverterAction,
): boolean {
    return getScheduleActionIdentityKey(left) === getScheduleActionIdentityKey(right);
}

export function areScheduleApplianceActionsEqual(
    left: ScheduleApplianceAction,
    right: ScheduleApplianceAction,
): boolean {
    return getScheduleApplianceActionIdentityKey(left)
        === getScheduleApplianceActionIdentityKey(right);
}

export function areScheduleDomainsEqual(
    left: ScheduleDomains,
    right: ScheduleDomains,
): boolean {
    if (!areScheduleActionsEqual(left.inverter, right.inverter)) {
        return false;
    }

    const leftIds = Object.keys(left.appliances).sort();
    const rightIds = Object.keys(right.appliances).sort();
    if (leftIds.length !== rightIds.length) {
        return false;
    }

    for (let index = 0; index < leftIds.length; index += 1) {
        const applianceId = leftIds[index];
        if (applianceId !== rightIds[index]) {
            return false;
        }

        const leftAction = left.appliances[applianceId];
        const rightAction = right.appliances[applianceId];
        if (!leftAction || !rightAction || !areScheduleApplianceActionsEqual(leftAction, rightAction)) {
            return false;
        }
    }

    return true;
}

export function isTargetScheduleAction(
    action: ScheduleInverterAction,
): action is ScheduleInverterAction & Required<Pick<ScheduleInverterAction, "targetSoc">> {
    return action.kind === "charge_to_target_soc" || action.kind === "discharge_to_target_soc";
}

export function isScheduleEvChargerAction(
    action: ScheduleApplianceAction,
): action is ScheduleEvChargerAction {
    return typeof (action as Partial<ScheduleEvChargerAction>).charge === "boolean";
}

export function isScheduleGenericApplianceAction(
    action: ScheduleApplianceAction,
): action is ScheduleGenericApplianceAction {
    return typeof (action as Partial<ScheduleGenericApplianceAction>).on === "boolean";
}

export function isScheduleClimateApplianceAction(
    action: ScheduleApplianceAction,
): action is ScheduleClimateApplianceAction {
    return typeof (action as Partial<ScheduleClimateApplianceAction>).mode === "string"
        && (action as Partial<ScheduleClimateApplianceAction>).mode!.trim().length > 0;
}

export function isScheduleApplianceActionEnabled(action: ScheduleApplianceAction): boolean | null {
    if (isScheduleEvChargerAction(action)) {
        return action.charge;
    }

    if (isScheduleGenericApplianceAction(action)) {
        return action.on;
    }

    if (isScheduleClimateApplianceAction(action)) {
        return action.mode !== "off";
    }

    return null;
}
