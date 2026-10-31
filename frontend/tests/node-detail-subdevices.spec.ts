import { test, expect, type Page } from "@playwright/test";
import { prepareNodeDetailPage, mountSimpleCard, treeNode } from "./support/node-detail-harness";
import { treePayload } from "./support/payload-builders";
import type { TreeItemDTO } from "../cards/helman-api";

/**
 * The Subdevices list on a device's detail: the device's direct children, idle
 * ones too, by power and then by name, each with its share of the device's
 * headline. Collapsed, the three largest and everything else; expanded, every
 * one, what no meter explains and Show less. A row opens its child's detail;
 * a device without children says it has none.
 */

declare global {
    interface Window {
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
    }
}

const device = (name: string, overrides: Partial<TreeItemDTO> = {}) => {
    const key = name.toLowerCase().replace(/ /g, "_");
    return treeNode({ id: `sensor.${key}_energy`, displayName: name, energyEntityId: `sensor.${key}_energy`, powerSensorId: `sensor.${key}_power`, ...overrides });
};

const TREE = treePayload({
    sources: [treeNode({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
    consumers: [treeNode({
        id: "house", displayName: "House", powerSensorId: "sensor.house", childrenFullWidth: true,
        children: [
            device("Panel", {
                children: [
                    device("Toaster"), device("Light"), device("Kettle"), device("Oven"), device("Fridge"),
                    treeNode({ id: "panel_unmeasured", displayName: "", powerSensorId: "sensor.helman_unmeasured_power_panel", isUnmeasured: true }),
                ],
            }),
            device("Lamp"),
            device("Workshop", {
                children: [
                    // An energy-only circuit reads what its own subdevices do.
                    device("Bench circuit", { powerSensorId: null, children: [device("Drill"), device("Saw")] }),
                    // A power sensor that is the kWh meter is no power sensor.
                    device("Old meter", { powerSensorId: "sensor.old_meter_energy" }),
                    device("Shed", { children: [device("Heater"), device("Bulb")] }),
                ],
            }),
        ],
    })],
    uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
});

async function mount(page: Page): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate((tree) => {
        window.__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
        const s = window.__nodeDetailState;
        // 1.8 kW of children in a 2 kW panel leave 200 W no meter explains; the backend's remainder reads 90 W.
        const states: Record<string, any> = {
            "sensor.solar": s("0", "W"), "sensor.house": s("2000", "W"),
            "sensor.panel_power": s("2000", "W"), "sensor.lamp_power": s("0", "W"),
            "sensor.oven_power": s("1.2", "kW"), "sensor.kettle_power": s("300", "W"), "sensor.fridge_power": s("300", "W"),
            "sensor.light_power": s("0", "W"), "sensor.toaster_power": s("unavailable"),
            "sensor.helman_unmeasured_power_panel": s("90", "W"),
            "sensor.workshop_power": s("1500", "W"), "sensor.drill_power": s("600", "W"), "sensor.saw_power": s("400", "W"),
            "sensor.old_meter_energy": s("1234", "kWh"),
            // The shed's meter lags its heater: a 0 W headline over 200 W of children.
            "sensor.shed_power": s("0", "W"), "sensor.heater_power": s("200", "W"), "sensor.bulb_power": s("0", "W"),
        };
        for (const [id, state] of Object.entries(states)) state.entity_id = id;
        window.__configureNodeDetail({
            tree, states,
            hass: { user: { is_admin: false } },
            replies: { "helman/get_device_stats": null, "recorder/statistic_during_period": { change: 1 } },
        });
    }, TREE);
    await mountSimpleCard(page, undefined, "helman-card");
    await expect.poll(() => page.evaluate(() => window.__deepAll(document, "helman-tree-item").length)).toBeGreaterThan(2);
}

/** Open the device named `name` from its row in the card's tree. */
async function openDevice(page: Page, name: string): Promise<void> {
    await expect.poll(() => page.evaluate((name) => {
        const row = window.__deepAll(document, "helman-tree-item").find((candidate) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === name);
        if (!row) return false;
        (row.shadowRoot!.querySelector(".deviceName") as HTMLElement).click();
        return true;
    }, name)).toBe(true);
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText(name);
}

const list = (page: Page) => page.locator("node-detail-device-content helman-subdevice-list");
const names = (page: Page) => list(page).locator(".user-row .user-name");
const amount = (page: Page, name: string | RegExp) => list(page).locator(".user-row", { has: page.locator(".user-name", { hasText: name }) }).locator(".user-amount");

test("a device lists its direct children by power, then by name, three and everything else", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Panel");
    await expect(list(page).locator(".section-title")).toHaveText("Subdevices");
    // Fridge and Kettle tie at 300 W; the idle light, the toaster without a reading and the remainder are everything else.
    await expect(names(page)).toHaveText(["Oven", "Fridge", "Kettle", "Everything else · 3 more"]);
    await expect(amount(page, "Oven")).toContainText("1.2 kW 60 %");
    await expect(amount(page, /Everything else/)).toContainText("200 W 10 %");
    expect(await list(page).locator("button.user-row").first().evaluate((row) => row.getBoundingClientRect().height)).toBe(32);
});

test("expanded, a device lists its idle children and what no meter explains, and folds back", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Panel");
    await list(page).getByRole("button", { name: /Everything else/ }).click();
    await expect(names(page)).toHaveText(["Oven", "Fridge", "Kettle", "Light", "Toaster", "Not measured"]);
    await expect(amount(page, "Light")).toHaveText(/0 W\s+0 %/);
    await expect(amount(page, "Toaster")).toHaveText("—");
    // The headline less the rows, not the backend's remainder sensor.
    await expect(amount(page, "Not measured")).toContainText("200 W 10 %");
    await list(page).getByRole("button", { name: "Show less" }).click();
    await expect(names(page)).toHaveText(["Oven", "Fridge", "Kettle", "Everything else · 3 more"]);
});

