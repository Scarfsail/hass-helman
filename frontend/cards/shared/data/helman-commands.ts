import type { HomeAssistant } from "../../../types/ha";
import type * as Api from "../../helman-api";
import type { ConfigSnapshot, JsonObject, SaveConfigResponse, ValidationReport, VendorsResponse } from "../config/types";
import type { ConfigDefaults } from "../config/config-defaults";
import type { EntityInspectionResult } from "../config/entity-group";
import type { OptimizerSchemaDocument } from "../optimizer/optimizer-schema";
import type { NavigationRange } from "../../helman-solar-inspector/helman-solar-aggregate-chart";
import type { ApplianceComponent } from "../../helman-solar-inspector/solar-inspector-model";
import type { TrainingStatus } from "../../../config-editor/training-status";

/** One bucket of the span read: a local day, or a local month. */
export interface DayAggregateRow {
    /** `YYYY-MM-DD` for a day bucket, `YYYY-MM-01` for a month one. */
    date: string;
    solarWh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    batteryMinSocPct: number | null;
    batteryMaxSocPct: number | null;
    houseWh: number | null;
    batteryChargeWh: number | null;
    batteryDischargeWh: number | null;
    moneyCost: number | null;
    moneyGain: number | null;
    moneyCostKwh: number | null;
    moneyGainKwh: number | null;
    /** Only when the request asks for house_forecast. */
    houseForecastWh?: number | null;
    /**
     * What the house was doing this bucket: every metered consumer's energy plus
     * the remainder no individual meter accounted for.
     *
     * The appliance shape is the day slot's, field for field, so the panel and
     * the chart parse a bucket's composition with the types they already have.
     * Null where there is nothing to split by -- no consumers configured -- or
     * nothing to split, the house meter having reported no energy for the
     * bucket.
     */
    houseBreakdown?: {
        unmeasuredWh: number;
        appliances: ApplianceComponent[];
    } | null;
}

export interface DayAggregatesPayload {
    bucket: "day" | "month";
    currency: string | null;
    days: DayAggregateRow[];
    range?: NavigationRange;
}

export interface ConditionTracePayload {
    optimizerId: string;
    groupIndex: number;
    runAt: string;
    config: unknown[];
    trace: Record<string, unknown[]>;
}

type ExplanationRuns<T> = [T | null, number][];
interface ExplanationConditionColumn {
    key: string;
    scope: "slot" | "day" | "window" | "run";
    state: ExplanationRuns<string>;
    value?: ExplanationRuns<unknown>;
    actual?: Record<string, unknown>;
}
interface ExplanationGroupColumn {
    index: number;
    label: string;
    paramsSource: ExplanationRuns<string>;
    params?: ExplanationRuns<Record<string, unknown>>;
    customResults?: ExplanationRuns<unknown[]>;
    conditions?: ExplanationConditionColumn[];
}
interface ExplanationOptimizerColumn {
    optimizerId: string;
    kind: string;
    phase: 2 | 3;
    status: string;
    verdict: ExplanationRuns<string>;
    controllableId?: string;
    statusReason?: string;
    winningOptimizer?: Record<string, string>;
    groups?: ExplanationGroupColumn[];
    gates?: { key: string; state: ExplanationRuns<string>; params?: ExplanationRuns<Record<string, unknown>> }[];
    runAt: ExplanationRuns<string>;
}
export interface ScheduleExplanationPayload {
    controllableId: string;
    date: string;
    slotIds: string[];
    runAt: string | null;
    optimizers: ExplanationOptimizerColumn[];
}

export interface SolarBiasStatus {
    enabled: boolean;
    minHistoryDays: number;
    slotInvalidationEnabled: boolean;
    status: string;
    effectiveVariant: string;
    trainedAt: string | null;
    lastAttemptAt: string | null;
    nextScheduledTrainingAt: string | null;
    trainingConfigFingerprint: string | null;
    isStale: boolean | null;
    lastOutcome: string | null;
    fallbackReason: string | null;
    usableDays: number;
    droppedDays: { date: string; reason: string }[];
    omittedSlotCount: number;
    invalidatedSlotCount: number;
    factorSummary: { min: number | null; max: number | null; median: number | null };
    errorReason: string | null;
}

