import type { ForecastPointDTO } from "../helman-api";
import { buildEmptyBatterySlotFlow } from "./shared/battery-capacity-flow";
import type {
    BatteryCapacityForecastDay,
    BatteryCapacityForecastSlot,
} from "./shared/battery-capacity-forecast-detail-model";
import {
    buildBatteryDetailChartModel,
    type BatteryDetailChartModel,
} from "./shared/battery-capacity-forecast-chart-model";
import type {
    SolarForecastDayModel,
    ForecastSolarHourPoint,
} from "./shared/forecast-detail-model";
import {
    buildEmptyGridEnergySlot,
    type GridEnergyForecastDay,
} from "./shared/grid-energy-forecast-detail-model";
import {
    type ForecastChartBuildContext,
    normalizeForecastBarHeight,
} from "./shared/forecast-chart-shared";
import type { GridPriceForecastDayModel } from "./shared/grid-price-forecast-detail-model";
import type {
    HouseForecastDay,
    HouseForecastHour,
    ConsumerDayTotal,
} from "./shared/house-forecast-detail-model";
import {
    buildHouseDeferrableBreakdownRows,
    buildHouseDetailColumns,
    type HouseBreakdownRowModel,
    type HouseDetailColumnModel,
} from "./shared/house-forecast-chart-model";
import {
    getForecastPriceToneClass,
    type ForecastPriceToneClass,
} from "./shared/forecast-render-helpers";
import {
    alignPointsToSharedAxis,
    buildSharedForecastAxis,
    projectIntervalsToSharedAxis,
    type SharedForecastAxis,
} from "./shared/shared-forecast-axis";
import type { HelmanForecastSectionVisibility } from "./HelmanForecastCardConfig";
import type { UnifiedForecastDayModel } from "./unified-forecast-model";

interface UnifiedSolarPointProjection {
    columnTimestamp: string;
    isPast: boolean;
    hourLabel: string | null;
    point: ForecastSolarHourPoint | null;
}

interface UnifiedPricePointProjection {
    columnTimestamp: string;
    isPast: boolean;
    hourLabel: string | null;
    point: ForecastPointDTO | null;
}

export interface UnifiedSolarDetailColumnModel {
    timestamp: string;
    hourLabel: string | null;
    isPast: boolean;
    isGap: boolean;
    source: ForecastSolarHourPoint["source"] | "gap";
    value: number | null;
    heightPercent: number;
    isMax: boolean;
}

export interface UnifiedPriceDetailColumnModel {
    timestamp: string;
    hourLabel: string | null;
    isPast: boolean;
    isGap: boolean;
    value: number | null;
    heightPercent: number;
    offsetPercent: number;
    toneClass: ForecastPriceToneClass;
    isMin: boolean;
    isMax: boolean;
}

export interface UnifiedSolarDetailRowModel {
    columns: UnifiedSolarDetailColumnModel[];
}

export interface UnifiedPriceDetailRowModel {
    columns: UnifiedPriceDetailColumnModel[];
    hasNegativeValues: boolean;
    minColumnIndex: number;
    maxColumnIndex: number;
}

export interface UnifiedGridDetailColumnModel {
    timestamp: string;
    hourLabel: string | null;
    isPast: boolean;
    isGap: boolean;
    displayStartAt: string;
    displayEndAt: string;
    durationHours: number;
    importedFromGridKwh: number;
    exportedToGridKwh: number;
    netKwh: number | null;
    heightPercent: number;
    offsetPercent: number;
}

export interface UnifiedGridDetailRowModel {
    columns: UnifiedGridDetailColumnModel[];
}

export interface UnifiedHouseDetailModel {
    columns: HouseDetailColumnModel[];
    hasBreakdown: boolean;
    breakdownSummaryItems: ConsumerDayTotal[];
    breakdownRows: HouseBreakdownRowModel[];
}

export interface UnifiedForecastDetailModel {
    axis: SharedForecastAxis;
    solar: UnifiedSolarDetailRowModel | null;
    grid: UnifiedGridDetailRowModel | null;
    price: UnifiedPriceDetailRowModel | null;
    battery: BatteryDetailChartModel | null;
    house: UnifiedHouseDetailModel | null;
}

