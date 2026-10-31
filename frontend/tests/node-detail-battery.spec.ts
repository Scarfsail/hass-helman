import { prepareNodeDetailPage, mountSimpleCard, liveFigures, onDashboard, expectShowMore } from "./support/node-detail-harness";
import { cardTree, forecastPayload, scheduleSlots } from "./support/payload-builders";
import type { ForecastPayload, ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The battery node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the battery overview and its
 * charge section), the schedule and the forecast. What is pinned is
 * the shared visual language (a status pill, the Now/Today flow around the SoC
 * glyph, answer tiles, readings that open more-info), the disclosure contract
 * (the pictures open the questions they absorb, one open answer under the
 * tiles, answer then evidence, nothing heavy mounted or requested while
 * closed) and the battery's truthfulness: a BMS ceiling is not proof of a
 * binding cap, a cold reading is not a cause, today's charge is not the stored
 * energy, the daily ratio is not an efficiency and throughput cycles are not
 * health.
 */

type Variant = {
    recordedForecast?: boolean;
    missingLastForecast?: boolean;
    profile?: boolean;
    /** The battery meter's state, W, positive charging. */
    power?: string;
    /** The BMS current limits are disabled on the hardware. */
    noBmsCurrents?: boolean;
    temperature?: string;
    bmsDisconnected?: boolean;
    /** The battery has not charged today. */
    noCharge?: boolean;
    /** Minutes the time-to-empty sensor reads. */
    timeToEmpty?: string;
    temperatureUnit?: string;
    forecastFails?: boolean;
    remainingUnit?: string;
    todayUnit?: string;
    minSoc?: string;
    maxSoc?: string;
    remaining?: string;
    /** The solar, house and grid meters' states, W. */
    solar?: string;
    house?: string;
    grid?: string;
    soc?: string;
    /** The inverter's rated power register, W; absent without one. */
    ratedPower?: string;
    /** The slot in progress holds a charge candidate whose condition is not met. */
    candidateNow?: boolean;
    /** Schedule execution is switched off. */
    executionOff?: boolean;
    /** The slot in progress plans a charge that would apply if execution were on. */
    chargeNow?: boolean;
    /** The mode the inverter reports; `normal` unless given, `null` when it reads none. */
    observed?: string | null;
    /** The planned SoC at the end of each 15-minute slot from 12:00, and whether the slot hits the floor or the ceiling. */
    socPath?: Array<{ soc: number; min?: boolean; max?: boolean }>;
    /** The forecast's SoC now; 67 unless given. */
    currentSoc?: number;
    /** The viewer is an admin. */
    admin?: boolean;
};

