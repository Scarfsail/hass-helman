import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { loadBundle } from "./support/card-page";
import { treeNode, treePayload } from "./support/payload-builders";

/**
 * `helman-entity-detail` is how another dashboard's card opens a Helman device
 * detail by entity id instead of HA's more-info.
 *
 * Its static `entityIds` lists the entities that open a detail: a config
 * device's switch, power sensor, meter and climate entity, and nothing of the
 * rows that are not devices -- the house, the sources root, the unmeasured
 * remainder. Mounted with one of them it opens that device's detail; closing it
 * fires a non-bubbling `closed`. An entity that no longer maps to a device gets
 * HA's more-info, then `closed`.
 */

const TREE = treePayload({
    sources: [treeNode({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
    consumers: [
        treeNode({
            id: "house",
            displayName: "House",
            powerSensorId: "sensor.house",
            children: [
                treeNode({
                    id: "sensor.boiler_energy",
                    displayName: "Boiler",
                    powerSensorId: "sensor.boiler_power",
                    switchEntityId: "switch.boiler",
                    energyEntityId: "sensor.boiler_energy",
                    children: [
                        treeNode({
                            id: "heat_pump",
                            displayName: "Heat pump",
                            powerSensorId: "sensor.heat_pump_share",
                            climateEntityId: "climate.heat_pump",
                            controllableIds: ["heat_pump"],
                            isEstimated: true,
                        }),
                    ],
                }),
                treeNode({
                    id: "house_unmeasured",
                    displayName: "",
                    powerSensorId: "sensor.house_unmeasured",
                    isUnmeasured: true,
                }),
            ],
        }),
    ],
    uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
});

/** Load the bundle with HA's stubs and put a hass answering the tree on `window.__hass`. */
async function setup(page: Page): Promise<void> {
    await loadBundle(page, "helman-entity-detail");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((tree) => {
        (window as any).loadCardHelpers = async () => ({ createCardElement: () => document.createElement("div") });
        (window as any).__events = [];
        document.addEventListener("hass-more-info", (event: Event) => {
            (window as any).__events.push(`hass-more-info:${(event as CustomEvent).detail?.entityId}`);
        });
        const state = (value: string) => ({ state: value, attributes: {} });
        (window as any).__hass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            user: { is_admin: false },
            connection: {
                sendMessagePromise: async () => ({}),
                subscribeMessage: window.__mockHass().connection.subscribeMessage,
            },
            states: {
                "sensor.solar": state("0"),
                "sensor.house": state("2000"),
                "sensor.boiler_power": state("1200"),
                "sensor.boiler_energy": state("10"),
                "sensor.heat_pump_share": state("300"),
                "sensor.house_unmeasured": state("500"),
                "switch.boiler": state("on"),
            },
            callWS: window.__mockHass({
                "helman/get_device_tree": async () => tree,
                "helman/get_history": async () => ({ entity_history: {} }),
            }).callWS,
        };
    }, TREE);
}

/** Append the element for `entityId`, recording its `closed` and whether it bubbled to the body. */
async function mount(page: Page, entityId: string): Promise<void> {
    await page.evaluate((entityId) => {
        document.body.addEventListener("closed", () => (window as any).__events.push("closed-bubbled"));
        const element = document.createElement("helman-entity-detail") as any;
        element.addEventListener("closed", () => (window as any).__events.push("closed"));
        element.hass = (window as any).__hass;
        element.entityId = entityId;
        document.body.appendChild(element);
    }, entityId);
}

const dialog = (page: Page) => page.locator("helman-entity-detail node-detail-dialog ha-dialog");
const events = (page: Page) => page.evaluate(() => (window as any).__events as string[]);

test("entityIds lists the config devices' switch, power, energy and climate entities, and nothing else", async ({ page }) => {
    await setup(page);
    const ids = await page.evaluate(async () => {
        const element = customElements.get("helman-entity-detail") as any;
        return [...await element.entityIds((window as any).__hass)].sort();
    });
    expect(ids).toEqual([
        "climate.heat_pump",
        "sensor.boiler_energy",
        "sensor.boiler_power",
        "sensor.heat_pump_share",
        "switch.boiler",
    ]);
});

test("mounted with a device's switch it opens that device's detail, and closing it fires closed", async ({ page }) => {
    await setup(page);
    await mount(page, "switch.boiler");

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveJSProperty("heading", "Boiler");

    await dialog(page).evaluate((element: any) => element.close());
    await expect.poll(() => events(page)).toEqual(["closed"]);
    await expect(page.locator("helman-entity-detail node-detail-dialog")).toHaveCount(0);
});

test("a schedule lane's device icon swaps the open detail to that device without firing closed", async ({ page }) => {
    await setup(page);
    await mount(page, "switch.boiler");
    await expect(dialog(page)).toHaveJSProperty("heading", "Boiler");

    await page.locator("helman-entity-detail node-detail-dialog").evaluate((element) => {
        element.dispatchEvent(new CustomEvent("show-controllable-detail", {
            detail: { controllableId: "heat_pump", entityId: "climate.heat_pump" },
            bubbles: true,
            composed: true,
        }));
    });

    await expect(dialog(page)).toHaveJSProperty("heading", "Heat pump");
    expect(await events(page)).toEqual([]);
});

test("an entity that maps to no device gets more-info, then closed", async ({ page }) => {
    await setup(page);
    await mount(page, "sensor.house");

    await expect.poll(() => events(page)).toEqual(["hass-more-info:sensor.house", "closed"]);
    await expect(page.locator("helman-entity-detail node-detail-dialog")).toHaveCount(0);
});

test("a config refresh that removes the open device closes the detail and fires closed", async ({ page }) => {
    await setup(page);
    await mount(page, "switch.boiler");
    await expect(dialog(page)).toBeVisible();

    await page.evaluate((tree) => {
        window.__setMockReply((window as any).__hass, "helman/get_device_tree", tree);
        window.__fireDataChanged("config");
    }, treePayload({ uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 5 } }));

    await expect.poll(() => events(page)).toEqual(["closed"]);
    await expect(page.locator("helman-entity-detail node-detail-dialog")).toHaveCount(0);
});

test("a failed load gets more-info, then closed", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.__setMockReply((window as any).__hass, "helman/get_device_tree", new Error("not ready")));
    await mount(page, "switch.boiler");

    await expect.poll(() => events(page)).toEqual(["hass-more-info:switch.boiler", "closed"]);
    await expect(page.locator("helman-entity-detail node-detail-dialog")).toHaveCount(0);
});
