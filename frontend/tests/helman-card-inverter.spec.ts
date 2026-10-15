import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { loadBundle } from "./support/card-page";
import { treeNode, treePayload } from "./support/payload-builders";
import type { TreeItemDTO } from "../cards/helman-api";

/**
 * The inverter from the power card's distribution row.
 *
 * The full card's central "Distribution" aggregate is where the source and
 * consumer flows meet, so it carries the simple card's inverter cell, with the
 * commanded mode, opening the same inverter detail. Mounted on the real
 * `helman-card` against a fake backend that answers the device tree, the
 * schedule and `helman/get_node_detail` with an inverter that has no hardware
 * profile; the inverter detail itself is pinned in `node-detail-inverter.spec.ts`.
 */

/** A tree DTO with the defaults the backend fills in. */
function dto(overrides: Partial<TreeItemDTO>) {
    return treeNode(overrides);
}

async function mountCard(page: Page): Promise<void> {
    await loadBundle(page, "helman-card");
    await page.addScriptTag({ content: HA_DIALOG_STUB });

    const tree = treePayload({
        sources: [
            dto({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" }),
            dto({ id: "battery", displayName: "Battery", powerSensorId: "sensor.battery", isSource: true, sourceType: "battery" }),
        ],
        consumers: [dto({ id: "house", displayName: "House", powerSensorId: "sensor.house" })],
        consumptionTotalSensorId: null,
        productionTotalSensorId: null,
        uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
    });

    await page.evaluate(async (tree) => {
        const state = (value: string, unit?: string) => ({ state: value, attributes: unit ? { unit_of_measurement: unit } : {} });
        (window as any).__moreInfo = [];
        document.addEventListener("hass-more-info", (event: Event) => {
            (window as any).__moreInfo.push((event as CustomEvent).detail?.entityId);
        });
        const overview = {
            node: "inverter",
            asOf: "2026-10-21T12:00:00+00:00",
            configured: true,
            profile: null,
            mode: { entityId: "select.helman_inverter_mode", actionOptions: { normal: "normal", stop_charging: "stop_charging" } },
            entities: { battery_min_soc: "number.min_soc", battery_max_soc: "number.max_soc" },
            maxAllowedExportPower: null,
            agreement: { status: "unknown", reason: "no_profile", commanded: "normal", observedOption: null, observedFrom: [], registers: [] },
            condition: null,
            sections: [],
        };
        const hass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async () => ({}),
                subscribeMessage: window.__mockHass().connection.subscribeMessage,
            },
            states: {
                "sensor.solar": state("4200", "W"),
                "sensor.battery": state("500", "W"),
                "sensor.house": state("1200", "W"),
                "number.min_soc": state("10", "%"),
                "number.max_soc": state("100", "%"),
                "select.helman_inverter_mode": state("normal"),
            },
            callWS: window.__mockHass({
                "helman/get_device_tree": async (msg: {
                    type: string;
                    section?: string;
                }) => {
                    return tree;
                },
                "helman/get_history": async (msg: {
                    type: string;
                    section?: string;
                }) => {
                    return { entity_history: {} };
                },
                "helman/get_node_detail": async (msg: {
                    type: string;
                    section?: string;
                }) => {
                    if (msg.section)
                        throw new Error("no sections without a profile");
                    return overview;
                }
            }).callWS,
        };
        const card = document.createElement("helman-card") as any;
        await card.setConfig({ type: "custom:helman-card" });
        card.hass = hass;
        (window as any).__hass = hass;
        document.body.appendChild(card);
    }, tree);

    await expect(button(page)).toBeVisible();
}

const button = (page: Page) => page.locator("helman-tree-item helman-inverter-cell .inverter-cell");
const content = (page: Page) => page.locator("node-detail-inverter-content");
const dialog = (page: Page) => page.locator("node-detail-dialog ha-dialog");

/** The distribution row's geometry: the button, the row, its title and its power reading. */
function layout(page: Page) {
    return page.evaluate(() => {
        const row = Array.from(document.querySelector("helman-card")!.shadowRoot!.querySelectorAll("helman-tree-item-list"))
            .flatMap((list) => Array.from(list.shadowRoot!.querySelectorAll("helman-tree-item")))
            .find((item: any) => item.device?.id === "consumers")!;
        const root = row.shadowRoot!;
        const rect = (element: Element) => {
            const { left, right, top, bottom } = element.getBoundingClientRect();
            return { left, right, top, bottom };
        };
        const cellElement = root.querySelector("helman-inverter-cell")!;
        const buttonRect = rect(cellElement.shadowRoot!.querySelector(".inverter-cell")!);
        const display = root.querySelector("helman-tree-item-power-display")!;
        const hit = root.elementFromPoint((buttonRect.left + buttonRect.right) / 2, (buttonRect.top + buttonRect.bottom) / 2);
        return {
            row: rect(root.querySelector(".deviceContent")!),
            button: buttonRect,
            name: rect(root.querySelector(".deviceName")!),
            nameText: root.querySelector(".deviceName")!.textContent!.trim(),
            power: rect(display.shadowRoot!.querySelector(".powerDisplay")!),
            powerText: display.shadowRoot!.querySelector(".powerValue")!.textContent!.replace(/\s+/g, " ").trim(),
            unobstructed: hit === cellElement || cellElement.contains(hit),
        };
    });
}