declare global {
    interface Window {
        __BatteryHass: any;
        __BatteryRequests: Array<{ type: string; node?: string; section?: string }>;
        __moreInfo: string[];
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate(({ v, tree, forecastDefaults, scheduleDefaults }) => {
        const profile = v.profile !== false;
        const s = window.__nodeDetailState;
        const telemetry: Record<string, [string, string, string?]> = {
            battery_voltage: ["sensor.solax_battery_voltage_charge", "355.6", "V"],
            battery_current: ["sensor.solax_battery_current_charge", "-5.9", "A"],
            battery_temperature: ["sensor.solax_battery_temperature", v.temperature ?? "24", v.temperatureUnit ?? "°C"],
            chargeable_energy: ["sensor.solax_chargeable_battery_capacity", "5702", "Wh"],
            max_charge_rate: ["sensor.solax_inverter_battery_max_charge_rate", "10668", "W"],
            bdc_status: ["sensor.solax_inverter_bdc_status", "Discharge"],
            bms_charge_max_current: ["sensor.solax_bms_charge_max_current", "25.0", "A"],
            bms_discharge_max_current: ["sensor.solax_bms_discharge_max_current", "30.0", "A"],
            input_energy_total: ["sensor.solax_battery_input_energy_total", "3100.0", "kWh"],
            output_energy_total: ["sensor.solax_battery_output_energy_total", "2800.0", "kWh"],
            cell_voltage_high: ["sensor.solax_cell_voltage_high", "3.342", "V"],
            cell_voltage_low: ["sensor.solax_cell_voltage_low", "3.330", "V"],
            cell_voltage_difference: ["sensor.solax_battery_voltage_cell_difference", "0.012", "V"],
            battery_type: ["sensor.solax_battery_type", "Lithium"],
            battery_temp_high: ["sensor.solax_battery_temp_high", "25.0", "°C"],
            battery_temp_low: ["sensor.solax_battery_temp_low", "23.0", "°C"],
            bms_connect_state: ["sensor.solax_bms_connect_state", v.bmsDisconnected ? "Disconnected" : "Connected"],
            battery_heating: ["switch.solax_inverter_battery_heating", "off"],
            battery_heating_start_1: ["time.solax_inverter_battery_heating_start_time_1", "00:00:00"],
            battery_heating_end_1: ["time.solax_inverter_battery_heating_end_time_1", "00:00:00"],
            battery_heating_start_2: ["time.solax_inverter_battery_heating_start_time_2", "00:00:00"],
            battery_heating_end_2: ["time.solax_inverter_battery_heating_end_time_2", "00:00:00"],
            battery_charge_max_current: ["number.solax_battery_charge_max_current", "30.0", "A"],
            battery_discharge_max_current: ["number.solax_battery_discharge_max_current", "30.0", "A"],
            use_mode: ["select.solax_charger_use_mode", "Self Use Mode"],
            run_mode: ["sensor.solax_run_mode", "Normal Mode"],
        };
        const states: Record<string, unknown> = {
            "sensor.solar": s(v.solar ?? "4200", "W"), "sensor.grid": s(v.grid ?? "-300", "W"), "sensor.battery": s(v.power ?? "-2100", "W"),
            "sensor.house": s(v.house ?? "1200", "W"),
            "sensor.soc": s(v.soc ?? "67", "%"), "sensor.remaining": s(v.remaining ?? "11577", v.remainingUnit ?? "Wh"),
            "number.min_soc": s(v.minSoc ?? "10", "%"), "number.max_soc": s(v.maxSoc ?? "100", "%"),
            "sensor.solax_inverter_power_type": s(v.ratedPower ?? "unknown", "W"),
            "sensor.battery_in_today": s("6.2", v.todayUnit ?? "kWh"), "sensor.battery_out_today": s("4.1", "kWh"),
            "sensor.helman_battery_time_to_empty": s(v.timeToEmpty ?? "280", "min", { target_time: "2026-10-21T16:40:00+00:00", target_soc: 10 }),
            "sensor.helman_battery_time_to_full": s("unknown", "min", { target_time: "", target_soc: null }),
        };
        const entities: Record<string, string | null> = {
            soc: "sensor.soc", remaining_energy: "sensor.remaining", min_soc: "number.min_soc", max_soc: "number.max_soc",
            today_charge: "sensor.battery_in_today", today_discharge: "sensor.battery_out_today",
            time_to_full: "sensor.helman_battery_time_to_full", time_to_empty: "sensor.helman_battery_time_to_empty",
        };
        if (profile) {
            for (const [key, [entityId, state, unit]] of Object.entries(telemetry)) {
                const disabled = v.noBmsCurrents && key.startsWith("bms_") && key.endsWith("_current");
                entities[key] = disabled ? null : entityId;
                if (!disabled) states[entityId] = s(state, unit, { friendly_name: key.replace(/_/g, " ") });
            }
        }
        const overview = {
            node: "battery",
            asOf: "2026-10-21T12:00:00+00:00",
            profile: profile ? { id: "solax_inverter", label: "SolaX inverter" } : null,
            entities,
            configured: { maxChargePowerW: 5000, maxDischargePowerW: 6000 },
            cycles: profile
                ? { cycles: 170.3, inputKwh: 3100, outputKwh: 2800, capacityKwh: 17.32, reason: null }
                : { cycles: null, inputKwh: null, outputKwh: null, capacityKwh: 17.32, reason: "no_counters" },
            condition: v.bmsDisconnected ? { kind: "bms_disconnected", state: "Disconnected", entityId: "sensor.solax_bms_connect_state" } : null,
            sections: ["charge"],
        };
        const day = "2026-10-21";
        const charge = v.noCharge
            ? {
                chargedKwh: 0, solarKwh: 0, gridKwh: 0, unknownKwh: 0, gridPricedKwh: 0, gridTariffKwh: 0, gridUnpricedKwh: 0,
                solarPricedKwh: 0, solarUnpricedKwh: 0, paidRate: null, forgoneRate: null, paidCost: 0, forgoneValue: 0,
            }
            : {
                chargedKwh: 6.2, solarKwh: 4.2, gridKwh: 1.5, unknownKwh: 0.5, gridPricedKwh: 1.0, gridTariffKwh: 0, gridUnpricedKwh: 0.5,
                solarPricedKwh: 4.2, solarUnpricedKwh: 0, paidRate: 4.0, forgoneRate: 1.2, paidCost: 4.0, forgoneValue: 5.04,
            };
        const section = {
            node: "battery", section: "charge", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            priceUnit: "CZK/kWh", complete: false, unavailable: null, charge,
        };
        // 15-minute slots from 11:45 today for a day and a half.
        const slots: ScheduleSlotDTO[] = [];
        const start = Date.parse(`${day}T11:45:00Z`);
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = at.getUTCHours() + (at.getUTCDate() - 21) * 24;
            let action: ScheduleActionDTO = { kind: "normal", setBy: "automation" };
            if (hour >= 14 && hour < 16) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (v.chargeNow && hour === 12) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (v.candidateNow && hour === 12) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation", conditionMet: false };
            if (hour >= 18 && hour < 19) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
            slots.push({ id, controllables: { inverter: action } });
        }
        const schedule: SchedulePayload = {
            ...scheduleDefaults,
            executionEnabled: !v.executionOff,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: { actionKind: "apply", outcome: "success", executedAction: { kind: "normal" }, reason: "scheduled" } },
            },
        };
        const forecastSlot = (iso: string, soc: number, hitMinSoc = false, hitMaxSoc = false) => ({
            timestamp: iso, durationHours: 0.25, solarKwh: 0, baselineHouseKwh: 0, netKwh: 0, chargedKwh: 0, dischargedKwh: 0,
            remainingEnergyKwh: 0, socPct: soc, importedFromGridKwh: 0, exportedToGridKwh: 0,
            hitMinSoc, hitMaxSoc, limitedByChargePower: false, limitedByDischargePower: false,
        });
        const forecast: ForecastPayload = {
            ...forecastDefaults,
            battery_capacity: {
                ...forecastDefaults.battery_capacity,
                status: "available", generatedAt: null, startedAt: null, unit: "kWh",
                model: null, nominalCapacityKwh: 17.3, currentRemainingEnergyKwh: 11.6, currentSoc: v.currentSoc ?? 67, minSoc: 10, maxSoc: 100,
                chargeEfficiency: 0.95, dischargeEfficiency: 0.95, maxChargePowerW: 5000, maxDischargePowerW: 6000,
                partialReason: null, coverageUntil: null,
                actualHistory: [{ timestamp: `${day}T11:30:00+00:00`, startSocPct: 70, socPct: 69 }, { timestamp: `${day}T11:45:00+00:00`, startSocPct: 69, socPct: 67 }],
                forecastHistory: v.recordedForecast ? [
                    { timestamp: `${day}T10:00:00Z`, value: 100 },
                    { timestamp: `${day}T11:30:00Z`, value: 2 },
                    ...(v.missingLastForecast ? [] : [{ timestamp: `${day}T11:45:00Z`, value: 30 }]),
                ] : [],
                series: v.socPath
                    ? v.socPath.map((slot, index) => forecastSlot(new Date(Date.parse(`${day}T12:00:00Z`) + index * 900_000).toISOString(), slot.soc, slot.min, slot.max))
                    : [forecastSlot(`${day}T12:00:00+00:00`, 66), forecastSlot(`${day}T12:15:00+00:00`, 64)],
            },
        };
        const inverter = window.__inverterOverview({
            entities: v.ratedPower ? { rated_power: "sensor.solax_inverter_power_type" } : {},
            agreement: { status: "match", reason: null, commanded: null, observedOption: v.observed === undefined ? "normal" : v.observed, observedFrom: [], registers: [] },
        });
        window.__moreInfo = [];
        document.addEventListener("hass-more-info", (event) => window.__moreInfo.push((event as CustomEvent).detail.entityId));
        window.__BatteryHass = window.__configureNodeDetail({
            states, tree, overviews: { battery: overview, inverter }, sections: { battery: { charge: section } }, forecast: v.forecastFails ? "error" : forecast, schedule,
            replies: { "recorder/statistic_during_period": { min: 6, max: 14 } },
            hass: v.admin ? { user: { is_admin: true } } : {},
        });
        window.__BatteryRequests = window.__NodeDetailRequests;
    }, { v: variant, tree: cardTree(), forecastDefaults: forecastPayload(), scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page);
}


