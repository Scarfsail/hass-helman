import { css } from "lit";
import type { DeviceReportQuery } from "../helman-api";
import { formatIsoDate, addDays, parseDayKey } from "../shared/time/day-key";

/** The periods the shell offers, in the order it offers them. */
export const PERIOD_PRESETS = [
    "last_7",
    "last_30",
    "last_90",
    "last_365",
    "this_month",
    "last_month",
    "this_year",
    "custom",
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const DEFAULT_PERIOD_PRESET: PeriodPreset = "last_30";

function parseIsoDate(value: string): Date {
    const { year, month, day } = parseDayKey(value) ?? { year: NaN, month: NaN, day: NaN };
    return new Date(Date.UTC(year, month - 1, day));
}

function isoOf(date: Date): string {
    return formatIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}


/**
 * The dates a preset covers, given today's local day key.
 *
 * Rolling presets end today; "last month" is the whole previous calendar month.
 * `custom` has no dates of its own and answers null.
 */
export function presetQuery(
    preset: PeriodPreset | "today" | "yesterday",
    today: string,
): DeviceReportQuery | null {
    switch (preset) {
        case "today":
            return { start_date: today, end_date: today };
        case "yesterday": {
            const yesterday = addDays(today, -1);
            return { start_date: yesterday, end_date: yesterday };
        }
        case "last_7":
            return { start_date: addDays(today, -6), end_date: today };
        case "last_30":
            return { start_date: addDays(today, -29), end_date: today };
        case "last_90":
            return { start_date: addDays(today, -89), end_date: today };
        case "last_365":
            return { start_date: addDays(today, -364), end_date: today };
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

/** The period bars' look: a row of preset chips, the selected one filled, and the custom date fields. */
export const periodBarStyles = css`
    .bar {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
        margin-bottom: 8px;
    }
    .bar button {
        font: inherit;
        font-size: 0.8rem;
        padding: 3px 8px;
        border-radius: 12px;
        border: 1px solid var(--divider-color, #ccc);
        background: transparent;
        color: var(--primary-text-color);
        cursor: pointer;
    }
    .bar button.selected {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: var(--text-primary-color, #fff);
    }
    .custom input {
        font: inherit;
        font-size: 0.8rem;
    }
`;
