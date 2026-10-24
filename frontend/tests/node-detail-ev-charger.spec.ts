import { prepareNodeDetailPage, mountSimpleCard, nodeDetailLocators, sectionRequestLog, sectionReads, expectKeepRule, treeNode, holdSection, powerTick, reconnectDetail } from "./support/node-detail-harness";
import { energyFields, scheduleSlots, treePayload } from "./support/payload-builders";
import type { EvChargerUseMode, ScheduleControllableActionsDTO, SchedulePayload, ScheduleSlotDTO, TreeItemDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import { expectReducedMotionStill } from "./support/node-flow";

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
 * car, the tiles; the charge switch is the Control tab's), the shared
 * disclosure contract, and the charger's truthfulness: the hardware's session counters
 * are the session and today's attribution is not, several cars with nothing
 * naming one show no car's charge, a time at current power is not a ready-by
 * time, and a projected completion counts only windows that will run, under a
 * projection computed for the slot in progress.
 *
 * The clock is fixed at 12:00 UTC; the schedule's 15-minute slots start 11:45.
 */

const SCREENS = process.env.SCREENS;

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
            "switch.ev_charge": s(v.chargeSwitch ?? "on"),
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

const { content, question, header, evidence, tile, flow, flowLabel } = nodeDetailLocators("ev-charger");
const overview = (page: Page) => content(page).locator("[data-overview]");
const glyph = (page: Page) => content(page).locator("helman-soc-glyph");
const strip = (page: Page) => content(page).locator("helman-mode-strip");
const tab = (page: Page, name: "overview" | "control") => page.locator(`node-detail-dialog [data-tab="${name}"]`);
// The card's own inverter overview, for its distribution row's cell, is not the detail's.
const requests = (page: Page, type: string) =>
    page.evaluate((type) => window.__EvChargerRequests.filter((r) => r.type === type && r.node !== "inverter"), type);
const sectionRequests = async (page: Page, section: string) => (await sectionRequestLog(page, "ev_charger", section)).length;

async function openCharger(page: Page, variant: Variant = {}): Promise<void> {
    await mount(page, variant);
    await openDevice(page, "Garage EV");
    await expect(overview(page)).toBeVisible();
}

/** Open a question the way a reader does: the picture that absorbed it, or its tile. */
async function open(page: Page, id: string): Promise<void> {
    if (id === "plan") await content(page).locator("[data-strip]").click();
    else if (id === "today") await flow(page).locator("[data-side='in']").click();
    else if (id === "progress") await content(page).locator("[data-glyph]").click();
    else await tile(page, id).locator("button").click();
    await expect(header(page, id)).toHaveAttribute("aria-expanded", "true");
}

async function setStates(page: Page, states: Record<string, string>): Promise<void> {
    await page.evaluate((states) => {
        const card = window.__deepAll(document, "helman-card")[0] as any;
        const hass = window.__EvChargerHass;
        const next = { ...hass.states };
        for (const [id, state] of Object.entries(states)) next[id] = { ...next[id], state };
        window.__EvChargerHass = { ...hass, states: next };
        card.hass = window.__EvChargerHass;
    }, states);
}

/** A flow label's bold value and its name. */
async function expectItem(page: Page, side: "in" | "out", id: string, value: string, name: string): Promise<void> {
    await expect(flowLabel(page, side, id).locator(".value")).toHaveText(value);
    await expect(flowLabel(page, side, id).locator(".name")).toHaveText(name);
}

/** The strip's segments as drawn: tone, whether planned, and the UTC times they span. */
async function segments(page: Page): Promise<Array<{ tone: string; planned: string; from: string; to: string }>> {
    return strip(page).locator("[data-segment]").evaluateAll((nodes) => nodes.map((node) => ({
        tone: node.getAttribute("data-tone")!,
        planned: node.getAttribute("data-planned")!,
        from: new Date(Number(node.getAttribute("data-start"))).toISOString().slice(11, 16),
        to: new Date(Number(node.getAttribute("data-end"))).toISOString().slice(11, 16),
    })));
}

test.describe("routing", () => {
    test("an EV charger opens its own detail by its appliance kind, with its device id", async ({ page }) => {
        await openCharger(page);
        await expect(page.locator("node-detail-device-content")).toHaveCount(0);
        const detail = (await requests(page, "helman/get_node_detail"))[0];
        expect(detail).toEqual({ type: "helman/get_node_detail", node: "ev_charger", section: undefined, device_id: "garage-ev" });
    });

    test("a schedulable device of another kind keeps the generic detail", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Boiler");
        await expect(page.locator("node-detail-device-content")).toHaveCount(1);
        await expect(content(page)).toHaveCount(0);
        expect(await requests(page, "helman/get_node_detail")).toEqual([]);
        expect(await requests(page, "helman/get_appliances")).toHaveLength(1); // generic schedule data
    });

    test("a meterless EV child opens charger detail from its own kind", async ({ page }) => {
        await mount(page, { evNode: "meterless" });
        await openDevice(page, "Garage EV");
        await expect(content(page)).toHaveCount(1);
        expect((await requests(page, "helman/get_node_detail"))[0].device_id).toBe("garage-ev");
        // The charger itself reads its roster once for vehicle metadata.
        expect(await requests(page, "helman/get_appliances")).toHaveLength(1);
    });

    for (const evNode of ["missing_kind", "multiple"] as const) {
        test(`${evNode} uses generic detail without a classification request`, async ({ page }) => {
            await mount(page, { evNode });
            await openDevice(page, "Garage EV");
            await expect(page.locator("node-detail-device-content")).toHaveCount(1);
            expect(await requests(page, "helman/get_node_detail")).toEqual([]);
            // The generic detail still reads the roster for its schedule; routing adds no second read.
            expect(await requests(page, "helman/get_appliances")).toHaveLength(1);
        });
    }
});

