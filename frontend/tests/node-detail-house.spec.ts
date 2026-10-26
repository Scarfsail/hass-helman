import { prepareNodeDetailPage, mountSimpleCard, treeNode, liveFigures } from "./support/node-detail-harness";
import { energyFields, forecastPayload, scheduleSlots, treePayload } from "./support/payload-builders";
import type { DevicePhase, ForecastPayload, ScheduleControllableActionsDTO, SchedulePayload, ScheduleSlotDTO, TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

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
    rankingUnavailable?: boolean;
    /** Schedule execution is switched off. */
    executionOff?: boolean;
    noSlots?: boolean;
    /** Today misses one of its completed hours. */
    partialToday?: boolean;
    /** The EV's run switches from Fast to ECO at 15:30, its condition met. */
    evModeChange?: boolean;
    /** The boiler's 13:30 slot was set by the user, its settings unchanged. */
    boilerSetByUser?: boolean;
    boilerOffFirst?: boolean;
    noBoiler?: boolean;
    /** Helman's house remainder sensor, its median lagging the meters. */
    houseRemainder?: string;
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
            "sensor.helman_unmeasured_power_house": s(v.houseRemainder ?? "300", "W"),
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
            if (!v.noBoiler && hour === (v.boilerOffFirst ? 14 : 13)) controllables.boiler = { on: true, setBy: v.boilerSetByUser && at.getUTCMinutes() === 30 ? "user" : "automation" };
            if (v.boilerOffFirst && hour === 13) controllables.boiler = { on: false, setBy: "automation" };
            if (hour === 15) {
                controllables.ev = v.evModeChange
                    ? { charge: true, useMode: at.getUTCMinutes() < 30 ? "Fast" : "ECO", setBy: "automation" }
                    : { charge: true, useMode: "Fast", setBy: "automation", conditionMet: false };
            }
            slots.push({ id: at.toISOString().replace(".000Z", "+00:00"), controllables });
        }
        const schedule: SchedulePayload = { ...scheduleDefaults, executionEnabled: !v.executionOff, slots: (v.noSlots ? undefined : slots) as SchedulePayload["slots"], runtime: { activeSlotId: "2026-10-21T12:00:00+00:00", controllables: {} } };
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
            states, tree, overviews: { house: overview, inverter: window.__inverterOverview({ maxAllowedExportPower: null }) }, sections: { house: { today, pattern, ranking: { node: "house", section: "ranking", asOf: ranking.asOf, period: today.period, unavailable: v.rankingUnavailable ? "no_house_meter" : null, report: v.rankingUnavailable ? null : ranking } } }, forecast, schedule,
        });
        window.__HouseRequests = window.__NodeDetailRequests;
    }, { v: variant, tree, forecastDefaults: forecastPayload(), scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page);
}


const content = (page: Page) => page.locator("node-detail-house-content");

test("house Overview shows the P1 detail layout", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-house)").click();
    const c = content(page);
    await expect(c.locator("[data-overview]")).toBeVisible();
    await expect(c.locator("helman-detail-headline")).toBeVisible();
    await expect(c.locator("helman-flow-gauge")).toHaveCount(1);
    await expect(c).toContainText("biggest users");
    await expect(c.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
});

test("house headline, gauge and power card agree where the grid meter disagrees with the balance", async ({ page }) => {
    // 7.8 kW of house from 3 kW of solar and 1 kW of battery leaves 3.8 kW from the grid; its meter reads 2 kW.
    await mount(page);
    await page.locator(".node-cell:has(simple-card-house)").click();
    const figures = await liveFigures(page, "node-detail-house-content", "house");
    expect(figures).toMatchObject({ card: 7800, gauge: 7800 });
    expect(figures.headline).toContain("7.8 kW");
});

test("house gauge keeps a source share under 50 W, so it adds up to the headline", async ({ page }) => {
    // 463 W of house: 150 W of solar, 283 W of battery and the 30 W the grid supplies.
    await mount(page, { power: "463", solar: "150", battery: "-283", grid: "30" });
    await page.locator(".node-cell:has(simple-card-house)").click();
    const figures = await liveFigures(page, "node-detail-house-content", "house");
    expect(figures).toMatchObject({ card: 463, gauge: 463 });
    expect(figures.headline).toContain("463 W");
    await expect(content(page).locator("helman-flow-gauge .figure")).toHaveCount(3);
});

test("house Overview shows the off-grid warning", async ({ page }) => {
    await mount(page, { offGrid: true });
    await page.locator(".node-cell:has(simple-card-house)").click();
    const overview = content(page).locator("[data-overview]");
    await expect(overview).toContainText("off-grid operation");
});

test("house expands biggest users and opens the selected device", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-house)").click();
    const c = content(page);
    await expect(c.locator("button.user-row")).toHaveCount(4);
    await expect(c.getByRole("button", { name: /Everything else/ })).toContainText("1.8 kW 23 %");
    expect(await c.locator("button.user-row").first().evaluate((row) => ({
        border: getComputedStyle(row).borderTopWidth,
        radius: getComputedStyle(row).borderTopLeftRadius,
        height: row.getBoundingClientRect().height,
    }))).toEqual({ border: "0px", radius: "8px", height: 44 });
    await c.getByRole("button", { name: /Everything else/ }).click();
    await expect(c).toContainText("Not measured");
    await c.getByRole("button", { name: /Heat pump/ }).click();
    await expect(page.locator("node-detail-device-content")).toBeVisible();
});

test("house biggest users add up to the headline, whatever the remainder sensor reads", async ({ page }) => {
    // 7.5 kW of loads in 7.8 kW of house leave 300 W no meter explains; the sensor's median still reads 90 W.
    await mount(page, { houseRemainder: "90" });
    await page.locator(".node-cell:has(simple-card-house)").click();
    const c = content(page);
    const rows = () => c.locator(".user-row .user-amount").evaluateAll((amounts) => amounts.map((amount) => {
        const [, value, unit, pct] = amount.textContent!.replace(/\s+/g, " ").match(/([\d.]+) (k?W) (\d+) %/)!;
        return { watts: Number(value) * (unit === "kW" ? 1000 : 1), pct: Number(pct) };
    }));
    const total = (list: Array<{ watts: number; pct: number }>) => list.reduce((sum, row) => ({ watts: sum.watts + row.watts, pct: sum.pct + row.pct }), { watts: 0, pct: 0 });
    await expect(c.getByRole("button", { name: /Everything else/ })).toContainText("1.8 kW 23 %");
    expect(total(await rows())).toEqual({ watts: 7800, pct: 100 });
    await c.getByRole("button", { name: /Everything else/ }).click();
    await expect(c.locator(".user-row", { hasText: "Not measured" })).toContainText("300 W 4 %");
    expect(total(await rows())).toEqual({ watts: 7800, pct: 100 });
});

test("house Schedule skips an off transition and finds the later start", async ({ page }) => {
    await mount(page, { boilerOffFirst: true });
    await page.locator(".node-cell:has(simple-card-house)").click();
    await expect(page.locator("node-detail-dialog helman-detail-section[data-schedule] [slot=summary]"))
        .toContainText("Boiler starts 14:00");
});

test("house Schedule excludes a future charge candidate with unmet condition", async ({ page }) => {
    await mount(page, { noBoiler: true });
    await page.locator(".node-cell:has(simple-card-house)").click();
    await expect(page.locator("node-detail-dialog helman-detail-section[data-schedule] [slot=summary]"))
        .toContainText("Nothing planned");
});
