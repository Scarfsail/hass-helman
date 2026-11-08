import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";
import { loadBundle } from "./support/card-page";
import { treeNode, treePayload } from "./support/payload-builders";
import { expectShowMore, onDashboard } from "./support/node-detail-harness";
import type { TreeItemDTO } from "../cards/helman-api";

/**
 * A device box's name opens that device's detail.
 *
 * The name used to toggle the box's children; that job moved to a chevron in
 * front of it, so the name is free to open one dialog per config device: its
 * live power and switch, the energy its own meter counted today and in the last
 * hour, and its power today in Forecast. The house's Untracked remainder opens its
 * detail too; other rows -- virtual label groups, a breaker's remainder --
 * keep toggling and open nothing.
 *
 * Home Assistant's own pieces are stubbed at the edge: `callWS` answers the
 * recorder's statistics and `window.__powerHistory` as HA's history of an
 * entity, `window.loadCardHelpers` hands back an element that records any card
 * config it was built with, and `ha-dialog` only shows its content while open.
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
 * device, so `schedulableBoiler` gives the boiler one. `nodeHistory` is what
 * `helman/get_node_history` answers for every node.
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
    nodeHistory: unknown = { unavailable: "no_house_node" },
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
                                id: "sensor.helman_share_energy_pump",
                                displayName: "Pump",
                                powerSensorId: "sensor.helman_share_power_pump",
                                energyEntityId: "sensor.helman_share_energy_pump",
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
            device_groupings: [{ id: "room", name: "Room", groups: [{ id: "kitchen", name: "Kitchen", short_name: "K" }] }],
            history_buckets: 3,
            history_bucket_duration: 5,
        },
    });

    await page.evaluate(
        async ({ tree, today, lastHour, stats, energyUnit, projections, generatedAt, admin, nodeHistory }) => {
            const state = (value: string, attributes: Record<string, unknown> = {}) => ({ state: value, attributes });
            (window as any).__statRequests = [];
            (window as any).__deviceStatsRequests = [];
            (window as any).__nodeHistoryRequests = [];
            (window as any).__nodeHistoryMessages = [];
            (window as any).__historyRequests = [];
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
                    "sensor.boiler_power": state("1200", { unit_of_measurement: "W", friendly_name: "Boiler Power" }),
                    "sensor.boiler_energy": state("10", { unit_of_measurement: energyUnit, friendly_name: "Boiler Energy" }),
                    "sensor.helman_share_power_pump": state("300", { unit_of_measurement: "W", friendly_name: "Share — Pump" }),
                    "sensor.helman_share_energy_pump": state("4", { unit_of_measurement: energyUnit, friendly_name: "Share energy — Pump" }),
                    "sensor.house_unmeasured": state("500"),
                    "switch.boiler": { entity_id: "switch.boiler", state: "on", attributes: { friendly_name: "Boiler Switch" } },
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
                    "helman/get_node_history": async (msg: any) => {
                        (window as any).__nodeHistoryRequests.push(msg.node_id);
                        (window as any).__nodeHistoryMessages.push(msg);
                        return nodeHistory;
                    },
                    "helman/get_appliance_projections": async () => ({
                        generatedAt,
                        appliances: Object.fromEntries(Object.entries(projections).map(([id, points]) =>
                            [id, { series: points.map(([slotId, energyKwh]) => ({ slotId, energyKwh })) }])),
                    }),
                    "history/history_during_period": async (msg: any) => {
                        (window as any).__historyRequests.push(msg);
                        return (window as any).__powerHistory ?? {};
                    },
                    "recorder/statistic_during_period": async (msg: any) => {
                        (window as any).__statRequests.push(msg);
                        return { change: msg.calendar ? today : lastHour };
                    }
                }).callWS,
            };
            const card = document.createElement("helman-card") as any;
            await card.setConfig({ type: "custom:helman-card" });
            (window as any).__hass = hass;
            card.hass = hass;
            document.body.appendChild(card);
        },
        { tree, today, lastHour: LAST_HOUR_KWH, stats, energyUnit, projections, generatedAt, admin, nodeHistory },
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
        chart.series.find((series: { key: string }) => series.key === "planned").points.slice(0, 2).map((point: { v: number }) => Math.round(point.v * 1000) / 1000));
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

/** The boiler's power this morning, W, as HA's recorder has it: `[time, state]` from 10:50 on. */
const BOILER_POWER: Array<[string, string]> = [
    ["10:50", "1000"], ["11:00", "0"], ["11:05", "2000"], ["11:08", "unavailable"], ["11:08", "0"], ["12:04", "3000"],
];

