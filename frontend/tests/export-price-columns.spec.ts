import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * How the price strip turns the day payload's two rails into drawable columns.
 *
 * The strip is fed from the inspector day payload rather than the live forecast,
 * which is what lets it draw a day that has already elapsed. Each rail arrives as
 * `{slot, value}` on the schedule's 15-minute grid, and both are bucketed onto
 * the inspector's *current* slot grid so that one cell holds one bar per rail,
 * import on its left half and export on its right.
 *
 * That shared grid is the property worth pinning. Coalescing equal neighbours
 * into natural cells was tried first and is what these tests exist to prevent
 * coming back: it gives each rail its own boundaries, so a window-shaped import
 * rate becomes one cell hours wide while a spot export price stays hourly, and
 * the strip draws a wide backdrop with unrelated bars across it instead of a
 * pair per slot.
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
    rails: {
        importPrice?: RailPoint[];
        exportPrice?: RailPoint[];
        unit?: string;
        slotMinutes?: number;
    },
): Promise<Rails> {
    return page.evaluate(async ({ mounted, day }) => {
        const el = document.createElement("helman-solar-price-strip") as any;
        let seen: Rails = { importColumns: [], exportColumns: [], unit: "" };
        el.addEventListener("price-columns", (event: Event) => {
            seen = (event as CustomEvent).detail;
        });
        el.timeZone = "UTC";
        el.date = day;
        el.slotMinutes = mounted.slotMinutes ?? 15;
        el.importPrice = mounted.importPrice ?? [];
        el.exportPrice = mounted.exportPrice ?? [];
        el.unit = mounted.unit ?? "CZK/kWh";
        document.body.appendChild(el);
        await el.updateComplete;
        return seen;
    }, { mounted: rails, day: DAY });
}

/** Rail points every 15 minutes across the leading hours, one value per hour. */
function hourlyPoints(values: number[]): RailPoint[] {
    const points: RailPoint[] = [];
    values.forEach((value, hour) => {
        for (let m = 0; m < 60; m += 15) {
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

    test("both rails land on identical cells, whatever their own resolutions", async ({ page }) => {
        // The regression this file exists for. A fixed import window holding all
        // morning and a spot export price moving every quarter-hour must still
        // produce cell-for-cell matching columns, because each cell is split in
        // half to hold one bar from each rail.
        const rails = await railsFor(page, {
            importPrice: [
                { slot: "00:00", value: 6 },
                { slot: "00:15", value: 6 },
                { slot: "00:30", value: 6 },
                { slot: "00:45", value: 6 },
            ],
            exportPrice: [
                { slot: "00:00", value: 1 },
                { slot: "00:15", value: 4 },
                { slot: "00:30", value: 2 },
                { slot: "00:45", value: 9 },
            ],
        });

        const spans = (columns: Column[]) =>
            columns.map((column) => [column.startMinutes, column.endMinutes]);
        expect(spans(rails.importColumns)).toEqual(spans(rails.exportColumns));
        expect(rails.importColumns.map((column) => column.value)).toEqual([6, 6, 6, 6]);
        expect(rails.exportColumns.map((column) => column.value)).toEqual([1, 4, 2, 9]);
    });

    test("an unchanging price is one cell per slot, not one merged column", async ({ page }) => {
        // The old value-driven coalescing collapsed this to a single column
        // running to the end of the day; on the shared grid it stays four cells.
        const rails = await railsFor(page, { exportPrice: hourlyPoints([4]) });

        expect(rails.exportColumns).toEqual([
            { startMinutes: 0, endMinutes: 15, value: 4 },
            { startMinutes: 15, endMinutes: 30, value: 4 },
            { startMinutes: 30, endMinutes: 45, value: 4 },
            { startMinutes: 45, endMinutes: 60, value: 4 },
        ]);
    });

    test("a wider slot width groups the day into fewer, wider cells", async ({ page }) => {
        // Density is the slot-size control's business: the same three hours that
        // draw as twelve pairs at 15 minutes draw as three at 60.
        const rails = await railsFor(page, {
            exportPrice: hourlyPoints([2, 5, 3]),
            slotMinutes: 60,
        });

        expect(rails.exportColumns).toEqual([
            { startMinutes: 0, endMinutes: 60, value: 2 },
            { startMinutes: 60, endMinutes: 120, value: 5 },
            { startMinutes: 120, endMinutes: 180, value: 3 },
        ]);
    });

    test("samples sharing a grouped cell average, because a price is a rate", async ({ page }) => {
        // Summing would be wrong here in a way that matters for P2: four
        // quarter-hours at 2 CZK/kWh is an hour at 2, not an hour at 8.
        const rails = await railsFor(page, {
            exportPrice: [
                { slot: "00:00", value: 1 },
                { slot: "00:15", value: 2 },
                { slot: "00:30", value: 3 },
                { slot: "00:45", value: 6 },
            ],
            slotMinutes: 60,
        });

        expect(rails.exportColumns).toEqual([{ startMinutes: 0, endMinutes: 60, value: 3 }]);
    });

    test("the last cell of the day is clamped to midnight", async ({ page }) => {
        const rails = await railsFor(page, {
            exportPrice: [{ slot: "23:45", value: 5 }],
        });

        expect(rails.exportColumns).toEqual([
            { startMinutes: 1425, endMinutes: 1440, value: 5 },
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
            { startMinutes: 360, endMinutes: 375, value: 5 },
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

        expect(rails.exportColumns).toEqual([
            { startMinutes: 360, endMinutes: 375, value: 1 },
        ]);
    });

    test("changing the slot width republishes the columns", async ({ page }) => {
        // The inspector's selected-slot panel reads these, so a regroup that did
        // not re-emit would leave it quoting cells the strip no longer draws.
        const widths = await page.evaluate(async (day) => {
            const el = document.createElement("helman-solar-price-strip") as any;
            const seen: number[] = [];
            el.addEventListener("price-columns", (event: Event) => {
                seen.push((event as CustomEvent).detail.exportColumns.length);
            });
            el.timeZone = "UTC";
            el.date = day;
            el.slotMinutes = 15;
            el.exportPrice = [
                { slot: "00:00", value: 1 },
                { slot: "00:15", value: 2 },
                { slot: "00:30", value: 3 },
                { slot: "00:45", value: 4 },
            ];
            el.unit = "CZK/kWh";
            document.body.appendChild(el);
            await el.updateComplete;
            el.slotMinutes = 60;
            await el.updateComplete;
            return seen;
        }, DAY);

        expect(widths.at(0)).toBe(4);
        expect(widths.at(-1)).toBe(1);
    });
});
