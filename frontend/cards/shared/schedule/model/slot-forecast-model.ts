import type {
    BatteryCapacityForecastDTO,
    ForecastPointDTO,
    ForecastPayload,
    GridForecastDTO,
    SolarForecastDTO,
} from "../../../helman-api";
import { getEffectiveSolarForecastPoints } from "../../../helman-api";
import { SLOT_MS, slotTimeKey } from "../../time/slot-time";
import type { ScheduleDisplaySlot } from "../schedule-types";

export interface SlotForecastPoint {
    socPct: number | null;
    solarWh: number | null;
    gridNetKwh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    availableSurplusKwh: number | null;
    price: number | null;
}

export interface SlotForecastMap {
    points: ReadonlyMap<string, SlotForecastPoint>;
    solarMaxWh: number;
    gridMaxAbsKwh: number;
    priceMaxAbs: number;
    batteryAvailable: boolean;
    solarAvailable: boolean;
    gridAvailable: boolean;
    priceAvailable: boolean;
    priceDisplayUnit: string | null;
}

export interface SlotForecastProjection {
    points: ReadonlyMap<string, SlotForecastPoint>;
    solarMaxWh: number;
    gridMaxAbsKwh: number;
    priceMaxAbs: number;
    batteryAvailable: boolean;
    solarAvailable: boolean;
    gridAvailable: boolean;
    priceAvailable: boolean;
    priceDisplayUnit: string | null;
    currentBatterySoc: number | null;
    currentPrice: number | null;
}

export const EMPTY_SLOT_FORECAST_MAP: SlotForecastMap = {
    points: new Map(),
    solarMaxWh: 0,
    gridMaxAbsKwh: 0,
    priceMaxAbs: 0,
    batteryAvailable: false,
    solarAvailable: false,
    gridAvailable: false,
    priceAvailable: false,
    priceDisplayUnit: null,
};

export const EMPTY_SLOT_FORECAST_PROJECTION: SlotForecastProjection = {
    points: new Map(),
    solarMaxWh: 0,
    gridMaxAbsKwh: 0,
    priceMaxAbs: 0,
    batteryAvailable: false,
    solarAvailable: false,
    gridAvailable: false,
    priceAvailable: false,
    priceDisplayUnit: null,
    currentBatterySoc: null,
    currentPrice: null,
};

const FORECAST_AVAILABLE_STATUSES = new Set(["available", "partial"]);

export function buildSlotForecastMap(
    forecast: ForecastPayload | null,
    slots: readonly ScheduleDisplaySlot[],
): SlotForecastMap {
    return materializeSlotForecastMap(buildSlotForecastProjection(forecast, slots), slots);
}

export function buildSlotForecastProjection(
    forecast: ForecastPayload | null,
    slots: readonly ScheduleDisplaySlot[],
): SlotForecastProjection {
    if (forecast === null || slots.length === 0) {
        return EMPTY_SLOT_FORECAST_PROJECTION;
    }

    const batteryAvailable = FORECAST_AVAILABLE_STATUSES.has(forecast.battery_capacity.status);
    const solarAvailable = FORECAST_AVAILABLE_STATUSES.has(forecast.solar.status);
    const gridAvailable = FORECAST_AVAILABLE_STATUSES.has(forecast.grid.status);
    const batteryBySlot = batteryAvailable
        ? _buildBatteryLookup(forecast.battery_capacity)
        : new Map<number, number>();
    const solarBySlot = solarAvailable
        ? _buildSolarLookup(forecast.solar)
        : new Map<number, number>();
    const priceProjection = _buildPriceProjection(forecast.grid, slots);
    if (!batteryAvailable && !solarAvailable && !gridAvailable && !priceProjection.available) {
        return EMPTY_SLOT_FORECAST_PROJECTION;
    }
    const gridProjection = gridAvailable
        ? _buildGridProjection(forecast.grid, slots)
        : {
            points: new Map<string, Pick<SlotForecastPoint, "gridNetKwh" | "gridImportKwh" | "gridExportKwh" | "availableSurplusKwh">>(),
            maxAbsKwh: 0,
        };

    let solarMaxWh = 0;
    const points = new Map<string, SlotForecastPoint>();

    for (const slot of slots) {
        const key = slotTimeKey(slot.startMs);
        const socPct = key === null ? null : batteryBySlot.get(key) ?? null;
        const solarWh = key === null ? null : solarBySlot.get(key) ?? null;
        const gridPoint = gridProjection.points.get(slot.id);
        const pricePoint = priceProjection.points.get(slot.id);

        if (solarWh !== null && solarWh > solarMaxWh) {
            solarMaxWh = solarWh;
        }

        points.set(slot.id, {
            socPct,
            solarWh,
            gridNetKwh: gridPoint?.gridNetKwh ?? null,
            gridImportKwh: gridPoint?.gridImportKwh ?? null,
            gridExportKwh: gridPoint?.gridExportKwh ?? null,
            availableSurplusKwh: gridPoint?.availableSurplusKwh ?? null,
            price: pricePoint?.price ?? null,
        });
    }

    return {
        points,
        solarMaxWh,
        gridMaxAbsKwh: gridProjection.maxAbsKwh,
        priceMaxAbs: priceProjection.maxAbs,
        batteryAvailable,
        solarAvailable,
        gridAvailable,
        priceAvailable: priceProjection.available,
        priceDisplayUnit: priceProjection.displayUnit,
        currentBatterySoc: batteryAvailable ? forecast.battery_capacity.currentSoc : null,
        currentPrice: forecast.grid.currentExportPrice ?? null,
    };
}

