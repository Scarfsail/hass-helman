import { test, expect, type Page } from "@playwright/test";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";
import { CARD_BUNDLE } from "./support/card-page";

/**
 * The battery node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the battery overview and its
 * charge section), the schedule and the forecast. What is pinned is the shared
 * disclosure contract (compact overview, one open question, answer then
 * evidence, nothing heavy mounted or requested while closed) and the battery's
 * truthfulness: a BMS ceiling is not proof of a binding cap, a cold reading is
 * not a cause, today's charge is not the stored energy, the daily ratio is not
 * an efficiency and throughput cycles are not health.
 */

const SCREENS = process.env.SCREENS;

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
    remaining?: string;
};

declare global {
    interface Window {
        __hass: any;
        __requests: Array<{ type: string; node?: string; section?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((v) => {
        const profile = v.profile !== false;
        const node = (id: string, sensor: string, sourceType: string | null) => ({
            id, displayName: id, powerSensorId: sensor, ratioSensorId: null, switchEntityId: null,
            valueType: "default", sourceConfig: null, sourceType, isSource: sourceType !== null,
            isUnmeasured: false, groups: {}, groupBadgeTexts: [], icon: null, compact: false,
            showAdditionalInfo: false, childrenFullWidth: false, hideChildren: false,
            hideChildrenIndicator: false, sortChildrenByPower: false, deferrable: false,
            controllableIds: [], children: [],
        });
        const tree = {
            sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid", "grid"), node("battery", "sensor.battery", "battery")],
            consumers: [node("house", "sensor.house", null)],
            consumptionTotalSensorId: null,
            productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
        };
        const s = (state: string, unit?: string, attributes: Record<string, unknown> = {}) => ({
            state, attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...attributes },
        });
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
            "sensor.solar": s("4200", "W"), "sensor.grid": s("-300", "W"), "sensor.battery": s(v.power ?? "-2100", "W"),
            "sensor.house": s("1200", "W"),
            "sensor.soc": s("67", "%"), "sensor.remaining": s(v.remaining ?? "11577", v.remainingUnit ?? "Wh"),
            "number.min_soc": s(v.minSoc ?? "10", "%"), "number.max_soc": s("100", "%"),
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
            currency: "CZK/kWh", complete: false, unavailable: null, charge,
        };
        // 15-minute slots from 11:45 today for a day and a half.
        const slots = [];
        const start = Date.parse(`${day}T11:45:00Z`);
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = at.getUTCHours() + (at.getUTCDate() - 21) * 24;
            let action: Record<string, unknown> = { kind: "normal", setBy: "automation" };
            if (hour >= 14 && hour < 16) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (hour >= 18 && hour < 19) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
            slots.push({ id, controllables: { inverter: action } });
        }
        const schedule = {
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
        const forecast = {
            battery_capacity: {
                status: "available", generatedAt: null, startedAt: null, unit: "kWh", resolution: "quarter_hour", horizonHours: 48,
                model: null, nominalCapacityKwh: 17.3, currentRemainingEnergyKwh: 11.6, currentSoc: 67, minSoc: 10, maxSoc: 100,
                chargeEfficiency: 0.95, dischargeEfficiency: 0.95, maxChargePowerW: 5000, maxDischargePowerW: 6000,
                partialReason: null, coverageUntil: null, actualHistory: [],
                series: [forecastSlot(`${day}T12:00:00+00:00`, 66), forecastSlot(`${day}T12:15:00+00:00`, 64)],
            },
        };
        const inverter = {
            node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: false, profile: null, mode: null,
            entities: {}, maxAllowedExportPower: 9900,
            agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, registers: [] },
            condition: null, sections: [],
        };
        window.__requests = [];
        window.__hass = {
            language: "en",
            // A 24-hour English locale, so times read as the assertions write them.
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) => {
                    window.__requests.push({ type: msg.type });
                    if (msg.type === "helman/get_forecast" && v.forecastFails) throw new Error("forecast down");
                    return msg.type === "helman/get_forecast" ? forecast : {};
                },
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return schedule;
                if (msg.type === "helman/get_node_detail") {
                    if (msg.node === "inverter") return inverter;
                    return msg.section ? section : overview;
                }
                return {};
            },
        };
    }, variant);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(async () => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = window.__hass;
        document.body.appendChild(card);
    });
}