test.describe("the overview", () => {
    test("opens on a status pill, the strip, the Now flow around the car and three closed tiles", async ({ page }) => {
        await openCharger(page);
        await expect(overview(page).locator(".status")).toHaveText("Charging at 6.4 kW.");
        await expect(overview(page).locator(".status")).toHaveAttribute("data-tone", "charge");
        await expect(strip(page)).toBeVisible();
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
        // 30 % of a 64 kWh battery at 6.4 kW: three hours, at current power, not a ready-by time.
        await expect(content(page).locator("[data-estimate]")).toHaveText("≈ 3 h 0 min to 80 % at current power");

        const ids = await content(page).locator("helman-node-tile").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["progress", "waiting", "trust"]);
        for (const id of ids) await expect(tile(page, id!).locator("button")).toHaveAttribute("aria-expanded", "false");
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        // The strip and its completion line are read on opening; today's attribution is not.
        await expect.poll(() => sectionRequests(page, "segment")).toBe(1);
        expect(await requests(page, "helman/get_appliance_projections")).toHaveLength(1);
        expect(await sectionRequests(page, "today")).toBe(0);
    });

    test("tiles say the answer: the session, charging since when, the total against its phases", async ({ page }) => {
        await openCharger(page);
        await expect(tile(page, "progress").locator(".value")).toHaveText("9.5 kWh");
        await expect(tile(page, "progress").locator(".detail")).toHaveText("this session, 1 h 13 min");
        await expect(tile(page, "waiting").locator(".value")).toHaveText("Charging");
        await expect(tile(page, "waiting").locator(".detail")).toHaveText("from 11:20");
        await expect(tile(page, "waiting").locator("button")).toHaveClass(/action-tone-charge/);
        await expect(tile(page, "waiting").locator(".caption")).toHaveText("Why isn't it charging?");
        await expect(tile(page, "trust").locator(".value")).toHaveText("6.4 kW");
        await expect(tile(page, "trust").locator(".detail")).toHaveText("phases 6.4 kW");
    });

    test("answer previews say the answer", async ({ page }) => {
        await openCharger(page);
        await open(page, "progress");
        await expect(question(page, "progress").locator(".preview")).toHaveText("9.5 kWh this session · 19 kWh still needed");
        await open(page, "plan");
        await expect(question(page, "plan").locator(".preview")).toHaveText("Next charging window: now–14:00");
        await open(page, "waiting");
        await expect(question(page, "waiting").locator(".preview")).toHaveText("It is charging now");
        await open(page, "trust");
        await expect(question(page, "trust").locator(".preview")).toHaveText("network Not Connected · total vs phases differ by 0 W");
    });

    test("an explicit fault is the one exception, linked to the readings answer, and comes before any waiting explanation", async ({ page }) => {
        await openCharger(page, { runMode: "Faulted", faultCode: "12", power: "0", windows: [{ from: 22, to: 26, vehicleId: "kona" }] });
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("The charger reports a fault: Faulted · Over current · code 12.");
        await expect(tile(page, "waiting").locator(".value")).toHaveText("Fault");
        await expect(tile(page, "waiting").locator("button")).toHaveClass(/action-tone-stop/);
        await open(page, "waiting");
        await expect(question(page, "waiting").locator("[data-waiting='fault']")).toBeVisible();
        await expect(question(page, "waiting")).not.toContainText("next window");
        await exception.locator("button").click();
        await expect(header(page, "trust")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "trust").locator("[data-row='fault']")).toContainText("code 12");
    });

    test("a fault code left over while charging is a reading, not a fault", async ({ page }) => {
        await openCharger(page, { faultCode: "12" });
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await expect(tile(page, "waiting").locator(".value")).toHaveText("Charging");
        await open(page, "trust");
        await evidence(page, "trust").click();
        await expect(question(page, "trust").locator("[data-row='fault_code']")).toContainText("12");
    });

    test("no car connected: no session in progress and no estimate", async ({ page }) => {
        await openCharger(page, { runMode: "Available", power: "0" });
        await expect(overview(page).locator(".status")).toHaveText("No car connected (Available).");
        await expect(tile(page, "progress").locator(".value")).toHaveText("No car connected");
        await expect(content(page).locator("[data-estimate]")).toHaveCount(0);
        await open(page, "progress");
        await expect(question(page, "progress").locator("[data-no-session]")).toBeVisible();
        await expect(question(page, "progress")).toContainText("Last reported session");
        await expect(question(page, "progress").locator("[data-row='eta']")).toHaveCount(0);
    });
});

test.describe("the charge switch", () => {
    test("is not on the overview: the Control tab drives the charger's lane, never a direct toggle", async ({ page }) => {
        await openCharger(page);
        await expect(content(page).locator("[data-switch]")).toHaveCount(0);
        await expect(page.locator("node-detail-dialog ha-entity-toggle")).toHaveCount(0);
        await expect(strip(page)).toBeVisible();

        await tab(page, "control").click();
        await expect(content(page)).toHaveCount(0);
        const control = page.locator("helman-node-control");
        await expect(control).toHaveCount(1);
        await expect(control.locator("[data-control]")).toHaveAttribute("data-control", "garage-ev");
        await expect(page.locator("helman-device-direct-control")).toHaveCount(0);
        await expect(page.locator("node-detail-dialog ha-entity-toggle")).toHaveCount(0);
    });

    test("an override writes the charger's lane through its own editor, keeping the boiler's user action", async ({ page }) => {
        await openCharger(page, { userBoiler: true });
        await tab(page, "control").click();
        await page.locator("helman-node-control [data-change]").click();
        const dialog = page.locator("control-override-dialog");
        await dialog.locator('label:has(input[value="off"])').click();
        await dialog.locator('[data-pick="plus_1h"]').click();
        await dialog.locator("[data-save]").click();
        await expect(dialog).toHaveCount(0);
        const slots = await page.evaluate(() => window.__EvChargerRequests.filter((r) => r.type === "helman/set_schedule").map((r) => (r as any).slots));
        expect(slots).toEqual([["12:00", "12:15", "12:30", "12:45"].map((time) => ({
            id: `2026-10-21T${time}:00+00:00`,
            controllables: { "garage-ev": { charge: false }, boiler: { on: true } },
        }))]);
    });
});

