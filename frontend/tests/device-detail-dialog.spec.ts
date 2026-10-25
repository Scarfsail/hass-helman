import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { loadBundle } from "./support/card-page";
import { treeNode, treePayload } from "./support/payload-builders";
import type { TreeItemDTO } from "../cards/helman-api";

/**
 * A device box's name opens that device's detail.
 *
 * The name used to toggle the box's children; that job moved to a chevron in
 * front of it, so the name is free to open one dialog per config device: its
 * live power and switch, the energy its own meter counted today and in the last
 * hour, and HA's history graph. Rows that are not devices -- virtual label
 * groups, the unmeasured remainder -- keep toggling and open nothing.
 *
 * Home Assistant's own pieces are stubbed at the edge: `callWS` answers the
 * recorder's statistics, `window.loadCardHelpers` hands back an element that
 * records the history-graph config it was built with, and `ha-dialog` only
 * shows its content while open.
 */

const TODAY_KWH = 1.25;
const LAST_HOUR_KWH = 0.3;

/** Install the HA stubs every host needs: the dialog and the card helpers. */
async function installHaStubs(page: Page): Promise<void> {
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        (window as any).__chartConfigs = [];
        (window as any).loadCardHelpers = async () => ({
            createCardElement: (config: unknown) => {
                (window as any).__chartConfigs.push(config);
                const element = document.createElement("div");
                element.className = "history-graph-stub";
                return element;
            },
        });
        (window as any).__moreInfo = [];
        document.addEventListener("hass-more-info", (event: Event) => {
            (window as any).__moreInfo.push((event as CustomEvent).detail?.entityId);
        });
        // Every element matching a selector, through every shadow root below `root`.
        (window as any).__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
    });
}

/** A house child DTO with the defaults the backend fills in. */
function dto(overrides: Partial<TreeItemDTO>) {
    return treeNode({ childrenFullWidth: true, ...overrides });
}

/**
 * The power card on a house with a metered boiler, whose meter a meterless pump
 * shares, and an unmeasured remainder. The boiler carries a label the card can
 * group by, so a virtual group is one chip away.
 *
 * `stats` is what `helman/get_device_stats` answers per device key; a key it
 * lacks has no record. The tree lists controllable ids only for a schedulable
 * device, so `schedulableBoiler` gives the boiler one.
 */
