import type { ForecastPointDTO, SolarForecastDTO } from "../../helman-api";
import { getEffectiveSolarForecastPoints } from "../../helman-api";
import {
    buildLocalDayHourAxis,
    getLocalHourKey,
    indexEntriesByLocalHour,
} from "./local-day-hour-axis";
import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export type SolarHourSource = "actual" | "forecast" | "gap";

export interface ForecastSolarHourPoint {
    timestamp: string;
    value: number | null;
    source: SolarHourSource;
}

export interface SolarForecastDayModel {
    dayKey: string;
    isToday: boolean;
    isTomorrow: boolean;
    solarSummaryKwh: number | null;
    solarTotalKwh: number | null;
    solarHours: ForecastSolarHourPoint[];
    hasSolarData: boolean;
}

interface BuildSolarForecastDetailModelParams {
    solarForecast: SolarForecastDTO | null;
    timeZone: string;
    remainingTodayKwhOverride?: number | null;
    now?: Date;
}

export function buildSolarForecastDetailModel({
    solarForecast,
    timeZone,
    remainingTodayKwhOverride,
    now = new Date(),
}: BuildSolarForecastDetailModelParams): SolarForecastDayModel[] {
    const currentLocalParts = getCachedLocalDateTimeParts(now, timeZone);
    const currentHourKey = getLocalHourKey(now, timeZone);
    if (currentLocalParts === null || currentHourKey === null) {
        return [];
    }

    const solarDayMap = _groupSolarHoursByDay(
        solarForecast,
        timeZone,
        currentLocalParts.dayKey,
        currentHourKey,
    );
    const todayKey = currentLocalParts.dayKey;
    const tomorrowKey = _addDaysToDayKey(todayKey, 1);
    const allDayKeys = Array.from(solarDayMap.keys()).sort();

    return allDayKeys.map((dayKey) => {
        const solarHours = solarDayMap.get(dayKey) ?? [];
        const solarSummaryKwh = dayKey === todayKey
            ? remainingTodayKwhOverride
                ?? solarForecast?.remainingTodayKwh
                ?? _sumRemainingSolarKwh(solarHours, currentHourKey)
            : _sumSolarHourValuesKwh(solarHours);

        return {
            dayKey,
            isToday: dayKey === todayKey,
            isTomorrow: dayKey === tomorrowKey,
            solarSummaryKwh,
            solarTotalKwh: _sumSolarHourValuesKwh(solarHours),
            solarHours,
            hasSolarData: solarHours.length > 0 || solarSummaryKwh !== null,
        };
    });
}

function _groupSolarHoursByDay(
    solarForecast: SolarForecastDTO | null,
    timeZone: string,
    currentLocalDayKey: string,
    currentHourKey: string,
): Map<string, ForecastSolarHourPoint[]> {
    const dayMap = new Map<string, ForecastSolarHourPoint[]>();
    const actualHistory = solarForecast?.actualHistory ?? [];
    const forecastPoints = getEffectiveSolarForecastPoints(solarForecast);
    const todayHours = _buildTodaySolarHours({
        actualHistory,
        forecastPoints,
        timeZone,
        dayKey: currentLocalDayKey,
        currentHourKey,
    });

    if (todayHours.length > 0) {
        dayMap.set(currentLocalDayKey, todayHours);
    }

    for (const point of forecastPoints) {
        const pointLocalParts = getCachedLocalDateTimeParts(point.timestamp, timeZone);
        if (pointLocalParts === null || pointLocalParts.dayKey <= currentLocalDayKey) {
            continue;
        }

        const dayPoints = dayMap.get(pointLocalParts.dayKey) ?? [];
        dayPoints.push({
            timestamp: point.timestamp,
            value: point.value,
            source: "forecast",
        });
        dayMap.set(pointLocalParts.dayKey, dayPoints);
    }

    for (const [dayKey, dayPoints] of dayMap.entries()) {
        dayMap.set(dayKey, [...dayPoints].sort(_compareSolarHoursByTimestamp));
    }

    return dayMap;
}

function _buildTodaySolarHours({
    actualHistory,
    forecastPoints,
    timeZone,
    dayKey,
    currentHourKey,
}: {
    actualHistory: ForecastPointDTO[];
    forecastPoints: ForecastPointDTO[];
    timeZone: string;
    dayKey: string;
    currentHourKey: string;
}): ForecastSolarHourPoint[] {
    const referenceTimestamps = [
        ...actualHistory.map((entry) => entry.timestamp),
        ...forecastPoints.map((point) => point.timestamp),
    ];
    if (referenceTimestamps.length === 0) {
        return [];
    }

    const actualByHour = indexEntriesByLocalHour(actualHistory, timeZone, dayKey);
    const forecastByHour = indexEntriesByLocalHour(forecastPoints, timeZone, dayKey);
    const currentHourStartMs = _parseTimestampMs(currentHourKey);
    if (currentHourStartMs === null) {
        return [];
    }

    return buildLocalDayHourAxis(dayKey, timeZone, referenceTimestamps).map(({ hourKey, timestamp }) => {
        const hourStartMs = _parseTimestampMs(timestamp);
        if (hourStartMs !== null && hourStartMs < currentHourStartMs) {
            const actualPoint = actualByHour.get(hourKey);
            return actualPoint !== undefined
                ? {
                    timestamp: actualPoint.timestamp,
                    value: actualPoint.value,
                    source: "actual",
                }
                : {
                    timestamp,
                    value: null,
                    source: "gap",
                };
        }

        const forecastPoint = forecastByHour.get(hourKey);
        return forecastPoint !== undefined
            ? {
                timestamp: forecastPoint.timestamp,
                value: forecastPoint.value,
                source: "forecast",
            }
            : {
                timestamp,
                value: null,
                source: "gap",
            };
    });
}

function _sumSolarHourValuesKwh(points: ForecastSolarHourPoint[]): number | null {
    const values = points
        .map((point) => point.value)
        .filter((value): value is number => value !== null);

    if (values.length === 0) {
        return null;
    }

    return values.reduce((sum, value) => sum + value, 0) / 1000;
}

function _sumRemainingSolarKwh(
    points: ForecastSolarHourPoint[],
    currentHourKey: string,
): number | null {
    const currentHourStartMs = _parseTimestampMs(currentHourKey);
    if (currentHourStartMs === null) {
        return null;
    }

    const remainingValues = points
        .filter((point) => {
            const pointMs = _parseTimestampMs(point.timestamp);
            return pointMs !== null && pointMs >= currentHourStartMs && point.value !== null;
        })
        .map((point) => point.value as number);

    if (remainingValues.length === 0) {
        return null;
    }

    return remainingValues.reduce((sum, value) => sum + value, 0) / 1000;
}

function _addDaysToDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function _compareSolarHoursByTimestamp(a: ForecastSolarHourPoint, b: ForecastSolarHourPoint): number {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

function _parseTimestampMs(timestamp: string): number | null {
    const parsedMs = new Date(timestamp).getTime();
    return Number.isNaN(parsedMs) ? null : parsedMs;
}
