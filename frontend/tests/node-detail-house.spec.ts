import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { FIXED_NOW_ISO, installFixedClock } from "./support/fixed-clock";

/**
 * The house node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the house overview and its two
 * sections), the device report, the schedule and the forecast, at the fixed
 * clock (Wednesday 12:00 UTC). What is pinned is the shared disclosure
 * contract and the house answers' honesty: no device tree in the dialog, each
 * load counted once in the phase estimate and the top consumers, a three-phase
 * load in thirds and unmapped load unassigned, the measured phases against what
 * their devices explain, no diagnosis from the overnight minimum, and no
 * full-day comparison against a partial today.
 */

const BUNDLE = resolve(__dirname, "../../custom_components/helman/frontend_compiled/helman-card.js");
const SCREENS = process.env.P5_SCREENS;

type Variant = {
    profile?: boolean;
    /** The house power sensor's state, W. */
    power?: string;
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
        __hass: any;
        __requests: Array<{ type: string; node?: string; section?: string; report?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((v) => {
        const profile = v.profile !== false;
        const item = (id: string, name: string, sensor: string | null, extra: Record<string, unknown> = {}) => ({
            id, displayName: name, powerSensorId: sensor, ratioSensorId: null, switchEntityId: null,
            valueType: "default", sourceConfig: null, sourceType: null, isSource: false,
            isUnmeasured: false, groups: {}, groupBadgeTexts: [], icon: null, compact: false,
            showAdditionalInfo: false, childrenFullWidth: false, hideChildren: false,
            hideChildrenIndicator: false, sortChildrenByPower: false, deferrable: false,
            controllableIds: [], energyEntityId: null, isEstimated: false, children: [],
            phase: null, ...extra,
        });
        const rest = (parent: string) => item(`${parent}_unmeasured`, "", `sensor.helman_unmeasured_power_${parent}`, { isUnmeasured: true });
        const phase = (value: string) => (v.noPhases ? {} : { phase: value });
        const houseChildren = [
            // A metered L1 kitchen: an oven without its own phase, and its own rest.
            item("sensor.kitchen_energy", "Kitchen", "sensor.kitchen_power", {
                ...phase("L1"),
                children: [item("sensor.oven_energy", "Oven", "sensor.oven_power"), rest("kitchen_energy")],
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
        const source = (id: string, sensor: string, sourceType: string) => ({ ...item(id, id, sensor), sourceType, isSource: true });
        const tree = {
            sources: [source("solar", "sensor.solar", "solar"), source("grid", "sensor.grid", "grid"), source("battery", "sensor.battery", "battery")],
            consumers: [{ ...item("house", "House", "sensor.house"), children: houseChildren }],
            consumptionTotalSensorId: null,
            productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
        };
        const s = (state: string, unit?: string) => ({ state, attributes: unit ? { unit_of_measurement: unit } : {} });
        const states: Record<string, unknown> = {
            "sensor.solar": s("3000", "W"),
            "sensor.grid": s("2000", "W"),
            "sensor.battery": s("-1000", "W"),
            "sensor.house": s(v.power ?? "7800", "W"),
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
                node: "house", section: "today", asOf: "2026-10-21T12:00:00+00:00", period, currency: null, complete: false,
                unavailable: "no_house_meter", house: null, independence: null, selfConsumption: null, consumers: null,
            }
            : {
                node: "house", section: "today", asOf: "2026-10-21T11:55:00+00:00", period, currency: "CZK/kWh", complete: false,
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
            report: "ranking", start_date: "2026-10-21", end_date: "2026-10-21", currency: "CZK/kWh",
            complete: false, as_of: "2026-10-21T11:55:00+00:00", range: { minDate: "2026-01-01", maxDate: "2026-10-21" },
            meters: { grid: true, solar: true, battery: true, house: true },
            charge_origin: {}, solar_totals: {}, house_kwh: 20, ambiguous_kwh: 0, unattributed_kwh: 2, mismatch_kwh: 0,
            nodes: [
                { id: "house", label: "", icon: null, estimated: false, unmeasured: false, kwh: 20, coverage: 1, first_hour: null,
                  parent_id: null, depth: 0, children: ["sensor.ev_energy"],
                  sources: { solar: 8, battery: 4, grid: 6, unattributed: 2 },
                  money: { paid: { amount: 25.4, priced_kwh: 18, unpriced_kwh: 2, tariff_kwh: 0 }, forgone: { amount: 6.1, priced_kwh: 18, unpriced_kwh: 2 } },
                  overallocated_kwh: 0 },
                { id: "sensor.ev_energy", label: "EV", icon: null, estimated: false, unmeasured: false, kwh: 6, coverage: 1, first_hour: null,
                  parent_id: "house", depth: 1, children: [],
                  sources: { solar: 2, battery: 1, grid: 3, unattributed: 0 },
                  money: { paid: { amount: 12, priced_kwh: 6, unpriced_kwh: 0, tariff_kwh: 0 }, forgone: { amount: 1.2, priced_kwh: 6, unpriced_kwh: 0 } },
                  overallocated_kwh: 0 },
            ],
        };
        // The plan: the boiler from 13:00 to 14:00, the EV a candidate 15:00–16:00.
        const slots = [];
        for (let i = 0; i < 48; i += 1) {
            const at = new Date(Date.parse("2026-10-21T11:45:00Z") + i * 900_000);
            const hour = at.getUTCHours();
            const controllables: Record<string, unknown> = { inverter: { kind: "normal", setBy: "automation" } };
            if (hour === 13) controllables.boiler = { on: true, setBy: "automation" };
            if (hour === 15) controllables.ev = { charge: true, useMode: "Fast", setBy: "automation", conditionMet: false };
            slots.push({ id: at.toISOString().replace(".000Z", "+00:00"), controllables });
        }
        const schedule = { executionEnabled: !v.executionOff, slots, runtime: { activeSlotId: "2026-10-21T12:00:00+00:00", controllables: {} } };
        // The house forecast: 0.3 kWh in the slot in progress, 0.25 kWh in every later one.
        const houseSlot = (ms: number, kwh: number) => ({
            timestamp: new Date(ms).toISOString().replace(".000Z", "+00:00"),
            nonDeferrable: { value: kwh, lower: kwh * 0.6, upper: kwh * 1.5 },
            deferrableConsumers: [],
        });
        const now = Date.parse("2026-10-21T12:00:00Z");
        const forecast = {
            solar: { status: "unavailable", points: [], actualHistory: [] },
            house_consumption: {
                status: "available", generatedAt: "2026-10-21T12:00:00+00:00", unit: "kWh", resolution: "quarter_hour",
                horizonHours: 48, trainingWindowDays: 56, historyDaysAvailable: 42, requiredHistoryDays: 14, model: "hour_of_week",
                actualHistory: [],
                currentSlot: houseSlot(now, 0.3),
                series: Array.from({ length: 140 }, (_, i) => houseSlot(now + (i + 1) * 900_000, 0.25)),
            },
        };
        window.__requests = [];
        window.__hass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) => {
                    window.__requests.push({ type: msg.type });
                    return msg.type === "helman/get_forecast" ? forecast : {};
                },
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string; report?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section, report: msg.report });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return schedule;
                if (msg.type === "helman/device_report") return ranking;
                if (msg.type === "helman/get_node_detail") {
                    if (msg.node === "inverter") {
                        return {
                            node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: false, profile: null, mode: null,
                            entities: {}, maxAllowedExportPower: null,
                            agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, registers: [] },
                            condition: null, sections: [],
                        };
                    }
                    if (msg.section === "today") return today;
                    if (msg.section === "pattern") return pattern;
                    return overview;
                }
                return {};
            },
        };
    }, variant);
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(async () => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = window.__hass;
        document.body.appendChild(card);
    });
}

