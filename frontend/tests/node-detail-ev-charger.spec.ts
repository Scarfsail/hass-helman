import { prepareNodeDetailPage, mountSimpleCard, treeNode, liveFigures, onDashboard, expectShowMore } from "./support/node-detail-harness";
import { energyFields, scheduleSlots, treePayload } from "./support/payload-builders";
import type { EvChargerUseMode, ScheduleControllableActionsDTO, SchedulePayload, ScheduleSlotDTO, TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The EV charger detail, opened from the charger's name on the power card.
 *
 * Mounted on the real `helman-card` against a fake backend that answers the
 * device tree, the appliance roster, `helman/get_node_detail` (the charger's
 * overview and its segment section), the schedule and the
 * appliance projection.
 * What is pinned is the routing (an EV charger by its configured appliance
 * kind, every other device on the generic detail), the pictured overview
 * (the charging strip with the completion under it, the flow around the
 * car, the tiles; the charge switch is the Schedule tab's), the shared
 * disclosure contract, and the charger's truthfulness: the hardware's session counters
 * are the session and today's attribution is not, several cars with nothing
 * naming one show no car's charge, a time at current power is not a ready-by
 * time, and a projected completion counts only windows that will run, under a
 * projection computed for the slot in progress.
 *
 * The clock is fixed at 12:00 UTC; the schedule's 15-minute slots start 11:45.
 */


type Window = { from: number; to: number; candidate?: boolean; vehicleId?: string | null; useMode?: EvChargerUseMode };

type Variant = {
    profile?: boolean;
    runMode?: string;
    power?: string;
    phases?: [string, string, string];
    /** Phase readings this many seconds older than the total. */
    phasesAgeS?: number;
    /** Phase values unchanged for this many seconds, though just read again. */
    phasesHeldS?: number;
    soc?: string;
    limit?: string | null;
    /** A second configured car. */
    twoCars?: boolean;
    windows?: Window[];
    executionEnabled?: boolean;
    /** kWh the projection plans per effective slot of the 11:45 window. */
    slotKwh?: number;
    projectionGeneratedAt?: string;
    projectionEmpty?: boolean;
    projectionFails?: boolean;
    /** The projection's points for another car, which must not count. */
    otherCarPoints?: boolean;
    duration?: string;
    faultCode?: string;
    runtimeFailed?: boolean;
    overviewFails?: boolean;
    /** The charge switch's state; `null` for a charger without one configured. */
    chargeSwitch?: string | null;
    /** Home Assistant's time zone, UTC by default. */
    timeZone?: string;
    /** The profile's L3 power is not in the registry. */
    noPhase3?: boolean;
    /** The viewer is not an admin. */
    nonAdmin?: boolean;
    /** The boiler's user action from 12:00 to 13:00, another lane's override. */
    userBoiler?: boolean;
    evNode?: "meterless" | "missing_kind" | "multiple";
};

declare global {
    interface Window {
        __EvChargerHass: any;
        __EvChargerRequests: Array<{ type: string; node?: string; section?: string; device_id?: string }>;
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
        __moreInfo: string[];
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
        const dto = (overrides: Partial<TreeItemDTO>) => treeNode({ childrenFullWidth: true, ...overrides });
        const tree = treePayload({
            sources: [
                dto({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar", ...energyFields("solar") }),
                dto({ id: "battery", displayName: "Battery", powerSensorId: "sensor.battery", isSource: true, sourceType: "battery", ...energyFields("battery") }),
                dto({ id: "grid", displayName: "Grid", powerSensorId: "sensor.grid", isSource: true, sourceType: "grid", ...energyFields("grid") }),
            ],
            consumers: [dto({
                id: "house", displayName: "House", powerSensorId: "sensor.house",
                children: [
                    dto({
                        id: variant.evNode === "meterless" ? "sensor.helman_share_energy_garage_ev" : "sensor.ev_energy",
                        displayName: "Garage EV",
                        powerSensorId: variant.evNode === "meterless" ? "sensor.helman_share_power_garage_ev" : "sensor.ev_power",
                        energyEntityId: variant.evNode === "meterless" ? "sensor.helman_share_energy_garage_ev" : "sensor.ev_energy",
                        isEstimated: variant.evNode === "meterless",
                        controllableIds: variant.evNode === "multiple" ? ["garage-ev", "other"] : ["garage-ev"],
                        ...(variant.evNode === "missing_kind" ? {} : { applianceKind: "ev_charger" }),
                        switchEntityId: "switch.ev_charge",
                    }),
                    dto({ id: "sensor.boiler_energy", displayName: "Boiler", powerSensorId: "sensor.boiler_power", energyEntityId: "sensor.boiler_energy", controllableIds: ["boiler"] }),
                ],
            })],
            consumptionTotalSensorId: null, productionTotalSensorId: null,
            uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
        });
    await page.evaluate(({ v, tree, scheduleDefaults }) => {
        window.__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
        (window as any).loadCardHelpers = async () => ({ createCardElement: () => document.createElement("div") });
        customElements.define("ha-entity-toggle", class extends HTMLElement {
            set stateObj(value: any) { this.setAttribute("data-entity", value?.entity_id ?? ""); }
        });
        customElements.define("ha-state-icon", class extends HTMLElement {
            set stateObj(value: any) {
                this.setAttribute("data-entity", value?.entity_id ?? "");
                this.setAttribute("data-icon", value?.attributes?.icon ?? "");
            }
        });
        window.__moreInfo = [];
        document.addEventListener("hass-more-info", (event) => window.__moreInfo.push((event as CustomEvent).detail.entityId));
        const profile = v.profile !== false;
        const updated = "2026-10-21T11:59:50+00:00";
        const s = (value: string, unit?: string, at = updated, changedAt = at) => window.__nodeDetailState(value, unit, {}, at, changedAt);
        const phases = v.phases ?? ["2100", "2150", "2150"];
        const phaseAt = new Date(Date.parse(updated) - (v.phasesAgeS ?? 0) * 1000).toISOString();
        const phaseChangedAt = new Date(Date.parse(phaseAt) - (v.phasesHeldS ?? 0) * 1000).toISOString();
        const states: Record<string, unknown> = {
            // The house: 4.2 kW of solar and 3.8 kW from the grid.
            "sensor.solar": s("4200", "W"), "sensor.house": s("8000", "W"),
            "sensor.battery": s("0", "W"), "sensor.grid": s("3800", "W"),
            "sensor.ev_power": s(v.power ?? "6400", "W"), "sensor.ev_energy": s("9474.7", "kWh"),
            "sensor.boiler_power": s("0", "W"), "sensor.boiler_energy": s("10", "kWh"),
            "switch.ev_charge": { ...s(v.chargeSwitch ?? "on"), attributes: { icon: "mdi:ev-station" } },
            "select.ev_use_mode": s("Fast"), "select.ev_eco_gear": s("6A"),
            "sensor.kona_soc": s(v.soc ?? "50", "%"), "sensor.ioniq_soc": s("30", "%"),
        };
        if (v.limit !== null) states["number.kona_limit"] = s(v.limit ?? "80", "%");
        const entities: Record<string, string | null> = {
            power: "sensor.ev_power", energy_total: "sensor.ev_energy", charge_switch: v.chargeSwitch === null ? null : "switch.ev_charge",
            use_mode: "select.ev_use_mode", eco_gear: "select.ev_eco_gear",
        };
        const telemetry: Record<string, [string, string, string?, string?, string?]> = {
            run_mode: ["sensor.ev_run_mode", v.runMode ?? "Charging"],
            charge_mode: ["sensor.ev_charge_mode", "Fast"],
            charge_power_l1: ["sensor.ev_power_l1", phases[0], "W", phaseAt, phaseChangedAt],
            charge_power_l2: ["sensor.ev_power_l2", phases[1], "W", phaseAt, phaseChangedAt],
            charge_power_l3: ["sensor.ev_power_l3", phases[2], "W", phaseAt, phaseChangedAt],
            active_phase: ["sensor.ev_active_phase", "Three Phase"],
            session_energy: ["sensor.ev_session_energy", "9.5", "kWh"],
            session_duration: ["sensor.ev_session_duration", v.duration ?? "4388", "s"],
            green_start_power: ["sensor.ev_green_start", "2097", "W"],
            grid_power: ["sensor.ev_grid_power", "-781", "W"],
            temperature: ["sensor.ev_temperature", "27", "°C"],
            fault_code: ["sensor.ev_fault_code", v.faultCode ?? "0"],
            fault_description: ["sensor.ev_fault_description", v.faultCode && v.faultCode !== "0" ? "Over current" : "OK"],
            network_status: ["sensor.ev_network", "Not Connected"],
            firmware: ["sensor.ev_firmware", "1.14"],
            link_success_rate: ["sensor.ev_link", "98.5", "%"],
            auth_priority: ["select.ev_auth_priority", "Network Priority"],
            main_breaker_limit: ["number.ev_main_breaker", "25", "A"],
            lock: ["switch.ev_lock", "on"],
        };
        if (profile) {
            for (const [key, [entityId, state, unit, at, changedAt]] of Object.entries(telemetry)) {
                entities[key] = entityId;
                states[entityId] = s(state, unit, at, changedAt);
            }
            // Unresolved telemetry is a typed null, never dropped.
            if (v.noPhase3) entities.charge_power_l3 = null;
        }
        const kinds: Record<string, string> = { Charging: "charging", SuspendedEV: "waiting", Preparing: "waiting", Available: "no_car", Faulted: "fault" };
        const runMode = v.runMode ?? "Charging";
        const overview = {
            node: "ev_charger", deviceId: "garage-ev", asOf: "2026-10-21T12:00:00+00:00",
            profile: profile ? { id: "solax_ev_charger", label: "SolaX EV charger" } : null,
            entities,
            status: profile && kinds[runMode] ? { kind: kinds[runMode], runMode, entityId: "sensor.ev_run_mode" } : null,
            sections: ["segment"],
        };
        for (const [id, state] of Object.entries(states)) (state as any).entity_id = id;
        // Charged 08:00–09:30 this morning, and charging again since 11:20 while it charges now.
        const charging = runMode === "Charging";
        const segment = {
            node: "ev_charger", section: "segment", deviceId: "garage-ev", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" },
            chargingSince: profile && charging ? "2026-10-21T11:20:00+00:00" : null,
            charging: !profile ? null : [
                { start: "2026-10-21T08:00:00+00:00", end: "2026-10-21T09:30:00+00:00", open: false },
                ...(charging ? [{ start: "2026-10-21T11:20:00+00:00", end: "2026-10-21T12:00:00+00:00", open: true }] : []),
            ],
        };
        // The default 30 days of the charger's own energy, as `helman/get_node_history` serves it.
        const money = (amount: number, pricedKwh: number, unpricedKwh = 0) => ({ amount, pricedKwh, unpricedKwh });
        const nodeHistory = {
            id: "sensor.ev_energy", label: "Garage EV", icon: null, estimated: false, unmeasured: false, kwh: 216,
            coverage: 1, firstHour: "2026-09-22T00:00:00+00:00",
            startDate: "2026-09-22", endDate: "2026-10-21", priceUnit: "CZK/kWh", complete: false,
            navigationRange: { minDate: "2026-08-01", maxDate: "2026-10-21" },
            totals: {
                kwh: 215, sources: { solar: 109, battery: 17, grid: 82, unknown: 7 }, knownKwh: 208,
                paid: money(455, 208.1, 6.9), forgone: money(142, 200, 15), gridPaid: money(412, 79, 3),
                batteryPaid: money(43, 17), solarForgone: money(142, 96, 13), virtual: money(597, 208.1, 6.9),
            },
            activeDays: 13, coveredDays: 30, perWeek: 3, kwhPerActiveDay: 16.5,
            paidPerKwh: 2.19, gridPricePerKwh: 5.22, batteryPricePerKwh: 2.53, solarForgonePerKwh: 1.48, virtualPerKwh: 2.87,
        };
        const vehicle = (id: string, name: string, limit: boolean) => ({
            id, name,
            telemetry: { socEntityId: `sensor.${id}_soc`, ...(limit ? { chargeLimitEntityId: `number.${id}_limit` } : {}) },
            metadata: { batteryCapacityKwh: 64, maxChargingPowerKw: 11 },
        });
        // The whole roster, as `helman/get_appliances` serves it: the inverter
        // first, every entry carrying the roster fields beside its own payload.
        const appliances = {
            appliances: [
                {
                    id: "inverter", name: "Inverter", kind: "inverter", primaryEntityId: "select.inverter_mode",
                    supportsAuthoring: true, normalState: "Self Use", actionOptions: { normal: "Self Use" },
                },
                {
                    id: "garage-ev", name: "Garage EV", kind: "ev_charger",
                    primaryEntityId: "switch.ev_charge", supportsAuthoring: true, normalState: "off",
                    metadata: { icon: "mdi:car", maxChargingPowerKw: 11, scheduleCapabilities: { chargeToggle: true, useModes: ["Fast", "ECO"], ecoGears: ["6A"], requiresVehicleSelection: true } },
                    controls: { charge: { entityId: "switch.ev_charge" }, useMode: { entityId: "select.ev_use_mode" }, ecoGear: { entityId: "select.ev_eco_gear" } },
                    vehicles: [vehicle("kona", "Kona", v.limit !== null), ...(v.twoCars ? [vehicle("ioniq", "Ioniq", true)] : [])],
                },
                { id: "boiler", name: "Boiler", kind: "generic", primaryEntityId: "switch.boiler", supportsAuthoring: true, normalState: "off", metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } }, controls: { switch: { entityId: "switch.boiler" } } },
            ],
        };
        // 15-minute slots from 11:45 for a day and a half; by default a Fast
        // window in progress until 14:00 and a candidate ECO window tonight.
        const windows = v.windows ?? [
            { from: 11.75, to: 14, vehicleId: "kona", useMode: "Fast" },
            { from: 22, to: 26, candidate: true, vehicleId: "kona", useMode: "ECO" },
        ];
        const slots: ScheduleSlotDTO[] = [];
        const series = [];
        const start = Date.parse("2026-10-21T11:45:00Z");
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = 11.75 + i / 4;
            const window = windows.find((w) => hour >= w.from && hour < w.to);
            const controllables: ScheduleControllableActionsDTO = { inverter: { kind: "normal", setBy: "automation" } };
            if (v.userBoiler && hour >= 12 && hour < 13) controllables.boiler = { on: true, setBy: "user" };
            if (window) {
                controllables["garage-ev"] = {
                    charge: true, useMode: window.useMode ?? "Fast", ecoGear: "6A", setBy: "automation",
                    ...(window.vehicleId ? { vehicleId: window.vehicleId } : {}),
                    ...(window.candidate ? { conditionMet: false } : {}),
                };
                // The slot in progress is clipped at now: from 12:00 on.
                if (window.vehicleId && hour >= 12) {
                    series.push({ slotId: id, energyKwh: window.candidate ? 2.0 : v.slotKwh ?? 1.6, mode: window.useMode ?? "Fast", vehicleId: window.vehicleId, vehicleSoc: 80 });
                    if (v.otherCarPoints) series.push({ slotId: id, energyKwh: 5.0, mode: "Fast", vehicleId: "ioniq", vehicleSoc: 100 });
                }
            }
            slots.push({ id, controllables });
        }
        const schedule: SchedulePayload = {
            ...scheduleDefaults,
            executionEnabled: v.executionEnabled ?? true,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: v.runtimeFailed
                    ? { "garage-ev": { actionKind: "apply", outcome: "failed", errorCode: "write_failed", message: "the charger did not accept Start Charging" } }
                    : {},
            },
        };
        const projection = {
            generatedAt: v.projectionGeneratedAt ?? "2026-10-21T12:00:00+00:00",
            appliances: v.projectionEmpty ? {} : { "garage-ev": { series } },
        };
        window.__EvChargerHass = window.__configureNodeDetail({
            states, tree, overviews: { ev_charger: overview }, sections: { ev_charger: { segment } }, schedule,
            timeZone: v.timeZone,
            hass: { user: { is_admin: !v.nonAdmin } },
            replies: {
                "helman/set_schedule": schedule,
                "helman/get_appliances": appliances,
                "helman/get_appliance_projections": () => {
                    if (v.projectionFails || (window as any).__projectionDown) throw new Error("projection down");
                    return projection;
                },
                "helman/get_node_history": nodeHistory,
                "recorder/statistic_during_period": { change: 1 },
                // The car's SoC and the charger's power this morning, as HA's recorder has them.
                "history/history_during_period": {
                    "sensor.kona_soc": [
                        { s: "45", lu: Date.parse("2026-10-21T00:00:00Z") / 1000 }, { s: "50", lu: Date.parse("2026-10-21T09:10:00Z") / 1000 },
                    ],
                    "sensor.ev_power": [
                        { s: "0", lu: Date.parse("2026-10-21T00:00:00Z") / 1000 }, { s: "6400", lu: Date.parse("2026-10-21T11:20:00Z") / 1000 },
                    ],
                },
                "helman/get_node_detail": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                    device_id?: string;
                }) => {
                    if (v.overviewFails)
                        throw new Error("detail down");
                    if (msg.section === "segment")
                        return segment;
                    return overview;
                },
            },
        });
        window.__EvChargerRequests = window.__NodeDetailRequests;
    }, { v: variant, tree, scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page, undefined, "helman-card");
    await expect.poll(() => page.evaluate(() => window.__deepAll(document, "helman-tree-item").length)).toBeGreaterThan(1);
}

