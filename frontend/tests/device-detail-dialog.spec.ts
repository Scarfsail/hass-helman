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
    generatedAt = "2026-10-21T12:00:00+00:00",
    admin = false,
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
        async ({ tree, today, lastHour, stats, energyUnit, projections, generatedAt, admin }) => {
            const state = (value: string, attributes: Record<string, unknown> = {}) => ({ state: value, attributes });
            (window as any).__statRequests = [];
            (window as any).__deviceStatsRequests = [];
            const hass = {
                language: "en",
                locale: { language: "en" },
                config: { time_zone: "UTC" },
                user: { is_admin: admin },
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
                        generatedAt,
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
        { tree, today, lastHour: LAST_HOUR_KWH, stats, energyUnit, projections, generatedAt, admin },
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
});

test("device row switch badge opens the same detail dialog as clicking the name", async ({ page }) => {
    await mountCard(page);
    await page.evaluate((name) => {
        const row = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === name);
        if (!row) throw new Error(`no row named ${name}`);
        const badge = row.shadowRoot
            .querySelector("helman-tree-item-icon")
            ?.shadowRoot?.querySelector("helman-appliance-switch-badge");
        if (!badge) throw new Error("no switch badge on row");
        badge.dispatchEvent(new CustomEvent("show-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId: "switch.boiler" },
        }));
    }, "Boiler");
    const detail = page.locator("node-detail-dialog");
    await expect(detail.locator('[slot="headerTitle"]')).toHaveText("Boiler");
    expect(await page.evaluate(() => (window as any).__moreInfo ?? [])).toEqual([]);
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

test("device Forecast normalises the slot in progress by what was left of it", async ({ page }) => {
    await installFixedClock(page);
    await page.clock.setFixedTime(new Date("2026-10-21T12:14:00Z"));
    // 3 kW with one minute left in the 12:00 slot is 0.05 kWh; the next slot is a full 0.75 kWh.
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {
        boiler: [["2026-10-21T12:00:00+00:00", 0.05], ["2026-10-21T12:15:00+00:00", 0.75]],
    }, "2026-10-21T12:14:00+00:00");
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    const power = await section.locator("helman-day-line-chart").evaluate((chart: any) =>
        chart.series[0].points.slice(0, 2).map((point: { v: number }) => Math.round(point.v * 1000) / 1000));
    expect(power).toEqual([3, 3]);
    expect(await section.locator("helman-help-tip").evaluate((tip: any) => tip.explanation)).toContain("learned 3.0 kW");
});

test("device Forecast drops what ran in the slot in progress since the projection was generated", async ({ page }) => {
    await installFixedClock(page);
    await page.clock.setFixedTime(new Date("2026-10-21T12:10:00Z"));
    // Generated at 12:00 with the 12:00 slot whole: a third of it is left at 12:10, so 0.5 kWh counts as 0.17.
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {
        boiler: [["2026-10-21T12:00:00+00:00", 0.5], ["2026-10-21T12:15:00+00:00", 0.5]],
    }, "2026-10-21T12:00:00+00:00");
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await expect(section.locator("[slot=summary] b")).toHaveText("≈ 0.67 kWh");
    await section.locator("button").first().click();
    await expect(section.locator("[data-run]")).toHaveCount(1);
    await expect(section.locator("[data-run]")).toContainText("≈ 0.67 kWh");
});

test("device without projected energy has no Forecast section", async ({ page }) => {
    await mountCard(page, {}, true);
    await openDevice(page, "Boiler");
    await expect(page.locator("node-detail-device-content [data-overview]")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__deepAll(document, "node-detail-device-content").length)).toBe(1);
    await page.waitForTimeout(300);
    await expect(page.locator("node-detail-device-content helman-detail-section[data-forecast]")).toHaveCount(0);
});

// History & statistics, Technical details ------------------------------------------

const BOILER_STATS = {
    "sensor.boiler_energy": {
        daily_kwh: { median: 4.1, min: 1.2, max: 6.8, mean: 4.0, days: 14 },
        runs_per_day: 2,
        daily_runs: { min: 1, max: 3 },
        run_minutes: { median: 105, min: 60, max: 150 },
        run_kwh: { median: 3.4, min: 2, max: 5 },
        on_kwh_per_hour: 1.8,
    },
};

