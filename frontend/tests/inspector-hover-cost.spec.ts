import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import {
    STOP_MONTH_VIEW,
    clickStop,
    columnsWithClass,
    hoverColumn,
    loadCardBundle as loadAggregateBundle,
    mountInspector as mountAggregateInspector,
    waitForAggregateChart,
} from "./support/inspector-aggregate-harness";

/**
 * What a pointer sweep across the inspector is allowed to cost.
 *
 * A mouse reports far more often than the screen repaints, and every report
 * used to rebuild the whole day: the re-bucketed view, the coverage marks, the
 * two stacks, the axis, the SoC columns, the price columns and the money cells
 * were all built inside `render()`, so reading the chart re-derived a day per
 * pixel travelled (#230, findings F1 and F4).
 *
 * ## Why these are hard zeros
 *
 * Like `render-discipline.spec.ts`, this states the rule rather than a budget.
 * None of the models counted here is a function of the pointer -- the pointer
 * moves highlights and a popup, and nothing else -- so the honest expectation
 * for a sweep that stays inside one slot is exactly none of them, forever. A
 * "fewer than N rebuilds" gate would drift with unrelated work and would be
 * repaired by raising N. **If this fails, the fix is in the card.**
 *
 * The sweep deliberately spends one frame per move rather than firing thirty
 * moves into one turn: the card coalesces pointer work to `requestAnimationFrame`,
 * and a burst inside a single frame would collapse into one update and pass
 * this test without proving anything about the caches.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";
const SLOT_MINUTES = 30;

/** Every derivation a pointer report must not reach. */
type Counts = {
    view: number;
    coverage: number;
    stacks: number;
    layout: number;
    socBars: number;
    priceColumns: number;
    moneyCells: number;
};

declare global {
    interface Window {
        __hoverCounts: Counts;
    }
}

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * A full day with everything the strips need: a solar curve, measured house
 * and grid up to midday so the chart has both vintages and a seam, both price
 * rails, and money on both sides of that seam.
 */
async function mountInspector(page: Page): Promise<void> {
    await page.evaluate(({ date, slot }) => {
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const actual: Array<{ timestamp: string; valueWh: number }> = [];
        const houseForecast: Array<{ timestamp: string; valueWh: number }> = [];
        const gridForecast: Array<{ timestamp: string; valueWh: number }> = [];
        const soc: Array<{ slot: string; pct: number }> = [];
        const importPrice: Array<{ slot: string; value: number }> = [];
        const exportPrice: Array<{ slot: string; value: number }> = [];
        const moneyActual: Array<Record<string, unknown>> = [];
        const moneyForecast: Array<Record<string, unknown>> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const stamp = `${date}T${hh}:${mm}:00`;
            const label = `${hh}:${mm}`;
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ timestamp: stamp, valueWh: v });
            houseForecast.push({ timestamp: stamp, valueWh: 120 });
            gridForecast.push({ timestamp: stamp, valueWh: 60 });
            soc.push({ slot: label, pct: 40 + (m % 300) / 10 });
            importPrice.push({ slot: label, value: 4 + (m % 120) / 60 });
            exportPrice.push({ slot: label, value: 1.5 });
            if (m < 720) {
                actual.push({ timestamp: stamp, valueWh: v * 0.9 });
                moneyActual.push({ slot: label, cost: 0.4, gain: 0.1 });
            } else {
                moneyForecast.push({ slot: label, cost: 0.3, gain: 0.2 });
            }
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            priceUnit: "CZK/kWh",
            range: {
                minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: {
                raw: [], corrected, actual, invalidated: [], factors: [], impact: [],
                houseForecast, houseActual: [],
                batterySocForecast: soc, batterySocActual: [],
                gridForecast, gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice, exportPrice, moneyActual, moneyForecast,
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: true,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: true,
                hasHouseActual: false, hasBatterySocForecast: true, hasBatterySocActual: false,
                hasGridForecast: true, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as unknown as
            Record<string, unknown>;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = slot;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el as unknown as Node);
    }, { date: DAY, slot: SLOT_MINUTES });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as
            (Element & { shadowRoot: ShadowRoot | null }) | null;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
    // The price strip lands a render after the chart -- it echoes its columns
    // back up -- so let the opening sequence finish before anything is counted.
    await page.waitForTimeout(300);
}

/**
 * Wrap the derivations on the prototypes, so the count is of the real calls
 * and not of a stand-in. Installed after the mount: what the opening sequence
 * costs is not what this test is about.
 */
async function installCounters(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.__hoverCounts = {
            view: 0, coverage: 0, stacks: 0, layout: 0,
            socBars: 0, priceColumns: 0, moneyCells: 0,
        };
        const wrap = (tag: string, method: string, key: keyof Counts): void => {
            const proto = customElements.get(tag)!.prototype as unknown as
                Record<string, (...args: unknown[]) => unknown>;
            const original = proto[method];
            if (typeof original !== "function") {
                throw new Error(`${tag} has no ${method} to count`);
            }
            proto[method] = function counted(this: unknown, ...args: unknown[]) {
                window.__hoverCounts[key] += 1;
                return original.apply(this, args);
            };
        };
        wrap("helman-solar-inspector", "_viewForSlot", "view");
        wrap("helman-solar-inspector", "_computeCoverage", "coverage");
        wrap("helman-solar-inspector", "_buildStacks", "stacks");
        wrap("helman-solar-inspector", "_computeChartLayout", "layout");
        wrap("helman-solar-inspector", "_socBars", "socBars");
        wrap("helman-solar-price-strip", "_buildColumns", "priceColumns");
        wrap("helman-solar-money-strip", "_buildCells", "moneyCells");
    });
}

type Sweep = { counts: Counts; positions: string[]; titles: string[] };