async function openDevice(page: Page, name: string): Promise<void> {
    await page.evaluate((name) => {
        const row = window.__deepAll(document, "helman-tree-item").find((candidate) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === name);
        if (!row) throw new Error(`no row named ${name}`);
        (row.shadowRoot!.querySelector(".deviceName") as HTMLElement).click();
    }, name);
}


const content = (page: Page) => page.locator("node-detail-ev-charger-content");

test("ev-charger Overview shows the P1 detail layout", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");

    const c = content(page);
    await expect(c.locator("[data-overview]")).toBeVisible();
    await expect(c.locator("helman-detail-headline")).toBeVisible();
    await expect(c.locator("helman-switch-tile")).toHaveCount(1);
    await expect(c.locator("helman-flow-gauge")).toHaveCount(1);
    await expect(c.locator("[data-car]")).toHaveCount(1);
});

test("charger gauge adds up to its headline, small shares included", async ({ page }) => {
    // 100 W on a house that 4.2 kW of solar and 3.8 kW of grid supply: shares of 52.5 and 47.5 W.
    await mount(page, { power: "100" });
    await openDevice(page, "Garage EV");
    const figures = await liveFigures(page, "node-detail-ev-charger-content", null);
    expect(figures.gauge).toBe(100);
    expect(figures.headline).toContain("100 W");
});

