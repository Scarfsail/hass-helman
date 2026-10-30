import { type DayAggregatesPayload, type HelmanCommands, callHelman } from "./shared/data/helman-commands";
import type { HomeAssistant } from "../types/ha";
import type { JsonObject, ValidationReport } from "./shared/config/types";
export type { ConfigDocument } from "./shared/config/types";
export type { InspectorPayload } from "./helman-solar-inspector/inspector-day-model";
/**
 * Backend API types for the helman integration.
 *
 * Both helman-card and helman-simple-card communicate with the same
 * helman backend via Home Assistant WebSocket. This file contains the
 * shared DTO definitions and value-type helpers.
 */

// ── Value type ────────────────────────────────────────────────────────────────

export type ValueType = "default" | "positive" | "negative";

// ── Device node DTOs ──────────────────────────────────────────────────────────

/** Fields present on every device node returned by helman/get_device_tree. */
export interface TreeItemDTOBase {
    id: string;
    powerSensorId: string | null;
    valueType: ValueType;
    sourceType: string | null;
    children: TreeItemDTOBase[];
}

/**
 * A battery's or grid's power sensor and the sign that reads it in Helman's
 * convention: raw × sign is positive into the consumer side — a battery
 * charging, the grid exporting. Lossless where `valueType` keeps one half.
 */
export interface SignedPower {
    entityId: string;
    sign: 1 | -1;
}

/**
 * What the cards read off an energy node, resolved by the backend from the
 * active config with its own defaults; `null` on every node a field does not
 * apply to. Both halves of a battery or grid carry the same fields.
 */
export interface EnergyNodeFields {
    /** Battery and grid only. */
    power: SignedPower | null;
    /** Solar, battery and grid: the full scale of the node's flows, W. */
    maxPowerW: number | null;
    socEntityId: string | null;
    minSocEntityId: string | null;
    maxSocEntityId: string | null;
    remainingEnergyEntityId: string | null;
    /** Solar and house. */
    todayEnergyEntityId: string | null;
    todayImportEntityId: string | null;
    todayExportEntityId: string | null;
}

/** Full device node DTO — includes all fields used by helman-card. */
export interface TreeItemDTO extends TreeItemDTOBase, EnergyNodeFields {
    displayName: string;
    switchEntityId: string | null;
    isSource: boolean;
    isUnmeasured: boolean;
    /** A house device's own group per grouping: grouping id -> group id. */
    groups: Record<string, string>;
    /** The short names of those groups, in grouping order. */
    groupBadgeTexts: string[];
    icon: string | null;
    compact: boolean;
    showAdditionalInfo: boolean;
    childrenFullWidth: boolean;
    hideChildren: boolean;
    hideChildrenIndicator: boolean;
    sortChildrenByPower: boolean;
    children: TreeItemDTO[];
    ratioSensorId: string | null;
    /** A house child whose energy statistic is a deferrable controllable. */
    deferrable: boolean;
    /**
     * The controllables this device is — the keys the schedule stores their
     * assignments under, not the energy statistic in {@link id}. Several for a
     * meter shared by several controllables. Empty for everything that is not a
     * configured controllable, and for a controllable that declares no id.
     */
    controllableIds: string[];
    /** Historical own-load attribution; independent of the live aggregate tint. */
    ownDeferrable?: boolean;
    ownControllableIds?: string[];
    /** Configured kind only when this node identifies one schedulable controllable. */
    applianceKind?: string | null;
    /** The climate entity a device configures, whose more-info its Control tab opens; null for every other node. */
    climateEntityId: string | null;
    /** A house child's meter; null for every other node. */
    energyEntityId: string | null;
    /** A meterless child's share of its parent's power — an estimate, shown with `≈`. */
    isEstimated: boolean;
    /** A house device's own wiring, `null` when unassigned and for every other node. */
    phase?: DevicePhase | null;
}

/** The house phase a device is wired to: one of the three, or all three. */
export type DevicePhase = "L1" | "L2" | "L3" | "3ph";

// ── UI config (part of the tree payload) ─────────────────────────────────────

/** One entry of `devices.groupings`: an umbrella over groups, in display order. */
export interface DeviceGrouping {
    id: string;
    name: string;
    groups: { id: string; name: string; short_name: string }[];
}

export interface HelmanUiConfig {
    show_empty_groups?: boolean;
    show_others_group?: boolean;
    device_groupings: DeviceGrouping[];
    history_buckets: number;
    history_bucket_duration: number;
}

// ── WebSocket message payloads ────────────────────────────────────────────────

/** Request type for the "helman/get_device_tree" WebSocket command. */
export type GetDeviceTreeRequest = HelmanCommands["helman/get_device_tree"]["req"];

