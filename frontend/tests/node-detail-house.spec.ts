import { prepareNodeDetailPage, mountSimpleCard, nodeDetailLocators, sectionRequestLog, sectionReads, expectKeepRule, treeNode, holdSection, powerTick, reconnectDetail } from "./support/node-detail-harness";
import { energyFields, forecastPayload, scheduleSlots, treePayload } from "./support/payload-builders";
import type { DevicePhase, ForecastPayload, ScheduleControllableActionsDTO, SchedulePayload, ScheduleSlotDTO, TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import { FIXED_NOW_ISO } from "./support/fixed-clock";
import { expectReducedMotionStill } from "./support/node-flow";

/**
 * The house node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the house overview and its two
 * sections), the device report, the schedule and the forecast, at the fixed
 * clock (Wednesday 12:00 UTC). What is pinned is the pictured overview (the
 * Now/Today flow around the house filled with its source mix, the three
 * largest consumers and everything else, the tiles), the shared disclosure
 * contract and the house answers' honesty: no device tree in the dialog, each
 * load counted once in the phase estimate and the top consumers, a three-phase
 * load in thirds and unmapped load unassigned, the measured phases against what
 * their devices explain, no diagnosis from the overnight minimum, and no
 * full-day comparison against a partial today.
 */

const SCREENS = process.env.SCREENS;

type Variant = {
    profile?: boolean;
    /** The house power sensor's state, W. */
    power?: string;
    powerUnit?: string;
    /** The solar, battery (charging positive) and grid (importing positive) sensors' states, W. */
    solar?: string;
    battery?: string;
    grid?: string;
    offGrid?: boolean;
    /** The device tree carries no phases. */
    noPhases?: boolean;
    /** Helman's measured house phase sensors are unavailable. */
    noMeasured?: boolean;
    /** Today's report cannot be built. */
    todayUnavailable?: boolean;
    /** Schedule execution is switched off. */
    executionOff?: boolean;
    /** Today misses one of its completed hours. */
    partialToday?: boolean;
};

declare global {
    interface Window {
        __HouseHass: any;
        __HouseRequests: Array<{ type: string; node?: string; section?: string; report?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
        const item = (id: string, name: string, sensor: string | null, extra: Partial<TreeItemDTO> = {}) =>
            treeNode({ id, displayName: name, powerSensorId: sensor, ...extra });
        const rest = (parent: string) => item(`${parent}_unmeasured`, "", `sensor.helman_unmeasured_power_${parent}`, { isUnmeasured: true });
        const phase = (value: DevicePhase) => (variant.noPhases ? {} : { phase: value });
        const houseChildren = [
            // A metered L1 kitchen: an oven on its phase, a stale own L2 notwithstanding, and its own rest.
            item("sensor.kitchen_energy", "Kitchen", "sensor.kitchen_power", {
                ...phase("L1"),
                children: [item("sensor.oven_energy", "Oven", "sensor.oven_power", phase("L2")), rest("kitchen_energy")],
            }),
            item("sensor.heatpump_energy", "Heat pump", "sensor.heatpump_power", phase("3ph")),
            item("sensor.ev_energy", "EV", "sensor.ev_power", { ...phase("L2"), controllableIds: ["ev"] }),
            item("sensor.lamp_energy", "Lamp", "sensor.lamp_power"),
            item("sensor.boiler_energy", "Boiler", "sensor.boiler_power", { ...phase("L3"), controllableIds: ["boiler"] }),
            // A three-phase breaker: a pump without its own phase could be on any.
            item("sensor.breaker_energy", "Breaker", "sensor.breaker_power", {
                ...phase("3ph"),
                children: [item("sensor.pump_energy", "Pump", "sensor.pump_power"), rest("breaker_energy")],
            }),
            rest("house"),
        ];
        const source = (id: string, sensor: string, sourceType: string) => ({ ...item(id, id, sensor, energyFields(id)), sourceType, isSource: true });
        const tree = treePayload({
            sources: [source("solar", "sensor.solar", "solar"), source("grid", "sensor.grid", "grid"), source("battery", "sensor.battery", "battery")],
            consumers: [{ ...item("house", "House", "sensor.house"), children: houseChildren }],
            consumptionTotalSensorId: null,
            productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
        });
    await page.evaluate(({ v, tree, forecastDefaults, scheduleDefaults }) => {
        const profile = v.profile !== false;
        const s = window.__nodeDetailState;
        const states: Record<string, unknown> = {
            "sensor.solar": s(v.solar ?? "3000", "W"),
            "sensor.grid": s(v.grid ?? "2000", "W"),
            "sensor.battery": s(v.battery ?? "-1000", "W"),
            "sensor.house": s(v.power ?? "7800", v.powerUnit ?? "W"),
            "sensor.kitchen_power": s("1500", "W"),
            "sensor.oven_power": s("1000", "W"),
            "sensor.helman_unmeasured_power_kitchen_energy": s("500", "W"),
            "sensor.heatpump_power": s("3000", "W"),
            "sensor.ev_power": s("2", "kW"),
            "sensor.lamp_power": s("100", "W"),
            "sensor.boiler_power": s("unavailable"),
            "sensor.breaker_power": s("900", "W"),
            "sensor.pump_power": s("600", "W"),
            "sensor.helman_unmeasured_power_breaker_energy": s("300", "W"),
            "sensor.helman_unmeasured_power_house": s("300", "W"),
            "sensor.helman_solar_source_ratio": s("50", "%"),
            "sensor.helman_battery_source_ratio": s("20", "%"),
            "sensor.helman_grid_source_ratio": s("30", "%"),
            "sensor.helman_battery_time_to_empty": s("125.4", "min"),
            "sensor.solax_run_mode": s(v.offGrid ? "Off-Grid" : "Normal Mode"),
            "sensor.solax_eps_power_active_l1": s("1200", "W"),
            "sensor.solax_eps_power_active_l2": s("800", "W"),
            "sensor.solax_eps_power_active_l3": s("400", "W"),
            // The formula inputs; the meter reads positive while exporting.
            "sensor.solax_inverter_power_l1": s("2000", "W"),
            "sensor.solax_inverter_power_l2": s("1500", "W"),
            "sensor.solax_inverter_power_l3": s("1100", "W"),
            "sensor.solax_measured_power_l1": s("-1000", "W"),
            "sensor.solax_measured_power_l2": s("-1000", "W"),
            "sensor.solax_measured_power_l3": s("-1200", "W"),
        };
        // Measured against the estimate (L1 2.6, L2 3.1, L3 1.1 kW): L1 and L3
        // carry load no assigned device explains, L2 has more assigned than measured.
        // Without an inverter profile Helman's sensors publish unavailable.
        const measured = profile && !v.noMeasured;
        for (const [phase, watts] of [[1, "3000"], [2, "2500"], [3, "2300"]] as const) {
            states[`sensor.helman_house_consumption_power_l${phase}`] = s(measured ? watts : "unavailable", "W");
        }
        states["sensor.helman_house_consumption_power"] = s(measured ? "7800" : "unavailable", "W");
        const entities: Record<string, string | null> = {
            power: "sensor.house",
            solar_ratio: "sensor.helman_solar_source_ratio",
            battery_ratio: "sensor.helman_battery_source_ratio",
            grid_ratio: "sensor.helman_grid_source_ratio",
            time_to_empty: "sensor.helman_battery_time_to_empty",
            phase_power_total: "sensor.helman_house_consumption_power",
        };
        for (const p of [1, 2, 3]) entities[`phase_power_l${p}`] = `sensor.helman_house_consumption_power_l${p}`;
        if (profile) {
            entities.run_mode = "sensor.solax_run_mode";
            for (const p of [1, 2, 3]) {
                entities[`eps_power_l${p}`] = `sensor.solax_eps_power_active_l${p}`;
                entities[`ac_power_l${p}`] = `sensor.solax_inverter_power_l${p}`;
                entities[`grid_power_l${p}`] = `sensor.solax_measured_power_l${p}`;
            }
        }
        const period = { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" };
        const overview = {
            node: "house",
            asOf: "2026-10-21T12:00:00+00:00",
            profile: profile ? { id: "solax_inverter", label: "SolaX inverter" } : null,
            entities,
            phasePowerPolarity: profile ? "positive_is_export" : null,
            condition: v.offGrid ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: ["today", "pattern"],
        };
        const money = (paid: number | null, priced: number, forgone: number | null) => ({
            paid, paidPricedKwh: priced, paidUnpricedKwh: 0, forgone, forgonePricedKwh: priced, forgoneUnpricedKwh: 0,
        });
        const load = (id: string, label: string, kwh: number, paid: number | null, ownOf: string | null = null) => ({
            id, label, ownOf, estimated: false, kwh, coverage: 1, money: money(paid, paid === null ? 0 : kwh, 1.2),
        });
        const today = v.todayUnavailable
            ? {
                node: "house", section: "today", asOf: "2026-10-21T12:00:00+00:00", period, priceUnit: null, complete: false,
                unavailable: "no_house_meter", house: null, independence: null, selfConsumption: null, consumers: null,
            }
            : {
                node: "house", section: "today", asOf: "2026-10-21T11:55:00+00:00", period, priceUnit: "CZK/kWh", complete: false,
                unavailable: null,
                house: {
                    kwh: 20, coverage: 1,
                    sources: { solar: 8, battery: 4, grid: 6, unattributed: 2 },
                    money: money(25.4, 18, 6.1),
                    ambiguousKwh: 0.4, mismatchKwh: 0,
                },
                independence: { share: 0.6, gridShare: 0.3, unknownShare: 0.1 },
                selfConsumption: {
                    share: 0.6, reason: null,
                    destinations: {
                        producedKwh: 12, attributedKwh: 10, unattributedKwh: 2, houseKwh: 3, batteryKwh: 3, exportKwh: 4,
                        unresolvedKwh: 2, measuredExportKwh: 4, otherExportKwh: 0,
                    },
                },
                consumers: {
                    top: [
                        load("ev", "EV", 6, 12),
                        load("oven", "Oven", 5, 10),
                        load("kitchen_unmeasured", "Kitchen", 4, null, "kitchen"),
                    ],
                    others: { count: 2, kwh: 1.5 },
                    unmeasuredKwh: 3.5,
                    overallocatedKwh: 0,
                },
            };
        const pattern = {
            node: "house", section: "pattern", asOf: "2026-10-21T12:00:00+00:00", period,
            comparison: {
                unavailable: null, until: "2026-10-21T12:00:00+00:00", elapsedHours: 12,
                comparedHours: v.partialToday ? 11 : 12,
                todayKwh: 9.2, averageKwh: 8.0, ratio: 1.15, used: 3,
                days: [
                    { date: "2026-10-14", kwh: 7.5, knownHours: 12 },
                    { date: "2026-10-07", kwh: 8.4, knownHours: 12 },
                    { date: "2026-09-30", kwh: null, knownHours: 9 },
                    { date: "2026-09-23", kwh: 8.1, knownHours: 12 },
                ],
            },
            overnight: {
                start: "2026-10-21T00:00:00+00:00", end: "2026-10-21T05:00:00+00:00", complete: true, unavailable: null,
                minimum: { watts: 182.4, at: "2026-10-21T03:15:00+00:00", coverage: 1 }, coverage: 0.97,
            },
            profile: {
                historyDays: 42, trainedAt: "2026-10-21T03:00:00+00:00",
                kwh: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => (day === 2 && hour === 18 ? 1.6 : 0.3 + hour / 100))),
            },
        };
        const ranking = {
            report: "ranking", startDate: "2026-10-21", endDate: "2026-10-21", priceUnit: "CZK/kWh",
            complete: false, asOf: "2026-10-21T11:55:00+00:00", range: { minDate: "2026-01-01", maxDate: "2026-10-21" },
            meters: { grid: true, solar: true, battery: true, house: true },
            chargeOrigin: {}, solarTotals: {}, houseKwh: 20, ambiguousKwh: 0, unattributedKwh: 2, mismatchKwh: 0,
            nodes: [
                { id: "house", label: "", icon: null, estimated: false, unmeasured: false, kwh: 20, coverage: 1, firstHour: null,
                  parentId: null, depth: 0, children: ["sensor.ev_energy"],
                  sources: { solar: 8, battery: 4, grid: 6, unattributed: 2 },
                  money: { paid: { amount: 25.4, pricedKwh: 18, unpricedKwh: 2, tariffKwh: 0 }, forgone: { amount: 6.1, pricedKwh: 18, unpricedKwh: 2 } },
                  overallocatedKwh: 0 },
                { id: "sensor.ev_energy", label: "EV", icon: null, estimated: false, unmeasured: false, kwh: 6, coverage: 1, firstHour: null,
                  parentId: "house", depth: 1, children: [],
                  sources: { solar: 2, battery: 1, grid: 3, unattributed: 0 },
                  money: { paid: { amount: 12, pricedKwh: 6, unpricedKwh: 0, tariffKwh: 0 }, forgone: { amount: 1.2, pricedKwh: 6, unpricedKwh: 0 } },
                  overallocatedKwh: 0 },
            ],
        };
        // The plan: the boiler from 13:00 to 14:00, the EV a candidate 15:00–16:00.
        const slots: ScheduleSlotDTO[] = [];
        for (let i = 0; i < 48; i += 1) {
            const at = new Date(Date.parse("2026-10-21T11:45:00Z") + i * 900_000);
            const hour = at.getUTCHours();
            const controllables: ScheduleControllableActionsDTO = { inverter: { kind: "normal", setBy: "automation" } };
            if (hour === 13) controllables.boiler = { on: true, setBy: "automation" };
            if (hour === 15) controllables.ev = { charge: true, useMode: "Fast", setBy: "automation", conditionMet: false };
            slots.push({ id: at.toISOString().replace(".000Z", "+00:00"), controllables });
        }
        const schedule: SchedulePayload = { ...scheduleDefaults, executionEnabled: !v.executionOff, slots, runtime: { activeSlotId: "2026-10-21T12:00:00+00:00", controllables: {} } };
        // The house forecast: 0.3 kWh in the slot in progress, 0.25 kWh in every later one.
        const houseSlot = (ms: number, kwh: number) => ({
            timestamp: new Date(ms).toISOString().replace(".000Z", "+00:00"),
            nonDeferrable: { value: kwh, lower: kwh * 0.6, upper: kwh * 1.5 },
            deferrableConsumers: [],
        });
        const now = Date.parse("2026-10-21T12:00:00Z");
        const forecast: ForecastPayload = {
            ...forecastDefaults,
            solar: { ...forecastDefaults.solar, status: "unavailable", points: [], actualHistory: [] },
            house_consumption: {
                ...forecastDefaults.house_consumption,
                status: "available", generatedAt: "2026-10-21T12:00:00+00:00", unit: "kWh",
                trainingWindowDays: 56, historyDaysAvailable: 42, requiredHistoryDays: 14, model: "hour_of_week",
                actualHistory: [],
                currentSlot: houseSlot(now, 0.3),
                series: Array.from({ length: 140 }, (_, i) => houseSlot(now + (i + 1) * 900_000, 0.25)),
            },
        };
        window.__HouseHass = window.__configureNodeDetail({
            states, tree, overviews: { house: overview, inverter: window.__inverterOverview({ maxAllowedExportPower: null }) }, sections: { house: { today, pattern } }, forecast, schedule,
            replies: {
                "helman/device_report": ranking,
            },
        });
        window.__HouseRequests = window.__NodeDetailRequests;
    }, { v: variant, tree, forecastDefaults: forecastPayload(), scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page);
}

const { content, question, header, evidence, tile, flow, flowLabel } = nodeDetailLocators("house");
const houseCell = (page: Page) => page.locator(".node-cell:has(simple-card-house)");
const fill = (page: Page, id: string) => flow(page).locator(`[data-glyph="house"] [data-house-fill="${id}"]`);
const sectionRequests = async (page: Page) => (await sectionRequestLog(page, "house")).map((r) => r.section);
const reportRequests = (page: Page) =>
    page.evaluate(() => window.__HouseRequests.filter((r) => r.type === "helman/device_report").length);

async function openDetail(page: Page): Promise<void> {
    await houseCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

/** A flow label's bold value and its name. */
async function expectItem(page: Page, side: "in" | "out", id: string, value: string, name: string): Promise<void> {
    await expect(flowLabel(page, side, id).locator(".value")).toHaveText(value);
    await expect(flowLabel(page, side, id).locator(".name")).toHaveText(name);
}

/** Open a question the way a reader does: the flow's side that absorbed it, or its tile. */
async function open(page: Page, id: string): Promise<void> {
    if (id === "sources") await flow(page).locator("[data-side='in']").click();
    else if (id === "consumers") await flow(page).locator("[data-side='out']").click();
    else await tile(page, id).locator("button").click();
    await expect(header(page, id)).toHaveAttribute("aria-expanded", "true");
}

test.describe("the house overview", () => {
    test("opens on a status pill, the Now flow around the house and three closed tiles; no device tree", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Using 7.8 kW.");
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Now · 12:00");

        const ids = await content(page).locator("helman-node-tile").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["next", "pattern", "phases"]);
        for (const id of ids) await expect(tile(page, id!).locator("button")).toHaveAttribute("aria-expanded", "false");
        // No answer is open, and nothing heavy is mounted or requested.
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        // The card stays the route to individual devices: no tree in the dialog.
        await expect(content(page).locator("helman-tree-item, helman-house-devices-section")).toHaveCount(0);
        await expect(content(page).locator("table, .heatmap, helman-solar-inspector-card, helman-device-report-ranking")).toHaveCount(0);
        // Today's figures come with the overview; the history only with its answer.
        await expect.poll(() => sectionRequests(page)).toEqual(["today"]);
        expect(await reportRequests(page)).toBe(0);
        expect(await page.evaluate(() => window.__HouseRequests.filter((r) => r.type === "helman/get_forecast").length)).toBe(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
    });

    test("tiles say the answer: the next run in its action's tone, today so far, the most loaded phase in the phase colours", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(tile(page, "next").locator(".value")).toHaveText("13:00");
        await expect(tile(page, "next").locator(".detail")).toHaveText("Boiler");
        await expect(tile(page, "next").locator("button")).toHaveClass(/action-tone-charge/);
        await expect(tile(page, "next").locator(".caption")).toHaveText("What will use energy next?");
        await expect(tile(page, "pattern").locator(".value")).toHaveText("20 kWh");
        await expect(tile(page, "pattern").locator(".detail")).toHaveText("used so far today");
        await expect(tile(page, "phases").locator(".value")).toHaveText("L1 3.0 kW");
        await expect(tile(page, "phases").locator(".detail")).toHaveText("most loaded phase");
        for (const [phase, color] of [["L1", "l1"], ["L2", "l2"], ["L3", "l3"]]) {
            await expect(tile(page, "phases").locator(`[data-phase-bar="${phase}"]`)).toHaveAttribute("style", new RegExp(`--helman-phase-${color}`));
        }
        // L2 2.5 kW of the highest L1 3.0 kW.
        await expect(tile(page, "phases").locator('[data-phase-bar="L2"] .meter-fill')).toHaveAttribute("style", /width: 83\.3%/);
    });

    test("the pattern tile says today against the usual once its answer read it", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "pattern");
        await expect(tile(page, "pattern").locator(".detail")).toHaveText("+15 % against a usual Wednesday to 12:00");
    });

    test("an unreadable house sensor is no reading, never 0 W", async ({ page }) => {
        await mount(page, { power: "unavailable" });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("No house power reading right now.");
        // Without the house reading what the top three leave is unknown, never 0.
        await expect(flowLabel(page, "out", "rest")).toContainText("–");
    });
});

