import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";
import {
    STOP_MONTH_VIEW,
    STOP_SLOT_60,
    clickStop,
    waitForAggregateChart,
} from "./support/inspector-aggregate-harness";

/**
 * The solar inspector refreshing under the user rather than at them.
 *
 * This is the surface the whole feature is about: watching the inspector at
 * 10:15 when the automation run rewrites the plan. Reusing the refresh button's
 * handler was not enough, because that handler is written for a *navigation* —
 * it nulls the payload and raises the loading note before the request, which
 * would blank the card on every backend re-plan.
 *
 * So there are two loads now, and the distinction is what these tests pin:
 *
 * - **A navigation keeps the old day up, dimmed, under a loading overlay.**
 *   The day being drawn is about to be a different day, but the previous
 *   day's chart holds the card's height rather than the card collapsing and
 *   re-expanding around the request — see #195. The old content is inert
 *   while it is up, so it cannot be mistaken for the day that was asked for.
 * - **A refresh shows nothing at all until it lands.** No loading overlay, no
 *   vanished chart, and the day and slot the user picked are still picked
 *   afterwards — they never asked for this reload.
 *
 * The fake backend holds each inspector request open until the test releases
 * it, so "what is on screen while the request is in flight" is an assertion
 * rather than a race.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Days the inspector offers, counting today as day 0. */
const PILL_DAYS = 4;

async function mountInspector(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
    await installFakeHass(page, { pillDays: PILL_DAYS });

    await page.evaluate(() => {
        const el = document.createElement("helman-solar-inspector") as HTMLElement &
            Record<string, unknown>;
        el.hass = window.__fakeHass;
        document.body.appendChild(el);
    });

    // The first load is a navigation like any other: release it, then wait for
    // the chart it draws.
    await page.waitForFunction(() => window.__pendingInspector() === 1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true });
}

type CardReadout = {
    hasChart: boolean;
    /** The `.note` blocks that sit above the content shell — the error note
     *  is one of these; the loading note moved into `.loading-overlay`. */
    notes: string[];
    /** The centered loading message's text, or "" when it is not up. */
    overlayText: string;
    /** Whether the content shell is dimming and disabling what it holds. */
    dimmed: boolean;
    /** The day pill currently pressed. */
    selectedDay: string;
    totals: string;
};

function readCard(page: Page): Promise<CardReadout> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        const pills = root?.querySelector("helman-solar-day-pills")?.shadowRoot;
        const pressed = pills?.querySelector('.pill[aria-pressed="true"]');
        return {
            hasChart: !!root?.querySelector(".chart-wrap"),
            notes: Array.from(root?.querySelectorAll(".body > .note") ?? []).map(
                (note) => note.textContent?.trim() ?? "",
            ),
            overlayText: root?.querySelector(".loading-overlay")?.textContent?.trim() ?? "",
            dimmed: !!root?.querySelector(".content-shell.is-loading"),
            selectedDay: pressed?.getAttribute("data-day") ?? "",
            totals: root?.querySelector(".metrics-section")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        };
    });
}

/**
 * Leave today by picking an earlier day out of the row, as a user would.
 *
 * The row starts on today and reaches forward, so the day behind it comes from
 * the picker: opening it turns the row into the whole current month, and the
 * last pill before today is yesterday.
 */
async function pressPreviousWeek(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        (root?.querySelector(".nav-more") as HTMLButtonElement | undefined)?.click();
    });
    await page.evaluate(() => {
        const today = new Date().toISOString().slice(0, 10);
        const pills = document.querySelector("helman-solar-inspector")?.shadowRoot
            ?.querySelector("helman-solar-day-pills")?.shadowRoot;
        const days = [...(pills?.querySelectorAll(".pill") ?? [])];
        // Behind today by preference; on the 1st the month offers nothing
        // behind, and what the callers need is only a day that is not today.
        const other = days.filter((pill) => (pill.getAttribute("data-day") ?? "") < today).pop()
            ?? days.find((pill) => (pill.getAttribute("data-day") ?? "") > today);
        (other as HTMLButtonElement | undefined)?.click();
    });
}

