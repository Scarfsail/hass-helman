import { test, expect, type Page } from "@playwright/test";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";
import { CARD_BUNDLE } from "./support/card-page";

/**
 * The inverter: the simple card's centre cell and its node detail.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, the schedule and `helman/get_node_detail`. What is pinned is
 * the pictured overview (the plan → command → inverter chain, the mode strip,
 * the flow and the tiles), the shared disclosure contract (one open answer,
 * answer then evidence, keyboard, nothing heavy mounted or requested while
 * closed) and the inverter's truthfulness: the last command, the observed
 * registers, the plan and the executor are four facts and are never shown as
 * each other, and only a confirmed mismatch is promoted.
 */

const SCREENS = process.env.SCREENS;

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
    /** The card's live readings, W: battery negative while discharging. */
    solar?: string;
    house?: string;
    battery?: string;
    grid?: string;
    /** Each phase's AC power, W. */
    acPhase?: string;
    /** The rating in kW rather than W. */
    ratedKw?: boolean;
    modesFail?: boolean;
    /** The first read of today's modes is yesterday's, as after midnight; every read after it fails. */
    modesYesterdayThenFail?: boolean;
    /** No mode of the profile binds: the section answers without modes. */
    modesNull?: boolean;
    /** The slot in progress is a discharge candidate whose condition is not met. */
    candidateNow?: boolean;
    timeZone?: string;
};

