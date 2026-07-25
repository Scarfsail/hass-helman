import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Regression guard for the house breakdown's "top N" cut.
 *
 * The section shows only the top few consumers. An unmeasured node is a
 * remainder and is hidden below 1 W — but the ranking is by history sum while
 * the hiding asks about the current value, so the row could win a slot and then
 * render nothing. The user saw three rows collapse to two whenever the house
 * remainder blinked to 0, with no fourth device taking the freed slot.
 *
 * The container therefore drops invisible nodes BEFORE it takes its top N.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

interface FakeNode {
    id: string;
    name: string;
    powerValue: number;
    powerHistory: number[];
    isUnmeasured?: boolean;
}

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-devices-container"));
}

/** Mount the container with the given nodes and return the row names it painted. */
async function renderedRowNames(
    page: Page,
    nodes: FakeNode[],
    showOnlyTopChildren: number,
): Promise<string[]> {
    return page.evaluate(async (o) => {
        const el = document.createElement("power-devices-container") as any;
        el.hass = { states: {}, locale: { language: "en" } };
        el.devices = o.nodes.map((n: any) => ({
            children: [],
            valueType: "default",
            isSource: false,
            isUnmeasured: false,
            historyBuckets: n.powerHistory.length,
            ...n,
        }));
        el.historyBuckets = 3;
        el.historyBucketDuration = 1;
        el.devices_full_width = true;
        el.sortChildrenByPower = true;
        el.show_only_top_children = o.showOnlyTopChildren;
        document.body.appendChild(el);
        await el.updateComplete;

        const rows = Array.from(
            el.shadowRoot!.querySelectorAll("power-device"),
        ) as any[];
        const names: string[] = [];
        for (const row of rows) {
            await row.updateComplete;
            const name = row.shadowRoot?.querySelector(".deviceName");
            if (name) names.push(name.textContent!.trim());
        }
        return names;
    }, { nodes, showOnlyTopChildren });
}

// Ranked by history sum: unmeasured first, then A, B, C.
const NODES = (unmeasuredNow: number): FakeNode[] => [
    { id: "unmeasured", name: "Ghost", powerValue: unmeasuredNow,
      powerHistory: [400, 400, 400], isUnmeasured: true },
    { id: "a", name: "Oven", powerValue: 300, powerHistory: [300, 300, 300] },
    { id: "b", name: "Boiler", powerValue: 200, powerHistory: [200, 200, 200] },
    { id: "c", name: "Fridge", powerValue: 100, powerHistory: [100, 100, 100] },
];

test.describe("house breakdown top-N cut", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a hidden unmeasured row gives its slot to the next real device", async ({ page }) => {
        // The remainder is at 0 W, so it must not consume one of the three slots.
        const names = await renderedRowNames(page, NODES(0), 3);
        expect(names).toEqual(["Oven", "Boiler", "Fridge"]);
    });

    test("an unmeasured row that has power keeps its place at the top", async ({ page }) => {
        const names = await renderedRowNames(page, NODES(120), 3);
        expect(names).toEqual(["Ghost", "Oven", "Boiler"]);
    });

    test("without a top-N limit the hidden row still leaves no empty box", async ({ page }) => {
        const names = await renderedRowNames(page, NODES(0), 0);
        expect(names).toEqual(["Oven", "Boiler", "Fridge"]);
    });
});
