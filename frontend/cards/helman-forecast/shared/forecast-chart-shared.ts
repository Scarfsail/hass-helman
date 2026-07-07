import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export interface ForecastChartBuildContext {
    currentDayKey: string | null;
    currentHourKey: string | null;
    locale: string;
    timeZone: string;
}

export function buildSparseHourLabelMap(
    timestamps: string[],
    context: ForecastChartBuildContext,
): Map<number, string> {
    if (timestamps.length === 0) {
        return new Map();
    }

    const targetIndices = timestamps.length <= 6
        ? timestamps.map((_, index) => index)
        : [
            0,
            Math.round((timestamps.length - 1) / 3),
            Math.round(((timestamps.length - 1) * 2) / 3),
            timestamps.length - 1,
        ];
    const labelIndices = new Set<number>();

    for (const targetIndex of targetIndices) {
        let bestIndex = targetIndex;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let index = 0; index < timestamps.length; index++) {
            if (labelIndices.has(index)) {
                continue;
            }

            const parts = getCachedLocalDateTimeParts(timestamps[index], context.timeZone);
            if (parts === null || parts.hour % 6 !== 0) {
                continue;
            }

            const distance = Math.abs(index - targetIndex);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        }

        labelIndices.add(bestIndex);
    }

    for (const targetIndex of targetIndices) {
        if (labelIndices.size >= Math.min(targetIndices.length, timestamps.length)) {
            break;
        }

        labelIndices.add(targetIndex);
    }

    return new Map(
        Array.from(labelIndices)
            .sort((left, right) => left - right)
            .map((index) => [index, _formatHourAxisLabel(timestamps[index], context)]),
    );
}

export function isPastForecastTimestamp(
    timestamp: string,
    isToday: boolean,
    context: ForecastChartBuildContext,
): boolean {
    if (!isToday || context.currentDayKey === null || context.currentHourKey === null) {
        return false;
    }

    const parts = getCachedLocalDateTimeParts(timestamp, context.timeZone);
    if (parts === null) {
        return false;
    }

    const currentHourStartMs = new Date(context.currentHourKey).getTime();
    const timestampMs = new Date(timestamp).getTime();
    if (Number.isNaN(currentHourStartMs) || Number.isNaN(timestampMs)) {
        return false;
    }

    return parts.dayKey === context.currentDayKey && timestampMs < currentHourStartMs;
}

export function normalizeForecastBarHeight(
    value: number,
    maxValue: number,
    maxHeightPercent: number,
): number {
    if (value <= 0 || maxValue <= 0) {
        return 0;
    }

    return Math.max((value / maxValue) * maxHeightPercent, maxHeightPercent * 0.12);
}

export function clampForecastPercent(value: number | null): number | null {
    if (!Number.isFinite(value ?? NaN)) {
        return null;
    }

    return Math.min(Math.max(value ?? 0, 0), 100);
}

function _formatHourAxisLabel(timestamp: string, context: ForecastChartBuildContext): string {
    return new Date(timestamp).toLocaleTimeString(context.locale, {
        timeZone: context.timeZone,
        hour: "2-digit",
        hourCycle: "h23",
    });
}
