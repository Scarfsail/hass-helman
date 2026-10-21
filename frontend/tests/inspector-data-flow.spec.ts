import { test, expect, type Page } from "@playwright/test";
import { installFakeHass } from "./support/mock-hass";
import { CARD_BUNDLE } from "./support/card-page";
import { STOP_MONTH_VIEW, STOP_YEAR_VIEW, clickStop } from "./support/inspector-aggregate-harness";
import { FIXED_NOW_ISO, FIXED_TODAY } from "./support/fixed-clock";
import { forecastPayload, scheduleSlots } from "./support/payload-builders";

/**
 * What the inspector owns and hands down, rather than hears about from below.
 *
 * The forecast behind the health banner used to arrive as an event from the day
 * pills, so it was only re-read while the pills were mounted -- and they are not
 * at D (collapsed) or M. The inspector reads it itself now, whichever view is on
 * screen. And the chart's popup is the shared hover controller's, so a touch
 * screen gets its tap-to-toggle rather than a popup that a tap opens and nothing
 * but a scroll closes.
 */

const STALE = { generatedAt: null, isStale: true, reason: "stale_forecast", hint: null };

/**
 * Mount the bare inspector against the fake backend, its forecast answer swappable.
 * `timeZone` is the hass config's zone (the day payload always says UTC).
 */
async function mountInspector(
    page: Page,
    options: { timeZone?: string } = {},
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installFakeHass(page, { pillDays: 4 });
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await expect.poll(() => page.evaluate(
        () => !!customElements.get("helman-solar-inspector"),
    )).toBe(true);

    const healthy = forecastPayload();
    const stale = {
        ...healthy,
        solar: { ...healthy.solar, staleness: STALE },
        house_consumption: { ...healthy.house_consumption, staleness: STALE },
    };
    // The forecast is only read once the schedule has slots to draw it against.
    const schedule = scheduleSlots({ slotMinutes: 60, start: `${FIXED_TODAY}T00:00:00.000Z`, count: 48 });
    await page.evaluate(({ healthy, stale, schedule, timeZone }) => {
        (window as any).__forecastReply = healthy;
        (window as any).__staleForecast = stale;
        window.__setMockReply(window.__fakeHass as any, "helman/get_forecast",
            () => (window as any).__forecastReply);
        // A fresh document per read, as the backend sends: a re-read is a new
        // schedule to whoever compares it by identity.
        window.__setMockReply(window.__fakeHass as any, "helman/get_schedule",
            () => structuredClone(schedule));

        const el = document.createElement("helman-solar-inspector") as unknown as HTMLElement &
            Record<string, unknown>;
        if (timeZone) (window.__fakeHass as any).config = { ...(window.__fakeHass as any).config, time_zone: timeZone };
        el.hass = window.__fakeHass;
        document.body.appendChild(el);
    }, { healthy, stale, schedule, timeZone: options.timeZone ?? null });

    await expect.poll(() => page.evaluate(() => window.__pendingInspector())).toBe(1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => page.evaluate(() => !!document
        .querySelector("helman-solar-inspector")?.shadowRoot?.querySelector(".chart-wrap svg")))
        .toBe(true);
}

/** The banner's rendered text, empty while it draws nothing. */
function bannerText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const banner = document.querySelector("helman-solar-inspector")?.shadowRoot
            ?.querySelector("helman-forecast-health-banner");
        return (banner?.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim();
    });
}

test.describe("the forecast-health banner", () => {
    for (const [name, stop] of [["month (D)", STOP_MONTH_VIEW], ["year (M)", STOP_YEAR_VIEW]] as const) {
        test(`a forecast that goes stale while the ${name} view is up raises it there`, async ({ page }) => {
            await mountInspector(page);
            await expect.poll(() => page.evaluate(() =>
                window.__mockRequests.some((request) => request.type === "helman/get_forecast"))).toBe(true);
            expect(await bannerText(page)).toBe("");

            await clickStop(page, stop);
            await expect.poll(() => page.evaluate(() => !!document
                .querySelector("helman-solar-inspector")?.shadowRoot
                ?.querySelector("helman-solar-aggregate-chart"))).toBe(true);
            // The view the reader is on draws no day pills.
            expect(await page.evaluate(() => !!document
                .querySelector("helman-solar-inspector")?.shadowRoot
                ?.querySelector("helman-solar-day-pills"))).toBe(false);

            // The backend re-plans, and the forecast it now serves has gone
            // stale. Past the loader's burst window, so the re-read is real.
            await page.evaluate(() => {
                (window as any).__forecastReply = (window as any).__staleForecast;
            });
            await page.clock.setFixedTime(new Date(Date.parse(FIXED_NOW_ISO) + 10_000));
            await page.evaluate(() => window.__fireDataChanged("plan"));

            await expect.poll(() => bannerText(page)).toContain("Solar forecast");
        });
    }
});

