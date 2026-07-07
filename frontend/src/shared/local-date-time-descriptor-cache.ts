export interface LocalDateTimeParts {
    dayKey: string;
    hour: number;
}

export interface LocalDateTimeDescriptor extends LocalDateTimeParts {
    minute: number;
    offset: string;
}

const MAX_LOCAL_DATE_TIME_DESCRIPTOR_CACHE_SIZE = 2048;
const LOCAL_DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const LOCAL_DATE_TIME_DESCRIPTOR_CACHE = new Map<string, LocalDateTimeDescriptor | null>();

export function getCachedLocalDateTimeParts(
    value: Date | string | number,
    timeZone: string,
): LocalDateTimeParts | null {
    const descriptor = getCachedLocalDateTimeDescriptor(value, timeZone);
    if (descriptor === null) {
        return null;
    }

    return {
        dayKey: descriptor.dayKey,
        hour: descriptor.hour,
    };
}

export function getCachedLocalDateTimeDescriptor(
    value: Date | string | number,
    timeZone: string,
): LocalDateTimeDescriptor | null {
    const cacheKey = _getCacheKey(value, timeZone);
    if (cacheKey !== null && LOCAL_DATE_TIME_DESCRIPTOR_CACHE.has(cacheKey)) {
        return LOCAL_DATE_TIME_DESCRIPTOR_CACHE.get(cacheKey) ?? null;
    }

    const descriptor = _buildLocalDateTimeDescriptor(value, timeZone);
    if (cacheKey !== null) {
        _setCachedLocalDateTimeDescriptor(cacheKey, descriptor);
    }

    return descriptor;
}

function _buildLocalDateTimeDescriptor(
    value: Date | string | number,
    timeZone: string,
): LocalDateTimeDescriptor | null {
    const date = typeof value === "number"
        ? new Date(value)
        : typeof value === "string"
        ? new Date(value)
        : value;
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const formattedParts = _getLocalDateTimeFormatter(timeZone).formatToParts(date);
    let year: string | undefined;
    let month: string | undefined;
    let day: string | undefined;
    let hour: string | undefined;
    let minute: string | undefined;
    let rawOffset: string | undefined;

    for (const part of formattedParts) {
        if (part.type === "year") {
            year = part.value;
        } else if (part.type === "month") {
            month = part.value;
        } else if (part.type === "day") {
            day = part.value;
        } else if (part.type === "hour") {
            hour = part.value;
        } else if (part.type === "minute") {
            minute = part.value;
        } else if (part.type === "timeZoneName") {
            rawOffset = part.value;
        }
    }

    const offset = rawOffset ? _normalizeOffset(rawOffset) : null;
    if (!year || !month || !day || !hour || !minute || offset === null) {
        return null;
    }

    return {
        dayKey: `${year}-${month}-${day}`,
        hour: Number(hour),
        minute: Number(minute),
        offset,
    };
}

function _getCacheKey(value: Date | string | number, timeZone: string): string | null {
    if (typeof value === "string") {
        return `${timeZone}::string::${value}`;
    }

    const epochMs = typeof value === "number" ? value : value.getTime();
    if (Number.isNaN(epochMs)) {
        return null;
    }

    return `${timeZone}::ms::${epochMs}`;
}

function _setCachedLocalDateTimeDescriptor(cacheKey: string, value: LocalDateTimeDescriptor | null): void {
    if (LOCAL_DATE_TIME_DESCRIPTOR_CACHE.size >= MAX_LOCAL_DATE_TIME_DESCRIPTOR_CACHE_SIZE) {
        LOCAL_DATE_TIME_DESCRIPTOR_CACHE.clear();
    }

    LOCAL_DATE_TIME_DESCRIPTOR_CACHE.set(cacheKey, value);
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

function _getLocalDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
    const formatter = LOCAL_DATE_TIME_FORMATTERS.get(timeZone);
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
        hourCycle: "h23",
        timeZoneName: "shortOffset",
    });
    LOCAL_DATE_TIME_FORMATTERS.set(timeZone, nextFormatter);
    return nextFormatter;
}