declare global {
    interface Window {
        __hass: any;
        __requests: Array<{ type: string; node?: string; section?: string }>;
        __modesFail: boolean;
        __overview: any;
        __modesCalls: number;
        __dataChanged: Array<(event: unknown) => void>;
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
            ac_power_l1: ["sensor.solax_inverter_power_l1", v.acPhase ?? "1170", "W"],
            ac_power_l2: ["sensor.solax_inverter_power_l2", v.acPhase ?? "1180", "W"],
            ac_power_l3: ["sensor.solax_inverter_power_l3", v.acPhase ?? "1150", "W"],
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
            rated_power: ["sensor.solax_inverter_power_type", v.ratedKw ? "10" : "10000", v.ratedKw ? "kW" : "W"],
            mppt_count: ["sensor.solax_inverter_mppt_count", "2"],
            lock_state: ["select.solax_lock_state", "Unlocked"],
            grid_mode_runtime: ["sensor.solax_grid_mode_runtime", "32820.0", "h"],
            eps_mode_runtime: ["sensor.solax_eps_mode_runtime", "163.9", "h"],
        };
        const states: Record<string, unknown> = {
            "sensor.solar": s(v.solar ?? "4200", "W"), "sensor.grid": s(v.grid ?? "-300", "W"), "sensor.battery": s(v.battery ?? "-500", "W"),
            "sensor.house": s(v.house ?? "1200", "W"), "number.min_soc": s("10", "%"), "number.max_soc": s("100", "%"),
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
                ? { status: v.agreement ?? "match", reason: v.agreement === "unknown" ? "unavailable" : null, commanded: "normal", observedOption: v.agreement === "mismatch" ? null : "normal",
                    observedFrom: ["number.solax_export_control_user_limit", "select.solax_charger_use_mode", "select.solax_manual_mode_select"], registers }
                : { status: "unknown", reason: "no_profile", commanded: "normal", observedOption: null, observedFrom: [], registers: [] },
            condition: v.condition === "off_grid" ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: profile ? ["temperature", "modes"] : [],
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
        const stretch = (from: string, to: string, kind: string | null, open = false) =>
            ({ start: `${day}T${from}:00+00:00`, end: `${day}T${to}:00+00:00`, kind, open });
        // Normal overnight, a morning charge, a Modbus blip the registers held no mode in, normal since.
        const modes = {
            node: "inverter", section: "modes", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            modes: v.modesNull ? null : [
                stretch("00:00", "06:00", "normal"),
                stretch("06:00", "08:00", "charge_to_target_soc"),
                stretch("08:00", "08:10", null),
                stretch("08:10", "12:00", "normal", true),
            ],
        };
        const flowsSection = {
            node: "inverter", section: "flows", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            currency: "CZK/kWh", complete: false, unavailable: null,
            flows: {
                solarToHouse: 5.1, solarToBattery: 4.2, solarToGrid: 2.0, solarUnresolved: 0.4,
                gridToBattery: 1.5, unknownToBattery: 0.3, gridToBatteryCost: 4.0,
                batteryToHouse: 3.6, gridToHouse: 1.2, unknownToHouse: 0, batteryToGrid: 0,
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
            if (v.candidateNow && hour < 14) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
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
        window.__modesFail = !!v.modesFail;
        window.__overview = overview;
        window.__modesCalls = 0;
        window.__dataChanged = [];
        window.__hass = {
            language: "en",
            // A 24-hour English locale, so times read as the assertions write them.
            locale: { language: "en-GB" },
            config: { time_zone: v.timeZone ?? "UTC" },
            connection: {
                sendMessagePromise: async () => ({}),
                subscribeMessage: async (listener: (event: unknown) => void, request: { type: string }) => {
                    if (request.type === "helman/subscribe_updates") window.__dataChanged.push(listener);
                    return () => undefined;
                },
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return schedule;
                if (msg.type === "helman/get_node_detail") {
                    if (msg.section === "modes") {
                        window.__modesCalls += 1;
                        if (window.__modesFail) throw new Error("recorder down");
                        if (v.modesYesterdayThenFail) {
                            if (window.__modesCalls > 1) throw new Error("recorder down");
                            return { ...modes, period: { start: "2026-10-20T00:00:00+00:00", end: `${day}T00:00:00+00:00` } };
                        }
                        return modes;
                    }
                    if (msg.section === "flows") return flowsSection;
                    if (msg.section) {
                        if (v.sectionFails) throw new Error("recorder down");
                        return section;
                    }
                    if (v.overviewFails) throw new Error("backend down");
                    return window.__overview;
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


const cell = (page: Page) => page.locator(".inverter-cell");
const content = (page: Page) => page.locator("node-detail-inverter-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const tile = (page: Page, id: string) => page.locator(`helman-node-tile[data-question="${id}"]`);
const chain = (page: Page) => content(page).locator("[data-chain]");
const box = (page: Page, key: string) => chain(page).locator(`[data-box="${key}"]`);
const strip = (page: Page) => content(page).locator("helman-mode-strip");
const flow = (page: Page) => content(page).locator("helman-node-flow");
const flowLabel = (page: Page, side: "in" | "out", id: string) => flow(page).locator(`[data-side="${side}"] [data-flow="${id}"]`);
const sectionRequests = (page: Page, section?: string) =>
    page.evaluate((name) => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.section
        && (name === undefined ? r.section !== "modes" : r.section === name)).length, section);

async function segments(page: Page): Promise<Array<{ tone: string; planned: string; from: string; to: string }>> {
    return strip(page).locator("[data-segment]").evaluateAll((nodes) => nodes.map((node) => ({
        tone: node.getAttribute("data-tone")!,
        planned: node.getAttribute("data-planned")!,
        from: new Date(Number(node.getAttribute("data-start"))).toISOString().slice(11, 16),
        to: new Date(Number(node.getAttribute("data-end"))).toISOString().slice(11, 16),
    })));
}

async function setStates(page: Page, states: Record<string, string>): Promise<void> {
    await page.evaluate((states) => {
        const card = document.querySelector("helman-simple-card") as any;
        const hass = window.__hass;
        const next = { ...hass.states };
        for (const [id, state] of Object.entries(states)) next[id] = { ...next[id], state };
        window.__hass = { ...hass, states: next };
        card.hass = window.__hass;
    }, states);
}

/** Announce a data change, as the backend's update feed does. */
async function announceChange(page: Page): Promise<void> {
    await page.evaluate(() => { for (const listener of window.__dataChanged) listener({ kind: "config" }); });
}

const overviewRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.node === "inverter" && !r.section).length);

async function openDetail(page: Page): Promise<void> {
    await cell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

/** Open a question the way a reader does: the picture that absorbed it, or its tile. */
async function open(page: Page, id: string): Promise<void> {
    if (id === "why") await chain(page).click();
    else if (id === "next") await content(page).locator("[data-strip]").click();
    else await tile(page, id).locator("button").click();
    await expect(header(page, id)).toHaveAttribute("aria-expanded", "true");
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
    test("opens on a status pill, the chain, the strip, the Now flow and three closed tiles", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const status = content(page).locator("[data-overview] .status");
        await expect(status).toHaveText("Helman last commanded: Normal.");
        await expect(status).toHaveAttribute("data-tone", "normal");
        await expect(chain(page).locator("[data-box]")).toHaveCount(3);
        await expect(strip(page)).toBeVisible();
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");

        const ids = await content(page).locator("helman-node-tile").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["limits", "operating", "trust"]);
        // No answer is open, and nothing heavy is mounted; only the strip's modes are read.
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        expect(await sectionRequests(page, "modes")).toBe(1);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
    });

    test("tiles say the answer: the export cap with the SoC range, temperature and load, the link", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(tile(page, "limits").locator(".value")).toHaveText("≤ 9.9 kW");
        await expect(tile(page, "limits").locator(".detail")).toHaveText("export cap · SoC 10–100 %");
        const range = tile(page, "limits").locator("[data-soc-range]");
        await expect(range).toHaveAttribute("data-min", "10");
        await expect(range).toHaveAttribute("data-max", "100");
        await expect(range.locator(".meter-fill")).toHaveAttribute("style", /margin-left: 10%; width: 90%/);
        // 3.5 kW of the 10 kW rating, without thresholds.
        await expect(tile(page, "operating").locator(".value")).toHaveText("48 °C");
        await expect(tile(page, "operating").locator(".detail")).toHaveText("AC 3.5 kW · 35 % of rating");
        await expect(tile(page, "operating").locator("[data-load-meter] .meter-fill")).toHaveAttribute("style", /width: 35\.0%/);
        // The rate and the quarantined count: no hourly dots, there is no history of the link.
        await expect(tile(page, "trust").locator(".value")).toHaveText("100.0 %");
        await expect(tile(page, "trust").locator(".detail")).toHaveText("0 quarantined");
        await expect(tile(page, "trust").locator(".caption")).toHaveText("Can I trust its readings?");
    });

    test("unavailable link readings say so on the trust tile", async ({ page }) => {
        await mount(page, { linkUnavailable: true });
        await openDetail(page);
        await expect(tile(page, "trust").locator(".value")).toHaveText("–");
        await expect(tile(page, "trust").locator(".detail")).toHaveText("The link readings are unavailable.");
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

test.describe("the chain", () => {
    test("match: plan, command and inverter in their mode's tone, linked; it opens why", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(chain(page).locator(".picture-scope")).toHaveText("Now · 12:00");
        await expect(box(page, "plan").locator(".box-value")).toHaveText("Normal");
        await expect(box(page, "plan").locator(".box-detail")).toHaveText("execution on");
        await expect(box(page, "command").locator(".box-value")).toHaveText("Normal");
        await expect(box(page, "command").locator(".box-detail")).toHaveText("executor succeeded");
        await expect(box(page, "inverter").locator(".box-value")).toHaveText("Normal");
        await expect(box(page, "inverter").locator(".box-detail")).toHaveText("matches");
        for (const key of ["plan", "command", "inverter"]) {
            await expect(box(page, key)).toHaveAttribute("data-tone", "normal");
            await expect(box(page, key)).toHaveClass(/action-tone-normal/);
        }
        await expect(box(page, "inverter")).not.toHaveAttribute("data-state", "mismatch");
        await expect(chain(page).locator("[data-link]")).toHaveCount(2);
        await expect(chain(page).locator("[data-link='broken']")).toHaveCount(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);

        // A button wrapping a picture keeps its values readable: the question is its title.
        await expect(chain(page)).toHaveAttribute("title", "Why is the inverter doing this?");
        expect(await chain(page).getAttribute("aria-label")).toBeNull();
        await open(page, "why");
        await expect(chain(page)).toHaveAttribute("aria-expanded", "true");
        const why = question(page, "why");
        await expect(why.locator("[data-row='scheduled']")).toContainText("Normal until 14:00");
        await expect(why.locator("[data-row='execution']")).toContainText("On: Helman applies the schedule");
        await expect(why.locator("[data-row='executor']")).toContainText("Applied · succeeded · Normal");
        await expect(why.locator("[data-row='last-command']")).toContainText("Normal");
        await expect(why.locator("[data-row='agreement']")).toContainText("Matches the last command");
        await evidence(page, "why").click();
        const registers = why.locator("[data-registers] tbody tr");
        await expect(registers).toHaveCount(2);
        await expect(registers.first()).toContainText("Self Use Mode");
        await expect(registers.first()).toContainText("matches");
    });

    test("mismatch: the inverter's box turns red and the exception sits under the chain, leading to why", async ({ page }) => {
        await mount(page, { agreement: "mismatch" });
        await openDetail(page);
        await expect(box(page, "inverter")).toHaveAttribute("data-state", "mismatch");
        await expect(box(page, "inverter")).toHaveClass(/mismatch/);
        await expect(box(page, "inverter").locator(".box-value")).toHaveText("another mode");
        await expect(box(page, "inverter").locator(".box-detail")).toHaveText("doesn't match");
        // The plan and the command are unchanged: only the disagreement is promoted.
        await expect(box(page, "command")).not.toHaveAttribute("data-state", "mismatch");
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toHaveCount(1);
        await expect(exception).toContainText("don't match Helman's last command");
        // Under the chain, before the strip.
        const order = await content(page).locator("[data-chain], [data-exception], [data-strip]").evaluateAll((nodes) =>
            nodes.map((node) => node.hasAttribute("data-chain") ? "chain" : node.hasAttribute("data-exception") ? "exception" : "strip"));
        expect(order).toEqual(["chain", "exception", "strip"]);
        await exception.locator("button").click();
        await expect(header(page, "why")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "why").locator("[data-row='agreement']")).toContainText("Doesn't match the last command");
    });

    test("execution off: the link from plan to command is broken and says not applied", async ({ page }) => {
        await mount(page, { executionEnabled: false });
        await openDetail(page);
        await expect(box(page, "plan").locator(".box-detail")).toHaveText("execution off");
        const links = chain(page).locator("[data-link]");
        await expect(links.nth(0)).toHaveAttribute("data-link", "broken");
        await expect(links.nth(0)).toHaveText("not applied");
        await expect(links.nth(1)).toHaveAttribute("data-link", "applied");
        await open(page, "why");
        await expect(question(page, "why").locator("[data-row='execution']")).toContainText("Off: the schedule is shown but not applied");
    });

    test("an unreadable register is unknown, never an alert", async ({ page }) => {
        await mount(page, { agreement: "unknown" });
        await openDetail(page);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await expect(box(page, "inverter")).not.toHaveAttribute("data-state", "mismatch");
        await expect(box(page, "inverter").locator(".box-detail")).toHaveText("can't be told now");
        await open(page, "why");
        await expect(question(page, "why").locator("[data-row='agreement']")).toContainText("Unknown: some mode registers can't be read");
    });

    test("a candidate in progress is what the executor applies, normal, and said to be a candidate", async ({ page }) => {
        await mount(page, { candidateNow: true });
        await openDetail(page);
        await expect(box(page, "plan").locator(".box-value")).toHaveText("Normal");
        await expect(box(page, "plan").locator(".box-detail")).toHaveText("Discharge to 30 %: a candidate, not executed · execution on");
        await expect(box(page, "plan")).toHaveAttribute("data-tone", "normal");
        // The strip agrees: normal from now.
        expect((await segments(page)).find((segment) => segment.planned === "true")).toEqual({ tone: "normal", planned: "true", from: "12:00", to: "14:00" });
    });

    for (const [reason, text] of [["no_command", "No command to compare yet"], ["not_bound", "Unknown: not every mode register of the profile is found"]] as const) {
        test(`an agreement unknown for ${reason} says why`, async ({ page }) => {
            await mount(page);
            await page.evaluate((reason) => {
                window.__overview = { ...window.__overview, agreement: { ...window.__overview.agreement, status: "unknown", reason, registers: [] } };
            }, reason);
            await openDetail(page);
            await expect(box(page, "inverter").locator(".box-detail")).toHaveText(text);
        });
    }

    test("the plan box takes the slot's action tone", async ({ page }) => {
        await mount(page, { stopExportThenEmpty: true });
        await openDetail(page);
        await expect(box(page, "plan").locator(".box-value")).toHaveText("Stop export");
        await expect(box(page, "plan")).toHaveAttribute("data-tone", "stop");
    });
});

test.describe("the mode strip", () => {
    test("today's recorded modes solid, a gap left a gap, the plan hatched to noon tomorrow, the next change flagged", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(content(page).locator("[data-strip] .picture-scope")).toHaveText("Modes · today to noon tomorrow");
        expect(await segments(page)).toEqual([
            { tone: "normal", planned: "false", from: "00:00", to: "06:00" },
            { tone: "charge", planned: "false", from: "06:00", to: "08:00" },
            // 08:00–08:10 the registers held no mode: a gap, never forced into one.
            { tone: "normal", planned: "false", from: "08:10", to: "12:00" },
            // The plan from now: the executor applies normal outside actions, and a candidate is normal.
            { tone: "normal", planned: "true", from: "12:00", to: "14:00" },
            { tone: "charge", planned: "true", from: "14:00", to: "16:00" },
            { tone: "normal", planned: "true", from: "16:00", to: "18:00" },
            { tone: "normal", planned: "true", from: "18:00", to: "19:00" },
            { tone: "normal", planned: "true", from: "19:00", to: "12:00" },
        ]);
        const next = strip(page).locator("[data-next-change]");
        await expect(next).toHaveText("14:00 · Charge to 80 %");
        await expect(next).toHaveAttribute("data-tone", "charge");
        await expect(strip(page).locator("[data-now]")).toHaveCount(1);
    });

    test("the strip opens what it will do next", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(content(page).locator("[data-strip]")).toHaveAttribute("title", "What will it do next?");
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
        await open(page, "next");
        const runs = question(page, "next").locator("[data-runs] li:not(.day-label)");
        await expect(runs.nth(1)).toContainText("14:00–16:00");
        await expect(runs.nth(1)).toContainText("Charge to 80 %");
        await expect(runs.nth(3)).toContainText("Discharge to 30 % (candidate, not executed)");
        await expect(question(page, "next").locator("helman-solar-inspector-card")).toHaveCount(1);
        await evidence(page, "next").click();
        await expect(question(page, "next")).toContainText("The schedule does not record why an optimizer chose this action.");
        await content(page).locator("[data-strip]").click();
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
    });

    test("with execution off the plan is drawn neutral, not applied", async ({ page }) => {
        await mount(page, { executionEnabled: false });
        await openDetail(page);
        const planned = (await segments(page)).filter((segment) => segment.planned === "true");
        expect(planned.length).toBeGreaterThan(0);
        expect(planned.every((segment) => segment.tone === "neutral")).toBe(true);
        // What was recorded keeps its tone.
        expect((await segments(page))[1].tone).toBe("charge");
    });

    test("an empty stretch after an action is the next change back to normal", async ({ page }) => {
        await mount(page, { stopExportThenEmpty: true });
        await openDetail(page);
        await expect(strip(page).locator("[data-next-change]")).toHaveText(/^13:00 · /);
        await expect(strip(page).locator("[data-next-change]")).toHaveAttribute("data-tone", "normal");
    });

    test("a candidate whose condition is not met is not the next change", async ({ page }) => {
        await mount(page, { noCharge: true });
        await openDetail(page);
        await expect(strip(page).locator("[data-next-change]")).toHaveCount(0);
    });

    test("today's modes that fail to load say so, and retry", async ({ page }) => {
        await mount(page, { modesFail: true });
        await openDetail(page);
        await expect(content(page).locator("[data-strip-failed]")).toContainText("Today's modes could not be read.");
        expect((await segments(page)).every((segment) => segment.planned === "true")).toBe(true);
        await page.evaluate(() => { window.__modesFail = false; });
        await content(page).locator("[data-strip-failed] button").click();
        await expect(content(page).locator("[data-strip-failed]")).toHaveCount(0);
        expect((await segments(page))[0]).toEqual({ tone: "normal", planned: "false", from: "00:00", to: "06:00" });
        expect(await sectionRequests(page, "modes")).toBe(2);
    });
});

test.describe("today's modes are read when the observed mode changes", () => {
    test("a register change re-reads the comparison, and only a new observed mode re-reads the history", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page, "modes")).toBe(1);
        const before = await overviewRequests(page);
        // A compared register moves, but the registers still hold Normal.
        await setStates(page, { "number.solax_export_control_user_limit": "9900.0" });
        await expect.poll(() => overviewRequests(page)).toBeGreaterThan(before);
        expect(await sectionRequests(page, "modes")).toBe(1);
        // The inverter now shows another mode: today's modes are read again.
        await page.evaluate(() => { window.__overview = { ...window.__overview, agreement: { ...window.__overview.agreement, observedOption: "charge_to_target_soc" } }; });
        await setStates(page, { "select.solax_charger_use_mode": "Manual Mode" });
        await expect.poll(() => sectionRequests(page, "modes")).toBe(2);
    });

    test("a register only another mode binds still re-reads the comparison", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const before = await overviewRequests(page);
        // Normal never writes the manual mode, but the observed mode is read from it too.
        await setStates(page, { "select.solax_manual_mode_select": "Force Charge" });
        await expect.poll(() => overviewRequests(page)).toBeGreaterThan(before);
    });
});