test.describe("the charging strip", () => {
    test("charging so far solid, the planned windows hatched, the next change flagged, and the completion under it", async ({ page }) => {
        await openCharger(page);
        expect(await segments(page)).toEqual([
            { tone: "charge", planned: "false", from: "08:00", to: "09:30" },
            // The stretch still going is drawn to now.
            { tone: "charge", planned: "false", from: "11:20", to: "12:00" },
            // The window in progress, from now; the candidate tonight is not executed.
            { tone: "charge", planned: "true", from: "12:00", to: "14:00" },
            { tone: "neutral", planned: "true", from: "22:00", to: "02:00" },
        ]);
        const next = strip(page).locator("[data-next-change]");
        await expect(next).toHaveText("14:00 · stops charging");
        await expect(next).toHaveAttribute("data-tone", "stop");
        await expect(strip(page).locator("[data-now]")).toHaveCount(1);
        // 8 slots × 1.6 kWh = 12.8 kWh of 19.2 needed.
        await expect(content(page).locator("[data-completion-line]")).toHaveText(
            "Under the current plan ≈ 70 % of 80 % by 14:00, 6.4 kWh short: an estimate, not a guarantee.");
        // The strip opens the plan.
        await expect(content(page).locator("[data-strip]")).toHaveAttribute("title", "When will charging happen, and will it reach the target?");
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-window]")).toHaveCount(2);
    });

    test("the completion line names when the limit is reached", async ({ page }) => {
        await openCharger(page, { slotKwh: 2.4 });
        await expect(content(page).locator("[data-completion-line]")).toHaveText(
            "Under the current plan ≈ 80 % by 14:00: an estimate, not a guarantee.");
    });

    test("waiting for tonight: no charging now, the next start flagged in the charge tone", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", windows: [{ from: 22, to: 26, vehicleId: "kona" }] });
        expect(await segments(page)).toEqual([
            { tone: "charge", planned: "false", from: "08:00", to: "09:30" },
            { tone: "charge", planned: "true", from: "22:00", to: "02:00" },
        ]);
        await expect(strip(page).locator("[data-next-change]")).toHaveText("22:00 · starts charging");
        await expect(strip(page).locator("[data-next-change]")).toHaveAttribute("data-tone", "charge");
    });

    test("adjacent planned windows are one stretch: charging stops where the last ends", async ({ page }) => {
        await openCharger(page, { windows: [
            { from: 11.75, to: 13, vehicleId: "kona", useMode: "Fast" },
            { from: 13, to: 14.5, vehicleId: "kona", useMode: "ECO" },
        ] });
        await expect(strip(page).locator("[data-next-change]")).toHaveText("14:30 · stops charging");
    });

    test("a candidate is not executed: it is not a plan change", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", windows: [{ from: 22, to: 26, candidate: true, vehicleId: "kona" }] });
        await expect(strip(page)).toBeVisible();
        await expect(strip(page).locator("[data-next-change]")).toHaveCount(0);
    });

    test("a completion that cannot be estimated says why on the line", async ({ page }) => {
        await openCharger(page, { executionEnabled: false });
        await expect(content(page).locator("[data-completion-line]")).toHaveText("Schedule execution is off, so the plan does not establish a completion.");
        // Not executed: every window is neutral.
        expect((await segments(page)).filter((segment) => segment.planned === "true").map((segment) => segment.tone)).toEqual(["neutral", "neutral"]);
    });

    test("a Custom charger has no recorded charging, only the plan", async ({ page }) => {
        await openCharger(page, { profile: false });
        expect((await segments(page)).every((segment) => segment.planned === "true")).toBe(true);
    });
});

test.describe("the strip in Home Assistant's time zone", () => {
    test.use({ timezoneId: "America/New_York" });

    test("midnight to noon tomorrow and the hours are Home Assistant's, not the browser's", async ({ page }) => {
        // 12:00 UTC is 14:00 in Prague: the strip runs from Prague's midnight, 22:00 UTC, for 36 h.
        await openCharger(page, { timeZone: "Europe/Prague" });
        const ticks = strip(page).locator(".hours span");
        await expect(ticks.first()).toHaveText("00");
        await expect(ticks.first()).toHaveAttribute("style", /left: 0\.00%/);
        await expect(ticks.nth(1)).toHaveText("06");
        await expect(ticks.nth(1)).toHaveAttribute("style", /left: 16\.67%/);
        await expect(ticks.last()).toHaveText("12");
        await expect(ticks.last()).toHaveAttribute("style", /left: 100\.00%/);
        // Now, 14 h into the 36.
        await expect(strip(page).locator("[data-now] line")).toHaveAttribute("x1", "389");
        // This morning's 08:00 UTC charging, 10 h after Prague's midnight.
        await expect(strip(page).locator("[data-segment]").first()).toHaveAttribute("style", /left: 27\.78%/);
    });
});

test.describe("the flow", () => {
    test("Now: the house's live mix applied to the charger in, an estimate said as one; its phases out in the phase colours", async ({ page }) => {
        await openCharger(page);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Now · 12:00");
        // 6.4 kW of the house's 4.2 kW solar and 3.8 kW grid.
        await expectItem(page, "in", "solar", "3.4 kW", "Solar");
        await expectItem(page, "in", "grid", "3.0 kW", "Grid");
        await expect(flowLabel(page, "in", "battery")).toHaveClass(/none/);
        await expect(flow(page).locator("[data-flow-note]")).toHaveText("Sources are the house's mix now, applied to the charger: an estimate.");
        await expectItem(page, "out", "phase-1", "2.1 kW", "L1");
        await expect(flow(page).locator("[data-side='out'] [data-ribbon]")).toHaveCount(3);
        await expect(flow(page).locator("[data-ribbon='phase-2']")).toHaveAttribute("style", /--helman-phase-l2/);
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 6.4 kW");
    });

    test("single-phase charging draws one phase ribbon", async ({ page }) => {
        await openCharger(page, { phases: ["6400", "0", "0"] });
        await expect(flow(page).locator("[data-side='out'] [data-ribbon]")).toHaveCount(1);
        await expect(flow(page).locator("[data-side='out'] [data-ribbon]")).toHaveAttribute("data-ribbon", "phase-1");
        // The idle phases stay as greyed labels, so the layout never moves.
        await expect(flowLabel(page, "out", "phase-2")).toHaveClass(/none/);
        await expect(flowLabel(page, "out", "phase-3")).toHaveClass(/none/);
    });

    test("the car is the SoC glyph: the limit as its max, no min marker, still while not charging", async ({ page }) => {
        await openCharger(page);
        await expect(glyph(page).locator("[data-soc-text]")).toHaveText("50 %");
        await expect(glyph(page).locator("[data-marker='max']")).toHaveAttribute("data-soc", "80");
        await expect(glyph(page).locator("[data-marker-label='max']")).toContainText("limit 80 %");
        await expect(glyph(page).locator("[data-marker='min']")).toHaveCount(0);
        // 30 % of 64 kWh still to the limit.
        await expect(glyph(page).locator("[data-room]")).toHaveText("19 kWh");
        await expect(glyph(page).locator("[data-chevrons]")).toHaveAttribute("data-chevrons", "charge");
        // The car opens the progress.
        await open(page, "progress");
    });

    test("a car plugged in but not charging is drawn still", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0" });
        await expect(glyph(page).locator("[data-chevrons]")).toHaveAttribute("data-chevrons", "idle");
    });

    test("several cars and nothing naming one: the car is drawn empty, never another car's charge", async ({ page }) => {
        await openCharger(page, { twoCars: true, windows: [{ from: 22, to: 26, vehicleId: "ioniq" }] });
        await expect(glyph(page).locator("[data-soc-text]")).toHaveCount(0);
        await expect(glyph(page).locator("[data-fill]")).toHaveCount(0);
    });

    test("an unknown live split is no source, never 0 W", async ({ page }) => {
        await openCharger(page);
        await setStates(page, { "sensor.battery": "unavailable" });
        await expect(flowLabel(page, "in", "solar").locator(".value")).toHaveText("–");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon]")).toHaveCount(0);
    });

    test("Today: the today section's sources only, requested once chosen, with the paid estimate and no phases", async ({ page }) => {
        await openCharger(page);
        expect(await sectionRequests(page, "today")).toBe(0);
        await flow(page).locator("[data-scope='today']").click();
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "today");
        await expectItem(page, "in", "solar", "4.0 kWh", "Solar");
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Today · 00:00–11:55");
        await expectItem(page, "in", "grid", "1.8 kWh", "Grid");
        await expect(flowLabel(page, "in", "grid").locator(".item-note")).toHaveText("paid ≈ 7.20 CZK");
        // Per-phase energy is not recorded: nothing goes out.
        await expect(flow(page).locator("[data-side='out'] [data-flow]")).toHaveCount(0);
        await expect(flow(page).locator("[data-total='out']")).toHaveText("");
        // Energy of no known source is a footnote and part of what went in.
        await expect(flow(page).locator("[data-flow-note]")).toHaveText("0.20 kWh from no known source");
        await expect(flow(page).locator("[data-total='in']")).toHaveText("In 6.4 kWh");
        await expect(content(page).locator("[data-estimate]")).toHaveCount(0);
        expect(await sectionRequests(page, "today")).toBe(1);
        // The flow opens today's answer, from the same figures.
        await open(page, "today");
        await expect(question(page, "today").locator("[data-row='today-kwh']")).toContainText("6.4 kWh");
    });
});