/** Response type for the "helman/get_device_tree" WebSocket command. */
export interface TreePayload {
    sources: TreeItemDTO[];
    consumers: TreeItemDTO[];
    consumptionTotalSensorId: string | null;
    productionTotalSensorId: string | null;
    uiConfig: HelmanUiConfig;
}

/** Request type for the "helman/get_history" WebSocket command. */
export type GetHistoryRequest = HelmanCommands["helman/get_history"]["req"];

/** Response type for the "helman/get_history" WebSocket command. */
export interface HistoryPayload {
    entity_history: Record<string, number[]>;
}

/** A median and its range, as a device's usage record states one. */
export interface DeviceStatsSpread {
    median: number;
    min: number;
    max: number;
}

/**
 * One device's usage record, learned nightly from its history. Every key is
 * absent when history does not answer it; the run figures need a power
 * sensor or, for a meterless child, its running signal.
 */
export interface DeviceStats {
    /** kWh over the complete local days in the window, zero days included. */
    daily_kwh?: DeviceStatsSpread & { mean: number; days: number };
    runs_per_day?: number;
    /** The fewest and most runs started on one of the `daily_kwh` days. */
    daily_runs?: { min: number; max: number };
    run_minutes?: DeviceStatsSpread;
    run_kwh?: DeviceStatsSpread;
    /** Energy over the hours the device actually draws power. */
    running_kw?: number;
    /** Energy per hour its running signal is on, idle on-time included. */
    on_kwh_per_hour?: number;
}

/** The bucket size of a report that is bucketed by it. */
/** The bucket sizes `helman/device_report` accepts: the backend's `span_buckets.BUCKETS`. */
export const DEVICE_REPORT_GRANULARITIES = ["day", "week", "month"] as const;
export type DeviceReportGranularity = (typeof DEVICE_REPORT_GRANULARITIES)[number];

/**
 * The period a device report covers: local dates, both inclusive. A report
 * bucketed by granularity carries it; any other report leaves it out.
 */
export interface DeviceReportQuery {
    start_date: string;
    end_date: string;
    granularity?: DeviceReportGranularity;
}

/**
 * One money figure of a device report. `pricedKwh + unpricedKwh` is the
 * row's kWh; a known zero counts as priced. `amount` is null only when nothing
 * was priced.
 */
export interface DeviceReportMoneySide {
    amount: number | null;
    pricedKwh: number;
    unpricedKwh: number;
    /** `paid` only: the priced kWh valued at today's configured tariff. */
    tariffKwh?: number;
}

export interface DeviceReportSources {
    solar: number;
    battery: number;
    grid: number;
    unattributed: number;
}

/** What every report payload carries, whatever the report. */
export interface DeviceReportCommon {
    report: string;
    startDate: string;
    endDate: string;
    /** The import price unit, e.g. `CZK/kWh`. */
    priceUnit: string | null;
    /** Fractions of the period's battery charge, by what charged it. */
    chargeOrigin: {
        chargedKwh: number;
        grid: number;
        gridRecorded: number;
        gridTariff: number;
        gridUnpriced: number;
        solar: number;
        solarPriced: number;
        solarUnpriced: number;
        unknown: number;
        paidRate: number | null;
        forgoneRate: number | null;
    };
    houseKwh: number;
    ambiguousKwh: number;
    unattributedKwh: number;
    mismatchKwh: number;
    meters: { grid: boolean; solar: boolean; battery: boolean; house: boolean };
    /** The backend's clock when it built the payload, ISO. */
    asOf: string;
    /** The recorder had compiled the whole period: the figures no longer change. */
    complete: boolean;
    range: { minDate: string; maxDate: string };
}

/** Why there is no report at all: a setting the reports need is missing. */
export interface DeviceReportUnavailable {
    unavailable: "no_house_node" | "no_house_meter";
}

export type DeviceReportPayload = DeviceReportCommon | DeviceReportUnavailable;

export function isDeviceReportUnavailable(
    payload: DeviceReportPayload,
): payload is DeviceReportUnavailable {
    return "unavailable" in payload;
}

/** One row of the Ranking report. A parent's figures include its children. */
export interface RankingNode {
    id: string;
    parentId: string | null;
    depth: number;
    label: string;
    icon: string | null;
    estimated: boolean;
    unmeasured: boolean;
    children: string[];
    kwh: number;
    sources: DeviceReportSources;
    money: { paid: DeviceReportMoneySide; forgone: DeviceReportMoneySide };
    /** Covered hours over the period's elapsed hours, 0..1. */
    coverage: number;
    firstHour: string | null;
    overallocatedKwh: number;
}

export interface RankingReportPayload extends DeviceReportCommon {
    /** Pre-order; `nodes[0]` is the house. */
    nodes: RankingNode[];
}

/**
 * One bucket of the Over time report, clamped to the period. Over the hours
 * the house meter measured, `Σ values + unmeasured − overallocated = house`.
 */
