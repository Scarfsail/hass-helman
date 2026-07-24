import type {
    ApplianceMetadataDTO,
    AppliancesPayload,
    ApplianceVehicleDTO,
    ClimateApplianceMetadataRecordDTO,
    ClimateApplianceMode,
    ClimateApplianceScheduleCapabilitiesDTO,
    EvChargerApplianceMetadataDTO,
    EvChargerScheduleCapabilitiesDTO,
    EvChargerUseMode,
    GenericApplianceMetadataRecordDTO,
    GenericApplianceScheduleCapabilitiesDTO,
} from "../../helman-api";

export interface ScheduleVehicleOption {
    id: string;
    name: string;
}

/**
 * The entities that carry an appliance's state.
 *
 * `primary` is the entity whose state decides whether the appliance is running
 * -- the same one the backend lists as controllable -- so it doubles as the key
 * that links a controllable entity back to its appliance. The EV charger's mode
 * selects are secondary: they refine how a running charger is described, but
 * never decide whether it is running.
 */
export interface ScheduleApplianceControlEntityIds {
    primary: string;
    useMode?: string;
    ecoGear?: string;
}

export interface ScheduleApplianceMetadataBase {
    id: string;
    name: string;
    kind: string;
    icon: string;
    order: number;
    supportsAuthoring: boolean;
    controlEntityIds: ScheduleApplianceControlEntityIds | null;
}

export interface ScheduleEvChargerCapabilities {
    chargeToggle: boolean;
    useModes: EvChargerUseMode[];
    ecoGears: string[];
    requiresVehicleSelection: boolean;
}

export interface ScheduleGenericApplianceCapabilities {
    onOffToggle: boolean;
}

export interface ScheduleClimateApplianceCapabilities {
    modes: ClimateApplianceMode[];
}

export interface ScheduleEvChargerApplianceMetadata extends ScheduleApplianceMetadataBase {
    kind: "ev_charger";
    supportsAuthoring: true;
    maxChargingPowerKw: number;
    scheduleCapabilities: ScheduleEvChargerCapabilities;
    vehicles: ScheduleVehicleOption[];
}

export interface ScheduleGenericApplianceMetadata extends ScheduleApplianceMetadataBase {
    kind: "generic";
    scheduleCapabilities: ScheduleGenericApplianceCapabilities;
}

export interface ScheduleClimateApplianceMetadata extends ScheduleApplianceMetadataBase {
    kind: "climate";
    scheduleCapabilities: ScheduleClimateApplianceCapabilities;
}

export interface ScheduleUnknownApplianceMetadata extends ScheduleApplianceMetadataBase {
    supportsAuthoring: false;
}

export type ScheduleApplianceMetadata =
    | ScheduleEvChargerApplianceMetadata
    | ScheduleGenericApplianceMetadata
    | ScheduleClimateApplianceMetadata
    | ScheduleUnknownApplianceMetadata;

export function normalizeScheduleApplianceMetadata(
    payload: AppliancesPayload,
): ScheduleApplianceMetadata[] {
    return payload.appliances.flatMap((appliance, index) => {
        const normalized = _normalizeApplianceMetadata(appliance, index);
        return normalized === null ? [] : [normalized];
    });
}

export function getScheduleApplianceById(
    appliances: readonly ScheduleApplianceMetadata[],
    applianceId: string,
): ScheduleApplianceMetadata | null {
    return appliances.find((appliance) => appliance.id === applianceId) ?? null;
}

