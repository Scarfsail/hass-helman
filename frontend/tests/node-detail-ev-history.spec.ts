import { prepareNodeDetailPage, mountSimpleCard, treeNode } from "./support/node-detail-harness";
import { energyFields, scheduleSlots, treePayload } from "./support/payload-builders";
import type { TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The EV charger's charging ledger in History & statistics (#428): the last
 * 30 days, the newest charging segments and the ledger's health.
 *
 * Mounted on the real `helman-card` like `node-detail-ev-charger.spec.ts`,
 * against a fake backend answering the charger's overview and its `today`,
 * `segment` and `history` sections. Pinned: the ledger is read only once the
 * overview offers it and its body only while History is open; the header's
 * fallback to today's figure; the segment list and its states; the
 * estimate's disclosure; failure, empty and Custom charger states; and that
 * an answer for another charger is never shown.
 *
 * The clock is fixed at 12:00 UTC on Wednesday 21 October 2026, HA in UTC.
 */

type Variant = {
    /** A Custom charger: no profile, no run mode, no ledger offered. */
    custom?: boolean;
    historyFails?: boolean;
    /** The ledger has recorded nothing yet. */
    empty?: boolean;
    /** No house dataset: nothing attributed. */
    noHouse?: boolean;
    /** The ledger has recorded only this many of the 30 days. */
    coveredDays?: number;
    /** Hold the overview's answer until `__releaseOverview()`. */
    holdOverview?: boolean;
    /** Hold garage-ev's ledger answer until `__releaseLedger()`. */
    holdLedger?: boolean;
};

declare global {
    interface Window {
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
        __releaseOverview: () => void;
        __releaseLedger: () => void;
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
        uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
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
            sections: v.custom ? ["today", "segment"] : ["today", "segment", "history"],
        });
        const today = {
            node: "ev_charger", section: "today", deviceId: "garage-ev", asOf: "2026-10-21T11:55:00+00:00",
            period: { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" },
            priceUnit: "CZK/kWh", complete: false, unavailable: null,
            charger: {
                kwh: 6.4, coverage: 0.95, estimated: false,
                sources: { solar: 4.0, battery: 0.4, grid: 1.8, unattributed: 0.2 },
                money: { paid: 7.2, paidPricedKwh: 1.8, paidUnpricedKwh: 0, forgone: 4.8, forgonePricedKwh: 4.0, forgoneUnpricedKwh: 0 },
            },
        };
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
                solarForgone: money(kwh / 2, kwh / 2), ...extra,
            };
        };
        const segments = v.empty ? [] : [
            segment("2026-10-21T11:20:00+00:00", "2026-10-21T12:00:00+00:00", 4.3, { status: "active", final: false }),
            segment("2026-10-21T08:00:00+00:00", "2026-10-21T09:30:00+00:00", 9.6),
            // A negative price: paid back.
            segment("2026-10-20T22:00:00+00:00", "2026-10-21T02:10:00+00:00", 21.8, { paid: money(-5, 21.8), gridPaid: money(-5, 21.8) }),
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
        const ledger = (deviceId: string, kwh: number) => ({
            node: "ev_charger", section: "history", deviceId, asOf: "2026-10-21T12:00:00+00:00", unavailable: null,
            window: { start: "2026-09-21T12:00:00+00:00", end: "2026-10-21T12:00:00+00:00" },
            totals: {
                kwh, sources: v.noHouse ? null : { solar: 109, battery: 17, grid: 82, unknown: 7 }, knownKwh: v.noHouse ? 0 : 208,
                paid: v.noHouse ? money(0, 0, kwh) : money(412, 208.1, 6.9), forgone: money(142, 200, 15),
                gridPaid: v.noHouse ? money(0, 0, kwh) : money(412, 79, 3), solarForgone: v.noHouse ? money(0, 0, kwh) : money(142, 96, 13),
                provisional: true,
            },
            chargingDays: 13, coveredDays: v.coveredDays ?? 30, perWeek: 13 / (v.coveredDays ?? 30) * 7,
            paidPerKwh: v.noHouse ? null : 1.98, gridPricePerKwh: v.noHouse ? null : 5.22,
            per100km: v.noHouse ? null : { entityId: "sensor.kona_consumption", kwhPer100km: 15.8, vehicleId: "kona", vehicleName: "Kona", amount: 31.28 },
            priceUnit: "CZK/kWh",
            segments,
            complete: false,
            health: {
                recordedSince: "2026-10-09T00:00:00+00:00", segmentsStored: 37, backfill: { status: "done", recoveredDays: 10 },
                settledThrough: "2026-10-21T11:20:00+00:00", runModeEntityId: "sensor.ev_run_mode", meterEntityId: "sensor.ev_energy", error: null,
            },
        });
        const held = (name: string) => new Promise((resolve) => { (window as any)[name] = resolve; });
        const overviewHeld = v.holdOverview ? held("__releaseOverview") : null;
        const ledgerHeld = v.holdLedger ? held("__releaseLedger") : null;
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
                "helman/get_node_detail": async (msg: { section?: string; device_id?: string }) => {
                    const deviceId = msg.device_id ?? "garage-ev";
                    if (!msg.section) {
                        if (overviewHeld) await overviewHeld;
                        return overview(deviceId);
                    }
                    if (msg.section === "today") return { ...today, deviceId };
                    if (msg.section === "segment") return { ...segmentSection, deviceId };
                    if (msg.section === "history") {
                        if (v.historyFails || (window as any).__ledgerDown) throw new Error("ledger down");
                        if (deviceId === "garage-ev" && ledgerHeld) {
                            await ledgerHeld;
                        }
                        return ledger(deviceId, deviceId === "garage-ev" ? 215 : 99);
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
const historyReads = (page: Page) => page.evaluate(() =>
    window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_detail" && r.section === "history").map((r) => r.device_id));

/** History's own header button, which opens and closes it. */
const historyToggle = (page: Page) => history(page).locator("button[aria-controls]:not([data-estimates-toggle])").first();

async function openHistory(page: Page): Promise<void> {
    await historyToggle(page).click();
}

test("ev-charger ledger is read only once the overview is ready, and its body renders only while History is open", async ({ page }) => {
    await mount(page, { holdOverview: true });
    await openCharger(page);
    await page.waitForTimeout(200);
    expect(await historyReads(page)).toEqual([]);

    await page.evaluate(() => window.__releaseOverview());
    await expect.poll(() => historyReads(page)).toEqual(["garage-ev"]);
    await expect(history(page).locator("[slot=summary]")).toContainText("in 30 days");
    await expect(content(page).locator("[data-ledger-window]")).toHaveCount(0);

    await openHistory(page);
    await expect(content(page).locator("[data-ledger-window]")).toBeVisible();
    await historyToggle(page).click();
    await expect(content(page).locator("[data-ledger-window]")).toHaveCount(0);
});

test("ev-charger History header gives today and the last 30 days, today alone while the ledger loads or after it failed", async ({ page }) => {
    await mount(page, { holdLedger: true });
    await openCharger(page);
    const summary = history(page).locator("[slot=summary]");
    await expect(summary).toHaveText("6.4 kWh today · 63 % solar");

    await page.evaluate(() => window.__releaseLedger());
    await expect(summary).toHaveText("6.4 kWh today · 215 kWh in 30 days");
    await expect(summary.locator("b")).toHaveText(["6.4 kWh", "215 kWh"]);
});

test("ev-charger History header falls back to today's figure when the ledger fails, with the failure and retry in the body", async ({ page }) => {
    await mount(page, { historyFails: true });
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("6.4 kWh today · 63 % solar");
    await openHistory(page);
    const notReady = content(page).locator("[data-ledger-not-ready]");
    await expect(notReady.locator("[data-history-failed]")).toBeVisible();
    // Today's block is unaffected.
    await expect(content(page).locator("[data-sources] [data-row=from-solar] .value")).toHaveText("4.0 kWh");

    // Retry asks again.
    const before = (await historyReads(page)).length;
    await notReady.locator("button").click();
    await expect.poll(async () => (await historyReads(page)).length).toBeGreaterThan(before);
});

test("ev-charger last 30 days shows the share bar, the four tiles and the battery and unknown rows", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    const window30 = content(page).locator("[data-ledger-window]");
    await expect(content(page).locator("[data-ledger-title]")).toContainText("Last 30 days");
    await expect(content(page).locator("[data-ledger-title] helman-help-tip")).toHaveCount(1);
    await expect(window30.locator("[data-share-bar] [data-share]")).toHaveCount(4);
    await expect(window30.locator("[data-stat=charged]")).toHaveText(/215 kWh\s*charged · ≈ 1\.98 CZK per kWh\s*≈ 31 CZK per 100 km/);
    await expect(window30.locator("[data-stat=how-often]")).toHaveText(/≈ 3× a week\s*charged on 13 of 30 days/);
    await expect(window30.locator("[data-stat=solar]")).toHaveText(/109 kWh · 51 %.*from solar.*≈ 142 CZK for 96 of 109 kWh not earned by selling it/s);
    await expect(window30.locator("[data-stat=grid]")).toHaveText(/82 kWh · 38 %.*from the grid.*paid ≈ 412 CZK for 79 of 82 kWh · ≈ 5\.22 CZK\/kWh/s);
    await expect(window30.locator("[data-row=ledger-battery] .value")).toHaveText("17 kWh · 8 %");
    await expect(window30.locator("[data-row=ledger-unknown] .value")).toHaveText("7.0 kWh · 3 %");
    // Forgone export value is its own figure: never in the per-kWh or per-100-km figures.
    await expect(window30.locator("[data-stat=charged]")).not.toContainText("142");
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
    await expect(estimates.locator("[data-row=how-per100] .value")).toHaveText("uses Kona's current 15.8 kWh/100 km");
    await expect(estimates.locator("[data-estimates-note]")).toContainText("not your bill");
    await expect(estimates.locator("[data-estimates-note]")).toContainText("A charging segment is one stretch of charging");
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(content(page).locator("[data-estimates]")).toHaveCount(0);
});

test("ev-charger lists the newest segments by local start day, five first and all twenty on Show all", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    const list = content(page).locator("[data-ledger-segments]");
    await expect(list.locator("[data-segment]")).toHaveCount(5);
    const days = list.locator("[data-ledger-day]");
    await expect(days.first().locator(".day-head .label")).toHaveText("Today");
    await expect(days.first().locator("[data-day-summary]")).toHaveText("14 kWh · 50 % solar · ≈ 28 CZK");
    // A segment crossing midnight is listed under its start day.
    await expect(days.nth(1).locator(".day-head .label")).toHaveText("Yesterday");
    await expect(days.nth(1).locator("[data-segment]")).toHaveCount(1);
    const show = content(page).locator("[data-show-all]");
    await expect(show).toHaveText("Show all 20");
    await show.click();
    await expect(list.locator("[data-segment]")).toHaveCount(20);
    await expect(content(page).locator("[data-show-all]")).toHaveCount(0);
    // One scale across the list: the largest segment's bar is the longest.
    const widths = await list.locator(".seg-bar").evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width));
    expect(Math.max(...widths)).toBe(widths[2]);
});

