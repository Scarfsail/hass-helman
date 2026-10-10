import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";

/**
 * The inverter: the simple card's centre cell and its node detail.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, the schedule and `helman/get_node_detail`. What is pinned is
 * the shared disclosure contract (compact overview, one open question, answer
 * then evidence, keyboard, nothing heavy mounted or requested while closed)
 * and the inverter's truthfulness: the last command, the observed registers,
 * the plan and the executor are four facts and are never shown as each other.
 */

const BUNDLE = resolve(__dirname, "../../custom_components/helman/frontend_compiled/helman-card.js");
const SCREENS = process.env.P1_SCREENS;

type Variant = {
    agreement?: "match" | "mismatch" | "unknown";
    profile?: boolean;
    executionEnabled?: boolean;
    linkUnavailable?: boolean;
    linkRate?: string;
    sectionFails?: boolean;
    overviewFails?: boolean;
    condition?: "off_grid" | null;
    /** Stop export until 13:00, then nothing scheduled until 14:00. */
    stopExportThenEmpty?: boolean;
    /** Leave out the 14:00 charge, so the 18:00 candidate is the only action left. */
    noCharge?: boolean;
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
        const s = (state: string, unit?: string, friendly?: string) => ({
            state, attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...(friendly ? { friendly_name: friendly } : {}) },
        });
        const telemetry: Record<string, [string, string, string?]> = {
            use_mode: ["select.solax_charger_use_mode", v.agreement === "mismatch" ? "Back Up Mode" : "Self Use Mode"],
            manual_mode: ["select.solax_manual_mode_select", "Force Discharge"],
            run_mode: ["sensor.solax_run_mode", v.condition === "off_grid" ? "Off-Grid" : "Normal Mode"],
            export_limit: ["number.solax_export_control_user_limit", "9900", "W"],
            pv_power_limit: ["number.solax_remotecontrol_pv_power_limit", "30000", "W"],
            main_breaker_limit: ["number.solax_main_breaker_current_limit", "25", "A"],
            battery_charge_max_current: ["number.solax_battery_charge_max_current", "30.0", "A"],
            battery_discharge_max_current: ["number.solax_battery_discharge_max_current", "30.0", "A"],
            eps_min_soc: ["number.solax_inverter_eps_min_soc", "10", "%"],
            eps_restart_soc: ["number.solax_inverter_eps_restart_soc", "30", "%"],
            remote_control: ["select.solax_remotecontrol_power_control", "Disabled"],
            remote_control_mode: ["select.solax_remotecontrol_power_control_mode", "Disabled"],
            active_power_target: ["sensor.solax_active_power_target", "0", "W"],
            active_power_real: ["sensor.solax_active_power_real", "0", "W"],
            ac_power_l1: ["sensor.solax_inverter_power_l1", "1170", "W"],
            ac_power_l2: ["sensor.solax_inverter_power_l2", "1180", "W"],
            ac_power_l3: ["sensor.solax_inverter_power_l3", "1150", "W"],
            ac_voltage_l1: ["sensor.solax_inverter_voltage_l1", "235.3", "V"],
            ac_voltage_l2: ["sensor.solax_inverter_voltage_l2", "236.1", "V"],
            ac_voltage_l3: ["sensor.solax_inverter_voltage_l3", "234.8", "V"],
            ac_current_l1: ["sensor.solax_inverter_current_l1", "5.0", "A"],
            ac_current_l2: ["sensor.solax_inverter_current_l2", "5.0", "A"],
            ac_current_l3: ["sensor.solax_inverter_current_l3", "4.9", "A"],
            ac_frequency_l1: ["sensor.solax_inverter_frequency_l1", "50.0", "Hz"],
            ac_frequency_l2: ["sensor.solax_inverter_frequency_l2", "50.0", "Hz"],
            ac_frequency_l3: ["sensor.solax_inverter_frequency_l3", "50.0", "Hz"],
            phase_balance: ["switch.solax_inverter_phase_power_balance_x3", "on"],
            inverter_temperature: ["sensor.solax_inverter_temperature", "48", "°C"],
            link_success_rate: ["sensor.solax_inverter_communication_success_rate", v.linkUnavailable ? "unavailable" : (v.linkRate ?? "100.0"), "%"],
            link_quarantined_registers: ["sensor.solax_inverter_communication_quarantined_registers", v.linkUnavailable ? "unavailable" : "0"],
            firmware: ["sensor.solax_inverter_solax_software_version", "DSP 1.46 ARM 1.44-1.08"],
            hardware_version: ["sensor.solax_inverter_solax_hardware_version", "Gen4"],
            rated_power: ["sensor.solax_inverter_power_type", "10000", "W"],
            mppt_count: ["sensor.solax_inverter_mppt_count", "2"],
            lock_state: ["select.solax_lock_state", "Unlocked"],
            grid_mode_runtime: ["sensor.solax_grid_mode_runtime", "32820.0", "h"],
            eps_mode_runtime: ["sensor.solax_eps_mode_runtime", "163.9", "h"],
        };
        const states: Record<string, unknown> = {
            "sensor.solar": s("4200", "W"), "sensor.grid": s("-300", "W"), "sensor.battery": s("-500", "W"),
            "sensor.house": s("1200", "W"), "number.min_soc": s("10", "%"), "number.max_soc": s("100", "%"),
            "select.helman_inverter_mode": s("normal", undefined, "Helman inverter mode"),
        };
        const entities: Record<string, string | null> = { battery_min_soc: "number.min_soc", battery_max_soc: "number.max_soc" };
        if (profile) {
            for (const [key, [entityId, state, unit]] of Object.entries(telemetry)) {
                entities[key] = entityId;
                states[entityId] = s(state, unit, key.replace(/_/g, " "));
            }
        }
        const kinds = ["normal", "stop_charging", "stop_discharging", "charge_to_target_soc", "discharge_to_target_soc", "stop_export"];
        const registers = [
            { entityId: "select.solax_charger_use_mode", expected: "Self Use Mode", actual: v.agreement === "mismatch" ? "Back Up Mode" : "Self Use Mode", matches: v.agreement === "mismatch" ? false : v.agreement === "unknown" ? null : true },
            { entityId: "number.solax_export_control_user_limit", expected: 9900, actual: "9900", matches: true },
        ];
        const overview = {
            node: "inverter",
            asOf: "2026-10-21T12:00:00+00:00",
            configured: true,
            profile: profile ? { id: "solax_inverter", label: "SolaX inverter" } : null,
            mode: { entityId: "select.helman_inverter_mode", actionOptions: Object.fromEntries(kinds.map((k) => [k, k])) },
            entities,
            maxAllowedExportPower: 9900,
            agreement: profile
                ? { status: v.agreement ?? "match", reason: v.agreement === "unknown" ? "unavailable" : null, commanded: "normal", observedOption: v.agreement === "mismatch" ? null : "normal", registers }
                : { status: "unknown", reason: "no_profile", commanded: "normal", observedOption: null, registers: [] },
            condition: v.condition === "off_grid" ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: profile ? ["temperature"] : [],
        };
        const day = "2026-10-21";
        const points = Array.from({ length: 144 }, (_, i) => {
            const minutes = i * 5;
            const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
            const mm = String(minutes % 60).padStart(2, "0");
            const mean = 38 + 10 * Math.sin((i / 144) * Math.PI);
            return { start: `${day}T${hh}:${mm}:00+00:00`, mean, min: mean - 0.5, max: mean + 0.5, coverage: 1 };
        }).filter((_, i) => i < 40 || i > 52); // a gap in the morning
        const section = {
            node: "inverter", section: "temperature", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            temperature: {
                entityId: "sensor.solax_inverter_temperature", unit: "°C", source: "statistics", extrema: "bucket_statistics",
                bucketMinutes: 5, points, mean: 43.2, min: 37.5, minAt: `${day}T00:00:00+00:00`, max: 48.5, maxAt: `${day}T11:55:00+00:00`, coverage: 0.89,
            },
        };
        // 15-minute slots from 11:45 today for a day and a half.
        const slots = [];
        const start = Date.parse(`${day}T11:45:00Z`);
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = at.getUTCHours() + (at.getUTCDate() - 21) * 24;
            let action: Record<string, unknown> | null = { kind: "normal", setBy: "automation" };
            if (v.stopExportThenEmpty && hour < 13) action = { kind: "stop_export", setBy: "automation" };
            if (v.stopExportThenEmpty && hour === 13) action = null;
            if (!v.noCharge && hour >= 14 && hour < 16) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (hour >= 18 && hour < 19) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
            slots.push({ id, controllables: action ? { inverter: action } : {} });
        }
        const schedule = {
            executionEnabled: v.executionEnabled !== false,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: { actionKind: "apply", outcome: "success", executedAction: { kind: "normal" }, reason: "scheduled" } },
            },
        };
        window.__requests = [];
        window.__hass = {
            language: "en",
            // A 24-hour English locale, so times read as the assertions write them.
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async () => ({}),
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return schedule;
                if (msg.type === "helman/get_node_detail") {
                    if (msg.section) {
                        if (v.sectionFails) throw new Error("recorder down");
                        return section;
                    }
                    if (v.overviewFails) throw new Error("backend down");
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

const cell = (page: Page) => page.locator(".inverter-cell");
const content = (page: Page) => page.locator("node-detail-inverter-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const sectionRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.section).length);

async function openDetail(page: Page): Promise<void> {
    await cell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test.describe("the centre cell", () => {
    test("is a labelled button with the commanded mode, opened from the keyboard", async ({ page }) => {
        await mount(page);
        await expect(cell(page)).toBeVisible();
        await expect(cell(page)).toHaveText(/Normal/);
        await expect(cell(page)).toHaveAttribute("aria-label", "Inverter: Normal");

        await cell(page).focus();
        await page.keyboard.press("Enter");
        await expect(content(page).locator("[data-overview]")).toBeVisible();
    });

    test("a link short of 100 % is a neutral cue with its value, not a fault", async ({ page }) => {
        await mount(page, { linkRate: "97.0" });
        await expect(cell(page).locator(".inverter-link")).toHaveText("97 %");
        await expect(cell(page)).toHaveAttribute("aria-label", /communication details: 97 %/);
    });

    test("a rate just short of 100 % never rounds up to 100 %", async ({ page }) => {
        await mount(page, { linkRate: "99.97" });
        await expect(cell(page).locator(".inverter-link")).toHaveText("99.9 %");
    });

    test("no cell when the overview cannot be loaded, and the card still draws", async ({ page }) => {
        await mount(page, { overviewFails: true });
        await expect(page.locator("simple-card-solar")).toBeVisible();
        await expect(cell(page)).toHaveCount(0);
    });
});

test.describe("the inverter overview", () => {
    test("opens compact: a status sentence, at most three figures, the next change and five closed questions", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Helman last commanded: Normal. The inverter's mode registers match it.");
        await expect(overview.locator(".figure")).toHaveCount(3);
        await expect(overview.locator(".figure").nth(1)).toContainText("3.5 kW");
        await expect(overview.locator("[data-next]")).toHaveText("Next: 14:00 Charge to 80 %");
        // Every question findable, every one closed, none of them heavy yet.
        for (const id of ["why", "next", "limits", "operating", "trust"]) {
            await expect(header(page, id)).toHaveAttribute("aria-expanded", "false");
        }
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        // All the telemetry is available, and none of it grew the overview.
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
    });

    test("the end of an action is the next change: an empty stretch returns to normal", async ({ page }) => {
        await mount(page, { stopExportThenEmpty: true });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] [data-next]")).toHaveText(/^Next: 13:00 /);
        await expect(content(page).locator("[data-overview] [data-next]")).not.toContainText("Charge");
    });

    test("a candidate whose condition is not met is not the next change", async ({ page }) => {
        await mount(page, { noCharge: true });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] [data-next]")).toHaveText("No change planned for today or tomorrow.");
    });

    test("answer previews say the answer", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(question(page, "why").locator(".preview")).toHaveText("Normal · execution on");
        await expect(question(page, "limits").locator(".preview")).toHaveText("export ≤ 9.9 kW · SoC 10–100 %");
        await expect(question(page, "operating").locator(".preview")).toHaveText("AC 3.5 kW · 48 °C");
        await expect(question(page, "trust").locator(".preview")).toHaveText("link 100.0 % · 0 quarantined");
    });

    test("a confirmed disagreement is the one exception, linked to its answer", async ({ page }) => {
        await mount(page, { agreement: "mismatch" });
        await openDetail(page);
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("don't match Helman's last command");
        await exception.locator("button").click();
        await expect(header(page, "why")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "why").locator("[data-row='agreement']")).toContainText("Doesn't match the last command");
        await expect(question(page, "why").locator("[data-row='last-command']")).toContainText("Normal");
    });

    test("an unreadable register is unknown, never an alert", async ({ page }) => {
        await mount(page, { agreement: "unknown" });
        await openDetail(page);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await expect(content(page).locator(".status")).toContainText("can't be told right now");
        await header(page, "why").click();
        await expect(question(page, "why").locator("[data-row='agreement']")).toContainText("Unknown: some mode registers can't be read");
    });

    test("off-grid operation is promoted and leads to the operating answer", async ({ page }) => {
        await mount(page, { condition: "off_grid" });
        await openDetail(page);
        await expect(content(page).locator("[data-exception]")).toContainText("off-grid operation (Off-Grid)");
        await content(page).locator("[data-exception] button").click();
        await expect(header(page, "operating")).toHaveAttribute("aria-expanded", "true");
    });

    test("an overview that fails explains itself with a retry", async ({ page }) => {
        await mount(page);
        await page.evaluate(() => {
            const original = window.__hass.callWS;
            window.__hass.callWS = async (msg: any) => {
                if (msg.type === "helman/get_node_detail") throw new Error("down");
                return original(msg);
            };
        });
        await cell(page).click();
        await expect(content(page)).toContainText("Inverter details could not be loaded.");
        await expect(content(page).getByRole("button", { name: "Try again" })).toBeVisible();
    });
});