test.describe("the flow", () => {
    test("Now: the card's live split in, the three largest loads of the house tree counted once and everything else out", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        // Solar 3.0 kW covers the house first, the battery 1.0 kW, the grid the 3.8 kW left.
        await expect(flowLabel(page, "in", "solar")).toContainText("3.0 kW");
        await expect(flowLabel(page, "in", "battery")).toContainText("1.0 kW");
        await expect(flowLabel(page, "in", "grid")).toContainText("3.8 kW");
        // The heat pump, the EV and the oven; the kitchen's meter is never a load beside its oven.
        const outputs = await flow(page).locator("[data-side='out'] [data-flow]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-flow")));
        expect(outputs).toEqual(["consumer-1", "consumer-2", "consumer-3", "rest"]);
        await expectItem(page, "out", "consumer-1", "3.0 kW", "Heat pump");
        await expectItem(page, "out", "consumer-2", "2.0 kW", "EV");
        await expectItem(page, "out", "consumer-3", "1.0 kW", "Oven");
        // 7.8 kW less the three named loads.
        await expectItem(page, "out", "rest", "1.8 kW", "Everything else");
        await expect(flow(page).locator("[data-total='in']")).toHaveText("In 7.8 kW");
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 7.8 kW");
    });

    test("the house is filled bottom-up with the source mix, shares not a level", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        // 3.0, 1.0 and 3.8 of 7.8 kW.
        await expect(fill(page, "solar")).toHaveAttribute("data-share", "0.385");
        await expect(fill(page, "battery")).toHaveAttribute("data-share", "0.128");
        await expect(fill(page, "grid")).toHaveAttribute("data-share", "0.487");
        const rects = await flow(page).locator("[data-house-fill]").evaluateAll((nodes) => nodes.map((node) => ({
            id: node.getAttribute("data-house-fill"), y: Number(node.getAttribute("y")), h: Number(node.getAttribute("height")),
        })));
        // Solar at the bottom, the bands stacked to the roof: the whole body, whatever the load.
        expect(rects.map((rect) => rect.id)).toEqual(["solar", "battery", "grid"]);
        expect(rects[0].y + rects[0].h).toBeCloseTo(70, 3);
        expect(rects[2].y).toBeCloseTo(28, 3);

        await flow(page).locator("[data-scope='today']").click();
        // Today the unknown source is in the fill, in the neutral colour: 8, 4, 6 and 2 of 20 kWh.
        await expect(fill(page, "solar")).toHaveAttribute("data-share", "0.400");
        await expect(fill(page, "unattributed")).toHaveAttribute("data-share", "0.100");
        await expect(fill(page, "unattributed")).toHaveAttribute("fill", "var(--helman-neutral-light)");
    });

    test("an unreadable battery leaves the split and the fill unknown, never 0", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__HouseHass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.battery": { state: "unavailable", attributes: {} } } };
        });
        await expect(flowLabel(page, "in", "solar")).toContainText("–");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon]")).toHaveCount(0);
        await expect(flow(page).locator("[data-house-fill]")).toHaveCount(0);
    });

    test("Today: the today section's sources, its top three and everything else; unknown source and the paid estimate as footnotes", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await flow(page).locator("[data-scope='today']").click();
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "today");
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Today · 00:00–11:55");
        await expect(flowLabel(page, "in", "solar")).toContainText("8.0 kWh");
        await expect(flowLabel(page, "in", "battery")).toContainText("4.0 kWh");
        await expect(flowLabel(page, "in", "grid")).toContainText("6.0 kWh");
        await expectItem(page, "out", "consumer-1", "6.0 kWh", "EV");
        await expectItem(page, "out", "consumer-3", "4.0 kWh", "Kitchen (rest)");
        // 20 kWh less the 15 kWh named.
        await expectItem(page, "out", "rest", "5.0 kWh", "Everything else");
        await expect(flow(page).locator("[data-flow]")).toHaveCount(7);
        // The unknown source is in what went in, never forced into a source.
        await expect(flow(page).locator("[data-total='in']")).toHaveText("In 20 kWh");
        const notes = flow(page).locator("[data-flow-note]");
        await expect(notes.nth(0)).toHaveText("2.0 kWh from no known source");
        await expect(notes.nth(1)).toHaveText("Paid ≈ 25.40 CZK, an estimate, not a bill");
        // The today section the overview already read: no flows section, no second read.
        expect(await sectionRequests(page)).toEqual(["today"]);
    });

    test("Today without reports says why, and draws no flow", async ({ page }) => {
        await mount(page, { todayUnavailable: true });
        await openDetail(page);
        await flow(page).locator("[data-scope='today']").click();
        await expect(flow(page).locator("[data-flow-note]").first()).toHaveText("Needs a house energy meter.");
        await expect(flowLabel(page, "in", "solar")).toContainText("–");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("–");
        await expect(flow(page).locator("[data-ribbon]")).toHaveCount(0);
    });

    test("the sources open what powered the house, the consumers what used the most", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page).locator("[data-side='in']")).toHaveAttribute("title", "What powered the house today?");
        await expect(flow(page).locator("[data-side='out']")).toHaveAttribute("title", "What used the most energy today?");
        await open(page, "sources");
        await open(page, "consumers");
        await expect(question(page, "sources")).toHaveCount(0);
    });
});