test("ev-charger segment rows say what is not recorded, what is provisional, paid back and partly priced", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await openHistory(page);
    await content(page).locator("[data-show-all]").click();
    const row = (start: string) => content(page).locator(`[data-segment="${start}"]`);
    const active = row("2026-10-21T11:20:00+00:00");
    await expect(active.locator(".seg-time")).toHaveText("11:20 – now");
    await expect(active).toHaveAttribute("data-status", "active");
    await expect(active.locator(".seg-bar.active")).toHaveCount(1);
    await expect(row("2026-10-19T13:00:00+00:00").locator(".seg-time")).toHaveText("13:00 – ?");
    await expect(row("2026-10-19T13:00:00+00:00").locator(".seg-kwh")).toHaveText("≥ 3.2");
    const unknown = row("2026-10-17T05:00:00+00:00");
    await expect(unknown.locator(".seg-time")).toHaveText("? – 07:10");
    await expect(unknown.locator("[data-share]")).toHaveCount(1);
    await expect(unknown.locator("[data-share=unknown]")).toHaveCount(1);
    await expect(content(page).locator('[data-ledger-day="2026-10-20"] [data-day-summary]')).toContainText("≈ 5.0 CZK paid back");
    await expect(content(page).locator('[data-ledger-day="2026-10-19"] [data-day-summary]')).toContainText("≈ 36 CZK for 18 of 21 kWh");
    await expect(content(page).locator('[data-ledger-day="2026-10-17"] [data-day-summary]')).toContainText("source unknown");
});