test("charger fault remains visible without a dead Details button", async ({ page }) => {
    await mount(page, { runMode: "Faulted", faultCode: "42" });
    await openDevice(page, "Garage EV");

    const warning = content(page).locator("[data-exception]");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Over current");
    await expect(warning.locator("button")).toHaveCount(0);
});

test("charger car tile gives the limit, needed energy and ETA", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");
    const c = content(page);
    await expect(c.locator("[data-car]")).toContainText("Kona");
    await expect(c.locator("[data-car] [data-limit-marker]")).toHaveCount(1);
    await expect(c.locator("[data-car]")).toContainText("Still needed");
    await expect(c.locator("helman-who-decides")).toBeVisible();
    await expect(c.locator("[data-overview]").locator("helman-mode-strip")).toHaveCount(0);
});

test("charger Schedule does not promise an unmet charge candidate", async ({ page }) => {
    await mount(page, { windows: [{ from: 15, to: 16, candidate: true }] });
    await openDevice(page, "Garage EV");
    await expect(page.locator("node-detail-dialog helman-detail-section[data-schedule] [slot=summary]"))
        .toContainText("Nothing planned");
});

test("charger Overview shows an unmet current candidate as idle", async ({ page }) => {
    await mount(page, { windows: [{ from: 11.75, to: 14, candidate: true }] });
    await openDevice(page, "Garage EV");
    const planned = content(page).locator("helman-who-decides .row").nth(1);
    await expect(planned.locator("span").last()).toContainText("idle until");
});

