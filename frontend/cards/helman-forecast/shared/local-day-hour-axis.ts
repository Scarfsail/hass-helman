import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export interface LocalDayHourPoint {
    hourKey: string;
    hour: number;
    timestamp: string;
}

interface LocalHourDescriptor {
    dayKey: string;
    hour: number;
    hourKey: string;
}

const HOUR_MS = 3600000;
const LOCAL_HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const LOCAL_DAY_START_CACHE = new Map<string, number | null>();

export function buildLocalDayHourAxis(
    dayKey: string,
    timeZone: string,
    referenceTimestamps: readonly string[],
): LocalDayHourPoint[] {
    const hasSameDayReference = referenceTimestamps.some((timestamp) => {
        const parts = getCachedLocalDateTimeParts(timestamp, timeZone);
        return parts !== null && parts.dayKey === dayKey;
    });
    if (!hasSameDayReference) {
        return [];
    }

    const dayStartMs = _getLocalDayStartMs(dayKey, timeZone);
    const nextDayStartMs = _getLocalDayStartMs(_addDaysToDayKey(dayKey, 1), timeZone);
    if (dayStartMs === null || nextDayStartMs === null) {
        return [];
    }

    const axis: LocalDayHourPoint[] = [];
    for (let cursorMs = dayStartMs; cursorMs < nextDayStartMs; cursorMs += HOUR_MS) {
        const descriptor = _getLocalHourDescriptor(new Date(cursorMs), timeZone);
        if (descriptor === null || descriptor.dayKey !== dayKey) {
            continue;
        }

        axis.push({
            hourKey: descriptor.hourKey,
            hour: descriptor.hour,
            timestamp: descriptor.hourKey,
        });
    }

    return axis;
}

export function indexEntriesByLocalHour<T extends { timestamp: string }>(
    entries: readonly T[],
    timeZone: string,
    dayKey: string,
): Map<string, T> {
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

        entriesByHour.set(hourKey, entry);
    }

    return entriesByHour;
}

export function getLocalHourKey(value: Date | string, timeZone: string): string | null {
    return _getLocalHourDescriptor(value, timeZone)?.hourKey ?? null;
}

function _getLocalHourDescriptor(
    value: Date | string,
    timeZone: string,
): LocalHourDescriptor | null {
    const date = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const formattedParts = _getLocalHourFormatter(timeZone).formatToParts(date);
    let year: string | undefined;
    let month: string | undefined;
    let day: string | undefined;
    let hour: string | undefined;
    let offset: string | undefined;
    for (const part of formattedParts) {
        if (part.type === "year") {
            year = part.value;
        } else if (part.type === "month") {
            month = part.value;
        } else if (part.type === "day") {
            day = part.value;
        } else if (part.type === "hour") {
            hour = part.value;
        } else if (part.type === "timeZoneName") {
            offset = _normalizeOffset(part.value);
        }
    }

    if (!year || !month || !day || !hour || !offset) {
        return null;
    }

    return {
        dayKey: `${year}-${month}-${day}`,
        hour: Number(hour),
        hourKey: `${year}-${month}-${day}T${hour}:00:00${offset}`,
    };
}

function _getLocalDayStartMs(dayKey: string, timeZone: string): number | null {
    const cacheKey = `${timeZone}::${dayKey}`;
    if (LOCAL_DAY_START_CACHE.has(cacheKey)) {
        return LOCAL_DAY_START_CACHE.get(cacheKey) ?? null;
    }

    const [year, month, day] = dayKey.split("-").map(Number);
    if (
        !Number.isInteger(year)
        || !Number.isInteger(month)
        || !Number.isInteger(day)
    ) {
        LOCAL_DAY_START_CACHE.set(cacheKey, null);
        return null;
    }

    const naiveUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
    let candidateMs = naiveUtcMs;
    for (let iteration = 0; iteration < 6; iteration++) {
        const offsetMinutes = _readOffsetMinutes(new Date(candidateMs), timeZone);
        if (offsetMinutes === null) {
            LOCAL_DAY_START_CACHE.set(cacheKey, null);
            return null;
        }

        const nextCandidateMs = naiveUtcMs - offsetMinutes * 60000;
        if (nextCandidateMs === candidateMs) {
            break;
        }
        candidateMs = nextCandidateMs;
    }

    const descriptor = _getLocalHourDescriptor(new Date(candidateMs), timeZone);
    const resolvedValue = descriptor !== null && descriptor.dayKey === dayKey && descriptor.hour === 0
        ? candidateMs
        : null;
    LOCAL_DAY_START_CACHE.set(cacheKey, resolvedValue);
    return resolvedValue;
}

function _readOffsetMinutes(date: Date, timeZone: string): number | null {
    const formattedParts = _getLocalHourFormatter(timeZone).formatToParts(date);
    const timeZoneName = formattedParts.find((part) => part.type === "timeZoneName")?.value;
    if (timeZoneName === undefined) {
        return null;
    }

    const normalizedOffset = _normalizeOffset(timeZoneName);
    if (normalizedOffset === null) {
        return null;
    }

    const sign = normalizedOffset.startsWith("-") ? -1 : 1;
    const hours = Number(normalizedOffset.slice(1, 3));
    const minutes = Number(normalizedOffset.slice(4, 6));
    return sign * (hours * 60 + minutes);
}

function _normalizeOffset(rawOffset: string): string | null {
    if (rawOffset === "GMT" || rawOffset === "UTC") {
        return "+00:00";
    }

    const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(rawOffset);
    if (!match) {
        return null;
    }

    const [, sign, rawHours, rawMinutes = "0"] = match;
    return `${sign}${rawHours.padStart(2, "0")}:${rawMinutes.padStart(2, "0")}`;
}

function _getLocalHourFormatter(timeZone: string): Intl.DateTimeFormat {
    const formatter = LOCAL_HOUR_FORMATTERS.get(timeZone);
    if (formatter !== undefined) {
        return formatter;
    }

    const nextFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "shortOffset",
    });
    LOCAL_HOUR_FORMATTERS.set(timeZone, nextFormatter);
    return nextFormatter;
}

function _addDaysToDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