test.describe("today's modes on a data change, a new day and a changed config", () => {
    test("a data change reads today's modes once, after the overview it reloads", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect.poll(() => page.evaluate(() => window.__modesCalls)).toBe(1);
        const before = await overviewRequests(page);
        await announceChange(page);
        await expect.poll(() => overviewRequests(page)).toBeGreaterThan(before);
        await expect.poll(() => page.evaluate(() => window.__modesCalls)).toBe(2);
        await page.waitForTimeout(600);
        expect(await page.evaluate(() => window.__modesCalls)).toBe(2);
    });

    test("when the overview stops offering the section, the strip drops today's modes and stops reading them", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect.poll(async () => (await segments(page)).filter((segment) => segment.planned === "false").length).toBe(3);
        await page.evaluate(() => { window.__overview = { ...window.__overview, sections: ["temperature"] }; });
        await announceChange(page);
        await expect.poll(async () => (await segments(page)).filter((segment) => segment.planned === "false").length).toBe(0);
        expect(await page.evaluate(() => window.__modesCalls)).toBe(1);
    });

    test("a section without modes says why the strip has only the plan", async ({ page }) => {
        await mount(page, { modesNull: true });
        await openDetail(page);
        await expect(content(page).locator("[data-strip-no-registers]")).toHaveText(
            "Not every mode register of the profile is found, so today's modes can't be read: only the plan is drawn.");
        expect((await segments(page)).every((segment) => segment.planned === "true")).toBe(true);
    });

    test("yesterday's modes give way on a new day, so a failed read says so", async ({ page }) => {
        await mount(page, { modesYesterdayThenFail: true });
        await openDetail(page);
        await expect(content(page).locator("[data-strip-failed]")).toContainText("Today's modes could not be read.");
        expect((await segments(page)).every((segment) => segment.planned === "true")).toBe(true);
    });
});