export function materializeSlotForecastMap(
    projection: SlotForecastProjection,
    slots: readonly ScheduleDisplaySlot[],
): SlotForecastMap {
    if (projection === EMPTY_SLOT_FORECAST_PROJECTION || slots.length === 0) {
        return EMPTY_SLOT_FORECAST_MAP;
    }

    const points = new Map<string, SlotForecastPoint>();
    for (const slot of slots) {
        const point = projection.points.get(slot.id);
        const socPct = point?.socPct
            ?? (slot.isCurrent ? projection.currentBatterySoc ?? null : null);
        const price = point?.price
            ?? (slot.isCurrent ? projection.currentPrice ?? null : null);

        points.set(slot.id, {
            socPct,
            solarWh: point?.solarWh ?? null,
            gridNetKwh: point?.gridNetKwh ?? null,
            gridImportKwh: point?.gridImportKwh ?? null,
            gridExportKwh: point?.gridExportKwh ?? null,
            availableSurplusKwh: point?.availableSurplusKwh ?? null,
            price,
        });
    }

    return {
        points,
        solarMaxWh: projection.solarMaxWh,
        gridMaxAbsKwh: projection.gridMaxAbsKwh,
        priceMaxAbs: projection.priceMaxAbs,
        batteryAvailable: projection.batteryAvailable,
        solarAvailable: projection.solarAvailable,
        gridAvailable: projection.gridAvailable,
        priceAvailable: projection.priceAvailable,
        priceDisplayUnit: projection.priceDisplayUnit,
    };
}

function _buildBatteryLookup(battery: BatteryCapacityForecastDTO): Map<number, number> {
    const points = new Map<number, number>();

    for (const entry of battery.actualHistory) {
        const key = slotTimeKey(entry.timestamp);
        if (key !== null) {
            points.set(key, entry.socPct);
        }
    }

    for (const entry of battery.series) {
        const key = slotTimeKey(entry.timestamp);
        if (key !== null) {
            points.set(key, entry.socPct);
        }
    }

    return points;
}

function _buildSolarLookup(solar: SolarForecastDTO): Map<number, number> {
    const points = new Map<number, number>();

    for (const entry of solar.actualHistory) {
        const key = slotTimeKey(entry.timestamp);
        if (key !== null) {
            points.set(key, entry.value);
        }
    }

    for (const entry of getEffectiveSolarForecastPoints(solar)) {
        const key = slotTimeKey(entry.timestamp);
        if (key !== null) {
            points.set(key, entry.value);
        }
    }

    return points;
}