export function buildUnifiedForecastDetailModel({
    day,
    chartContext,
    sectionVisibility,
    batteryMinSoc,
    batteryMaxSoc,
    includeHouseBreakdownRows,
}: {
    day: UnifiedForecastDayModel;
    chartContext: ForecastChartBuildContext;
    sectionVisibility: HelmanForecastSectionVisibility;
    batteryMinSoc: number | null;
    batteryMaxSoc: number | null;
    includeHouseBreakdownRows: boolean;
}): UnifiedForecastDetailModel {
    const axis = buildSharedForecastAxis({
        dayKey: day.dayKey,
        chartContext,
        referenceTimestamps: _collectReferenceTimestamps(day, sectionVisibility),
    });

    return {
        axis,
        solar: sectionVisibility.solar && day.solar !== null && day.solarDay !== null
            ? _buildSolarDetailRow(day.solarDay, axis, chartContext.timeZone, day.dayKey)
            : null,
        grid: sectionVisibility.grid && day.grid !== null && day.gridDay !== null
            ? _buildGridDetailRow(day.gridDay, axis, chartContext.timeZone)
            : null,
        price: sectionVisibility.price && day.price !== null && day.gridPriceDay !== null
            ? _buildPriceDetailRow(day.gridPriceDay, axis, chartContext.timeZone, day.dayKey)
            : null,
        battery: sectionVisibility.battery && day.battery !== null && day.batteryDay !== null
            ? buildBatteryDetailChartModel({
                day: _alignBatteryDayToAxis(day.batteryDay, axis, chartContext.timeZone),
                axis,
                minSoc: batteryMinSoc,
                maxSoc: batteryMaxSoc,
                context: chartContext,
            })
            : null,
        house: sectionVisibility.house && day.house !== null && day.houseDay !== null
            ? _buildHouseDetailModel(day.houseDay, axis, chartContext, includeHouseBreakdownRows)
            : null,
    };
}

function _collectReferenceTimestamps(
    day: UnifiedForecastDayModel,
    sectionVisibility: HelmanForecastSectionVisibility,
): string[] {
    const timestamps: string[] = [];

    if (sectionVisibility.solar && day.solar !== null && day.solarDay !== null) {
        timestamps.push(...day.solarDay.solarHours.map((point) => point.timestamp));
    }

    if (sectionVisibility.grid && day.grid !== null && day.gridDay !== null) {
        timestamps.push(...day.gridDay.slots.map((slot) => slot.timestamp));
    }

    if (sectionVisibility.price && day.price !== null && day.gridPriceDay !== null) {
        timestamps.push(...day.gridPriceDay.priceHours.map((point) => point.timestamp));
    }

    if (sectionVisibility.battery && day.battery !== null && day.batteryDay !== null) {
        timestamps.push(...day.batteryDay.slots.map((slot) => slot.timestamp));
    }

    if (sectionVisibility.house && day.house !== null && day.houseDay !== null) {
        timestamps.push(...day.houseDay.hours.map((hour) => hour.timestamp));
    }

    return timestamps;
}

function _buildSolarDetailRow(
    day: SolarForecastDayModel,
    axis: SharedForecastAxis,
    timeZone: string,
    dayKey: string,
): UnifiedSolarDetailRowModel {
    const projections: UnifiedSolarPointProjection[] = alignPointsToSharedAxis(
        axis,
        day.solarHours,
        timeZone,
        dayKey,
    ).map((projection) => ({
        columnTimestamp: projection.column.timestamp,
        isPast: projection.column.isPast,
        hourLabel: projection.column.hourLabel,
        point: projection.entry,
    }));
    const maxValue = Math.max(...projections.map((projection) => Math.max(projection.point?.value ?? 0, 0)), 0);
    let maxColumnIndex = -1;
    let highlightedValue = 0;
    for (let index = 0; index < projections.length; index++) {
        const value = Math.max(projections[index].point?.value ?? 0, 0);
        if (value > highlightedValue) {
            highlightedValue = value;
            maxColumnIndex = index;
        }
    }

    return {
        columns: projections.map((projection, index) => ({
            timestamp: projection.point?.timestamp ?? projection.columnTimestamp,
            hourLabel: projection.hourLabel,
            isPast: projection.isPast,
            isGap: projection.point === null || projection.point.source === "gap",
            source: projection.point?.source ?? "gap",
            value: projection.point?.value ?? null,
            heightPercent: normalizeForecastBarHeight(
                Math.max(projection.point?.value ?? 0, 0),
                maxValue,
                78,
            ),
            isMax: index === maxColumnIndex && highlightedValue > 0,
        })),
    };
}