test.describe("the strip in Home Assistant's time zone", () => {
    test.use({ timezoneId: "America/New_York" });

    test("midnight to noon tomorrow, the hours and the chain's time are Home Assistant's, not the browser's", async ({ page }) => {
        // 12:00 UTC is 14:00 in Prague: the strip runs from Prague's midnight, 22:00 UTC, for 36 h.
        await mount(page, { timeZone: "Europe/Prague" });
        await openDetail(page);
        const ticks = strip(page).locator(".hours span");
        await expect(ticks.first()).toHaveText("00");
        await expect(ticks.first()).toHaveAttribute("style", /left: 0\.00%/);
        await expect(ticks.nth(1)).toHaveText("06");
        await expect(ticks.nth(1)).toHaveAttribute("style", /left: 16\.67%/);
        await expect(ticks.last()).toHaveText("12");
        await expect(strip(page).locator("[data-now] line")).toHaveAttribute("x1", "389");
        // The recorded 00:00 UTC stretch starts 2 h into Prague's day.
        await expect(strip(page).locator("[data-segment]").first()).toHaveAttribute("style", /left: 5\.56%/);
        await expect(chain(page).locator(".picture-scope")).toHaveText("Now · 14:00");
        await expect(strip(page).locator("[data-next-change]")).toHaveText("16:00 · Charge to 80 %");
    });
});

