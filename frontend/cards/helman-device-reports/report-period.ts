import type { DeviceReportQuery } from "../helman-api";
import { formatIsoDate } from "../shared/today-iso";

/** The periods the shell offers, in the order it offers them. */
export const PERIOD_PRESETS = [
    "last_7",
    "last_30",
    "last_90",
    "this_month",
    "last_month",
    "this_year",
    "custom",
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const DEFAULT_PERIOD_PRESET: PeriodPreset = "last_30";

function parseIsoDate(value: string): Date {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function isoOf(date: Date): string {
    return formatIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addDays(value: string, delta: number): string {
    const date = parseIsoDate(value);
    date.setUTCDate(date.getUTCDate() + delta);
    return isoOf(date);
}

/**
 * The dates a preset covers, given today's local day key.
 *
 * Rolling presets end today; "last month" is the whole previous calendar month.
 * `custom` has no dates of its own and answers null.
 */
export function presetQuery(preset: PeriodPreset, today: string): DeviceReportQuery | null {
    switch (preset) {
        case "last_7":
            return { start_date: addDays(today, -6), end_date: today };
        case "last_30":
            return { start_date: addDays(today, -29), end_date: today };
        case "last_90":
            return { start_date: addDays(today, -89), end_date: today };
        case "this_month":
            return { start_date: `${today.slice(0, 7)}-01`, end_date: today };
        case "last_month": {
            const firstOfThisMonth = parseIsoDate(`${today.slice(0, 7)}-01`);
            const lastOfPrevious = addDays(isoOf(firstOfThisMonth), -1);
            return { start_date: `${lastOfPrevious.slice(0, 7)}-01`, end_date: lastOfPrevious };
        }
        case "this_year":
            return { start_date: `${today.slice(0, 4)}-01-01`, end_date: today };
        case "custom":
            return null;
    }
}
