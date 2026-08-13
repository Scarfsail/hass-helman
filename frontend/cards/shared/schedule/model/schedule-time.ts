import { getCachedLocalDateTimeDescriptor } from "../../../shared/local-date-time-descriptor-cache";

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
/** Slot spacings the planner knows how to lay out rows for. */
export type ScheduleGranularityMinutes = 15 | 30 | 60;

const VALID_SCHEDULE_GRANULARITIES = new Set<number>([15, 30, 60]);

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

export function getScheduleSlotDayKey(slotId: string, timeZone: string): string | null {
    return getScheduleDayKey(slotId, timeZone);
}

export function deriveScheduleGranularityMinutes(
    slotIds: readonly string[],
): ScheduleGranularityMinutes | null {
    const sortedStarts = [...new Set(
        slotIds
            .map((slotId) => getScheduleSlotStartMs(slotId))
            .filter((startMs): startMs is number => startMs !== null),
    )].sort((left, right) => left - right);

    let granularityMinutes: number | null = null;
    for (let index = 1; index < sortedStarts.length; index += 1) {
        const durationMinutes = (sortedStarts[index] - sortedStarts[index - 1]) / 60_000;
        if (!(durationMinutes > 0) || !VALID_SCHEDULE_GRANULARITIES.has(durationMinutes)) {
            continue;
        }

        granularityMinutes = granularityMinutes === null
            ? durationMinutes
            : Math.min(granularityMinutes, durationMinutes);
    }

    return granularityMinutes === null ? null : granularityMinutes as ScheduleGranularityMinutes;
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

export function getNextScheduleBoundaryDelayMs(slotIds: readonly string[], now: Date = new Date()): number | null {
    const boundaries = resolveScheduleSlotBoundaries(slotIds);
    if (boundaries.length === 0) {
        return null;
    }

    const nowMs = now.getTime();
    const boundaryMs = [...new Set(boundaries.flatMap((slot) => slot.endMs === null ? [slot.startMs] : [slot.startMs, slot.endMs]))]
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
        next: _addDaysToDayKey(dayKey, 1),
        previous: _addDaysToDayKey(dayKey, -1),
    };
    return DAY_STEP_MEMO;
}

function _addDaysToDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
