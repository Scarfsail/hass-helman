import { test, expect, type Locator, type Page } from "@playwright/test";
import type { TodayGaugeDTO } from "../cards/helman-api";
import { loadBundle } from "./support/card-page";

/** Today's solar day gauge as a tile in the inspector's daily totals, absent on any other day. */

/** A foggy morning: 2.0 of 4.9 kWh so far, Helman's rest 7.6 kWh, likely 4.6–5.6 kWh. */
const FOGGY: TodayGaugeDTO = {
    at: "2026-11-10T10:00:00+00:00",
    rawSoFarWh: 5400,
    correctedSoFarWh: 4900,
    actualSoFarWh: 2000,
    rawRestWh: 14000,
    finalRestWh: 7600,
    trust: 0.664,
    likelyLowWh: 4600,
    likelyHighWh: 5640,
    direction: "lower",
};

async function mountInspector(page: Page, todayGauge: TodayGaugeDTO | null, language = "en"): Promise<void> {
    await loadBundle(page, "helman-solar-inspector");
    await page.evaluate(({ todayGauge, language }) => {
        const payload = window.__inspectorDay({
            date: "2026-11-10",
            status: "applied",
            effectiveVariant: "adjusted",
            range: { minDate: "2026-11-10", maxDate: "2026-11-10", isToday: todayGauge !== null },
            series: { corrected: [{ slot: "10:00", valueWh: 100 }] },
            totals: { rawWh: 100, correctedWh: 100, actualWh: 50 },
            availability: { hasProfile: true },
            todayGauge,
        });
        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.hass = {
            language,
            locale: { language },
            config: { time_zone: "UTC" },
            connection: {},
            callWS: window.__mockHass({
                "helman/solar_bias/inspector": async (msg: { date: string }) => ({ ...payload, date: msg.date }),
            }).callWS,
        };
        document.body.appendChild(el);
    }, { todayGauge, language });
    await page.waitForFunction(() =>
        !!(document.querySelector("helman-solar-inspector") as any)?.shadowRoot?.querySelector(".metric-card"));
}

const tile = (page: Page) => page.locator("helman-solar-inspector [data-today-gauge]");

test("today's totals show the solar day gauge with its trust and labels", async ({ page }) => {
    await mountInspector(page, FOGGY);
    await expect(tile(page).locator(".metric-label")).toHaveText("Today's forecast");
    const gauge = tile(page).locator("helman-solar-day-gauge");
    await expect(gauge.locator("[data-chip]")).toHaveText(/^Remaining 4\.6–5\.6 kWh · trust 66 %↓/);
    await expect(gauge.locator("[data-chip] [data-direction=lower]")).toHaveCount(1);
    await expect(gauge.locator("[data-label=raw-so-far]")).toHaveText("5.4");
    await expect(gauge.locator("[data-label=raw-rest]")).toHaveText("14.0");
    await expect(gauge.locator("[data-label=so-far]")).toHaveText(/^2\.0\s+of 4\.9 forecast so far\s+−59 %$/);
    await expect(gauge.locator("[data-label=final-rest]")).toHaveText("7.6");
    await expect(gauge.locator("[data-label=range]")).toHaveText(/^4\.6–5\.6\s+−33 %$/);
    await expect(gauge.locator("[data-short]")).toHaveCount(1);
    await expect(gauge.locator("[data-range].lower")).toHaveCount(1);
});

/** Late afternoon: 23.0 of 23.3 kWh so far, 1.6 kWh left, likely 1.4–1.9 kWh. */
const LATE: TodayGaugeDTO = {
    at: "2026-11-10T15:00:00+00:00",
    rawSoFarWh: 24000,
    correctedSoFarWh: 23300,
    actualSoFarWh: 23000,
    rawRestWh: 1700,
    finalRestWh: 1600,
    trust: 0.8,
    likelyLowWh: 1400,
    likelyHighWh: 1900,
    direction: null,
};

