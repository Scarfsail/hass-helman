import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";
import {
    STOP_MONTH_VIEW,
    clickStop,
    columns,
    loadCardBundle,
    mountInspector as mountAggregateInspector,
    pageBack,
} from "./support/inspector-aggregate-harness";

/**
 * #195 -- the card holds its height and its last drawn content across a load,
 * instead of collapsing to a one-line note and re-expanding once the request
 * lands.
 *
 * Both loads it fixes are covered here: a day-view navigation, whose stale
 * payload is kept and dimmed under the loading overlay, and an aggregate-view
 * span switch, which does the same with the previous span's rows. A cold mount
 * — the one case with nothing stale to hold the box open — is covered on the
 * day-view side; the aggregate side reaches the identical code path (see
 * `_renderBody`), so it is not repeated there.
 */

/** Matches `INSPECTOR_CONTENT_MIN_HEIGHT` in the card; a wide floor so the
 *  assertion survives a few pixels of drift without chasing the constant. */
const MIN_HEIGHT_FLOOR = 400;

/** Days the inspector offers, counting today as day 0. */
const PILL_DAYS = 4;

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

async function mountDayViewInspector(page: Page): Promise<void> {
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
}

/**
 * Move to tomorrow, which the default row already offers -- unlike a past
 * day, it needs no "more" press first, so the only thing that changes on
 * screen is the day itself, not the picker's own layout underneath it.
 */
async function pressNextDay(page: Page): Promise<void> {
    await page.evaluate(() => {
        const todayIso = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.parse(`${todayIso}T00:00:00Z`) + 86_400_000)
            .toISOString().slice(0, 10);
        const pills = document.querySelector("helman-solar-inspector")?.shadowRoot
            ?.querySelector("helman-solar-day-pills")?.shadowRoot;
        (pills?.querySelector(`.pill[data-day="${tomorrow}"]`) as HTMLButtonElement | null)?.click();
    });
}

type ShellReadout = {
    bodyHeight: number;
    hasChart: boolean;
    isLoading: boolean;
    overlayText: string;
    /** The chart-wrap's own opacity, read through `getComputedStyle` -- the
     *  dimming rule targets the shell's children, so this is what shows it
     *  actually landed on the content and not just on the shell. */
    contentOpacity: string;
    errorNotes: string[];
};

async function readShell(page: Page): Promise<ShellReadout> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        const body = root?.querySelector(".body");
        const chartWrap = root?.querySelector(".chart-wrap");
        return {
            bodyHeight: body?.getBoundingClientRect().height ?? 0,
            hasChart: !!chartWrap,
            isLoading: !!root?.querySelector(".content-shell.is-loading"),
            overlayText: root?.querySelector(".loading-overlay")?.textContent?.trim() ?? "",
            contentOpacity: chartWrap ? getComputedStyle(chartWrap).opacity : "",
            errorNotes: Array.from(root?.querySelectorAll(".body > .note") ?? []).map(
                (note) => note.textContent?.trim() ?? "",
            ),
        };
    });
}