function _buildPriceDetailRow(
    day: GridPriceForecastDayModel,
    axis: SharedForecastAxis,
    timeZone: string,
    dayKey: string,
): UnifiedPriceDetailRowModel {
    const projections: UnifiedPricePointProjection[] = alignPointsToSharedAxis(
        axis,
        day.priceHours,
        timeZone,
        dayKey,
    ).map((projection) => ({
        columnTimestamp: projection.column.timestamp,
        isPast: projection.column.isPast,
        hourLabel: projection.column.hourLabel,
        point: projection.entry,
    }));
    const hasNegativeValues = projections.some((projection) => (projection.point?.value ?? 0) < 0);
    const maxAbsoluteValue = Math.max(...projections.map((projection) => Math.abs(projection.point?.value ?? 0)), 0);
    let minColumnIndex = -1;
    let maxColumnIndex = -1;
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < projections.length; index++) {
        const value = projections[index].point?.value;
        if (value === undefined) {
            continue;
        }
        if (value < minValue) {
            minValue = value;
            minColumnIndex = index;
        }
        if (value > maxValue) {
            maxValue = value;
            maxColumnIndex = index;
        }
    }

    return {
        columns: projections.map((projection, index) => {
            const value = projection.point?.value ?? null;
            const heightPercent = normalizeForecastBarHeight(
                Math.abs(value ?? 0),
                maxAbsoluteValue,
                hasNegativeValues ? 34 : 78,
            );
            return {
                timestamp: projection.point?.timestamp ?? projection.columnTimestamp,
                hourLabel: projection.hourLabel,
                isPast: projection.isPast,
                isGap: projection.point === null,
                value,
                heightPercent,
                offsetPercent: value === null
                    ? 0
                    : hasNegativeValues && value < 0
                        ? Math.max(0, 50 - heightPercent)
                        : hasNegativeValues
                            ? 50
                            : 0,
                toneClass: getForecastPriceToneClass(value ?? 0),
                isMin: index === minColumnIndex && Number.isFinite(minValue),
                isMax: index === maxColumnIndex && Number.isFinite(maxValue),
            } satisfies UnifiedPriceDetailColumnModel;
        }),
        hasNegativeValues,
        minColumnIndex,
        maxColumnIndex,
    };
}

function _buildGridDetailRow(
    day: GridEnergyForecastDay,
    axis: SharedForecastAxis,
    timeZone: string,
): UnifiedGridDetailRowModel {
    const alignedDay = _alignGridDayToAxis(day, axis, timeZone);
    const maxAbsoluteValue = Math.max(...alignedDay.slots.map((slot) => Math.abs(slot.netKwh)), 0);

    return {
        columns: alignedDay.slots.map((slot, index) => {
            const netKwh = slot.source === "gap" ? null : slot.netKwh;
            const heightPercent = normalizeForecastBarHeight(
                Math.abs(netKwh ?? 0),
                maxAbsoluteValue,
                34,
            );

            return {
                timestamp: slot.timestamp,
                hourLabel: axis.columns[index]?.hourLabel ?? null,
                isPast: axis.columns[index]?.isPast ?? false,
                isGap: slot.source === "gap",
                displayStartAt: slot.timestamp,
                displayEndAt: slot.endsAt,
                durationHours: slot.durationHours,
                importedFromGridKwh: slot.importedFromGridKwh,
                exportedToGridKwh: slot.exportedToGridKwh,
                netKwh,
                heightPercent,
                offsetPercent: netKwh === null
                    ? 0
                    : netKwh < 0
                        ? Math.max(0, 50 - heightPercent)
                        : 50,
            } satisfies UnifiedGridDetailColumnModel;
        }),
    };
}

