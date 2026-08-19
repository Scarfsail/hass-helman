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

/**
 * Mount the strip with geometry so it actually draws, and read back the rects
 * of the first cell in document order -- which is also paint order, so the
 * first entry is the bar drawn underneath.
 */
async function barsFor(
    page: Page,
    rails: { importPrice?: RailPoint[]; exportPrice?: RailPoint[] },
): Promise<{ fill: string; y: number; height: number; width: number }[]> {
    return page.evaluate(async ({ mounted, day }) => {
        const el = document.createElement("helman-solar-price-strip") as any;
        el.hass = { language: "en", localize: () => "", states: {} };
        el.timeZone = "UTC";
        el.date = day;
        el.slotMinutes = 60;
        el.geometry = { width: 1000, marginLeft: 0, plotWidth: 1000, startMinutes: 0, endMinutes: 60 };
        el.nowMs = Date.parse(`${day}T23:59:00Z`);
        el.importPrice = mounted.importPrice ?? [];
        el.exportPrice = mounted.exportPrice ?? [];
        el.unit = "CZK/kWh";
        document.body.appendChild(el);
        await el.updateComplete;
        return [...el.shadowRoot.querySelectorAll("rect")]
            .filter((r: any) => /--helman-(grid-|price-negative)/.test(r.style.fill || ""))
            .map((r: any) => ({
                fill: r.style.fill.includes("import")
                    ? "import"
                    : r.style.fill.includes("negative") ? "negative" : "export",
                y: Math.round(parseFloat(r.getAttribute("y"))),
                height: Math.round(parseFloat(r.getAttribute("height"))),
                width: Math.round(parseFloat(r.getAttribute("width"))),
            }));
    }, { mounted: rails, day: DAY });
}

/** The value labels the strip drew, in document order. */
async function labelsFor(
    page: Page,
    rails: { importPrice?: RailPoint[]; exportPrice?: RailPoint[] },
): Promise<string[]> {
    return page.evaluate(async ({ mounted, day }) => {
        const el = document.createElement("helman-solar-price-strip") as any;
        el.hass = { language: "en", localize: () => "", states: {} };
        el.timeZone = "UTC";
        el.date = day;
        el.slotMinutes = 60;
        el.geometry = { width: 1000, marginLeft: 0, plotWidth: 1000, startMinutes: 0, endMinutes: 60 };
        el.nowMs = Date.parse(`${day}T23:59:00Z`);
        el.importPrice = mounted.importPrice ?? [];
        el.exportPrice = mounted.exportPrice ?? [];
        el.unit = "CZK/kWh";
        document.body.appendChild(el);
        await el.updateComplete;
        return [...el.shadowRoot.querySelectorAll("text")].map((t: any) => t.textContent.trim());
    }, { mounted: rails, day: DAY });
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
    test("a cell is one full-width column, not two half-width ones", async ({ page }) => {
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: 7.2 }],
            exportPrice: [{ slot: "00:00", value: 5.8 }],
        });

        expect(bars).toHaveLength(2);
        // Both span the whole cell; neither is halved to sit beside the other.
        expect(bars[0].width).toBe(bars[1].width);
        expect(bars[0].width).toBeGreaterThan(900);
    });

    test("the rate further from zero is drawn under the nearer one", async ({ page }) => {
        // The mockup's rule: what stays visible of the taller bar is exactly the
        // spread, in the colour of the side paying it. Import is the outer rate
        // here, so import paints first and export covers the shared stretch.
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: 7.2 }],
            exportPrice: [{ slot: "00:00", value: 5.8 }],
        });

        expect(bars.map((b) => b.fill)).toEqual(["import", "export"]);
        expect(bars[0].height).toBeGreaterThan(bars[1].height);
    });

    test("when export is the higher rate the layering swaps", async ({ page }) => {
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: 7.2 }],
            exportPrice: [{ slot: "00:00", value: 8.1 }],
        });

        expect(bars.map((b) => b.fill)).toEqual(["export", "import"]);
        expect(bars[0].height).toBeGreaterThan(bars[1].height);
    });

    test("a negative rate takes the adverse colour, not its side's", async ({ page }) => {
        // A price that has gone upside down is worth seeing before the
        // direction it was flowing in, so the flow colour gives way.
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: 7.3 }],
            exportPrice: [{ slot: "00:00", value: -0.3 }],
        });

        expect(bars.map((b) => b.fill)).toEqual(["import", "negative"]);
    });

    test("two negative rates still layer by distance from zero", async ({ page }) => {
        // Both draw adverse, so the ordering is what carries the meaning: the
        // further-from-zero bar underneath, the nearer one against the axis.
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: -1 }],
            exportPrice: [{ slot: "00:00", value: -3 }],
        });

        expect(bars.map((b) => b.fill)).toEqual(["negative", "negative"]);
        expect(bars[0].height).toBeGreaterThan(bars[1].height);
    });

    test("a small negative rate gets a band of its own, not a hairline", async ({ page }) => {
        // Scaling both sides by one shared maximum drew a lone -0.3 beside a 7.3
        // as something too small to see or label.
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: 7.3 }],
            exportPrice: [{ slot: "00:00", value: -0.3 }],
        });

        const negative = bars.find((b) => b.fill === "negative")!;
        expect(negative.height).toBeGreaterThan(8);
    });

    test("every rate keeps a label, however short its bar", async ({ page }) => {
        const labels = await labelsFor(page, {
            importPrice: [{ slot: "00:00", value: 7.3 }],
            exportPrice: [{ slot: "00:00", value: -0.3 }],
        });

        expect(labels).toContain("7.3");
        expect(labels).toContain("-0.3");
    });

    test("a cell with only one rate still draws its column", async ({ page }) => {
        const bars = await barsFor(page, {
            importPrice: [{ slot: "00:00", value: 4.4 }],
        });

        expect(bars.map((b) => b.fill)).toEqual(["import"]);
    });
});
