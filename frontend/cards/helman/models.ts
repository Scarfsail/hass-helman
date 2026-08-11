import type {
    ApplianceMetadataDTO,
    ApplianceProjectionDTO,
    AppliancesPayload,
    ApplianceProjectionsPayload,
    ScheduleApplianceActionDTO,
    ScheduleActionDTO,
    ScheduleControllableActionsDTO,
    SchedulePayload,
    ScheduleSlotDTO,
} from "../helman-api";

export type HelmanSchedule = SchedulePayload;
export type HelmanScheduleAction = ScheduleActionDTO;
export type HelmanAppliances = AppliancesPayload;
export type HelmanApplianceMetadata = ApplianceMetadataDTO;
export type HelmanApplianceProjections = ApplianceProjectionsPayload;
export type HelmanApplianceProjection = ApplianceProjectionDTO;

export interface HelmanSchedulePatch {
    id: string;
    controllables: ScheduleControllableActionsDTO;
}

export function cloneHelmanScheduleAction(action: HelmanScheduleAction): HelmanScheduleAction {
    const cloned: HelmanScheduleAction = { kind: action.kind };
    if (action.targetSoc !== undefined) {
        cloned.targetSoc = action.targetSoc;
    }
    if (action.conditionMet !== undefined) {
        cloned.conditionMet = action.conditionMet;
    }
    return cloned;
}

export function cloneHelmanScheduleApplianceAction(
    action: ScheduleApplianceActionDTO,
): ScheduleApplianceActionDTO {
    return { ...action };
}

export function cloneScheduleControllableActionsDTO(
    controllables: ScheduleControllableActionsDTO,
): ScheduleControllableActionsDTO {
    return Object.fromEntries(
        Object.entries(controllables).map(([controllableId, action]) => [
            controllableId,
            "kind" in action
                ? cloneHelmanScheduleAction(action)
                : cloneHelmanScheduleApplianceAction(action),
        ]),
    );
}

export function buildScheduleSlotDTO(patch: HelmanSchedulePatch): ScheduleSlotDTO {
    return {
        id: patch.id,
        controllables: cloneScheduleControllableActionsDTO(patch.controllables),
    };
}

export function cloneScheduleSlotDTO(slot: ScheduleSlotDTO): ScheduleSlotDTO {
    return {
        id: slot.id,
        controllables: cloneScheduleControllableActionsDTO(slot.controllables),
    };
}