test.describe("motion and the centre value", () => {
    test("Now: ribbons with energy shimmer, the glyph pulses and the power sits under it; Today stands still", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page)).toHaveAttribute("active", "");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("7.8 kW");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon='grid']")).toHaveAttribute("data-animated", "");
        // Every drawn ribbon has energy on it, and shimmers.
        await expect(flow(page).locator("[data-ribbon]:not([data-animated])")).toHaveCount(0);

        await flow(page).locator("[data-scope='today']").click();
        // Used: the sources and the unknown source.
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("20 kWh");
        await expect(flow(page)).not.toHaveAttribute("active");
        await expect(flow(page).locator("[data-ribbon]").first()).toBeAttached();
        await expect(flow(page).locator("[data-animated]")).toHaveCount(0);
    });

    const cases: Array<[Variant, string, boolean]> = [
        [{ power: "60" }, "60 W", true],
        [{ power: "50" }, "50 W", false],
        [{ power: "unavailable" }, "–", false],
    ];
    for (const [variant, value, active] of cases) {
        test(`${JSON.stringify(variant)} shows ${value} under the glyph, ${active ? "pulsing" : "still"}`, async ({ page }) => {
            await mount(page, variant);
            await openDetail(page);
            await expect(flow(page).locator("[data-centre-value]")).toHaveText(value);
            if (active) await expect(flow(page)).toHaveAttribute("active", "");
            else await expect(flow(page)).not.toHaveAttribute("active");
        });
    }

    test("reduced motion stops the shimmer and the pulse", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expectReducedMotionStill(page, flow(page));
    });
});