test.describe("day view", () => {
    test("a cold mount opens at the height floor with the loading message centered", async ({ page }) => {
        await mountDayViewInspector(page);

        // Caught before the very first request lands: nothing stale to hold the
        // box open, so the shell supplies its own floor instead.
        await page.waitForFunction(() => window.__pendingInspector() === 1);
        const cold = await readShell(page);
        expect(cold.hasChart).toBe(false);
        expect(cold.isLoading).toBe(true);
        expect(cold.overlayText.length).toBeGreaterThan(0);
        expect(cold.bodyHeight).toBeGreaterThanOrEqual(MIN_HEIGHT_FLOOR);

        await page.evaluate(() => window.__releaseInspector());
        await expect.poll(() => readShell(page)).toMatchObject({ hasChart: true, isLoading: false });
    });

    test("a day switch keeps the previous day's chart drawn, dimmed, at the same height", async ({ page }) => {
        await mountDayViewInspector(page);
        await page.waitForFunction(() => window.__pendingInspector() === 1);
        await page.evaluate(() => window.__releaseInspector());
        await expect.poll(() => readShell(page)).toMatchObject({ hasChart: true });

        const before = await readShell(page);

        await pressNextDay(page);
        await page.waitForFunction(() => window.__pendingInspector() === 1);

        // In flight: the old chart is still up, at the same height, dimmed and
        // overlaid rather than replaced by a one-line note.
        const inFlight = await readShell(page);
        expect(inFlight.hasChart).toBe(true);
        expect(inFlight.bodyHeight).toBeCloseTo(before.bodyHeight, 0);
        expect(inFlight.isLoading).toBe(true);
        expect(inFlight.overlayText.length).toBeGreaterThan(0);
        expect(Number(inFlight.contentOpacity)).toBeLessThan(1);

        await page.evaluate(() => window.__releaseInspector());
        await expect.poll(() => readShell(page)).toMatchObject({ hasChart: true, isLoading: false });
    });

    test("a failed load leaves the previous chart on screen under the error note", async ({ page }) => {
        await mountDayViewInspector(page);
        await page.waitForFunction(() => window.__pendingInspector() === 1);
        await page.evaluate(() => window.__releaseInspector());
        await expect.poll(() => readShell(page)).toMatchObject({ hasChart: true });

        // Swapped in after the first, working load: the fixture's own
        // `callWS` is captured so the failure is the only thing this changes.
        await page.evaluate(() => {
            const original = (window.__fakeHass as { callWS: (msg: unknown) => Promise<unknown> }).callWS;
            (window.__fakeHass as Record<string, unknown>).callWS = async (msg: {
                type: string;
                date?: string;
            }) => {
                if (msg.type === "helman/solar_bias/inspector") {
                    window.__requestedDates.push(msg.date ?? "");
                    throw new Error("boom");
                }
                return original(msg);
            };
        });

        await pressNextDay(page);
        await expect.poll(async () => (await readShell(page)).errorNotes.length).toBe(1);

        // Not a blank card: the chart from before the failed request is still
        // up, dimmed, under the error note. The overlay's own loading message
        // is gone -- the request that message was about is done, not in
        // flight -- but the note above says what happened instead.
        const failed = await readShell(page);
        expect(failed.hasChart).toBe(true);
        expect(failed.isLoading).toBe(true);
        expect(failed.overlayText).toBe("");
        expect(failed.errorNotes[0].length).toBeGreaterThan(0);
    });
});

test.describe("aggregate view", () => {
    const pendingSpan = (page: Page) => page.evaluate(() => (window as any).__pendingSpan());
    const releaseSpan = (page: Page) => page.evaluate(() => (window as any).__releaseSpan());

    test("a span switch keeps the previous span's chart drawn, dimmed, at the same height", async ({ page }) => {
        await loadCardBundle(page);
        await mountAggregateInspector(page, false, "", "2020-01-01", null, true);

        // `helman/solar_bias/day_aggregates` is also what feeds the day pills'
        // own history gauges, and holding span requests holds that read too --
        // drain it before the switch this test cares about, so the pending
        // count below is only ever the aggregate view's own load.
        await page.waitForFunction(() => (window as any).__pendingSpan() === 1);
        await releaseSpan(page);

        await clickStop(page, STOP_MONTH_VIEW);
        await page.waitForFunction(() => (window as any).__pendingSpan() === 1);
        await releaseSpan(page);
        await expect.poll(() => columns(page)).not.toHaveLength(0);

        const before = await readShell(page);
        expect(before.hasChart).toBe(true);

        await pageBack(page);
        await page.waitForFunction(() => (window as any).__pendingSpan() === 1);

        // In flight: the previous month's chart is still up, dimmed and
        // overlaid, rather than replaced by an empty frame. Not compared
        // against `before` for height: picking a span also drops whatever
        // bucket the panel below the chart was describing, which is its own,
        // unrelated height change that lands the moment the pill is pressed --
        // synchronously, before the request is even sent. What this fix owns
        // is that the height then holds steady across the request itself, so
        // that is what the two readouts below compare.
        const inFlightFirst = await readShell(page);
        expect(inFlightFirst.hasChart).toBe(true);
        expect(inFlightFirst.isLoading).toBe(true);
        expect(inFlightFirst.overlayText.length).toBeGreaterThan(0);

        await page.waitForTimeout(50);
        const inFlightLater = await readShell(page);
        expect(inFlightLater.bodyHeight).toBeCloseTo(inFlightFirst.bodyHeight, 0);

        await releaseSpan(page);
        await expect.poll(() => readShell(page)).toMatchObject({ isLoading: false });
        expect(await pendingSpan(page)).toBe(0);
    });
});
