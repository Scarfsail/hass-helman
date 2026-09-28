import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Lifting children in the house section's grouped view (#365).
 *
 * A descendant whose effective group differs from its parent's is filed under
 * its own group (or "Others") with its own subtree, and the same rule applies
 * again inside that subtree. Every ancestor it was lifted out of is shown as a
 * copy without it and without its power, history buckets and per-source
 * buckets, so the group totals still add up to the house devices' total. The
 * shared items -- the plain view's -- are never changed.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const GROUPINGS = [
    {
        id: "breakers",
        name: "Jističe",
        groups: [
            { id: "fv", name: "Technická FV", short_name: "🔋T" },
            { id: "grid", name: "Technická síť", short_name: "⚡T" },
        ],
    },
];

type Sources = Record<string, number>[];

function node(
    id: string,
    history: number[],
    sources: Sources,
    groups: Record<string, string> = {},
    children: unknown[] = [],
) {
    return {
        id,
        name: id,
        groups,
        children,
        valueType: "default",
        isSource: false,
        isUnmeasured: false,
        powerValue: history[history.length - 1],
        historyBuckets: 2,
        powerHistory: history,
        sourcePowerHistory: sources.map((bucket) =>
            Object.fromEntries(Object.entries(bucket).map(([name, power]) => [name, { power, color: name }])),
        ),
    };
}

const DEVICES = [
    node("Boiler", [1000, 900], [{ solar: 600, grid: 400 }, { solar: 900 }], { breakers: "fv" }, [
        // Lifted into grid; its valve is lifted back out into fv.
        node("Pump", [200, 300], [{ solar: 150, grid: 50 }, { solar: 300 }], { breakers: "grid" }, [
            node("Valve", [30, 30], [{ grid: 30 }, { solar: 30 }], { breakers: "fv" }),
        ]),
        // Inherits fv, so stays nested.
        node("Heater", [100, 100], [{ solar: 100 }, { solar: 100 }]),
        // The boiler's remainder is never lifted.
        { ...node("Boiler remainder", [700, 500], [{}, {}]), isUnmeasured: true },
    ]),
    // Unassigned, but its light is on the grid breaker.
    node("Fridge", [60, 50], [{ grid: 60 }, { grid: 50 }], {}, [
        node("Light", [10, 10], [{ grid: 10 }, { grid: 10 }], { breakers: "grid" }),
    ]),
    { ...node("Unmeasured", [20, 20], [{}, {}]), isUnmeasured: true },
];

async function mountSection(page: Page, devices: unknown[] = DEVICES): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-house-devices-section"));
    await page.evaluate(
        async ({ devices, groupings }) => {
            const el = document.createElement("helman-house-devices-section") as any;
            el.hass = { states: {}, locale: { language: "en" } };
            el.devices = devices;
            el.historyBuckets = 2;
            el.historyBucketDuration = 1;
            el.uiConfig = { device_groupings: groupings, others_group_label: "Others" };
            document.body.appendChild(el);
            await el.updateComplete;
        },
        { devices, groupings: GROUPINGS },
    );
}

/** Toggle the grouping's chip and read what the list shows, subtrees included. */
async function toggleGrouping(page: Page) {
    return page.evaluate(async () => {
        const el = document.querySelector("helman-house-devices-section") as any;
        (el.shadowRoot.querySelector("button.chip:not(.show-toggle)") as HTMLButtonElement).click();
        await el.updateComplete;
        const read = (item: any): any => ({
            name: item.name,
            power: item.powerValue,
            history: item.powerHistory,
            sources: (item.sourcePowerHistory ?? []).map((bucket: any) =>
                Object.fromEntries(Object.entries(bucket).map(([name, s]: [string, any]) => [name, s.power])),
            ),
            children: item.children.map(read),
        });
        return (el.shadowRoot.querySelector("helman-tree-item-list").devices as any[]).map(read);
    });
}

const leaf = (name: string, power: number, history: number[], sources: Sources, children: unknown[] = []) => ({
    name,
    power,
    history,
    sources,
    children,
});

