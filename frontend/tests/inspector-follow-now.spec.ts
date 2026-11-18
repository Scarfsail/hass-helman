import { test, expect, type Page } from "@playwright/test";

import {
    TODAY,
    TOMORROW,
    mountInspector,
    mouseDrag,
    pressPill,
    readView,
    solarHours,
} from "./support/pan-inspector";

/**
 * Today's day view following the clock, with "solar hours only" on.
 *
 * Today opens an hour before the current hour, never before sunrise, at the
 * width of its sun hours, and moves on the hour by itself -- into the night and
 * tomorrow's morning once the sun is down. A drag stops it, today's pill starts
 * it again, and at midnight a following view moves to the new day.
 *
 * The fixture's today has sun from 08:00 to 16:00 and tomorrow from 06:00 to
 * 18:00 (see `support/pan-inspector`).
 */

const SUN_WIDTH = (solarHours(0).end - solarHours(0).start) * 60;

/** Move the page's clock and let the card's clock tick, as a return to the tab does. */
async function setClock(page: Page, iso: string): Promise<void> {
    await page.clock.setFixedTime(new Date(iso));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

function requestedDates(page: Page): Promise<string[]> {
    return page.evaluate(() => [...(window as any).__requestedDates]);
}

test.describe("the inspector's today view follows now", () => {
    test("today opens an hour before the current hour at the sun-hours width, and moves on the hour", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T12:20:00.000Z` });
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: 660, end: 660 + SUN_WIDTH, overlayDate: null });

        // Still the 12:00 hour: nothing moves.
        await setClock(page, `${TODAY}T12:55:00.000Z`);
        await page.waitForTimeout(100);
        expect(await readView(page)).toMatchObject({ start: 660 });

        await setClock(page, `${TODAY}T13:05:00.000Z`);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 720, end: 720 + SUN_WIDTH });
    });

    test("before sunrise today opens at its own sun hours", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T05:30:00.000Z` });
        expect(await readView(page)).toMatchObject({ start: solarHours(0).start * 60, end: solarHours(0).end * 60 });
    });

    test("a silent refresh keeps following", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T12:20:00.000Z` });
        await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)._refreshActiveView(true));
        await setClock(page, `${TODAY}T14:10:00.000Z`);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 780, end: 780 + SUN_WIDTH });
    });

    test("a drag stops the following and today's pill starts it again", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T12:20:00.000Z` });
        // A fifth of the plot earlier.
        await mouseDrag(page, 0.2);
        await expect.poll(() => readView(page).then((view) => view.start)).toBeLessThan(660);
        const dragged = await readView(page);

        await setClock(page, `${TODAY}T14:10:00.000Z`);
        await page.waitForTimeout(100);
        expect(await readView(page)).toMatchObject({ start: dragged.start, end: dragged.end });

        await pressPill(page, TODAY);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 780, end: 780 + SUN_WIDTH });
    });

    test("tomorrow's pill opens at tomorrow's sun hours", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T12:20:00.000Z` });
        await pressPill(page, TOMORROW);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TOMORROW, start: solarHours(1).start * 60, end: solarHours(1).end * 60, overlayDate: null,
        });
    });

    test("after sunset the window runs into the night with tomorrow drawn beside today, with no drag", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T19:30:00.000Z` });
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TODAY, start: 1080, end: 1080 + SUN_WIDTH, overlayDate: TOMORROW,
        });
        expect(await requestedDates(page)).toContain(TOMORROW);
    });

    test("with no tomorrow to show, the window stops at 24:00", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T19:30:00.000Z`, lastDay: TODAY });
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: 1440 - SUN_WIDTH, end: 1440, overlayDate: null });
        expect(await requestedDates(page)).not.toContain(TOMORROW);
    });

    test("at midnight a following view moves to the new day", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T23:30:00.000Z` });
        await setClock(page, `${TOMORROW}T00:10:00.000Z`);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TOMORROW, start: solarHours(1).start * 60, end: solarHours(1).end * 60, overlayDate: null,
        });
    });

    test("at midnight a following view moves to the new day when a hass update sees it before the clock", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T23:30:00.000Z` });
        // Past midnight, but no tick yet: the live hass object is replaced first,
        // as Home Assistant does every few seconds.
        await page.clock.setFixedTime(new Date(`${TOMORROW}T00:00:05.000Z`));
        await page.evaluate(() => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            inspector.hass = { ...inspector.hass };
        });
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TOMORROW, start: solarHours(1).start * 60, end: solarHours(1).end * 60, overlayDate: null,
        });
    });

    test("at midnight a dragged view stays on its day", async ({ page }) => {
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T12:20:00.000Z` });
        await mouseDrag(page, 0.2);
        await expect.poll(() => readView(page).then((view) => view.start)).toBeLessThan(660);
        const dragged = await readView(page);

        await setClock(page, `${TOMORROW}T00:10:00.000Z`);
        await page.waitForTimeout(200);
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: dragged.start, end: dragged.end });
    });

    test("with daylight-only off, today is the whole day and does not move", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false, nowIso: `${TODAY}T12:20:00.000Z` });
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: 0, end: 1440 });
        await setClock(page, `${TODAY}T15:10:00.000Z`);
        await page.waitForTimeout(100);
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: 0, end: 1440 });
    });
});