export interface OverTimeBucket {
    /** The bucket's first and last local day, inclusive. */
    start: string;
    end: string;
    /** The period cuts the bucket, or the bucket is still running. */
    partial: boolean;
    /** The house meter. */
    house: number;
    /** kWh per top-level device, keyed by series id. */
    values: Record<string, number>;
    /** The house's remainder. */
    unmeasured: number;
    /** What the devices measure beyond the house meter. */
    overallocated: number;
}

/** A top-level device of the Over time report. */
export interface OverTimeSeries {
    id: string;
    label: string;
    icon: string | null;
    estimated: boolean;
    firstHour: string | null;
}

export interface OverTimeReportPayload extends DeviceReportCommon {
    granularity: DeviceReportGranularity;
    buckets: OverTimeBucket[];
    /** Every top-level device, ranked by its period total. */
    series: OverTimeSeries[];
}

/** A top-level device, or the house's remainder, of the Daily profile report. */
export interface DailyProfileRow {
    id: string;
    label: string;
    icon: string | null;
    estimated: boolean;
    unmeasured: boolean;
    kwh: number;
    /** Covered hours over the period's elapsed hours, 0..1. */
    coverage: number;
    firstHour: string | null;
    /** Mean W per local hour of day, 0..23, over the hours the row was observed; null where it never was. */
    watts: Array<number | null>;
}

export interface DailyProfileReportPayload extends DeviceReportCommon {
    /** In period-kWh order. */
    rows: DailyProfileRow[];
    /** Mean rate per local hour of day over the elapsed hours that had one. */
    importRate: Array<number | null>;
    exportRate: Array<number | null>;
}

export type ForecastStatus =
    | "not_configured"
    | "insufficient_history"
    | "unavailable"
    | "partial"
    | "available";

/** Every forecast payload is on the canonical 15-minute grid. */

export interface ForecastPointDTO {
    timestamp: string;
    value: number;
}

/**
 * How healthy the snapshot behind a forecast is.
 *
 * Reads never rebuild a forecast, so an aging snapshot is served as-is: the
 * data is old, not wrong, and blanking the card would be worse. This block is
 * the entire user-visible signal that the refresh loop has stopped. `reason` is
 * a stable machine string the frontend keys its wording off; `hint` is the
 * backend's own English wording, used only when `reason` is one we do not know.
 *
 * Optional so a payload from an older backend still types.
 */
export interface ForecastHealthDTO {
    /** When the snapshot was last successfully rebuilt; null when never. */
    generatedAt: string | null;
    isStale: boolean;
    /** e.g. "stale_forecast". Null when healthy. */
    reason: string | null;
    /** Human-readable, already worded by the backend. Null when healthy. */
    hint: string | null;
}

export interface SolarForecastDTO {
    status: ForecastStatus;
    staleness?: ForecastHealthDTO | null;
    unit: string | null;
    remainingTodayKwh?: number | null;
    remainingTodayEnergyEntityId?: string | null;
    actualHistory: ForecastPointDTO[];
    points: ForecastPointDTO[]; // forecast points at the returned response granularity
    adjustedPoints?: ForecastPointDTO[];
    /** What the bias correction is trained on and whether it applies; absent before it ever ran. */
    biasCorrection?: SolarBiasCorrectionDTO;
}

