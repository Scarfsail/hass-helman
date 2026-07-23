import type {
    ApplianceMetadataDTO,
    ApplianceProjectionDTO,
    AppliancesPayload,
    ApplianceProjectionsPayload,
    ScheduleApplianceActionDTO,
    ScheduleActionDTO,
    ScheduleDomainsDTO,
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
    domains: ScheduleDomainsDTO;
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

export function cloneScheduleDomainsDTO(domains: ScheduleDomainsDTO): ScheduleDomainsDTO {
    return {
        inverter: cloneHelmanScheduleAction(domains.inverter),
        appliances: Object.fromEntries(
            Object.entries(domains.appliances).map(([applianceId, action]) => [
                applianceId,
                cloneHelmanScheduleApplianceAction(action),
            ]),
        ),
    };
}

export function buildScheduleSlotDTO(patch: HelmanSchedulePatch): ScheduleSlotDTO {
    return {
        id: patch.id,
        domains: cloneScheduleDomainsDTO(patch.domains),
    };
}

export function cloneScheduleSlotDTO(slot: ScheduleSlotDTO): ScheduleSlotDTO {
    return {
        id: slot.id,
        domains: cloneScheduleDomainsDTO(slot.domains),
    };
}