type Box = { left: number; right: number; top: number; bottom: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.describe("the distribution row's inverter cell", () => {
    test("is a single labelled button, on the distribution root only", async ({ page }) => {
        await mountCard(page);
        await expect(button(page)).toHaveCount(1);
        await expect(button(page)).toHaveAttribute("aria-label", "Inverter: Normal");
        await expect(button(page)).toHaveAttribute("title", "Inverter: Normal");
        const owner = await button(page).evaluate((element) => {
            const cell = (element.getRootNode() as ShadowRoot).host;
            return ((cell.getRootNode() as ShadowRoot).host as any).device.id;
        });
        expect(owner).toBe("consumers");
    });

    test("shows the commanded mode, live", async ({ page }) => {
        await mountCard(page);
        await expect(button(page).locator(".inverter-mode")).toHaveText("Normal");
        await page.evaluate(() => {
            const previous = (window as any).__hass;
            const hass = {
                ...previous,
                states: { ...previous.states, "select.helman_inverter_mode": { state: "stop_charging", attributes: {} } },
            };
            (document.querySelector("helman-card") as any).hass = hass;
        });
        await expect(button(page).locator(".inverter-mode")).toHaveText("No charging");
    });

    for (const width of [1200, 320]) {
        test(`is centred and clear of the title and the power at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await mountCard(page);
            const box = await layout(page);
            const rowCentre = (box.row.left + box.row.right) / 2;
            expect(Math.abs((box.button.left + box.button.right) / 2 - rowCentre)).toBeLessThanOrEqual(1);
            expect(box.button.top).toBeGreaterThanOrEqual(box.row.top);
            expect(box.button.bottom).toBeLessThanOrEqual(box.row.bottom);
            expect(overlaps(box.button, box.name)).toBe(false);
            expect(overlaps(box.button, box.power)).toBe(false);
            expect(box.unobstructed).toBe(true);
            // The row keeps its title and its reading.
            expect(box.nameText).toBe("Distribution");
            expect(box.powerText).toMatch(/\d.*W$/);
        });
    }

    test("opens the inverter detail by mouse, closes, and reopens", async ({ page }) => {
        await mountCard(page);
        await button(page).click();
        await expect(content(page).locator("[data-overview]")).toBeVisible();
        await expect(dialog(page)).toHaveJSProperty("heading", "Inverter");

        await dialog(page).evaluate((element: any) => element.close());
        await expect(content(page)).toHaveCount(0);

        await button(page).click();
        await expect(content(page).locator("[data-overview]")).toBeVisible();
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([]);
    });

    for (const key of ["Enter", "Space"]) {
        test(`opens the inverter detail with ${key}`, async ({ page }) => {
            await mountCard(page);
            await button(page).focus();
            await page.keyboard.press(key);
            await expect(content(page).locator("[data-overview]")).toBeVisible();
            expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([]);
        });
    }
});

test("live history and detail context use watts for mixed-case power units", async ({ page }) => {
    await mountCard(page);
    const values = await page.evaluate(() => {
        const card = document.querySelector("helman-card") as any;
        const hass = (window as any).__hass;
        hass.states["sensor.house"] = { state: "2.4", attributes: { unit_of_measurement: "KW" } };
        hass.states["sensor.solar"] = { state: "4.2", attributes: { unit_of_measurement: "kW" } };
        card.hass = { ...hass };
        card._historyEngine.advanceBuckets(card._computedNodes.sourcesChildren, card._computedNodes.sourcesChildren);
        card._historyEngine.advanceBuckets(card._computedNodes.consumersChildren, card._computedNodes.sourcesChildren);
        const context = card._buildNodeDetailContext();
        return { housePower: context.housePower, solarPower: context.solarPower, solarPowerReading: context.solarPowerReading };
    });
    expect(values).toEqual({ housePower: 2400, solarPower: 4200, solarPowerReading: 4200 });
});