export type NodeDetailPayload = Api.InverterDetailPayload | Api.InverterTemperatureSectionPayload
    | Api.InverterModesSectionPayload | Api.GridDetailPayload | Api.GridVoltageSectionPayload
    | Api.BatteryDetailPayload | Api.BatteryChargeSectionPayload | Api.FlowsSectionPayload
    | Api.SolarDetailPayload | Api.SolarProductionSectionPayload | Api.SolarStringsSectionPayload
    | Api.SolarDestinationsSectionPayload | Api.HouseDetailPayload | Api.HouseTodaySectionPayload
    | Api.HousePatternSectionPayload | Api.EvChargerDetailPayload | Api.EvChargerSegmentSectionPayload
    | Api.EvChargerTodaySectionPayload;

/** All request/response commands; subscribe_updates belongs to the shared feed. */
export interface HelmanCommands {
    "helman/get_config": { req: Record<string, never>; res: ConfigSnapshot };
    "helman/validate_config": { req: { config: JsonObject }; res: ValidationReport };
    "helman/save_config": { req: { config: JsonObject; expected_revision?: string }; res: SaveConfigResponse };
    "helman/get_config_defaults": { req: Record<string, never>; res: ConfigDefaults };
    "helman/get_optimizer_schema": { req: Record<string, never>; res: OptimizerSchemaDocument };
    "helman/get_vendors": { req: { config: JsonObject }; res: VendorsResponse };
    "helman/inspect_entities": { req: { config: JsonObject; saved_config?: JsonObject; targets: { key: string; path: (string | number)[] }[] }; res: { results: EntityInspectionResult[] } };
    "helman/get_device_tree": { req: Record<string, never>; res: Api.TreePayload };
    "helman/get_history": { req: Record<string, never>; res: Api.HistoryPayload };
    "helman/get_device_stats": { req: { device_key: string }; res: Api.DeviceStats | null };
    "helman/device_report": { req: Api.DeviceReportQuery & { report: string }; res: Api.RankingReportPayload | Api.OverTimeReportPayload | Api.DailyProfileReportPayload | Api.DeviceReportUnavailable };
    "helman/get_forecast": { req: Record<string, never>; res: Api.ForecastPayload };
    "helman/get_schedule": { req: Record<string, never>; res: Api.SchedulePayload };
    "helman/set_schedule": { req: { slots: Api.ScheduleSlotDTO[] }; res: Api.SetScheduleResponse };
    "helman/set_schedule_execution": { req: { enabled: boolean }; res: Api.SetScheduleExecutionResponse };
    "helman/get_controllable_entities": { req: Record<string, never>; res: Api.ControllableEntitiesPayload };
    "helman/get_entity_actual_history": { req: Record<string, never>; res: Api.EntityActualHistoryPayload };
    "helman/get_appliances": { req: Record<string, never>; res: Api.AppliancesPayload };
    "helman/get_appliance_projections": { req: Record<string, never>; res: Api.ApplianceProjectionsPayload };
    "helman/get_node_detail": { req: { node: Api.NodeDetailNode; device_id?: string; section?: string }; res: NodeDetailPayload };
    "helman/get_schedule_explanation": { req: { controllable_id: string; date: string }; res: ScheduleExplanationPayload | null };
    "helman/get_condition_trace": { req: { optimizer_id: string; group_index: number }; res: ConditionTracePayload | null };
    "helman/suggest_device_entities": { req: { anchor_entity_ids: string[]; config: object }; res: Api.DeviceSuggestions };
    "helman/preview_energy_import": { req: { config: object }; res: Api.EnergyImportPreview };
    "helman/solar_bias/day_aggregates": { req: { start_date: string; end_date: string; bucket?: "day" | "month"; house_breakdown?: boolean; house_forecast?: boolean }; res: DayAggregatesPayload };
    "helman/solar_bias/inspector": { req: { date: string }; res: Api.InspectorPayload };
    "helman/solar_bias/status": { req: Record<string, never>; res: SolarBiasStatus };
    "helman/training/status": { req: Record<string, never>; res: TrainingStatus };
    "helman/training/train_now": { req: { job?: string }; res: { outcomes: Record<string, string>; status: TrainingStatus } };
}

export function callHelman<K extends keyof HelmanCommands>(
    hass: Pick<HomeAssistant, "callWS">,
    type: K,
    req: HelmanCommands[K]["req"],
): Promise<HelmanCommands[K]["res"]> {
    return hass.callWS<HelmanCommands[K]["res"]>({ ...req, type });
}