function _alignBatteryDayToAxis(
    day: BatteryCapacityForecastDay,
    axis: SharedForecastAxis,
    timeZone: string,
): BatteryCapacityForecastDay {
    const projections = projectIntervalsToSharedAxis(axis, day.slots, timeZone, day.dayKey);

    return {
        ...day,
        slots: projections.map((projection, index) => projection.entry ?? _buildGapBatterySlot(
            projection.column.timestamp,
            axis.columns[index + 1]?.timestamp ?? null,
        )),
    };
}

function _alignGridDayToAxis(
    day: GridEnergyForecastDay,
    axis: SharedForecastAxis,
    timeZone: string,
): GridEnergyForecastDay {
    const projections = projectIntervalsToSharedAxis(axis, day.slots, timeZone, day.dayKey);

    return {
        ...day,
        slots: projections.map((projection, index) => projection.entry ?? buildEmptyGridEnergySlot(
            projection.column.timestamp,
            axis.columns[index + 1]?.timestamp ?? null,
        )),
    };
}

function _buildGapBatterySlot(
    timestamp: string,
    nextTimestamp: string | null,
): BatteryCapacityForecastSlot {
    return {
        ...buildEmptyBatterySlotFlow(),
        source: "gap",
        timestamp,
        endsAt: nextTimestamp ?? _addHour(timestamp),
        durationHours: 1,
        startSocPct: null,
        socPct: null,
        chargedKwh: 0,
        dischargedKwh: 0,
        importedFromGridKwh: 0,
        exportedToGridKwh: 0,
        hitMinSoc: false,
        hitMaxSoc: false,
        limitedByChargePower: false,
        limitedByDischargePower: false,
    };
}

function _buildHouseDetailModel(
    day: HouseForecastDay,
    axis: SharedForecastAxis,
    chartContext: ForecastChartBuildContext,
    includeHouseBreakdownRows: boolean,
): UnifiedHouseDetailModel {
    const alignedDay = _alignHouseDayToAxis(day, axis, chartContext.timeZone);
    const hasBreakdown = alignedDay.consumerDaySums.length > 0;

    return {
        columns: buildHouseDetailColumns(
            alignedDay,
            {
                getHourValue: (hour) => hour.baselineKwh,
                getLowerValue: (hour) => hour.baselineLowerKwh,
                getUpperValue: (hour) => hour.baselineUpperKwh,
            },
            chartContext,
        ),
        hasBreakdown,
        breakdownSummaryItems: alignedDay.consumerDaySums,
        breakdownRows: includeHouseBreakdownRows && hasBreakdown
            ? buildHouseDeferrableBreakdownRows(alignedDay, chartContext)
            : [],
    };
}

function _alignHouseDayToAxis(
    day: HouseForecastDay,
    axis: SharedForecastAxis,
    timeZone: string,
): HouseForecastDay {
    const projections = alignPointsToSharedAxis(axis, day.hours, timeZone, day.dayKey);

    return {
        ...day,
        hours: projections.map((projection) => projection.entry ?? _buildGapHouseHour(projection.column.timestamp)),
    };
}

function _buildGapHouseHour(timestamp: string): HouseForecastHour {
    return {
        timestamp,
        baselineKwh: null,
        baselineLowerKwh: null,
        baselineUpperKwh: null,
        deferrableKwh: null,
        deferrableLowerKwh: null,
        deferrableUpperKwh: null,
        consumers: [],
        source: "gap",
    };
}

function _addHour(timestamp: string): string {
    const parsed = new Date(timestamp).getTime();
    if (Number.isNaN(parsed)) {
        return timestamp;
    }

    return new Date(parsed + 3600000).toISOString();
}