test("charger Schedule strip draws today's charging before now and the plan after it, with the changes to come", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");
    await page.locator("node-detail-dialog helman-detail-section[data-schedule] button").first().click();
    const control = page.locator("helman-node-control");
    await expect(control.locator("[data-strip-title]")).toHaveText("Today → tomorrow noon");
    const segments = control.locator("helman-mode-strip [data-segment]");
    await expect(segments).toHaveCount(4);
    expect(await segments.evaluateAll((all) => all.map((s) => [s.getAttribute("data-planned"), s.getAttribute("data-tone"), s.getAttribute("data-candidate")])))
        .toEqual([["false", "charge", "false"], ["false", "charge", "false"], ["true", "charge", "false"], ["true", "neutral", "true"]]);
    // The stretch still charging runs to now, where the plan takes over.
    await expect(segments.nth(1)).toHaveAttribute("data-end", String(Date.parse("2026-10-21T12:00:00Z")));
    expect(await control.locator("[data-change-row]").allInnerTexts()).toEqual([
        "14:00 Idle\ndefault",
        "22:00–02:00 Charging\ncandidate",
        "02:00 Idle\ndefault",
    ]);
    // What was charged and what is planned to charge are one mode, named once.
    expect(await control.locator("helman-mode-strip [data-legend-entry]").allInnerTexts()).toEqual(["Charging", "Charging · candidate"]);
    await expect(control.locator("[data-history-note]")).toHaveCount(0);
    // One button: the override is the day editor on this charger alone.
    await expect(control.locator(".actions > button")).toHaveCount(1);
    await expect(control.locator("[data-change]")).toHaveText("Override…");
});

