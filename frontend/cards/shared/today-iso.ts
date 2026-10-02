/**
 * Today's day key (`YYYY-MM-DD`) in Home Assistant's time zone.
 *
 * Shared by the solar inspector and the device reports, which both have to
 * agree with the backend about which local day "today" is.
 */

/**
 * One `Intl.DateTimeFormat` per time zone for the page's lifetime.
 *
 * `todayIso()` is asked for the current day key several times per render, and
 * building a formatter for each of those was the single most expensive thing
 * the inspector's navigation did.
 */
const DAY_KEY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
    const formatter = DAY_KEY_FORMATTERS.get(timeZone);
    if (formatter !== undefined) {
        return formatter;
    }

    const nextFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    DAY_KEY_FORMATTERS.set(timeZone, nextFormatter);
    return nextFormatter;
}

/** A calendar date as its `YYYY-MM-DD` key. */
export function formatIsoDate(year: number, month: number, day: number): string {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The local day `value` falls on in `timeZone`, or in the browser's zone without one. */
export function isoDateInTimeZone(value: Date, timeZone: string | undefined): string {
    if (!timeZone) {
        return formatIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }

    const parts = dayKeyFormatter(timeZone).formatToParts(value);
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
export function todayIso(timeZone: string | undefined): string {
    const second = Math.floor(Date.now() / 1000);
    const memo = todayMemo;
    if (memo !== null && memo.second === second && memo.timeZone === timeZone) {
        return memo.value;
    }

    const value = isoDateInTimeZone(new Date(), timeZone);
    todayMemo = { second, timeZone, value };
    return value;
}
