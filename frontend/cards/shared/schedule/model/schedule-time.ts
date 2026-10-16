import { addDays as addDaysToDayKey } from "../../time/day-key";
export { addDays as addDaysToDayKey } from "../../time/day-key";
import { getCachedLocalDateTimeDescriptor } from "../../../shared/time/day-key";

const TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const DAY_LABEL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
/**
 * `dayKey` + locale → the weekday-and-date label.
 *
 * Only the tail of `formatScheduleDayLabel` is cached: the today/tomorrow/
 * yesterday answers stay live, recomputed from `currentDayKey` on every call,
 * so midnight rolls over on its own and this map can never hold a stale
 * "Today". One entry per calendar day per locale, and a pill row is at most a
 * month, so the bound is never reached in practice.
 */
const DAY_LABELS = new Map<string, string>();
const MAX_DAY_LABEL_CACHE_SIZE = 512;
/**
 * The one-day step either side of today, memoised on the day it steps from.
 *
 * `formatScheduleDayLabel` walks it up to twice per pill, and it is a pure
 * function of the pair.
 */
let DAY_STEP_MEMO: { dayKey: string; next: string; previous: string } | null = null;
export interface ScheduleSlotLabels {
    timeLabel: string;
    endLabel: string | null;
    rangeLabel: string;
}

export interface ScheduleLocalTimeParts {
    dayKey: string;
    hour: number;
    minute: number;
    offset: string;
}

export interface ScheduleCompactExpandedRangeLabel {
    leading: string | null;
    primary: string;
    trailing: string | null;
    hideLeading: boolean;
    hideTrailing: boolean;
}

export interface ScheduleSlotBoundary {
    id: string;
    startMs: number;
    endMs: number | null;
}

export function parseScheduleDate(value: string): Date | null {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function getScheduleSlotStartMs(slotId: string): number | null {
    return parseScheduleDate(slotId)?.getTime() ?? null;
}

export function getScheduleDayKey(value: Date | string, timeZone: string): string | null {
    return getCachedLocalDateTimeDescriptor(value, timeZone)?.dayKey ?? null;
}


export function resolveScheduleSlotBoundaries(slotIds: readonly string[]): ScheduleSlotBoundary[] {
    const sorted = slotIds
        .map((slotId) => {
            const startMs = getScheduleSlotStartMs(slotId);
            if (startMs === null) {
                throw new Error(`schedule: invalid schedule slot id "${slotId}"`);
            }

            return {
                id: slotId,
                startMs,
            };
        })
        .sort((left, right) => left.startMs - right.startMs);

    const slots: { id: string; startMs: number }[] = [];
    for (const slot of sorted) {
        if (slots.length > 0 && slot.startMs === slots[slots.length - 1].startMs) {
            slots[slots.length - 1] = slot;
            continue;
        }
        slots.push(slot);
    }

    return slots.map((slot, index) => {
        const nextSlot = slots[index + 1];

        return {
            id: slot.id,
            startMs: slot.startMs,
            endMs: nextSlot?.startMs ?? null,
        };
    });
}

export function getScheduleTimeRangeLabels({
    startMs,
    endMs,
    locale,
    timeZone,
}: {
    startMs: number;
    endMs: number | null;
    locale: string;
    timeZone: string;
}): ScheduleSlotLabels {
    const timeLabel = formatScheduleTime(startMs, locale, timeZone);
    if (endMs === null) {
        return {
            timeLabel,
            endLabel: null,
            rangeLabel: `${timeLabel}+`,
        };
    }

    const endLabel = formatScheduleTime(endMs, locale, timeZone);
    return {
        timeLabel,
        endLabel,
        rangeLabel: startMs === endMs ? timeLabel : `${timeLabel}–${endLabel}`,
    };
}

export function getNextScheduleBoundaryDelayMs(
    slotIds: readonly string[],
    slotMinutes: number,
    now: Date = new Date(),
): number | null {
    const boundaries = resolveScheduleSlotBoundaries(slotIds);
    if (boundaries.length === 0) {
        return null;
    }

    const nowMs = now.getTime();
    const slotDurationMs = slotMinutes * 60_000;
    const boundaryMs = [...new Set(boundaries.flatMap((slot) => [slot.startMs, slot.startMs + slotDurationMs]))]
        .sort((left, right) => left - right);

    const nextBoundaryMs = boundaryMs.find((value) => value > nowMs);
    if (nextBoundaryMs !== undefined) {
        return Math.max(nextBoundaryMs - nowMs, 0);
    }

    return null;
}

export function formatScheduleDayLabel({
    dayKey,
    currentDayKey,
    locale,
    todayLabel,
    tomorrowLabel,
    yesterdayLabel,
}: {
    dayKey: string;
    currentDayKey: string | null;
    locale: string;
    todayLabel: string;
    tomorrowLabel: string;
    /**
     * Names the day before today. Omitted by the schedule, which never looks
     * back; the inspector's pills do, and one step back is worth a word for the
     * same reason "tomorrow" is.
     */
    yesterdayLabel?: string;
}): string {
    if (currentDayKey !== null) {
        if (dayKey === currentDayKey) {
            return todayLabel;
        }

        const steps = _dayStepsFrom(currentDayKey);
        if (dayKey === steps.next) {
            return tomorrowLabel;
        }

        if (yesterdayLabel !== undefined && dayKey === steps.previous) {
            return yesterdayLabel;
        }
    }

    return _formatDayKeyLabel(dayKey, locale);
}

function _formatDayKeyLabel(dayKey: string, locale: string): string {
    const cacheKey = `${locale}::${dayKey}`;
    const cached = DAY_LABELS.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const label = _getDayLabelFormatter(locale).format(new Date(`${dayKey}T00:00:00Z`));
    if (DAY_LABELS.size >= MAX_DAY_LABEL_CACHE_SIZE) {
        DAY_LABELS.clear();
    }
    DAY_LABELS.set(cacheKey, label);
    return label;
}

function _getDayLabelFormatter(locale: string): Intl.DateTimeFormat {
    const formatter = DAY_LABEL_FORMATTERS.get(locale);
    if (formatter !== undefined) {
        return formatter;
    }

    const nextFormatter = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "numeric",
    });
    DAY_LABEL_FORMATTERS.set(locale, nextFormatter);
    return nextFormatter;
}

