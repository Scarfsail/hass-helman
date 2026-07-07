import type {
    HouseForecastDay,
    HouseForecastHour,
    HouseForecastHourSource,
} from "./house-forecast-detail-model";
import {
    buildSparseHourLabelMap,
    isPastForecastTimestamp,
    normalizeForecastBarHeight,
    type ForecastChartBuildContext,
} from "./forecast-chart-shared";

export interface HouseMetricAccessors {
    getHourValue(hour: HouseForecastHour): number | null;
    getLowerValue(hour: HouseForecastHour): number | null;
    getUpperValue(hour: HouseForecastHour): number | null;
}

export type HouseChartBuildContext = ForecastChartBuildContext;

export interface HouseMiniChartBarModel {
    heightPercent: number;
    isPast: boolean;
    isGap: boolean;
}

export interface HouseDetailColumnModel {
    timestamp: string;
    valueKwh: number | null;
    heightPercent: number;
    bandLowerPercent: number | null;
    bandUpperPercent: number | null;
    hourLabel: string | null;
    isMax: boolean;
    isMin: boolean;
    isPast: boolean;
    isGap: boolean;
    source: HouseForecastHourSource;
    hasConfidenceBand: boolean;
}

export interface HouseBreakdownRowModel {
    entityId: string;
    label: string;
    columns: HouseDetailColumnModel[];
}

interface BandedPoint {
    timestamp: string;
    valueKwh: number | null;
    lowerKwh: number | null;
    upperKwh: number | null;
    isPast: boolean;
    source: HouseForecastHourSource;
}

const DETAIL_MAX_BAR_HEIGHT = 78;
const MINI_CHART_MAX_BAR_HEIGHT = 100;

export function computeHouseMetricMax(
    days: HouseForecastDay[],
    accessors: HouseMetricAccessors,
): number {
    return Math.max(
        ...days.flatMap((day) => day.hours.map((hour) => accessors.getHourValue(hour) ?? 0)),
        0,
    );
}

export function buildHouseMiniChartBars(
    day: HouseForecastDay,
    accessors: HouseMetricAccessors,
    maxValue: number,
    context: HouseChartBuildContext,
): HouseMiniChartBarModel[] {
    return day.hours.map((hour) => {
        const valueKwh = accessors.getHourValue(hour);
        return {
            heightPercent: normalizeForecastBarHeight(
                Math.max(valueKwh ?? 0, 0),
                maxValue,
                MINI_CHART_MAX_BAR_HEIGHT,
            ),
            isPast: isPastForecastTimestamp(hour.timestamp, day.isToday, context),
            isGap: hour.source === "gap",
        };
    });
}

export function buildHouseDetailColumns(
    day: HouseForecastDay,
    accessors: HouseMetricAccessors,
    context: HouseChartBuildContext,
): HouseDetailColumnModel[] {
    const points = day.hours.map((hour) => ({
        timestamp: hour.timestamp,
        valueKwh: accessors.getHourValue(hour),
        lowerKwh: accessors.getLowerValue(hour),
        upperKwh: accessors.getUpperValue(hour),
        isPast: isPastForecastTimestamp(hour.timestamp, day.isToday, context),
        source: hour.source,
    }));
    const maxValue = Math.max(
        ...points.map((point) => Math.max(point.valueKwh ?? 0, point.upperKwh ?? 0, 0)),
        0,
    );

    return _buildBandedColumns(points, maxValue, context);
}

export function buildHouseDeferrableBreakdownRows(
    day: HouseForecastDay,
    context: HouseChartBuildContext,
): HouseBreakdownRowModel[] {
    if (day.hours.length === 0 || day.consumerDaySums.length === 0) {
        return [];
    }

    const maxValue = Math.max(
        ...day.hours.flatMap((hour) => day.consumerDaySums.map((consumer) => {
            const snapshot = hour.consumers.find((item) => item.entityId === consumer.entityId);
            return Math.max(snapshot?.valueKwh ?? 0, snapshot?.upperKwh ?? 0, 0);
        })),
        0,
    );

    return day.consumerDaySums.map((consumer) => {
        const points: BandedPoint[] = day.hours.map((hour) => {
            const snapshot = hour.consumers.find((item) => item.entityId === consumer.entityId);
            return {
                timestamp: hour.timestamp,
                valueKwh: snapshot?.valueKwh ?? (hour.source === "gap" ? null : 0),
                lowerKwh: snapshot?.lowerKwh ?? null,
                upperKwh: snapshot?.upperKwh ?? null,
                isPast: isPastForecastTimestamp(hour.timestamp, day.isToday, context),
                source: hour.source,
            };
        });

        return {
            entityId: consumer.entityId,
            label: consumer.label,
            columns: _buildBandedColumns(points, maxValue, context),
        };
    });
}

function _buildBandedColumns(
    points: BandedPoint[],
    maxValue: number,
    context: HouseChartBuildContext,
): HouseDetailColumnModel[] {
    if (points.length === 0) {
        return [];
    }

    const sparseLabels = buildSparseHourLabelMap(
        points.map((point) => point.timestamp),
        context,
    );

    let maxIndex = -1;
    let maxKwh = 0;
    let minIndex = -1;
    let minKwh = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index++) {
        const valueKwh = points[index].valueKwh;
        if (valueKwh === null) {
            continue;
        }
        if (valueKwh > maxKwh) {
            maxKwh = valueKwh;
            maxIndex = index;
        }
        if (valueKwh > 0 && valueKwh < minKwh) {
            minKwh = valueKwh;
            minIndex = index;
        }
    }

    return points.map((point, index) => {
        const valueKwh = point.valueKwh;
        const hasConfidenceBand = point.source === "forecast"
            && point.lowerKwh !== null
            && point.upperKwh !== null;

        return {
            timestamp: point.timestamp,
            valueKwh,
            heightPercent: normalizeForecastBarHeight(
                Math.max(valueKwh ?? 0, 0),
                maxValue,
                DETAIL_MAX_BAR_HEIGHT,
            ),
            bandLowerPercent: hasConfidenceBand && maxValue > 0
                ? Math.min((Math.max(point.lowerKwh ?? 0, 0) / maxValue) * DETAIL_MAX_BAR_HEIGHT, DETAIL_MAX_BAR_HEIGHT)
                : null,
            bandUpperPercent: hasConfidenceBand && maxValue > 0
                ? Math.min((Math.max(point.upperKwh ?? 0, 0) / maxValue) * DETAIL_MAX_BAR_HEIGHT, DETAIL_MAX_BAR_HEIGHT)
                : null,
            hourLabel: sparseLabels.get(index) ?? null,
            isMax: index === maxIndex && maxKwh > 0,
            isMin: index === minIndex && Number.isFinite(minKwh),
            isPast: point.isPast,
            isGap: point.source === "gap",
            source: point.source,
            hasConfidenceBand,
        };
    });
}
