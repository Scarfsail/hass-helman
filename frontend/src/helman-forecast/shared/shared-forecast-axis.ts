import {
    buildLocalDayHourAxis,
    getLocalHourKey,
    indexEntriesByLocalHour,
} from "./local-day-hour-axis";
import {
    buildSparseHourLabelMap,
    isPastForecastTimestamp,
    type ForecastChartBuildContext,
} from "./forecast-chart-shared";
import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export interface SharedForecastAxisColumn {
    hourKey: string;
    timestamp: string;
    hourLabel: string | null;
    isPast: boolean;
}

export interface SharedForecastAxis {
    columns: SharedForecastAxisColumn[];
}

export interface SharedAxisPointProjection<T> {
    column: SharedForecastAxisColumn;
    entry: T | null;
}

export interface SharedAxisIntervalProjection<T> {
    column: SharedForecastAxisColumn;
    entry: T | null;
}

export function buildSharedForecastAxis({
    dayKey,
    chartContext,
    referenceTimestamps,
}: {
    dayKey: string;
    chartContext: ForecastChartBuildContext;
    referenceTimestamps: readonly string[];
}): SharedForecastAxis {
    const axisPoints = buildLocalDayHourAxis(dayKey, chartContext.timeZone, referenceTimestamps);
    const sparseHourLabels = buildSparseHourLabelMap(
        axisPoints.map((point) => point.timestamp),
        chartContext,
    );
    const isToday = chartContext.currentDayKey === dayKey;

    return {
        columns: axisPoints.map((point, index) => ({
            hourKey: point.hourKey,
            timestamp: point.timestamp,
            hourLabel: sparseHourLabels.get(index) ?? null,
            isPast: isPastForecastTimestamp(point.timestamp, isToday, chartContext),
        })),
    };
}

export function alignPointsToSharedAxis<T extends { timestamp: string }>(
    axis: SharedForecastAxis,
    entries: readonly T[],
    timeZone: string,
    dayKey: string,
): SharedAxisPointProjection<T>[] {
    const entriesByHour = indexEntriesByLocalHour(entries, timeZone, dayKey);
    return axis.columns.map((column) => ({
        column,
        entry: entriesByHour.get(column.hourKey) ?? null,
    }));
}

export function projectIntervalsToSharedAxis<T extends { timestamp: string; endsAt: string }>(
    axis: SharedForecastAxis,
    entries: readonly T[],
    timeZone: string,
    dayKey: string,
): SharedAxisIntervalProjection<T>[] {
    const entriesByHour = new Map<string, T>();

    for (const entry of entries) {
        const parts = getCachedLocalDateTimeParts(entry.timestamp, timeZone);
        if (parts === null || parts.dayKey !== dayKey) {
            continue;
        }

        const hourKey = getLocalHourKey(entry.timestamp, timeZone);
        if (hourKey === null || entriesByHour.has(hourKey)) {
            continue;
        }

        // Battery slots are currently rendered as one column per slot start. Preserve that behavior
        // when projecting them onto the shared hourly axis.
        entriesByHour.set(hourKey, entry);
    }

    return axis.columns.map((column) => ({
        column,
        entry: entriesByHour.get(column.hourKey) ?? null,
    }));
}