function _buildGridProjection(
    grid: GridForecastDTO,
    slots: readonly ScheduleDisplaySlot[],
): {
    points: Map<string, Pick<SlotForecastPoint, "gridNetKwh" | "gridImportKwh" | "gridExportKwh" | "availableSurplusKwh">>;
    maxAbsKwh: number;
} {
    const points = new Map<string, Pick<SlotForecastPoint, "gridNetKwh" | "gridImportKwh" | "gridExportKwh" | "availableSurplusKwh">>();
    let maxAbsKwh = 0;
    // A feed entry can cover several schedule slots. Index it under each
    // quarter it touches, then count it once per slot before applying overlap.
    const entriesBySlot = new Map<number, typeof grid.series>();
    for (const entry of grid.series) {
        const entryStartMs = Date.parse(entry.timestamp);
        const entryDurationMs = entry.durationHours * 3_600_000;
        if (!Number.isFinite(entryStartMs) || !(entryDurationMs > 0)) continue;
        const firstKey = Math.floor(entryStartMs / SLOT_MS);
        const lastKey = Math.ceil((entryStartMs + entryDurationMs) / SLOT_MS) - 1;
        for (let key = firstKey; key <= lastKey; key += 1) {
            const entries = entriesBySlot.get(key) ?? [];
            entries.push(entry);
            entriesBySlot.set(key, entries);
        }
    }

    for (const slot of slots) {
        let importedKwh = 0;
        let exportedKwh = 0;
        let availableSurplusKwh = 0;
        let hasAvailableSurplus = false;
        let hasOverlap = false;

        const candidates = new Set<typeof grid.series[number]>();
        for (let key = Math.floor(slot.startMs / SLOT_MS);
            key < Math.ceil(slot.endMs / SLOT_MS); key += 1) {
            for (const entry of entriesBySlot.get(key) ?? []) candidates.add(entry);
        }
        for (const entry of candidates) {
            const entryStartMs = Date.parse(entry.timestamp);
            const entryDurationMs = entry.durationHours * 3_600_000;
            const entryEndMs = entryStartMs + entryDurationMs;
            const overlapMs = Math.min(slot.endMs, entryEndMs) - Math.max(slot.startMs, entryStartMs);
            if (overlapMs <= 0) {
                continue;
            }

            const overlapRatio = overlapMs / entryDurationMs;
            importedKwh += entry.importedFromGridKwh * overlapRatio;
            exportedKwh += entry.exportedToGridKwh * overlapRatio;
            if (
                entry.availableSurplusKwh !== undefined
                && Number.isFinite(entry.availableSurplusKwh)
                && entry.availableSurplusKwh >= 0
            ) {
                availableSurplusKwh += entry.availableSurplusKwh * overlapRatio;
                hasAvailableSurplus = true;
            }
            hasOverlap = true;
        }

        if (!hasOverlap) {
            continue;
        }

        const netKwh = exportedKwh - importedKwh;
        maxAbsKwh = Math.max(
            maxAbsKwh,
            Math.abs(netKwh),
            importedKwh,
            exportedKwh,
            hasAvailableSurplus ? availableSurplusKwh : 0,
        );
        points.set(slot.id, {
            gridNetKwh: netKwh,
            gridImportKwh: importedKwh,
            gridExportKwh: exportedKwh,
            availableSurplusKwh: hasAvailableSurplus ? availableSurplusKwh : null,
        });
    }

    return { points, maxAbsKwh };
}

function _buildPriceProjection(
    grid: GridForecastDTO,
    slots: readonly ScheduleDisplaySlot[],
): {
    points: Map<string, Pick<SlotForecastPoint, "price">>;
    maxAbs: number;
    available: boolean;
    displayUnit: string | null;
} {
    const exportPriceBySlot = _buildForecastPointLookup(grid.exportPricePoints ?? []);
    const points = new Map<string, Pick<SlotForecastPoint, "price">>();
    let maxAbs = Math.max(
        ...Array.from(exportPriceBySlot.values()).map((value) => Math.abs(value)),
        Math.abs(grid.currentExportPrice ?? 0),
        0,
    );

    for (const slot of slots) {
        const key = slotTimeKey(slot.startMs);
        const price = key === null ? null : exportPriceBySlot.get(key) ?? null;

        if (price === null) {
            continue;
        }

        maxAbs = Math.max(maxAbs, Math.abs(price));
        points.set(slot.id, {
            price,
        });
    }

    return {
        points,
        maxAbs,
        available: points.size > 0
            || (grid.currentExportPrice ?? null) !== null,
        displayUnit: grid.exportPriceUnit ?? null,
    };
}

function _buildForecastPointLookup(points: readonly ForecastPointDTO[]): Map<number, number> {
    const lookup = new Map<number, number>();

    for (const point of points) {
        const key = slotTimeKey(point.timestamp);
        if (key !== null) {
            lookup.set(key, point.value);
        }
    }

    return lookup;
}