test("a navigation keeps the old day drawn, dimmed, under the loading overlay", async ({ page }) => {
    await mountInspector(page);
    const startingDay = (await readCard(page)).selectedDay;

    await pressPreviousWeek(page);
    await page.waitForFunction(() => window.__pendingInspector() === 1);

    // Mid-flight: the old day's chart is still up rather than gone, but it
    // reads as stale rather than current -- dimmed, inert, with the loading
    // message centered over it.
    const inFlight = await readCard(page);
    expect(inFlight.hasChart).toBe(true);
    expect(inFlight.dimmed).toBe(true);
    expect(inFlight.overlayText.length).toBeGreaterThan(0);
    expect(inFlight.notes).toEqual([]);

    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true, dimmed: false });
    expect((await readCard(page)).selectedDay).not.toBe(startingDay);
});

test("an announced change refreshes the drawn day without disturbing it", async ({ page }) => {
    await mountInspector(page);

    // Leave today, so a refresh that quietly fell back to today would show up.
    await pressPreviousWeek(page);
    await page.waitForFunction(() => window.__pendingInspector() === 1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true });

    const before = await readCard(page);
    const requestsBefore = await page.evaluate(() => window.__requestedDates.length);

    // The backend re-planned. Nothing the user did.
    // 9 kWh against the 6 kWh already drawn — far enough apart to survive the
    // card's rounding to one decimal.
    await page.evaluate(() => window.__setActualWh(9000));
    await page.evaluate(() => window.__fireDataChanged("plan"));
    await page.waitForFunction(
        (count) => window.__requestedDates.length === count + 1,
        requestsBefore,
    );

    // In flight, and the user cannot tell: same chart, same day, no note.
    const inFlight = await readCard(page);
    expect(inFlight.hasChart).toBe(true);
    expect(inFlight.notes).toEqual([]);
    expect(inFlight.selectedDay).toBe(before.selectedDay);

    // And it asked for the day being drawn, not for today.
    const requested = await page.evaluate(() => window.__requestedDates);
    expect(requested[requested.length - 1]).toBe(before.selectedDay);

    await page.evaluate(() => window.__releaseInspector());

    // The new numbers land, still on the day the user had picked.
    await expect.poll(async () => (await readCard(page)).totals).toContain("9.0 kWh");
    const after = await readCard(page);
    expect(after.totals).not.toBe(before.totals);
    expect(after.selectedDay).toBe(before.selectedDay);
    expect(after.hasChart).toBe(true);
});

/**
 * The same announcement, arriving while the reader is at M.
 *
 * The day view is not on screen there, and a full inspector day — every
 * series, the actuals, the training explainability — fetched so that nothing
 * can draw it is the request this pair exists to stop. What the reader *is*
 * looking at is the span, which the subscriber used never to ask for at all:
 * `_loadSpan`'s key guard reads "the window has not moved" as "there is
 * nothing to fetch", which is exactly the case an announcement is about.
 */
test("an announced change at M refreshes the span, not the day", async ({ page }) => {
    await mountInspector(page);
    await clickStop(page, STOP_MONTH_VIEW);
    await waitForAggregateChart(page);

    const daysBefore = await page.evaluate(() => window.__requestedDates.length);
    const spansBefore = await spanReads(page);
    expect(spansBefore).toHaveLength(1);

    await page.evaluate(() => window.__fireDataChanged("plan"));

    // The span is asked for again, for the very window already on screen.
    await expect.poll(() => spanReads(page).then((reads) => reads.length)).toBe(2);
    const spansAfter = await spanReads(page);
    expect(spansAfter[1]).toEqual(spansBefore[0]);
    // And nothing was spent on the day nobody is looking at.
    expect(await page.evaluate(() => window.__requestedDates.length)).toBe(daysBefore);
});

