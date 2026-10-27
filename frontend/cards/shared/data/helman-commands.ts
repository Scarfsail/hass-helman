import type { HomeAssistant } from "../../../types/ha";
import type * as Api from "../../helman-api";
import type { ConfigSnapshot, JsonObject, SaveConfigResponse, ValidationReport, VendorsResponse } from "../config/types";
import type { ConfigDefaults } from "../config/config-defaults";
import type { EntityInspectionResult } from "../config/entity-group";
import type { OptimizerSchemaDocument } from "../optimizer/optimizer-schema";
import type { NavigationRange } from "../../helman-solar-inspector/inspector-navigation";
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
    /** Gross house source mix energy-weighted over the bucket's hours. */
    houseSourceMix?: {
        solar: number;
        battery: number;
        grid: number;
        unattributed: number;
    } | null;
}

export interface DayAggregatesPayload {
    bucket: "day" | "month";
    priceUnit: string | null;
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

export type ExplanationNodeState =
    | "true"
    | "false"
    | "not_evaluated"
    | "not_applicable";

export type ExplanationNodeScope = "slot" | "day" | "window" | "run";

export type ExplanationVerdict = "execute" | "candidate" | "skip";

export type ExplanationStatus = "ok" | "skipped" | "failed";

/** The authoritative runtime phases that emit explanation records. */
export type ExplanationPhase = 2 | 3;

export type ExplanationParamsSource =
    | "slot_matched"
    | "day_resolved"
    | "master_fallback";

/** One condition node as it resolved for one slot; absent keys were not recorded. */
export interface ExplanationConditionRow {
    key: string;
    scope: ExplanationNodeScope;
    state: ExplanationNodeState;
    value?: unknown;
    actual?: unknown;
}
export interface ExplanationGateRow {
    key: string;
    role: "veto" | "advisory" | "override";
    state: ExplanationNodeState;
    params: Record<string, unknown>;
}
export interface ExplanationGroupRow {
    index: number;
    label: string;
    paramsSource: ExplanationParamsSource;
    params: Record<string, unknown>;
    customResults: (boolean | null)[];
    conditions: ExplanationConditionRow[];
}
/** One optimizer's account of one slot. A slot it said nothing about has no row. */
export interface ExplanationSlotRow {
    slotId: string;
    runAt: string;
    verdict: ExplanationVerdict;
    winningOptimizer?: string;
    /** The group `Eligibility.at(slot)` matched; absent when no group covers the slot. */
    matchedGroupIndex?: number;
    groups: ExplanationGroupRow[];
    gates: ExplanationGateRow[];
}
/** What a condition column is, as opposed to what it found in any one slot. */
export interface ExplanationConditionColumnRow {
    key: string;
    /** Resolved by the optimizer for the slot, not by group matching. */
    selfGating?: true;
    /** How the test compares `actual` with `value`; absent where it does not compare. */
    operator?: string;
}
export interface ExplanationOptimizerRows {
    optimizerId: string;
    kind: string;
    phase: ExplanationPhase;
    status: ExplanationStatus;
    controllableId?: string;
    statusReason?: string;
    conditions: ExplanationConditionColumnRow[];
    slots: ExplanationSlotRow[];
}
export interface ScheduleExplanationPayload {
    controllableId: string;
    date: string;
    slotIds: string[];
    runAt: string | null;
    optimizers: ExplanationOptimizerRows[];
}

export type NodeDetailPayload = Api.InverterDetailPayload | Api.InverterTemperatureSectionPayload
    | Api.InverterModesSectionPayload | Api.GridDetailPayload | Api.GridVoltageSectionPayload | Api.GridMoneySectionPayload
    | Api.BatteryDetailPayload | Api.BatteryChargeSectionPayload
    | Api.SolarDetailPayload | Api.SolarProductionSectionPayload | Api.SolarStringsSectionPayload
    | Api.SolarDestinationsSectionPayload | Api.HouseDetailPayload | Api.HouseTodaySectionPayload
    | Api.HousePatternSectionPayload | Api.HouseRankingSectionPayload | Api.EvChargerDetailPayload | Api.EvChargerSegmentSectionPayload
    | Api.EvChargerTodaySectionPayload;

/** All request/response commands; subscribe_updates belongs to the shared feed. */
export interface HelmanCommands {
    "helman/get_config": { req: { include_revision: true }; res: ConfigSnapshot };
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
    "helman/set_schedule": { req: { slots: Api.ScheduleSlotDTO[] }; res: Api.SchedulePayload };
    "helman/set_schedule_execution": { req: { enabled: boolean }; res: Api.SchedulePayload };
    "helman/get_automation_coverage": { req: Record<string, never>; res: Api.AutomationCoveragePayload };
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