test.describe("motion and the centre value", () => {
    test("Now: ribbons with energy shimmer, the glyph pulses and the charger's power sits under it; Today stands still", async ({ page }) => {
        await openCharger(page);
        await expect(flow(page)).toHaveAttribute("active", "");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("6.4 kW");
        await expect(flow(page).locator("[data-side='out'] [data-ribbon='phase-1']")).toHaveAttribute("data-animated", "");
        // Every drawn ribbon has energy on it, and shimmers.
        await expect(flow(page).locator("[data-ribbon]:not([data-animated])")).toHaveCount(0);
        // Nothing comes from the battery: no ribbon, so nothing shimmers.
        await expect(flowLabel(page, "in", "battery")).toHaveClass(/none/);
        await expect(flow(page).locator("[data-side='in'] [data-ribbon='battery']")).toHaveCount(0);
        await flow(page).locator("[data-scope='today']").click();
        // Charged: the sources and the unknown source.
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("6.4 kWh");
        await expect(flow(page)).not.toHaveAttribute("active");
        await expect(flow(page).locator("[data-ribbon]").first()).toBeAttached();
        await expect(flow(page).locator("[data-animated]")).toHaveCount(0);
    });

    const cases: Array<[Variant, string, boolean]> = [
        [{ runMode: "SuspendedEV", power: "0" }, "0 W", false],
        [{ power: "60" }, "60 W", true],
        [{ power: "unavailable" }, "–", false],
    ];
    for (const [variant, value, active] of cases) {
        test(`${JSON.stringify(variant)} shows ${value} under the glyph, ${active ? "pulsing" : "still"}`, async ({ page }) => {
            await openCharger(page, variant);
            await expect(flow(page).locator("[data-centre-value]")).toHaveText(value);
            if (active) await expect(flow(page)).toHaveAttribute("active", "");
            else await expect(flow(page)).not.toHaveAttribute("active");
        });
    }

    test("reduced motion stops the shimmer and the pulse", async ({ page }) => {
        await openCharger(page);
        await expectReducedMotionStill(page, flow(page));
    });
});

test.describe("progress", () => {
    test("hardware session counters, the charging segment apart, and the car's need converted from percent", async ({ page }) => {
        await openCharger(page);
        await open(page, "progress");
        const progress = question(page, "progress");
        await expect(progress.locator("[data-row='session-energy']")).toContainText("9.5 kWh");
        await expect(progress.locator("[data-row='session-duration']")).toContainText("1 h 13 min");
        await expect(progress.locator("[data-row='segment']")).toContainText("11:20: the latest start of charging, not the session's start");
        // The segment is the strip's, read once on opening.
        expect(await sectionRequests(page, "segment")).toBe(1);
        await expect(progress.locator("[data-row='car-name']")).toContainText("the only configured car");
        // (80 − 50) % of 64 kWh.
        await expect(progress.locator("[data-row='car-needed']")).toContainText("19 kWh");
        await expect(progress.locator("[data-row='eta']")).toContainText("≈ 3 h 0 min to 80 % at current power");
        await expect(progress).toContainText("it is not a ready-by time");

        await evidence(page, "progress").click();
        // 9.5 kWh over 73 min.
        await expect(progress.locator("[data-row='average']")).toContainText("7.8 kW");
        await expect(progress.locator("[data-row='active-phases']")).toContainText("3");
        await expect(progress.locator("[data-row='car-capacity']")).toContainText("64 kWh");
        await expect(progress).toContainText("(limit − charge) ÷ 100 × the car's configured capacity");
        await expect(progress.locator("[data-single-phase]")).toHaveCount(0);
    });

    test("a car at its limit needs nothing and gets no estimate", async ({ page }) => {
        await openCharger(page, { soc: "85" });
        await expect(content(page).locator("[data-estimate]")).toHaveCount(0);
        await open(page, "progress");
        await expect(question(page, "progress").locator(".preview")).toHaveText("9.5 kWh this session · at the car's limit");
        await expect(question(page, "progress").locator("[data-row='car-needed']")).toContainText("at or above the limit");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("at or above the limit");
        await expect(content(page).locator("[data-completion-line]")).toHaveText("The car is already at or above its charge limit.");
    });

    test("paused at zero power has no time estimate", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", phases: ["0", "0", "0"] });
        await expect(overview(page).locator(".status")).toHaveText("Car plugged in, not charging (SuspendedEV).");
        await expect(content(page).locator("[data-estimate]")).toHaveCount(0);
        await expect(tile(page, "waiting").locator(".value")).toHaveText("Not charging");
        await open(page, "progress");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("no estimate while not charging");
        await expect(question(page, "progress").locator("[data-row='segment']")).toHaveCount(0);
    });

    test("charging on one phase is an observation, not a fault", async ({ page }) => {
        await openCharger(page, { phases: ["6400", "0", "0"] });
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await open(page, "progress");
        await evidence(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='active-phases']")).toContainText("1");
        await expect(question(page, "progress").locator("[data-single-phase]")).toContainText("an observation, not a fault");
    });

    test("an implausible duration counter is shown as read, never used", async ({ page }) => {
        await openCharger(page, { duration: "287571968" });
        await expect(tile(page, "progress").locator(".detail")).toHaveText("this session");
        await open(page, "progress");
        await expect(question(page, "progress").locator("[data-row='session-duration']")).toContainText("unavailable");
        await evidence(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='duration-raw']")).toContainText("287571968 s");
        await expect(question(page, "progress").locator("[data-row='average']")).toHaveCount(0);
    });

    test("several cars and nothing naming one: no car's charge is shown", async ({ page }) => {
        await openCharger(page, { twoCars: true, windows: [{ from: 22, to: 26, vehicleId: "ioniq" }] });
        await expect(content(page).locator("[data-estimate]")).toHaveCount(0);
        await open(page, "progress");
        await expect(question(page, "progress").locator("[data-ambiguous]")).toContainText("2 cars are configured");
        await expect(question(page, "progress")).not.toContainText("50 %");
        await expect(question(page, "progress")).not.toContainText("30 %");
        await expect(content(page).locator("[data-completion-line]")).toHaveText("Which car charges is not known, so no completion is estimated.");
    });

    test("several cars with the slot in progress naming one: that car", async ({ page }) => {
        await openCharger(page, { twoCars: true });
        await expect(glyph(page).locator("[data-soc-text]")).toHaveText("50 %");
        await open(page, "progress");
        await expect(question(page, "progress").locator("[data-row='car-name']")).toContainText("named by the plan's slot in progress");
    });
});