async function mountCard(
    page: Page,
    stats: Record<string, unknown> = {},
    schedulableBoiler = false,
    energyUnit = "kWh",
    today = TODAY_KWH,
): Promise<void> {
    await loadBundle(page, "helman-card");
    await installHaStubs(page);

    const tree = treePayload({
        sources: [dto({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
        consumers: [
            dto({
                id: "house",
                displayName: "House",
                powerSensorId: "sensor.house",
                children: [
                    dto({
                        id: "sensor.boiler_energy",
                        displayName: "Boiler",
                        powerSensorId: "sensor.boiler_power",
                        switchEntityId: "switch.boiler",
                        energyEntityId: "sensor.boiler_energy",
                        icon: "mdi:water-boiler",
                        groups: { room: "kitchen" },
                        controllableIds: schedulableBoiler ? ["boiler"] : [],
                        children: [
                            dto({
                                id: "pump",
                                displayName: "Pump",
                                powerSensorId: "sensor.pump_share",
                                isEstimated: true,
                                controllableIds: ["pump"],
                            }),
                        ],
                    }),
                    dto({
                        id: "house_unmeasured",
                        displayName: "",
                        powerSensorId: "sensor.house_unmeasured",
                        isUnmeasured: true,
                    }),
                ],
            }),
        ],
        consumptionTotalSensorId: null,
        productionTotalSensorId: null,
        uiConfig: {
            show_others_group: true,
            device_groupings: [{ id: "room", name: "Room", groups: [{ id: "kitchen", name: "Kitchen", short_name: "K" }] }],
            history_buckets: 3,
            history_bucket_duration: 5,
        },
    });

    await page.evaluate(
        async ({ tree, today, lastHour, stats, energyUnit }) => {
            const state = (value: string, attributes: Record<string, unknown> = {}) => ({ state: value, attributes });
            (window as any).__statRequests = [];
            (window as any).__deviceStatsRequests = [];
            const hass = {
                language: "en",
                locale: { language: "en" },
                config: { time_zone: "UTC" },
                connection: {
                    sendMessagePromise: async () => ({}),
                    subscribeMessage: window.__mockHass().connection.subscribeMessage,
                },
                states: {
                    "sensor.solar": state("0"),
                    "sensor.house": state("2000"),
                    "sensor.boiler_power": state("1200", { unit_of_measurement: "W" }),
                    "sensor.boiler_energy": state("10", { unit_of_measurement: energyUnit }),
                    "sensor.pump_share": state("300"),
                    "sensor.house_unmeasured": state("500"),
                    "switch.boiler": { entity_id: "switch.boiler", state: "on", attributes: {} },
                },
                callWS: window.__mockHass({
                    "helman/get_device_tree": async (msg: any) => {
                        return tree;
                    },
                    "helman/get_history": async (msg: any) => {
                        return { entity_history: {} };
                    },
                    "helman/get_device_stats": async (msg: any) => {
                        (window as any).__deviceStatsRequests.push(msg.device_key);
                        return (stats as Record<string, unknown>)[msg.device_key] ?? null;
                    },
                    "recorder/statistic_during_period": async (msg: any) => {
                        (window as any).__statRequests.push(msg);
                        return { change: msg.calendar ? today : lastHour };
                    }
                }).callWS,
            };
            const card = document.createElement("helman-card") as any;
            await card.setConfig({ type: "custom:helman-card" });
            card.hass = hass;
            document.body.appendChild(card);
        },
        { tree, today, lastHour: LAST_HOUR_KWH, stats, energyUnit },
    );

    await expect.poll(() => rowNames(page)).toContain("Boiler");
}

/** Names of every device row on the page, through every shadow root. */

function rowNames(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as any).__deepAll(document, "helman-tree-item").map((row: any) =>
        (row.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim()));
}

async function openDevice(page: Page, name: string): Promise<void> {
    await page.evaluate((name) => {
        const row = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === name);
        if (!row) throw new Error(`no row named ${name}`);
        (row.shadowRoot.querySelector(".deviceName") as HTMLElement).click();
    }, name);
}

test("device name opens a shared Overview with today's measured energy", async ({ page }) => {
    await mountCard(page);
    await openDevice(page, "Boiler");
    const detail = page.locator("node-detail-dialog");
    await expect(detail.locator('[slot="headerTitle"]')).toHaveText("Boiler");
    await expect(detail.locator('[slot="headerTitle"] ha-icon, [slot="headerTitle"] ha-state-icon')).toHaveCount(0);
    await expect(detail.locator("node-detail-device-content helman-detail-headline")).toContainText("1.25 kWh used today");
    await expect(detail.locator("helman-switch-tile")).toHaveCount(1);
    await expect(detail.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
});

for (const [unit, change, caption] of [["Wh", 500, "0.50 kWh used today"], ["MWh", 0.00125, "1.25 kWh used today"]] as const) {
    test(`today's ${unit} recorder change is displayed in kWh`, async ({ page }) => {
        await mountCard(page, {}, false, unit, change);
        await openDevice(page, "Boiler");
        await expect(page.locator("node-detail-device-content helman-detail-headline")).toContainText(caption);
    });
}

test("device headline opens its power entity and the Schedule starts collapsed", async ({ page }) => {
    await mountCard(page, {}, true);
    await openDevice(page, "Boiler");
    const detail = page.locator("node-detail-dialog");
    await detail.locator("helman-detail-headline [data-headline]").click();
    expect(await page.evaluate(() => (window as any).__moreInfo)).toContain("sensor.boiler_power");
    const schedule = detail.locator("helman-detail-section[data-schedule] button").first();
    await expect(schedule).toHaveAttribute("aria-expanded", "false");
    await schedule.click();
    await expect(schedule).toHaveAttribute("aria-expanded", "true");
});
