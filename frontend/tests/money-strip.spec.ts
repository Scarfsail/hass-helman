import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * How the money strip draws a day's cost and gain.
 *
 * Signed like the chart above it: cost rises above the zero line, gain falls
 * below, so the two are never told apart by colour alone. Two rules are worth
 * pinning because they are exactly where this strip must NOT follow the price
 * strip it sits beneath. Amounts grouped into a wider cell sum where prices
 * average — money is a quantity, not a rate. And each slot belongs to one
 * vintage only, actual behind the seam and forecast ahead of it, so the two can
 * never both contribute and double the day.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

type MoneyPoint = { slot: string; cost: number; gain: number };
type Bar = { side: "cost" | "gain"; height: number; width: number };

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-money-strip"));
}

/**
 * Mount the strip and read back the bars it drew. `nowMs` places the seam, so a
 * test can put a slot on either side of it.
 */
async function barsFor(
    page: Page,
    input: {
        actual?: MoneyPoint[];
        forecast?: MoneyPoint[];
        slotMinutes?: number;
        nowSlot?: string;
    },
): Promise<Bar[]> {
    return page.evaluate(async ({ mounted, day }) => {
        const el = document.createElement("helman-solar-money-strip") as any;
        el.hass = { language: "en", localize: () => "", states: {} };
        el.timeZone = "Europe/Prague";
        el.date = day;
        el.slotMinutes = mounted.slotMinutes ?? 15;
        el.nowMs = Date.parse(`${day}T${mounted.nowSlot ?? "23:59"}:00+02:00`);
        el.moneyActual = mounted.actual ?? [];
        el.moneyForecast = mounted.forecast ?? [];
        el.currency = "CZK";
        el.geometry = {
            width: 1000, marginLeft: 0, plotWidth: 1000,
            startMinutes: 0, endMinutes: 1440,
        };
        document.body.appendChild(el);
        await el.updateComplete;
        return [...el.shadowRoot.querySelectorAll("rect")]
            .filter((r: any) => /--helman-grid-/.test(r.style.fill || ""))
            .map((r: any) => ({
                side: r.style.fill.includes("import") ? "cost" : "gain",
                height: Math.round(parseFloat(r.getAttribute("height"))),
                width: Math.round(parseFloat(r.getAttribute("width"))),
            }));
    }, { mounted: input, day: DAY });
}

test.describe("money strip", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("cost rises above the line and gain falls below it", async ({ page }) => {
        const bars = await barsFor(page, {
            actual: [{ slot: "10:00", cost: 5, gain: 2 }],
        });

        // Both drawn, from the same zero line, so a slot that did both shows
        // both without either hiding the other.
        expect(bars.map((b) => b.side).sort()).toEqual(["cost", "gain"]);
        expect(bars.every((b) => b.height > 0)).toBe(true);
    });

    test("a slot with only cost draws only the cost bar", async ({ page }) => {
        const bars = await barsFor(page, {
            actual: [{ slot: "10:00", cost: 5, gain: 0 }],
        });

        expect(bars.map((b) => b.side)).toEqual(["cost"]);
    });

    test("amounts grouped into one cell sum, they do not average", async ({ page }) => {
        // The rule the price strip above deliberately does not share. Hour 10
        // holds four quarter-hours of 1 CZK and hour 11 holds one, in the same
        // strip and therefore on the same scale: summing makes 10 four times
        // the height of 11, averaging would make them equal.
        const bars = await barsFor(page, {
            actual: [
                { slot: "10:00", cost: 1, gain: 0 },
                { slot: "10:15", cost: 1, gain: 0 },
                { slot: "10:30", cost: 1, gain: 0 },
                { slot: "10:45", cost: 1, gain: 0 },
                { slot: "11:00", cost: 1, gain: 0 },
            ],
            slotMinutes: 60,
        });

        expect(bars).toHaveLength(2);
        const [tenth, eleventh] = bars;
        // ~4, give or take the pixel rounding of a 58px plot. Averaging would
        // put this at 1, which is what the assertion actually rules out.
        expect(tenth.height / eleventh.height).toBeGreaterThan(3.5);
    });

    test("a wider slot width groups the day into fewer, wider cells", async ({ page }) => {
        const quarterHourly = await barsFor(page, {
            actual: [
                { slot: "10:00", cost: 1, gain: 0 },
                { slot: "10:15", cost: 1, gain: 0 },
            ],
            slotMinutes: 15,
        });
        const hourly = await barsFor(page, {
            actual: [
                { slot: "10:00", cost: 1, gain: 0 },
                { slot: "10:15", cost: 1, gain: 0 },
            ],
            slotMinutes: 60,
        });

        expect(quarterHourly).toHaveLength(2);
        expect(hourly).toHaveLength(1);
    });

    test("each slot belongs to one vintage, so the day is never doubled", async ({ page }) => {
        // Both vintages carry the same slot, as they do around the running slot.
        // Behind the seam the actual wins and the forecast is ignored entirely.
        const bars = await barsFor(page, {
            actual: [{ slot: "10:00", cost: 4, gain: 0 }],
            forecast: [{ slot: "10:00", cost: 4, gain: 0 }],
            nowSlot: "12:00",
            slotMinutes: 60,
        });

        expect(bars).toHaveLength(1);
    });

    test("every drawn amount carries its number", async ({ page }) => {
        // The strip is unreadable without them: a bar's height says which slot
        // was dearest, never what it came to.
        const labels = await page.evaluate(async (day) => {
            const el = document.createElement("helman-solar-money-strip") as any;
            el.hass = { language: "en", localize: () => "", states: {} };
            el.timeZone = "Europe/Prague";
            el.date = day;
            el.slotMinutes = 60;
            el.nowMs = Date.parse(`${day}T23:59:00+02:00`);
            el.moneyActual = [{ slot: "10:00", cost: 12.4, gain: 3.25 }];
            el.moneyForecast = [];
            el.currency = "CZK";
            el.geometry = {
                width: 1000, marginLeft: 0, plotWidth: 1000,
                startMinutes: 540, endMinutes: 780,
            };
            document.body.appendChild(el);
            await el.updateComplete;
            return [...el.shadowRoot.querySelectorAll("text")].map((t: any) => t.textContent.trim());
        }, DAY);

        // Whole units past ten, one place below it.
        expect(labels).toContain("12");
        expect(labels).toContain("3.3");
    });

    test("a side with nothing on it gets no band of the plot", async ({ page }) => {
        // A day that only ever exported would otherwise spend half the plot on
        // an empty cost half and draw its gains at half the height they deserve.
        const gainOnly = await barsFor(page, {
            actual: [{ slot: "10:00", cost: 0, gain: 4 }],
            slotMinutes: 60,
        });
        const both = await barsFor(page, {
            actual: [{ slot: "10:00", cost: 4, gain: 4 }],
            slotMinutes: 60,
        });

        const gainBar = (bars: typeof gainOnly) => bars.find((b) => b.side === "gain")!;
        expect(gainBar(gainOnly).height).toBeGreaterThan(gainBar(both).height * 1.5);
    });

    test("a day with no priced slot draws nothing at all", async ({ page }) => {
        const bars = await barsFor(page, { actual: [], forecast: [] });
        expect(bars).toEqual([]);
    });
});