const batteryCell = (page: Page) => page.locator(".node-cell:has(simple-card-battery)");
const content = (page: Page) => page.locator("node-detail-battery-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const sectionRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.node === "battery" && r.section).length);

async function openDetail(page: Page): Promise<void> {
    await batteryCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test.describe("the battery overview", () => {
    test("opens compact: a status sentence, SoC and usable reserve, the next change and five closed questions", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Discharging at 2.1 kW.");
        await expect(overview.locator(".figure")).toHaveCount(2);
        await expect(overview.locator("[data-figure='soc']")).toContainText("67 %");
        // 11 577 Wh at 67 %: a 17.3 kWh battery holds 9.8 kWh above its 10 % floor.
        await expect(overview.locator("[data-figure='usable']")).toContainText("Usable above 10 %");
        await expect(overview.locator("[data-figure='usable']")).toContainText("9.8 kWh");
        await expect(overview.locator("[data-next]")).toHaveText("Next: Charge to 80 % from 14:00");

        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["reserve", "next", "limits", "charge", "diagnostics"]);
        for (const id of ids) {
            await expect(header(page, id!)).toHaveAttribute("aria-expanded", "false");
        }
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        // The producer and consumer tree rows are gone.
        await expect(content(page).locator("helman-tree-item")).toHaveCount(0);
    });

    test("answer previews say the answer", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(question(page, "reserve").locator(".preview")).toHaveText("9.8 kWh usable above 10 % · 5.7 kWh room below 100 %");
        await expect(question(page, "next").locator(".preview")).toHaveText("Next: Charge to 80 % from 14:00");
        await expect(question(page, "limits").locator(".preview")).toHaveText("charge ≤ 5.0 kW · discharge ≤ 6.0 kW");
        await expect(question(page, "charge").locator(".preview")).toHaveText("6.2 kWh charged today");
        await expect(question(page, "diagnostics").locator(".preview")).toHaveText("≈ 170 full cycles · 24 °C · cell gap 0.012 V");
    });

    test("an unreadable battery sensor is no reading, never idle at 0 W", async ({ page }) => {
        await mount(page, { power: "unavailable" });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("No battery power reading right now.");
    });

    test("a BMS the hardware reports disconnected is the one exception, linked to the diagnostics", async ({ page }) => {
        await mount(page, { bmsDisconnected: true });
        await openDetail(page);
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("battery management system as disconnected (Disconnected)");
        await exception.locator("button").click();
        await expect(header(page, "diagnostics")).toHaveAttribute("aria-expanded", "true");
    });
});

test.describe("reserve", () => {
    test("usable energy, room and the time estimate, with the capacity assumption as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "reserve").click();
        const reserve = question(page, "reserve");
        await expect(reserve.locator("[data-row='usable']")).toContainText("9.8 kWh");
        await expect(reserve.locator("[data-row='room']")).toContainText("5.7 kWh");
        await expect(reserve.locator("[data-row='soc-range']")).toContainText("10 % – 100 %");
        await expect(reserve.locator("[data-row='time']")).toContainText("≈ 4 h 40 min to 10 %, around 16:40");

        await evidence(page, "reserve").click();
        await expect(reserve.locator("[data-row='capacity']")).toContainText("≈ 17 kWh (12 kWh ÷ 67 %)");
        // The inverter's chargeable register is shown, but not as the room.
        await expect(reserve.locator("[data-row='chargeable_energy']")).toContainText("5702 Wh");
        await expect(reserve).toContainText("not the room below the configured ceiling");
        await expect(reserve).toContainText("average non-idle battery power over the last 3 min");
    });

    test("idle has no finish time", async ({ page }) => {
        await mount(page, { power: "20" });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("Idle (20 W).");
        await header(page, "reserve").click();
        await expect(question(page, "reserve").locator("[data-row='time']")).toContainText("idle: no finish time");
    });
});