test("returning to the day view spends the day request the aggregate view saved", async ({ page }) => {
    await mountInspector(page);
    await clickStop(page, STOP_MONTH_VIEW);
    await waitForAggregateChart(page);

    const daysBefore = await page.evaluate(() => window.__requestedDates.length);
    await page.evaluate(() => window.__fireDataChanged("plan"));
    await expect.poll(() => spanReads(page).then((reads) => reads.length)).toBe(2);

    // Back to the day view. The payload it still holds is the one the
    // announcement invalidated, so the day is read again even though the
    // selected date never moved -- which is what the date guard alone would
    // have called "already loaded".
    await clickStop(page, STOP_SLOT_60);
    await page.waitForFunction(
        (count) => window.__requestedDates.length === count + 1,
        daysBefore,
    );
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true });
});

/**
 * What a background span refresh is allowed to do to the reader.
 *
 * The announcement path carries `silent` through to the span the same way it
 * carries it to the day: the reader is studying the month, and a re-plan they
 * did not ask for must not dim it under a loading chip. The refresh button, a
 * navigation the reader did ask for, still shows itself.
 */
test("an announced span refresh is silent, the refresh button is not", async ({ page }) => {
    await mountInspector(page);
    await clickStop(page, STOP_MONTH_VIEW);
    await waitForAggregateChart(page);

    const shown = await page.evaluate(() => {
        const card = document.querySelector("helman-solar-inspector") as any;
        const hass = card.hass;
        const original = hass.callWS;
        // Held open, so both loads are still in flight when they are read.
        hass.callWS = () => new Promise(() => { /* never lands */ });
        // The key answers "same window", which is exactly the case here; the
        // refresh path clears it, so do that rather than fake a navigation.
        card._spanRequestKey = null;
        void card._loadSpan(true);
        const silent = card._spanLoading;
        card._spanRequestKey = null;
        void card._loadSpan(false);
        const loud = card._spanLoading;
        hass.callWS = original;
        return { silent, loud };
    });

    expect(shown).toEqual({ silent: false, loud: true });
});

/**
 * Two reads of the same window, and which one is allowed to land.
 *
 * An announcement asks for the window already on screen, so the request key
 * cannot tell the two apart -- both carry `bucket:start..end`. Without a
 * monotonic id the older answer passes the guard and paints the data the
 * announcement was about to replace.
 */
test("a slow span answer cannot land on top of a newer one", async ({ page }) => {
    await mountInspector(page);
    await clickStop(page, STOP_MONTH_VIEW);
    await waitForAggregateChart(page);

    const landed = await page.evaluate(async () => {
        const card = document.querySelector("helman-solar-inspector") as any;
        const hass = card.hass;
        const original = hass.callWS;
        const sample = card._span.days[0];

        let releaseStale: ((value: unknown) => void) | null = null;
        hass.callWS = () => new Promise((resolve) => { releaseStale = resolve; });
        card._spanRequestKey = null;
        const stale = card._loadSpan(true);

        // The same window again, and this answer is the current one.
        hass.callWS = async () => ({ currency: "CZK", days: [sample, { ...sample }] });
        card._spanRequestKey = null;
        await card._loadSpan(true);
        const afterFresh = card._span.days.length;

        releaseStale!({ currency: "CZK", days: [] });
        await stale;
        hass.callWS = original;
        return { afterFresh, afterStale: card._span.days.length, loading: card._spanLoading };
    });

    expect(landed).toEqual({ afterFresh: 2, afterStale: 2, loading: false });
});

/** The span reads only: the day pills share the command without a bucket. */
function spanReads(page: Page): Promise<Array<{ start: string; end: string; bucket: string | null }>> {
    return page.evaluate(() =>
        window.__aggregateRequests.filter((request) => request.bucket !== null));
}