async function seedPowerHistory(page: Page, readings = BOILER_POWER): Promise<void> {
    await page.evaluate((readings) => {
        (window as any).__powerHistory = { "sensor.boiler_power": readings.map(([time, s]) => ({ s, lu: Date.parse(`2026-10-21T${time}:00Z`) / 1000 })) };
    }, readings);
}

test("device Forecast draws the actual power since midnight as each slot's time-weighted mean, against the plan", async ({ page }) => {
    await installFixedClock(page);
    await page.clock.setFixedTime(new Date("2026-10-21T12:10:00Z"));
    await mountCard(page, {}, true, "kWh", TODAY_KWH, { boiler: [["2026-10-21T12:15:00+00:00", 0.5]] }, "2026-10-21T12:10:00+00:00");
    await seedPowerHistory(page);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    const chart = section.locator("helman-day-line-chart");
    await expect(chart.locator("path.line")).toHaveCount(2);
    await expect(chart.locator("path.line.dashed")).toHaveCount(1);
    const at = (time: string) => Date.parse(`2026-10-21T${time}:00Z`);
    // Nothing known before 10:50; the 11:00 slot's 3 minutes at 2 kW are 0.4 kW;
    // off without a reading of its own until 12:04, then 3 kW for 6 of the 10 minutes so far.
    await expect.poll(() => chart.evaluate((element: any) => element.series.find((series: { key: string }) => series.key === "actual").points
        .map((point: { t: number; v: number }) => [point.t, Math.round(point.v * 1000) / 1000]))).toEqual([
        [at("10:45"), 1], [at("11:00"), 0.4], [at("11:15"), 0], [at("11:30"), 0], [at("11:45"), 0], [at("12:00"), 1.8],
    ]);
    expect(await page.evaluate(() => (window as any).__historyRequests)).toEqual([{
        type: "history/history_during_period", start_time: "2026-10-21T00:00:00.000Z", end_time: "2026-10-21T12:10:00.000Z",
        entity_ids: ["sensor.boiler_power"], minimal_response: true, no_attributes: true, significant_changes_only: false,
    }]);
    const help = await section.locator("helman-help-tip").evaluate((tip: any) => tip.explanation);
    expect(help).toContain("The solid line is the power measured since midnight");
    expect(help).toContain("The dashed line is estimated from the planned runs");
});

test("device Forecast leaves a gap where its power sensor was unavailable, not its last reading", async ({ page }) => {
    await installFixedClock(page);
    await page.clock.setFixedTime(new Date("2026-10-21T12:10:00Z"));
    await mountCard(page, {}, true);
    await seedPowerHistory(page, [["10:50", "1000"], ["11:05", "2000"], ["11:08", "unavailable"], ["12:04", "3000"]]);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    const chart = section.locator("helman-day-line-chart");
    const at = (time: string) => Date.parse(`2026-10-21T${time}:00Z`);
    // The 11:00 slot averages its 8 minutes known; 11:15–11:45 have none; 12:00 its 6 minutes at 3 kW.
    await expect.poll(() => chart.evaluate((element: any) => element.series.find((series: { key: string }) => series.key === "actual").points
        .map((point: { t: number; v: number }) => [point.t, Math.round(point.v * 1000) / 1000]))).toEqual([
        [at("10:45"), 1], [at("11:00"), 1.375], [at("12:00"), 3],
    ]);
});

test("device without projected energy still shows its Forecast, with nothing planned and its actual power alone", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, {}, true);
    await seedPowerHistory(page);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await expect(section.locator("[slot=summary]")).toHaveText("Nothing planned");
    await section.locator("button").first().click();
    const chart = section.locator("helman-day-line-chart");
    await expect(chart.locator("path.line")).toHaveCount(1);
    await expect(chart.locator("path.line.dashed")).toHaveCount(0);
    await expect(section.locator("[data-run]")).toHaveCount(0);
    expect(await chart.evaluate((element: any) => element.series.map((series: { key: string }) => series.key))).toEqual(["actual"]);
    const help = await section.locator("helman-help-tip").evaluate((tip: any) => tip.explanation);
    expect(help).toBe("The solid line is the power measured since midnight, averaged over each 15 minutes.");
});

