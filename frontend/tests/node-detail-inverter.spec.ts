import { prepareNodeDetailPage, mountSimpleCard, onDashboard, expectShowMore } from "./support/node-detail-harness";
import { cardTree, scheduleSlots } from "./support/payload-builders";
import type { ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The inverter: the simple card's centre cell and its node detail.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, the schedule and `helman/get_node_detail`. What is pinned is
 * the overview (the power through the inverter, what flows into and out of
 * it, and the control tile), the plan → command → inverter chain in Technical
 * details, the mode strip, the shared disclosure contract (one open answer,
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
    /** A mode picked by hand holds: the executor skips the slot's action. */
    manualModeNow?: boolean;
    /** Helman's mode select is unavailable. */
    modeUnavailable?: boolean;
    /** The overview has no mode control. */
    noMode?: boolean;
    /** The slot in progress charges to a target the battery has reached: the executor holds it with stop discharging. */
    targetReachedNow?: boolean;
    timeZone?: string;
    /** The viewer is an admin. */
    admin?: boolean;
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
            "select.helman_inverter_mode": s(v.modeUnavailable ? "unavailable" : v.targetReachedNow ? "stop_discharging" : "normal", undefined, { friendly_name: "Helman inverter mode" }),
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
            mode: v.noMode ? null : { entityId: "select.helman_inverter_mode", actionOptions: Object.fromEntries(kinds.map((k) => [k, k])) },
            entities,
            maxAllowedExportPower: 9900,
            agreement: profile
                ? { status: v.agreement ?? "match", reason: v.agreement === "unknown" ? "unavailable" : null, commanded: v.targetReachedNow ? "stop_discharging" : "normal", observedOption: v.agreement === "mismatch" ? null : v.targetReachedNow ? "stop_discharging" : "normal",
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
            if ((v.plannedChargeNow || v.targetReachedNow || v.manualModeNow) && hour < 14) action = { kind: "charge_to_target_soc", targetSoc: 80, setBy: "automation" };
            if (v.userOverrideNow && hour < 14) action = { kind: "normal", setBy: "user" };
            slots.push({ id, controllables: action ? { inverter: action } : {} });
        }
        const schedule: SchedulePayload = {
            ...scheduleDefaults,
            executionEnabled: v.executionEnabled !== false,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: v.manualModeNow
                    ? { actionKind: "noop", outcome: "skipped", executedAction: { kind: "charge_to_target_soc", targetSoc: 80 }, reason: "manual_mode" }
                    : { actionKind: "apply", outcome: v.runtimeFailed ? "failed" : "success", executedAction: { kind: v.targetReachedNow ? "stop_discharging" : "normal" }, reason: v.targetReachedNow ? "target_soc_reached" : "scheduled" } },
            },
        };
        window.__modesFail = !!v.modesFail;
        window.__overview = overview;
        window.__modesCalls = 0;
        window.__dataChanged = [];
        window.__InverterHass = window.__configureNodeDetail({
            states, tree, overviews: { inverter: overview }, sections: { inverter: { modes, temperature: section } }, schedule,
            timeZone: v.timeZone,
            hass: { ...(v.admin ? { user: { is_admin: true } } : {}), connection: { subscribeMessage: async (listener: (event: unknown) => void, request: { type: string }) => {
                if (request.type === "helman/subscribe_updates") window.__dataChanged.push(listener);
                return () => undefined;
            } } },
            replies: {
                "helman/get_appliances": { appliances: [{ id: "inverter", name: "Inverter", kind: "inverter", primaryEntityId: "select.helman_inverter_mode", supportsAuthoring: true, normalState: "normal", actionOptions: { normal: "normal", stop_export: "stop_export" } }] },
                "helman/set_schedule": () => schedule,
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

/** The chain, in Technical details: an admin's, opened. */
async function openChain(page: Page) {
    await page.locator(".inverter-cell").click();
    const section = content(page).locator("helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-chain]")).toBeVisible();
    return section;
}

/** Each pill of a gauge: its figure, in the gauge's fixed order. */
const pills = (page: Page, gauge: "into" | "out") => content(page).locator(`helman-flow-gauge[data-gauge=${gauge}] .pill`).evaluateAll((buttons) =>
    buttons.map((button) => [button.querySelector("ha-icon")!.getAttribute("icon"), (button.querySelector(".gauge-figure") as HTMLElement).innerText]));

test("inverter Overview: the power headline with its load, the gauges into and out of it, then the control tile; the chain is not on it", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    const c = content(page);
    const overview = c.locator("[data-overview]");
    await expect(overview).toBeVisible();
    await expect(c.locator("helman-detail-headline")).toContainText("3.5 kW");
    await expect(c.locator("helman-detail-headline")).toContainText("throughput now");
    await expect(c.locator("helman-detail-headline")).toContainText("35 % of 10.0 kW");
    expect(await overview.evaluate((el) => Array.from(el.children).map((child) => child.getAttribute("data-gauge") ?? child.tagName.toLowerCase())))
        .toEqual(["helman-detail-headline", "into", "out", "helman-control-tile"]);
    await expect(c.locator("helman-flow-gauge[data-gauge=into] .gauge-title")).toContainText("Coming from");
    await expect(c.locator("helman-flow-gauge[data-gauge=out] .gauge-title")).toContainText("Going to");
    const reports = c.locator("helman-control-tile [data-inverter-reports] > span");
    await expect(reports).toHaveText(["Inverter reports", "Normal ✓"]);
    await expect(overview.locator("[data-chain], [data-verdict], [data-output]")).toHaveCount(0);
});

test("inverter gauges: into it from solar, the battery and the grid's charge; out of it to the house, the battery and the grid", async ({ page }) => {
    // Solar covers the house and charges the battery with the rest; the grid charges what solar does not cover.
    await mount(page, { solar: "2000", house: "1500", battery: "1000", grid: "500" });
    await page.locator(".inverter-cell").click();
    expect(await pills(page, "into")).toEqual([
        ["mdi:white-balance-sunny", "2.0 kW 80 %"], ["mdi:battery", "0 W"], ["mdi:transmission-tower", "500 W 20 %"],
    ]);
    expect(await pills(page, "out")).toEqual([
        ["mdi:home", "1.5 kW 60 %"], ["mdi:battery", "1.0 kW 40 %"], ["mdi:transmission-tower", "0 W"],
    ]);
});

test("inverter gauges: a discharging battery flows in, and what the house does not use flows out to the grid", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    expect(await pills(page, "into")).toEqual([
        ["mdi:white-balance-sunny", "4.2 kW 89 %"], ["mdi:battery", "500 W 11 %"], ["mdi:transmission-tower", "0 W"],
    ]);
    expect(await pills(page, "out")).toEqual([
        ["mdi:home", "1.2 kW 26 %"], ["mdi:battery", "0 W"], ["mdi:transmission-tower", "3.5 kW 74 %"],
    ]);
});

