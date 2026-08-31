import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";

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