test.describe("limits", () => {
    test("directional ceilings side by side, and power below them does not name a cause", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "limits").click();
        const limits = question(page, "limits");
        await expect(limits.locator("[data-row='bms-charge']")).toContainText("BMS charge ceiling");
        await expect(limits.locator("[data-row='bms-charge']")).toContainText("≈ 8.9 kW (25.0 A × 355.6 V)");
        await expect(limits.locator("[data-row='bms-discharge']")).toContainText("≈ 10.7 kW (30.0 A × 355.6 V)");
        await expect(limits.locator("[data-row='inverter-discharge']")).toContainText("30.0 A (≈ 10.7 kW)");
        await expect(limits.locator("[data-row='planning-discharge']")).toContainText("6.0 kW");
        await expect(limits.locator("[data-row='binding']")).toContainText("discharging at 2.1 kW, below every known ceiling: the actual limiting cause is not known");
        await expect(limits.locator("[data-cold]")).toHaveCount(0);

        await evidence(page, "limits").click();
        await expect(limits.locator("[data-row='battery_voltage']")).toContainText("355.6 V");
        await expect(limits.locator("[data-row='max_charge_rate']")).toContainText("10668 W");
        await expect(limits).toContainText("so it is not by itself a BMS limit");
    });

    test("power at the lowest ceiling is consistent with it, never proof", async ({ page }) => {
        await mount(page, { power: "-5900" });
        await openDetail(page);
        await header(page, "limits").click();
        await expect(question(page, "limits").locator("[data-row='binding']"))
            .toContainText("at the lowest known ceiling (planning limit, 6.0 kW): consistent with it limiting, not proof that it does");
    });

    test("a disabled BMS current is not reported, not a zero ceiling", async ({ page }) => {
        await mount(page, { noBmsCurrents: true });
        await openDetail(page);
        await header(page, "limits").click();
        await expect(question(page, "limits").locator("[data-row='bms-charge']")).toContainText("not reported");
    });

    test("a cold reading is an observation without an invented cause", async ({ page }) => {
        await mount(page, { temperature: "6" });
        await openDetail(page);
        await header(page, "limits").click();
        const cold = question(page, "limits").locator("[data-cold]");
        await expect(cold).toContainText("The battery reads 6 °C.");
        await expect(cold).toContainText("this reading alone does not show that is happening");
        await expect(question(page, "limits")).not.toContainText(/derat|because of the cold|due to/i);
    });
});

test("a remaining energy in an unsupported unit gives no reserve, never a guess", async ({ page }) => {
    await mount(page, { remainingUnit: "MJ" });
    await openDetail(page);
    await header(page, "reserve").click();
    await expect(question(page, "reserve").locator("[data-row='usable']")).toHaveCount(0);
});

test("today's meter in an unsupported unit gives no charge preview, never a guess", async ({ page }) => {
    await mount(page, { todayUnit: "MJ" });
    await openDetail(page);
    await expect(question(page, "charge")).not.toContainText("charged today");
});

test("an out-of-range SoC floor is no floor, never a usable figure above it", async ({ page }) => {
    await mount(page, { minSoc: "120" });
    await openDetail(page);
    await header(page, "reserve").click();
    const reserve = question(page, "reserve");
    await expect(reserve).not.toContainText("120 %");
    await expect(reserve.locator("[data-row='room']")).toContainText("5.7 kWh");
});

test("a zero remaining energy at a positive SoC is no reserve, never 0 kWh of room", async ({ page }) => {
    await mount(page, { remaining: "0" });
    await openDetail(page);
    await header(page, "reserve").click();
    await expect(question(page, "reserve").locator("[data-row='usable'], [data-row='room']")).toHaveCount(0);
});

test("a cold reading in °F is compared in °C", async ({ page }) => {
    await mount(page, { temperature: "41", temperatureUnit: "°F" });
    await openDetail(page);
    await header(page, "limits").click();
    await expect(question(page, "limits").locator("[data-cold]")).toContainText("41 °F");
});