test("late in the day the rest still takes a quarter of the bar and the range box stays inside it", async ({ page }) => {
    await mountInspector(page, LATE);
    const gauge = tile(page).locator("helman-solar-day-gauge");
    const bar = (await gauge.locator(".bar").boundingBox())!;
    const soFar = (await gauge.locator(".lane .fill.so-far").boundingBox())!;
    const range = (await gauge.locator("[data-range]").boundingBox())!;
    expect(bar.x + bar.width - (soFar.x + soFar.width)).toBeGreaterThanOrEqual(bar.width * 0.25 - 0.5);
    expect(range.x).toBeGreaterThanOrEqual(bar.x - 0.5);
    expect(range.x + range.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
    const rawSoFar = (await gauge.locator("[data-label=raw-so-far]").boundingBox())!;
    const rawRest = (await gauge.locator("[data-label=raw-rest]").boundingBox())!;
    expect(rawSoFar.x + rawSoFar.width).toBeLessThanOrEqual(rawRest.x);
});

/** Early morning: the split clamps to a quarter, and the raw rest equals Helman's rest. */
const DAWN: TodayGaugeDTO = {
    at: "2026-11-10T07:30:00+00:00",
    rawSoFarWh: 600,
    correctedSoFarWh: 500,
    actualSoFarWh: 300,
    rawRestWh: 20000,
    finalRestWh: 20000,
    trust: 0.7,
    likelyLowWh: 18000,
    likelyHighWh: 22000,
    direction: null,
};

test("the end step only shows the raw rest against Helman's rest, not the day so far", async ({ page }) => {
    await mountInspector(page, DAWN);
    const gauge = tile(page).locator("helman-solar-day-gauge");
    const rawRest = (await gauge.locator(".lane .fill.rest").boundingBox())!;
    const finalRest = (await gauge.locator(".bar .fill.rest").boundingBox())!;
    // Raw rest = final rest: the end step is straight, though raw so far and produced differ.
    expect(Math.abs(rawRest.x + rawRest.width - (finalRest.x + finalRest.width))).toBeLessThan(0.5);
    // Produced (0.3) is below the so-far sums: both rests still start at the now boundary.
    expect(Math.abs(rawRest.x - finalRest.x)).toBeLessThan(0.5);
    const xs = await gauge.locator(".step-end").evaluate((el) =>
        el.getAttribute("points")!.trim().split(/\s+/).map((point) => Number(point.split(",")[0])));
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.01);
});

test("after sunset a production shortfall leaves the hatched rest empty, starting at now", async ({ page }) => {
    await mountInspector(page, { ...FOGGY, rawSoFarWh: 10000, correctedSoFarWh: 10000, actualSoFarWh: 5000,
        rawRestWh: 0, finalRestWh: 0, likelyLowWh: 0, likelyHighWh: 0 });
    const gauge = tile(page).locator("helman-solar-day-gauge");
    const bar = (await gauge.locator(".bar").boundingBox())!;
    const rest = (await gauge.locator(".bar .fill.rest").boundingBox())!;
    const soFar = (await gauge.locator(".lane .fill.so-far").boundingBox())!;
    expect(rest.width).toBeLessThan(0.5);
    expect(Math.abs(rest.x - (soFar.x + soFar.width))).toBeLessThan(0.5);
    expect(rest.x).toBeGreaterThan(bar.x + bar.width * 0.5);
});

test("a tiny rest late in the day keeps its label clear of the day so far", async ({ page }) => {
    await mountInspector(page, { ...LATE, rawRestWh: 250, finalRestWh: 200, likelyLowWh: 180, likelyHighWh: 230 });
    const gauge = tile(page).locator("helman-solar-day-gauge");
    const produced = (await gauge.locator(".bar .fill.produced").boundingBox())!;
    const label = (await gauge.locator("[data-label=final-rest]").boundingBox())!;
    const text = await gauge.locator("[data-label=final-rest]").evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().x;
    });
    expect(label.x).toBeGreaterThanOrEqual(produced.x + produced.width - 0.5);
    expect(text).toBeGreaterThanOrEqual(produced.x + produced.width - 0.5);
    const bar = (await gauge.locator(".bar").boundingBox())!;
    expect(label.x + label.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
});

/** The direction icon's mark and colour, and the range box's border colour. */
async function directionTones(gauge: Locator) {
    return gauge.evaluate((el) => {
        const root = el.shadowRoot!;
        const mark = root.querySelector("[data-direction]")!.shadowRoot!.querySelector(".mark")!;
        const range = root.querySelector("[data-range]")!;
        return { mark: mark.textContent, icon: getComputedStyle(mark).color, range: getComputedStyle(range).borderTopColor };
    });
}

test("the chip ends with a direction icon in the range box's tone, and a blue ? without a direction", async ({ page }) => {
    const bright: TodayGaugeDTO = {
        at: "2026-11-10T11:00:00+00:00", rawSoFarWh: 4000, correctedSoFarWh: 3600, actualSoFarWh: 4500,
        rawRestWh: 9500, finalRestWh: 9200, trust: 0.878, likelyLowWh: 9000, likelyHighWh: 11100, direction: "higher",
    };
    await mountInspector(page, bright);
    let gauge = tile(page).locator("helman-solar-day-gauge");
    await expect(gauge.locator("[data-chip]")).toHaveText(/^Remaining 9\.0–11\.1 kWh · trust 88 %↑/);
    await expect(gauge.locator("[data-chip] [data-direction=higher]")).toHaveCount(1);
    let tones = await directionTones(gauge);
    expect(tones.mark).toBe("↑");
    expect(tones.icon).toBe(tones.range);
    await gauge.locator("[data-over]").waitFor();

    await mountInspector(page, FOGGY);
    gauge = tile(page).locator("helman-solar-day-gauge");
    tones = await directionTones(gauge);
    expect(tones.mark).toBe("↓");
    expect(tones.icon).toBe(tones.range);

    await mountInspector(page, { ...FOGGY, direction: null });
    gauge = tile(page).locator("helman-solar-day-gauge");
    await expect(gauge.locator("[data-chip]")).toHaveText(/^Remaining 4\.6–5\.6 kWh · trust 66 %\?/);
    await expect(gauge.locator("[data-chip] [data-direction=none]")).toHaveCount(1);
    tones = await directionTones(gauge);
    expect(tones.mark).toBe("?");
    // The theme's info blue.
    await gauge.evaluate((el) => (el as HTMLElement).style.setProperty("--info-color", "rgb(3, 155, 229)"));
    expect((await directionTones(gauge)).icon).toBe("rgb(3, 155, 229)");
});

