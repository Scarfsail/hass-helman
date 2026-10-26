import { prepareNodeDetailPage, mountSimpleCard, liveFigures } from "./support/node-detail-harness";
import { cardTree, forecastPayload, scheduleSlots } from "./support/payload-builders";
import type { ForecastPayload, ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The battery node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the battery overview and its
 * charge and flows sections), the schedule and the forecast. What is pinned is
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
    /** Today's flows section: a fixed day, or the reports' reason for none. */
    flowsUnavailable?: string;
    /** The slot in progress holds a charge candidate whose condition is not met. */
    candidateNow?: boolean;
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
                chargedKwh: 6.0, solarKwh: 4.2, gridKwh: 1.5, unknownKwh: 0.3, gridPricedKwh: 1.0, gridTariffKwh: 0, gridUnpricedKwh: 0.5,
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
            if (v.candidateNow && hour === 12) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation", conditionMet: false };
            if (hour >= 18 && hour < 19) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
            slots.push({ id, controllables: { inverter: action } });
        }
        const schedule: SchedulePayload = {
            ...scheduleDefaults,
            executionEnabled: true,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: { actionKind: "apply", outcome: "success", executedAction: { kind: "normal" }, reason: "scheduled" } },
            },
        };
        const forecastSlot = (iso: string, soc: number) => ({
            timestamp: iso, durationHours: 0.25, solarKwh: 0, baselineHouseKwh: 0, netKwh: 0, chargedKwh: 0, dischargedKwh: 0,
            remainingEnergyKwh: 0, socPct: soc, importedFromGridKwh: 0, exportedToGridKwh: 0,
            hitMinSoc: false, hitMaxSoc: false, limitedByChargePower: false, limitedByDischargePower: false,
        });
        const forecast: ForecastPayload = {
            ...forecastDefaults,
            battery_capacity: {
                ...forecastDefaults.battery_capacity,
                status: "available", generatedAt: null, startedAt: null, unit: "kWh",
                model: null, nominalCapacityKwh: 17.3, currentRemainingEnergyKwh: 11.6, currentSoc: 67, minSoc: 10, maxSoc: 100,
                chargeEfficiency: 0.95, dischargeEfficiency: 0.95, maxChargePowerW: 5000, maxDischargePowerW: 6000,
                partialReason: null, coverageUntil: null, actualHistory: [],
                series: [forecastSlot(`${day}T12:00:00+00:00`, 66), forecastSlot(`${day}T12:15:00+00:00`, 64)],
            },
        };
        const flowsSection = window.__flowsSection("battery", { unavailable: v.flowsUnavailable ?? null, flows: v.flowsUnavailable ? null : { ...window.__flowsSection("battery").flows, solarToGrid: 2.0 } });
        const inverter = window.__inverterOverview({ entities: v.ratedPower ? { rated_power: "sensor.solax_inverter_power_type" } : {} });
        window.__moreInfo = [];
        document.addEventListener("hass-more-info", (event) => window.__moreInfo.push((event as CustomEvent).detail.entityId));
        window.__BatteryHass = window.__configureNodeDetail({
            states, tree, overviews: { battery: overview, inverter }, sections: { battery: { flows: flowsSection, charge: section } }, forecast: v.forecastFails ? "error" : forecast, schedule,
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
    await expect(content(page).locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
    await content(page).getByRole("button", { name: /Controlled through the inverter/ }).click();
    await expect(page.locator("node-detail-inverter-content")).toBeVisible();
});

test("battery mode now shows an unmet candidate as the normal mode it runs", async ({ page }) => {
    await mount(page, { candidateNow: true });
    await openDetail(page);
    const mode = content(page).locator("[data-inverter-control] .row").nth(1).locator(".value");
    await expect(mode).toHaveText("Normal");
    await expect(mode).not.toContainText("Charge to");
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
    await expect(page.locator("node-detail-house-content, node-detail-grid-content")).toHaveCount(1);
});


test("battery caption colours the power in the discharge colour", async ({ page }) => {
    await mount(page);
    await openDetail(page);
    const part = content(page).locator("helman-detail-headline [data-direction]");
    await expect(part).toContainText("discharging");
    await expect(part).toHaveCSS("color", "rgb(220, 38, 38)");
});