test("a duration just short of two hours reads 2 h 0 min, never 1 h 60 min", async ({ page }) => {
    await mount(page, { power: "-1500", timeToEmpty: "119.7" });
    await openDetail(page);
    await header(page, "reserve").click();
    await expect(question(page, "reserve").locator("[data-row='time']")).toContainText("≈ 2 h 0 min");
});

test("a plan that cannot be loaded says so and offers a retry", async ({ page }) => {
    await mount(page, { forecastFails: true });
    await openDetail(page);
    await header(page, "next").click();
    const next = question(page, "next");
    await expect(next.locator("[data-row='planned-soc']")).toContainText("the plan could not be loaded");
    await expect(next.getByRole("button", { name: "Try again" })).toBeVisible();
});

test.describe("today's charge", () => {
    test("requested only when opened; kWh by source, the paid share and its partial pricing, never the stored inventory", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page)).toBe(0);
        await header(page, "charge").click();
        const charge = question(page, "charge");
        await expect(charge.locator("[data-row='charged']")).toContainText("6.0 kWh");
        expect(await sectionRequests(page)).toBe(1);
        await expect(charge.locator("[data-row='period']")).toContainText("Today 00:00–12:00");
        await expect(charge.locator("[data-row='solar']")).toContainText("4.2 kWh (70 %)");
        await expect(charge.locator("[data-row='grid']")).toContainText("1.5 kWh (25 %)");
        await expect(charge.locator("[data-row='unknown']")).toContainText("0.30 kWh (5 %)");
        await expect(charge.locator("[data-row='paid']")).toContainText("4.00 CZK");
        await expect(charge.locator("[data-row='paid']")).toContainText("estimate");
        // Only two thirds of the grid charge had a rate.
        await expect(charge.locator("[data-row='coverage']")).toContainText("grid charge 67 % of 1.5 kWh");
        await expect(charge).toContainText("not what is stored in the battery now");
        await expect(charge).not.toContainText(/inventory|currently stored/i);
        await expect(charge.locator(".preview")).toHaveText("6.0 kWh charged today · paid 4.00 CZK");

        await evidence(page, "charge").click();
        await expect(charge.locator("[data-row='paid-rate']")).toContainText("4.0 CZK/kWh");
        await expect(charge.locator("[data-row='forgone']")).toContainText("5.04 CZK");
        await expect(charge.locator("[data-row='forgone']")).toContainText("opportunity value, not a payment");
        await expect(charge.locator("[data-row='grid-unpriced']")).toContainText("0.50 kWh");
        // Today's meters and their ratio, which is a flow ratio and nothing more.
        await expect(charge.locator("[data-row='input-today']")).toContainText("6.2 kWh");
        await expect(charge.locator("[data-row='flow-ratio']")).toContainText("0.66");
        await expect(charge.locator("[data-row='flow-ratio']")).not.toContainText(/efficiency/i);
        await expect(charge.locator("[data-flow-ratio-note]")).toContainText("A flow ratio over today, not round-trip efficiency");
    });

    test("no charge today is said so, not an unknown or a zero-cost store", async ({ page }) => {
        await mount(page, { noCharge: true });
        await openDetail(page);
        await header(page, "charge").click();
        const charge = question(page, "charge");
        await expect(charge.locator("[data-no-charge]")).toContainText("has not charged today");
        await expect(charge.locator(".preview")).toHaveText("No charge today");
        await expect(charge.locator("[data-row='paid']")).toHaveCount(0);
    });
});