test("inverter reports a mismatch with a cross in the control tile", async ({ page }) => {
    await mount(page, { agreement: "mismatch" });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("helman-control-tile [data-inverter-reports] > span").last()).toHaveText("another mode ✗");
    await expect(content(page).locator("helman-control-tile [data-inverter-reports] .differs")).toHaveCount(1);
});

/** The simple card's day editor, as Override opens it over the detail. */
const editor = (page: Page) => page.locator("scheduling-entity-day-editor");
const editorState = (page: Page) => page.evaluate(async () => {
    const host = document.querySelector("helman-simple-card")!.shadowRoot!.querySelector("scheduling-day-editor-host") as any;
    await host.updateComplete;
    const editor = host.shadowRoot.querySelector("scheduling-entity-day-editor") as any;
    return { open: editor?.open === true, selected: editor?._selectedLaneKey ?? null, single: editor?.single === true };
});

test("the control tile's Override opens the editor on the inverter alone and saves a claimed hour", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    await content(page).locator("helman-control-tile [data-override]").click();
    await expect.poll(() => editorState(page)).toEqual({ open: true, selected: "inverter", single: true });
    await expect.poll(() => editor(page).locator("ha-dialog").evaluate((dialog: any) => dialog.heading)).toBe("Schedule · Inverter");
    await expect(editor(page).locator("scheduling-entity-day-band .lane")).toHaveCount(1);
    await editor(page).locator('.edit-panel [data-start-pick="plus_1h"]').click();
    await editor(page).locator("ha-button[slot=primaryAction]").click();
    await expect.poll(() => editorState(page).then((state) => state.open)).toBe(false);
    await expect(content(page)).toBeVisible();
    const writes = await page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/set_schedule").map((r) => r.slots));
    // From the slot in progress, holding what the automation has it doing, each slot claimed by the user.
    expect(writes).toEqual([["12:00", "12:15", "12:30", "12:45"].map((time) => ({
        id: `2026-10-21T${time}:00+00:00`, controllables: { inverter: { kind: "normal" } },
    }))]);
});

