import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The house section's grouped view on `devices.groupings` (#363).
 *
 * The chips are the groupings, by name and in order. Picking one files every
 * top-level house device under its own group of that grouping -- `name (short
 * name)`, in group order -- or under "Others", and each group totals its
 * members. A child in its parent's group stays nested; one in another group is
 * lifted into it (#365, see house-grouping-lift.spec.ts), and the unmeasured
 * remainder is never filed.
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
    { id: "modes", name: "Režimy", groups: [{ id: "night", name: "Vypnout na noc", short_name: "😴" }] },
];

function node(id: string, powerValue: number, groups: Record<string, string> = {}, children: unknown[] = []) {
    return {
        id,
        name: id,
        groups,
        children,
        valueType: "default",
        isSource: false,
        isUnmeasured: false,
        powerValue,
        historyBuckets: 3,
        powerHistory: [powerValue, powerValue],
        sourcePowerHistory: [],
    };
}

const DEVICES = [
    // The pump is lifted into its own breaker group, but follows the boiler's mode.
    node("Boiler", 1000, { breakers: "fv", modes: "night" }, [node("Pump", 200, { breakers: "grid" })]),
    node("Washer", 300, { breakers: "fv" }),
    node("Fridge", 50),
    { ...node("Unmeasured", 20), isUnmeasured: true },
];

async function mountSection(page: Page, uiConfig: Record<string, unknown>): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-house-devices-section"));
    await page.evaluate(
        async ({ devices, uiConfig }) => {
            const el = document.createElement("helman-house-devices-section") as any;
            el.hass = { states: {}, locale: { language: "en" } };
            el.devices = devices;
            el.historyBuckets = 3;
            el.historyBucketDuration = 1;
            el.uiConfig = uiConfig;
            document.body.appendChild(el);
            await el.updateComplete;
        },
        { devices: DEVICES, uiConfig },
    );
}

const chips = (page: Page) =>
    page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-house-devices-section")!
                .shadowRoot!.querySelectorAll("button.chip:not(.show-toggle)"),
        ).map((chip) => chip.textContent?.trim()),
    );

/** Pick a grouping's chip, then read the rows it lists: name, total, members. */
async function groupedBy(page: Page, chip: string) {
    return page.evaluate(async (label) => {
        const el = document.querySelector("helman-house-devices-section") as any;
        const button = Array.from(el.shadowRoot.querySelectorAll("button.chip:not(.show-toggle)")).find(
            (candidate: any) => candidate.textContent.trim() === label,
        ) as HTMLButtonElement;
        button.click();
        await el.updateComplete;
        const list = el.shadowRoot.querySelector("helman-tree-item-list") as any;
        return (list.devices as any[]).map((group) => ({
            name: group.name,
            power: group.powerValue,
            members: group.children.map((member: any) => [member.name, member.children.map((c: any) => c.name)]),
        }));
    }, chip);
}

test("the chips are the groupings, by name and in order", async ({ page }) => {
    await mountSection(page, { device_groupings: GROUPINGS });

    expect(await chips(page)).toEqual(["Jističe", "Režimy"]);
});

test("a grouping files devices under their group, the rest under Others", async ({ page }) => {
    await mountSection(page, { device_groupings: GROUPINGS, others_group_label: "Others" });

    expect(await groupedBy(page, "Jističe")).toEqual([
        {
            name: "Technická FV (🔋T)",
            power: 1100,
            members: [
                ["Boiler", []],
                ["Washer", []],
            ],
        },
        { name: "Technická síť (⚡T)", power: 200, members: [["Pump", []]] },
        { name: "Others", power: 50, members: [["Fridge", []]] },
    ]);
    expect(await groupedBy(page, "Režimy")).toEqual([
        { name: "Vypnout na noc (😴)", power: 1000, members: [["Boiler", ["Pump"]]] },
        { name: "Others", power: 350, members: [["Washer", []], ["Fridge", []]] },
    ]);
});

test("empty groups and Others follow their settings", async ({ page }) => {
    await mountSection(page, { device_groupings: GROUPINGS, show_empty_groups: true, show_others_group: false });

    expect((await groupedBy(page, "Jističe")).map(({ name, power }) => [name, power])).toEqual([
        ["Technická FV (🔋T)", 1100],
        ["Technická síť (⚡T)", 200],
    ]);
});

test("without groupings there are no chips", async ({ page }) => {
    await mountSection(page, { device_groupings: [] });

    expect(await chips(page)).toEqual([]);
});

test("a group whose id is others keeps apart from the Others group", async ({ page }) => {
    const groupings = [
        { id: "breakers", name: "Jističe", groups: [{ id: "others", name: "Ostatní jističe", short_name: "O" }] },
    ];
    await mountSection(page, { device_groupings: groupings, show_empty_groups: true, others_group_label: "Others" });

    expect((await groupedBy(page, "Jističe")).map(({ name }) => name)).toEqual(["Ostatní jističe (O)", "Others"]);
    const ids = await page.evaluate(() => {
        const el = document.querySelector("helman-house-devices-section") as any;
        return (el.shadowRoot.querySelector("helman-tree-item-list").devices as any[]).map((group) => group.id);
    });
    expect(new Set(ids).size).toBe(2);
});