test("device Forecast's chart opens HA's history of its power and switch", async ({ page }) => {
    await onDashboard(page);
    await installFixedClock(page);
    await mountCard(page, BOILER_STATS, true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    await expectShowMore(page, section.locator("[data-show-more]"), ["sensor.boiler_power", "switch.boiler"]);
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
        running_kw: 1.96,
    },
};

test("device History header gives the learned average during a run, collapsed; the body has no history graph", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    // No node history here: the power alone.
    await expect(section.locator("[slot=summary]")).toHaveText("2.0 kW while running");
    await expect(section.locator("[slot=summary] b")).toHaveText("2.0 kW");
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__chartConfigs.length)).toBe(0);
    await section.locator("button").first().click();
    // A node without a history renders no block, only what it learned.
    await expect(section.locator("[data-node-history], [data-node-history-not-ready]")).toHaveCount(0);
    await expect(section.locator(".section-title")).toHaveText([/^In period/]);
    await expect(section.locator(".history-graph-stub, helman-day-line-chart")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__chartConfigs)).toEqual([]);
    await expect(section.locator("[data-node-history-summary] [data-row]")).toHaveCount(4);
    await expect(section.locator("[data-row=day] .value")).toHaveText(/^\s*4\.1 kWh \(1\.2–6\.8\)\s*typical\s*$/);
});

/** The boiler's last 30 days, as `helman/get_node_history` answers them. */
function boilerHistory(overrides: Record<string, unknown> = {}) {
    const money = (amount: number, pricedKwh: number, unpricedKwh = 0) => ({ amount, pricedKwh, unpricedKwh });
    return {
        id: "sensor.boiler_energy", label: "Boiler", icon: "mdi:water-boiler", estimated: false, unmeasured: false, kwh: 42.6,
        coverage: 1, firstHour: "2026-09-22T00:00:00+00:00", startDate: "2026-09-22", endDate: "2026-10-21", priceUnit: "CZK/kWh", complete: false,
        navigationRange: { minDate: "2026-08-01", maxDate: "2026-10-21" },
        totals: {
            kwh: 42.6, sources: { solar: 26, battery: 9.4, grid: 7.2, unknown: 0 }, knownKwh: 42.6,
            paid: money(52, 42.6), forgone: money(46, 42.6), gridPaid: money(31, 7.2), batteryPaid: money(21, 9.4),
            solarForgone: money(46, 26), virtual: money(98, 42.6),
        },
        paidPerKwh: 1.22, gridPricePerKwh: 4.31, batteryPricePerKwh: 2.23, solarForgonePerKwh: 1.77, virtualPerKwh: 2.3,
        activeDays: 18, coveredDays: 30, perWeek: 4.2, kwhPerActiveDay: 2.4,
        ...overrides,
    };
}

test("device History header gives the running power and what an hour of it costs at the 30 days' paid rate, collapsed", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    // 1.96 kW × 1.22 CZK/kWh.
    await expect(section.locator("[slot=summary]")).toHaveText("2.0 kW · ≈ 2.39 CZK/h while running");
    await expect(section.locator("[slot=summary] b")).toHaveText("2.0 kW · ≈ 2.39 CZK/h");
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__nodeHistoryRequests)).toEqual(["sensor.boiler_energy"]);
});