test("device History header gives the learned average while on, collapsed; the body has the last 24 hours and the typical tiles", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("1.8 kW while on");
    await expect(section.locator("[slot=summary] b")).toHaveText("1.8 kW");
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__chartConfigs.length)).toBe(0);
    await section.locator("button").first().click();
    await expect(section.locator(".history-graph-stub")).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__chartConfigs)).toEqual([{ type: "history-graph", hours_to_show: 24, entities: ["sensor.boiler_power", "switch.boiler"] }]);
    await expect(section.locator(".section-title")).toHaveText(["Last 24 hours", "Typical, learned from the last 14 days"]);
    const tiles = section.locator("[data-typical] [data-stat]");
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0)).toContainText("4.1 kWh");
    await expect(tiles.nth(0)).toContainText("a typical day (1.2–6.8 kWh)");
    await expect(tiles.nth(1)).toContainText("2 runs");
    await expect(tiles.nth(1)).toContainText("a typical day (1–3 runs)");
    await expect(tiles.nth(2)).toContainText("1 h 45 min");
    await expect(tiles.nth(2)).toContainText("a typical run ≈ 3.4 kWh");
    await expect(tiles.nth(3)).toContainText("1.8 kW");
    await expect(tiles.nth(3)).toContainText("average while on");
});

test("device runs tile keeps the plain caption for stats learned before the daily run range", async ({ page }) => {
    const { daily_runs: _, ...stats } = BOILER_STATS["sensor.boiler_energy"];
    await mountCard(page, { "sensor.boiler_energy": stats }, true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    const runs = section.locator("[data-typical] [data-stat]").nth(1);
    await expect(runs).toContainText("2 runs");
    await expect(runs).toContainText("a typical day");
    await expect(runs).not.toContainText("(");
});

test("device Technical details lists its entities for an admin, and is absent for anyone else", async ({ page }) => {
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-technical]");
    await expect(section.locator("[slot=summary]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=switch] .value")).toHaveText("switch.boiler");
    await expect(section.locator("[data-row=power-sensor] .value")).toHaveText("sensor.boiler_power");
    await expect(section.locator("[data-row^=runtime-]")).toHaveCount(1);
});

test("device Technical details is not rendered for a non-admin", async ({ page }) => {
    await mountCard(page, {}, true);
    await openDevice(page, "Boiler");
    await expect(page.locator("node-detail-device-content helman-detail-section[data-history]")).toHaveCount(1);
    await expect(page.locator("node-detail-device-content helman-detail-section[data-technical]")).toHaveCount(0);
});

// Closing divider ----------------------------------------------------------------

/** The detail's and each section's bottom border width, by name. */
async function sectionBottomBorders(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => Object.fromEntries((window as any).__deepAll(document, "node-detail-device-content, helman-detail-section")
        .map((element: Element) => [["schedule", "forecast", "history", "technical"].find((name) => element.hasAttribute(`data-${name}`)) ?? "detail",
            getComputedStyle(element).borderBottomWidth])));
}

for (const [label, schedulable, projections, admin, borders] of [
    ["History & statistics, without a Schedule", false, {}, false, { detail: "0px", history: "1px" }],
    ["History & statistics after the Schedule", true, {}, false, { detail: "0px", schedule: "0px", history: "1px" }],
    ["History & statistics after the Forecast", true, { boiler: [["2026-10-21T12:00:00+00:00", 0.5]] }, false, { detail: "0px", schedule: "0px", forecast: "0px", history: "1px" }],
    ["Technical details for an admin", true, {}, true, { detail: "0px", schedule: "0px", history: "0px", technical: "1px" }],
] as const) {
    test(`the last section, ${label}, and only it is closed off from the footer`, async ({ page }) => {
        await installFixedClock(page);
        await mountCard(page, {}, schedulable, "kWh", TODAY_KWH, projections as Record<string, Array<[string, number]>>, "2026-10-21T12:00:00+00:00", admin);
        await page.evaluate(() => document.body.style.setProperty("--divider-color", "#d4d4d8"));
        await openDevice(page, "Boiler");
        await expect.poll(() => sectionBottomBorders(page)).toEqual(borders);
    });
}