test.describe("what powered the house", () => {
    test("today's split, independence with its unknown share, and self-consumption over solar production", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "sources");
        const sources = question(page, "sources");
        await expect(sources.locator("[data-row='used']")).toContainText("20 kWh");
        await expect(sources.locator("[data-row='solar']")).toContainText("8.0 kWh (40 %)");
        await expect(sources.locator("[data-row='grid']")).toContainText("6.0 kWh (30 %)");
        await expect(sources.locator("[data-row='unattributed']")).toContainText("2.0 kWh (10 %)");
        await expect(sources.locator("[data-row='independence']")).toContainText("60 % (source unknown for 10 %)");
        await expect(sources.locator("[data-row='self-consumption']")).toContainText("60 %");
        await expect(sources.locator("[data-row='self-consumption']")).toContainText("of the solar produced");

        await evidence(page, "sources").click();
        await expect(sources.locator("[data-row='paid']")).toContainText("≈ 25.40 CZK");
        await expect(sources.locator("[data-row='paid']")).toContainText("not a bill");
        await expect(sources.locator("[data-row='forgone']")).toContainText("not a payment");
        await expect(sources.locator("[data-row='matched-solar']")).toContainText("10 kWh");
        await expect(sources.locator("[data-row='solar-unmatched']")).toContainText("2.0 kWh");
    });

    test("without reports the answer says why, and the overview keeps its live figures", async ({ page }) => {
        await mount(page, { todayUnavailable: true });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("Using 7.8 kW.");
        await expect(content(page).locator("[data-overview] .figure")).toHaveCount(0);
        await open(page, "sources");
        await expect(question(page, "sources").locator("[data-today-unavailable]")).toHaveText("Needs a house energy meter.");
    });
});

