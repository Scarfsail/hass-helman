import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * How the export-price strip turns forecast points into drawable columns.
 *
 * The strip no longer fetches its own hourly payload -- it is handed the one the
 * day pills already loaded, at the schedule's granularity, which can be finer
 * than the price's own resolution. An hourly price then arrives as four equal
 * 15-minute repeats, and drawing one rect per point would give four hairline
 * seams and no room for a value label. So consecutive equal values coalesce, and
 * what is worth pinning is that this is value-driven: a price that genuinely
 * moves inside the hour still gets a column per change.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

type Column = { startMinutes: number; endMinutes: number; value: number };

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() =>
        !!customElements.get("helman-solar-export-price-strip"),
    );
}

/**
 * Mount the strip with a day of export-price points and return the columns it
 * publishes, which are the same ones it draws.
 */
async function columnsFor(
    page: Page,
    points: Array<{ timestamp: string; value: number }>,
): Promise<Column[]> {
    return page.evaluate(async ({ mounted, day }) => {
        const el = document.createElement("helman-solar-export-price-strip") as any;
        const seen: Column[] = [];
        el.addEventListener("price-columns", (event: Event) => {
            seen.length = 0;
            seen.push(...(event as CustomEvent).detail.columns);
        });
        el.timeZone = "UTC";
        el.date = day;
        el.forecast = {
            grid: { exportPriceUnit: "CZK/kWh", exportPricePoints: mounted },
        };
        document.body.appendChild(el);
        await el.updateComplete;
        return seen;
    }, { mounted: points, day: DAY });
}

/** Points every `stepMinutes` across `hours`, each hour holding one value. */
function hourlyPoints(values: number[], stepMinutes: number) {
    const points: Array<{ timestamp: string; value: number }> = [];
    values.forEach((value, hour) => {
        for (let m = 0; m < 60; m += stepMinutes) {
            const hh = String(hour).padStart(2, "0");
            const mm = String(m).padStart(2, "0");
            points.push({ timestamp: `${DAY}T${hh}:${mm}:00Z`, value });
        }
    });
    return points;
}

test.describe("export price columns", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("an hourly price on a 15-minute grid draws as one column per hour", async ({ page }) => {
        const columns = await columnsFor(page, hourlyPoints([2, 5, 3], 15));

        // Not twelve quarter-hour slivers -- three hours, the last one running to
        // the end of the day because nothing follows it.
        expect(columns).toEqual([
            { startMinutes: 0, endMinutes: 60, value: 2 },
            { startMinutes: 60, endMinutes: 120, value: 5 },
            { startMinutes: 120, endMinutes: 1440, value: 3 },
        ]);
    });

    test("a price that holds across the hour is one column, not one per hour", async ({ page }) => {
        // Coalescing is driven by the value, not by the clock: an unchanged price
        // over two hours is one cell, which is also how it reads on the strip.
        const columns = await columnsFor(page, hourlyPoints([4, 4], 60));

        expect(columns).toEqual([{ startMinutes: 0, endMinutes: 1440, value: 4 }]);
    });

    test("a price that moves inside the hour keeps a column per change", async ({ page }) => {
        const columns = await columnsFor(page, [
            { timestamp: `${DAY}T00:00:00Z`, value: 3 },
            { timestamp: `${DAY}T00:15:00Z`, value: 3 },
            { timestamp: `${DAY}T00:30:00Z`, value: 7 },
            { timestamp: `${DAY}T00:45:00Z`, value: 3 },
        ]);

        expect(columns).toEqual([
            { startMinutes: 0, endMinutes: 30, value: 3 },
            { startMinutes: 30, endMinutes: 45, value: 7 },
            { startMinutes: 45, endMinutes: 1440, value: 3 },
        ]);
    });

    test("points from other days are left out", async ({ page }) => {
        const columns = await columnsFor(page, [
            { timestamp: "2026-07-17T23:00:00Z", value: 9 },
            { timestamp: `${DAY}T06:00:00Z`, value: 1 },
            { timestamp: "2026-07-19T01:00:00Z", value: 9 },
        ]);

        expect(columns).toEqual([{ startMinutes: 360, endMinutes: 1440, value: 1 }]);
    });
});
