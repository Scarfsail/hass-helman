import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";
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
    projections: Record<string, Array<[string, number]>> = {},
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
        async ({ tree, today, lastHour, stats, energyUnit, projections }) => {
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
                    "helman/get_appliance_projections": async () => ({
                        generatedAt: "2026-10-21T12:00:00+00:00",
                        appliances: Object.fromEntries(Object.entries(projections).map(([id, points]) =>
                            [id, { series: points.map(([slotId, energyKwh]) => ({ slotId, energyKwh })) }])),
                    }),
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
        { tree, today, lastHour: LAST_HOUR_KWH, stats, energyUnit, projections },
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

// Forecast -------------------------------------------------------------------

test("device Forecast header sums the planned runs to noon tomorrow, and the body draws and lists them", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {
        boiler: [
            // Already over, then two runs, then one past tomorrow noon.
            ["2026-10-21T11:00:00+00:00", 0.5],
            ["2026-10-21T12:00:00+00:00", 0.5], ["2026-10-21T12:15:00+00:00", 0.5],
            ["2026-10-21T13:00:00+00:00", 0.4], ["2026-10-21T13:15:00+00:00", 0.4],
            ["2026-10-22T13:00:00+00:00", 0.5],
        ],
    });
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await expect(section.locator("[slot=summary]")).toHaveText("≈ 1.8 kWh more by noon tomorrow");
    await expect(section.locator("[slot=summary] b")).toHaveText("≈ 1.8 kWh");
    await expect(section.locator("[data-forecast-body]")).toHaveCount(0);
    await section.locator("button").first().click();
    const runs = section.locator("[data-run]");
    await expect(runs).toHaveCount(2);
    await expect(runs.nth(0)).toContainText("12:00 PM–12:30 PM");
    await expect(runs.nth(0)).toContainText("≈ 1.0 kWh");
    await expect(runs.nth(1)).toContainText("01:00 PM–01:30 PM");
    await expect(runs.nth(1)).toContainText("≈ 0.80 kWh");
    const chart = section.locator("helman-day-line-chart");
    await expect(chart.locator("path.line.dashed")).toHaveCount(1);
    await expect(chart.locator("[data-now]")).toHaveCount(1);
    expect(await section.locator("helman-help-tip").evaluate((tip: any) => tip.explanation)).toContain("learned 2.0 kW");
});

test("device without projected energy has no Forecast section", async ({ page }) => {
    await mountCard(page, {}, true);
    await openDevice(page, "Boiler");
    await expect(page.locator("node-detail-device-content [data-overview]")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__deepAll(document, "node-detail-device-content").length)).toBe(1);
    await page.waitForTimeout(300);
    await expect(page.locator("node-detail-device-content helman-detail-section[data-forecast]")).toHaveCount(0);
});

// Closing divider ----------------------------------------------------------------

/** The detail's and each section's bottom border width, by name. */
async function sectionBottomBorders(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => Object.fromEntries((window as any).__deepAll(document, "node-detail-device-content, helman-detail-section")
        .map((element: Element) => [element.hasAttribute("data-schedule") ? "schedule" : element.hasAttribute("data-forecast") ? "forecast" : "detail",
            getComputedStyle(element).borderBottomWidth])));
}

test("a device without sections ends on its Overview, with no divider above the footer", async ({ page }) => {
    await mountCard(page);
    await page.evaluate(() => document.body.style.setProperty("--divider-color", "#d4d4d8"));
    await openDevice(page, "Boiler");
    await expect(page.locator("node-detail-device-content [data-overview]")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await sectionBottomBorders(page)).toEqual({ detail: "0px" });
});

for (const [label, projections, borders] of [
    ["the Schedule", {}, { detail: "0px", schedule: "1px" }],
    ["the Forecast after the Schedule", { boiler: [["2026-10-21T12:00:00+00:00", 0.5]] }, { detail: "0px", schedule: "0px", forecast: "1px" }],
] as const) {
    test(`the last section, ${label}, and only it is closed off from the footer`, async ({ page }) => {
        await installFixedClock(page);
        await mountCard(page, {}, true, "kWh", TODAY_KWH, projections as Record<string, Array<[string, number]>>);
        await page.evaluate(() => document.body.style.setProperty("--divider-color", "#d4d4d8"));
        await openDevice(page, "Boiler");
        await expect.poll(() => sectionBottomBorders(page)).toEqual(borders);
    });
}
