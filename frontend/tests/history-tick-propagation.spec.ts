import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * A history tick has to reach the bars.
 *
 * `HistoryEngine` mutates each node's `powerHistory` / `sourcePowerHistory` in
 * place, so when a bucket rolls nothing a child was handed changes identity:
 * same node objects, same arrays, and on a steady house the same power values.
 * Lit dirty-checks by identity, so the containers had no reason to re-render and
 * the bars below them kept painting the mix they were built with — until some
 * unrelated Home Assistant state change happened to shake the tree. That is the
 * "intermittent" half of #227: whether the colours were current depended on
 * house noise rather than on the histories.
 *
 * The signal is `historyRevision`, a counter the card bumps once per tick and
 * passes down. These tests move nothing else: the node objects, the `hass`
 * object and the parent power all stay exactly as they were, so a repaint here
 * can only have come from the counter.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const SOLAR = "#facc15";
const GRID = "#38bdf8";
const SOLAR_RGB = "rgb(250, 204, 21)";
const GRID_RGB = "rgb(56, 189, 248)";

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-devices-container"));
}

/**
 * Install a page-side helper that reads back the bar colours of every rendered
 * row, keyed by row name. One entry per rectangle subpath, so a row whose newest
 * bucket switched source shows both colours.
 */
async function installReader(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as any).__rowColours = async (root: any) => {
            const out: Record<string, string[]> = {};
            const rows = Array.from(root.querySelectorAll("power-device")) as any[];
            for (const row of rows) {
                await row.updateComplete;
                // The row's own name, minus the expand/collapse indicator glued to it.
                const name = (row.shadowRoot?.querySelector(".deviceName")?.textContent ?? "?")
                    .replace(/[\u25BA\u25BC]\s*$/, "")
                    .trim();
                const bars = row.shadowRoot?.querySelector("helman-power-history-bars") as any;
                await bars?.updateComplete;
                const colours: string[] = [];
                for (const path of bars?.shadowRoot?.querySelectorAll("path") ?? []) {
                    const fill = getComputedStyle(path as SVGPathElement).fill;
                    const d = path.getAttribute("d") ?? "";
                    for (const _ of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)) colours.push(fill);
                }
                out[name] = colours;
            }
            return out;
        };
    });
}

/** One consumer node shaped the way the card's hydrated tree shapes them. */
function fakeNode(id: string, name: string, labels: string[] = []) {
    return {
        id,
        name,
        labels,
        children: [],
        valueType: "default",
        isSource: false,
        isUnmeasured: false,
        powerValue: 100,
        historyBuckets: 3,
        powerHistory: [100, 100],
        sourcePowerHistory: [
            { solar: { power: 100, color: SOLAR } },
            { solar: { power: 100, color: SOLAR } },
        ],
    };
}

test.describe("history tick reaches the rendered bars", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
        await installReader(page);
    });

    test("a consumer row repaints on a bumped revision alone", async ({ page }) => {
        const colours = await page.evaluate(async (c) => {
            const el = document.createElement("power-devices-container") as any;
            const hass = { states: {}, locale: { language: "en" } };
            const nodes = [c.node];
            el.hass = hass;
            el.devices = nodes;
            el.historyBuckets = 3;
            el.historyBucketDuration = 1;
            el.historyRevision = 0;
            el.devices_full_width = true;
            document.body.appendChild(el);
            await el.updateComplete;
            const before = await (window as any).__rowColours(el.shadowRoot);

            // Exactly what a tick does: push a bucket onto both series in place,
            // attributed to a different source. Nothing else changes — same node
            // object, same arrays, same hass, same power value.
            const node = nodes[0];
            node.powerHistory.push(100);
            node.sourcePowerHistory.push({ grid: { power: 100, color: c.GRID } });
            el.historyRevision = 1;
            await el.updateComplete;
            const after = await (window as any).__rowColours(el.shadowRoot);

            return { before, after };
        }, { GRID, node: fakeNode("washer", "Washer") });

        expect(colours.before["Washer"]).toEqual([SOLAR_RGB, SOLAR_RGB]);
        expect(colours.after["Washer"]).toEqual([SOLAR_RGB, SOLAR_RGB, GRID_RGB]);
    });

    test("a grouped house row repaints on a bumped revision alone", async ({ page }) => {
        // The group rows are virtual nodes holding *copies* of their children's
        // histories, rebuilt behind a memo. The memo has to see the revision too,
        // or the aggregate keeps painting the bucket it was built from.
        const colours = await page.evaluate(async (c) => {
            const el = document.createElement("power-house-devices-section") as any;
            const child = c.node;
            el.hass = { states: {}, locale: { language: "en" } };
            el.devices = [child];
            el.historyBuckets = 3;
            el.historyBucketDuration = 1;
            el.historyRevision = 0;
            el.uiConfig = { device_label_text: { Room: { Kitchen: "🍳" } }, show_others_group: false };
            document.body.appendChild(el);
            await el.updateComplete;

            // Activate the grouping — that is what puts the aggregate rows on screen.
            (el.shadowRoot.querySelector("button.chip:not(.show-toggle)") as HTMLButtonElement).click();
            await el.updateComplete;
            const container = el.shadowRoot.querySelector("power-devices-container") as any;
            await container.updateComplete;
            const before = await (window as any).__rowColours(container.shadowRoot);

            child.powerHistory.push(100);
            child.sourcePowerHistory.push({ grid: { power: 100, color: c.GRID } });
            el.historyRevision = 1;
            await el.updateComplete;
            await container.updateComplete;
            const after = await (window as any).__rowColours(container.shadowRoot);

            return { before, after };
        }, { GRID, node: fakeNode("washer", "Washer", ["Kitchen"]) });

        expect(colours.before["Kitchen (🍳)"]).toEqual([SOLAR_RGB, SOLAR_RGB]);
        expect(colours.after["Kitchen (🍳)"]).toEqual([SOLAR_RGB, SOLAR_RGB, GRID_RGB]);
    });
});
