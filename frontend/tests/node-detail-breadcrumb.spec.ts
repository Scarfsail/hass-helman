import { test, expect, type Page } from "@playwright/test";
import { prepareNodeDetailPage, mountSimpleCard, treeNode } from "./support/node-detail-harness";
import { treePayload } from "./support/payload-builders";
import type { TreeItemDTO } from "../cards/helman-api";

/**
 * The breadcrumb at the top of a device's detail: House, then every config
 * device above it, down to its direct parent. A switched parent's icon carries
 * its switch's state; a parent without one shows its own icon untinted. A
 * segment opens its node's detail in the same dialog.
 */

declare global {
    interface Window {
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
    }
}

const ON = "rgb(10, 20, 30)";
const SECONDARY = "rgb(40, 50, 60)";
const PRIMARY = "rgb(70, 80, 90)";

const device = (name: string, overrides: Partial<TreeItemDTO>) => {
    const key = name.toLowerCase().replace(/ /g, "_");
    return treeNode({ id: `sensor.${key}_energy`, displayName: name, energyEntityId: `sensor.${key}_energy`, powerSensorId: `sensor.${key}_power`, ...overrides });
};

const TREE = treePayload({
    sources: [treeNode({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
    consumers: [treeNode({
        id: "house", displayName: "House", powerSensorId: "sensor.house", childrenFullWidth: true,
        children: [
            device("Main distribution panel", {
                icon: "mdi:flash", switchEntityId: "switch.panel",
                children: [device("Kitchen circuit breaker", {
                    icon: "mdi:fuse", switchEntityId: "switch.kitchen",
                    children: [device("Kettle", { icon: "mdi:kettle" })],
                }), device("Garage", { icon: "mdi:garage", switchEntityId: "switch.garage", children: [device("Heater", { icon: "mdi:radiator" })] })],
            }),
            device("Pumps", {
                icon: "mdi:pump",
                children: [treeNode({ id: "pump", displayName: "Pump", isEstimated: true, powerSensorId: "sensor.pump_share" })],
            }),
            device("Lamp", { switchEntityId: "switch.lamp" }),
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
        customElements.define("ha-state-icon", class extends HTMLElement {
            set stateObj(value: any) { this.setAttribute("data-state", value?.state ?? ""); }
        });
        const s = window.__nodeDetailState;
        const states: Record<string, any> = {
            "sensor.solar": s("0", "W"), "sensor.house": s("800", "W"),
            "switch.panel": s("on"), "switch.kitchen": s("off"), "switch.lamp": s("on"), "switch.garage": s("unavailable"),
        };
        for (const [id, state] of Object.entries(states)) state.entity_id = id;
        window.__configureNodeDetail({
            tree, states,
            hass: { user: { is_admin: false } },
            replies: { "helman/get_device_stats": null, "recorder/statistic_during_period": { change: 1 } },
        });
    }, TREE);
    await page.addStyleTag({ content: `html { --state-switch-on-color: ${ON}; --secondary-text-color: ${SECONDARY}; --primary-text-color: ${PRIMARY}; }` });
    await mountSimpleCard(page, undefined, "helman-card");
    await expect.poll(() => page.evaluate(() => window.__deepAll(document, "helman-tree-item").length)).toBeGreaterThan(2);
}

/** Expand `parents` in order, then open the device named `name` from its row. */
async function openDevice(page: Page, name: string, parents: string[] = []): Promise<void> {
    for (const parent of [...parents, name]) {
        await expect.poll(() => page.evaluate(({ parent, open }) => {
            const row = window.__deepAll(document, "helman-tree-item").find((candidate) =>
                (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === parent);
            if (!row) return false;
            (row.shadowRoot!.querySelector(open ? ".deviceName" : ".childrenToggle") as HTMLElement).click();
            return true;
        }, { parent, open: parent === name })).toBe(true);
    }
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText(name);
}

const segments = (page: Page) => page.locator("node-detail-dialog helman-node-breadcrumb button");

test("a nested device lists House and every parent, top down", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Kettle", ["Main distribution panel", "Kitchen circuit breaker"]);
    await expect(segments(page).locator(".label")).toHaveText(["House", "Main distribution panel", "Kitchen circuit breaker"]);
});

test("a device directly under the house shows House only", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Lamp");
    await expect(segments(page).locator(".label")).toHaveText(["House"]);
});

test("a switched parent's icon carries its state, an unswitched one its own icon untinted", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Kettle", ["Main distribution panel", "Kitchen circuit breaker"]);
    const [house, panel, kitchen] = [segments(page).nth(0), segments(page).nth(1), segments(page).nth(2)];
    await expect(panel).toHaveAttribute("aria-label", "Main distribution panel, on");
    await expect(panel.locator("ha-state-icon")).toHaveAttribute("data-state", "on");
    await expect(panel.locator("ha-state-icon")).toHaveCSS("color", ON);
    await expect(kitchen).toHaveAttribute("aria-label", "Kitchen circuit breaker, off");
    await expect(kitchen.locator("ha-state-icon")).toHaveCSS("color", SECONDARY);
    await expect(house).toHaveAttribute("aria-label", "House");
    await expect(house.locator("ha-icon")).toHaveJSProperty("icon", "mdi:home");
    await expect(house.locator("ha-icon")).toHaveCSS("color", PRIMARY);

    // The switch's state follows HA live.
    await page.evaluate(() => {
        const card = document.querySelector("helman-card") as any;
        card.hass = { ...window.__NodeDetailHass, states: {
            ...window.__NodeDetailHass.states,
            "switch.panel": { ...window.__NodeDetailHass.states["switch.panel"], state: "off" },
        } };
    });
    await expect(panel).toHaveAttribute("aria-label", "Main distribution panel, off");
    await expect(panel.locator("ha-state-icon")).toHaveCSS("color", SECONDARY);

    await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
    await openDevice(page, "Pump", ["Pumps"]);
    const pumps = segments(page).nth(1);
    await expect(pumps).toHaveAttribute("aria-label", "Pumps");
    await expect(pumps.locator("ha-state-icon")).toHaveCount(0);
    await expect(pumps.locator("ha-icon")).toHaveJSProperty("icon", "mdi:pump");
    await expect(pumps.locator("ha-icon")).toHaveCSS("color", PRIMARY);
});

test("a switch in neither state shows its icon untinted and names no state", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Heater", ["Main distribution panel", "Garage"]);
    const garage = segments(page).nth(2);
    await expect(garage).toHaveAttribute("aria-label", "Garage");
    await expect(garage.locator("ha-state-icon")).toHaveAttribute("data-state", "unavailable");
    await expect(garage.locator("ha-state-icon")).toHaveCSS("color", PRIMARY);
});

test("a device's switch tile starts below the strip, never over it", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Lamp");
    const strip = await page.locator("node-detail-dialog helman-node-breadcrumb").boundingBox();
    const tile = await page.locator("node-detail-dialog helman-switch-tile button").boundingBox();
    expect(tile!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height);
});

test("a segment opens its node's detail in the same dialog", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Kettle", ["Main distribution panel", "Kitchen circuit breaker"]);
    const historyLength = await page.evaluate(() => window.history.length);
    await segments(page).nth(2).click();
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText("Kitchen circuit breaker");
    await expect(segments(page).locator(".label")).toHaveText(["House", "Main distribution panel"]);
    await segments(page).first().click();
    await expect(page.locator("node-detail-dialog [slot=headerTitle]")).toHaveText("House");
    await expect(page.locator("node-detail-dialog helman-node-breadcrumb")).toHaveCount(0);
    await expect(page.locator("node-detail-dialog")).toHaveCount(1);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});

test("at phone width only the labels truncate, every icon stays whole", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await mount(page);
    await openDevice(page, "Kettle", ["Main distribution panel", "Kitchen circuit breaker"]);
    const layout = await page.locator("node-detail-dialog helman-node-breadcrumb").evaluate((strip) => {
        const buttons = Array.from(strip.shadowRoot!.querySelectorAll("button"));
        return {
            pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            truncated: buttons.some((button) => {
                const label = button.querySelector(".label")!;
                return label.scrollWidth > label.clientWidth;
            }),
            icons: buttons.map((button) => {
                const box = button.getBoundingClientRect();
                const icon = button.querySelector(".icon")!.getBoundingClientRect();
                return icon.width === 16 && icon.left >= box.left && icon.right <= box.right;
            }),
        };
    });
    expect(layout).toEqual({ pageScroll: false, truncated: true, icons: [true, true, true] });
});