/**
 * Sweep `moves` pointer reports across the main chart, from `fromMinutes` to
 * `toMinutes` of the drawn day, one report per frame.
 */
async function sweep(
    page: Page,
    fromMinutes: number,
    toMinutes: number,
    moves: number,
): Promise<Sweep> {
    return page.evaluate(async ({ from, to, steps }) => {
        const el = document.querySelector("helman-solar-inspector") as unknown as
            Record<string, any>;
        const root = el.shadowRoot as ShadowRoot;
        const svg = root.querySelector(".chart-wrap svg") as SVGSVGElement;
        const rect = svg.getBoundingClientRect();
        // Whichever name the layout is kept under, so the same sweep can be run
        // against a build from before it was hoisted out of `render()`.
        const layout = el._layout ?? el._lastLayoutForStrip;
        const span = layout.dayEndMinutes - layout.dayStartMinutes;
        const clientXFor = (minutes: number): number => {
            const svgX = layout.margin.left
                + ((minutes - layout.dayStartMinutes) / span) * layout.plotWidth;
            return rect.left + (svgX / layout.width) * rect.width;
        };
        const popup = () => root.querySelector(".hover-tooltip") as HTMLElement | null;
        const positions: string[] = [];
        const titles: string[] = [];
        for (let i = 0; i < steps; i += 1) {
            const minutes = from + ((to - from) * i) / Math.max(1, steps - 1);
            svg.dispatchEvent(new MouseEvent("mousemove", {
                bubbles: true,
                clientX: clientXFor(minutes),
                clientY: rect.top + rect.height / 2,
            }));
            // One frame per report, then one turn for Lit to flush: a burst
            // inside a single frame would be coalesced and prove nothing.
            await new Promise((frame) => requestAnimationFrame(() => frame(null)));
            await new Promise((done) => setTimeout(done, 0));
            positions.push(`${popup()?.style.left ?? ""}|${popup()?.style.top ?? ""}`);
            titles.push(popup()?.querySelector(".hover-tooltip-title")?.textContent?.trim() ?? "");
        }
        return { counts: window.__hoverCounts, positions, titles };
    }, { from: fromMinutes, to: toMinutes, steps: moves });
}

const NO_REBUILDS: Counts = {
    view: 0, coverage: 0, stacks: 0, layout: 0,
    socBars: 0, priceColumns: 0, moneyCells: 0,
};

test.describe("what a hover over the inspector costs", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await loadCardBundle(page);
        await mountInspector(page);
        await installCounters(page);
    });

    test("thirty moves inside one slot rebuild nothing, and the popup still follows", async ({ page }) => {
        // Well inside a single 30-minute slot, so not one report crosses a
        // boundary: 10:02 to 10:28.
        const result = await sweep(page, 602, 628, 30);

        expect(result.counts).toEqual(NO_REBUILDS);

        // The popup did appear, says one thing throughout, and moved with the
        // pointer -- otherwise "nothing was rebuilt" would be the report of a
        // hover that did nothing at all.
        expect(new Set(result.titles).size, "one slot, one popup title").toBe(1);
        expect(result.titles[0]).not.toBe("");
        expect(new Set(result.positions).size, "the popup tracked the pointer")
            .toBeGreaterThan(5);
    });

    test("crossing into the next slot re-reads the popup and still nothing else", async ({ page }) => {
        const result = await sweep(page, 602, 692, 30);

        // A slot boundary changes what the popup says and which column is lit.
        // Neither is a fact about the day's shape, so the day's models stay put.
        expect(result.counts).toEqual(NO_REBUILDS);
        expect(new Set(result.titles.filter((title) => title !== "")).size)
            .toBeGreaterThan(1);
    });

    test("a change of slot width does rebuild them", async ({ page }) => {
        // The guard above is only meaningful if these counters can move at all.
        await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as unknown as
                Record<string, unknown>;
            (el as unknown as { _setSlotMinutes: (m: number) => void })._setSlotMinutes(60);
        });
        await page.waitForTimeout(200);

        const counts = await page.evaluate(() => window.__hoverCounts);
        expect(counts.view).toBeGreaterThan(0);
        expect(counts.stacks).toBeGreaterThan(0);
        expect(counts.layout).toBeGreaterThan(0);
        expect(counts.socBars).toBeGreaterThan(0);
        expect(counts.coverage).toBeGreaterThan(0);
        expect(counts.priceColumns).toBeGreaterThan(0);
        expect(counts.moneyCells).toBeGreaterThan(0);
    });
});

/**
 * The same rule one view up. At a month's width a column is a whole day, and
 * the chart is handed the hovered bucket by the card rather than deciding it
 * itself -- so a hover changes which column is lit and nothing else. The six
 * meters are stacked once per span.
 */
test.describe("what a hover over the aggregate chart costs", () => {
    test.beforeEach(async ({ page }) => {
        await loadAggregateBundle(page);
        await mountAggregateInspector(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await page.evaluate(() => {
            const proto = customElements.get("helman-solar-aggregate-chart")!.prototype as
                unknown as Record<string, (...args: unknown[]) => unknown>;
            const original = proto._buildStack;
            (window as unknown as { __stackBuilds: number }).__stackBuilds = 0;
            proto._buildStack = function counted(this: unknown, ...args: unknown[]) {
                (window as unknown as { __stackBuilds: number }).__stackBuilds += 1;
                return original.apply(this, args);
            };
        });
    });

    test("hovering column after column re-stacks nothing", async ({ page }) => {
        for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
            await hoverColumn(page, index);
        }

        expect(await page.evaluate(() => (window as unknown as { __stackBuilds: number }).__stackBuilds))
            .toBe(0);
        // And the hover did land -- a column reads as hovered.
        expect(await columnsWithClass(page, "hovered")).toHaveLength(1);
    });
});
