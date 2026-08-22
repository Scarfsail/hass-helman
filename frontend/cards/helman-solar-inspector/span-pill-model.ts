/**
 * The two rows of pills the aggregate views pick a span with: years, then
 * months.
 *
 * The day view has always had a pill row — every day of its window one click
 * away, with the arrows there to reach a *different* window. The month and year
 * views had a label instead: words, not a control. Once the history floor
 * became the recorder's own answer rather than a training window, reaching two
 * years back meant twenty-four clicks of `‹‹`.
 *
 * Two rows rather than one long one, because a span is two independent choices.
 * The year row holds every year there is data for; the month row holds all
 * twelve, always, with the ones outside the data *disabled rather than hidden*
 * so the row never changes shape under the reader and a gap is visible as a
 * gap. Keeping the months in fixed positions is also what lets a month stay
 * picked while the year changes — the whole point of the second row.
 *
 * The list is derived here, away from the element, because everything about it
 * is arithmetic on three dates: where the data starts, where today is, and
 * what is being browsed. The module imports only types, so a spec exercises it
 * directly rather than through the card bundle.
 */

/**
 * Which span one *view* is made of, which is not what the rows offer.
 *
 * `"month"` is the view whose columns are days — a month of them — so both a
 * year and a month are being browsed and both rows have a lit pill.
 * `"year"` is the view whose columns are months, so only a year is being
 * browsed and the month row has nothing lit.
 */
export type SpanPillMode = "month" | "year";

export interface SpanPill {
    /** The span's first day, `YYYY-MM-DD`. What selecting it asks the card for. */
    key: string;
    /** "Mar", "2024" — what the pill says. Months never carry their year. */
    label: string;
    /** Whether this pill is the one being browsed. */
    selected: boolean;
    /** Whether there is no data for it, so it is shown but cannot be picked. */
    disabled: boolean;
}

export interface SpanPillRows {
    years: SpanPill[];
    months: SpanPill[];
}

export interface SpanPillOptions {
    viewMode: SpanPillMode;
    /** The oldest date the aggregate views may reach, `YYYY-MM-DD`. */
    minDate: string;
    /** Today in the house's time zone, `YYYY-MM-DD`. The far end of both rows. */
    todayKey: string;
    /** The date the card is browsing; its year and month are the lit ones. */
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

/** Months since year zero, so a range spanning a new year is one subtraction. */
function monthIndex(parts: DateParts): number {
    return parts.year * 12 + (parts.month - 1);
}

/** The three dates every answer here is arithmetic on, once each. */
interface Bounds {
    floor: DateParts;
    today: DateParts;
    selected: DateParts;
}

/**
 * Read the options into dates, or `null` if today is unreadable.
 *
 * A floor the card has not learned yet — the state on the first render, before
 * the span load has answered — collapses to today's span rather than to
 * nothing, so the rows never disappear out from under the reader. Same for a
 * browsed date that is not one: something has to be lit.
 */
function readBounds(options: SpanPillOptions): Bounds | null {
    const today = parseIsoDate(options.todayKey);
    if (today === null) {
        return null;
    }
    const floor = parseIsoDate(options.minDate) ?? today;
    return {
        today,
        floor: monthIndex(floor) > monthIndex(today) ? today : floor,
        selected: parseIsoDate(options.selectedDate) ?? today,
    };
}

/** Both rows, ready to draw. Empty rows where the options say nothing. */
export function buildSpanPillRows(options: SpanPillOptions): SpanPillRows {
    const bounds = readBounds(options);
    if (bounds === null) {
        return { years: [], months: [] };
    }
    return {
        years: buildYearPills(bounds),
        months: buildMonthPills(bounds, options.viewMode, options.locale),
    };
}

/**
 * One pill per year with data, oldest first.
 *
 * The lit one is the browsed year in *both* view modes: a year view is browsing
 * that year, and a month view is browsing a month inside it.
 */
function buildYearPills(bounds: Bounds): SpanPill[] {
    const pills: SpanPill[] = [];
    for (let year = bounds.floor.year; year <= bounds.today.year; year += 1) {
        pills.push({
            key: isoFirstOfMonth(year, 1),
            label: String(year),
            selected: year === bounds.selected.year,
            // Every year in the range has at least the month that put it there.
            disabled: false,
        });
    }
    return pills;
}

/**
 * All twelve months of the browsed year, in fixed positions.
 *
 * Disabled rather than omitted outside the data: a row that changed length as
 * the year changed would move the months around under the pointer, and the
 * whole reason the months sit in their own row is that one stays picked while
 * the year moves beneath it. A disabled pill also says something a missing one
 * cannot — that the month exists and the recorder has nothing for it.
 *
 * Nothing is lit in the year view. Its columns *are* the months, so lighting
 * one would claim a narrower span than the view is showing.
 */
function buildMonthPills(
    bounds: Bounds,
    viewMode: SpanPillMode,
    locale: string | undefined,
): SpanPill[] {
    const year = bounds.selected.year;
    const pills: SpanPill[] = [];
    for (let month = 1; month <= 12; month += 1) {
        const index = monthIndex({ year, month });
        pills.push({
            key: isoFirstOfMonth(year, month),
            label: monthLabel(year, month, locale),
            selected: viewMode === "month" && month === bounds.selected.month,
            disabled: index < monthIndex(bounds.floor) || index > monthIndex(bounds.today),
        });
    }
    return pills;
}

/**
 * Where clicking a year lands, given what is already being browsed.
 *
 * In the year view it is simply that year. In the month view the month is kept
 * — switching year is meant to show the same month elsewhere in time, not to
 * throw the choice away — and clamped into what that year actually has, so
 * jumping to the current year from a December lands on the newest month rather
 * than on one that has not happened.
 */
export function spanKeyForYear(options: SpanPillOptions, year: number): string | null {
    const bounds = readBounds(options);
    if (bounds === null) {
        return null;
    }
    if (options.viewMode === "year") {
        return isoFirstOfMonth(year, 1);
    }
    const wanted = monthIndex({ year, month: bounds.selected.month });
    const clamped = Math.min(
        Math.max(wanted, monthIndex(bounds.floor)),
        monthIndex(bounds.today),
    );
    return isoFirstOfMonth(Math.floor(clamped / 12), (clamped % 12) + 1);
}

/**
 * The month's name, from the runtime rather than from the translation files.
 *
 * Month names are one of the few things every locale already knows, and the
 * card names them this way everywhere else it prints a span.
 */
function monthLabel(year: number, month: number, locale: string | undefined): string {
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, {
        timeZone: "UTC",
        month: "short",
    });
}