const houseCell = (page: Page) => page.locator(".node-cell:has(simple-card-house)");
const content = (page: Page) => page.locator("node-detail-house-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const sectionRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.node === "house" && r.section).map((r) => r.section));
const reportRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/device_report").length);

async function openDetail(page: Page): Promise<void> {
    await houseCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test.describe("the house overview", () => {
    test("opens compact: power, the live mix, today's energy and paid cost, the next load and five closed questions; no device tree", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Using 7.8 kW.");
        await expect(overview.locator("[data-live-mix]")).toContainText("Supplied now: solar 50 % · battery 20 % · grid 30 %");
        await expect(overview.locator(".figure")).toHaveCount(2);
        await expect(overview.locator("[data-figure='today']")).toContainText("20 kWh");
        await expect(overview.locator("[data-figure='paid']")).toContainText("≈ 25.40 CZK");
        await expect(overview.locator("[data-figure='paid']")).toContainText("estimate");
        await expect(overview.locator("[data-next]")).toHaveText("Next planned: Boiler at 13:00");

        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["sources", "consumers", "next", "pattern", "phases"]);
        for (const id of ids) await expect(header(page, id!)).toHaveAttribute("aria-expanded", "false");
        // The card stays the route to individual devices: no tree in the dialog.
        await expect(content(page).locator("helman-tree-item, helman-house-devices-section")).toHaveCount(0);
        await expect(content(page).locator("table, .heatmap, helman-solar-inspector-card, helman-device-report-ranking")).toHaveCount(0);
        // Today's figures come with the overview; the history only with its answer.
        await expect.poll(() => sectionRequests(page)).toEqual(["today"]);
        expect(await reportRequests(page)).toBe(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
    });

    test("answer previews say the answer", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(question(page, "sources").locator(".preview")).toHaveText("solar 40 % · battery 20 % · grid 30 %");
        await expect(question(page, "consumers").locator(".preview")).toHaveText("Most: EV 6.0 kWh");
        // 0.3 kWh in the slot in progress and 47 × 0.25 kWh to midnight.
        await expect(question(page, "next").locator(".preview")).toHaveText("≈ 12 kWh for the rest of today · Boiler at 13:00");
        await expect(question(page, "phases").locator(".preview")).toHaveText("L1 3.0 kW · L2 2.5 kW · L3 2.3 kW");
    });

    test("an unreadable house sensor is no reading, never 0 W", async ({ page }) => {
        await mount(page, { power: "unavailable" });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("No house power reading right now.");
    });
});

