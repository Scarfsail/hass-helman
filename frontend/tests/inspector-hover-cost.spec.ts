import type { InspectorPayload } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import {
    STOP_MONTH_VIEW,
    clickStop,
    columnsWithClass,
    hoverColumn,
    loadCardBundle as loadAggregateBundle,
    mountInspector as mountAggregateInspector,
    waitForAggregateChart,
} from "./support/inspector-aggregate-harness";
import { loadBundle } from "./support/card-page";

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

const DAY = "2026-07-18";
const SLOT_MINUTES = 30;

/** Every derivation a pointer report must not reach. */
type Counts = {
    view: number;
    coverage: number;
    stacks: number;
    layout: number;
    socBars: number;
    selectedMinutes: number;
    stripGeometry: number;
    priceColumns: number;
    moneyCells: number;
};

declare global {
    interface Window {
        __hoverCounts: Counts;
    }
}

/**
 * A full day with everything the strips need: a solar curve, measured house
 * and grid up to midday so the chart has both vintages and a seam, both price
 * rails, and money on both sides of that seam.
 */
async function mountInspector(page: Page): Promise<void> {
    await page.evaluate(({ date, slot }) => {
        const corrected: Array<{ slot: string; valueWh: number }> = [];
        const actual: Array<{ slot: string; valueWh: number }> = [];
        const houseForecast: Array<{ slot: string; valueWh: number }> = [];
        const gridForecast: Array<{ slot: string; valueWh: number }> = [];
        const soc: Array<{ slot: string; pct: number }> = [];
        const importPrice: Array<{ slot: string; value: number }> = [];
        const exportPrice: Array<{ slot: string; value: number }> = [];
        const moneyActual: InspectorPayload["series"]["moneyActual"] = [];
        const moneyForecast: InspectorPayload["series"]["moneyForecast"] = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const label = `${hh}:${mm}`;
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ slot: label, valueWh: v });
            houseForecast.push({ slot: label, valueWh: 120 });
            gridForecast.push({ slot: label, valueWh: 60 });
            soc.push({ slot: label, pct: 40 + (m % 300) / 10 });
            importPrice.push({ slot: label, value: 4 + (m % 120) / 60 });
            exportPrice.push({ slot: label, value: 1.5 });
            if (m < 720) {
                actual.push({ slot: label, valueWh: v * 0.9 });
                moneyActual.push({ slot: label, cost: 0.4, gain: 0.1 });
            } else {
                moneyForecast.push({ slot: label, cost: 0.3, gain: 0.2 });
            }
        }
        const payload = window.__inspectorDay({ date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            priceUnit: "CZK/kWh",
            range: { minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: { raw: [], corrected, actual, invalidated: [], factors: [], impact: [],
                houseForecast, houseActual: [],
                batterySocForecast: soc, batterySocActual: [],
                gridForecast, gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice, exportPrice, moneyActual, moneyForecast,
            },
            totals: { rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasProfile: true,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        });

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as unknown as
            Record<string, unknown>;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = slot;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: window.__mockHass({
                "helman/solar_bias/inspector": async (msg: {
                    date: string;
                }) => {
                    return ({ ...payload, date: msg.date });
                }
            }).callWS,
        };
        document.body.appendChild(el as unknown as Node);
    }, { date: DAY, slot: SLOT_MINUTES });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as
            (Element & { shadowRoot: ShadowRoot | null }) | null;
        return !!el?.shadowRoot?.querySelector("helman-solar-day-chart")?.shadowRoot?.querySelector(".chart-wrap svg");
    });
    // The price strip lands a render after the chart -- it echoes its columns
    // back up -- so let the opening sequence finish before anything is counted.
    await page.waitForTimeout(300);
}

/**
 * Count the derivations that actually ran. Installed after the mount: what the
 * opening sequence costs is not what this test is about.
 *
 * The day model is pure functions the card memoises (`inspector-day-model.ts`),
 * so a rebuild is visible as a new identity on the field the card stores its
 * result in -- each step returns a fresh object whenever it runs, and the very
 * same one whenever it does not. Those fields are compared after every update.
 * The money strip still builds its cells in a method of its own, so that one
 * is counted by wrapping it on the prototype.
 */
async function installCounters(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.__hoverCounts = {
            view: 0, coverage: 0, stacks: 0, layout: 0,
            socBars: 0, selectedMinutes: 0, stripGeometry: 0, priceColumns: 0, moneyCells: 0,
        };
        const inspector = document.querySelector("helman-solar-inspector") as unknown as
            Element & { shadowRoot: ShadowRoot };
        const watch = (
            tag: string,
            element: Element,
            fields: Partial<Record<keyof Counts, string>>,
        ): void => {
            const proto = customElements.get(tag)!.prototype as unknown as
                Record<string, (...args: unknown[]) => unknown>;
            const original = proto.updated;
            const snapshot = (el: Record<string, unknown>) => {
                const values: Record<string, unknown> = {};
                for (const [key, field] of Object.entries(fields)) {
                    if (!(field in el)) throw new Error(`${tag} has no ${field} to watch`);
                    values[key] = el[field];
                }
                return values;
            };
            const seen = new WeakMap<object, Record<string, unknown>>();
            seen.set(element, snapshot(element as unknown as Record<string, unknown>));
            proto.updated = function counted(this: Record<string, unknown>, ...args: unknown[]) {
                const last = seen.get(this);
                const now = snapshot(this);
                for (const key of Object.keys(now)) {
                    if (last && last[key] !== now[key]) window.__hoverCounts[key as keyof Counts] += 1;
                }
                seen.set(this, now);
                return original.apply(this, args);
            };
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
        watch("helman-solar-inspector", inspector, {
            view: "_view",
            coverage: "_coverage",
            stacks: "_stacks",
            layout: "_layout",
            socBars: "_socBarsModel",
            selectedMinutes: "_selectedMinutesModel",
            stripGeometry: "_stripGeometry",
        });
        watch("helman-solar-price-strip", inspector.shadowRoot.querySelector("helman-solar-price-strip")!, {
            priceColumns: "importColumns",
        });
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
        const svg = root.querySelector("helman-solar-day-chart")?.shadowRoot?.querySelector(".chart-wrap svg") as SVGSVGElement;
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
    socBars: 0, selectedMinutes: 0, stripGeometry: 0, priceColumns: 0, moneyCells: 0,
};

test.describe("what a hover over the inspector costs", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await loadBundle(page, "helman-solar-inspector");
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