const content = (page: Page) => page.locator("node-detail-battery-content");

async function openDetail(page: Page): Promise<void> {
    await page.locator(".node-cell:has(simple-card-battery)").click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test("battery Overview has SoC, recent-rate estimate, destination gauge and inverter link", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    await expect(content(page).locator("helman-detail-headline")).toContainText("67 %");
    await expect(content(page).locator("simple-card-battery")).toHaveCount(1);
    await expect(content(page).locator("[data-estimate]")).toContainText("4 h");
    await expect(content(page).locator("helman-flow-gauge")).toHaveAttribute("direction", "to");
    await content(page).getByRole("button", { name: /Controlled through the inverter/ }).click();
    await expect(page.locator("node-detail-inverter-content")).toBeVisible();
});

test("battery mode now shows the mode the inverter reports while an unmet candidate is planned", async ({ page }) => {
    await mount(page, { candidateNow: true });
    await openDetail(page);
    const mode = content(page).locator("[data-inverter-control] .row").nth(1).locator(".value");
    await expect(mode).toHaveText("Normal");
    await expect(mode).not.toContainText("Charg");
});

test("battery mode now shows the inverter's mode, not the planned charge, while execution is off", async ({ page }) => {
    await mount(page, { executionOff: true, chargeNow: true, observed: "normal" });
    await openDetail(page);
    const mode = content(page).locator("[data-inverter-control] .row").nth(1).locator(".value");
    await expect(mode).toHaveText("Normal");
    await expect(mode).not.toContainText("Charg");
});