test("device History shows period figures with obvykle lines and no history graph", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();

    // The picker sits at the top of the history block
    const picker = section.locator("helman-history-period-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator("button[data-preset=last_30]")).toHaveClass(/selected/);

    const block = section.locator("[data-node-history]");
    await expect(block.locator("[data-energy-title]")).toHaveText(/Energy\s*· 43 kWh/);
    await expect(block.locator("[data-energy] [data-source]")).toHaveText([/^\s*26\s*61 %\s*$/, /^\s*9\.4\s*22 %\s*$/, /^\s*7\.2\s*17 %\s*$/]);
    await expect(block.locator("[data-money-title]")).toHaveText(/Money\s*· paid ≈ 52 CZK · ≈ 1\.22 CZK\/kWh\s*· virtually ≈ 98 CZK · ≈ 2\.30 CZK\/kWh/);
    await expect(block.locator("[data-money] [data-money-source]")).toHaveText([/≈ 46 CZK\s*≈ 1\.77 CZK\/kWh/, /≈ 21 CZK\s*≈ 2\.23 CZK\/kWh/, /≈ 31 CZK\s*≈ 4\.31 CZK\/kWh/]);

    // The rows, "In period", with what was learned at the far end.
    await expect(block.locator("[data-rows-title]")).toHaveText(/^In period\s*typical · learned from 14 days$/);
    await expect(block.locator("[data-rows-title] .aside")).toHaveText("typical · learned from 14 days");

    // Each learned figure on the row measuring the same quantity: under the
    // period's own value, or as the value itself captioned "typical".
    const rows = block.locator("[data-node-history-summary] [data-row]");
    await expect(rows).toHaveCount(6);
    const typical = (row: string) => block.locator(`[data-row=${row}] [data-typical]`);
    await expect(block.locator("[data-row=day] .value")).toContainText("1.4 kWh");
    await expect(typical("day")).toHaveText("typical 4.1 kWh (1.2–6.8)");
    await expect(block.locator("[data-row=per-day] .value")).toHaveText("≈ 2.4 kWh");
    await expect(block.locator("[data-row=how-often] .value")).toHaveText("≈ 4.2× a week · on 18 of 30 days");
    await expect(block.locator("[data-row=runs] .value")).toContainText("2 (1–3)");
    await expect(typical("runs")).toHaveText("typical");
    await expect(block.locator("[data-row=run] .value")).toContainText("1 h 45 min · ≈ 3.4 kWh");
    await expect(typical("run")).toHaveText("typical");
    await expect(block.locator("[data-row=running] .value")).toContainText("2.0 kW");
    await expect(typical("running")).toHaveText("typical");

    await expect(block.locator("[data-estimates-toggle]")).toHaveText("How these are estimated");

    // HA's 24 h graph has moved to Forecast as the actual power.
    await expect(section.locator(".section-title")).toHaveText([/^In period/]);
    await expect(section.locator(".history-graph-stub")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__chartConfigs)).toEqual([]);
});

test("period picker in device History selects shortcuts, steps ranges, opens custom inputs, and resets on reopen", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();

    // 1. The detail opens on last_30
    const picker = section.locator("helman-history-period-picker");
    await expect(picker.locator("button[data-preset=last_30]")).toHaveClass(/selected/);
    await expect(picker.locator("[data-primary-date]")).toHaveText("September 22 – October 21, 2026");
    await expect(picker.locator("[data-node-history-title] helman-help-tip")).toHaveCount(1);
    await expect(picker.locator("[data-step-next]")).toBeDisabled();

    // 2. Tapping Yesterday requests yesterday..yesterday
    await picker.locator("button[data-preset=yesterday]").click();
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ node_id: "sensor.boiler_energy", start_date: "2026-10-20", end_date: "2026-10-20" })
    );
    await expect(picker.locator("button[data-preset=yesterday]")).toHaveClass(/selected/);
    await expect(picker.locator("[data-primary-date]")).toHaveText("Tuesday, October 20, 2026");

    // 3. ‹ on last_7 requests the previous 7 days, and › is disabled on the current period
    await picker.locator("button[data-preset=last_7]").click();
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ node_id: "sensor.boiler_energy", start_date: "2026-10-15", end_date: "2026-10-21" })
    );
    await expect(picker.locator("[data-step-next]")).toBeDisabled();
    await expect(picker.locator("[data-step-prev]")).toBeEnabled();

    // Tap ‹: requests previous 7 days (2026-10-08 .. 2026-10-14)
    await picker.locator("[data-step-prev]").click();
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ node_id: "sensor.boiler_energy", start_date: "2026-10-08", end_date: "2026-10-14" })
    );
    // Shortcut chip stays highlighted
    await expect(picker.locator("button[data-preset=last_7]")).toHaveClass(/selected/);
    // › is now enabled
    await expect(picker.locator("[data-step-next]")).toBeEnabled();

    // 4. Custom inputs carry navigationRange as min/max
    await picker.locator("button[data-preset=custom]").click();
    const startInput = picker.locator("input[data-custom-start]");
    const endInput = picker.locator("input[data-custom-end]");
    await expect(startInput).toHaveAttribute("min", "2026-08-01");
    await expect(startInput).toHaveValue("2026-10-08");
    await expect(endInput).toHaveAttribute("max", "2026-10-21");
    await endInput.fill("2026-10-10");
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ start_date: "2026-10-08", end_date: "2026-10-10" })
    );
    await expect(picker.locator("button[data-preset=custom]")).toHaveClass(/selected/);
    // A typed start after the end moves the end along; a typed period over 366 days ends 366 days on.
    await startInput.fill("2026-10-15");
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ start_date: "2026-10-15", end_date: "2026-10-15" })
    );
    await startInput.fill("2025-01-01");
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ start_date: "2025-01-01", end_date: "2026-01-01" })
    );
    await endInput.fill("2024-06-01");
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ start_date: "2024-06-01", end_date: "2024-06-01" })
    );
    // A typed date after today is today.
    await endInput.fill("2027-01-01");
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ start_date: "2025-10-21", end_date: "2026-10-21" })
    );

    // 5. Reopening resets to last_30
    await page.locator("node-detail-dialog [data-dialog='close']").click();
    await openDevice(page, "Boiler");
    await section.locator("button").first().click();
    await expect(picker.locator("button[data-preset=last_30]")).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryMessages.slice(-1)[0])).toEqual(
        expect.objectContaining({ start_date: "2026-09-22", end_date: "2026-10-21" })
    );
});