test.describe("the schedule the day pills draw", () => {
    test("is normalized in the payload's zone once the payload names one other than hass's", async ({ page }) => {
        await mountInspector(page, { timeZone: "America/New_York" });
        // The owner's normalized model is cached on its arguments, so the pills
        // hold the UTC one exactly when the inspector last asked for UTC.
        await expect.poll(() => page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const pills = el.shadowRoot.querySelector("helman-solar-day-pills") as any;
            return pills.timeZone === "UTC"
                && pills.normalizedSchedule === el._scheduleOwner.getNormalized("UTC", "en");
        })).toBe(true);
    });

});

test.describe("the day chart on a touch screen", () => {
    test.use({ hasTouch: true });

    /** The viewport point over the main chart at `minutes` of the day, mid-height. */
    function chartPoint(page: Page, minutes: number): Promise<{ x: number; y: number }> {
        return page.evaluate((at) => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const svg = el.shadowRoot.querySelector(".chart-wrap svg") as SVGSVGElement;
            const rect = svg.getBoundingClientRect();
            const layout = el._layout;
            const span = layout.dayEndMinutes - layout.dayStartMinutes;
            const svgX = layout.margin.left + ((at - layout.dayStartMinutes) / span) * layout.plotWidth;
            return { x: rect.left + (svgX / layout.width) * rect.width, y: rect.top + rect.height / 2 };
        }, minutes);
    }

    function popupTitle(page: Page): Promise<string | null> {
        return page.evaluate(() => document.querySelector("helman-solar-inspector")?.shadowRoot
            ?.querySelector(".hover-tooltip .hover-tooltip-title")?.textContent?.trim() ?? null);
    }

    test("a tap opens the popup, a second tap on the slot or one outside closes it", async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await mountInspector(page);
        const noon = await chartPoint(page, 12 * 60 + 10);

        await page.touchscreen.tap(noon.x, noon.y);
        await expect.poll(() => popupTitle(page)).not.toBeNull();

        await page.touchscreen.tap(noon.x, noon.y);
        await expect.poll(() => popupTitle(page)).toBeNull();

        await page.touchscreen.tap(noon.x, noon.y);
        await expect.poll(() => popupTitle(page)).not.toBeNull();
        // Outside the card altogether: the page margin beside it.
        await page.touchscreen.tap(2, noon.y);
        await expect.poll(() => popupTitle(page)).toBeNull();
    });

    test("the tap that closes the popup takes the hover band with it", async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await mountInspector(page);
        const noon = await chartPoint(page, 12 * 60 + 10);
        const hovered = () => page.evaluate(() =>
            (document.querySelector("helman-solar-inspector") as any)._hoveredMinutes);

        await page.touchscreen.tap(noon.x, noon.y);
        await expect.poll(() => popupTitle(page)).not.toBeNull();
        await expect.poll(hovered).not.toBeNull();

        await page.touchscreen.tap(noon.x, noon.y);
        await expect.poll(() => popupTitle(page)).toBeNull();
        await expect.poll(hovered).toBeNull();
    });

    test("a refresh that replaces the day closes the popup describing the old one", async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await mountInspector(page);
        const noon = await chartPoint(page, 12 * 60 + 10);

        await page.touchscreen.tap(noon.x, noon.y);
        await expect.poll(() => popupTitle(page)).not.toBeNull();

        const before = await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)._payload);
        await page.evaluate(() => window.__fireDataChanged("plan"));
        await expect.poll(() => page.evaluate(() => window.__pendingInspector())).toBe(1);
        await page.evaluate(() => window.__releaseInspector());
        await expect.poll(() => page.evaluate((old) =>
            (document.querySelector("helman-solar-inspector") as any)._payload !== null
            && JSON.stringify((document.querySelector("helman-solar-inspector") as any)._payload) === JSON.stringify(old),
        before)).toBe(true);
        await expect.poll(() => popupTitle(page)).toBeNull();
    });
});