test("charger Override opens the day editor on the charger alone, saves a claimed hour and returns to the detail", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");
    await page.locator("node-detail-dialog helman-detail-section[data-schedule] button").first().click();
    await page.locator("helman-node-control [data-change]").click();
    const editorState = () => page.evaluate(async () => {
        const host = document.querySelector("helman-card")!.shadowRoot!.querySelector("scheduling-day-editor-host") as any;
        await host.updateComplete;
        const editor = host.shadowRoot.querySelector("scheduling-entity-day-editor") as any;
        return { open: editor?.open === true, selected: editor?._selectedLaneKey ?? null, single: editor?.single === true };
    });
    await expect.poll(editorState).toEqual({ open: true, selected: "garage-ev", single: true });
    const editor = page.locator("scheduling-entity-day-editor");
    await expect.poll(() => editor.locator("ha-dialog").evaluate((dialog: any) => dialog.heading)).toBe("Schedule · Garage EV");
    await expect(editor.locator("scheduling-entity-day-band .lane")).toHaveCount(1);
    await expect(editor.locator(".edit-panel .panel-title")).toHaveCount(0);
    await editor.locator('.edit-panel [data-start-pick="plus_1h"]').click();
    await editor.locator('.edit-panel select:has(option[value="kona"])').selectOption("kona");
    await editor.locator("ha-button[slot=primaryAction]").click();
    await expect.poll(() => editorState().then((state) => state.open)).toBe(false);
    await expect(page.locator("helman-node-control")).toBeVisible();
    const writes = await page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/set_schedule").map((r) => r.slots));
    // The automation's Fast window is taken over: each slot is now the user's.
    expect(writes).toEqual([["12:00", "12:15", "12:30", "12:45"].map((time) => ({
        id: `2026-10-21T${time}:00+00:00`, controllables: { "garage-ev": { charge: true, vehicleId: "kona", useMode: "Fast" } },
    }))]);
});