test("a picked period shows its loading note, not the figures of the period before, until it answers", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-gauges]")).toBeVisible();
    // Hold the next node history answer.
    await page.evaluate(() => {
        const hass = (window as any).__hass;
        const callWS = hass.callWS;
        hass.callWS = (msg: any) => msg.type === "helman/get_node_history"
            ? new Promise((resolve) => { (window as any).__releaseNodeHistory = () => resolve(callWS(msg)); })
            : callWS(msg);
    });
    const picker = section.locator("helman-history-period-picker");
    await picker.locator("button[data-preset=last_7]").click();
    await expect(section.locator("[data-node-history-not-ready] [data-history-loading]")).toBeVisible();
    await expect(section.locator("[data-gauges]")).toHaveCount(0);
    // The learned figures stay, and the header keeps the power without the rate.
    await expect(section.locator("[data-row=running] .value")).toContainText("2.0 kW");
    await expect(section.locator("[data-row=how-often]")).toHaveCount(0);
    await expect(section.locator("[slot=summary]")).toHaveText("2.0 kW while running");
    // The picker stays, on the period asked for.
    await expect(picker.locator("button[data-preset=last_7]")).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseNodeHistory)).toBe("function");
    await page.evaluate(() => (window as any).__releaseNodeHistory());
    await expect(section.locator("[data-gauges]")).toBeVisible();
    await expect(section.locator("[data-node-history-not-ready]")).toHaveCount(0);
});

test("device History names partial coverage in the title and hides virtually without export-priced solar", async ({ page }) => {
    await installFixedClock(page);
    const history = boilerHistory({
        coverage: 0.64, firstHour: "2026-10-03T00:00:00+00:00", coveredDays: 19, virtualPerKwh: null,
    });
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, history);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-node-history-title]")).toContainText("data for 19 days");
    await expect(section.locator("[data-node-history-coverage]")).toHaveText("Data for 64 % of the period (from Oct 3)");
    await expect(section.locator("[data-money-paid]")).toHaveCount(1);
    await expect(section.locator("[data-money-virtual]")).toHaveCount(0);
});

test("device History notes gaps inside the period without dating them, and keeps the plain title with every day covered", async ({ page }) => {
    await installFixedClock(page);
    // An eight-hour outage mid-period: every day still has data.
    const history = boilerHistory({ coverage: 0.989 });
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, history);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-primary-date]")).toHaveText("September 22 – October 21, 2026");
    await expect(section.locator("[data-subtitle]")).toHaveCount(0);
    await expect(section.locator("[data-node-history-coverage]")).toHaveText("Data for 99 % of the period");
});

test("device History's explanation is every consumer's, without the EV charger's note", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    await section.locator("[data-estimates-toggle]").click();
    await expect(section.locator("[data-row=how-energy] .value")).not.toContainText("EV");
    await expect(section.locator("[data-estimates-detail-note]")).toHaveCount(0);
});

