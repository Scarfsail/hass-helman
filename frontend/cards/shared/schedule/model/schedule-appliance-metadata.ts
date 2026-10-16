import type {
    ApplianceDTO,
    ApplianceMetadataDTO,
    ClimateApplianceMetadataRecordDTO,
    EvChargerApplianceMetadataDTO,
    GenericApplianceMetadataRecordDTO,
} from "../../../helman-api";

/**
 * One entry of the controllable roster, the inverter included, exactly as
 * `helman/get_appliances` serves it: the backend already applies the defaults
 * and says which entity is primary and whether a lane can be authored.
 */
export type ScheduleControllable = ApplianceMetadataDTO;

/** An appliance on the roster -- what a non-inverter lane draws and edits. */
export type ScheduleApplianceMetadata = ApplianceDTO;
export type ScheduleEvChargerApplianceMetadata = EvChargerApplianceMetadataDTO;
export type ScheduleGenericApplianceMetadata = GenericApplianceMetadataRecordDTO;
export type ScheduleClimateApplianceMetadata = ClimateApplianceMetadataRecordDTO;

/** What a chip needs to draw an appliance's action. */
export interface ScheduleApplianceDescriptor {
    id: string;
    name: string;
    kind: string;
    icon: string;
}

export function describeScheduleAppliance(appliance: ScheduleApplianceMetadata): ScheduleApplianceDescriptor {
    return { id: appliance.id, name: appliance.name, kind: appliance.kind, icon: appliance.metadata.icon };
}

/** The appliance behind a roster entry, or null for the inverter. */
export function asScheduleAppliance(controllable: ScheduleControllable): ScheduleApplianceMetadata | null {
    return controllable.kind === "inverter" ? null : controllable;
}