test("battery mode now shows a dash when the inverter reports no mode", async ({ page }) => {
    await mount(page, { observed: null });
    await openDetail(page);
    await expect(content(page).locator("[data-inverter-control] .row").nth(1).locator(".value")).toHaveText("—");
});

for (const first of ["battery", "inverter"] as const) {
    test(`battery keeps watching its own entities and the inverter's mode when the ${first} overview answers first`, async ({ page }) => {
        await mount(page);
        await page.evaluate((first) => {
            const hass = window.__BatteryHass;
            const original = hass.callWS;
            const held: Record<string, () => void> = {};
            (window as any).__releaseOverview = (node: string) => held[node]?.();
            hass.callWS = async (request: any) => {
                if (request.type !== "helman/get_node_detail" || request.section) return original(request);
                const hold = new Promise<void>((resolve) => { held[request.node] = resolve; });
                const answer = await original(request);
                await hold;
                if (request.node !== "inverter") return answer;
                // The inverter reports whatever its mode register reads when asked.
                const charging = ((window as any).__currentHass ?? hass).states["select.helman_inverter_mode"]?.state === "charge";
                return { ...answer, mode: { entityId: "select.helman_inverter_mode", actionOptions: {} },
                    agreement: { ...answer.agreement, observedOption: charging ? "charge_to_target_soc" : "normal" } };
            };
            hass.states["select.helman_inverter_mode"] = { entity_id: "select.helman_inverter_mode", state: "idle", attributes: {}, last_changed: "", last_updated: "", context: { id: "" } };
            void first;
        }, first);
        await page.locator(".node-cell:has(simple-card-battery)").click();
        const second = first === "battery" ? "inverter" : "battery";
        for (const node of [first, second]) {
            await expect.poll(() => page.evaluate((n) => window.__NodeDetailRequests.some((r) => r.type === "helman/get_node_detail" && r.node === n && !r.section), node)).toBe(true);
            await page.evaluate((n) => (window as any).__releaseOverview(n), node);
        }
        const mode = content(page).locator("[data-inverter-control] .row").nth(1).locator(".value");
        await expect(mode).toHaveText("Normal");
        await expect(content(page).locator("[data-estimate]")).toContainText("4 h");
        const change = (entity: string, state: string) => page.evaluate(({ entity, state }) => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = (window as any).__currentHass ?? window.__BatteryHass;
            (window as any).__currentHass = { ...hass, states: { ...hass.states, [entity]: { ...hass.states[entity], state } } };
            card.hass = (window as any).__currentHass;
        }, { entity, state });
        // A battery-only entity (time to empty) still refreshes what is shown.
        await change("sensor.helman_battery_time_to_empty", "60");
        await expect(content(page).locator("[data-estimate]")).toContainText("1 h");
        // The inverter's mode register re-reads the inverter overview.
        const inverterReads = () => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_detail" && r.node === "inverter" && !r.section).length);
        const before = await inverterReads();
        await change("select.helman_inverter_mode", "charge");
        await expect.poll(inverterReads).toBe(before + 1);
        await page.evaluate(() => (window as any).__releaseOverview("inverter"));
        await expect(mode).toContainText("Charg");
    });
}

