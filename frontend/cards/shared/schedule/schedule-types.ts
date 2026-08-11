import type {
    ForecastGranularity,
    RuntimeActionKind,
    RuntimeOutcome,
    ScheduleApplianceActionDTO,
    ScheduleActionDTO,
    SchedulePayload,
    ScheduleRuntimeReason,
    ScheduleSetBy as ScheduleSetByDTO,
} from "../../helman-api";

type WithoutSetBy<TValue> = TValue extends unknown ? Omit<TValue, "setBy"> : never;

export type ScheduleInverterAction = WithoutSetBy<ScheduleActionDTO>;
export type ScheduleAction = ScheduleInverterAction;
export type ScheduleActionKind = ScheduleInverterAction["kind"];
export type ScheduleApplianceAction = WithoutSetBy<ScheduleApplianceActionDTO>;
export type ScheduleEvChargerAction = Extract<ScheduleApplianceAction, { charge: boolean }>;
export type ScheduleGenericApplianceAction = Extract<ScheduleApplianceAction, { on: boolean }>;
export type ScheduleClimateApplianceAction = Extract<ScheduleApplianceAction, { mode: string }>;
/**
 * One slot's actions, keyed by controllable id -- the inverter under its
 * reserved `inverter` id, every appliance under its own.
 *
 * A union of shapes rather than one shape, because an inverter action and a
 * boiler's are genuinely different things; what unified is the map they live
 * in. An id that is absent has nothing scheduled, which is how an appliance
 * has always said it and now how the inverter does too.
 */
export type ScheduleControllableAction = ScheduleInverterAction | ScheduleApplianceAction;
export type ScheduleControllableActions = Record<string, ScheduleControllableAction>;

/** The one place that knows which id the inverter reserves. */
export const INVERTER_CONTROLLABLE_ID = "inverter";

export function isScheduleInverterAction(
    action: ScheduleControllableAction,
): action is ScheduleInverterAction {
    return "kind" in action;
}

export type ScheduleSetBy = ScheduleSetByDTO;

export interface ScheduleAssignment {
    action: ScheduleControllableAction;
    setBy: ScheduleSetBy | null;
}

/**
 * Who authored what in one slot, keyed by controllable id.
 *
 * Absent means nothing is scheduled for that controllable, so a reader asks
 * `assignments[id]` and gets `undefined` for the inverter exactly as it always
 * did for a boiler -- one lookup for every lane.
 */
export type ScheduleAssignments = Record<string, ScheduleAssignment>;

export type ScheduleAuthorshipState = "none" | "user" | "automation" | "mixed";

export interface ScheduleActionAuthorshipSummary {
    state: ScheduleAuthorshipState;
    counts: {
        user: number;
        automation: number;
    };
}

export type ScheduleRangeEditAuthorshipSummary = Record<
    string,
    ScheduleActionAuthorshipSummary
>;

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

export type ScheduleControllableRuntime = ScheduleInverterRuntime | ScheduleApplianceRuntime;

export interface ScheduleRuntime {
    controllables: Record<string, ScheduleControllableRuntime>;
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

export type ScheduleRangeEditSelectionSummary = Record<
    string,
    ScheduleSelectionValueSummary<ScheduleControllableAction | null>
>;

export interface ScheduleDialogState {
    selectedSlots: ScheduleSlot[];
    selectionSummary: ScheduleRangeEditSelectionSummary;
    authorshipSummary: ScheduleRangeEditAuthorshipSummary;
}

/**
 * What one lane's edit means, for any controllable.
 *
 * `unset_user` is now the only way to say "nothing here": the inverter used to
 * spell that as `set_user` with an `empty` action, because its lane always had
 * an action, and it no longer does.
 */
export type ScheduleEditIntent =
    | { kind: "keep" }
    | { kind: "set_user"; action: ScheduleControllableAction }
    | { kind: "unset_user" };

export type ScheduleRangeEditIntent = Record<string, ScheduleEditIntent>;

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
    controllables: ScheduleControllableActions;
}

export function cloneScheduleInverterAction(action: ScheduleInverterAction): ScheduleInverterAction {
    const cloned: ScheduleInverterAction = { kind: action.kind };
    if (action.targetSoc !== undefined) {
        cloned.targetSoc = action.targetSoc;
    }
    if (action.conditionMet !== undefined) {
        cloned.conditionMet = action.conditionMet;
    }
    return cloned;
}

export function cloneScheduleApplianceAction(
    action: ScheduleApplianceAction,
): ScheduleApplianceAction {
    return { ...action };
}

export function cloneScheduleControllableAction(
    action: ScheduleControllableAction,
): ScheduleControllableAction {
    return isScheduleInverterAction(action)
        ? cloneScheduleInverterAction(action)
        : cloneScheduleApplianceAction(action);
}

export function cloneScheduleControllableActions(
    controllables: ScheduleControllableActions,
): ScheduleControllableActions {
    return Object.fromEntries(
        Object.entries(controllables).map(([controllableId, action]) => [
            controllableId,
            cloneScheduleControllableAction(action),
        ]),
    );
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
        controllables: Object.fromEntries(
            Object.entries(runtime.controllables).map(([controllableId, entry]) => [
                controllableId,
                // Which shape an entry has is decided by its id, not by
                // sniffing its fields: an inverter runtime that failed before
                // it acted carries neither `executedAction` nor `reason`.
                controllableId === INVERTER_CONTROLLABLE_ID
                    ? cloneScheduleInverterRuntime(entry as ScheduleInverterRuntime)
                    : cloneScheduleApplianceRuntime(entry as ScheduleApplianceRuntime),
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
    // Include candidacy so a committed and a candidate action of the same kind
    // render as separate (solid vs muted) chips rather than merging.
    const candidate = action.conditionMet === false ? "candidate" : "";
    return `${action.kind}:${action.targetSoc ?? ""}:${candidate}`;
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

export function getScheduleControllableActionIdentityKey(
    action: ScheduleControllableAction,
): string {
    return isScheduleInverterAction(action)
        // Prefixed by the action's *shape*, not by a lane: two lanes never
        // compare their keys, but an inverter action and an appliance action
        // must never collide on one. Deliberately not the bare word
        // "appliance", which used to prefix a lane key and no longer prefixes
        // anything.
        ? `inverter-action:${getScheduleActionIdentityKey(action)}`
        : `appliance-action:${getScheduleApplianceActionIdentityKey(action)}`;
}

export function areScheduleControllableActionsEqual(
    left: ScheduleControllableActions,
    right: ScheduleControllableActions,
): boolean {
    const leftIds = Object.keys(left).sort();
    const rightIds = Object.keys(right).sort();
    if (leftIds.length !== rightIds.length) {
        return false;
    }

    for (let index = 0; index < leftIds.length; index += 1) {
        const controllableId = leftIds[index];
        if (controllableId !== rightIds[index]) {
            return false;
        }

        const leftAction = left[controllableId];
        const rightAction = right[controllableId];
        if (
            getScheduleControllableActionIdentityKey(leftAction)
            !== getScheduleControllableActionIdentityKey(rightAction)
        ) {
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