test.describe("next and the plan", () => {
    test("actual and planned SoC, the next effective action, and the plan chart mounted only when open", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
        await header(page, "next").click();
        const next = question(page, "next");
        await expect(next.locator("[data-row='soc-now']")).toContainText("67 %");
        await expect(next.locator("[data-row='planned-soc']")).toContainText("66 % at 12:15");
        await expect(next.locator("[data-row='scheduled']")).toContainText("Normal");
        await expect(next.locator("[data-row='change']")).toContainText("Charge to 80 % from 14:00");
        await expect(next.locator("helman-solar-inspector-card")).toHaveCount(1);

        await evidence(page, "next").click();
        await expect(next.locator("[data-row='executor']")).toBeVisible();
        await expect(next).toContainText("does not record why an optimizer chose");

        // Another question unmounts the plan.
        await header(page, "reserve").click();
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
    });
});

test.describe("diagnostics", () => {
    test("throughput cycles with their denominator, never health; cells and heating as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "diagnostics").click();
        const diagnostics = question(page, "diagnostics");
        await expect(diagnostics.locator("[data-row='cycles']")).toContainText("≈ 170.3 (throughput)");
        await expect(diagnostics.locator("[data-row='temperature-range']")).toContainText("23.0 °C – 25.0 °C");
        await expect(diagnostics).toContainText("÷ (2 × 17 kWh, today's nominal capacity)");
        await expect(diagnostics).toContainText("not state of health or remaining life");
        await expect(diagnostics).not.toContainText(/0 % health|SoH/i);

        await evidence(page, "diagnostics").click();
        await expect(diagnostics.locator("[data-row='lifetime-in']")).toContainText("3100 kWh");
        await expect(diagnostics.locator("[data-row='cell_voltage_high']")).toContainText("3.342 V");
        await expect(diagnostics.locator("[data-row='battery_heating']")).toContainText("off");
        await expect(diagnostics.locator("[data-row='heating-1']")).toContainText("00:00:00 – 00:00:00");
    });
});

test.describe("disclosure and live data", () => {
    test("one open question at a time, evidence by keyboard, and a reopened dialog starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "reserve").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "reserve")).toHaveAttribute("aria-expanded", "true");
        await expect(header(page, "reserve")).toBeFocused();
        await evidence(page, "reserve").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "reserve").locator("[data-row='capacity']")).toBeVisible();

        await header(page, "limits").click();
        await expect(header(page, "reserve")).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "reserve").locator("[data-row='usable']")).toHaveCount(0);

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "false");
    });

    test("live readings reach the open detail", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__hass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.soc": { state: "70", attributes: { unit_of_measurement: "%" } } } };
        });
        await expect(content(page).locator("[data-figure='soc']")).toContainText("70 %");
    });
});

test.describe("a Custom inverter", () => {
    test("keeps every question with what its config can answer", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(content(page).locator("helman-node-question")).toHaveCount(5);
        await expect(question(page, "diagnostics").locator(".preview")).toHaveText("No battery diagnostics are available.");
        await header(page, "limits").click();
        await expect(question(page, "limits").locator("[data-row='bms-charge']")).toContainText("needs a hardware profile");
        await expect(question(page, "limits").locator("[data-row='planning-charge']")).toContainText("5.0 kW");
        await header(page, "diagnostics").click();
        await expect(question(page, "diagnostics").locator("[data-row='cycles']")).toContainText("needs the lifetime energy counters");
    });
});

test.describe("screenshots", { tag: "@screens" }, () => {
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        test(`overview and an expanded answer at ${name}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mount(page);
            await openDetail(page);
            await page.screenshot({ path: `${SCREENS}/battery-${name}-overview.png`, fullPage: true });
            await header(page, "limits").click();
            await page.screenshot({ path: `${SCREENS}/battery-${name}-limits.png`, fullPage: true });
            await evidence(page, "limits").click();
            await page.screenshot({ path: `${SCREENS}/battery-${name}-limits-evidence.png`, fullPage: true });
            await header(page, "charge").click();
            await expect(question(page, "charge").locator("[data-row='charged']")).toBeVisible();
            await evidence(page, "charge").click();
            await page.screenshot({ path: `${SCREENS}/battery-${name}-charge.png`, fullPage: true });
            await header(page, "reserve").click();
            await evidence(page, "reserve").click();
            await page.screenshot({ path: `${SCREENS}/battery-${name}-reserve.png`, fullPage: true });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});