function _normalizeApplianceMetadata(
    appliance: ApplianceMetadataDTO,
    order: number,
): ScheduleApplianceMetadata | null {
    if (!_isNonEmptyString(appliance.id) || !_isNonEmptyString(appliance.name) || !_isNonEmptyString(appliance.kind)) {
        return null;
    }

    if (appliance.kind === "ev_charger" && _isEvChargerApplianceMetadata(appliance)) {
        return {
            id: appliance.id,
            name: appliance.name,
            kind: appliance.kind,
            icon: appliance.metadata.icon,
            order,
            supportsAuthoring: true,
            controlEntityIds: {
                primary: appliance.controls.charge.entityId,
                useMode: appliance.controls.useMode.entityId,
                ecoGear: appliance.controls.ecoGear.entityId,
            },
            maxChargingPowerKw: appliance.metadata.maxChargingPowerKw,
            scheduleCapabilities: _cloneEvChargerScheduleCapabilities(appliance.metadata.scheduleCapabilities),
            vehicles: appliance.vehicles
                .filter((vehicle) => _isVehicleOption(vehicle))
                .map((vehicle) => ({ id: vehicle.id, name: vehicle.name })),
        };
    }

    if (appliance.kind === "generic" && _isGenericApplianceMetadata(appliance)) {
        return {
            id: appliance.id,
            name: appliance.name,
            kind: appliance.kind,
            icon: appliance.metadata.icon,
            order,
            supportsAuthoring: appliance.metadata.scheduleCapabilities.onOffToggle,
            controlEntityIds: { primary: appliance.controls.switch.entityId },
            scheduleCapabilities: _cloneGenericScheduleCapabilities(appliance.metadata.scheduleCapabilities),
        };
    }

    if (appliance.kind === "climate" && _isClimateApplianceMetadata(appliance)) {
        return {
            id: appliance.id,
            name: appliance.name,
            kind: appliance.kind,
            icon: appliance.metadata.icon,
            order,
            supportsAuthoring: appliance.metadata.scheduleCapabilities.modes.length > 0,
            controlEntityIds: { primary: appliance.controls.climate.entityId },
            scheduleCapabilities: _cloneClimateScheduleCapabilities(appliance.metadata.scheduleCapabilities),
        };
    }

    return {
        id: appliance.id,
        name: appliance.name,
        kind: appliance.kind,
        icon: _extractUnknownApplianceIcon(appliance),
        order,
        supportsAuthoring: false,
        controlEntityIds: null,
    };
}

function _cloneEvChargerScheduleCapabilities(
    capabilities: EvChargerScheduleCapabilitiesDTO,
): ScheduleEvChargerCapabilities {
    return {
        chargeToggle: capabilities.chargeToggle,
        useModes: [...capabilities.useModes],
        ecoGears: [...capabilities.ecoGears],
        requiresVehicleSelection: capabilities.requiresVehicleSelection,
    };
}

function _cloneGenericScheduleCapabilities(
    capabilities: GenericApplianceScheduleCapabilitiesDTO,
): ScheduleGenericApplianceCapabilities {
    return {
        onOffToggle: capabilities.onOffToggle,
    };
}

function _cloneClimateScheduleCapabilities(
    capabilities: ClimateApplianceScheduleCapabilitiesDTO,
): ScheduleClimateApplianceCapabilities {
    return {
        modes: [...capabilities.modes],
    };
}

function _isEvChargerApplianceMetadata(
    appliance: ApplianceMetadataDTO,
): appliance is EvChargerApplianceMetadataDTO {
    return appliance.kind === "ev_charger"
        && typeof appliance.metadata?.maxChargingPowerKw === "number"
        && Array.isArray(appliance.metadata?.scheduleCapabilities?.useModes)
        && Array.isArray(appliance.metadata?.scheduleCapabilities?.ecoGears)
        && typeof appliance.metadata?.scheduleCapabilities?.chargeToggle === "boolean"
        && typeof appliance.metadata?.scheduleCapabilities?.requiresVehicleSelection === "boolean"
        && typeof appliance.controls?.charge?.entityId === "string"
        && typeof appliance.controls?.useMode?.entityId === "string"
        && typeof appliance.controls?.ecoGear?.entityId === "string"
        && Array.isArray(appliance.vehicles);
}

function _isGenericApplianceMetadata(
    appliance: ApplianceMetadataDTO,
): appliance is GenericApplianceMetadataRecordDTO {
    return appliance.kind === "generic"
        && typeof appliance.metadata?.scheduleCapabilities?.onOffToggle === "boolean"
        && typeof appliance.controls?.switch?.entityId === "string";
}

function _isClimateApplianceMetadata(
    appliance: ApplianceMetadataDTO,
): appliance is ClimateApplianceMetadataRecordDTO {
    return appliance.kind === "climate"
        && Array.isArray(appliance.metadata?.scheduleCapabilities?.modes)
        && typeof appliance.controls?.climate?.entityId === "string";
}

function _isVehicleOption(vehicle: ApplianceVehicleDTO): boolean {
    return _isNonEmptyString(vehicle.id) && _isNonEmptyString(vehicle.name);
}

function _isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function _extractUnknownApplianceIcon(appliance: ApplianceMetadataDTO): string {
    if ("metadata" in appliance && appliance.metadata && typeof appliance.metadata === "object") {
        const icon = (appliance.metadata as { icon?: unknown }).icon;
        if (_isNonEmptyString(icon)) {
            return icon;
        }
    }

    return "mdi:flash-outline";
}