test("a subdevice row opens that child's detail", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Panel");
    await list(page).getByRole("button", { name: /Kettle/ }).click();
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText("Kettle");
    await expect(list(page)).toContainText("No subdevices for this device");
});

test("a device without children says it has none", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Lamp");
    await expect(list(page).locator(".section-title")).toHaveText("Subdevices");
    await expect(list(page).locator("[data-no-subdevices]")).toHaveText("No subdevices for this device");
    await expect(list(page).locator(".user-row")).toHaveCount(0);
});

test("a device's child rows follow their power sensors", async ({ page }) => {
    await mount(page);
    // The card walks the whole tree, so a state push alone cannot tell a watched child from an unwatched one: the detail's own watch must name it.
    await page.evaluate(() => {
        (window as any).__watched = [];
        window.addEventListener("helman-watched-entities", (event) => {
            const { source, entityIds } = (event as CustomEvent).detail;
            if (source === "node-detail") (window as any).__watched = entityIds;
        });
    });
    await openDevice(page, "Panel");
    await expect.poll(() => page.evaluate(() => (window as any).__watched)).toContain("sensor.kettle_power");
    await expect(amount(page, "Kettle")).toContainText("300 W");
    await page.evaluate(async () => {
        const hass = window.__NodeDetailHass;
        const states = { ...hass.states, "sensor.kettle_power": { ...hass.states["sensor.kettle_power"], state: "450" } };
        window.__NodeDetailHass = { ...hass, states };
        const card: any = document.querySelector("helman-simple-card, helman-card");
        card.hass = { ...window.__NodeDetailHass };
        await card.updateComplete;
    });
    await expect(amount(page, "Kettle")).toContainText("450 W");
});

test("an energy-only child reads its own subdevices, and a kWh meter reads as no power", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Workshop");
    // Three children need no folding: all of them, and the 500 W no meter explains.
    await expect(names(page)).toHaveText(["Bench circuit", "Old meter", "Shed", "Not measured"]);
    await expect(amount(page, "Bench circuit")).toContainText("1.0 kW 67 %");
    await expect(amount(page, "Old meter")).toHaveText("—");
    await expect(amount(page, "Not measured")).toContainText("500 W 33 %");
    await expect(list(page).getByRole("button", { name: /Everything else|Show less/ })).toHaveCount(0);
});

test("a headline lagging its children still gives each its share", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Workshop");
    await list(page).getByRole("button", { name: /Shed/ }).click();
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText("Shed");
    // Nothing is left unexplained, so no Not measured row, and no Everything else for two children.
    await expect(names(page)).toHaveText(["Heater", "Bulb"]);
    await expect(amount(page, "Heater")).toContainText("200 W 100 %");
    await expect(amount(page, "Bulb")).toHaveText(/0 W\s+0 %/);
});

test("a list without its node, as before the tree loads, shows nothing", async ({ page }) => {
    await mount(page);
    const html = await page.evaluate(async () => {
        const element = document.createElement("helman-subdevice-list") as any;
        element.hass = window.__NodeDetailHass;
        element.localize = (key: string) => key;
        element.parent = null;
        document.body.append(element);
        await element.updateComplete;
        return element.shadowRoot.innerHTML.replace(/<!--[^>]*-->/g, "").trim();
    });
    expect(html).toBe("");
});
