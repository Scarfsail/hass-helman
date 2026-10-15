/**
 * Today's day key (`YYYY-MM-DD`) in Home Assistant's time zone.
 *
 * Shared by the solar inspector and the device reports, which both have to
 * agree with the backend about which local day "today" is.
 */

/** A calendar date as its `YYYY-MM-DD` key. */
export function formatIsoDate(year: number, month: number, day: number): string {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The local day `value` falls on in `timeZone`, or in the browser's zone without one. */
export function isoDateInTimeZone(value: Date, timeZone: string | undefined): string {
    if (!timeZone) {
        return formatIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }

    const parts = _getLocalDateTimeFormatter(timeZone).formatToParts(value);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return formatIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    return formatIsoDate(year, month, day);
}

let todayMemo: { second: number; timeZone: string | undefined; value: string } | null = null;

/**
 * Today's day key, recomputed at most once a second.
 *
 * It is asked for several times per render and the answer only changes at
 * midnight, so a second of staleness is invisible -- but only a second: this
 * deliberately does not ride the coarse `now-clock` resolution, because half
 * a minute of lag at midnight is a visibly wrong answer. The time zone is
 * part of the key because it really does change.
 */
export function todayKey(timeZone: string | undefined): string {
    const second = Math.floor(Date.now() / 1000);
    const memo = todayMemo;
    if (memo !== null && memo.second === second && memo.timeZone === timeZone) {
        return memo.value;
    }

    const value = isoDateInTimeZone(new Date(), timeZone);
    todayMemo = { second, timeZone, value };
    return value;
}

export interface LocalDateTimeParts {
    dayKey: string;
    hour: number;
}

export interface LocalDateTimeDescriptor extends LocalDateTimeParts {
    minute: number;
    offset: string;
}

const MAX_LOCAL_DATE_TIME_DESCRIPTOR_CACHE_SIZE = 2048;
/** One formatter per time zone serves day keys and local time descriptors. */
const LOCAL_DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const LOCAL_DATE_TIME_DESCRIPTOR_CACHE = new Map<string, LocalDateTimeDescriptor | null>();

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

/** Strict calendar day parsing; callers choose their own invalid-input fallback. */
export function parseDayKey(value: string): { year: number; month: number; day: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(`${value}T00:00:00Z`);
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
        ? { year, month, day } : null;
}

export function addDays(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/** Calendar days from start to end, independent of daylight saving time. */
export function daysBetween(start: string, end: string): number {
    return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}
