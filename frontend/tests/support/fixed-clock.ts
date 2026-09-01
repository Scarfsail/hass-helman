import type { Page } from "@playwright/test";

/**
 * The one instant every card spec runs at.
 *
 * The fixtures these specs mount against are generated from the clock rather
 * than written out — a day payload for "today", a span row per day of "this
 * month" — so without this the shape of the fixture, and with it what the
 * assertions are about, depends on the calendar day the suite happens to run.
 * That is not a theoretical worry: on the first of a month the middle column of
 * the month view is a fortnight in the future, and eleven inspector specs that
 * take the middle column went red on `main` with no code change behind it.
 *
 * The date is chosen so that every shape these specs need is on screen at once:
 * past the middle of a 31-day month, so the month has measured days behind it
 * and forecast days ahead of it and its middle column is one that has happened;
 * late in the year, so the month row has months on both sides of the lit one and
 * enough of them before it that a narrow row has to scroll to reach it; and
 * midday on a weekday, so "now" sits inside the day rather than on either edge.
 *
 * `setFixedTime` freezes `Date` in the page and leaves timers alone, so code
 * that schedules work still runs — it just always agrees with the fixtures
 * about what day it is.
 */
export const FIXED_NOW_ISO = "2026-10-21T12:00:00.000Z";

/** `FIXED_NOW_ISO` as the day key the cards select days by. */
export const FIXED_TODAY = FIXED_NOW_ISO.slice(0, 10);

/** The year of `FIXED_NOW_ISO`, for specs that build a floor from it. */
export const FIXED_YEAR = Number(FIXED_NOW_ISO.slice(0, 4));

/**
 * Freeze the page's clock at `FIXED_NOW_ISO`.
 *
 * Called by the two entry points every spec goes through — `loadCardBundle` and
 * `installFakeHass` — so a spec gets the fixed clock by mounting anything at
 * all, rather than by remembering to ask for it. Node-side date arithmetic in
 * the specs has to use the constants above to match.
 */
export async function installFixedClock(page: Page): Promise<void> {
    await page.clock.setFixedTime(new Date(FIXED_NOW_ISO));
}