test("a mode register that changes while the inverter read is in flight reads the inverter again", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
        const hass = window.__BatteryHass;
        const original = hass.callWS;
        const held: Array<() => void> = [];
        let hold = false;
        (window as any).__holdInverter = () => { hold = true; };
        (window as any).__releaseInverter = () => held.shift()?.();
        hass.callWS = async (request: any) => {
            if (request.type !== "helman/get_node_detail" || request.node !== "inverter" || request.section) return original(request);
            const answer = await original(request);
            if (hold) await new Promise<void>((resolve) => held.push(resolve));
            return { ...answer, mode: { entityId: "select.helman_inverter_mode", actionOptions: {} } };
        };
        hass.states["select.helman_inverter_mode"] = { entity_id: "select.helman_inverter_mode", state: "idle", attributes: {}, last_changed: "", last_updated: "", context: { id: "" } };
    });
    await openDetail(page);
    await expect(content(page).locator("[data-inverter-control]")).toHaveCount(1);
    const change = (state: string) => page.evaluate((state) => {
        const card = document.querySelector("helman-simple-card") as any;
        const hass = (window as any).__currentHass ?? window.__BatteryHass;
        (window as any).__currentHass = { ...hass, states: { ...hass.states, "select.helman_inverter_mode": { ...hass.states["select.helman_inverter_mode"], state } } };
        card.hass = (window as any).__currentHass;
    }, state);
    const inverterReads = () => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_detail" && r.node === "inverter" && !r.section).length);
    const before = await inverterReads();
    await page.evaluate(() => (window as any).__holdInverter());
    await change("charge");
    await expect.poll(inverterReads).toBe(before + 1);
    // The register is back where the last answer was read under, but the read in flight was sent under "charge".
    await change("idle");
    await page.evaluate(() => (window as any).__releaseInverter());
    await expect.poll(inverterReads).toBe(before + 2);
});

test("battery backs off retrying a failed inverter read and shows a dash", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
        const hass = window.__BatteryHass;
        const original = hass.callWS;
        hass.callWS = (request: any) => {
            if (request.type !== "helman/get_node_detail" || request.node !== "inverter" || request.section) return original(request);
            window.__NodeDetailRequests.push({ ...request });
            return Promise.reject(new Error("inverter down"));
        };
    });
    const calls = () => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/get_node_detail" && r.node === "inverter" && !r.section).length);
    const before = await calls();
    await openDetail(page);
    const mode = content(page).locator("[data-inverter-control] .row").nth(1).locator(".value");
    await expect(mode).toHaveText("—");
    for (let i = 0; i < 3; i += 1) {
        await page.evaluate((i) => {
            const card = document.querySelector("helman-simple-card") as any;
            card.hass = { ...window.__BatteryHass, states: { ...window.__BatteryHass.states, "sensor.tick": { state: String(i), attributes: {} } } };
        }, i);
        await page.waitForTimeout(100);
    }
    expect(await calls() - before).toBe(1);
    await expect(mode).toHaveText("—");
});

test("battery headline, gauge and power card agree where the grid meter disagrees with the balance", async ({ page }) => {
    // 2.1 kW discharging while solar covers the house: the balance exports it all; the grid meter reads 0.3 kW.
    await mount(page);
    await openDetail(page);
    const figures = await liveFigures(page, "node-detail-battery-content", "battery");
    expect(figures).toMatchObject({ card: -2100, gauge: 2100 });
    expect(figures.headline).toContain("discharging 2.1 kW");
});

test("battery shows a binding cap only while power reaches the lowest limit", async ({ page }) => {
    await mount(page, { power: "-10500", temperature: "8" });
    await openDetail(page);
    await expect(content(page).locator("[data-binding]")).toBeVisible();
});