test.describe("the flow", () => {
    test("Now: solar, battery and grid in; house, battery and export out, around the inverter's AC power", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Now · 12:00");
        await expect(flow(page).locator("[data-glyph='inverter']")).toHaveCount(1);
        await expect(flow(page).locator("[data-ac]")).toHaveText("AC 3.5 kW");
        await expect(flowLabel(page, "in", "solar")).toContainText("4.2 kW");
        await expect(flowLabel(page, "in", "battery")).toContainText("500 W");
        await expect(flowLabel(page, "in", "grid")).toHaveClass(/none/);
        await expect(flowLabel(page, "out", "house")).toContainText("1.2 kW");
        await expect(flowLabel(page, "out", "battery")).toHaveClass(/none/);
        await expect(flowLabel(page, "out", "grid")).toContainText("3.5 kW");
        await expect(flowLabel(page, "out", "grid")).toContainText("Export");
        await expect(flow(page).locator("[data-total='in']")).toHaveText("In 4.7 kW");
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 4.7 kW");
    });

    test("an unreadable house meter leaves every edge unknown, never 0", async ({ page }) => {
        await mount(page, { house: "unavailable" });
        await openDetail(page);
        for (const [side, id] of [["in", "solar"], ["in", "battery"], ["out", "house"], ["out", "grid"]] as const) {
            await expect(flowLabel(page, side, id)).toContainText("–");
        }
        await expect(flow(page).locator("[data-ribbon]")).toHaveCount(0);
        await expect(flow(page).locator("[data-total]")).toHaveCount(0);
    });

    test("Today is requested only once chosen, from the same edges, with the unresolved energy said", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page, "flows")).toBe(0);
        await flow(page).locator("[data-scope='today']").click();
        await expect(flowLabel(page, "in", "solar")).toContainText("11 kWh");
        expect(await sectionRequests(page, "flows")).toBe(1);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Today · 00:00–12:00");
        await expect(flowLabel(page, "in", "battery")).toContainText("3.6 kWh");
        await expect(flowLabel(page, "in", "grid")).toContainText("2.7 kWh");
        await expect(flowLabel(page, "out", "house")).toContainText("9.9 kWh");
        await expect(flowLabel(page, "out", "battery")).toContainText("5.7 kWh");
        await expect(flowLabel(page, "out", "grid")).toContainText("2.0 kWh");
        await expect(flow(page).locator("[data-ac]")).toHaveCount(0);
        await expect(flow(page).locator("[data-flow-note]")).toHaveText([
            "0.40 kWh of today's solar is not resolved to a destination.",
            "0.30 kWh of today's charge has no known source.",
        ]);
        await expect(flow(page).locator("[data-total='in']")).toHaveText("In 18 kWh");
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 18 kWh");
    });

    test("tapping the flow opens how the inverter is operating", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await flow(page).locator("[data-side='in']").click();
        await expect(header(page, "operating")).toHaveAttribute("aria-expanded", "true");
    });
});

