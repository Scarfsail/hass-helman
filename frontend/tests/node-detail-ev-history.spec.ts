import { prepareNodeDetailPage, mountSimpleCard, treeNode } from "./support/node-detail-harness";
import { energyFields, scheduleSlots, treePayload } from "./support/payload-builders";
import type { TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The EV charger's History & statistics: the picked period every consumer
 * shows (#741, #744, from `helman/get_node_history`) and the charging
 * ledger's health in Technical details (#428).
 *
 * Mounted on the real `helman-card` like `node-detail-ev-charger.spec.ts`,
 * against a fake backend answering the charger's overview, its `segment` and
 * `history` sections, its node history and its learned usage. Pinned: no
 * segment list and no "Charged today"; the header's running power and cost
 * per hour and its fallback to the period's kWh; the period picker; the
 * gauges and rows; the estimate's disclosure; failure and Custom charger
 * states; and the ledger's health.
 *
 * The clock is fixed at 12:00 UTC on Wednesday 21 October 2026, HA in UTC.
 */

type Variant = {
    /** A Custom charger: no profile, no run mode, no ledger offered. */
    custom?: boolean;
    historyFails?: boolean;
    /** No house dataset: nothing attributed. */
    noHouse?: boolean;
    /** The node history has data for only this many of the 30 days. */
    coveredDays?: number;
    /** No learned usage record: no running power. */
    noStats?: boolean;
    /** Only the whole paid side is priced, and it was paid back: no source's money is. */
    paidBackOnly?: boolean;
    /** Hold the node history's answer until `__releaseNodeHistory()`. */
    holdNodeHistory?: boolean;
};

declare global {
    interface Window {
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
        __releaseNodeHistory: () => void;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
    const dto = (overrides: Partial<TreeItemDTO>) => treeNode({ childrenFullWidth: true, ...overrides });
    const tree = treePayload({
        sources: [
            dto({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar", ...energyFields("solar") }),
            dto({ id: "grid", displayName: "Grid", powerSensorId: "sensor.grid", isSource: true, sourceType: "grid", ...energyFields("grid") }),
        ],
        consumers: [dto({
            id: "house", displayName: "House", powerSensorId: "sensor.house",
            children: [dto({
                id: "sensor.ev_energy", displayName: "Garage EV", powerSensorId: "sensor.ev_power", energyEntityId: "sensor.ev_energy",
                controllableIds: ["garage-ev"], applianceKind: "ev_charger", switchEntityId: "switch.ev_charge",
            })],
        })],
        consumptionTotalSensorId: null, productionTotalSensorId: null,
        uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
    });
    await page.evaluate(({ v, tree, schedule }) => {
        window.__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
        (window as any).loadCardHelpers = async () => ({ createCardElement: () => document.createElement("div") });
        const s = (value: string, unit?: string) => window.__nodeDetailState(value, unit, {}, "2026-10-21T11:59:50+00:00");
        const states: Record<string, any> = {
            "sensor.solar": s("4200", "W"), "sensor.house": s("8000", "W"), "sensor.grid": s("3800", "W"),
            "sensor.ev_power": s("6400", "W"), "sensor.ev_energy": s("9474.7", "kWh"), "switch.ev_charge": s("on"),
            "sensor.ev_run_mode": s("Charging"), "sensor.ev_session_energy": s("9.5", "kWh"), "sensor.kona_soc": s("50", "%"),
        };
        for (const [id, state] of Object.entries(states)) state.entity_id = id;
        const overview = (deviceId: string) => ({
            node: "ev_charger", deviceId, asOf: "2026-10-21T12:00:00+00:00",
            profile: v.custom ? null : { id: "solax_ev_charger", label: "SolaX EV charger" },
            entities: {
                power: "sensor.ev_power", energy_total: "sensor.ev_energy", charge_switch: "switch.ev_charge",
                ...(v.custom ? {} : { run_mode: "sensor.ev_run_mode", session_energy: "sensor.ev_session_energy" }),
            },
            status: v.custom ? null : { kind: "charging", runMode: "Charging", entityId: "sensor.ev_run_mode" },
            sections: v.custom ? ["segment"] : ["segment", "history"],
        });
        const segmentSection = {
            node: "ev_charger", section: "segment", deviceId: "garage-ev", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" },
            chargingSince: null, charging: v.custom ? null : [],
        };
        const money = (amount: number, pricedKwh: number, unpricedKwh = 0) => ({ amount, pricedKwh, unpricedKwh });
        const segment = (start: string, end: string, kwh: number, extra: Record<string, unknown> = {}) => {
            const sources = v.noHouse ? null : { solar: kwh * 0.5, battery: 0, grid: kwh * 0.5, unknown: 0 };
            return {
                id: start, start, end, localDate: start.slice(0, 10), startKnown: true, endKnown: true, status: "closed",
                final: true, kwhComplete: true, kwh, sources, knownKwh: sources ? kwh : 0,
                paid: v.noHouse ? money(0, 0, kwh) : money(kwh * 2, kwh), forgone: money(0, kwh), gridPaid: money(kwh * 2, kwh / 2),
                batteryPaid: money(0, 0), solarForgone: money(kwh / 2, kwh / 2), virtual: money(kwh * 2.5, kwh), ...extra,
            };
        };
        const segments = [
            segment("2026-10-21T11:20:00+00:00", "2026-10-21T12:00:00+00:00", 4.3, { status: "active", final: false }),
            segment("2026-10-21T08:00:00+00:00", "2026-10-21T09:30:00+00:00", 9.6),
            // A negative price: paid back.
            segment("2026-10-20T22:00:00+00:00", "2026-10-21T02:10:00+00:00", 21.8, { paid: money(-5, 21.8), gridPaid: money(-5, 21.8), batteryPaid: money(0, 0) }),
            // Partly priced.
            segment("2026-10-19T11:05:00+00:00", "2026-10-19T15:40:00+00:00", 18.2, { paid: money(30, 15, 3.2) }),
            // The charger went offline: the end is not recorded, the kWh a lower bound.
            segment("2026-10-19T13:00:00+00:00", "2026-10-19T13:50:00+00:00", 3.2, { endKnown: false, kwhComplete: false }),
            // The start is not recorded, and nothing says where the energy came from.
            segment("2026-10-17T05:00:00+00:00", "2026-10-17T07:10:00+00:00", 6.1, { startKnown: false, kwhComplete: false, sources: null, knownKwh: 0 }),
            ...Array.from({ length: 14 }, (_, index) => {
                const day = String(16 - index).padStart(2, "0");
                return segment(`2026-10-${day}T10:00:00+00:00`, `2026-10-${day}T11:00:00+00:00`, 5);
            }),
        ];
        const period = {
            id: "sensor.ev_energy", label: "Garage EV", icon: null, estimated: false, unmeasured: false, kwh: 216,
            coverage: v.coveredDays ? v.coveredDays / 30 : 1,
            firstHour: v.coveredDays ? "2026-10-09T00:00:00+00:00" : "2026-09-22T00:00:00+00:00",
            startDate: "2026-09-22", endDate: "2026-10-21", priceUnit: "CZK/kWh", complete: false,
            navigationRange: { minDate: "2026-08-01", maxDate: "2026-10-21" },
            bucket: "day",
            series: Array.from({ length: 30 }, (_, index) => ({
                start: new Date(Date.UTC(2026, 8, 22 + index)).toISOString().slice(0, 10), kwh: 7.2, solar: 3.6, battery: 0.6, grid: 2.8, unknown: 0.2,
            })),
            totals: {
                kwh: 215, sources: v.noHouse ? null : { solar: 109, battery: 17, grid: 82, unknown: 7 }, knownKwh: v.noHouse ? 0 : 208,
                paid: v.noHouse ? money(0, 0, 215) : money(455, 208.1, 6.9), forgone: money(142, 200, 15),
                gridPaid: v.noHouse ? money(0, 0, 215) : money(412, 79, 3),
                batteryPaid: v.noHouse ? money(0, 0, 215) : money(43, 17), solarForgone: v.noHouse ? money(0, 0, 215) : money(142, 96, 13),
                virtual: v.noHouse ? money(0, 0, 215) : money(597, 208.1, 6.9),
                ...(v.paidBackOnly ? {
                    paid: money(-5, 215), gridPaid: money(0, 0, 82), batteryPaid: money(0, 0, 17), solarForgone: money(0, 0, 109), virtual: money(0, 0, 215),
                } : {}),
            },
            activeDays: 13, coveredDays: v.coveredDays ?? 30, perWeek: 13 / (v.coveredDays ?? 30) * 7, kwhPerActiveDay: 16.5,
            paidPerKwh: v.noHouse ? null : 2.19, gridPricePerKwh: v.noHouse ? null : 5.22, batteryPricePerKwh: v.noHouse ? null : 2.53, solarForgonePerKwh: v.noHouse ? null : 1.48, virtualPerKwh: v.noHouse || v.paidBackOnly ? null : 2.87,
            ...(v.paidBackOnly ? { paidPerKwh: -0.02, gridPricePerKwh: null, batteryPricePerKwh: null, solarForgonePerKwh: null } : {}),
        };
        const ledger = (deviceId: string) => ({
            node: "ev_charger", section: "history", deviceId, asOf: "2026-10-21T12:00:00+00:00", unavailable: null,
            priceUnit: "CZK/kWh",
            segments: deviceId === "garage-ev" ? segments : segments.slice(0, 1),
            complete: false,
            health: {
                recordedSince: "2026-10-09T00:00:00+00:00", segmentsStored: 37, backfill: { status: "done", recoveredDays: 10 },
                settledThrough: "2026-10-21T11:20:00+00:00", powerEntityId: "sensor.ev_power", meterEntityId: "sensor.ev_energy", error: null,
            },
        });
        const held = (name: string) => new Promise((resolve) => { (window as any)[name] = resolve; });
        const nodeHistoryHeld = v.holdNodeHistory ? held("__releaseNodeHistory") : null;
        const appliances = {
            appliances: [{
                id: "garage-ev", name: "Garage EV", kind: "ev_charger", primaryEntityId: "switch.ev_charge", supportsAuthoring: true, normalState: "off",
                metadata: { icon: "mdi:car", maxChargingPowerKw: 11, scheduleCapabilities: { chargeToggle: true, useModes: ["Fast", "ECO"], ecoGears: ["6A"], requiresVehicleSelection: true } },
                controls: { charge: { entityId: "switch.ev_charge" } },
                vehicles: [{ id: "kona", name: "Kona", telemetry: { socEntityId: "sensor.kona_soc" }, metadata: { batteryCapacityKwh: 64, maxChargingPowerKw: 11 } }],
            }],
        };
        window.__configureNodeDetail({
            states, tree, schedule,
            hass: { user: { is_admin: true } },
            replies: {
                "helman/get_appliances": appliances,
                "helman/get_appliance_projections": { generatedAt: "2026-10-21T12:00:00+00:00", appliances: {} },
                "helman/get_node_history": async () => {
                    if (nodeHistoryHeld) await nodeHistoryHeld;
                    return period;
                },
                "helman/get_device_stats": v.noStats ? null : { running_kw: 11 },
                "helman/get_node_detail": async (msg: { section?: string; device_id?: string }) => {
                    const deviceId = msg.device_id ?? "garage-ev";
                    if (!msg.section) return overview(deviceId);
                    if (msg.section === "segment") return { ...segmentSection, deviceId };
                    if (msg.section === "history") {
                        if (v.historyFails) throw new Error("ledger down");
                        return ledger(deviceId);
                    }
                    throw new Error(`no section ${msg.section}`);
                },
            },
        });
    }, { v: variant, tree, schedule: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page, undefined, "helman-card");
    await expect.poll(() => page.evaluate(() => window.__deepAll(document, "helman-tree-item").length)).toBeGreaterThan(1);
}

async function openCharger(page: Page): Promise<void> {
    await page.evaluate(() => {
        const row = window.__deepAll(document, "helman-tree-item").find((candidate) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === "Garage EV");
        (row!.shadowRoot!.querySelector(".deviceName") as HTMLElement).click();
    });
}

const content = (page: Page) => page.locator("node-detail-ev-charger-content");
const history = (page: Page) => content(page).locator("helman-detail-section[data-history]");
const periodReads = (page: Page) => page.evaluate(() =>
    window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_history").map((r) => r.node_id));
const historyReads = (page: Page) => page.evaluate(() =>
    window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_detail" && r.section === "history").map((r) => r.device_id));

/** History's own header button, which opens and closes it. */
const historyToggle = (page: Page) => history(page).locator("button[aria-controls]:not([data-estimates-toggle])").first();

async function openHistory(page: Page): Promise<void> {
    await historyToggle(page).click();
}

test("ev-charger detail has no segment list and no today block in History", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    await expect(content(page).locator("[data-ledger-segments]")).toHaveCount(0);
    await expect(content(page).locator("[data-sources]")).toHaveCount(0);
    await expect(content(page).locator("[data-node-history]")).toBeVisible();
    // Nothing asks for today's figures of the charger any more.
    expect(await page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_detail" && r.section === "today"))).toEqual([]);
});

test("ev-charger History header gives the learned running power and what an hour of it costs, read on opening", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    const summary = history(page).locator("[slot=summary]");
    // 11 kW × the 30 days' 2.19 CZK/kWh paid.
    await expect(summary).toHaveText("11.0 kW · ≈ 24.09 CZK/h while running");
    await expect(summary.locator("b")).toHaveText("11.0 kW · ≈ 24.09 CZK/h");
    // The node history is read by the tree node's id, while History is still collapsed.
    expect(await periodReads(page)).toEqual(["sensor.ev_energy"]);
});

test("ev-charger History header gives the power alone without a price, and period figure without a learned power", async ({ page }) => {
    await mount(page, { noHouse: true });
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("11.0 kW while running");

    await mount(page, { noStats: true });
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("215 kWh for 22 September – 21 October");
});

test("ev-charger History header names the running power while the node history loads, its rate once it answers", async ({ page }) => {
    await mount(page, { holdNodeHistory: true });
    await openCharger(page);
    await expect.poll(() => periodReads(page)).toEqual(["sensor.ev_energy"]);
    await expect(history(page).locator("[slot=summary]")).toHaveText("11.0 kW while running");
    await page.evaluate(() => window.__releaseNodeHistory());
    await expect(history(page).locator("[slot=summary]")).toHaveText("11.0 kW · ≈ 24.09 CZK/h while running");
});

test("ev-charger ledger failure does not affect the History section", async ({ page }) => {
    await mount(page, { historyFails: true });
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("11.0 kW · ≈ 24.09 CZK/h while running");
    await openHistory(page);
    await expect(content(page).locator("[data-node-history]")).toBeVisible();
});

test("ev-charger last 30 days shows an energy and a money gauge with their totals and the rest under them", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    const window30 = content(page).locator("[data-node-history]");
    await expect(content(page).locator("[data-primary-date]")).toHaveText("22 September – 21 October 2026");
    await expect(content(page).locator("[data-subtitle]")).toHaveCount(0);
    await expect(content(page).locator("[data-node-history-title] helman-help-tip")).toHaveCount(1);
    await expect(window30.locator("[data-node-history-coverage]")).toHaveCount(0);
    // Two gauges as the live one's pills, each title with its total, in the live order.
    await expect(window30.locator("[data-energy-title]")).toHaveText(/Energy\s*· 215 kWh/);
    const energy = window30.locator("[data-energy] [data-source]");
    await expect(energy).toHaveText([/^\s*109\s*51 %\s*$/, /^\s*17\s*8 %\s*$/, /^\s*82\s*38 %\s*$/]);
    await expect(energy.nth(0)).toHaveAttribute("style", /--fill: 51%/);
    // Each over all the charged energy: really paid, and virtually with the solar's export income.
    await expect(window30.locator("[data-money-title]")).toHaveText(/Money\s*· paid ≈ 455 CZK · ≈ 2\.19 CZK\/kWh\s*· virtually ≈ 597 CZK · ≈ 2\.87 CZK\/kWh/);
    const money = window30.locator("[data-money] [data-money-source]");
    await expect(money).toHaveText([/≈ 142 CZK\s*≈ 1\.48 CZK\/kWh/, /≈ 43 CZK\s*≈ 2\.53 CZK\/kWh/, /≈ 412 CZK\s*≈ 5\.22 CZK\/kWh/]);
    // Filled by the money's share: 142, 43 and 412 of 597.
    await expect(money.nth(2)).toHaveAttribute("style", /--fill: 69%/);
    // Solar's money was never paid: drawn apart, and named so.
    await expect(money.nth(0)).toHaveClass(/missed/);
    await expect(money.nth(0)).toHaveAttribute("title", /not sold/);
    // Under them rows: day, per-day, how-often, running, source-unknown
    const rows = window30.locator("[data-node-history-summary] [data-row]");
    await expect(rows).toHaveCount(5);
    await expect(window30.locator("[data-row=day] .value")).toHaveText("7.2 kWh");
    await expect(window30.locator("[data-row=per-day] .value")).toHaveText("≈ 17 kWh");
    await expect(window30.locator("[data-row=how-often] .value")).toHaveText("≈ 3.0× a week · on 13 of 30 days");
    await expect(window30.locator("[data-row=running] .value")).toHaveText(/^11\.0 kW\s*typical$/);
    await expect(window30.locator("[data-row=source-unknown] .value")).toHaveText("7.0 kWh · 3 %");
    // No segment list
    await expect(content(page).locator("[data-ledger-segments]")).toHaveCount(0);
});

test("ev-charger How these are estimated discloses its evidence in place, by keyboard", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    const toggle = content(page).locator("[data-estimates-toggle]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(content(page).locator("[data-estimates]")).toHaveCount(0);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const estimates = content(page).locator("[data-estimates]");
    await expect(estimates.locator("[data-row=how-priced] .value")).toHaveText("208 of 215 kWh");
    await expect(estimates.locator("[data-row=how-known] .value")).toHaveText("208 of 215 kWh");
    await expect(estimates.locator("[data-row=how-paid] .value")).toContainText("solar is free here");
    await expect(estimates.locator("[data-row=how-per100]")).toHaveCount(0);
    await expect(estimates.locator("[data-estimates-note]")).toContainText("not your bill");
    // The charger's own note: its standby floor and without segment sentence.
    await expect(estimates.locator("[data-row=how-energy] .value")).not.toContainText("0.1 kWh");
    await expect(estimates.locator("[data-estimates-detail-note]")).toContainText("under 0.1 kWh are standby");
    await expect(estimates.locator("[data-estimates-detail-note]")).not.toContainText("a pause starts a new one");
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(content(page).locator("[data-estimates]")).toHaveCount(0);
});

test("ev-charger period picker switches period and updates node history", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    const picker = content(page).locator("helman-history-period-picker");
    await expect(picker.locator("button[data-preset=last_30]")).toHaveClass(/selected/);
    await picker.locator("button[data-preset=yesterday]").click();
    await expect(picker.locator("button[data-preset=yesterday]")).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_history").at(-1)))
        .toEqual(expect.objectContaining({ node_id: "sensor.ev_energy", start_date: "2026-10-20", end_date: "2026-10-20" }));
    await expect(picker.locator("[data-primary-date]")).toHaveText("Tuesday, 20 October 2026");

    // Reopening resets to the last 30 days and reads them again.
    await page.locator("node-detail-dialog [data-dialog='close']").click();
    await openCharger(page);
    await openHistory(page);
    await expect(picker.locator("button[data-preset=last_30]")).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_history").at(-1)))
        .toEqual(expect.objectContaining({ start_date: "2026-09-22", end_date: "2026-10-21" }));
});

test("ev-charger last 30 days names a shorter coverage, its first day, and counts by it", async ({ page }) => {
    await mount(page, { coveredDays: 13 });
    await openCharger(page);
    await openHistory(page);
    await expect(content(page).locator("[data-node-history-title]")).toContainText("data for 13 days");
    await expect(content(page).locator("[data-node-history-coverage]")).toHaveText("Data for 43 % of the period (from 9 Oct)");
    await expect(content(page).locator("[data-node-history] [data-row=how-often] .value")).toHaveText("≈ 7.0× a week · on 13 of 13 days");
});

test("ev-charger without a house dataset shows the kWh and no source or money", async ({ page }) => {
    await mount(page, { noHouse: true });
    await openCharger(page);
    await openHistory(page);
    const window30 = content(page).locator("[data-node-history]");
    await expect(window30.locator("[data-energy-title]")).toHaveText(/Energy\s*· 215 kWh/);
    await expect(window30.locator("[data-row=source-unknown] .value")).toHaveText("215 kWh · 100 %");
    // Every energy pill says its source is not known, none is filled, and there is no money.
    await expect(window30.locator("[data-energy] [data-source]")).toHaveText(["—", "—", "—"]);
    await expect(window30.locator("[data-gauges] [data-active]")).toHaveCount(0);
    await expect(window30.locator("[data-money]")).toHaveCount(0);
});

test("ev-charger keeps the money gauge for a paid total no source prices, and a total paid back says so", async ({ page }) => {
    await mount(page, { paidBackOnly: true });
    await openCharger(page);
    await openHistory(page);
    const window30 = content(page).locator("[data-node-history]");
    await expect(window30.locator("[data-money-paid]")).toHaveText("· ≈ 5.0 CZK paid back · ≈ -0.02 CZK/kWh");
    await expect(window30.locator("[data-money-virtual]")).toHaveCount(0);
    await expect(window30.locator("[data-money] [data-money-source]")).toHaveText(["—", "—", "—"]);
    await expect(window30.locator("[data-money] [data-active]")).toHaveCount(0);
});

test("ev-charger Custom charger without a run mode reads no ledger, keeps no today block and still shows its period figures", async ({ page }) => {
    await mount(page, { custom: true, noStats: true });
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("215 kWh for 22 September – 21 October");
    await openHistory(page);
    await expect(content(page).locator("[data-node-history]")).toBeVisible();
    await expect(content(page).locator("[data-sources], [data-ledger-segments]")).toHaveCount(0);
    expect(await historyReads(page)).toEqual([]);
});

test("ev-charger Technical details shows the charging ledger's health, read once it opens", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("11.0 kW · ≈ 24.09 CZK/h while running");
    expect(await historyReads(page)).toEqual([]);
    const technical = content(page).locator("helman-detail-section[data-technical]");
    await technical.locator("button").first().click();
    await expect.poll(() => historyReads(page)).toEqual(["garage-ev"]);
    const health = technical.locator("[data-ledger-health]");
    await expect(health.locator("[data-row=ledger-segments] .value")).toHaveText("37");
    await expect(health.locator("[data-row=ledger-backfill] .value")).toHaveText("done, 10 days read");
    await expect(health.locator("[data-row=ledger-power] .value")).toHaveText("sensor.ev_power");
    await expect(health.locator("[data-row=ledger-meter] .value")).toHaveText("sensor.ev_energy");
    await expect(health.locator("[data-row=ledger-since] .value")).not.toHaveText("—");
    await expect(health.locator("[data-row=ledger-settled] .value")).not.toHaveText("—");
});