test("Back closes the Overview's override and keeps the inverter detail", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    await content(page).locator("helman-control-tile [data-override]").click();
    await expect.poll(() => editorState(page).then((state) => state.open)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.history.state?.__helmanEntityScheduleDialogId)).toBeTruthy();
    await page.evaluate(() => window.history.back());
    await expect.poll(() => editorState(page).then((state) => state.open)).toBe(false);
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

test("inverter Technical details: the chain above the registers, its verdict agreeing", async ({ page }) => {
    await mount(page, { profile: true, agreement: "match", admin: true });
    const section = await openChain(page);
    await expect(section.locator("[data-chain] [data-box]")).toHaveCount(3);
    await expect(section.locator("[data-verdict]")).toContainText("Everything agrees");
    expect(await section.locator("[data-chain], [data-registers]").evaluateAll((els) => els.map((el) => el.hasAttribute("data-chain") ? "chain" : "registers"))).toEqual(["chain", "registers"]);
});

test("inverter does not claim agreement when the plan differs from the last command", async ({ page }) => {
    await mount(page, { plannedChargeNow: true, admin: true });
    await openChain(page);
    await expect(content(page).locator("[data-verdict]")).toContainText("last command differs from the plan");
});

test("inverter verdict says a hand-picked mode holds instead of a plan mismatch", async ({ page }) => {
    await mount(page, { manualModeNow: true, admin: true });
    await openChain(page);
    const verdict = content(page).locator("[data-verdict]");
    await expect(verdict).toContainText("Set by hand — kept until Helman's next planned window");
    await expect(verdict).not.toContainText("last command differs from the plan");
});

test("inverter control tile's mode dropdown lists the configured modes, the commanded one picked, and a pick sets the mode", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    const picker = content(page).locator("helman-control-tile [data-mode-picker]");
    await expect(picker.locator(".segments")).toHaveCount(0);
    const select = picker.locator("ha-select");
    await expect(select.locator("[data-label]")).toHaveText("Mode");
    await expect(select.locator("[data-item]")).toHaveText(["Normal", "No charging", "No discharging", "Charging", "Discharging", "No export"]);
    await expect(select).toHaveJSProperty("value", "normal");
    await expect(select.locator("[data-value]")).toHaveText("Normal");
    await expect(select).toHaveJSProperty("disabled", false);

    await select.locator("[data-item=stop_export]").click();
    await expect.poll(() => page.evaluate(() => window.__InverterRequests.filter((r) => r.type === "call_service"))).toEqual([
        { type: "call_service", domain: "select", service: "select_option", service_data: { entity_id: "select.helman_inverter_mode", option: "stop_export" } },
    ]);
});

test("inverter control tile's mode dropdown is disabled while the mode control is unreadable", async ({ page }) => {
    await mount(page, { modeUnavailable: true });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-mode-picker] ha-select")).toHaveJSProperty("disabled", true);
});