test("device History header names the running power while the node history loads, its rate once it answers", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    // Hold the node history's answer.
    await page.evaluate(() => {
        const hass = (window as any).__hass;
        const callWS = hass.callWS;
        (window as any).__releaseNodeHistory = null;
        hass.callWS = (msg: any) => msg.type === "helman/get_node_history"
            ? new Promise((resolve) => { (window as any).__releaseNodeHistory = () => resolve(callWS(msg)); })
            : callWS(msg);
    });
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect.poll(() => page.evaluate(() => (window as any).__deviceStatsRequests.length)).toBe(1);
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseNodeHistory)).toBe("function");
    await expect(section.locator("[slot=summary]")).toHaveText("2.0 kW while running");
    await page.evaluate(() => (window as any).__releaseNodeHistory());
    await expect(section.locator("[slot=summary]")).toHaveText("2.0 kW · ≈ 2.39 CZK/h while running");
});

/** Open the detail of the row whose item is `id`, whether or not it is a config device. */
async function openNode(page: Page, id: string): Promise<void> {
    await page.evaluate((id) => {
        const row = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) => candidate.device?.id === id);
        if (!row) throw new Error(`no row for ${id}`);
        row.dispatchEvent(new CustomEvent("show-device-detail", { bubbles: true, composed: true, detail: { item: row.device } }));
    }, id);
}

test("a node without learned stats heads its History with the period's kWh", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openNode(page, "house_unmeasured");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("43 kWh for September 22 – October 21");
    await expect(section.locator("[slot=summary] b")).toHaveText("43 kWh");
    expect(await page.evaluate(() => (window as any).__deviceStatsRequests)).toEqual([]);
});

test("a node with no stats and no node history has no History section", async ({ page }) => {
    await mountCard(page);
    await openNode(page, "house_unmeasured");
    await expect(page.locator("node-detail-device-content")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryRequests)).toEqual(["house_unmeasured"]);
    await expect(page.locator("node-detail-device-content helman-detail-section[data-history]")).toHaveCount(0);
});

test("a device with no learned record and no node history has no History section", async ({ page }) => {
    await mountCard(page);
    await openDevice(page, "Boiler");
    await expect(page.locator("node-detail-device-content")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__deviceStatsRequests)).toEqual(["sensor.boiler_energy"]);
    await expect.poll(() => page.evaluate(() => (window as any).__nodeHistoryRequests)).toEqual(["sensor.boiler_energy"]);
    await expect(page.locator("node-detail-device-content helman-detail-section[data-history]")).toHaveCount(0);
});

test("the Untracked remainder's name opens its detail with its period", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory({ id: "house_unmeasured", unmeasured: true }));
    await expect.poll(() => rowNames(page)).toContain("👻 Untracked consumption");
    await openDevice(page, "👻 Untracked consumption");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("43 kWh for September 22 – October 21");
    expect(await page.evaluate(() => (window as any).__nodeHistoryRequests)).toEqual(["house_unmeasured"]);
});

/** A node with no energy in the period, as the backend answers it: one covered day, nothing else. */
function emptyHistory() {
    return boilerHistory({
        kwh: 0, coverage: 0, firstHour: null, coveredDays: 1, activeDays: 0, perWeek: 0, kwhPerActiveDay: null,
        totals: { ...boilerHistory().totals, kwh: 0, sources: null, knownKwh: 0 },
    });
}

test("a period without energy keeps the picker with its note: the power alone and no figures", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, emptyHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    // The power alone, no rate from an empty period.
    await expect(section.locator("[slot=summary]")).toHaveText("2.0 kW while running");
    await section.locator("button").first().click();
    // The picker stays, so another period can be picked.
    await expect(section.locator("helman-history-period-picker")).toBeVisible();
    await expect(section.locator("[data-node-history-empty]")).toHaveText("No figures yet");
    await expect(section.locator("[data-gauges]")).toHaveCount(0);
    // No covered days to name, but what it learned stays, the day's typical as its value.
    await expect(section.locator("[data-subtitle]")).toHaveCount(0);
    await expect(section.locator("[data-node-history-summary] [data-row]")).toHaveCount(4);
    await expect(section.locator("[data-row=day] .value")).toHaveText(/^\s*4\.1 kWh \(1\.2–6\.8\)\s*typical\s*$/);
    await expect(section.locator("[data-row=runs] [data-typical]")).toHaveText("typical");
});

test("a node with no stats and a period without energy keeps its History section for the picker", async ({ page }) => {
    await mountCard(page, {}, false, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, emptyHistory());
    await openNode(page, "house_unmeasured");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("No figures yet");
    await section.locator("button").first().click();
    await expect(section.locator("helman-history-period-picker")).toBeVisible();
    await expect(section.locator("[data-node-history-empty]")).toHaveText("No figures yet");
});

