/**
 * The months or years the aggregate views offer, as a list of pills.
 *
 * The day view has always had a pill row: every day of its window one click
 * away, with the arrows there to reach a *different* window. The month and year
 * views had a label — words, not a control — and once the history floor became
 * the recorder's own answer rather than a training window, reaching two years
 * back meant twenty-four clicks of `‹‹`. This is what the row offers instead.
 *
 * The list is derived here, away from the element, because everything about it
 * is arithmetic on two dates: where the data starts and where today is. The
 * module imports only types, so a spec exercises it directly rather than
 * through the card bundle.
 */

/** Which span one pill stands for. The day view has its own, richer, row. */
export type SpanPillMode = "month" | "year";

export interface SpanPill {
    /** The span's first day, `YYYY-MM-DD`. What selecting it asks the card for. */
    key: string;
    /** "Mar", "Jan 2025", "2024" — what the pill says. */
    label: string;
    /** Whether the browsed date falls inside this pill's span. */
    selected: boolean;
}

export interface SpanPillOptions {
    viewMode: SpanPillMode;
    /** The oldest date the aggregate views may reach, `YYYY-MM-DD`. */
    minDate: string;
    /** Today in the house's time zone, `YYYY-MM-DD`. The row's far end. */
    todayKey: string;
    /** The date the card is browsing; the pill containing it reads selected. */
    selectedDate: string;
    /** Locale for the month names. Defaults to the runtime's. */
    locale?: string;
}

interface DateParts {
    year: number;
    month: number;
}

/** `YYYY-MM-DD` to its year and month, or `null` if it is not one. */
function parseIsoDate(value: string): DateParts | null {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    if (!Number.isFinite(year) || month < 1 || month > 12) {
        return null;
    }
    return { year, month };
}

function isoFirstOfMonth(year: number, month: number): string {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function isoFirstOfYear(year: number): string {
    return `${String(year).padStart(4, "0")}-01-01`;
}

/**
 * The pills, oldest first, from the floor's span through the one holding today.
 *
 * Both ends are real: the floor is where the recorder's statistics begin and
 * today is where they stop, so no pill in the row is unreachable and none needs
 * a disabled state. A floor the card has not learned yet — or one that is not a
 * date, or one later than today because a clock moved — collapses to the single
 * span holding today rather than to nothing, so the row never disappears out
 * from under the reader.
 */
export function buildSpanPills(options: SpanPillOptions): SpanPill[] {
    const { viewMode, minDate, todayKey, selectedDate, locale } = options;
    const today = parseIsoDate(todayKey);
    if (today === null) {
        return [];
    }
    const floor = parseIsoDate(minDate) ?? today;
    // The browsed date decides which pill is lit. Falling back to today rather
    // than to nothing keeps exactly one pill selected while the card settles.
    const selected = parseIsoDate(selectedDate) ?? today;

    return viewMode === "year"
        ? buildYearPills(floor, today, selected)
        : buildMonthPills(floor, today, selected, locale);
}

function buildYearPills(floor: DateParts, today: DateParts, selected: DateParts): SpanPill[] {
    const first = Math.min(floor.year, today.year);
    const pills: SpanPill[] = [];
    for (let year = first; year <= today.year; year += 1) {
        pills.push({
            key: isoFirstOfYear(year),
            label: String(year),
            selected: year === selected.year,
        });
    }
    return pills;
}

function buildMonthPills(
    floor: DateParts,
    today: DateParts,
    selected: DateParts,
    locale: string | undefined,
): SpanPill[] {
    const firstIndex = Math.min(monthIndex(floor), monthIndex(today));
    const lastIndex = monthIndex(today);
    const selectedIndex = monthIndex(selected);
    const pills: SpanPill[] = [];
    for (let index = firstIndex; index <= lastIndex; index += 1) {
        const year = Math.floor(index / 12);
        const month = (index % 12) + 1;
        // January carries its year, and so does the first pill whatever month it
        // is: a row scrolled to its middle must never leave the reader working
        // out which year they are looking at.
        const withYear = month === 1 || index === firstIndex;
        pills.push({
            key: isoFirstOfMonth(year, month),
            label: monthLabel(year, month, withYear, locale),
            selected: index === selectedIndex,
        });
    }
    return pills;
}

/** Months since year zero, so a range spanning a new year is one subtraction. */
function monthIndex(parts: DateParts): number {
    return parts.year * 12 + (parts.month - 1);
}

/**
 * The month's name, from the runtime rather than from the translation files.
 *
 * Month names are one of the few things every locale already knows, and the
 * card names them this way everywhere else it prints a span.
 */
function monthLabel(
    year: number,
    month: number,
    withYear: boolean,
    locale: string | undefined,
): string {
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, {
        timeZone: "UTC",
        month: "short",
        ...(withYear ? { year: "numeric" } : {}),
    });
}