test("battery compact icon marks the usable range and gauge segments open destination details", async ({ page }) => {
    await mount(page, { minSoc: "15", maxSoc: "90" });
    await openDetail(page);
    const icon = content(page).locator("simple-card-battery");
    await expect(icon.locator("svg line[stroke-dasharray]")).toHaveCount(2);
    await expect(icon).toContainText("15");
    await expect(icon).toContainText("90");
    await content(page).locator("helman-flow-gauge button").first().click();
    await expect(page.locator("node-detail-house-content")).toHaveCount(1);
});

test("battery gauge: an active segment opens its destination details", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    // The default mount discharges, so the solar pill is idle and only a destination pill is active.
    await content(page).locator("helman-flow-gauge button[data-active]").click();
    await expect(page.locator("node-detail-house-content, node-detail-grid-content")).toHaveCount(1);
});


test("battery caption colours the power in the discharge colour", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    const part = content(page).locator("helman-detail-headline [data-direction]");
    await expect(part).toContainText("discharging");
    await expect(part).toHaveCSS("color", "rgb(220, 38, 38)");
});

// Forecast -------------------------------------------------------------------

const forecastSection = (page: Page) => content(page).locator("helman-detail-section[data-forecast]");

async function openForecast(page: Page): Promise<void> {
    await forecastSection(page).locator("button").first().click();
    await expect(forecastSection(page).locator("[data-forecast-body]")).toBeVisible();
}