// Forecast -------------------------------------------------------------------

const forecastSection = (page: Page) => content(page).locator("helman-detail-section[data-forecast]");

test("charger Forecast header names the shortfall when the plan does not reach the limit", async ({ page }) => {
    // 8 slots × 1.6 kWh from 12:00 to 14:00 bring 12.8 of the 19.2 kWh the Kona needs.
    await mount(page);
    await openDevice(page, "Garage EV");
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("6.4 kWh short of 80 % by 14:00");
    await expect(section.locator("[data-forecast-body]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=end-of-plan] .value")).toHaveText("70 %, 6.4 kWh short");
    await expect(section.locator("[data-row=candidate] .value")).toHaveText("Likely, 22:00–02:00");
    // The charger's power first, then the car's charge.
    const charts = section.locator("helman-day-line-chart");
    await expect(charts).toHaveCount(2);
    await expect(section.locator("[data-chart-title]")).toHaveText([/^Power · today → tomorrow noon/, /^Car charge · planned/]);
    await expect(charts.nth(1).locator("path.line")).toHaveCount(2);
    await expect(charts.nth(1).locator("path.line.dashed")).toHaveCount(1);
    await expect(charts.nth(1).locator(".reference-label")).toHaveText("limit 80 %");
});

test("charger Forecast draws its actual power since midnight against its planned charging", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");
    const section = forecastSection(page);
    await section.locator("button").first().click();
    const chart = section.locator("helman-day-line-chart").first();
    await expect(chart.locator("path.line")).toHaveCount(2);
    await expect(chart.locator("path.line.dashed")).toHaveCount(1);
    const series = (key: string): Promise<Array<[string, number]>> => chart.evaluate((element: any, key) => element.series.find((series: { key: string }) => series.key === key).points
        .map((point: { t: number; v: number }) => [new Date(point.t).toISOString().slice(11, 16), Math.round(point.v * 1000) / 1000]), key);
    // 6.4 kW from 11:20: a third of the 11:15 slot, the whole 11:30 and 11:45 slots; the slot in progress has not started.
    await expect.poll(async () => (await series("actual")).slice(-3)).toEqual([["11:15", 4.267], ["11:30", 6.4], ["11:45", 6.4]]);
    expect((await series("actual"))[0]).toEqual(["00:00", 0]);
    // 1.6 kWh a slot is 6.4 kW until 14:00, then off.
    expect((await series("planned")).slice(0, 1)).toEqual([["12:00", 6.4]]);
    expect((await series("planned")).find(([time]) => time === "14:00")).toEqual(["14:00", 0]);
});

