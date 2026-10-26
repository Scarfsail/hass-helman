import { expect, test, type Page } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";

/**
 * `helman-day-line-chart` as the Forecast sections draw it: the actual series
 * solid, a planned one dashed, the now marker a labelled vertical line, and a
 * step series held across each bucket.
 */

const START = Date.parse("2026-10-21T00:00:00Z");
const HOUR = 3_600_000;

async function mountChart(page: Page, props: Record<string, unknown>): Promise<void> {
    await page.setContent("<div id='mount' style='width:600px'></div>");
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-day-line-chart"));
    await page.evaluate((props) => {
        const chart = document.createElement("helman-day-line-chart") as any;
        Object.assign(chart, { bucketMs: 900_000, timeZone: "UTC", locale: "en-GB", ...props });
        document.getElementById("mount")!.append(chart);
    }, { start: START, end: START + 36 * HOUR, ...props });
}

const points = (from: number, to: number, value: (t: number) => number) =>
    Array.from({ length: (to - from) / 900_000 + 1 }, (_, i) => ({ t: from + i * 900_000, v: value(from + i * 900_000) }));

test("a planned series is dashed, the actual one solid, and the legend says which is which", async ({ page }) => {
    await mountChart(page, {
        series: [
            { key: "actual", label: "actual", color: "rgb(0, 128, 0)", points: points(START, START + 12 * HOUR, () => 40) },
            { key: "planned", label: "planned", color: "rgb(0, 128, 0)", dashed: true, points: points(START + 12 * HOUR, START + 30 * HOUR, () => 60) },
        ],
        now: START + 12 * HOUR,
        nowLabel: "now",
    });
    const chart = page.locator("helman-day-line-chart");
    const actual = chart.locator('path[data-series="actual"]');
    const planned = chart.locator('path[data-series="planned"]');
    await expect(actual).toHaveCSS("stroke-dasharray", "none");
    await expect(planned).toHaveCSS("stroke-dasharray", "6px, 4px");
    await expect(chart.locator(".legend-swatch.dashed")).toHaveCount(1);
    await expect(chart.locator(".legend")).toContainText("actual");
    await expect(chart.locator(".legend")).toContainText("planned");
});

test("the now marker is a vertical line at now, labelled on the time axis in place of a nearby hour", async ({ page }) => {
    await mountChart(page, {
        series: [{ key: "planned", label: "planned", color: "red", dashed: true, points: points(START, START + 36 * HOUR, () => 1) }],
        now: START + 12 * HOUR,
        nowLabel: "now",
    });
    const chart = page.locator("helman-day-line-chart");
    const marker = chart.locator("[data-now] line");
    await expect(marker).toHaveCount(1);
    const geometry = await marker.evaluate((line) => ({
        x1: Number(line.getAttribute("x1")), x2: Number(line.getAttribute("x2")),
        y1: Number(line.getAttribute("y1")), y2: Number(line.getAttribute("y2")),
    }));
    expect(geometry.x1).toBe(geometry.x2);
    expect(geometry.y2).toBeGreaterThan(geometry.y1);
    // 12 of 36 hours across the plot between its 54 px and 12 px paddings.
    expect(geometry.x1).toBeCloseTo(54 + (600 - 66) / 3, 0);
    await expect(chart.locator(".now-label")).toHaveText("now");
    // Today's 12 sits under "now", so it is left out; tomorrow noon stays.
    await expect(chart.locator(".axis-label[text-anchor=middle]")).toHaveText(["00", "06", "18", "00", "06", "12"]);
});

test("no now marker while now is outside the window", async ({ page }) => {
    await mountChart(page, {
        series: [{ key: "planned", label: "planned", color: "red", points: points(START, START + 2 * HOUR, () => 1) }],
        now: START + 40 * HOUR,
    });
    await expect(page.locator("helman-day-line-chart path.line")).toHaveCount(1);
    await expect(page.locator("helman-day-line-chart [data-now]")).toHaveCount(0);
});

test("a step series holds each value to the end of its bucket", async ({ page }) => {
    await mountChart(page, {
        series: [{ key: "price", label: "price", color: "red", points: [{ t: START, v: 1 }, { t: START + 900_000, v: 2 }] }],
        step: true,
    });
    const d = await page.locator("helman-day-line-chart path.line").getAttribute("d");
    // Across the first bucket, up at its end, across the second.
    expect(d).toMatch(/^M[\d.]+,[\d.]+H[\d.]+V[\d.]+H[\d.]+$/);
});
