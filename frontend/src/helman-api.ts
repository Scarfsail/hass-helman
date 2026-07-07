/**
 * Backend API types for the helman integration.
 *
 * Both helman-card and helman-simple-card communicate with the same
 * helman backend via Home Assistant WebSocket. This file contains the
 * shared DTO definitions and value-type helpers.
 */

// ── Value type ────────────────────────────────────────────────────────────────

export type ValueType = "default" | "positive" | "negative";

/**
 * Applies a ValueType transformation to a raw sensor reading.
 * - "positive": clamps to ≥ 0  (e.g. solar production)
 * - "negative": returns absolute value of the negative part (e.g. battery discharge)
 * - "default":  returns the raw value unchanged
 */
export function applyValueType(raw: number, vt: ValueType): number {
    if (vt === "positive") return Math.max(0, raw);
    if (vt === "negative") return Math.abs(Math.min(0, raw));
    return raw;
}

// ── Device node DTOs ──────────────────────────────────────────────────────────

/** Fields present on every device node returned by helman/get_device_tree. */
export interface DeviceNodeDTOBase {
    id: string;
    powerSensorId: string | null;
    valueType: ValueType;
    sourceConfig: any | null;
    sourceType: string | null;
    children: DeviceNodeDTOBase[];
}

/** Full device node DTO — includes all fields used by helman-card. */
export interface DeviceNodeDTO extends DeviceNodeDTOBase {
    displayName: string;
    switchEntityId: string | null;
    isSource: boolean;
    isUnmeasured: boolean;
    labels: string[];
    labelBadgeTexts: string[];
    color: string | null;
    icon: string | null;
    compact: boolean;
    showAdditionalInfo: boolean;
    childrenFullWidth: boolean;
    hideChildren: boolean;
    hideChildrenIndicator: boolean;
    sortChildrenByPower: boolean;
    children: DeviceNodeDTO[];
    ratioSensorId: string | null;
}

// ── UI config (part of the tree payload) ─────────────────────────────────────

export interface HelmanUiConfig {
    sources_title: string;
    consumers_title: string;
    groups_title: string;
    others_group_label: string;
    show_empty_groups?: boolean;
    show_others_group?: boolean;
    device_label_text: Record<string, Record<string, string>>;
    history_buckets: number;
    history_bucket_duration: number;
}

// ── WebSocket message payloads ────────────────────────────────────────────────

/** Response type for the "helman/get_device_tree" WebSocket command. */
export interface TreePayload {
    sources: DeviceNodeDTO[];
    consumers: DeviceNodeDTO[];
    consumptionTotalSensorId: string | null;
    productionTotalSensorId: string | null;
    uiConfig: HelmanUiConfig;
}

/** Response type for the "helman/get_history" WebSocket command. */
export interface HistoryPayload {
    buckets: number;
    bucket_duration: number;
    entity_history: Record<string, number[]>;
}

export type ForecastStatus =
    | "not_configured"
    | "insufficient_history"
    | "unavailable"
    | "partial"
    | "available";

export type ForecastGranularity = 15 | 30 | 60;

export type ForecastResolution = "quarter_hour" | "half_hour" | "hour";

export interface ForecastPointDTO {
    timestamp: string;
    value: number;
}

export interface SolarForecastDTO {
    status: ForecastStatus;
    unit: string | null;
    resolution: ForecastResolution;
    horizonHours: number;
    remainingTodayKwh?: number | null;
    remainingTodayEnergyEntityId?: string | null;
    actualHistory: ForecastPointDTO[];
    points: ForecastPointDTO[]; // forecast points at the returned response granularity
    adjustedPoints?: ForecastPointDTO[];
}

export function getEffectiveSolarForecastPoints(
    solar: SolarForecastDTO | null | undefined,
): ForecastPointDTO[] {
    return solar?.adjustedPoints ?? solar?.points ?? [];
}

export interface GridForecastDTO {
    status: ForecastStatus;
    generatedAt: string | null;
    unit: string;
    resolution: ForecastResolution;
    horizonHours: number;
    startedAt: string | null;
    partialReason: string | null;
    coverageUntil: string | null;
    scheduleAdjusted?: boolean;
    scheduleAdjustmentCoverageUntil?: string | null;
    currentImportPrice: number | null;
    importPriceUnit: string | null;
    importPricePoints: ForecastPointDTO[];
    currentExportPrice: number | null;
    exportPriceUnit: string | null;
    exportPricePoints: ForecastPointDTO[];
    series: GridForecastSlotDTO[];
}

export interface GridForecastBaselineDTO {
    importedFromGridKwh: number;
    exportedToGridKwh: number;
}

export interface GridForecastSlotDTO {
    timestamp: string;
    durationHours: number;
    importedFromGridKwh: number;
    exportedToGridKwh: number;
    availableSurplusKwh?: number;
    baseline?: GridForecastBaselineDTO;
}

export interface ForecastBandValueDTO {
    value: number;
    lower: number;
    upper: number;
}