test("an estimated node marks its 30 days' energy total as approximate", async ({ page }) => {
    await mountCard(page, BOILER_STATS, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory({ estimated: true }));
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-energy-title]")).toHaveText(/Energy\s*· ≈ 43 kWh/);
});

test("device History header keeps today's header without learned stats, even with a node history", async ({ page }) => {
    await installFixedClock(page);
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("No figures yet");
    await section.locator("button").first().click();
    await expect(section.locator("[data-node-history]")).toBeVisible();
});

test("device History falls back to the average while on without learned runs, and drops the running row", async ({ page }) => {
    await installFixedClock(page);
    const { running_kw: _, ...stats } = BOILER_STATS["sensor.boiler_energy"];
    await mountCard(page, { "sensor.boiler_energy": stats }, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText(/1\.8 kW( · ≈ 2\.20 CZK\/h)? while\s*running/);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=running]")).toHaveCount(0);
});

test("device History without a power figure says it has none yet, and drops the running row", async ({ page }) => {
    await installFixedClock(page);
    const { running_kw: _, on_kwh_per_hour: __, ...stats } = BOILER_STATS["sensor.boiler_energy"];
    await mountCard(page, { "sensor.boiler_energy": stats }, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("No figures yet");
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=running]")).toHaveCount(0);
});