test("ev-charger labels ledger rows as charging segments and keeps the Overview's hardware session apart", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    await expect(content(page).locator("helman-detail-headline")).toContainText("added this session");
    await openHistory(page);
    await expect(content(page).locator("[data-ledger-segments] [data-segment]").first())
        .toHaveAttribute("aria-label", "Charging segment 11:20 – now, 4.3 kWh");
    await expect(content(page).locator("[data-ledger-window]")).not.toContainText("session");
});

test("ev-charger with nothing recorded yet says so and keeps today's block", async ({ page }) => {
    await mount(page, { empty: true });
    await openCharger(page);
    await openHistory(page);
    await expect(content(page).locator("[data-ledger-empty]")).toHaveText("No charging recorded yet.");
    await expect(content(page).locator("[data-sources]")).toBeVisible();
    await expect(content(page).locator("[data-ledger-segments]")).toHaveCount(0);
});

test("ev-charger last 30 days names a shorter recorded coverage and counts by it", async ({ page }) => {
    await mount(page, { coveredDays: 13 });
    await openCharger(page);
    await openHistory(page);
    await expect(content(page).locator("[data-ledger-title]")).toContainText("Last 30 days · recorded for 13");
    await expect(content(page).locator("[data-ledger-window] [data-stat=how-often]")).toHaveText(/≈ 7× a week\s*charged on 13 of 13 days/);
});