export interface DeferrableConsumerHourValueDTO {
    entityId: string;
    label: string;
    value: number;
    lower: number;
    upper: number;
}

export interface HouseConsumptionForecastHourDTO {
    timestamp: string;
    nonDeferrable: ForecastBandValueDTO;
    deferrableConsumers: DeferrableConsumerHourValueDTO[];
}

export interface HouseConsumptionActualValueDTO {
    value: number;
}

export interface HouseConsumptionActualConsumerHourDTO {
    entityId: string;
    label: string;
    value: number;
}

export interface HouseConsumptionActualHourDTO {
    timestamp: string;
    nonDeferrable: HouseConsumptionActualValueDTO;
    deferrableConsumers: HouseConsumptionActualConsumerHourDTO[];
}

export interface HouseConsumptionForecastDTO {
    status: ForecastStatus;
    generatedAt: string | null;
    unit: string;
    resolution: ForecastResolution;
    horizonHours: number;
    trainingWindowDays: number;
    historyDaysAvailable: number;
    requiredHistoryDays: number;
    model: string | null;
    actualHistory: HouseConsumptionActualHourDTO[];
    currentSlot?: HouseConsumptionForecastHourDTO;
    currentHour?: HouseConsumptionForecastHourDTO;
    series: HouseConsumptionForecastHourDTO[];
}

export interface BatteryCapacityActualHourDTO {
    timestamp: string;
    startSocPct: number;
    socPct: number;
}

export interface BatteryCapacityForecastHourDTO {
    timestamp: string;
    durationHours: number;
    solarKwh: number;
    baselineHouseKwh: number;
    netKwh: number;
    chargedKwh: number;
    dischargedKwh: number;
    remainingEnergyKwh: number;
    socPct: number;
    importedFromGridKwh: number;
    exportedToGridKwh: number;
    hitMinSoc: boolean;
    hitMaxSoc: boolean;
    limitedByChargePower: boolean;
    limitedByDischargePower: boolean;
}

export interface BatteryCapacityForecastDTO {
    status: ForecastStatus;
    generatedAt: string | null;
    startedAt: string | null;
    unit: "kWh";
    resolution: ForecastResolution;
    horizonHours: number;
    model: string | null;
    nominalCapacityKwh: number | null;
    currentRemainingEnergyKwh: number | null;
    currentSoc: number | null;
    minSoc: number | null;
    maxSoc: number | null;
    chargeEfficiency: number | null;
    dischargeEfficiency: number | null;
    maxChargePowerW: number | null;
    maxDischargePowerW: number | null;
    partialReason: string | null;
    coverageUntil: string | null;
    actualHistory: BatteryCapacityActualHourDTO[];
    series: BatteryCapacityForecastHourDTO[];
}

export interface ForecastPayload {
    solar: SolarForecastDTO;
    grid: GridForecastDTO;
    house_consumption: HouseConsumptionForecastDTO;
    battery_capacity: BatteryCapacityForecastDTO;
}

export interface GetForecastRequest {
    type: "helman/get_forecast";
    granularity?: ForecastGranularity;
    forecast_days?: number;
}

export type ScheduleActionKind =
    | "empty"
    | "normal"
    | "charge_to_target_soc"
    | "discharge_to_target_soc"
    | "stop_charging"
    | "stop_discharging"
    | "stop_export";

export type ScheduleSetBy = "user" | "automation";

export interface ScheduleActionDTO {
    kind: ScheduleActionKind;
    targetSoc?: number;
    setBy?: ScheduleSetBy;
}

export type EvChargerUseMode = "Fast" | "ECO";
export type ClimateApplianceMode = "heat" | "cool" | (string & {});

export interface ScheduleEvChargerActionDTO {
    charge: boolean;
    vehicleId?: string;
    useMode?: EvChargerUseMode;
    ecoGear?: string;
    setBy?: ScheduleSetBy;
}

export interface ScheduleGenericApplianceActionDTO {
    on: boolean;
    setBy?: ScheduleSetBy;
}

export interface ScheduleClimateApplianceActionDTO {
    mode: ClimateApplianceMode;
    setBy?: ScheduleSetBy;
}

export type ScheduleApplianceActionDTO =
    | ScheduleEvChargerActionDTO
    | ScheduleGenericApplianceActionDTO
    | ScheduleClimateApplianceActionDTO;

export type ScheduleRuntimeReason = "scheduled" | "target_soc_reached";
export type RuntimeActionKind = "apply" | "slot_stop" | "noop";
export type RuntimeOutcome = "success" | "failed" | "skipped";

export interface ScheduleDomainsDTO {
    inverter: ScheduleActionDTO;
    appliances: Record<string, ScheduleApplianceActionDTO>;
}

export interface InverterRuntimeDTO {
    actionKind: RuntimeActionKind;
    outcome: RuntimeOutcome;
    executedAction?: ScheduleActionDTO;
    reason?: ScheduleRuntimeReason;
    errorCode?: string;
    message?: string;
}