test.describe("questions", () => {
    test("opening one closes the other, and evidence is the second disclosure", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "why").click();
        await expect(header(page, "why")).toHaveAttribute("aria-expanded", "true");
        await header(page, "limits").click();
        await expect(header(page, "why")).toHaveAttribute("aria-expanded", "false");
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "limits").locator("[data-row='export-limit']")).toContainText("9.9 kW");
        await expect(question(page, "limits").locator("[data-row='eps_min_soc']")).toHaveCount(0);

        await question(page, "limits").locator("button.evidence-toggle").click();
        await expect(question(page, "limits").locator("[data-row='eps_min_soc']")).toContainText("10 %");
        await expect(question(page, "limits").locator("[data-row='main_breaker_limit']")).toContainText("25 A");
    });

    test("why: scheduled now, the executor, the last command and the registers are separate facts", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "why").click();
        const why = question(page, "why");
        await expect(why.locator("[data-row='scheduled']")).toContainText("Normal until 14:00");
        await expect(why.locator("[data-row='execution']")).toContainText("On: Helman applies the schedule");
        await expect(why.locator("[data-row='executor']")).toContainText("Applied · succeeded · Normal");
        await expect(why.locator("[data-row='last-command']")).toContainText("Normal");
        await expect(why.locator("[data-row='agreement']")).toContainText("Matches the last command");
        await why.locator("button.evidence-toggle").click();
        const registers = why.locator("[data-registers] tbody tr");
        await expect(registers).toHaveCount(2);
        await expect(registers.first()).toContainText("Self Use Mode");
        await expect(registers.first()).toContainText("matches");
    });

    test("why: with execution disabled the plan is shown as not applied", async ({ page }) => {
        await mount(page, { executionEnabled: false });
        await openDetail(page);
        await expect(question(page, "why").locator(".preview")).toHaveText("Normal · execution off");
        await header(page, "why").click();
        await expect(question(page, "why").locator("[data-row='execution']")).toContainText("Off: the schedule is shown but not applied");
    });

    test("next: planned runs, a candidate marked as not executed, and the plan chart mounted only when open", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
        await header(page, "next").click();
        const runs = question(page, "next").locator("[data-runs] li:not(.day-label)");
        await expect(runs.nth(1)).toContainText("14:00–16:00");
        await expect(runs.nth(1)).toContainText("Charge to 80 %");
        await expect(runs.nth(3)).toContainText("Discharge to 30 % (candidate, not executed)");
        await expect(question(page, "next").locator("helman-solar-inspector-card")).toHaveCount(1);
        await question(page, "next").locator("button.evidence-toggle").click();
        await expect(question(page, "next")).toContainText("The schedule does not record why an optimizer chose this action.");

        await header(page, "next").click();
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
    });

    test("operating: today's temperature is requested and drawn only when the question opens", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page)).toBe(0);
        await header(page, "operating").click();
        const chart = question(page, "operating").locator("helman-day-line-chart");
        await expect(chart).toBeVisible();
        expect(await sectionRequests(page)).toBe(1);
        await expect(chart.locator(".summary")).toContainText("Today 37.5 °C to 48.5 °C, mean 43.2 °C; warmest around 11:55. 89 % of the day so far is recorded.");
        // The morning gap stays a gap: the line breaks in two.
        const path = await chart.locator("path.line").getAttribute("d");
        expect((path ?? "").split("M").length - 1).toBe(2);

        await question(page, "operating").locator("button.evidence-toggle").click();
        const phases = question(page, "operating").locator("[data-phases] tbody tr");
        await expect(phases).toHaveCount(3);
        await expect(phases.first()).toContainText("235.3 V");
    });

    test("the chart is read by keyboard, not hover alone", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "operating").click();
        const plot = question(page, "operating").locator("helman-day-line-chart .plot");
        await plot.scrollIntoViewIfNeeded();
        await plot.focus();
        // Focusing can scroll the dialog, and a scroll closes any popup: let it settle.
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.keyboard.press("End");
        const tooltip = question(page, "operating").locator("helman-day-line-chart .hover-tooltip");
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText("11:55–12:00");
        await page.keyboard.press("Home");
        await expect(tooltip).toContainText("00:00–00:05");
        await page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
    });

    test("a failed history request explains itself, retries, and does not block the overview", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await header(page, "operating").click();
        await expect(question(page, "operating")).toContainText("Today's history could not be loaded.");
        await expect(question(page, "operating").locator("[data-row='ac-total']")).toContainText("3.5 kW");
        await expect(content(page).locator("[data-overview]")).toBeVisible();
        await question(page, "operating").getByRole("button", { name: "Try again" }).click();
        expect(await sectionRequests(page)).toBe(2);
    });

    test("trust: unavailable link readings say so, and the hardware facts are evidence", async ({ page }) => {
        await mount(page, { linkUnavailable: true });
        await openDetail(page);
        await expect(question(page, "trust").locator(".preview")).toHaveText("The link readings are unavailable.");
        await header(page, "trust").click();
        await expect(question(page, "trust").locator("[data-row='link-rate']")).toHaveCount(0);
        await question(page, "trust").locator("button.evidence-toggle").click();
        await expect(question(page, "trust").locator("[data-row='firmware']")).toContainText("DSP 1.46");
        await expect(question(page, "trust").locator("[data-row='mppt_count']")).toContainText("2");
    });

    test("keyboard: tab to a question, open it, reach its evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "limits").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "true");
        await expect(header(page, "limits")).toBeFocused();
        await question(page, "limits").locator("button.evidence-toggle").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "limits").locator("[data-row='eps_restart_soc']")).toBeVisible();
    });

    test("closing and reopening starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "why").click();
        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(header(page, "why")).toHaveAttribute("aria-expanded", "false");
    });
});