test.describe("answers", () => {
    test("one open at a time under the tiles, and evidence is the second disclosure", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "why");
        await open(page, "limits");
        await expect(question(page, "why")).toHaveCount(0);
        await expect(question(page, "limits").locator("[data-row='export-limit']")).toContainText("9.9 kW");
        await expect(question(page, "limits").locator("[data-row='eps_min_soc']")).toHaveCount(0);
        await evidence(page, "limits").click();
        await expect(question(page, "limits").locator("[data-row='eps_min_soc']")).toContainText("10 %");
        await expect(question(page, "limits").locator("[data-row='main_breaker_limit']")).toContainText("25 A");
    });

    test("operating: today's temperature is requested and drawn only when the question opens", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page, "temperature")).toBe(0);
        await open(page, "operating");
        const chart = question(page, "operating").locator("helman-day-line-chart");
        await expect(chart).toBeVisible();
        expect(await sectionRequests(page, "temperature")).toBe(1);
        await expect(chart.locator(".summary")).toContainText("Today 37.5 °C to 48.5 °C, mean 43.2 °C; warmest around 11:55. 89 % of the day so far is recorded.");
        // The morning gap stays a gap: the line breaks in two.
        const path = await chart.locator("path.line").getAttribute("d");
        expect((path ?? "").split("M").length - 1).toBe(2);

        await evidence(page, "operating").click();
        const phases = question(page, "operating").locator("[data-phases] tbody tr");
        await expect(phases).toHaveCount(3);
        await expect(phases.first()).toContainText("235.3 V");
    });

    test("the chart is read by keyboard, not hover alone", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "operating");
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
        await open(page, "operating");
        await expect(question(page, "operating")).toContainText("Today's history could not be loaded.");
        await expect(question(page, "operating").locator("[data-row='ac-total']")).toContainText("3.5 kW");
        await expect(content(page).locator("[data-overview]")).toBeVisible();
        await question(page, "operating").getByRole("button", { name: "Try again" }).click();
        expect(await sectionRequests(page, "temperature")).toBe(2);
    });

    test("trust: the readings open more-info, and the hardware facts are evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "trust");
        await expect(question(page, "trust").locator("[data-row='link-rate'] button.reading")).toHaveAttribute("data-entity", "sensor.solax_inverter_communication_success_rate");
        await evidence(page, "trust").click();
        await expect(question(page, "trust").locator("[data-row='firmware']")).toContainText("DSP 1.46");
        await expect(question(page, "trust").locator("[data-row='mppt_count']")).toContainText("2");
    });

    test("keyboard: tab to a tile, open it, reach its evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await tile(page, "limits").locator("button").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "true");
        await evidence(page, "limits").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "limits").locator("[data-row='eps_restart_soc']")).toBeVisible();
    });

    test("closing and reopening starts at the overview, on Now", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "why");
        await flow(page).locator("[data-scope='today']").click();
        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
    });
});

