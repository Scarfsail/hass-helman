import type {
    HouseConsumptionActualHourDTO,
    HouseConsumptionForecastHourDTO,
} from "../../helman-api";
import {
    buildLocalDayHourAxis,
    getLocalHourKey,
    indexEntriesByLocalHour,
} from "./local-day-hour-axis";
import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export type HouseForecastHourSource = "actual" | "forecast" | "gap";

export interface ConsumerHourSnapshot {
    entityId: string;
    label: string;
    valueKwh: number | null;
    lowerKwh: number | null;
    upperKwh: number | null;
}

export interface ConsumerDayTotal {
    entityId: string;
    label: string;
    totalKwh: number;
}

export interface HouseForecastHour {
    timestamp: string;
    baselineKwh: number | null;
    baselineLowerKwh: number | null;
    baselineUpperKwh: number | null;
    deferrableKwh: number | null;
    deferrableLowerKwh: number | null;
    deferrableUpperKwh: number | null;
    consumers: ConsumerHourSnapshot[];
    source: HouseForecastHourSource;
}

export interface HouseForecastDay {
    dayKey: string;
    isToday: boolean;
    isTomorrow: boolean;
    baselineDayKwh: number;
    deferrableDayKwh: number;
    consumerDaySums: ConsumerDayTotal[];
    hours: HouseForecastHour[];
}

interface BuildHouseForecastModelParams {
    actualHistory: HouseConsumptionActualHourDTO[];
    currentSlot: HouseConsumptionForecastHourDTO | null;
    series: HouseConsumptionForecastHourDTO[];
    timeZone: string;
    now?: Date;
}

export function buildHouseForecastModel({
    actualHistory,
    currentSlot,
    series,
    timeZone,
    now = new Date(),
}: BuildHouseForecastModelParams): HouseForecastDay[] {
    const currentLocalParts = getCachedLocalDateTimeParts(now, timeZone);
    const currentHourKey = getLocalHourKey(now, timeZone);
    if (currentLocalParts === null || currentHourKey === null) {
        return [];
    }

    const todayKey = currentLocalParts.dayKey;
    const tomorrowKey = _addDaysToDayKey(todayKey, 1);
    const forecastDayMap = new Map<string, HouseForecastHour[]>();

    if (currentSlot !== null) {
        _addForecastEntry(forecastDayMap, currentSlot, timeZone, todayKey);
    }
    for (const entry of series) {
        _addForecastEntry(forecastDayMap, entry, timeZone, todayKey);
    }

    const hasTodayActualHistory = actualHistory.some((entry) => {
        const parts = getCachedLocalDateTimeParts(entry.timestamp, timeZone);
        return parts !== null && parts.dayKey === todayKey;
    });
    const dayKeys = new Set(forecastDayMap.keys());
    if (hasTodayActualHistory || forecastDayMap.has(todayKey)) {
        dayKeys.add(todayKey);
    }

    return Array.from(dayKeys)
        .sort()
        .map((dayKey) => {
            const forecastHours = [...(forecastDayMap.get(dayKey) ?? [])].sort(_compareHoursByTimestamp);
            const hours = dayKey === todayKey
                ? _buildTodayHours({
                    actualHistory,
                    forecastHours,
                    currentHourKey,
                    dayKey,
                    timeZone,
                })
                : forecastHours;

            if (hours.length === 0) {
                return null;
            }

            return {
                dayKey,
                isToday: dayKey === todayKey,
                isTomorrow: dayKey === tomorrowKey,
                baselineDayKwh: _sumHourValues(hours, (hour) => hour.baselineKwh),
                deferrableDayKwh: _sumHourValues(hours, (hour) => hour.deferrableKwh),
                consumerDaySums: _buildConsumerDaySums(hours),
                hours,
            };
        })
        .filter((day): day is HouseForecastDay => day !== null);
}

function _buildTodayHours({
    actualHistory,
    forecastHours,
    currentHourKey,
    dayKey,
    timeZone,
}: {
    actualHistory: HouseConsumptionActualHourDTO[];
    forecastHours: HouseForecastHour[];
    currentHourKey: string;
    dayKey: string;
    timeZone: string;
}): HouseForecastHour[] {
    const actualByHour = indexEntriesByLocalHour(actualHistory, timeZone, dayKey);
    const forecastByHour = _indexHoursByLocalHour(forecastHours, timeZone, dayKey);
    const referenceTimestamps = [
        ...actualHistory.map((entry) => entry.timestamp),
        ...forecastHours.map((hour) => hour.timestamp),
    ];
    const currentHourStartMs = _parseTimestampMs(currentHourKey);
    if (currentHourStartMs === null) {
        return forecastHours;
    }

    return buildLocalDayHourAxis(dayKey, timeZone, referenceTimestamps).map(({ hourKey, timestamp }) => {
        const hourStartMs = _parseTimestampMs(timestamp);
        if (hourStartMs !== null && hourStartMs < currentHourStartMs) {
            const actualHour = actualByHour.get(hourKey);
            return actualHour !== undefined
                ? _buildActualHour(actualHour)
                : _buildGapHour(timestamp);
        }

        const forecastHour = forecastByHour.get(hourKey);
        return forecastHour ?? _buildGapHour(timestamp);
    });
}