test.describe("plan", () => {
    test("effective and candidate windows, and the end-of-plan charge with its shortfall under the current plan", async ({ page }) => {
        await openCharger(page);
        await open(page, "plan");
        const plan = question(page, "plan");
        const windows = plan.locator("[data-window]");
        await expect(windows).toHaveCount(2);
        await expect(windows.nth(0)).toContainText("now–14:00");
        await expect(windows.nth(0)).toContainText("Fast 6A · Kona");
        await expect(windows.nth(0)).toHaveAttribute("data-effective", "true");
        await expect(windows.nth(1)).toContainText("22:00–02:00");
        await expect(windows.nth(1)).toContainText("candidate, not executed");
        // 8 slots × 1.6 kWh = 12.8 kWh of 19.2 needed; the candidate's 2 kWh slots do not count.
        await expect(plan.locator("[data-row='end-soc']")).toContainText("≈ 70 % of 80 % by 14:00");
        await expect(plan.locator("[data-row='end-soc']")).toContainText("an estimate under the current plan, not a guarantee");
        await expect(plan.locator("[data-row='reach']")).toContainText("not within the plan: 6.4 kWh short");
        // The projection read on opening serves the answer too.
        expect(await requests(page, "helman/get_appliance_projections")).toHaveLength(1);

        await evidence(page, "plan").click();
        await expect(plan.locator("[data-row='supplied']")).toContainText("13 kWh");
        await expect(plan.locator("[data-row='generated']")).toContainText("12:00");
        await expect(plan).toContainText("no reason is inferred here");
    });

    test("the first slot whose cumulative energy reaches the limit, only for this car", async ({ page }) => {
        await openCharger(page, { slotKwh: 2.4, twoCars: true, otherCarPoints: true });
        await open(page, "plan");
        // 8 × 2.4 = 19.2 kWh: exactly the need, at the 13:45 slot's end. The other car's 5 kWh points are not this car's.
        await expect(question(page, "plan").locator("[data-row='reach']")).toContainText("≈ by 14:00");
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toContainText("≈ 80 % of 80 % by 14:00");
    });

    test("the threshold is crossed in energy, not on the projection's rounded SoC", async ({ page }) => {
        // 8 × 2.368 = 18.944 kWh: 79.6 %, which the projection rounds to 80.
        await openCharger(page, { slotKwh: 2.368 });
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-row='reach']")).toContainText("not within the plan: 0.26 kWh short");
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toContainText("≈ 79 % of 80 %");
        await expect(content(page).locator("[data-completion-line]")).toContainText("≈ 79 % of 80 %");
    });

    test("execution off establishes no completion", async ({ page }) => {
        await openCharger(page, { executionEnabled: false });
        await open(page, "plan");
        await expect(question(page, "plan").locator(".preview")).toHaveText("Planned, but schedule execution is off");
        await expect(question(page, "plan").locator("[data-execution-off]")).toBeVisible();
        await expect(question(page, "plan").locator("[data-window]").nth(0)).toHaveAttribute("data-effective", "false");
        await expect(question(page, "plan").locator("[data-completion='execution_off']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='reach']")).toHaveCount(0);
    });

    test("candidate-only windows establish no completion", async ({ page }) => {
        await openCharger(page, { windows: [{ from: 22, to: 26, candidate: true, vehicleId: "kona" }] });
        await open(page, "plan");
        await expect(question(page, "plan").locator(".preview")).toHaveText("Only candidate windows, not executed");
        await expect(question(page, "plan").locator("[data-completion='candidates_only']")).toBeVisible();
    });

    test("a candidate before the planned windows caps them in the projection: no estimate short of the limit", async ({ page }) => {
        await openCharger(page, { windows: [
            { from: 11.75, to: 13, candidate: true, vehicleId: "kona" },
            { from: 13, to: 14, vehicleId: "kona" },
        ] });
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-completion='candidate_first']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toHaveCount(0);
    });

    test("the limit reached before a candidate window still has its time", async ({ page }) => {
        // 5 % of 64 kWh: 3.2 kWh, reached in the second planned slot, before tonight's candidate.
        await openCharger(page, { soc: "75", windows: [
            { from: 11.75, to: 13, vehicleId: "kona" },
            { from: 13, to: 14, candidate: true, vehicleId: "kona" },
            { from: 14, to: 15, vehicleId: "kona" },
        ] });
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-row='reach']")).toContainText("12:30");
    });

    test("a projection from an earlier slot is stale", async ({ page }) => {
        await openCharger(page, { projectionGeneratedAt: "2026-10-21T11:40:00+00:00" });
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-completion='stale']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toHaveCount(0);
    });

    test("a projection without this charger has no completion", async ({ page }) => {
        await openCharger(page, { projectionEmpty: true });
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-completion='no_projection']")).toBeVisible();
    });

    test("an unknown charge limit supports no deadline and no completion; there is no silent default target", async ({ page }) => {
        await openCharger(page, { limit: null });
        await expect(glyph(page).locator("[data-marker='max']")).toHaveCount(0);
        await expect(content(page).locator("[data-estimate]")).toHaveCount(0);
        await open(page, "progress");
        await expect(question(page, "progress").locator("[data-row='car-limit']")).toContainText("no charge limit reading");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("no estimate without the car's charge and limit");
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-completion='no_target']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='reach']")).toHaveCount(0);
    });

    test("a failed refresh after a plan change drops the old plan's completion", async ({ page }) => {
        await openCharger(page);
        await open(page, "plan");
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toBeVisible();
        await page.evaluate(() => {
            (window as any).__projectionDown = true;
            // A plan change announced on the shared feed.
            (window.__deepAll(document, "node-detail-ev-charger-content")[0] as any)._onDataChanged();
        });
        await expect(question(page, "plan")).toContainText("The projection could not be loaded.");
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toHaveCount(0);
        await expect(content(page).locator("[data-completion-line]")).toHaveText("The projection could not be loaded.");
    });

    test("a failed projection offers a retry", async ({ page }) => {
        await openCharger(page, { projectionFails: true });
        await open(page, "plan");
        await expect(question(page, "plan")).toContainText("The projection could not be loaded.");
        await expect(question(page, "plan").locator("button.link-button")).toHaveText("Try again");
    });
});