test.describe("what used the most", () => {
    test("the top three loads counted once, the rest and the unmeasured remainder; the full ranking only as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "consumers");
        const consumers = question(page, "consumers");
        await expect(consumers.locator("[data-row='top-1']")).toContainText("EV");
        await expect(consumers.locator("[data-row='top-1']")).toContainText("6.0 kWh · ≈ 12.00 CZK");
        // A metered parent is never a load beside its children: its own rest is.
        await expect(consumers.locator("[data-row='top-3']")).toContainText("Kitchen (rest)");
        await expect(consumers.locator("[data-row='top-3']")).toContainText("4.0 kWh");
        await expect(consumers.locator("[data-row^='top-']")).toHaveCount(3);
        await expect(consumers.locator("[data-row='others']")).toContainText("Other devices (2)");
        await expect(consumers.locator("[data-row='unmeasured']")).toContainText("3.5 kWh");
        await expect(consumers).toContainText("not proof of waste");
        expect(await reportRequests(page)).toBe(0);
        await expect(consumers.locator("helman-device-report-ranking")).toHaveCount(0);

        await evidence(page, "consumers").click();
        await expect(consumers.locator("helman-device-report-ranking")).toHaveCount(1);
        expect(await reportRequests(page)).toBe(1);
        await expect(consumers.locator("[data-row='money-1']")).toContainText("100 % priced");

        // While the evidence stays open, the ranking is re-read as today moves on.
        await page.clock.setFixedTime(new Date(Date.parse(FIXED_NOW_ISO) + 6 * 60_000));
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__HouseHass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.ev_power": { state: "3", attributes: { unit_of_measurement: "kW" } } } };
        });
        await expect.poll(() => reportRequests(page)).toBe(2);
    });
});

