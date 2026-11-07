import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { treeNode, treePayload } from "./support/payload-builders";

/**
 * `show_empty_groups` and `show_others_group` are options of each `helman-card`
 * (#414): two cards on one dashboard group the same house devices their own
 * way, an unset flag reads as its default, and a config change regroups at once.
 */

const GROUPINGS = [
    {
        id: "room",
        name: "Room",
        groups: [
            { id: "kitchen", name: "Kitchen", short_name: "K" },
            { id: "garage", name: "Garage", short_name: "G" },
        ],
    },
];

function tree() {
    const device = (id: string, groups: Record<string, string> = {}) =>
        treeNode({ id, displayName: id, powerSensorId: `sensor.${id}`, groups });
    return treePayload({
        sources: [
            treeNode({ id: "solar", displayName: "solar", powerSensorId: "sensor.solar", sourceType: "solar", isSource: true }),
        ],
        consumers: [
            treeNode({
                id: "house",
                displayName: "house",
                powerSensorId: "sensor.house",
                children: [device("washer", { room: "kitchen" }), device("fridge")],
            }),
        ],
        uiConfig: { device_groupings: GROUPINGS, history_buckets: 3, history_bucket_duration: 60 },
    });
}

async function mountCards(page: Page, configs: Record<string, unknown>[]): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installMockHass(page);
    await page.evaluate((payload) => {
        (window as any).__hass = {
            ...window.__mockHass({
                "helman/get_device_tree": payload,
                "helman/get_history": { entity_history: {} },
                "helman/get_node_detail": { entities: {} },
            }),
            language: "en", locale: { language: "en" }, config: { time_zone: "UTC" }, states: {},
        };
    }, tree());
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.evaluate((configs) => {
        for (const config of configs) {
            const card = document.createElement("helman-card") as any;
            card.setConfig({ type: "custom:helman-card", ...config });
            card.hass = (window as any).__hass;
            document.body.appendChild(card);
        }
    }, configs);
}

/** Group the card's house devices by Room, once, and list the rows it shows. */
async function groupRows(page: Page, index: number): Promise<string[] | null> {
    return page.evaluate(async (index) => {
        const card = document.querySelectorAll("helman-card")[index] as any;
        await card.updateComplete;
        const section = card.shadowRoot?.querySelector("helman-house-devices-section") as any;
        if (!section) return null;
        await section.updateComplete;
        const chip = section.shadowRoot.querySelector("button.chip:not(.show-toggle)") as HTMLButtonElement | null;
        if (!chip) return null;
        if (!chip.classList.contains("active")) {
            chip.click();
            await section.updateComplete;
        }
        const list = section.shadowRoot.querySelector("helman-tree-item-list") as any;
        return (list.devices as any[]).map((row) => row.name);
    }, index);
}

test("two cards group the same devices by their own options, unset ones by the defaults", async ({ page }) => {
    await mountCards(page, [{}, { show_empty_groups: true, show_others_group: false }]);

    await expect.poll(() => groupRows(page, 0)).toEqual(["Kitchen (K)", "Others"]);
    await expect.poll(() => groupRows(page, 1)).toEqual(["Kitchen (K)", "Garage (G)"]);
});

test("a config change regroups at once, and an explicit false hides Others", async ({ page }) => {
    await mountCards(page, [{}]);
    await expect.poll(() => groupRows(page, 0)).toEqual(["Kitchen (K)", "Others"]);

    await page.evaluate(() => {
        const card = document.querySelector("helman-card") as any;
        card.setConfig({ type: "custom:helman-card", show_others_group: false, show_empty_groups: true });
    });

    expect(await groupRows(page, 0)).toEqual(["Kitchen (K)", "Garage (G)"]);
});

test("the card editor shows the group options at their defaults when unset", async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.evaluate(() => {
        const editor = (customElements.get("helman-card") as any).getConfigElement();
        editor.hass = { language: "en", locale: { language: "en" }, states: {} };
        editor.setConfig({ type: "custom:helman-card" });
        document.body.appendChild(editor);
    });
    const form = page.locator("helman-card-editor ha-form");

    await expect.poll(() => form.evaluate((element: any) => ({
        show_empty_groups: element.data.show_empty_groups,
        show_others_group: element.data.show_others_group,
        selectors: element.schema
            .filter((field: any) => field.name.startsWith("show_"))
            .map((field: any) => [field.name, Object.keys(field.selector)[0]]),
    }))).toEqual({
        show_empty_groups: false,
        show_others_group: true,
        selectors: [["show_empty_groups", "boolean"], ["show_others_group", "boolean"]],
    });
    expect(await form.evaluate((element: any) => element.computeHelper({ name: "show_others_group" })))
        .toContain("Group by");
});