test("hovering the direction icon explains the rest of today with the range values", async ({ page }) => {
    await mountInspector(page, FOGGY);
    const icon = tile(page).locator("helman-solar-day-gauge [data-direction]");
    await expect(icon.locator("[role=tooltip]")).toBeHidden();
    await icon.locator("button").hover();
    const text = "Production so far is below Helman's corrected forecast and the live correction hasn't fully caught up, so the rest of today will likely come in lower: about 4.6–5.6 kWh instead of 7.6 kWh.";
    await expect(icon.locator("[role=tooltip]")).toBeVisible();
    await expect(icon.locator("[role=tooltip]")).toHaveText(text);
    await expect(icon.locator("button")).toHaveAttribute("aria-label", text);

    // A tap opens it too.
    await mountInspector(page, { ...FOGGY, direction: null });
    await tile(page).locator("helman-solar-day-gauge [data-direction] button").click();
    await expect(tile(page).locator("helman-solar-day-gauge [data-direction] [role=tooltip]")).toBeVisible();
    await expect(tile(page).locator("helman-solar-day-gauge [data-direction] [role=tooltip]")).toHaveText(
        "No clear direction: Helman's live correction has caught up with how today is going, so the rest of today could land either way, within 4.6–5.6 kWh around 7.6 kWh.");
});

test("hovering the gauge shows the time and the step values", async ({ page }) => {
    await mountInspector(page, FOGGY);
    const gauge = tile(page).locator("helman-solar-day-gauge");
    await gauge.locator("[data-gauge]").hover();
    const popup = gauge.locator(".hover-tooltip");
    await expect(popup.locator(".hover-tooltip-title")).toHaveText("At 10:00 AM");
    await expect(popup).toContainText("Raw so far");
    await expect(popup).toContainText("5.4 kWh");
    await expect(popup).toContainText("Helman's rest of today");
    await expect(popup).toContainText("4.6–5.6 kWh");
});

test("the gauge is a three-by-two tile on the right with the tiles in order to its left", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountInspector(page, FOGGY);
    const box = await tile(page).boundingBox();
    const cards = await page.locator("helman-solar-inspector .metric-grid > .metric-card:not([data-today-gauge])").evaluateAll(
        (nodes) => nodes.map((node) => node.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
    expect(cards.length).toBeGreaterThan(0);
    // Every regular tile sits left of the gauge, the first at the top-left.
    for (const card of cards) expect(card.right).toBeLessThanOrEqual(box!.x);
    expect(cards[0].y).toBeCloseTo(box!.y, 0);
    expect(cards[0].x).toBeLessThan(cards[1]?.x ?? Infinity);
    const grid = await page.locator("helman-solar-inspector .metric-grid").boundingBox();
    expect(box!.x + box!.width).toBeCloseTo(grid!.x + grid!.width, 0);
});

test("on a narrow screen the gauge spans the grid below the tiles", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await mountInspector(page, FOGGY);
    const box = await tile(page).boundingBox();
    const grid = await page.locator("helman-solar-inspector .metric-grid").boundingBox();
    expect(box!.width).toBeCloseTo(grid!.width, 0);
    const lastTile = await page.locator("helman-solar-inspector .metric-grid > .metric-card:not([data-today-gauge])").last().boundingBox();
    expect(box!.y).toBeGreaterThan(lastTile!.y);
});

test("the gauge speaks Czech", async ({ page }) => {
    await mountInspector(page, FOGGY, "cs");
    await expect(tile(page).locator(".metric-label")).toHaveText("Dnešní předpověď");
    await expect(tile(page).locator("helman-solar-day-gauge [data-chip]")).toHaveText(/^Zbývá 4\.6–5\.6 kWh · důvěra 66 %↓/);
    await expect(tile(page).locator("helman-solar-day-gauge [data-direction] [role=tooltip]")).toContainText("asi 4.6–5.6 kWh místo 7.6 kWh");
});

test("a day without a gauge shows no such tile", async ({ page }) => {
    await mountInspector(page, null);
    await expect(tile(page)).toHaveCount(0);
    await expect(page.locator("helman-solar-inspector .metric-grid.with-gauge")).toHaveCount(0);
});