test.describe("a Custom inverter", () => {
    test("answers from its config: no agreement row, no trust question, no temperature", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(content(page).locator(".status")).toHaveText("Helman last commanded: Normal.");
        await expect(question(page, "trust")).toHaveCount(0);
        await expect(content(page).locator(".figure")).toHaveCount(1);
        await header(page, "why").click();
        await expect(question(page, "why").locator("[data-row='agreement']")).toHaveCount(0);
        await header(page, "operating").click();
        await expect(question(page, "operating").locator("helman-day-line-chart")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        await header(page, "limits").click();
        await expect(question(page, "limits").locator("[data-row='soc-range']")).toContainText("10–100 %");
        await expect(question(page, "limits").locator("[data-row='export-limit']")).toHaveCount(0);
    });
});

test.describe("screenshots", () => {
    test.skip(!SCREENS, "set P1_SCREENS to a directory to capture the review screenshots");
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        test(`overview and an expanded answer at ${name}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mount(page);
            await page.screenshot({ path: `${SCREENS}/${name}-card.png`, fullPage: true });
            await openDetail(page);
            await page.screenshot({ path: `${SCREENS}/${name}-overview.png`, fullPage: true });
            await header(page, "operating").click();
            await expect(question(page, "operating").locator("helman-day-line-chart svg")).toBeVisible();
            await question(page, "operating").locator("button.evidence-toggle").click();
            await page.screenshot({ path: `${SCREENS}/${name}-operating.png`, fullPage: true });
            await header(page, "why").click();
            await question(page, "why").locator("button.evidence-toggle").click();
            await page.screenshot({ path: `${SCREENS}/${name}-why.png`, fullPage: true });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});