test("lifted children join their own group and leave their parents' power", async ({ page }) => {
    await mountSection(page);

    const groups = await toggleGrouping(page);

    expect(groups).toEqual([
        leaf("Technická FV (🔋T)", 630, [830, 630], [{ solar: 450, grid: 380 }, { solar: 630 }], [
            // The pump's whole reading, valve included, leaves the boiler.
            leaf("Boiler", 600, [800, 600], [{ solar: 450, grid: 350 }, { solar: 600 }], [
                leaf("Heater", 100, [100, 100], [{ solar: 100 }, { solar: 100 }]),
                leaf("Boiler remainder", 500, [700, 500], [{}, {}]),
            ]),
            // Lifted out of the lifted pump, back into fv.
            leaf("Valve", 30, [30, 30], [{ grid: 30 }, { solar: 30 }]),
        ]),
        leaf("Technická síť (⚡T)", 280, [180, 280], [{ solar: 150, grid: 30 }, { solar: 270, grid: 10 }], [
            leaf("Pump", 270, [170, 270], [{ solar: 150, grid: 20 }, { solar: 270 }]),
            leaf("Light", 10, [10, 10], [{ grid: 10 }, { grid: 10 }]),
        ]),
        leaf("Others", 40, [50, 40], [{ grid: 50 }, { grid: 40 }], [
            leaf("Fridge", 40, [50, 40], [{ grid: 50 }, { grid: 40 }]),
        ]),
    ]);

    // No watt counted twice: the groups add up to the top-level devices.
    const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
    expect(total(groups.map((group) => group.power))).toBe(900 + 50);
    for (const bucket of [0, 1]) {
        expect(total(groups.map((group) => group.history[bucket]))).toBe(
            DEVICES[0].powerHistory[bucket] + DEVICES[1].powerHistory[bucket],
        );
    }
});

test("the plain view keeps the raw readings and the whole tree", async ({ page }) => {
    await mountSection(page);

    await toggleGrouping(page);
    const plain = await toggleGrouping(page);

    const raw = (item: any): any => ({
        name: item.name,
        power: item.powerValue,
        history: item.powerHistory,
        sources: item.sourcePowerHistory.map((bucket: any) =>
            Object.fromEntries(Object.entries(bucket).map(([name, s]: [string, any]) => [name, s.power])),
        ),
        children: item.children.map(raw),
    });
    expect(plain).toEqual(DEVICES.map(raw));
});

test("a lifted child with a shorter history lines up with the newest buckets", async ({ page }) => {
    // The child's series started later: its one sample is the parent's newest.
    const child = node("Pump", [50], [{ grid: 50 }], { breakers: "grid" });
    await mountSection(page, [
        node("Boiler", [100, 200, 300], [{ solar: 100 }, { solar: 200 }, { solar: 200, grid: 100 }], { breakers: "fv" }, [child]),
        node("Lamp", [10, 10, 10], [{ grid: 10 }, { grid: 10 }, { grid: 10 }], { breakers: "grid" }),
    ]);

    const [fv, grid] = await toggleGrouping(page);

    expect(fv.children[0]).toEqual(
        leaf("Boiler", 250, [100, 200, 250], [{ solar: 100 }, { solar: 200 }, { solar: 200, grid: 50 }]),
    );
    // The group total lines the pump's one sample up with the lamp's newest.
    expect(grid.history).toEqual([10, 10, 60]);
    expect(grid.sources).toEqual([{ grid: 10 }, { grid: 10 }, { grid: 60 }]);
});

test("expanding a parent copy sticks to the shared item", async ({ page }) => {
    await mountSection(page);
    await toggleGrouping(page);

    const collapsed = await page.evaluate(async () => {
        const el = document.querySelector("helman-house-devices-section") as any;
        const [fv] = el.shadowRoot.querySelector("helman-tree-item-list").devices as any[];
        const boilerCopy = fv.children.find((item: any) => item.name === "Boiler");
        boilerCopy.childrenCollapsed = false;
        return el.devices[0].childrenCollapsed;
    });

    expect(collapsed).toBe(false);
});