test("charger Forecast without a car estimate shows the power chart alone, with a consumer's summary", async ({ page }) => {
    // No charge limit: no estimate for the Kona, but the charger's plan stands,
    // 8 × 1.6 kWh to 14:00 and the candidate's 16 × 2 kWh tonight, as a device's plan counts them.
    await mount(page, { limit: null });
    await openDevice(page, "Garage EV");
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("≈ 45 kWh more by noon tomorrow");
    await section.locator("button").first().click();
    await expect(section.locator("helman-day-line-chart")).toHaveCount(1);
    await expect(section.locator("[data-chart-title]")).toHaveText([/^Power · today → tomorrow noon/]);
    await expect(section.locator("[data-row=end-of-plan]")).toHaveCount(0);
});

test("charger Forecast counts only what is left of the slot in progress", async ({ page }) => {
    await mount(page);
    // Projected at 12:00 with the 12:00 slot whole; at 12:10 a third of its 1.6 kWh is left: 11.2 + 0.53 supplied of 19.2.
    await page.clock.setFixedTime(new Date("2026-10-21T12:10:00Z"));
    await openDevice(page, "Garage EV");
    await expect(forecastSection(page).locator("[slot=summary]")).toHaveText("7.5 kWh short of 80 % by 14:00");
});

test("charger Forecast header confirms the limit is reached, and the candidate stays one", async ({ page }) => {
    // 3 kWh a slot reaches 19.2 kWh in the slot ending 13:45.
    await mount(page, { slotKwh: 3 });
    await openDevice(page, "Garage EV");
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Reaches 80 % by 13:45 ✓");
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=end-of-plan] .value")).toHaveText("80 %, limit reached");
    await expect(section.locator("[data-row=candidate] .value")).toHaveText("No, stays a candidate");
});

test("charger without a projection for its car still shows its power in Forecast, with nothing planned", async ({ page }) => {
    await mount(page, { projectionEmpty: true });
    await openDevice(page, "Garage EV");
    const section = forecastSection(page);
    await expect(section.locator("[slot=summary]")).toHaveText("Nothing planned");
    await section.locator("button").first().click();
    const chart = section.locator("helman-day-line-chart");
    await expect(chart).toHaveCount(1);
    await expect(chart.locator("path.line")).toHaveCount(1);
    await expect(chart.locator("path.line.dashed")).toHaveCount(0);
});