export function formatScheduleTime(
    value: number | string | Date,
    locale: string,
    timeZone: string,
): string {
    const date = typeof value === "number"
        ? new Date(value)
        : typeof value === "string"
        ? parseScheduleDate(value)
        : value;
    if (date === null || Number.isNaN(date.getTime())) {
        return String(value);
    }

    return _getTimeFormatter(locale, timeZone).format(date);
}

export function getScheduleLocalTimeParts(
    value: number | string | Date,
    timeZone: string,
): ScheduleLocalTimeParts | null {
    const descriptor = getCachedLocalDateTimeDescriptor(value, timeZone);
    if (descriptor === null) {
        return null;
    }

    return {
        dayKey: descriptor.dayKey,
        hour: descriptor.hour,
        minute: descriptor.minute,
        offset: descriptor.offset,
    };
}

/**
 * The start of the local day `atMs` falls on, in `timeZone`: its midnight,
 * an exact instant even on a daylight-saving day, when the hours since
 * midnight on the clock are not the hours elapsed.
 */
export function getScheduleLocalDayStartMs(atMs: number, timeZone: string): number {
    const day = getScheduleLocalTimeParts(atMs, timeZone)?.dayKey;
    let start = Math.floor(atMs / 60_000) * 60_000;
    // Step back by the clock's hours, then correct once more for an hour the
    // clock skipped or repeated on the way.
    for (let step = 0; step < 3; step += 1) {
        const parts = getScheduleLocalTimeParts(start, timeZone);
        if (parts === null || day === undefined) break;
        if (parts.dayKey !== day) start += ((24 - parts.hour) * 60 - parts.minute) * 60_000;
        else if (parts.hour !== 0 || parts.minute !== 0) start -= (parts.hour * 60 + parts.minute) * 60_000;
        else break;
    }
    return start;
}

export function buildScheduleCompactExpandedRangeLabel({
    startMs,
    endMs,
    locale,
    timeZone,
}: {
    startMs: number;
    endMs: number | null;
    locale: string;
    timeZone: string;
}): ScheduleCompactExpandedRangeLabel {
    const startLabel = formatScheduleTime(startMs, locale, timeZone);
    if (endMs === null) {
        return {
            leading: null,
            primary: startLabel,
            trailing: null,
            hideLeading: false,
            hideTrailing: false,
        };
    }

    const startLabelParts = _getTimeFormatter(locale, timeZone).formatToParts(new Date(startMs));
    const minutePartIndex = startLabelParts.map((part) => part.type).lastIndexOf("minute");
    const minutePart = minutePartIndex === -1 ? undefined : startLabelParts[minutePartIndex];
    if (minutePartIndex === -1 || minutePart === undefined || minutePart.type !== "minute") {
        return {
            leading: null,
            primary: getScheduleTimeRangeLabels({
                startMs,
                endMs,
                locale,
                timeZone,
            }).rangeLabel,
            trailing: null,
            hideLeading: false,
            hideTrailing: false,
        };
    }

    return {
        leading: startLabelParts
            .slice(0, minutePartIndex + 1)
            .slice(0, -1)
            .map((part) => part.value)
            .join("") || null,
        primary: minutePart.value,
        trailing: startLabelParts
            .slice(minutePartIndex + 1)
            .map((part) => part.value)
            .join("") || null,
        hideLeading: true,
        hideTrailing: true,
    };
}

function _getTimeFormatter(locale: string, timeZone: string): Intl.DateTimeFormat {
    const cacheKey = `${locale}::${timeZone}`;
    const formatter = TIME_FORMATTERS.get(cacheKey);
    if (formatter !== undefined) {
        return formatter;
    }

    const nextFormatter = new Intl.DateTimeFormat(locale, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
    });
    TIME_FORMATTERS.set(cacheKey, nextFormatter);
    return nextFormatter;
}

function _dayStepsFrom(dayKey: string): { dayKey: string; next: string; previous: string } {
    if (DAY_STEP_MEMO !== null && DAY_STEP_MEMO.dayKey === dayKey) {
        return DAY_STEP_MEMO;
    }

    DAY_STEP_MEMO = {
        dayKey,
        next: addDaysToDayKey(dayKey, 1),
        previous: addDaysToDayKey(dayKey, -1),
    };
    return DAY_STEP_MEMO;
}
