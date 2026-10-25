import { prepareNodeDetailPage, mountSimpleCard } from "./support/node-detail-harness";
import { cardTree, scheduleSlots } from "./support/payload-builders";
import type { ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

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
    /** The first read of today's modes answers; every read after it fails. */
    modesThenFail?: boolean;
    /** The first read of today's modes is yesterday's, as after midnight; every read after it fails. */
    modesYesterdayThenFail?: boolean;
    /** No mode of the profile binds: the section answers without modes. */
    modesNull?: boolean;
    /** The slot in progress is a discharge candidate whose condition is not met. */
    candidateNow?: boolean;
    plannedChargeNow?: boolean;
    userOverrideNow?: boolean;
    runtimeFailed?: boolean;
    timeZone?: string;
};

declare global {
    interface Window {
        __InverterHass: any;
        __InverterRequests: Array<{ type: string; node?: string; section?: string }>;
        __modesFail: boolean;
        __overview: any;
        __modesCalls: number;
        __dataChanged: Array<(event: unknown) => void>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate(({ v, tree, scheduleDefaults }) => {
        const profile = v.profile !== false;
        const s = window.__nodeDetailState;
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
            "select.helman_inverter_mode": s("normal", undefined, { friendly_name: "Helman inverter mode" }),
        };
        const entities: Record<string, string | null> = { battery_min_soc: "number.min_soc", battery_max_soc: "number.max_soc" };
        if (profile) {
            for (const [key, [entityId, state, unit]] of Object.entries(telemetry)) {
                entities[key] = entityId;
                states[entityId] = s(state, unit, { friendly_name: key.replace(/_/g, " ") });
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
        const flowsSection = window.__flowsSection("inverter", { flows: { ...window.__flowsSection("inverter").flows, solarToGrid: 2.0, unknownToHouse: 0 } });
        // 15-minute slots from 11:45 today for a day and a half.
        const slots: ScheduleSlotDTO[] = [];
        const start = Date.parse(`${day}T11:45:00Z`);
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = at.getUTCHours() + (at.getUTCDate() - 21) * 24;
            let action: ScheduleActionDTO | null = { kind: "normal", setBy: "automation" };
            if (v.stopExportThenEmpty && hour < 13) action = { kind: "stop_export", setBy: "automation" };
            if (v.stopExportThenEmpty && hour === 13) action = null;
            if (!v.noCharge && hour >= 14 && hour < 16) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (hour >= 18 && hour < 19) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
            if (v.candidateNow && hour < 14) action = { kind: "discharge_to_target_soc", targetSoc: 30, setBy: "automation", conditionMet: false };
            if (v.plannedChargeNow && hour < 14) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (v.userOverrideNow && hour < 14) action = { kind: "normal", setBy: "user" };
            slots.push({ id, controllables: action ? { inverter: action } : {} });
        }
        const schedule: SchedulePayload = {
            ...scheduleDefaults,
            executionEnabled: v.executionEnabled !== false,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: { actionKind: "apply", outcome: v.runtimeFailed ? "failed" : "success", executedAction: { kind: "normal" }, reason: "scheduled" } },
            },
        };
        window.__modesFail = !!v.modesFail;
        window.__overview = overview;
        window.__modesCalls = 0;
        window.__dataChanged = [];
        window.__InverterHass = window.__configureNodeDetail({
            states, tree, overviews: { inverter: overview }, sections: { inverter: { flows: flowsSection, modes, temperature: section } }, schedule,
            timeZone: v.timeZone,
            hass: { connection: { subscribeMessage: async (listener: (event: unknown) => void, request: { type: string }) => {
                if (request.type === "helman/subscribe_updates") window.__dataChanged.push(listener);
                return () => undefined;
            } } },
            replies: {
                "helman/get_appliances": { appliances: [{ id: "inverter", name: "Inverter", kind: "inverter", primaryEntityId: "select.helman_inverter_mode", supportsAuthoring: true, normalState: "normal", actionOptions: { normal: "normal", stop_export: "stop_export" } }] },
                "helman/get_node_detail": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    if (msg.section === "modes") {
                        window.__modesCalls += 1;
                        if (window.__modesFail)
                            throw new Error("recorder down");
                        if (v.modesThenFail && window.__modesCalls > 1)
                            throw new Error("recorder down");
                        if (v.modesYesterdayThenFail) {
                            if (window.__modesCalls > 1)
                                throw new Error("recorder down");
                            return { ...modes, period: { start: "2026-10-20T00:00:00+00:00", end: `${day}T00:00:00+00:00` } };
                        }
                        return modes;
                    }
                    if (msg.section === "flows")
                        return flowsSection;
                    if (msg.section) {
                        if (v.sectionFails)
                            throw new Error("recorder down");
                        return section;
                    }
                    if (v.overviewFails)
                        throw new Error("backend down");
                    return window.__overview;
                },
            },
        });
        window.__InverterRequests = window.__NodeDetailRequests;
    }, { v: variant, tree: cardTree(), scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page);
}



const content = (page: Page) => page.locator("node-detail-inverter-content");

test("inverter Overview shows the P1 detail layout", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    const c = content(page);
    await expect(c.locator("[data-overview]")).toBeVisible();
    await expect(c.locator("helman-detail-headline")).toBeVisible();
    await expect(c.locator("[data-chain] [data-box]")).toHaveCount(3);
    await expect(c.locator("[data-verdict]")).toBeVisible();
    await expect(c.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
});

test("Back closes the Overview mode override and keeps the inverter detail", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    await content(page).locator("button.link-button").filter({ hasText: "Override mode" }).click();
    await expect(page.locator("control-override-dialog")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanInverterOverrideId)).toBeTruthy();
    await page.evaluate(() => window.history.back());
    await expect(page.locator("control-override-dialog")).toHaveCount(0);
    await expect(content(page)).toBeVisible();
});

test("inverter condition remains visible without a dead Details button", async ({ page }) => {
    await mount(page, { condition: "off_grid" });
    await page.locator(".inverter-cell").click();

    const warning = content(page).locator("[data-exception]");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Off-Grid");
    await expect(warning.locator("button")).toHaveCount(0);
});

test("inverter verdict distinguishes agreement and mismatch", async ({ page }) => {
    await mount(page, { profile: true, agreement: "match" });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-verdict]")).toContainText("Everything agrees");
    await expect(content(page).locator("[data-output]")).toContainText("Output now (AC)");
});

test("inverter does not claim agreement when the plan differs from the last command", async ({ page }) => {
    await mount(page, { plannedChargeNow: true });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-verdict]")).toContainText("last command differs from the plan");
});

test("inverter reports disabled execution in status and verdict", async ({ page }) => {
    await mount(page, { executionEnabled: false });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-overview] .status")).toContainText("Execution off");
    await expect(content(page).locator("[data-verdict]")).toContainText("execution off");
});

test("inverter candidate is judged by its effective normal action", async ({ page }) => {
    await mount(page, { candidateNow: true });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-verdict]")).toContainText("Everything agrees");
});

test("inverter does not claim agreement when the current command failed", async ({ page }) => {
    await mount(page, { runtimeFailed: true });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-verdict]")).toContainText("scheduled command failed");
});

test("inverter Schedule does not promise an unmet discharge candidate", async ({ page }) => {
    await mount(page, { noCharge: true });
    await page.locator(".inverter-cell").click();
    await expect(page.locator("node-detail-dialog helman-detail-section[data-schedule] [slot=summary]"))
        .toContainText("Nothing planned");
});

test("inverter status names a manual override", async ({ page }) => {
    await mount(page, { userOverrideNow: true });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-overview] .status")).toContainText("You, until");
});
