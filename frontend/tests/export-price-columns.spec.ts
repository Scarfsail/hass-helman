import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * How the price strip turns the day payload's two rails into drawable columns.
 *
 * The strip is fed from the inspector day payload rather than the live forecast,
 * which is what lets it draw a day that has already elapsed; each rail arrives as
 * `{slot, value}` on the schedule's 15-minute grid, which can be finer than
 * either price's own resolution. An hourly export price then arrives as four
 * equal repeats and a fixed import window as a whole morning of them, and drawing
 * one rect per sample would give hairline seams and no room for a value label. So
 * consecutive equal values coalesce, and what is worth pinning is that this is
 * value-driven and per-rail: a price that genuinely moves inside the hour still
 * gets a column per change, and the two rails never borrow each other's cells.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

type Column = { startMinutes: number; endMinutes: number; value: number };
type Rails = { importColumns: Column[]; exportColumns: Column[]; unit: string };
type RailPoint = { slot: string; value: number };

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-price-strip"));
}

/**
 * Mount the strip with a day's price rails and return the columns it publishes,
 * which are the same ones it draws.
 */
async function railsFor(
    page: Page,
    rails: { importPrice?: RailPoint[]; exportPrice?: RailPoint[]; unit?: string },
): Promise<Rails> {
    return page.evaluate(async ({ mounted, day }) => {
        const el = document.createElement("helman-solar-price-strip") as any;
        let seen: Rails = { importColumns: [], exportColumns: [], unit: "" };
        el.addEventListener("price-columns", (event: Event) => {
            seen = (event as CustomEvent).detail;
        });
        el.timeZone = "UTC";
        el.date = day;
        el.importPrice = mounted.importPrice ?? [];
        el.exportPrice = mounted.exportPrice ?? [];
        el.unit = mounted.unit ?? "CZK/kWh";
        document.body.appendChild(el);
        await el.updateComplete;
        return seen;
    }, { mounted: rails, day: DAY });
}

/** Rail points every `stepMinutes` across the leading hours, one value per hour. */
function hourlyPoints(values: number[], stepMinutes: number): RailPoint[] {
    const points: RailPoint[] = [];
    values.forEach((value, hour) => {
        for (let m = 0; m < 60; m += stepMinutes) {
            const hh = String(hour).padStart(2, "0");
            const mm = String(m).padStart(2, "0");
            points.push({ slot: `${hh}:${mm}`, value });
        }
    });
    return points;
}

test.describe("price columns", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("an hourly price on a 15-minute grid draws as one column per hour", async ({ page }) => {
        const rails = await railsFor(page, { exportPrice: hourlyPoints([2, 5, 3], 15) });

        // Not twelve quarter-hour slivers -- three hours, the last one running to
        // the end of the day because nothing follows it.
        expect(rails.exportColumns).toEqual([
            { startMinutes: 0, endMinutes: 60, value: 2 },
            { startMinutes: 60, endMinutes: 120, value: 5 },
            { startMinutes: 120, endMinutes: 1440, value: 3 },
        ]);
    });

    test("a price that holds across the hour is one column, not one per hour", async ({ page }) => {
        // Coalescing is driven by the value, not by the clock: an unchanged price
        // over two hours is one cell, which is also how it reads on the strip.
        const rails = await railsFor(page, { exportPrice: hourlyPoints([4, 4], 60) });

        expect(rails.exportColumns).toEqual([{ startMinutes: 0, endMinutes: 1440, value: 4 }]);
    });

    test("a price that moves inside the hour keeps a column per change", async ({ page }) => {
        const rails = await railsFor(page, {
            exportPrice: [
                { slot: "00:00", value: 3 },
                { slot: "00:15", value: 3 },
                { slot: "00:30", value: 7 },
                { slot: "00:45", value: 3 },
            ],
        });

        expect(rails.exportColumns).toEqual([
            { startMinutes: 0, endMinutes: 30, value: 3 },
            { startMinutes: 30, endMinutes: 45, value: 7 },
            { startMinutes: 45, endMinutes: 1440, value: 3 },
        ]);
    });

    test("the two rails coalesce independently of each other", async ({ page }) => {
        // The whole reason both rails are published rather than one merged series:
        // a window-shaped import rate holds for hours while a spot export price
        // moves inside them, and neither may be forced onto the other's grid.
        const rails = await railsFor(page, {
            importPrice: [
                { slot: "00:00", value: 6 },
                { slot: "00:15", value: 6 },
                { slot: "00:30", value: 6 },
                { slot: "00:45", value: 6 },
            ],
            exportPrice: [
                { slot: "00:00", value: 1 },
                { slot: "00:15", value: 1 },
                { slot: "00:30", value: 2 },
                { slot: "00:45", value: 2 },
            ],
        });

        expect(rails.importColumns).toEqual([
            { startMinutes: 0, endMinutes: 1440, value: 6 },
        ]);
        expect(rails.exportColumns).toEqual([
            { startMinutes: 0, endMinutes: 30, value: 1 },
            { startMinutes: 30, endMinutes: 1440, value: 2 },
        ]);
    });

    test("one rail alone still publishes, and the other comes back empty", async ({ page }) => {
        // A setup with no sell-price entity configured: the import rail draws and
        // nothing throws over the missing export side.
        const rails = await railsFor(page, {
            importPrice: [{ slot: "06:00", value: 5 }],
            unit: "CZK/kWh",
        });

        expect(rails.importColumns).toEqual([
            { startMinutes: 360, endMinutes: 1440, value: 5 },
        ]);
        expect(rails.exportColumns).toEqual([]);
        expect(rails.unit).toBe("CZK/kWh");
    });

    test("malformed slot labels are left out", async ({ page }) => {
        const rails = await railsFor(page, {
            exportPrice: [
                { slot: "not-a-slot", value: 9 } as unknown as RailPoint,
                { slot: "06:00", value: 1 },
                { slot: "25:00", value: 9 },
            ],
        });

        expect(rails.exportColumns).toEqual([{ startMinutes: 360, endMinutes: 1440, value: 1 }]);
    });
});