test.describe("waiting", () => {
    test("plugged in during an effective window with no reported cause: it cannot be determined, with the readings", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0" });
        await expect(tile(page, "waiting").locator(".detail")).toHaveText("The cause cannot be determined");
        await open(page, "waiting");
        await expect(question(page, "waiting").locator("[data-waiting='unknown']")).toBeVisible();
        await evidence(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-row='run_mode']")).toContainText("SuspendedEV");
        await expect(question(page, "waiting").locator("[data-row='scheduled-now']")).toContainText("now–14:00");
    });

    test("not planned now: the next effective window is the supported reason", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", windows: [{ from: 22, to: 26, vehicleId: "kona" }] });
        await expect(tile(page, "waiting").locator(".detail")).toHaveText("Not planned to charge now; next window 22:00–02:00.");
    });

    test("ECO surplus is context, not the established cause", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", windows: [{ from: 11.75, to: 14, vehicleId: "kona", useMode: "ECO" }] });
        await open(page, "waiting");
        await expect(question(page, "waiting").locator("[data-waiting='unknown']")).toBeVisible();
        await expect(question(page, "waiting").locator("[data-eco]")).toContainText("starts from 2097 W; its grid reading is -781 W");
        await expect(question(page, "waiting").locator("[data-eco]")).toContainText("context, not proof");
    });

    test("an actual runtime failure is reported as supplied", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", runtimeFailed: true });
        await open(page, "waiting");
        await expect(question(page, "waiting").locator("[data-waiting='reason']")).toContainText("failed: the charger did not accept Start Charging");
    });

    test("several supported observations are listed without picking one", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", soc: "85", executionEnabled: false });
        await open(page, "waiting");
        await expect(question(page, "waiting").locator("[data-waiting='unknown']")).toContainText("cannot be singled out");
        await expect(question(page, "waiting").locator("li")).toHaveCount(2);
    });
});

test.describe("today and the session", () => {
    test("today's attribution is its own answer, requested on opening, and never the session's", async ({ page }) => {
        await openCharger(page);
        await open(page, "today");
        const today = question(page, "today");
        await expect(today.locator("[data-row='today-kwh']")).toContainText("6.4 kWh");
        await expect(today.locator("[data-row='today-grid']")).toContainText("1.8 kWh (28 %)");
        await expect(today.locator("[data-row='today-paid']")).toContainText("7.20 CZK");
        await expect(today.locator("[data-row='today-paid']")).toContainText("not a bill");
        await expect(today.locator("[data-not-session]")).toContainText("not the charging session's");
        await expect(question(page, "today").locator(".preview")).toHaveText("6.4 kWh today · ≈ 7.20 CZK paid");
        // The session figure stays the hardware's.
        await expect(tile(page, "progress").locator(".value")).toHaveText("9.5 kWh");
        const section = (await requests(page, "helman/get_node_detail")).filter((r) => r.section === "today");
        expect(section).toEqual([{ type: "helman/get_node_detail", node: "ev_charger", section: "today", device_id: "garage-ev" }]);

        await evidence(page, "today").click();
        await expect(today.locator("[data-row='period-bounds']")).toContainText("00:00 – 11:55");
        await expect(today.locator("[data-row='forgone']")).toContainText("4.80 CZK");
    });
});

test.describe("trust", () => {
    test("reported states and a timestamped comparison, without a verdict", async ({ page }) => {
        await openCharger(page);
        await open(page, "trust");
        const trust = question(page, "trust");
        await expect(trust.locator("[data-row='fault']")).toContainText("none reported");
        await expect(trust.locator("[data-row='network_status']")).toContainText("Not Connected");
        await expect(trust.locator("[data-row='link_success_rate']")).toContainText("98.5 %");
        await expect(trust.locator("[data-row='total']")).toContainText("6.4 kW · 11:59");
        await expect(trust.locator("[data-row='phase-sum']")).toContainText("6.4 kW · 11:59");
        await expect(trust.locator("[data-row='difference']")).toContainText("0 W");
        await expect(trust).toContainText("below 100 % alone says nothing");
        await evidence(page, "trust").click();
        await expect(trust.locator("[data-row='temperature']")).toContainText("27 °C");
        await expect(trust.locator("[data-row='main_breaker_limit']")).toContainText("25 A");
    });

    test("readings not taken together are not compared", async ({ page }) => {
        await openCharger(page, { phasesAgeS: 120 });
        await expect(tile(page, "trust").locator(".detail")).toHaveText("not compared with its phases");
        await open(page, "trust");
        await expect(question(page, "trust").locator("[data-incomparable]")).toContainText("not taken at the same time");
        await expect(question(page, "trust").locator("[data-row='difference']")).toHaveCount(0);
    });

    test("a value that held for hours but was just read again is compared", async ({ page }) => {
        // Single-phase charging: L2 and L3 sit at 0 W, so only their last report moves.
        await openCharger(page, { phases: ["6400", "0", "0"], phasesHeldS: 3 * 3600 });
        await open(page, "trust");
        await expect(question(page, "trust").locator("[data-incomparable]")).toHaveCount(0);
        await expect(question(page, "trust").locator("[data-row='difference']")).toContainText("0 W");
    });
});

