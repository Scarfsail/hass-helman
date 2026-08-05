import type { SlotForecastMap, SlotForecastPoint } from "./slot-forecast-model";
import { getScheduleGridScaleMagnitude } from "./grid-surplus-display";
import { collectScheduleHourForecasts } from "./schedule-hour-bucket-builder";
import type {
    ScheduleTableDayAggregateModel,
    ScheduleTableForecastMeta,
    ScheduleTableSectionModel,
} from "../schedule-table-types";
import type { ScheduleDisplaySlot } from "../schedule-types";

const ZERO_PRICE_RANGE_THRESHOLD = 0.05;

export function aggregateScheduleHourForecast({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): SlotForecastPoint | null {
    const aggregate = _aggregateScheduleForecast({ slots, slotForecastMap });
    if (aggregate === null) {
        return null;
    }

    const forecastPoint: SlotForecastPoint = {
        socPct: aggregate.socPct,
        solarWh: aggregate.solarWh,
        gridNetKwh: aggregate.gridImportKwh !== null && aggregate.gridExportKwh !== null
            ? aggregate.gridExportKwh - aggregate.gridImportKwh
            : null,
        gridImportKwh: aggregate.gridImportKwh,
        gridExportKwh: aggregate.gridExportKwh,
        availableSurplusKwh: aggregate.availableSurplusKwh,
        price: aggregate.price,
    };

    return forecastPoint.socPct === null
        && forecastPoint.solarWh === null
        && forecastPoint.gridNetKwh === null
        && forecastPoint.gridImportKwh === null
        && forecastPoint.gridExportKwh === null
        && forecastPoint.availableSurplusKwh === null
        && forecastPoint.price === null
        ? null
        : forecastPoint;
}

export function aggregateScheduleDayForecast({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): ScheduleTableDayAggregateModel | null {
    const aggregate = _aggregateScheduleForecast({ slots, slotForecastMap });
    const batteryRange = _aggregateScheduleDayBatteryRange({ slots, slotForecastMap });
    const priceRange = _aggregateScheduleDayPriceRange({ slots, slotForecastMap });
    if (aggregate === null && batteryRange.hasData === false && priceRange.priceHasData === false) {
        return null;
    }

    return batteryRange.hasData === false
        && (aggregate?.solarWh ?? null) === null
        && (aggregate?.gridImportKwh ?? null) === null
        && (aggregate?.gridExportKwh ?? null) === null
        && (aggregate?.availableSurplusKwh ?? null) === null
        && priceRange.priceHasData === false
        ? null
        : {
            batteryMinSocPct: batteryRange.minSocPct,
            batteryMaxSocPct: batteryRange.maxSocPct,
            solarWh: aggregate?.solarWh ?? null,
            gridImportKwh: aggregate?.gridImportKwh ?? null,
            gridExportKwh: aggregate?.gridExportKwh ?? null,
            availableSurplusKwh: aggregate?.availableSurplusKwh ?? null,
            priceHasData: priceRange.priceHasData,
            pricePositiveMin: priceRange.pricePositiveMin,
            pricePositiveMax: priceRange.pricePositiveMax,
            priceNegativeMin: priceRange.priceNegativeMin,
            priceNegativeMax: priceRange.priceNegativeMax,
        };
}

function _aggregateScheduleDayBatteryRange({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): { hasData: boolean; minSocPct: number | null; maxSocPct: number | null } {
    let minSocPct: number | null = null;
    let maxSocPct: number | null = null;

    for (const slot of slots) {
        const socPct = slotForecastMap.points.get(slot.id)?.socPct;
        if (socPct === null || socPct === undefined) {
            continue;
        }

        minSocPct = minSocPct === null ? socPct : Math.min(minSocPct, socPct);
        maxSocPct = maxSocPct === null ? socPct : Math.max(maxSocPct, socPct);
    }

    return {
        hasData: minSocPct !== null && maxSocPct !== null,
        minSocPct,
        maxSocPct,
    };
}

export function buildScheduleTableForecastMeta({
    slotForecastMap,
    sections,
    slots,
    timeZone,
}: {
    slotForecastMap: SlotForecastMap;
    sections: readonly ScheduleTableSectionModel[];
    slots: readonly ScheduleDisplaySlot[];
    timeZone: string;
}): ScheduleTableForecastMeta {
    const rowScale = {
        solarMaxWh: 0,
        gridMaxAbsKwh: 0,
        priceMaxAbs: 0,
    };
    const dayAggregateScale = {
        solarMaxWh: 0,
        gridMaxKwh: 0,
        priceMaxAbs: 0,
    };

    const scanPoint = (point: SlotForecastPoint | null | undefined): void => {
        if (!point) {
            return;
        }

        if (point.solarWh !== null) {
            rowScale.solarMaxWh = Math.max(rowScale.solarMaxWh, point.solarWh);
        }

        if (
            point.gridNetKwh !== null
            || point.gridImportKwh !== null
            || point.gridExportKwh !== null
            || point.availableSurplusKwh !== null
        ) {
            rowScale.gridMaxAbsKwh = Math.max(
                rowScale.gridMaxAbsKwh,
                getScheduleGridScaleMagnitude({
                    gridNetKwh: point.gridNetKwh,
                    gridImportKwh: point.gridImportKwh,
                    gridExportKwh: point.gridExportKwh,
                    availableSurplusKwh: point.availableSurplusKwh,
                }),
            );
        }

        if (point.price !== null) {
            rowScale.priceMaxAbs = Math.max(rowScale.priceMaxAbs, Math.abs(point.price));
        }
    };

    const scanDayAggregate = (aggregate: ScheduleTableDayAggregateModel | null | undefined): void => {
        if (!aggregate) {
            return;
        }

        if (aggregate.solarWh !== null) {
            dayAggregateScale.solarMaxWh = Math.max(dayAggregateScale.solarMaxWh, aggregate.solarWh);
        }

        if (
            aggregate.gridImportKwh !== null
            || aggregate.gridExportKwh !== null
            || aggregate.availableSurplusKwh !== null
        ) {
            dayAggregateScale.gridMaxKwh = Math.max(
                dayAggregateScale.gridMaxKwh,
                getScheduleGridScaleMagnitude({
                    gridNetKwh: null,
                    gridImportKwh: aggregate.gridImportKwh,
                    gridExportKwh: aggregate.gridExportKwh,
                    availableSurplusKwh: aggregate.availableSurplusKwh,
                }),
            );
        }

        dayAggregateScale.priceMaxAbs = Math.max(
            dayAggregateScale.priceMaxAbs,
            Math.abs(aggregate.pricePositiveMin ?? 0),
            Math.abs(aggregate.pricePositiveMax ?? 0),
            Math.abs(aggregate.priceNegativeMin ?? 0),
            Math.abs(aggregate.priceNegativeMax ?? 0),
        );
    };

    for (const slot of slots) {
        scanPoint(slotForecastMap.points.get(slot.id));
    }

    for (const point of collectScheduleHourForecasts({ slots, slotForecastMap, timeZone })) {
        scanPoint(point);
    }

    for (const section of sections) {
        scanDayAggregate(section.dayAggregate);
    }

    return {
        batteryAvailable: slotForecastMap.batteryAvailable,
        solarAvailable: slotForecastMap.solarAvailable,
        gridAvailable: slotForecastMap.gridAvailable,
        priceAvailable: slotForecastMap.priceAvailable,
        priceDisplayUnit: slotForecastMap.priceDisplayUnit,
        rowScale,
        dayAggregateScale,
    };
}

function _aggregateScheduleDayPriceRange({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): Pick<
    ScheduleTableDayAggregateModel,
    "priceHasData" | "pricePositiveMin" | "pricePositiveMax" | "priceNegativeMin" | "priceNegativeMax"
> {
    let priceHasData = false;
    let pricePositiveMin: number | null = null;
    let pricePositiveMax: number | null = null;
    let priceNegativeMin: number | null = null;
    let priceNegativeMax: number | null = null;

    for (const slot of slots) {
        const price = slotForecastMap.points.get(slot.id)?.price;
        if (price === null || price === undefined) {
            continue;
        }

        priceHasData = true;

        if (price > ZERO_PRICE_RANGE_THRESHOLD) {
            pricePositiveMin = pricePositiveMin === null ? price : Math.min(pricePositiveMin, price);
            pricePositiveMax = pricePositiveMax === null ? price : Math.max(pricePositiveMax, price);
            continue;
        }

        if (price < -ZERO_PRICE_RANGE_THRESHOLD) {
            priceNegativeMin = priceNegativeMin === null ? price : Math.min(priceNegativeMin, price);
            priceNegativeMax = priceNegativeMax === null ? price : Math.max(priceNegativeMax, price);
        }
    }

    return {
        priceHasData,
        pricePositiveMin,
        pricePositiveMax,
        priceNegativeMin,
        priceNegativeMax,
    };
}

function _aggregateScheduleForecast({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): {
    socPct: number | null;
    solarWh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    availableSurplusKwh: number | null;
    price: number | null;
} | null {
    if (slots.length === 0) {
        return null;
    }

    const lastPoint = slotForecastMap.points.get(slots[slots.length - 1].id);

    let solarTotal = 0;
    let hasSolar = false;
    let gridImportTotal = 0;
    let gridExportTotal = 0;
    let availableSurplusTotal = 0;
    let hasGrid = false;
    let hasAvailableSurplus = false;
    let priceTotal = 0;
    let priceCount = 0;

    for (const slot of slots) {
        const point = slotForecastMap.points.get(slot.id);
        if (!point) {
            continue;
        }

        if (point.solarWh !== null) {
            solarTotal += point.solarWh;
            hasSolar = true;
        }

        if (
            point.gridImportKwh !== null
            || point.gridExportKwh !== null
            || point.availableSurplusKwh !== null
        ) {
            gridImportTotal += point.gridImportKwh ?? 0;
            gridExportTotal += point.gridExportKwh ?? 0;
            hasGrid = true;
        }

        if (point.availableSurplusKwh !== null) {
            availableSurplusTotal += point.availableSurplusKwh;
            hasAvailableSurplus = true;
        }

        if (point.price !== null) {
            priceTotal += point.price;
            priceCount += 1;
        }
    }

    return {
        socPct: lastPoint?.socPct ?? null,
        solarWh: hasSolar ? solarTotal : null,
        gridImportKwh: hasGrid ? gridImportTotal : null,
        gridExportKwh: hasGrid ? gridExportTotal : null,
        availableSurplusKwh: hasAvailableSurplus ? availableSurplusTotal : null,
        price: priceCount > 0 ? priceTotal / priceCount : null,
    };
}