test("battery Forecast header names when it is full and how long it lasts, while closed", async ({ page }) => {
    await mount(page, { socPath: [{ soc: 80 }, { soc: 95 }, { soc: 100, max: true }, { soc: 70 }, { soc: 40 }, { soc: 15 }, { soc: 10, min: true }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Full ≈ 12:45 · lasts until 13:45");
    await expect(section.locator("[slot=summary] b")).toHaveText(["≈ 12:45", "13:45"]);
    await expect(section.locator("[data-forecast-body]")).toHaveCount(0);
    await openForecast(page);
    await expect(section.locator("[data-row=full] .value")).toHaveText("≈ 12:45");
    await expect(section.locator("[data-row=lowest] .value")).toHaveText("10 % at 13:45");
    await expect(section.locator("[data-row=floor]")).toContainText("Reaches the 10 % floor");
    await expect(section.locator("[data-row=floor] .value")).toHaveText("13:45");
    // Actual and planned SoC, the floor and the ceiling, a dot for full and one for the lowest.
    const chart = section.locator("helman-day-line-chart");
    await expect(chart.locator("path.line")).toHaveCount(2);
    await expect(chart.locator("path.line.dashed")).toHaveCount(1);
    await expect(chart.locator("line.reference")).toHaveCount(2);
    // The floor and the ceiling label the SoC axis; it has no ticks of its own.
    await expect(chart.locator(".reference-label")).toHaveText(["100 %", "10 %"]);
    await expect(chart.locator(".axis-label[text-anchor=end]")).toHaveCount(0);
    await expect(chart.locator("[data-marker]")).toHaveCount(2);
    await expect(chart.locator("[data-now]")).toHaveCount(1);
    await expect(section.locator("helman-help-tip")).toHaveCount(1);
});

test("battery Forecast header gives the lowest charge when the floor is never reached", async ({ page }) => {
    await mount(page, { socPath: [{ soc: 80 }, { soc: 95 }, { soc: 100, max: true }, { soc: 70 }, { soc: 40 }, { soc: 55 }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Full ≈ 12:45 · lowest 40 % at 13:15");
    await openForecast(page);
    await expect(section.locator("[data-row=lowest] .value")).toHaveText("40 % at 13:15");
    await expect(section.locator("[data-row=floor] .value")).toHaveText("Not within the forecast");
});

test("battery Forecast header leaves out full when the plan never fills it", async ({ page }) => {
    await mount(page, { socPath: [{ soc: 60 }, { soc: 50 }, { soc: 55 }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Lowest 50 % at 12:30");
    await openForecast(page);
    await expect(section.locator("[data-row=full] .value")).toHaveText("Not within the forecast");
});

test("battery Forecast header says full now when the battery is at its ceiling already", async ({ page }) => {
    await mount(page, { currentSoc: 100, soc: "100", socPath: [{ soc: 100, max: true }, { soc: 90 }, { soc: 50 }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Full now · lowest 50 % at 12:45");
    await openForecast(page);
    await expect(section.locator("[data-row=full] .value")).toHaveText("now");
});

test("battery Forecast lowest is the SoC now when the plan only charges", async ({ page }) => {
    await mount(page, { currentSoc: 20, soc: "20", socPath: [{ soc: 30 }, { soc: 40 }, { soc: 50 }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Lowest 20 % now");
    await openForecast(page);
    await expect(section.locator("[data-row=lowest] .value")).toHaveText("20 % now");
    await expect(section.locator("helman-day-line-chart [data-marker]")).toHaveCount(1);
});

test("battery Forecast uses the live SoC for now, not the snapshot's", async ({ page }) => {
    await mount(page, { currentSoc: 20, soc: "35", socPath: [{ soc: 30 }, { soc: 40 }, { soc: 50 }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).not.toContainText("20 %");
    await expect(section.locator("[slot=summary]")).toHaveText(/^Lowest 30 % at /);
    await openForecast(page);
    await expect(section.locator("[data-row=lowest] .value")).toHaveText(/^30 % at /);
    const actual = await section.locator("helman-day-line-chart").evaluate((chart: any) => chart.series.find((line: any) => line.key === "actual").points.at(-1).v);
    expect(actual).toBe(35);
});

test("battery Forecast header says at the floor now when the battery is at its floor already", async ({ page }) => {
    await mount(page, { currentSoc: 10, soc: "10", socPath: [{ soc: 10, min: true }, { soc: 30 }, { soc: 100, max: true }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Full ≈ 12:45 · at the floor now");
    await openForecast(page);
    await expect(section.locator("[data-row=floor] .value")).toHaveText("now");
});

test("battery Forecast offers a retry when the forecast fails", async ({ page }) => {
    await mount(page, { forecastFails: true });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("The forecast could not be loaded.");
    await openForecast(page);
    await expect(section.locator("[data-forecast-failed]")).toBeVisible();
});

test("battery Forecast chart opens HA's history of the SoC", async ({ page }) => {
    await onDashboard(page);
    await mount(page);
    await openDetail(page);
    await openForecast(page);
    await expectShowMore(page, forecastSection(page).locator("[data-show-more]"), ["sensor.soc"]);
});

// History & statistics, Technical details -------------------------------------

test("battery History starts with a pointer that opens the Forecast chart", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    const history = content(page).locator("helman-detail-section[data-history]");
    await history.locator("button").first().click();
    const pointer = history.locator("[data-history-body] > :first-child");
    await expect(pointer).toHaveAttribute("data-forecast-pointer", "");
    await expect(forecastSection(page).locator("[data-forecast-body]")).toHaveCount(0);
    await pointer.click();
    await expect(forecastSection(page).locator("helman-day-line-chart[data-forecast-chart]")).toBeInViewport();
});

test("battery History has no Forecast pointer while the forecast cannot be loaded", async ({ page }) => {
    await mount(page, { forecastFails: true });
    await openDetail(page);
    const history = content(page).locator("helman-detail-section[data-history]");
    await history.locator("button").first().click();
    await expect(history.locator("[data-row=charged]")).toHaveCount(1);
    await expect(history.locator("[data-forecast-pointer]")).toHaveCount(0);
});

test("battery History header gives today's charge and discharge, collapsed; the body splits the charge and shows health", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    const section = content(page).locator("helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("Today +6.2 / −4.1 kWh");
    await expect(section.locator("[slot=summary] b")).toHaveText(["+6.2", "−4.1 kWh"]);
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    expect(await page.evaluate(() => window.__NodeDetailRequests.some((r) => r.type === "helman/get_node_detail" && r.section === "charge"))).toBe(false);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=charged] .value")).toHaveText("6.2 kWh");
    await expect(section.locator("[data-row=from-solar]")).toHaveClass(/indent/);
    await expect(section.locator("[data-row=from-solar] .value")).toHaveText("4.2 kWh");
    await expect(section.locator("[data-row=from-grid] .value")).toContainText("1.5 kWh · paid ≈");
    await expect(section.locator("[data-row=from-unknown]")).toHaveClass(/indent/);
    await expect(section.locator("[data-row=from-unknown] .label")).toHaveText("source not known");
    await expect(section.locator("[data-row=from-unknown] .value")).toHaveText("0.50 kWh");
    // Where the charge came from adds up to the charge the header gives.
    const parts = await section.locator("[data-row^=from-] .value").allTextContents();
    expect(parts.reduce((sum, text) => sum + parseFloat(text), 0)).toBeCloseTo(6.2, 5);
    await expect(section.locator("[data-row=discharged] .value")).toHaveText("4.1 kWh");
    const tiles = section.locator("[data-stat]");
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(0)).toContainText("170");
    await expect(tiles.nth(0)).toContainText("full cycles so far");
    await expect(tiles.nth(1)).toContainText("24 °C");
    await expect(tiles.nth(1)).toContainText("cells now; 6–14 today");
    await expect(tiles.nth(2)).toContainText("12 mV");
    await expect(tiles.nth(2)).toContainText("cell gap; fine below 50");
});

test("battery Technical details shows the slot, the executor and the entities list to an admin", async ({ page }) => {
    await mount(page, { admin: true });
    await openDetail(page);
    const section = content(page).locator("helman-detail-section[data-technical]");
    await expect(section.locator("[slot=summary]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=executor] .value")).toContainText("Applied");
    for (const id of [
        "sensor.solax_battery_voltage_charge",
        "sensor.solax_battery_current_charge",
        "sensor.solax_bms_charge_max_current",
        "sensor.solax_bms_discharge_max_current",
        "sensor.solax_bms_connect_state",
        "sensor.solax_cell_voltage_high",
        "sensor.solax_cell_voltage_low",
    ]) {
        await expect(section.locator(`[data-entities] [data-entity="${id}"]`)).toHaveCount(1);
    }
    await expect(section.locator("[data-row=bms_charge_max_current], [data-row=battery_voltage]")).toHaveCount(0);
});

test("battery Technical details is not rendered for a non-admin", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    await expect(content(page).locator("helman-detail-section[data-history]")).toHaveCount(1);
    await expect(content(page).locator("helman-detail-section[data-technical]")).toHaveCount(0);
});


test("battery retains elapsed predictions and its live anchor without historical extrema changing summaries", async ({ page }) => {
    await mount(page, { recordedForecast: true, socPath: [{ soc: 60 }, { soc: 50 }, { soc: 55 }] });
    await openDetail(page);
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Lowest 50 % at 12:30");
    await openForecast(page);
    const lines = await section.locator("helman-day-line-chart").evaluate((chart: any) => chart.series);
    const history = lines.find((line: any) => line.key === "forecast-history").points;
    const planned = lines.find((line: any) => line.key === "planned").points;
    expect(history).toEqual([
        { t: Date.parse("2026-10-21T10:15:00Z"), v: 100 },
        { t: Date.parse("2026-10-21T11:45:00Z"), v: 2 },
        { t: Date.parse("2026-10-21T12:00:00Z"), v: 30 },
    ]);
    expect(planned[0]).toEqual({ t: Date.parse("2026-10-21T12:00:00Z"), v: 67 });
    expect(planned.filter((point: any) => point.t === Date.parse("2026-10-21T12:15:00Z"))).toEqual([{ t: Date.parse("2026-10-21T12:15:00Z"), v: 60 }]);
    await expect(section.locator("[data-row=full] .value")).toHaveText("Not within the forecast");
    await expect(section.locator("[data-row=floor] .value")).toHaveText("Not within the forecast");
});


test("battery keeps a missing completed prediction separate from the live projection", async ({ page }) => {
    await mount(page, { recordedForecast: true, missingLastForecast: true });
    await page.clock.setFixedTime(new Date("2026-10-21T12:05:00Z"));
    await openDetail(page);
    await openForecast(page);
    const chart = forecastSection(page).locator("helman-day-line-chart");
    const lines = await chart.evaluate((chart: any) => chart.series);
    const history = lines.find((line: any) => line.key === "forecast-history");
    const planned = lines.find((line: any) => line.key === "planned");
    expect(history.points.at(-1)).toEqual({ t: Date.parse("2026-10-21T11:45:00Z"), v: 2 });
    expect(planned.points[0]).toEqual({ t: Date.parse("2026-10-21T12:05:00Z"), v: 67 });
    expect(planned.points.every((point: any) => point.t >= Date.parse("2026-10-21T12:05:00Z"))).toBe(true);
    await expect(chart.locator("path[data-series=forecast-history]")).toHaveCount(1);
    await expect(chart.locator("path[data-series=planned]")).toHaveCount(1);
});
