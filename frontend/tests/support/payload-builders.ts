import type { ConfigDocument, ForecastPayload, InspectorPayload, SchedulePayload, TreeItemDTO, TreePayload } from "../../cards/helman-api";
import type { ConfigSnapshot } from "../../cards/shared/config/types";
import type {
    ExplanationConditionColumnRow,
    ExplanationGateRow,
    ExplanationGroupRow,
    ExplanationOptimizerRows,
    ExplanationSlotRow,
    ScheduleExplanationPayload,
} from "../../cards/shared/data/helman-commands";

type InspectorDayOverrides = Omit<Partial<InspectorPayload>, "range" | "series" | "totals" | "availability"> & {
    range?: Partial<InspectorPayload["range"]>;
    series?: Partial<InspectorPayload["series"]>;
    totals?: Partial<InspectorPayload["totals"]>;
    availability?: Partial<InspectorPayload["availability"]>;
};

export function inspectorDay(overrides: InspectorDayOverrides = {}): InspectorPayload {
    const { range, series, totals, availability, ...rest } = overrides;
    return {
        date: "2026-01-01", timezone: "UTC", status: "unavailable", effectiveVariant: null, trainedAt: null,
        range: { minDate: "", maxDate: "", canGoPrevious: false, canGoNext: false, isToday: false, isFuture: false, ...range },
        series: { raw: [], corrected: [], actual: [], invalidated: [], factors: [], impact: [], houseForecast: [], houseActual: [], houseActualBreakdown: [], houseForecastBreakdown: [], batterySocForecast: [], batterySocActual: [], gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [], importPrice: [], exportPrice: [], moneyActual: [], moneyForecast: [], ...series },
        totals: { rawWh: null, correctedWh: null, actualWh: null, houseForecastWh: null, houseActualWh: null, gridForecastWh: null, gridActualWh: null, batteryForecastWh: null, batteryActualWh: null, moneyActual: null, moneyForecast: null, ...totals },
        availability: { hasProfile: false, ...availability },
        batterySocBounds: [], priceUnit: null, trainingExplainability: null,
        ...rest,
    };
}

export function configDoc<T extends Partial<ConfigDocument>>(overrides: T): ConfigDocument & T;
export function configDoc(): ConfigDocument;
export function configDoc(overrides: Partial<ConfigDocument> = {}): ConfigDocument {
    return {
        config_version: 29,
        ...overrides,
    };
}

export function configSnapshot(config: ConfigDocument): ConfigSnapshot {
    const canonical = (value: unknown): unknown => Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
            : value;
    return { config, revision: JSON.stringify(canonical(config)) };
}

/** Backend-shaped payloads shared by the WebSocket mock and individual specs. */
export function treeNode(overrides: Partial<TreeItemDTO> = {}): TreeItemDTO {
    return {
        id: "sensor.test",
        displayName: "Test",
        powerSensorId: null,
        valueType: "default",
        sourceType: null,
        switchEntityId: null,
        isSource: false,
        isUnmeasured: false,
        groups: {},
        groupBadgeTexts: [],
        icon: null,
        compact: false,
        showAdditionalInfo: false,
        childrenFullWidth: false,
        hideChildren: false,
        hideChildrenIndicator: false,
        sortChildrenByPower: false,
        children: [],
        ratioSensorId: null,
        deferrable: false,
        controllableIds: [],
        climateEntityId: null,
        energyEntityId: null,
        isEstimated: false,
        phase: null,
        power: null,
        maxPowerW: null,
        socEntityId: null,
        minSocEntityId: null,
        maxSocEntityId: null,
        remainingEnergyEntityId: null,
        todayEnergyEntityId: null,
        todayImportEntityId: null,
        todayExportEntityId: null,
        ...overrides,
    };
}

export function treePayload(overrides: Partial<TreePayload> = {}): TreePayload {
    return {
        sources: [],
        consumers: [],
        consumptionTotalSensorId: null,
        productionTotalSensorId: null,
        uiConfig: { device_groupings: [], history_buckets: 0, history_bucket_duration: 0 },
        ...overrides,
    };
}

/**
 * The typed fields the backend resolves for an energy node at its max-power
 * defaults, its power on `sensor.<device>`. The grid meter reads positive
 * importing (`sign: -1` in Helman's export-positive convention) unless
 * `gridSign` says otherwise.
 */
export function energyFields(device: string, gridSign: 1 | -1 = -1): Partial<TreeItemDTO> {
    switch (device) {
        case "solar": return { maxPowerW: 5000 };
        case "grid": return { maxPowerW: 11500, power: { entityId: "sensor.grid", sign: gridSign } };
        case "battery": return { maxPowerW: 5000, power: { entityId: "sensor.battery", sign: 1 } };
        default: return {};
    }
}

/** The four power-card roots used by node-detail specs. */
export function cardTree(gridSign: 1 | -1 = -1): TreePayload {
    const node = (id: string, sensor: string, sourceType: string | null) => treeNode({
        id, displayName: id, powerSensorId: sensor, sourceType, isSource: sourceType !== null,
        ...energyFields(id, gridSign),
    });
    return treePayload({
        sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid", "grid"), node("battery", "sensor.battery", "battery")],
        consumers: [node("house", "sensor.house", null)],
        uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
    });
}