for (const [index, chart, entity] of [[0, "power", "sensor.ev_power"], [1, "SoC", "sensor.kona_soc"]] as const) {
    test(`charger Forecast's ${chart} chart opens HA's history of ${entity}`, async ({ page }) => {
        await onDashboard(page);
        await mount(page);
        await openDevice(page, "Garage EV");
        const section = forecastSection(page);
        await section.locator("button").first().click();
        await expect(section.locator("[data-show-more]")).toHaveCount(2);
        await expectShowMore(page, section.locator("[data-show-more]").nth(index), [entity]);
    });
}

// History & statistics, Technical details -------------------------------------

test("ev-charger History starts with a pointer that opens the Forecast chart", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");
    const history = content(page).locator("helman-detail-section[data-history]");
    await history.locator("button").first().click();
    const pointer = history.locator("[data-history-body] > :first-child");
    await expect(pointer).toHaveAttribute("data-forecast-pointer", "");
    await pointer.click();
    await expect(forecastSection(page).locator("helman-day-line-chart[data-forecast-chart]").first()).toBeInViewport();
});

test("ev-charger History has no Forecast pointer without a projection for its car", async ({ page }) => {
    await mount(page, { projectionEmpty: true });
    await openDevice(page, "Garage EV");
    await content(page).locator("helman-detail-section[data-history] button").first().click();
    await expect(content(page).locator("[data-node-history]")).toBeVisible();
    await expect(content(page).locator("[data-forecast-pointer]")).toHaveCount(0);
});

test("ev-charger History header without learned stats gives the period's kWh, collapsed; the body has no history graph and no by-source block", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
        (window as any).__chartConfigs = [];
        (window as any).loadCardHelpers = async () => ({ createCardElement: (config: unknown) => {
            (window as any).__chartConfigs.push(config);
            return document.createElement("div");
        } });
    });
    await openDevice(page, "Garage EV");
    const section = content(page).locator("helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toContainText(/^215 kWh for /);
    await expect(section.locator("[slot=summary] b")).toHaveText(["215 kWh"]);
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-node-history]")).toBeVisible();
    await expect(section.locator("[data-share-bar]")).toHaveCount(0);
    await expect(section.locator("[data-sources]")).toHaveCount(0);
    await expect(section.locator("[data-row=from-solar]")).toHaveCount(0);
    await expect(section.locator("helman-day-line-chart")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__chartConfigs)).toEqual([]);
});

test("ev-charger Technical details shows execution, the window, the projection, the link and the phase comparison to an admin", async ({ page }) => {
    await mount(page);
    await openDevice(page, "Garage EV");
    const section = content(page).locator("helman-detail-section[data-technical]");
    await expect(section.locator("[slot=summary]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=execution]")).toHaveCount(1);
    await expect(section.locator("[data-row=runtime]")).toHaveCount(1);
    await expect(section.locator("[data-row=window] .value")).toHaveText("Fast · 6A");
    await expect(section.locator('[data-entities] [data-entity="sensor.ev_charge_mode"]')).toContainText("Fast");
    await expect(section.locator("[data-row=charge_mode]")).toHaveCount(0);
    await expect(section.locator("[data-row=generated]")).toHaveCount(1);
    await expect(section.locator("[data-row=fault]")).toHaveCount(1);
    await expect(section.locator('[data-entities] [data-entity="sensor.ev_network"]')).toHaveCount(1);
    await expect(section.locator("[data-row=network_status]")).toHaveCount(0);
    await expect(section.locator("[data-row=total], [data-incomparable]")).not.toHaveCount(0);
});

test("ev-charger Technical details is not rendered for a non-admin", async ({ page }) => {
    await mount(page, { nonAdmin: true });
    await openDevice(page, "Garage EV");
    await expect(content(page).locator("helman-detail-section[data-history]")).toHaveCount(1);
    await expect(content(page).locator("helman-detail-section[data-technical]")).toHaveCount(0);
});