test.describe("a Custom inverter", () => {
    test("answers from its config: no registers, no modes read, only the plan on the strip, no trust tile", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(content(page).locator(".status")).toHaveText("Helman last commanded: Normal.");
        await expect(tile(page, "trust")).toHaveCount(0);
        await expect(box(page, "inverter").locator(".box-detail")).toHaveText("not readable");
        expect(await sectionRequests(page, "modes")).toBe(0);
        expect((await segments(page)).every((segment) => segment.planned === "true")).toBe(true);
        await expect(content(page).locator("[data-strip-no-history]")).toBeVisible();
        await open(page, "why");
        await expect(question(page, "why").locator("[data-row='agreement']")).toHaveCount(0);
        await open(page, "operating");
        await expect(question(page, "operating").locator("helman-day-line-chart")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        await open(page, "limits");
        await expect(question(page, "limits").locator("[data-row='soc-range']")).toContainText("10–100 %");
        await expect(question(page, "limits").locator("[data-row='export-limit']")).toHaveCount(0);
    });
});

/** The review screenshots: an evening discharge, a midday charge, and the chain's two other states. */
const STATES: Array<[string, Variant]> = [
    ["evening", { solar: "0", house: "1800", battery: "-1500", grid: "300", acPhase: "500" }],
    ["midday", { solar: "6500", house: "900", battery: "3200", grid: "-2400", acPhase: "1100" }],
    ["mismatch", { agreement: "mismatch" }],
    ["execution-off", { executionEnabled: false }],
];