test("inverter Overview has no mode picker without a mode control", async ({ page }) => {
    await mount(page, { noMode: true });
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("helman-control-tile [data-inverter-reports]")).toBeVisible();
    await expect(content(page).locator("[data-mode-picker]")).toHaveCount(0);
});

test("inverter agrees when a charge to target holds the battery at its reached target", async ({ page }) => {
    await mount(page, { targetReachedNow: true, admin: true });
    const c = await openChain(page);
    await expect(c.locator("[data-verdict]")).toContainText("Everything agrees");
    await expect(c.locator("[data-verdict]")).not.toContainText("Not applied");
    await expect(c.locator("[data-box=plan]")).toContainText("Target SoC reached");
});

test("inverter reports disabled execution in its verdict", async ({ page }) => {
    await mount(page, { executionEnabled: false, admin: true });
    await openChain(page);
    await expect(content(page).locator("[data-verdict]")).toContainText("execution off");
});

test("inverter candidate is judged by its effective normal action", async ({ page }) => {
    await mount(page, { candidateNow: true, admin: true });
    await openChain(page);
    await expect(content(page).locator("[data-verdict]")).toContainText("Everything agrees");
});

test("inverter does not claim agreement when the current command failed", async ({ page }) => {
    await mount(page, { runtimeFailed: true, admin: true });
    await openChain(page);
    await expect(content(page).locator("[data-verdict]")).toContainText("scheduled command failed");
});

test("inverter Schedule does not promise an unmet discharge candidate", async ({ page }) => {
    await mount(page, { noCharge: true });
    await page.locator(".inverter-cell").click();
    await expect(page.locator("node-detail-dialog helman-detail-section[data-schedule] [slot=summary]"))
        .toContainText("Nothing planned");
});


test("inverter Schedule strip draws the observed modes before now and the plan after it, in two rows", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    await page.locator("node-detail-dialog helman-detail-section[data-schedule] button").first().click();
    const control = page.locator("helman-node-control");
    await expect(control.locator("[data-strip-title]")).toHaveText("Modes · today → tomorrow noon");
    const strip = control.locator("helman-mode-strip");
    const happened = strip.locator("[data-row=happened] [data-segment]");
    const planned = strip.locator("[data-row=planned] [data-segment]");
    // The recorded stretches, the Modbus blip a gap, the mode still held running to now.
    await expect(happened).toHaveCount(3);
    expect(await happened.evaluateAll((segments) => segments.map((s) => [s.getAttribute("data-tone"), s.getAttribute("data-planned")])))
        .toEqual([["normal", "false"], ["charge", "false"], ["normal", "false"]]);
    await expect(happened.last()).toHaveAttribute("data-end", String(Date.parse("2026-10-21T12:00:00Z")));
    // The plan from now on, the unmet discharge dashed and neutral.
    await expect(planned.first()).toHaveAttribute("data-start", String(Date.parse("2026-10-21T12:00:00Z")));
    expect(await planned.evaluateAll((segments) => segments.map((s) => [s.getAttribute("data-tone"), s.getAttribute("data-candidate")])))
        .toEqual([["normal", "false"], ["charge", "false"], ["normal", "false"], ["neutral", "true"], ["normal", "false"]]);
    // Observed and planned modes by the same names, each named once.
    expect(await strip.locator("[data-legend-entry]").allInnerTexts()).toEqual(["Normal", "Charging", "Discharging · candidate"]);
    await expect(control.locator("[data-history-note]")).toHaveCount(0);
    // Today and tomorrow's changes: who set each, a candidate as its range.
    const rows = control.locator("[data-change-row]");
    expect(await rows.allInnerTexts()).toEqual([
        "14:00 Charge to 80 %\nHelman's schedule",
        "16:00 Normal\ndefault",
        "18:00–19:00 Discharge to 30 %\ncandidate",
        "19:00 Normal\ndefault",
    ]);
});

