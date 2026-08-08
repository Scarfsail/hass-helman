import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Regression guard for the history-bar source-attribution colours.
 *
 * `helman-power-history-bars` paints each consumer's past power as a stacked bar,
 * split by which source (solar/battery/grid) fed it in that bucket. When a bucket
 * has no source attribution it falls back to the node's own `historyBarColor`.
 *
 * The backend bug (ratio-history buffers double-appended per tick, desyncing them
 * from the power buffers) made `applyHistory` produce EMPTY source buckets on page
 * refresh, so the house bars rendered the fallback colour ("weird colour") instead
 * of solar yellow. This test pins the rendering contract that feeds off that data:
 * with correct per-bucket source attribution the bar is painted the source colour,
 * and only genuinely-empty buckets fall back.
 *
 * The bars are drawn as one `<svg>` with one `<path>` per distinct colour and one
 * rectangle subpath per segment, so the segments are recovered from the path
 * geometry: each subpath's `M x y` gives the column and the top of the segment,
 * and sorting by column then by descending `y` puts them back in the order the
 * old bottom-up flex columns laid them out in.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const SOLAR = "#facc15"; // canonical solar colour (color-utils SOLAR_COLOR)
const SOLAR_RGB = "rgb(250, 204, 21)";
const FALLBACK_RGB = "rgb(122, 59, 59)"; // the node's own "weird" fallback colour

/** Load a bare page with the card bundle so its custom elements are registered. */
async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() =>
        !!customElements.get("helman-power-history-bars"),
    );
}

/** Mount the bars element with the given props and return its rendered segment colours. */
async function renderSegmentColours(
    page: Page,
    opts: {
        historyToRender: number[];
        maxHistoryPower: number;
        historyBarColor: string;
        sourceHistory: Array<Record<string, { power: number; color: string }>>;
    },
): Promise<string[]> {
    return page.evaluate(async (o) => {
        const el = document.createElement("helman-power-history-bars") as any;
        el.sourceHistory = o.sourceHistory;
        el.historyToRender = o.historyToRender;
        el.maxHistoryPower = o.maxHistoryPower;
        el.historyBarColor = o.historyBarColor;
        document.body.appendChild(el);
        await el.updateComplete;

        // Rebuild document order from the geometry: one entry per rectangle
        // subpath, columns left to right, segments bottom to top within a column.
        const segments: Array<{ x: number; y: number; colour: string }> = [];
        for (const path of el.shadowRoot!.querySelectorAll("path")) {
            const colour = getComputedStyle(path as SVGPathElement).fill;
            const d = path.getAttribute("d") ?? "";
            for (const m of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)) {
                segments.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), colour });
            }
        }
        segments.sort((a, b) => a.x - b.x || b.y - a.y);
        return segments.map((s) => s.colour);
    }, opts);
}

test.describe("helman-power-history-bars source attribution", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("paints buckets with the source colour when attribution is present", async ({ page }) => {
        // All three past buckets: 1 kW house load, fully attributed to solar —
        // exactly what a correctly-aligned backend history payload yields.
        const colours = await renderSegmentColours(page, {
            historyToRender: [1000, 1000, 1000],
            maxHistoryPower: 1000,
            historyBarColor: FALLBACK_RGB,
            sourceHistory: [
                { solar: { power: 1000, color: SOLAR } },
                { solar: { power: 1000, color: SOLAR } },
                { solar: { power: 1000, color: SOLAR } },
            ],
        });

        expect(colours).toHaveLength(3);
        for (const c of colours) {
            expect(c).toBe(SOLAR_RGB);
        }
        // Regression: none of the bars fell back to the node's own colour.
        expect(colours).not.toContain(FALLBACK_RGB);
    });

    test("falls back to the node colour only for genuinely empty buckets", async ({ page }) => {
        // Empty source buckets are the symptom the backend fix removes; document
        // that this — and only this — produces the fallback colour.
        const colours = await renderSegmentColours(page, {
            historyToRender: [1000, 1000],
            maxHistoryPower: 1000,
            historyBarColor: FALLBACK_RGB,
            sourceHistory: [{}, {}],
        });

        expect(colours).toEqual([FALLBACK_RGB, FALLBACK_RGB]);
    });
});