// A meterless child's row is a device row like any other: its energy and power
// are its share sensors, and its record and Settings are keyed by the former.
for (const [name, energy, power] of [
    ["Boiler", "sensor.boiler_energy", "sensor.boiler_power"],
    ["Pump", "sensor.helman_share_energy_pump", "sensor.helman_share_power_pump"],
] as const) {
    test(`${name} opens its detail, history and Settings from its energy entity`, async ({ page }) => {
        await mountCard(page, { [energy]: BOILER_STATS["sensor.boiler_energy"] }, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", true);
        if (name === "Pump") {
            // The pump sits under the boiler, whose children start collapsed.
            await page.evaluate(() => {
                const boiler = (window as any).__deepAll(document, "helman-tree-item").find((row: any) =>
                    (row.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === "Boiler");
                (boiler.shadowRoot.querySelector(".childrenToggle") as HTMLElement).click();
            });
            await expect.poll(() => rowNames(page)).toContain("Pump");
        }
        await openDevice(page, name);
        const detail = page.locator("node-detail-dialog");
        await expect(detail.locator('[slot="headerTitle"]')).toHaveText(name);
        await expect(detail.locator("node-detail-device-content helman-detail-headline")).toContainText("1.25 kWh used today");
        expect(await page.evaluate(() => (window as any).__statRequests.map((msg: any) => msg.statistic_id))).toContain(energy);
        expect(await page.evaluate(() => (window as any).__deviceStatsRequests)).toEqual([energy]);
        const history = detail.locator("node-detail-device-content helman-detail-section[data-history]");
        await expect(history.locator("[slot=summary]")).toHaveText("2.0 kW while running");
        await detail.locator("node-detail-device-content helman-detail-section[data-forecast] button").first().click();
        await expect.poll(() => page.evaluate(() => (window as any).__historyRequests.map((msg: any) => msg.entity_ids))).toEqual([[power]]);
        await expect(detail.locator("ha-button[data-settings]")).toHaveCount(1);
    });
}

test("device runs row keeps the plain value for stats learned before the daily run range", async ({ page }) => {
    await installFixedClock(page);
    const { daily_runs: _, ...stats } = BOILER_STATS["sensor.boiler_energy"];
    await mountCard(page, { "sensor.boiler_energy": stats }, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", false, boilerHistory());
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-history]");
    await section.locator("button").first().click();
    const runs = section.locator("[data-row=runs] .value");
    await expect(runs).toHaveText(/^2\s*typical$/);
    await expect(runs).not.toContainText("(");
});

test("device Technical details lists its entities for an admin, and is absent for anyone else", async ({ page }) => {
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-technical]");
    await expect(section.locator("[slot=summary]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator('[data-entities] [data-row="switch.boiler"] .label')).toHaveText("Boiler Switch");
    await expect(section.locator('[data-entities] [data-row="switch.boiler"] .value')).toHaveText("on");
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .label')).toHaveText("Boiler Power");
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .value')).toHaveText("1200 W");
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_energy"] .label')).toHaveText("Boiler Energy");
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_energy"] .value')).toHaveText("10 kWh");
    await expect(section.locator("[data-row^=runtime-]")).toHaveCount(1);
});

test("clicking an entity reading in Technical details opens Home Assistant's more-info dialog", async ({ page }) => {
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    await section.locator('[data-entities] [data-entity="sensor.boiler_power"]').click();
    expect(await page.evaluate(() => (window as any).__moreInfo)).toContain("sensor.boiler_power");
});

test("an unavailable entity in Technical details is still listed with the unavailable text", async ({ page }) => {
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .value')).toHaveText("1200 W");
    await page.evaluate(() => {
        const card = document.querySelector("helman-card") as any;
        const hass = (window as any).__hass;
        const nextHass = {
            ...hass,
            states: {
                ...hass.states,
                "sensor.boiler_power": { state: "unavailable", attributes: { friendly_name: "Boiler Power", unit_of_measurement: "W" } },
            },
        };
        (window as any).__hass = nextHass;
        card.hass = nextHass;
    });
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .label')).toHaveText("Boiler Power");
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .value')).toHaveText("unavailable");
});

test("a state change in Home Assistant updates the entity reading live while the dialog is open", async ({ page }) => {
    await mountCard(page, {}, true, "kWh", TODAY_KWH, {}, "2026-10-21T12:00:00+00:00", true);
    await openDevice(page, "Boiler");
    const section = page.locator("node-detail-device-content helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .value')).toHaveText("1200 W");
    await page.evaluate(() => {
        const card = document.querySelector("helman-card") as any;
        const hass = (window as any).__hass;
        const nextHass = {
            ...hass,
            states: {
                ...hass.states,
                "sensor.boiler_power": { state: "1850", attributes: { friendly_name: "Boiler Power", unit_of_measurement: "W" } },
            },
        };
        (window as any).__hass = nextHass;
        card.hass = nextHass;
    });
    await expect(section.locator('[data-entities] [data-row="sensor.boiler_power"] .value')).toHaveText("1850 W");
});

test("device Technical details is not rendered for a non-admin", async ({ page }) => {
    await mountCard(page, {}, true);
    await openDevice(page, "Boiler");
    await expect(page.locator("node-detail-device-content helman-detail-section[data-forecast]")).toHaveCount(1);
    await expect(page.locator("node-detail-device-content helman-detail-section[data-technical]")).toHaveCount(0);
});

// Closing divider ----------------------------------------------------------------

/** The detail's and each section's bottom border width, by name. */
async function sectionBottomBorders(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => Object.fromEntries((window as any).__deepAll(document, "node-detail-device-content, helman-detail-section")
        .map((element: Element) => [["schedule", "forecast", "history", "technical"].find((name) => element.hasAttribute(`data-${name}`)) ?? "detail",
            getComputedStyle(element).borderBottomWidth])));
}

// Without a learned record or a node history the boiler has no History, and its power entity keeps its Forecast.
for (const [label, stats, schedulable, projections, admin, borders] of [
    ["Forecast, without a Schedule", {}, false, {}, false, { detail: "0px", forecast: "1px" }],
    ["Forecast after the Schedule", {}, true, {}, false, { detail: "0px", schedule: "0px", forecast: "1px" }],
    ["History & statistics after the Forecast", BOILER_STATS, true, { boiler: [["2026-10-21T12:00:00+00:00", 0.5]] }, false, { detail: "0px", schedule: "0px", forecast: "0px", history: "1px" }],
    ["Technical details for an admin", BOILER_STATS, true, {}, true, { detail: "0px", schedule: "0px", forecast: "0px", history: "0px", technical: "1px" }],
] as const) {
    test(`the last section, ${label}, and only it is closed off from the footer`, async ({ page }) => {
        await installFixedClock(page);
        await mountCard(page, stats, schedulable, "kWh", TODAY_KWH, projections as Record<string, Array<[string, number]>>, "2026-10-21T12:00:00+00:00", admin);
        await page.evaluate(() => document.body.style.setProperty("--divider-color", "#d4d4d8"));
        await openDevice(page, "Boiler");
        await expect.poll(() => sectionBottomBorders(page)).toEqual(borders);
    });
}