test.describe("screenshots", { tag: "@screens" }, () => {
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        for (const [state, variant] of STATES) {
            test(`the ${state} overview at ${name}`, async ({ page }) => {
                await page.setViewportSize({ width, height });
                await mount(page, variant);
                // Home Assistant's default light theme colours the specs otherwise leave unset.
                await page.addStyleTag({ content: "html { --divider-color: rgba(0, 0, 0, 0.12); --secondary-background-color: #e5e5e5; --card-background-color: #fff; --primary-color: #03a9f4; --primary-text-color: #212121; --secondary-text-color: #727272; --disabled-text-color: #bdbdbd; }" });
                await openDetail(page);
                await expect(strip(page).locator("[data-segment]").first()).toBeVisible();
                await page.screenshot({ path: `${SCREENS}/inverter-${state}-${name}-now.png`, fullPage: true });
                if (state === "evening" || state === "midday") {
                    await flow(page).locator("[data-scope='today']").click();
                    await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
                    await page.screenshot({ path: `${SCREENS}/inverter-${state}-${name}-today.png`, fullPage: true });
                    await open(page, "operating");
                    await expect(question(page, "operating").locator("helman-day-line-chart svg")).toBeVisible();
                    await page.screenshot({ path: `${SCREENS}/inverter-${state}-${name}-operating.png`, fullPage: true });
                } else {
                    await open(page, "why");
                    await evidence(page, "why").click();
                    await page.screenshot({ path: `${SCREENS}/inverter-${state}-${name}-why.png`, fullPage: true });
                }
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                expect(overflow).toBeLessThanOrEqual(0);
            });
        }
    }
});

test("the load share converts a rating in kW and phases in W to one unit", async ({ page }) => {
    await mount(page, { ratedKw: true });
    await openDetail(page);
    await expect(tile(page, "operating").locator(".detail")).toHaveText("AC 3.5 kW · 35 % of rating");
});