test.describe("what comes next", () => {
    test("the rest of today's forecast, planned runs with a candidate marked, and the focused forecast embed", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(content(page).locator("helman-solar-inspector-card")).toHaveCount(0);
        await open(page, "next");
        const next = question(page, "next");
        await expect(next.locator("[data-row='rest']")).toContainText("12 kWh");
        await expect(next.locator("[data-row='run-1']")).toContainText("Boiler");
        await expect(next.locator("[data-row='run-1']")).toContainText("13:00–14:00");
        await expect(next.locator("[data-row='run-1']")).toHaveAttribute("data-candidate", "false");
        await expect(next.locator("[data-row='run-2']")).toContainText("EV");
        await expect(next.locator("[data-row='run-2']")).toContainText("candidate, its condition is not met");
        await expect(next.locator("[data-execution-off]")).toHaveCount(0);

        const embed = next.locator("helman-solar-inspector-card");
        await expect(embed).toHaveCount(1);
        const config = await embed.evaluate((card: any) => card._config);
        expect(config.chart_series).toEqual(["houseForecast", "houseActual"]);
        expect(config.hide_money_strip).toBe(true);
        expect(config.hide_aggregate_views).toBe(true);

        await evidence(page, "next").click();
        await expect(next.locator("[data-row='history']")).toContainText("42 days");
        await expect(next.locator("[data-row='plan-2']")).toContainText("not met");
    });

    test("with execution switched off the plan says it is not carried out", async ({ page }) => {
        await mount(page, { executionOff: true });
        await openDetail(page);
        await open(page, "next");
        await expect(question(page, "next").locator("[data-execution-off]")).toContainText("does not carry it out");
    });
});

test.describe("is today unusual", () => {
    test("requested only when opened; today against the same hours of earlier weekdays, and the overnight minimum without a diagnosis", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect.poll(() => sectionRequests(page)).toEqual(["today"]);
        await open(page, "pattern");
        const pattern = question(page, "pattern");
        await expect(pattern.locator("[data-bar='today']")).toContainText("Today to 12:00");
        await expect(pattern.locator("[data-bar='today']")).toContainText("9.2 kWh");
        // The usual day is over the same hours, never the whole day.
        await expect(pattern.locator("[data-bar='usual']")).toContainText("Usual Wednesday to 12:00");
        await expect(pattern.locator("[data-bar='usual']")).toContainText("8.0 kWh");
        await expect(pattern.locator("[data-row='difference']")).toContainText("+15 %");
        await expect(pattern.locator("[data-row='samples']")).toContainText("3 of the last 4 Wednesdays");
        await expect(pattern.locator("[data-partial-today]")).toHaveCount(0);
        expect(await sectionRequests(page)).toEqual(["today", "pattern"]);
        await expect(pattern.locator(".preview")).toHaveText("+15 % against a usual Wednesday to 12:00");

        await expect(pattern.locator("[data-row='overnight']")).toContainText("Lowest recorded overnight load");
        await expect(pattern.locator("[data-row='overnight']")).toContainText("182 W around 03:15");
        await expect(pattern).toContainText("not a diagnosis");
        await expect(pattern).not.toContainText(/left on|standby|leak|waste/i);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);

        await evidence(page, "pattern").click();
        await expect(pattern.locator("[data-row='day-2026-09-30']")).toContainText("not compared: 9 of 12 hours recorded");
        await expect(pattern.locator("[data-heatmap] .cell")).toHaveCount(7 * 24);
        await expect(pattern.locator("[data-profile-label]")).toContainText("learned expectation");
        await expect(pattern.locator("[data-profile-label]")).toContainText("not measured history");
        await expect(pattern.locator("[data-row='profile-peak']")).toContainText("Wed 18:00");
    });

    test("a partial today is compared only over the hours it has", async ({ page }) => {
        await mount(page, { partialToday: true });
        await openDetail(page);
        await open(page, "pattern");
        await expect(question(page, "pattern").locator("[data-partial-today]")).toContainText("11 of 12 completed hours; only those hours are compared");
    });
});