test.describe("disclosure and live data", () => {
    test("one open question at a time, evidence by keyboard in two disclosures", async ({ page }) => {
        await openCharger(page);
        await tile(page, "progress").locator("button").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "progress")).toHaveAttribute("aria-expanded", "true");
        await evidence(page, "progress").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "progress").locator("[data-row='average']")).toBeVisible();
        await open(page, "trust");
        await expect(question(page, "progress")).toHaveCount(0);
        await expect(tile(page, "progress").locator("button")).toHaveAttribute("aria-expanded", "false");
    });

    test("live readings reach the open detail", async ({ page }) => {
        await openCharger(page);
        await setStates(page, { "sensor.kona_soc": "60" });
        await expect(glyph(page).locator("[data-soc-text]")).toHaveText("60 %");
    });

    test("a failed overview offers a retry", async ({ page }) => {
        await mount(page, { overviewFails: true });
        await openDevice(page, "Garage EV");
        await expect(content(page)).toContainText("Charger details could not be loaded.");
        await expect(content(page).locator("button.link-button")).toHaveText("Try again");
    });
});

test.describe("a Custom charger", () => {
    test("keeps every question with its config-backed answers", async ({ page }) => {
        await openCharger(page, { profile: false });
        await expect(overview(page).locator(".status")).toHaveText("Drawing 6.4 kW.");
        await expect(content(page).locator("helman-node-tile")).toHaveCount(3);
        // No phase readings: nothing drawn out, which is not 0 W out.
        await expect(flow(page).locator("[data-side='out'] [data-flow]")).toHaveCount(0);
        await expect(flow(page).locator("[data-total='out']")).toHaveText("");
        await open(page, "progress");
        await expect(question(page, "progress")).toContainText("Session counters need a hardware profile");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("≈ 3 h 0 min to 80 % at current power");
        await open(page, "trust");
        await expect(question(page, "trust").locator("[data-row='fault']")).toContainText("unavailable");
    });
});

test.describe("review fixes", () => {
    test("a phase the registry does not have is not drawn, and the total out stays", async ({ page }) => {
        await openCharger(page, { noPhase3: true });
        await expect(flow(page).locator("[data-side='out'] [data-flow]")).toHaveCount(2);
        await expect(flowLabel(page, "out", "phase-3")).toHaveCount(0);
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 4.3 kW");
    });

    test("opened without the card's live split, the sources are unknown and there is no scale", async ({ page }) => {
        await openCharger(page);
        // As the solar inspector opens a device: its item alone.
        await content(page).evaluate((element: any) => { element.params = { nodeType: "device", item: element.params.item }; });
        await expect(flowLabel(page, "in", "solar").locator(".value")).toHaveText("–");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon]")).toHaveCount(0);
        expect(await flow(page).evaluate((element: any) => element.scale)).toBeNull();
    });

    test("a fresh Today is reused on the next toggle and by its answer", async ({ page }) => {
        await openCharger(page);
        await flow(page).locator("[data-scope='today']").click();
        await expectItem(page, "in", "solar", "4.0 kWh", "Solar");
        await flow(page).locator("[data-scope='now']").click();
        await flow(page).locator("[data-scope='today']").click();
        await open(page, "today");
        expect(await sectionRequests(page, "today")).toBe(1);
    });

    test("a failed Today offers a retry", async ({ page }) => {
        await openCharger(page, { todayFails: true });
        await flow(page).locator("[data-scope='today']").click();
        await expect(flow(page).locator("[data-flow-note]").first()).toHaveText("Today's figures could not be loaded.");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("–");
        const retry = content(page).locator("helman-node-flow + button.link-button");
        await expect(retry).toHaveText("Try again");
        await retry.click();
        await expect.poll(() => sectionRequests(page, "today")).toBe(2);
    });

    test("today's charging is read again on a new run mode, not on every overview", async ({ page }) => {
        await openCharger(page);
        await expect.poll(() => sectionRequests(page, "segment")).toBe(1);
        await page.evaluate(() => (window.__deepAll(document, "node-detail-ev-charger-content")[0] as any)._loadOverview(true));
        await expect.poll(() => requests(page, "helman/get_node_detail").then((all) => all.filter((r) => !r.section).length)).toBe(2);
        expect(await sectionRequests(page, "segment")).toBe(1);
        await setStates(page, { "sensor.ev_run_mode": "SuspendedEV" });
        await expect.poll(() => sectionRequests(page, "segment")).toBe(2);
    });
});

/** The two states the review screenshots show: an evening waiting for tonight's window, and a midday charge. */
const STATES: Array<[string, Variant]> = [
    ["evening", { runMode: "SuspendedEV", power: "0", phases: ["0", "0", "0"], chargeSwitch: "off", windows: [{ from: 22, to: 26, vehicleId: "kona" }] }],
    ["midday", {}],
];

test.describe("screenshots", { tag: "@screens" }, () => {
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        for (const [state, variant] of STATES) {
            test(`the ${state} overview, Today and the opened answers at ${name}`, async ({ page }) => {
                await page.setViewportSize({ width, height });
                await openCharger(page, variant);
                await expect(content(page).locator("[data-completion-line]")).not.toHaveText("Loading the projection…");
                await page.screenshot({ path: `${SCREENS}/ev-charger-${state}-${name}-now.png`, fullPage: true });
                await flow(page).locator("[data-scope='today']").click();
                await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
                await page.screenshot({ path: `${SCREENS}/ev-charger-${state}-${name}-today.png`, fullPage: true });
                await open(page, "plan");
                await expect(question(page, "plan").locator("[data-window]").first()).toBeVisible();
                await page.screenshot({ path: `${SCREENS}/ev-charger-${state}-${name}-plan.png`, fullPage: true });
                await open(page, "waiting");
                await evidence(page, "waiting").click();
                await page.screenshot({ path: `${SCREENS}/ev-charger-${state}-${name}-waiting.png`, fullPage: true });
                // The power card behind the stubbed dialog is wider than 360 px on its own; the detail is not.
                const overflow = await content(page).evaluate((element) =>
                    Math.max(element.scrollWidth - element.clientWidth, element.getBoundingClientRect().right - window.innerWidth));
                expect(overflow).toBeLessThanOrEqual(0);
            });
        }
    }
});