test("inverter Schedule says why nothing happened is drawn, and a failed read is tried again", async ({ page }) => {
    const openSchedule = async () => {
        await page.locator(".inverter-cell").click();
        await page.locator("node-detail-dialog helman-detail-section[data-schedule] button").first().click();
    };
    const note = page.locator("helman-node-control [data-history-note]");
    await mount(page, { modesFail: true });
    await openSchedule();
    await expect(note).toContainText("Today's modes could not be read.");
    await page.evaluate(() => { window.__modesFail = false; });
    await note.locator("[data-history-retry]").click();
    await expect(note).toHaveCount(0);
    await expect(page.locator("helman-node-control helman-mode-strip [data-row=happened] [data-segment]")).toHaveCount(3);

    await mount(page, { modesNull: true });
    await openSchedule();
    await expect(note).toHaveText("Not every mode register of the profile is found, so today's modes can't be read: only the plan is drawn.");

    await mount(page, { profile: false });
    await openSchedule();
    await expect(note).toHaveText("A Custom inverter has no mode registers to read: only the plan is drawn.");
});

test("inverter has a Schedule but no Forecast section: its future is its schedule", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
    await expect(content(page).locator("helman-detail-section[data-schedule]")).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(content(page).locator("helman-detail-section[data-forecast]")).toHaveCount(0);
});

// History & statistics, Technical details -------------------------------------

test("inverter History header gives today's temperature range, collapsed; the body has the chart, the link and the limits", async ({ page }) => {
    await mount(page, { linkRate: "97.46" });
    await page.locator(".inverter-cell").click();
    const section = content(page).locator("helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("38–49 °C today");
    await expect(section.locator("[slot=summary] b")).toHaveText("38–49 °C");
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=temperature] .value")).toHaveText("38–49 °C");
    await expect(section.locator("helman-day-line-chart[data-temperature-chart] [data-now]")).toHaveCount(1);
    await expect(section.locator("[data-row=link] .value")).toHaveText("97.4 % · link unreliable");
    await expect(section.locator("[data-row=export-limit] .value")).toHaveText("up to 9.9 kW");
    await expect(section.locator("[data-row=solar-input] .value")).toHaveText("not limited");
    await expect(section.locator("[data-row=soc-range] .value")).toHaveText("10–100 %");
});

test("inverter History's temperature chart opens HA's history of the temperature", async ({ page }) => {
    await onDashboard(page);
    await mount(page);
    await page.locator(".inverter-cell").click();
    const section = content(page).locator("helman-detail-section[data-history]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-forecast-pointer]")).toHaveCount(0);
    await expectShowMore(page, section.locator("[data-show-more]"), ["sensor.solax_inverter_temperature"]);
});

test("inverter Technical details shows the registers, the executor and the entities list to an admin", async ({ page }) => {
    await mount(page, { admin: true });
    await page.locator(".inverter-cell").click();
    const section = content(page).locator("helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-registers] tbody tr")).toHaveCount(2);
    await expect(section.locator("[data-row=executor] .value")).toContainText("Applied");
    await expect(section.locator("[data-row=last-command] .value")).toContainText("Normal");
    for (const id of [
        "select.solax_charger_use_mode",
        "select.solax_manual_mode_select",
        "select.solax_remotecontrol_power_control",
        "select.solax_remotecontrol_power_control_mode",
        "sensor.solax_inverter_communication_success_rate",
        "sensor.solax_inverter_communication_quarantined_registers",
    ]) {
        await expect(section.locator(`[data-entities] [data-entity="${id}"]`)).toHaveCount(1);
    }
    await expect(section.locator("[data-row=use_mode], [data-row=manual_mode], [data-row=link_success_rate]")).toHaveCount(0);
});

test("inverter Technical details is not rendered for a non-admin", async ({ page }) => {
    await mount(page);
    await page.locator(".inverter-cell").click();
    await expect(content(page).locator("helman-detail-section[data-history]")).toHaveCount(1);
    await expect(content(page).locator("helman-detail-section[data-technical]")).toHaveCount(0);
});