test.describe("what powered the house", () => {
    test("today's split, independence with its unknown share, and self-consumption over solar production", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "sources").click();
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
        await header(page, "sources").click();
        await expect(question(page, "sources").locator("[data-today-unavailable]")).toHaveText("Needs a house energy meter.");
    });
});

test.describe("what used the most", () => {
    test("the top three loads counted once, the rest and the unmeasured remainder; the full ranking only as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "consumers").click();
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
            const hass = window.__hass;
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
        await header(page, "next").click();
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
        await header(page, "next").click();
        await expect(question(page, "next").locator("[data-execution-off]")).toContainText("does not carry it out");
    });
});

test.describe("is today unusual", () => {
    test("requested only when opened; today against the same hours of earlier weekdays, and the overnight minimum without a diagnosis", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect.poll(() => sectionRequests(page)).toEqual(["today"]);
        await header(page, "pattern").click();
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
        await header(page, "pattern").click();
        await expect(question(page, "pattern").locator("[data-partial-today]")).toContainText("11 of 12 completed hours; only those hours are compared");
    });
});

test.describe("phases", () => {
    test("measured, assigned and the difference per phase, each with its devices, and a No phase group", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "phases").click();
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
        await expect(question(page, "phases").locator(".preview")).toHaveText("L1 2.6 kW · L2 3.1 kW · L3 1.1 kW (est.)");
        await header(page, "phases").click();
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
        await expect(question(page, "phases").locator(".preview")).toHaveText("No devices mapped to a phase");
        await header(page, "phases").click();
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
        await header(page, "phases").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "phases")).toHaveAttribute("aria-expanded", "true");
        await expect(header(page, "phases")).toBeFocused();
        await evidence(page, "phases").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "phases").locator("[data-phase-inputs]")).toBeVisible();

        await header(page, "sources").click();
        await expect(header(page, "phases")).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "phases").locator("[data-phase-measured]")).toHaveCount(0);

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(header(page, "sources")).toHaveAttribute("aria-expanded", "false");
    });

    test("live readings reach the open phase estimate", async ({ page }) => {
        await mount(page, { noMeasured: true });
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__hass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.ev_power": { state: "3", attributes: { unit_of_measurement: "kW" } } } };
        });
        await expect(question(page, "phases").locator(".preview")).toHaveText("L1 2.6 kW · L2 4.1 kW · L3 1.1 kW (est.)");
    });
});

test.describe("a Custom inverter", () => {
    test("keeps every question; no EPS readings and no exception", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["sources", "consumers", "next", "pattern", "phases"]);
        await header(page, "phases").click();
        await evidence(page, "phases").click();
        await expect(question(page, "phases")).not.toContainText("EPS");
    });
});

test.describe("screenshots", () => {
    test.skip(!SCREENS, "set P5_SCREENS to a directory to capture the review screenshots");
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        test(`overview and expanded answers at ${name}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mount(page, { offGrid: true });
            await openDetail(page);
            await page.screenshot({ path: `${SCREENS}/${name}-overview.png`, fullPage: true });
            for (const id of ["sources", "consumers", "next", "pattern", "phases"]) {
                await header(page, id).click();
                await evidence(page, id).click();
                await page.waitForTimeout(300);
                await page.screenshot({ path: `${SCREENS}/${name}-${id}.png`, fullPage: true });
            }
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});