test.describe("phases", () => {
    test("measured, assigned and the difference per phase, each with its devices, and a No phase group", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "phases");
        const phases = question(page, "phases");
        await expect(phases.locator("[data-phase-measured]")).toBeVisible();
        const phase = (id: string) => phases.locator(`[data-phase='${id}']`);
        // L1: oven 1.0 (on the kitchen's phase) + kitchen rest 0.5, not the kitchen
        // meter again; + a third of the heat pump and of the breaker's rest.
        await expect(phase("L1").locator("[data-measured]")).toHaveText("3.0 kW");
        await expect(phase("L1").locator("[data-assigned]")).toHaveText("assigned ≈ 2.6 kW");
        await expect(phase("L1").locator("[data-difference]")).toHaveText("400 W no assigned device explains");
        await expect(phase("L2").locator("[data-assigned]")).toHaveText("assigned ≈ 3.1 kW");
        await expect(phase("L2").locator("[data-difference]")).toHaveText("600 W more assigned than measured: a device is likely on another phase");
        await expect(phase("L3").locator("[data-difference]")).toHaveText("1.2 kW no assigned device explains");
        // The lamp, the pump behind a three-phase breaker and the house's own rest.
        await expect(phases.locator("[data-row='unassigned']")).toContainText("1.0 kW");
        await expect(phases.locator("[data-row='coverage']")).toContainText("6.8 kW, 87 % of the house load");
        await expect(phases.locator("[data-unknown-loads]")).toContainText("Boiler");

        // Each phase's devices, collapsed until opened.
        const devices = (id: string) => phases.locator(`[data-phase-devices='${id}']`);
        const row = (id: string, name: string) => devices(id).locator("tr").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^\\s*${name}`) }) });
        await expect(devices("L1").locator("summary")).toHaveText("Devices on L1 (4)");
        await expect(devices("L1").locator("table")).toBeHidden();
        await devices("L1").locator("summary").click();
        await expect(row("L1", "Oven")).toContainText("via Kitchen");
        await expect(row("L1", "Oven")).toContainText("1.0 kW");
        await expect(row("L1", "Kitchen \\(rest\\)")).toContainText("500 W");
        // A three-phase load is under every phase at its third, marked.
        for (const id of ["L2", "L3"]) await devices(id).locator("summary").click();
        for (const id of ["L1", "L2", "L3"]) {
            await expect(row(id, "Heat pump")).toContainText("3ph");
            await expect(row(id, "Heat pump")).toContainText("1.0 kW");
        }
        // No reading is not 0 W.
        await expect(row("L3", "Boiler")).toContainText("no reading");
        // Loads without a phase and the house's own remainder.
        await expect(devices("none").locator("summary")).toHaveText("No phase (3)");
        await devices("none").locator("summary").click();
        await expect(row("none", "Lamp")).toContainText("100 W");
        await expect(row("none", "Pump")).toContainText("600 W");
        await expect(row("none", "Unmeasured house load")).toContainText("300 W");

        // The evidence: the formula's inputs, the meter import-positive.
        await evidence(page, "phases").click();
        await expect(phases.locator("[data-phase-input='L1']")).toContainText("2000 W");
        await expect(phases.locator("[data-phase-input='L1'] td").nth(2)).toHaveText("1000 W");
        await expect(phases.locator("[data-formula]")).toContainText("sum of the three phases");
    });

    test("falls back to the estimate while the measured sensors are unavailable", async ({ page }) => {
        await mount(page, { noMeasured: true });
        await openDetail(page);
        await expect(tile(page, "phases").locator(".value")).toHaveText("L2 3.1 kW");
        await expect(tile(page, "phases").locator(".detail")).toHaveText("most loaded phase, estimated");
        await open(page, "phases");
        await expect(question(page, "phases").locator(".preview")).toHaveText("L1 2.6 kW · L2 3.1 kW · L3 1.1 kW (est.)");
        const phases = question(page, "phases");
        await expect(phases.locator("[data-phase-measured]")).toHaveCount(0);
        await expect(phases.locator("[data-phase='L1']")).toContainText("≈ 2.6 kW");
        await expect(phases.locator("[data-phase='L2']")).toContainText("≈ 3.1 kW");
        await expect(phases.locator("[data-phase='L3']")).toContainText("≈ 1.1 kW");
        await expect(phases.locator("[data-difference]")).toHaveCount(0);
        await expect(phases.locator("[data-row='unassigned']")).toContainText("1.0 kW");
        await expect(phases).toContainText("not a measured phase meter");
        // The device lists stay.
        await expect(phases.locator("[data-phase-devices]")).toHaveCount(4);
    });

    test("without a wiring map or a measurement nothing is guessed", async ({ page }) => {
        await mount(page, { noPhases: true, noMeasured: true });
        await openDetail(page);
        await expect(tile(page, "phases").locator(".value")).toHaveText("–");
        await expect(tile(page, "phases").locator(".detail")).toHaveText("No devices mapped to a phase");
        await expect(tile(page, "phases").locator("[data-phase-meters]")).toHaveCount(0);
        await open(page, "phases");
        await expect(question(page, "phases").locator("[data-none-mapped]")).toBeVisible();
        await expect(question(page, "phases").locator("[data-phase-estimate]")).toHaveCount(0);
    });

    test("off-grid is the one exception, linked to the phase answer with the EPS readings and the runtime", async ({ page }) => {
        await mount(page, { offGrid: true });
        await openDetail(page);
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("off-grid operation (Off-Grid)");
        await exception.locator("button").click();
        const phases = question(page, "phases");
        await expect(header(page, "phases")).toHaveAttribute("aria-expanded", "true");
        await expect(phases.locator("[data-row='eps-l1']")).toContainText("1200 W");
        await expect(phases.locator("[data-row='runtime']")).toContainText("about 2 h 5 min");
        await expect(phases.locator("[data-row='runtime']")).toContainText("recent discharge");
        // Measured EPS output is never mixed into the wiring estimate.
        await expect(phases.locator("[data-phase='L1']")).toContainText("≈ 2.6 kW");
    });
});

test.describe("disclosure and live data", () => {
    test("one open question at a time, evidence by keyboard, and a reopened dialog starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await tile(page, "phases").locator("button").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "phases")).toHaveAttribute("aria-expanded", "true");
        await expect(tile(page, "phases").locator("button")).toHaveAttribute("aria-expanded", "true");
        await evidence(page, "phases").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "phases").locator("[data-phase-inputs]")).toBeVisible();

        await open(page, "sources");
        await expect(question(page, "phases")).toHaveCount(0);
        await expect(tile(page, "phases").locator("button")).toHaveAttribute("aria-expanded", "false");

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
    });

    test("live readings reach the open phase estimate", async ({ page }) => {
        await mount(page, { noMeasured: true });
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__HouseHass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.ev_power": { state: "3", attributes: { unit_of_measurement: "kW" } } } };
        });
        await expect(tile(page, "phases").locator(".value")).toHaveText("L2 4.1 kW");
        // And the Now flow: the EV is now the largest load.
        await expectItem(page, "out", "consumer-1", "3.0 kW", "Heat pump");
        await expectItem(page, "out", "consumer-2", "3.0 kW", "EV");
    });
});

test.describe("a Custom inverter", () => {
    test("keeps every question; no EPS readings and no exception", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        for (const id of ["sources", "consumers", "next", "pattern"]) await open(page, id);
        await open(page, "phases");
        await evidence(page, "phases").click();
        await expect(question(page, "phases")).not.toContainText("EPS");
    });
});

/** The two states the review screenshots show: an evening on the battery and the grid, and a midday on solar. */
const STATES: Array<[string, Variant]> = [
    ["evening", { solar: "0", battery: "-2000", grid: "5800" }],
    ["midday", { solar: "9000", battery: "1000", grid: "-200" }],
];

test.describe("screenshots", { tag: "@screens" }, () => {
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        for (const [state, variant] of STATES) {
            test(`the ${state} overview, Today and the opened answers at ${name}`, async ({ page }) => {
                await page.setViewportSize({ width, height });
                await mount(page, variant);
                await openDetail(page);
                await page.screenshot({ path: `${SCREENS}/house-${state}-${name}-now.png`, fullPage: true });
                await flow(page).locator("[data-scope='today']").click();
                await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
                await page.screenshot({ path: `${SCREENS}/house-${state}-${name}-today.png`, fullPage: true });
                for (const id of ["sources", "consumers", "phases"]) {
                    await open(page, id);
                    await evidence(page, id).click();
                    await page.waitForTimeout(300);
                    await page.screenshot({ path: `${SCREENS}/house-${state}-${name}-${id}.png`, fullPage: true });
                }
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                expect(overflow).toBeLessThanOrEqual(0);
            });
        }
    }
});

test("the house detail receives watts exactly once from a kW sensor", async ({ page }) => {
    await mount(page, { power: "2.4", powerUnit: "kW" });
    await openDetail(page);
    await expect(content(page).locator("[data-overview] .status")).toHaveText("Using 2.4 kW.");
});


test("Today across midnight throttles power ticks and accepts a late answer", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    await flow(page).locator("[data-scope='today']").click();
    await expect(flow(page)).toContainText("11:55");
    await holdSection(page, "house", "today");
    const before = (await sectionRequestLog(page, "house", "today")).length;
    for (let second = 0; second < 10; second += 1) {
        await page.clock.setFixedTime(new Date(Date.parse("2026-10-22T00:00:00Z") + second * 1000));
        await powerTick(page, "node-detail-house-content", second);
    }
    expect((await sectionRequestLog(page, "house", "today")).length - before).toBe(1);
    // A delayed answer can still be for yesterday; accept it, then wait out the retry interval.
    await page.evaluate(() => (window as any).__releaseSection());
    await expect(flow(page)).toContainText("00:00–00:00");
    await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
    for (let second = 10; second <= 30; second += 1) {
        await page.clock.setFixedTime(new Date(Date.parse("2026-10-22T00:00:00Z") + second * 1000));
        await powerTick(page, "node-detail-house-content", second);
    }
    expect((await sectionRequestLog(page, "house", "today")).length - before).toBe(1);
    await page.clock.setFixedTime(new Date("2026-10-22T00:00:31Z"));
    await powerTick(page, "node-detail-house-content", 31);
    expect((await sectionRequestLog(page, "house", "today")).length - before).toBe(2);
    await page.evaluate(() => (window as any).__releaseSection(true));
    await expect.poll(() => content(page).evaluate((element: any) => element._today.state?.status)).toBe("ready");
});


test("a disconnected loading section can recover after reconnect", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    await holdSection(page, "house", "pattern");
    await open(page, "pattern");
    await expect.poll(() => content(page).evaluate((element: any) => element._pattern.state?.status)).toBe("loading");
    expect(await reconnectDetail(page, "node-detail-house-content", "_pattern")).toBeNull();
    await expect.poll(() => content(page).evaluate((element: any) => element._pattern.state?.status)).toBe("loading");
    await page.evaluate(() => { (window as any).__releaseSection(); (window as any).__releaseSection(); });
    await expect.poll(() => content(page).evaluate((element: any) => element._pattern.state?.status)).toBe("ready");
});


test("an idle Today retries a delayed previous-day answer on the clock", async ({ page }) => {
    await page.clock.install({ time: new Date(FIXED_NOW_ISO) });
    await mount(page);
    await openDetail(page);
    await flow(page).locator("[data-scope='today']").click();
    await expect(flow(page)).toContainText("11:55");
    await holdSection(page, "house", "today");
    const before = (await sectionRequestLog(page, "house", "today")).length;
    await page.clock.setFixedTime(new Date("2026-10-22T00:00:00Z"));
    await page.clock.pauseAt(new Date("2026-10-22T00:00:00Z"));
    await page.clock.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    await powerTick(page, "node-detail-house-content", 0);
    expect((await sectionRequestLog(page, "house", "today")).length - before).toBe(1);
    await page.clock.runFor(10_000);
    await page.evaluate(() => (window as any).__releaseSection());
    await expect(flow(page)).toContainText("00:00–00:00");
    // No further hass updates: the shared clock alone must arrange the retry.
    await page.clock.runFor(20_000);
    expect((await sectionRequestLog(page, "house", "today")).length - before).toBe(1);
    await page.clock.runFor(30_000);
    await expect.poll(async () => (await sectionRequestLog(page, "house", "today")).length - before).toBe(2);
    // A pending retry must not trigger another read within the retry interval.
    await page.clock.runFor(20_000);
    expect((await sectionRequestLog(page, "house", "today")).length - before).toBe(2);
    await page.evaluate(() => (window as any).__releaseSection(true));
    await expect.poll(() => content(page).evaluate((element: any) => element._today.state?.status)).toBe("ready");
});


test("section requests: a section is read while shown, re-read on a data change and dropped once hidden", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    const REPORT = "helman/device_report";
    const reads = () => sectionReads(page, "house", [REPORT]);
    await expect.poll(reads).toEqual({ today: 1 });
    await open(page, "pattern");
    await expect.poll(reads).toEqual({ today: 1, pattern: 1 });
    // A closed answer's figures are dropped: reopened, it is read again.
    await header(page, "pattern").click();
    await open(page, "pattern");
    await expect.poll(reads).toEqual({ today: 1, pattern: 2 });
    // The full ranking only behind the consumers answer's evidence.
    await open(page, "consumers");
    await evidence(page, "consumers").click();
    await expect.poll(reads).toEqual({ today: 1, pattern: 2, [REPORT]: 1 });
    // Today draws the today section the overview already read.
    await flow(page).locator("[data-scope='today']").click();
    await page.evaluate(() => window.__fireDataChanged("config"));
    // Once: Today draws the section the overview reads, not a second copy of it.
    await expect.poll(reads).toEqual({ today: 2, pattern: 2, [REPORT]: 2 });
    await flow(page).locator("[data-scope='now']").click();
    await flow(page).locator("[data-scope='today']").click();
    await page.waitForTimeout(300);
    expect(await reads()).toEqual({ today: 2, pattern: 2, [REPORT]: 2 });
});


test("today's figures stay while they refresh within the day and on a failure, and give way on a new day", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    await expectKeepRule(page, "node-detail-house-content", "house", "today", "_today");
});