test("ev-charger without a house dataset shows the kWh and no source or money", async ({ page }) => {
    await mount(page, { noHouse: true });
    await openCharger(page);
    await openHistory(page);
    const window30 = content(page).locator("[data-ledger-window]");
    await expect(window30.locator("[data-stat=charged] .stat-value")).toHaveText("215 kWh");
    await expect(window30.locator("[data-stat=charged] .stat-caption")).toHaveText("charged");
    await expect(window30.locator("[data-stat=solar] .stat-value")).toHaveText("—");
    await expect(window30.locator("[data-stat=grid] .stat-value")).toHaveText("—");
    await expect(window30.locator("[data-share-bar] [data-share=unknown]")).toHaveCount(1);
});

test("ev-charger Custom charger without a run mode reads no ledger and keeps today's block", async ({ page }) => {
    await mount(page, { custom: true });
    await openCharger(page);
    await expect(history(page).locator("[slot=summary]")).toHaveText("6.4 kWh today · 63 % solar");
    await openHistory(page);
    await expect(content(page).locator("[data-sources]")).toBeVisible();
    await expect(content(page).locator("[data-ledger-window], [data-ledger-not-ready], [data-ledger-segments]")).toHaveCount(0);
    expect(await historyReads(page)).toEqual([]);
});

test("ev-charger never shows a ledger answer meant for the charger it switched away from", async ({ page }) => {
    await mount(page, { holdLedger: true });
    await openCharger(page);
    await expect.poll(() => historyReads(page)).toEqual(["garage-ev"]);

    await content(page).evaluate((element: any) => { element.deviceId = "other-ev"; });
    await expect(history(page).locator("[slot=summary]")).toHaveText("6.4 kWh today · 99 kWh in 30 days");
    await page.evaluate(() => window.__releaseLedger());
    await page.waitForTimeout(300);
    await expect(history(page).locator("[slot=summary]")).toHaveText("6.4 kWh today · 99 kWh in 30 days");
});

test("ev-charger Technical details shows the charging ledger's health", async ({ page }) => {
    await mount(page);
    await openCharger(page);
    const technical = content(page).locator("helman-detail-section[data-technical]");
    await technical.locator("button").first().click();
    const health = technical.locator("[data-ledger-health]");
    await expect(health.locator("[data-row=ledger-segments] .value")).toHaveText("37");
    await expect(health.locator("[data-row=ledger-backfill] .value")).toHaveText("done, 10 days read");
    await expect(health.locator("[data-row=ledger-run-mode] .value")).toHaveText("sensor.ev_run_mode");
    await expect(health.locator("[data-row=ledger-meter] .value")).toHaveText("sensor.ev_energy");
    await expect(health.locator("[data-row=ledger-since] .value")).not.toHaveText("—");
    await expect(health.locator("[data-row=ledger-settled] .value")).not.toHaveText("—");
});