export interface ApplianceRuntimeDTO {
    actionKind: RuntimeActionKind;
    outcome: RuntimeOutcome;
    errorCode?: string;
    message?: string;
    updatedAt?: string;
}

export interface ScheduleRuntimeDTO {
    activeSlotId: string;
    appliances: Record<string, ApplianceRuntimeDTO>;
    inverter?: InverterRuntimeDTO;
    reconciledAt?: string;
}

export interface ScheduleSlotDTO {
    id: string;
    domains: ScheduleDomainsDTO;
}

export interface SchedulePayload {
    executionEnabled: boolean;
    slots: ScheduleSlotDTO[];
    runtime?: ScheduleRuntimeDTO;
}

export interface GetScheduleRequest {
    type: "helman/get_schedule";
}

export interface SetScheduleRequest {
    type: "helman/set_schedule";
    slots: ScheduleSlotDTO[];
}

export interface SetScheduleResponse {
    success: true;
}

export interface SetScheduleExecutionRequest {
    type: "helman/set_schedule_execution";
    enabled: boolean;
}

export interface SetScheduleExecutionResponse {
    success: true;
    executionEnabled: boolean;
}

export interface EntityReferenceDTO {
    entityId: string;
}

export interface EvChargerScheduleCapabilitiesDTO {
    chargeToggle: boolean;
    useModes: EvChargerUseMode[];
    ecoGears: string[];
    requiresVehicleSelection: boolean;
}

export interface GenericApplianceScheduleCapabilitiesDTO {
    onOffToggle: boolean;
}

export interface ClimateApplianceScheduleCapabilitiesDTO {
    modes: ClimateApplianceMode[];
}

export interface ApplianceVehicleTelemetryDTO {
    socEntityId: string;
    chargeLimitEntityId?: string;
}

export interface ApplianceVehicleMetadataDTO {
    batteryCapacityKwh: number;
    maxChargingPowerKw: number;
}

export interface ApplianceVehicleDTO {
    id: string;
    name: string;
    telemetry: ApplianceVehicleTelemetryDTO;
    metadata: ApplianceVehicleMetadataDTO;
}

export interface EvChargerMetadataDTO {
    icon: string;
    maxChargingPowerKw: number;
    scheduleCapabilities: EvChargerScheduleCapabilitiesDTO;
}

export interface GenericApplianceMetadataDTO {
    icon: string;
    scheduleCapabilities: GenericApplianceScheduleCapabilitiesDTO;
}

export interface ClimateApplianceMetadataDTO {
    icon: string;
    scheduleCapabilities: ClimateApplianceScheduleCapabilitiesDTO;
}

export interface EvChargerControlsDTO {
    charge: EntityReferenceDTO;
    useMode: EntityReferenceDTO;
    ecoGear: EntityReferenceDTO;
}

export interface GenericApplianceControlsDTO {
    switch: EntityReferenceDTO;
}

export interface ClimateApplianceControlsDTO {
    climate: EntityReferenceDTO;
}

export interface ApplianceMetadataDTOBase {
    id: string;
    name: string;
    kind: string;
}

export interface EvChargerApplianceMetadataDTO extends ApplianceMetadataDTOBase {
    kind: "ev_charger";
    metadata: EvChargerMetadataDTO;
    controls: EvChargerControlsDTO;
    vehicles: ApplianceVehicleDTO[];
}

export interface GenericApplianceMetadataRecordDTO extends ApplianceMetadataDTOBase {
    kind: "generic";
    metadata: GenericApplianceMetadataDTO;
    controls: GenericApplianceControlsDTO;
}

export interface ClimateApplianceMetadataRecordDTO extends ApplianceMetadataDTOBase {
    kind: "climate";
    metadata: ClimateApplianceMetadataDTO;
    controls: ClimateApplianceControlsDTO;
}

export interface UnknownApplianceMetadataDTO extends ApplianceMetadataDTOBase {
    [key: string]: unknown;
}

export type ApplianceMetadataDTO =
    | EvChargerApplianceMetadataDTO
    | GenericApplianceMetadataRecordDTO
    | ClimateApplianceMetadataRecordDTO
    | UnknownApplianceMetadataDTO;

export interface AppliancesPayload {
    appliances: ApplianceMetadataDTO[];
}

export interface GetAppliancesRequest {
    type: "helman/get_appliances";
}

export type ApplianceProjectionMethod =
    | "fixed"
    | "history_average"
    | "fixed_fallback";

export interface ApplianceProjectionPointDTO {
    slotId: string;
    energyKwh: number;
    mode?: string | null;
    vehicleId?: string | null;
    vehicleSoc?: number | null;
    projectionMethod?: ApplianceProjectionMethod | null;
}

export interface ApplianceProjectionSeriesDTO {
    series: ApplianceProjectionPointDTO[];
}

export type ApplianceProjectionDTO = ApplianceProjectionSeriesDTO;

export interface ApplianceProjectionsPayload {
    generatedAt: string;
    appliances: Record<string, ApplianceProjectionDTO>;
}

export interface GetApplianceProjectionsRequest {
    type: "helman/get_appliance_projections";
}
