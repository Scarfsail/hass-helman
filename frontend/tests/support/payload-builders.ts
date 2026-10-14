import type { ConfigDocument, ForecastPayload, InspectorPayload, SchedulePayload, TreeItemDTO, TreePayload, ValueType } from "../../cards/helman-api";

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
        availability: { hasRawForecast: false, hasCorrectedForecast: false, hasActuals: false, hasInvalidated: false, hasProfile: false, hasHouseForecast: false, hasHouseActual: false, hasHouseActualBreakdown: false, hasHouseForecastBreakdown: false, hasBatterySocForecast: false, hasBatterySocActual: false, hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false, hasBatteryActual: false, hasImportPrice: false, hasExportPrice: false, ...availability },
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

/** Backend-shaped payloads shared by the WebSocket mock and individual specs. */
export function treeNode(overrides: Partial<TreeItemDTO> = {}): TreeItemDTO {
    return {
        id: "sensor.test",
        displayName: "Test",
        powerSensorId: null,
        valueType: "default",
        sourceConfig: null,
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
        energyEntityId: null,
        isEstimated: false,
        phase: null,
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

/** The four power-card roots used by node-detail specs. */
export function cardTree(gridValueType: ValueType = "default"): TreePayload {
    const node = (id: string, sensor: string, sourceType: string | null) => treeNode({
        id, displayName: id, powerSensorId: sensor, sourceType, isSource: sourceType !== null,
        ...(id === "grid" ? { valueType: gridValueType } : {}),
    });
    return treePayload({
        sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid", "grid"), node("battery", "sensor.battery", "battery")],
        consumers: [node("house", "sensor.house", null)],
        uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
    });
}

export function forecastPayload(overrides: Partial<ForecastPayload> = {}): ForecastPayload {
    return {
        solar: { status: "unavailable", unit: "Wh", resolution: "quarter_hour", horizonHours: 0, actualHistory: [], points: [] },
        grid: { status: "unavailable", generatedAt: null, unit: "kWh", resolution: "quarter_hour", horizonHours: 0, startedAt: null, partialReason: null, coverageUntil: null, currentImportPrice: null, importPriceUnit: null, importPricePoints: [], currentExportPrice: null, exportPriceUnit: null, exportPricePoints: [], series: [] },
        house_consumption: { status: "unavailable", generatedAt: null, unit: "Wh", resolution: "quarter_hour", horizonHours: 0, trainingWindowDays: 0, historyDaysAvailable: 0, requiredHistoryDays: 0, model: null, actualHistory: [], series: [] },
        battery_capacity: { status: "unavailable", generatedAt: null, startedAt: null, unit: "kWh", resolution: "quarter_hour", horizonHours: 0, model: null, nominalCapacityKwh: null, currentRemainingEnergyKwh: null, currentSoc: null, minSoc: null, maxSoc: null, chargeEfficiency: null, dischargeEfficiency: null, maxChargePowerW: null, maxDischargePowerW: null, partialReason: null, coverageUntil: null, actualHistory: [], series: [] },
        ...overrides,
    };
}

export interface ScheduleSlotsOptions {
    slotMinutes: number;
    start?: string;
    count?: number;
    overrides?: Partial<SchedulePayload>;
}

export function scheduleSlots({ slotMinutes, start = "2026-01-01T00:00:00.000Z", count = 0, overrides = {} }: ScheduleSlotsOptions): SchedulePayload {
    if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) throw new RangeError("slotMinutes must be a positive integer");
    return {
        executionEnabled: true,
        slots: Array.from({ length: count }, (_, index) => ({
            id: new Date(Date.parse(start) + index * slotMinutes * 60_000).toISOString(),
            controllables: {},
        })),
        ...overrides,
    };
}