export function forecastPayload(overrides: Partial<ForecastPayload> = {}): ForecastPayload {
    return {
        solar: { status: "unavailable", unit: "Wh", actualHistory: [], points: [] },
        grid: { status: "unavailable", generatedAt: null, unit: "kWh", startedAt: null, partialReason: null, coverageUntil: null, currentImportPrice: null, importPriceUnit: null, importPricePoints: [], currentExportPrice: null, exportPriceUnit: null, exportPricePoints: [], series: [] },
        house_consumption: { status: "unavailable", generatedAt: null, unit: "Wh", trainingWindowDays: 0, historyDaysAvailable: 0, requiredHistoryDays: 0, model: null, actualHistory: [], forecastHistory: [], series: [] },
        battery_capacity: { status: "unavailable", generatedAt: null, startedAt: null, unit: "kWh", model: null, nominalCapacityKwh: null, currentRemainingEnergyKwh: null, currentSoc: null, minSoc: null, maxSoc: null, chargeEfficiency: null, dischargeEfficiency: null, maxChargePowerW: null, maxDischargePowerW: null, partialReason: null, coverageUntil: null, actualHistory: [], forecastHistory: [], series: [] },
        ...overrides,
    };
}

export interface ScheduleSlotsOptions {
    slotMinutes: number;
    start?: string;
    count?: number;
    overrides?: Partial<Omit<SchedulePayload, "slotMinutes">>;
}

export function scheduleSlots({ slotMinutes, start = "2026-01-01T00:00:00.000Z", count = 0, overrides = {} }: ScheduleSlotsOptions): SchedulePayload {
    if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) throw new RangeError("slotMinutes must be a positive integer");
    return {
        executionEnabled: true,
        slotMinutes,
        slots: Array.from({ length: count }, (_, index) => ({
            id: new Date(Date.parse(start) + index * slotMinutes * 60_000).toISOString(),
            controllables: {},
        })),
        ...overrides,
    };
}

/** What each condition column is, as `conditions/types.py` registers it. */
const CONDITION_COLUMNS: Record<string, Omit<ExplanationConditionColumnRow, "key">> = {
    run_when: { operator: "∈" },
    when_price_below: { operator: "<" },
    max_run_price: { operator: "<" },
    min_soc_pct: { operator: "≥" },
    min_solar_coverage_pct: { operator: "≥" },
    ensure_self_sustainability: { selfGating: true },
    reserve_floor_soc: { selfGating: true },
};

export type ExplanationGroupInput = Partial<ExplanationGroupRow>;
export type ExplanationGateInput = Omit<ExplanationGateRow, "params"> & Partial<Pick<ExplanationGateRow, "params">>;
export type ExplanationSlotInput = Partial<Omit<ExplanationSlotRow, "groups" | "gates">>
    & Pick<ExplanationSlotRow, "slotId"> & { groups?: ExplanationGroupInput[]; gates?: ExplanationGateInput[] };
export type ExplanationOptimizerInput = Partial<Omit<ExplanationOptimizerRows, "slots">>
    & Pick<ExplanationOptimizerRows, "optimizerId"> & { slots?: ExplanationSlotInput[] };
export type ExplanationRowsInput = Partial<Omit<ScheduleExplanationPayload, "optimizers">>
    & { optimizers?: ExplanationOptimizerInput[] };

/**
 * A `helman/get_schedule_explanation` payload: one plain row per explained slot.
 *
 * Fills in what a fixture does not care about: a group's index is its position,
 * an optimizer's kind is its id, a row's `runAt` is the payload's, and the
 * optimizer-level `conditions` list names every condition key its rows use, in
 * first-appearance order, with the backend's facts about it.
 */
export function explanationRows({ optimizers = [], ...overrides }: ExplanationRowsInput = {}): ScheduleExplanationPayload {
    const controllableId = overrides.controllableId ?? "inverter";
    const runAt = overrides.runAt ?? null;
    const built = optimizers.map(({ slots = [], ...optimizer }): ExplanationOptimizerRows => {
        const rows = slots.map(({ groups = [], gates = [], ...slot }): ExplanationSlotRow => ({
            runAt: runAt ?? "",
            verdict: "skip",
            ...slot,
            groups: groups.map((group, index) => ({
                index, label: "", paramsSource: "slot_matched", params: {}, customResults: [], conditions: [], ...group,
            })),
            gates: gates.map((gate) => ({ params: {}, ...gate })),
        }));
        const keys = [...new Set(rows.flatMap((row) => row.groups.flatMap((group) => group.conditions.map((node) => node.key))))];
        return {
            kind: optimizer.optimizerId,
            phase: 2,
            status: "ok",
            controllableId,
            conditions: keys.map((key) => ({ key, ...CONDITION_COLUMNS[key] })),
            ...optimizer,
            slots: rows,
        };
    });
    return {
        controllableId,
        date: "2026-07-31",
        slotIds: [...new Set(built.flatMap((optimizer) => optimizer.slots.map((row) => row.slotId)))],
        runAt,
        ...overrides,
        optimizers: built,
    };
}
