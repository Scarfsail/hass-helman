import { prepareNodeDetailPage, mountSimpleCard, treeNode, liveFigures } from "./support/node-detail-harness";
import { energyFields, scheduleSlots, treePayload } from "./support/payload-builders";
import type { EvChargerUseMode, ScheduleControllableActionsDTO, SchedulePayload, ScheduleSlotDTO, TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The EV charger detail, opened from the charger's name on the power card.
 *
 * Mounted on the real `helman-card` against a fake backend that answers the
 * device tree, the appliance roster, `helman/get_node_detail` (the charger's
 * overview and its today and segment sections), the schedule and the
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
    todayFails?: boolean;
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
                        id: variant.evNode === "meterless" ? "garage-ev" : "sensor.ev_energy",
                        displayName: "Garage EV", powerSensorId: "sensor.ev_power",
                        energyEntityId: variant.evNode === "meterless" ? null : "sensor.ev_energy",
                        isEstimated: variant.evNode === "meterless",
                        controllableIds: variant.evNode === "multiple" ? ["garage-ev", "other"] : ["garage-ev"],
                        ...(variant.evNode === "missing_kind" ? {} : { applianceKind: "ev_charger" }),
                        switchEntityId: "switch.ev_charge",
                    }),
                    dto({ id: "sensor.boiler_energy", displayName: "Boiler", powerSensorId: "sensor.boiler_power", energyEntityId: "sensor.boiler_energy", controllableIds: ["boiler"] }),
                ],
            })],
            consumptionTotalSensorId: null, productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
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
            sections: ["today", "segment"],
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
            states, tree, overviews: { ev_charger: overview }, sections: { ev_charger: { today, segment } }, schedule,
            timeZone: v.timeZone,
            hass: { user: { is_admin: true } },
            replies: {
                "helman/set_schedule": schedule,
                "helman/get_appliances": appliances,
                "helman/get_appliance_projections": () => {
                    if (v.projectionFails || (window as any).__projectionDown) throw new Error("projection down");
                    return projection;
                },
                "recorder/statistic_during_period": { change: 1 },
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
                    if (msg.section === "today" && (v.todayFails || (window as any).__todayDown))
                        throw new Error("today down");
                    return msg.section ? today : overview;
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
    await expect(c.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
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
    await expect(c.locator("helman-node-flow, helman-mode-strip")).toHaveCount(0);
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
    await expect(control.locator("[data-edit-blocks]")).toBeVisible();
    await expect(control.locator("[data-change]")).toHaveText("Override…");
});