export interface SolarBiasCorrectionDTO {
    status: string;
    /** `adjusted` when `adjustedPoints` are the corrected forecast, else `raw`. */
    effectiveVariant: string | null;
    explainability: {
        fallbackReason: string | null;
        trainedAt: string | null;
        usableDays: number;
        droppedDays: number;
    };
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

export interface GridForecastSlotDTO {
    timestamp: string;
    durationHours: number;
    importedFromGridKwh: number;
    exportedToGridKwh: number;
    availableSurplusKwh?: number;
    // Who placed the scheduled action that shapes the slot, when it is one.
    setBy?: ScheduleSetBy;
    optimizer?: string;
    // The battery limits the simulation hit in the slot.
    hitMinSoc?: boolean;
    hitMaxSoc?: boolean;
    limitedByChargePower?: boolean;
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
    staleness?: ForecastHealthDTO | null;
    generatedAt: string | null;
    unit: string;
    trainingWindowDays: number;
    historyDaysAvailable: number;
    requiredHistoryDays: number;
    model: string | null;
    actualHistory: HouseConsumptionActualHourDTO[];
    currentSlot?: HouseConsumptionForecastHourDTO;
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

export type GetForecastRequest = HelmanCommands["helman/get_forecast"]["req"];

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
    // The kind of the optimizer that placed the action, when one did.
    optimizer?: string;
    // False marks a "candidate": placed by an optimizer whose execution
    // condition is not currently met. Rendered muted; not executed.
    conditionMet?: boolean;
}

export type EvChargerUseMode = "Fast" | "ECO";
export type ClimateApplianceMode = "heat" | "cool" | (string & {});

export interface ScheduleEvChargerActionDTO {
    charge: boolean;
    vehicleId?: string;
    useMode?: EvChargerUseMode;
    ecoGear?: string;
    setBy?: ScheduleSetBy;
    optimizer?: string;
    conditionMet?: boolean;
}

export interface ScheduleGenericApplianceActionDTO {
    on: boolean;
    setBy?: ScheduleSetBy;
    optimizer?: string;
    conditionMet?: boolean;
}

export interface ScheduleClimateApplianceActionDTO {
    mode: ClimateApplianceMode;
    setBy?: ScheduleSetBy;
    optimizer?: string;
    conditionMet?: boolean;
}

export type ScheduleApplianceActionDTO =
    | ScheduleEvChargerActionDTO
    | ScheduleGenericApplianceActionDTO
    | ScheduleClimateApplianceActionDTO;

export type ScheduleRuntimeReason = "scheduled" | "target_soc_reached";
export type RuntimeActionKind = "apply" | "slot_stop" | "noop";
export type RuntimeOutcome = "success" | "failed" | "skipped";

/**
 * One slot's actions, keyed by controllable id.
 *
 * The inverter sits under its reserved `inverter` id as a peer of the
 * appliances rather than in a member of its own. Its action has a different
 * shape from theirs -- as theirs already differ from each other -- so the map
 * is a union discriminated by each controllable's configured kind. An id that
 * is absent has nothing scheduled; there is no "empty" action to write.
 */
export type ScheduleControllableActionDTO = ScheduleActionDTO | ScheduleApplianceActionDTO;
export type ScheduleControllableActionsDTO = Record<string, ScheduleControllableActionDTO>;

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

export type ControllableRuntimeDTO = InverterRuntimeDTO | ApplianceRuntimeDTO;

export interface ScheduleRuntimeDTO {
    activeSlotId: string;
    controllables: Record<string, ControllableRuntimeDTO>;
    reconciledAt?: string;
}

export interface ScheduleSlotDTO {
    id: string;
    controllables: ScheduleControllableActionsDTO;
}

export interface SchedulePayload {
    executionEnabled: boolean;
    slotMinutes: number;
    slots: ScheduleSlotDTO[];
    runtime?: ScheduleRuntimeDTO;
}

export type GetScheduleRequest = HelmanCommands["helman/get_schedule"]["req"];

export type SetScheduleRequest = HelmanCommands["helman/set_schedule"]["req"];

export type SetScheduleExecutionRequest = HelmanCommands["helman/set_schedule_execution"]["req"];

export type GetEntityActualHistoryRequest = HelmanCommands["helman/get_entity_actual_history"]["req"];

/** One elapsed slot an entity spent away from its resting state. */
export interface EntityActualHistorySlotDTO {
    /** Configured controllable whose observed action this is. */
    controllableId: string;
    /** Local ISO start of the slot, on the schedule's own grid. */
    slot: string;
    /** Observed action; unrecorded settings are absent. */
    action: ScheduleControllableActionDTO;
    /** Share of the slot it was away from rest, 0-1. */
    ratio: number;
}

export interface EntityActualHistoryPayload {
    entities: Record<string, EntityActualHistorySlotDTO[]>;
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

/**
 * What every `helman/get_appliances` entry carries, whatever its kind.
 *
 * `primaryEntityId` is the entity whose state decides whether the controllable
 * is running. The card filters the roster against live `hass.states`, so it
 * reacts to state changes without asking the backend again: an entity is
 * non-normal exactly when its state differs from `normalState`.
 *
 * `actionOptions` maps schedule action kinds to the inverter mode option each
 * one selects; only the inverter carries it. It is what lets the card label the
 * live inverter mode with the slot editor's chip, and project a scheduled
 * action onto the entity state it will produce.
 *
 * `supportsAuthoring` says whether the schedule editor can author a lane for
 * it -- a climate entity with no mode to switch into cannot.
 */
export interface ApplianceMetadataDTOBase {
    id: string;
    name: string;
    kind: string;
    primaryEntityId: string;
    supportsAuthoring: boolean;
    normalState: string;
    actionOptions?: Record<string, string>;
}

/** The inverter, under its reserved controllable id; the roster fields alone. */
export interface InverterRosterEntryDTO extends ApplianceMetadataDTOBase {
    kind: "inverter";
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

/** An appliance's entry: everything on the roster but the inverter. */
export type ApplianceDTO =
    | EvChargerApplianceMetadataDTO
    | GenericApplianceMetadataRecordDTO
    | ClimateApplianceMetadataRecordDTO;

export type ApplianceMetadataDTO = InverterRosterEntryDTO | ApplianceDTO;

/** Everything Helman can drive, in configuration order, the inverter first. */
export interface AppliancesPayload {
    appliances: ApplianceMetadataDTO[];
}

export type GetAppliancesRequest = HelmanCommands["helman/get_appliances"]["req"];

/**
 * `active`: an enabled optimizer drives it under an enabled master switch.
 * `disabled_only`: optimizers target it, but none of them runs.
 */
export type AutomationCoverageStateDTO = "active" | "disabled_only";

export interface ControllableAutomationCoverageDTO {
    state: AutomationCoverageStateDTO;
    /** Every optimizer targeting it, enabled or not, in pipeline order. */
    optimizerIds: string[];
}

/** Which automations drive each controllable; one no optimizer targets is absent. */
export interface AutomationCoveragePayload {
    masterEnabled: boolean;
    controllables: Record<string, ControllableAutomationCoverageDTO>;
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

export type GetApplianceProjectionsRequest = HelmanCommands["helman/get_appliance_projections"]["req"];

// --- Node details (helman/get_node_detail) ----------------------------------

/** The nodes the backend serves a detail for. */
export type NodeDetailNode = "inverter" | "grid" | "battery" | "solar" | "house" | "ev_charger";

/** Without `section`: the node's overview. With one: only that section's history. */
export type GetNodeDetailRequest = HelmanCommands["helman/get_node_detail"]["req"];

/**
 * One reading over a local day, in five-minute buckets. A missing bucket is a
 * gap, never a zero; `coverage` is the known share of the elapsed time. The
 * extrema are the statistics' own bucket extrema (`bucket_statistics`) or the
 * raw recorded ones (`recorded`).
 */
export interface DayStatsDTO {
    entityId: string;
    unit: string | null;
    source: "statistics" | "history";
    extrema: "bucket_statistics" | "recorded";
    bucketMinutes: number;
    points: Array<{ start: string; mean: number; min: number; max: number; coverage: number }>;
    mean: number | null;
    min: number | null;
    minAt: string | null;
    max: number | null;
    maxAt: string | null;
    coverage: number;
}

/** One mode register the last command writes, and what it reads now. */
export interface ModeRegisterDTO {
    entityId: string;
    expected: string | number;
    actual: string | null;
    /** `null`: the register has no readable state. */
    matches: boolean | null;
}

/**
 * Whether the hardware's mode registers hold the last command. A
 * configuration check, not proof of the inverter's physical response.
 */
export interface ModeAgreementDTO {
    status: "match" | "mismatch" | "unknown";
    reason: "no_profile" | "no_command" | "not_bound" | "unavailable" | null;
    commanded: ScheduleActionKind | null;
    observedOption: ScheduleActionKind | null;
    /** Every register any option binds: the states `observedOption` is read from. */
    observedFrom: string[];
    registers: ModeRegisterDTO[];
}

export interface InverterDetailPayload {
    node: "inverter";
    asOf: string;
    configured: boolean;
    /** `null` for a Custom inverter: no telemetry keys in `entities` then. */
    profile: { id: string; label: string } | null;
    mode: { entityId: string; actionOptions: Partial<Record<ScheduleActionKind, string>> } | null;
    /** Metric key → entity id; a key the profile has but the registry lacks is `null`. */
    entities: Record<string, string | null>;
    maxAllowedExportPower: number | null;
    agreement: ModeAgreementDTO;
    condition: { kind: "off_grid" | "fault"; runMode: string; entityId: string } | null;
    sections: string[];
}

/** The action kind the mode control's live option selects, if it maps to one. */
export function commandedModeKind(
    mode: InverterDetailPayload["mode"],
    states: Record<string, { state: string } | undefined>,
): ScheduleActionKind | null {
    if (!mode) return null;
    const live = states[mode.entityId]?.state;
    const match = Object.entries(mode.actionOptions).find(([, option]) => option === live);
    return match ? match[0] as ScheduleActionKind : null;
}

export interface InverterTemperatureSectionPayload {
    node: "inverter";
    section: "temperature";
    asOf: string;
    period: { start: string; end: string };
    temperature: DayStatsDTO | null;
}

/**
 * Today's observed modes, replayed from the recorded states of the registers
 * the profile's modes write: each stretch with the action kind the registers
 * held, `null` where they held none (unreadable, unrecorded, or a combination
 * no mode writes). `open` marks the last stretch, still going at `asOf`.
 * `modes` is `null` without registers to read (a Custom inverter).
 */
export interface InverterModesSectionPayload {
    node: "inverter";
    section: "modes";
    asOf: string;
    period: { start: string; end: string };
    modes: Array<{ start: string; end: string; kind: ScheduleActionKind | null; open: boolean }> | null;
}

/**
 * The grid detail's overview. `entities` carries the profile's grid telemetry
 * (absent for a Custom inverter, `null` where the registry lacks one) and the
 * grid's own `power` and today meters. `phasePowerPolarity` says which way the
 * `grid_power_l*` readings are positive.
 */
export interface GridDetailPayload {
    node: "grid";
    asOf: string;
    profile: { id: string; label: string } | null;
    entities: Record<string, string | null>;
    phasePowerPolarity: "positive_is_import" | "positive_is_export" | null;
    maxAllowedExportPower: number | null;
    condition: { kind: "off_grid" | "fault"; runMode: string; entityId: string } | null;
    sections: string[];
}

/**
 * The grid meter's power today, W, in Helman's convention
 * whatever the sensor's polarity: **positive is export, negative is import**.
 * `power` is `null` without the meter or in a unit not known; `unit` is its own.
 */
export interface GridPowerSectionPayload {
    node: "grid";
    section: "power";
    asOf: string;
    period: { start: string; end: string };
    power: DayStatsDTO | null;
    unit: string | null;
}

/**
 * Today's phase voltages. `spread` is the largest difference between the
 * compared phases' means within one five-minute bucket all of them know;
 * `coverage` is the share of the elapsed day they were known together.
 */
export interface GridVoltageSectionPayload {
    node: "grid";
    section: "voltage";
    asOf: string;
    period: { start: string; end: string };
    /** By phase number; `null` for a phase without a resolved sensor. */
    phases: Record<"1" | "2" | "3", DayStatsDTO | null>;
    spread: { phases: number[]; max: number | null; maxAt: string | null; coverage: number };
}

/**
 * The battery detail's overview. `entities` carries the battery's config meters
 * (`soc`, `remaining_energy`, `min_soc`, `max_soc`, `today_charge`,
 * `today_discharge`), Helman's `time_to_full`/`time_to_empty` sensors and the
 * profile's battery telemetry (absent for a Custom inverter, `null` where the
 * registry lacks one).
 */
export interface BatteryDetailPayload {
    node: "battery";
    asOf: string;
    profile: { id: string; label: string } | null;
    entities: Record<string, string | null>;
    /** Helman's planning ceilings from the battery's forecast config, W. */
    configured: { maxChargePowerW: number | null; maxDischargePowerW: number | null };
    /**
     * `(lifetime in + out) / (2 × nominal capacity)`: throughput, not health.
     * `cycles` is `null` with a `reason` without valid counters and capacity.
     */
    cycles: {
        cycles: number | null;
        inputKwh: number | null;
        outputKwh: number | null;
        capacityKwh: number | null;
        reason: "no_counters" | "invalid_counters" | "no_capacity" | null;
    };
    /** A condition the hardware explicitly reports: the BMS state first, then the run mode. */
    condition: { kind: "bms_disconnected" | "off_grid" | "fault"; state: string; entityId: string } | null;
    sections: string[];
}

/**
 * Today's battery charge by what charged it, from the device reports'
 * `chargeOrigin` in kWh. What charged the battery in the period, not what is
 * stored in it now. A money side is `0` without kWh and `null` with kWh but no rate.
 */
export interface BatteryChargeDTO {
    chargedKwh: number;
    solarKwh: number;
    gridKwh: number;
    unknownKwh: number;
    gridPricedKwh: number;
    gridTariffKwh: number;
    gridUnpricedKwh: number;
    solarPricedKwh: number;
    solarUnpricedKwh: number;
    /** Energy-weighted import rate over the priced grid charge. */
    paidRate: number | null;
    /** Energy-weighted export rate over the priced solar charge. */
    forgoneRate: number | null;
    paidCost: number | null;
    forgoneValue: number | null;
}

export interface BatteryChargeSectionPayload {
    node: "battery";
    section: "charge";
    asOf: string;
    period: { start: string; end: string };
    /** The price unit the money is in, such as `CZK/kWh`. */
    priceUnit: string | null;
    complete: boolean;
    /** Why there is no charge origin: the reports cannot be built. */
    unavailable: string | null;
    charge: BatteryChargeDTO | null;
}

/**
 * The solar detail's overview. `entities` carries the solar node's `power` and
 * `today_energy` meters, the lifetime counter (`lifetime_energy`), the grid's
 * `today_export` and the profile's string, cap and setting telemetry (absent
 * for a Custom inverter, `null` where the registry lacks one). `strings` are
 * the strings whose power the profile resolves.
 */
export interface SolarDetailPayload {
    node: "solar";
    asOf: string;
    profile: { id: string; label: string } | null;
    entities: Record<string, string | null>;
    strings: number[];
    /** The solar node's configured `max_power`, W: configured capacity, not a measurement. */
    configuredMaxPowerW: number | null;
    maxAllowedExportPower: number | null;
    condition: { kind: "off_grid" | "fault"; runMode: string; entityId: string } | null;
    sections: string[];
}

/** Today's solar power in W, production positive; `power` is `null` in a unit not known. */
export interface SolarProductionSectionPayload {
    node: "solar";
    section: "production";
    asOf: string;
    period: { start: string; end: string };
    power: DayStatsDTO | null;
    /** The sensor's own unit. */
    unit: string | null;
}

/**
 * The last 24 hours of solar power (W): the solar meter's total, production
 * positive (`null` without the meter or in a unit not known, `unit` its own),
 * and each string's, with their energies. A string's `kwh` integrates its
 * known time only; `common` compares the strings over the buckets all of them
 * know, so their shares compare like with like.
 */
export interface SolarPowerSectionPayload {
    node: "solar";
    section: "power";
    asOf: string;
    period: { start: string; end: string };
    power: DayStatsDTO | null;
    unit: string | null;
    strings: Record<string, { entityId: string; unit: string | null; day: DayStatsDTO | null } | null>;
    energy: {
        strings: Record<string, { kwh: number | null; coverage: number }>;
        common: { strings: number[]; coverage: number; kwh: Record<string, number> | null };
    };
}

/**
 * Where a period's measured solar went, estimated from the same per-hour
 * flows the reports solve: solar the meters do not explain, and solar in
 * hours without a source mix, stays unresolved:
 * `house + battery + export + unresolved = produced`.
 */
export interface SolarDestinationsDTO {
    producedKwh: number;
    /** Solar in the hours with a source mix, the only ones the shares cover. */
    attributedKwh: number;
    /** Solar in hours without a source mix; part of `unresolvedKwh`. */
    unattributedKwh: number;
    houseKwh: number;
    batteryKwh: number;
    exportKwh: number;
    unresolvedKwh: number;
    measuredExportKwh: number;
    /** Measured export the solar did not account for: the battery's. */
    otherExportKwh: number;
    /** The solar export's money at each hour's export rate; `null` when none of it was priced, `0` when nothing was exported. */
    exportMoney: number | null;
    exportPricedKwh: number;
}

export interface SolarDestinationsSectionPayload {
    node: "solar";
    section: "destinations";
    asOf: string;
    period: { start: string; end: string };
    priceUnit: string | null;
    complete: boolean;
    /** Why there are no destinations: the reports cannot be built, or there is no solar meter. */
    unavailable: string | null;
    destinations: SolarDestinationsDTO | null;
    /** Today's battery charge origin, for the solar charge's forgone export value. */
    charge: BatteryChargeDTO | null;
}

/**
 * The house detail's overview. `entities` carries the house `power` meter,
 * Helman's live source-ratio sensors (`solar_ratio`, `battery_ratio`,
 * `grid_ratio`), its battery `time_to_empty`, its measured house consumption
 * (`phase_power_l1..3`, `phase_power_total`) and the profile's phase readings
 * that is computed from (`ac_power_l1..3`, `grid_power_l1..3`,
 * `eps_power_l1..3`, absent for a Custom inverter). `phasePowerPolarity` says
 * which way the `grid_power_l*` readings are positive.
 */
export interface HouseDetailPayload {
    node: "house";
    asOf: string;
    profile: { id: string; label: string } | null;
    entities: Record<string, string | null>;
    phasePowerPolarity: "positive_is_import" | "positive_is_export" | null;
    condition: { kind: "off_grid" | "fault"; runMode: string; entityId: string } | null;
    sections: string[];
}

/** A ranking node's attributed money: estimates, not a bill. An amount is `null` when nothing was priced. */
export interface HouseMoneyDTO {
    paid: number | null;
    paidPricedKwh: number;
    paidUnpricedKwh: number;
    forgone: number | null;
    forgonePricedKwh: number;
    forgoneUnpricedKwh: number;
}

/** One load of the house, counted once: a device, or a metered parent's own share (`ownOf`). */
export interface HouseLoadDTO {
    id: string;
    label: string;
    ownOf: string | null;
    estimated: boolean;
    kwh: number;
    coverage: number;
    money: HouseMoneyDTO;
}

/** Today's house figures, from the ranking report. */
export interface HouseTodaySectionPayload {
    node: "house";
    section: "today";
    asOf: string;
    period: { start: string; end: string };
    priceUnit: string | null;
    complete: boolean;
    unavailable: string | null;
    house: {
        kwh: number;
        coverage: number;
        sources: { solar: number; battery: number; grid: number; unattributed: number };
        money: HouseMoneyDTO;
        ambiguousKwh: number;
        mismatchKwh: number;
    } | null;
    /** `(house − grid − unattributed) / house`; `null` without house energy. */
    independence: { share: number; gridShare: number; unknownShare: number } | null;
    /** `(solar → house + solar → battery) / matched solar`; `share` `null` with a `reason`. */
    selfConsumption: {
        share: number | null;
        reason: "no_solar_meter" | "no_matched_solar" | null;
        destinations: SolarDestinationsDTO | null;
    } | null;
    consumers: {
        top: HouseLoadDTO[];
        others: { count: number; kwh: number };
        /** The house's own remainder: what no device meter explains. */
        unmeasuredKwh: number | null;
        overallocatedKwh: number;
    } | null;
}

/** Today against earlier same weekdays, the overnight minimum and the learned profile. */
export interface HousePatternSectionPayload {
    node: "house";
    section: "pattern";
    asOf: string;
    period: { start: string; end: string };
    comparison: {
        unavailable: "no_energy_meter" | "no_elapsed_hour" | null;
        /** The end of the completed hours compared. */
        until: string;
        elapsedHours: number;
        comparedHours: number;
        todayKwh: number | null;
        averageKwh: number | null;
        ratio: number | null;
        used: number;
        days: Array<{ date: string; kwh: number | null; knownHours: number }>;
    };
    overnight: {
        start: string;
        end: string;
        complete: boolean;
        unavailable: "no_power_sensor" | "unit" | null;
        minimum: { watts: number; at: string; coverage: number } | null;
        coverage: number;
    };
    /** kWh per hour, Monday first; `null` while no profile is fitted. */
    profile: { historyDays: number; trainedAt: string | null; kwh: number[][] } | null;
}

/**
 * One EV charger's detail overview, by its consumer id. `entities` carries the
 * device's config (`power`, `energy_total`, `charge_switch`, `use_mode`,
 * `eco_gear`) and, with a hardware profile, its telemetry. `status` is the run
 * mode the profile names.
 */
export interface EvChargerDetailPayload {
    node: "ev_charger";
    deviceId: string;
    asOf: string;
    profile: { id: string; label: string } | null;
    entities: Record<string, string | null>;
    status: { kind: "charging" | "waiting" | "no_car" | "fault"; runMode: string; entityId: string } | null;
    sections: string[];
}

/**
 * When the charger's charging run mode began, as recorded: the start of a
 * charging segment, not the plugged-in session. `chargingSince` is `null`
 * while not charging, or when the record cannot tell. `charging` is today's
 * recorded charging stretches, from the same run mode history; `null`
 * without a run mode to read.
 */
export interface EvChargerSegmentSectionPayload {
    node: "ev_charger";
    section: "segment";
    deviceId: string;
    asOf: string;
    period: { start: string; end: string };
    chargingSince: string | null;
    /** `open`: still charging when read, so it ends at `asOf`. */
    charging: Array<{ start: string; end: string; open: boolean }> | null;
}

/** Today's sources and attributed money of one charger, from the ranking report: today, not the session. */
export interface EvChargerTodaySectionPayload {
    node: "ev_charger";
    section: "today";
    deviceId: string;
    asOf: string;
    period: { start: string; end: string };
    priceUnit: string | null;
    complete: boolean;
    unavailable: string | null;
    charger: {
        kwh: number;
        coverage: number;
        estimated: boolean;
        sources: { solar: number; battery: number; grid: number; unattributed: number };
        money: HouseMoneyDTO;
    } | null;
}

/**
 * One local day of grid detail money, projected from the inspector's span
 * aggregates. Each side is `null` where its money is unknown.
 */
export interface GridMoneySectionPayload {
    node: "grid";
    section: "money";
    asOf: string;
    priceUnit: string | null;
    unavailable: string | null;
    importCost: number | null;
    exportRevenue: number | null;
    importKwh: number | null;
    exportKwh: number | null;
    importPricedKwh: number | null;
    exportPricedKwh: number | null;
}

export interface HouseRankingSectionPayload {
    node: "house";
    section: "ranking";
    asOf: string;
    period: { start: string; end: string };
    unavailable: string | null;
    report: RankingReportPayload | null;
}

/** Explicit device suggestions preserve every candidate, including ambiguity. */
export interface DeviceEntityCandidate {
  entityId: string;
  name: string;
  /** Why it was suggested, as a code the editor translates. */
  reasons: { code: string; value?: string }[];
  rank: number;
}
export type DeviceSuggestions = Record<
  "energy" | "power" | "switch",
  DeviceEntityCandidate[]
>;
export interface EnergyImportPreview {
  devices: JsonObject[];
  additions: {
    deviceId: string;
    parentId: string | null;
    energyEntityId: string;
    powerEntityId: string | null;
  }[];
  powerEntities: { deviceId: string; entityId: string }[];
  nestingChanges: {
    deviceId: string;
    fromParentId: string | null;
    parentId: string | null;
  }[];
  skippedRows: {
    energy_entity_id: string;
    device_id: string | null;
    reason: string;
  }[];
  warnings: {
    energy_entity_id: string;
    device_id: string | null;
    reason: string;
  }[];
  validation: ValidationReport;
}

export type GetDayAggregatesRequest = HelmanCommands["helman/solar_bias/day_aggregates"]["req"];

export async function fetchDayAggregates(
  hass: HomeAssistant,
  request: GetDayAggregatesRequest,
): Promise<DayAggregatesPayload> {
  return callHelman(hass, "helman/solar_bias/day_aggregates", request);
}