test("Today across midnight throttles power ticks and accepts a late answer", async ({ page }) => {
    await openCharger(page);
    await flow(page).locator("[data-scope='today']").click();
    await expect(flow(page)).toContainText("11:55");
    await holdSection(page, "ev_charger", "today");
    const before = (await sectionRequestLog(page, "ev_charger", "today")).length;
    for (let second = 0; second < 10; second += 1) {
        await page.clock.setFixedTime(new Date(Date.parse("2026-10-22T00:00:00Z") + second * 1000));
        await powerTick(page, "node-detail-ev-charger-content", second);
    }
    expect((await sectionRequestLog(page, "ev_charger", "today")).length - before).toBe(1);
    // A delayed answer can still be for yesterday; accept it, then wait out the retry interval.
    await page.evaluate(() => (window as any).__releaseSection());
    await expect(flow(page)).toContainText("00:00–00:00");
    await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
    for (let second = 10; second <= 30; second += 1) {
        await page.clock.setFixedTime(new Date(Date.parse("2026-10-22T00:00:00Z") + second * 1000));
        await powerTick(page, "node-detail-ev-charger-content", second);
    }
    expect((await sectionRequestLog(page, "ev_charger", "today")).length - before).toBe(1);
    await page.clock.setFixedTime(new Date("2026-10-22T00:00:31Z"));
    await powerTick(page, "node-detail-ev-charger-content", 31);
    expect((await sectionRequestLog(page, "ev_charger", "today")).length - before).toBe(2);
    await page.evaluate(() => (window as any).__releaseSection(true));
    await expect.poll(() => content(page).evaluate((element: any) => element._today.state?.status)).toBe("ready");
});


test("a disconnected loading section can recover after reconnect", async ({ page }) => {
    await openCharger(page);
    await holdSection(page, "ev_charger", "today");
    await flow(page).locator("[data-scope='today']").click();
    await expect.poll(() => content(page).evaluate((element: any) => element._today.state?.status)).toBe("loading");
    expect(await reconnectDetail(page, "node-detail-ev-charger-content", "_today")).toBeNull();
    await expect.poll(() => content(page).evaluate((element: any) => element._today.state?.status)).toBe("loading");
    await page.evaluate(() => { (window as any).__releaseSection(); (window as any).__releaseSection(); });
    await expect.poll(() => content(page).evaluate((element: any) => element._today.state?.status)).toBe("ready");
});


test("section requests: a section is read while shown, re-read on a data change and dropped once hidden", async ({ page }) => {
    await openCharger(page);
    const PROJECTION = "helman/get_appliance_projections";
    const reads = () => sectionReads(page, "ev_charger", [PROJECTION]);
    await expect.poll(reads).toEqual({ [PROJECTION]: 1, segment: 1 });
    await open(page, "today");
    await expect.poll(reads).toEqual({ [PROJECTION]: 1, segment: 1, today: 1 });
    await header(page, "today").click();
    await open(page, "today");
    await flow(page).locator("[data-scope='today']").click();
    await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
    await page.waitForTimeout(300);
    expect(await reads()).toEqual({ [PROJECTION]: 1, segment: 1, today: 1 });
    await page.evaluate(() => window.__fireDataChanged("config"));
    await expect.poll(reads).toEqual({ [PROJECTION]: 2, segment: 2, today: 2 });
    await header(page, "today").click();
    await flow(page).locator("[data-scope='now']").click();
    await flow(page).locator("[data-scope='today']").click();
    await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
    await page.waitForTimeout(300);
    expect(await reads()).toEqual({ [PROJECTION]: 2, segment: 2, today: 2 });
});

test("a config change refreshes cached charger vehicle metadata", async ({ page }) => {
    await openCharger(page);
    await expect.poll(() => content(page).evaluate((element: any) => element._appliance.payload?.vehicles.length)).toBe(1);
    const initialReads = await page.evaluate(() => window.__EvChargerRequests.filter((request) => request.type === "helman/get_appliances").length);
    await page.evaluate(() => {
        const hass = window.__EvChargerHass;
        const original = hass.callWS;
        hass.callWS = async (request: any) => {
            const payload = await original(request);
            if (request.type !== "helman/get_appliances") return payload;
            const updated = structuredClone(payload);
            updated.appliances.find((item: any) => item.id === "garage-ev").vehicles.push({
                id: "ioniq", name: "Ioniq", telemetry: { socEntityId: "sensor.ioniq_soc" },
                metadata: { batteryCapacityKwh: 64, maxChargingPowerKw: 11 },
            });
            return updated;
        };
        window.__fireDataChanged("config");
    });
    await expect.poll(() => content(page).evaluate((element: any) => element._appliance.payload?.vehicles.map((vehicle: any) => vehicle.name))).toEqual(["Kona", "Ioniq"]);
    expect(await page.evaluate(() => window.__EvChargerRequests.filter((request) => request.type === "helman/get_appliances").length)).toBe(initialReads + 1);
});


test("today's figures stay while they refresh within the day and on a failure, and give way on a new day", async ({ page }) => {
    await openCharger(page);
    await flow(page).locator("[data-scope='today']").click();
    await expectKeepRule(page, "node-detail-ev-charger-content", "ev_charger", "today", "_today");
});


test("an appliance read a disconnect overtook announces no watched entities", async ({ page }) => {
    await openCharger(page);
    await page.evaluate(() => {
        const hass = window.__EvChargerHass;
        const original = hass.callWS;
        const held: Array<() => void> = [];
        (window as any).__heldAppliances = held;
        hass.callWS = (request: any) => request.type !== "helman/get_appliances" ? original(request)
            : new Promise((resolve, reject) => held.push(() => original(request).then(resolve, reject)));
    });
    // A data change re-reads the roster after the overview, which announces on its own.
    await page.evaluate(() => window.__fireDataChanged("config"));
    await expect.poll(() => page.evaluate(() => (window as any).__heldAppliances.length)).toBeGreaterThan(0);
    await content(page).evaluate((element: any) => {
        const announced: unknown[] = [];
        (window as any).__announced = announced;
        element.addEventListener("helman-watched-entities", (event: CustomEvent) => announced.push(event.detail));
        element.remove();
    });
    await page.evaluate(() => { for (const release of (window as any).__heldAppliances.splice(0)) release(); });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__announced)).toEqual([]);
});