function _addForecastEntry(
    dayMap: Map<string, HouseForecastHour[]>,
    dto: HouseConsumptionForecastHourDTO,
    timeZone: string,
    todayKey: string,
): void {
    const parts = getCachedLocalDateTimeParts(dto.timestamp, timeZone);
    if (parts === null || parts.dayKey < todayKey) {
        return;
    }

    const dayHours = dayMap.get(parts.dayKey) ?? [];
    dayHours.push(_buildForecastHour(dto));
    dayMap.set(parts.dayKey, dayHours);
}

function _buildForecastHour(dto: HouseConsumptionForecastHourDTO): HouseForecastHour {
    const consumers: ConsumerHourSnapshot[] = dto.deferrableConsumers
        .map((consumer) => ({
            entityId: consumer.entityId,
            label: consumer.label,
            valueKwh: consumer.value,
            lowerKwh: consumer.lower,
            upperKwh: consumer.upper,
        }))
        .sort((left, right) => left.entityId.localeCompare(right.entityId));

    const deferrableKwh = consumers.reduce((sum, consumer) => sum + (consumer.valueKwh ?? 0), 0);
    const deferrableLowerKwh = consumers.reduce((sum, consumer) => sum + (consumer.lowerKwh ?? 0), 0);
    const deferrableUpperKwh = consumers.reduce((sum, consumer) => sum + (consumer.upperKwh ?? 0), 0);

    return {
        timestamp: dto.timestamp,
        baselineKwh: dto.nonDeferrable.value,
        baselineLowerKwh: dto.nonDeferrable.lower,
        baselineUpperKwh: dto.nonDeferrable.upper,
        deferrableKwh,
        deferrableLowerKwh,
        deferrableUpperKwh,
        consumers,
        source: "forecast",
    };
}

function _buildActualHour(dto: HouseConsumptionActualHourDTO): HouseForecastHour {
    const consumers: ConsumerHourSnapshot[] = dto.deferrableConsumers
        .map((consumer) => ({
            entityId: consumer.entityId,
            label: consumer.label,
            valueKwh: consumer.value,
            lowerKwh: null,
            upperKwh: null,
        }))
        .sort((left, right) => left.entityId.localeCompare(right.entityId));

    const deferrableKwh = consumers.reduce((sum, consumer) => sum + (consumer.valueKwh ?? 0), 0);

    return {
        timestamp: dto.timestamp,
        baselineKwh: dto.nonDeferrable.value,
        baselineLowerKwh: null,
        baselineUpperKwh: null,
        deferrableKwh,
        deferrableLowerKwh: null,
        deferrableUpperKwh: null,
        consumers,
        source: "actual",
    };
}

function _buildGapHour(timestamp: string): HouseForecastHour {
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

function _buildConsumerDaySums(hours: HouseForecastHour[]): ConsumerDayTotal[] {
    const map = new Map<string, { label: string; totalKwh: number }>();
    for (const hour of hours) {
        for (const consumer of hour.consumers) {
            const valueKwh = consumer.valueKwh ?? 0;
            const existing = map.get(consumer.entityId);
            if (existing) {
                existing.totalKwh += valueKwh;
            } else {
                map.set(consumer.entityId, { label: consumer.label, totalKwh: valueKwh });
            }
        }
    }

    return Array.from(map.entries())
        .map(([entityId, { label, totalKwh }]) => ({ entityId, label, totalKwh }))
        .sort((left, right) => right.totalKwh - left.totalKwh || left.label.localeCompare(right.label));
}

function _sumHourValues(
    hours: HouseForecastHour[],
    getValue: (hour: HouseForecastHour) => number | null,
): number {
    return hours.reduce((sum, hour) => sum + (getValue(hour) ?? 0), 0);
}

function _indexHoursByLocalHour(
    hours: HouseForecastHour[],
    timeZone: string,
    dayKey: string,
): Map<string, HouseForecastHour> {
    const hoursByLocalHour = new Map<string, HouseForecastHour>();
    for (const hour of hours) {
        const parts = getCachedLocalDateTimeParts(hour.timestamp, timeZone);
        const hourKey = getLocalHourKey(hour.timestamp, timeZone);
        if (
            parts === null
            || parts.dayKey !== dayKey
            || hourKey === null
            || hoursByLocalHour.has(hourKey)
        ) {
            continue;
        }

        hoursByLocalHour.set(hourKey, hour);
    }

    return hoursByLocalHour;
}

function _compareHoursByTimestamp(left: HouseForecastHour, right: HouseForecastHour): number {
    return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
}

function _addDaysToDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function _parseTimestampMs(timestamp: string): number | null {
    const parsedMs = new Date(timestamp).getTime();
    return Number.isNaN(parsedMs) ? null : parsedMs;
}
