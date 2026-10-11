import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";

/**
 * The EV charger detail, opened from the charger's name on the power card.
 *
 * Mounted on the real `helman-card` against a fake backend that answers the
 * device tree, the appliance roster, `helman/get_node_detail` (the charger's
 * overview and its today and segment sections), the schedule and the
 * appliance projection.
 * What is pinned is the routing (an EV charger by its configured appliance
 * kind, every other device on the generic detail), the shared disclosure
 * contract, and the charger's truthfulness: the hardware's session counters
 * are the session and today's attribution is not, several cars with nothing
 * naming one show no car's charge, a time at current power is not a ready-by
 * time, and a projected completion counts only windows that will run, under a
 * projection computed for the slot in progress.
 *
 * The clock is fixed at 12:00 UTC; the schedule's 15-minute slots start 11:45.
 */

const BUNDLE = resolve(__dirname, "../../custom_components/helman/frontend_compiled/helman-card.js");
const SCREENS = process.env.EV_SCREENS;

type Window = { from: number; to: number; candidate?: boolean; vehicleId?: string | null; useMode?: string };

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
};

declare global {
    interface Window {
        __hass: any;
        __requests: Array<{ type: string; node?: string; section?: string; device_id?: string }>;
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-card"));
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((v) => {
        window.__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
        (window as any).loadCardHelpers = async () => ({ createCardElement: () => document.createElement("div") });
        const profile = v.profile !== false;
        const updated = "2026-10-21T11:59:50+00:00";
        const s = (state: string, unit?: string, at = updated, changedAt = at) => ({
            state, last_reported: at, last_updated: changedAt, last_changed: changedAt, attributes: unit ? { unit_of_measurement: unit } : {},
        });
        const dto = (overrides: Record<string, unknown>) => ({
            powerSensorId: null, switchEntityId: null, sourceType: null, sourceConfig: null, valueType: "default",
            isSource: false, isUnmeasured: false, isEstimated: false, groups: {}, groupBadgeTexts: [], icon: null,
            compact: false, showAdditionalInfo: false, childrenFullWidth: true, hideChildren: false,
            hideChildrenIndicator: false, sortChildrenByPower: false, deferrable: false, controllableIds: [],
            energyEntityId: null, ratioSensorId: null, children: [], ...overrides,
        });
        const tree = {
            sources: [dto({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
            consumers: [dto({
                id: "house", displayName: "House", powerSensorId: "sensor.house",
                children: [
                    dto({ id: "sensor.ev_energy", displayName: "Garage EV", powerSensorId: "sensor.ev_power", energyEntityId: "sensor.ev_energy", controllableIds: ["garage-ev"], switchEntityId: "switch.ev_charge" }),
                    dto({ id: "sensor.boiler_energy", displayName: "Boiler", powerSensorId: "sensor.boiler_power", energyEntityId: "sensor.boiler_energy", controllableIds: ["boiler"] }),
                ],
            })],
            consumptionTotalSensorId: null, productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
        };
        const phases = v.phases ?? ["2100", "2150", "2150"];
        const phaseAt = new Date(Date.parse(updated) - (v.phasesAgeS ?? 0) * 1000).toISOString();
        const phaseChangedAt = new Date(Date.parse(phaseAt) - (v.phasesHeldS ?? 0) * 1000).toISOString();
        const states: Record<string, unknown> = {
            "sensor.solar": s("4200", "W"), "sensor.house": s("8000", "W"),
            "sensor.ev_power": s(v.power ?? "6400", "W"), "sensor.ev_energy": s("9474.7", "kWh"),
            "sensor.boiler_power": s("0", "W"), "sensor.boiler_energy": s("10", "kWh"),
            "switch.ev_charge": s("on"),
            "select.ev_use_mode": s("Fast"), "select.ev_eco_gear": s("6A"),
            "sensor.kona_soc": s(v.soc ?? "50", "%"), "sensor.ioniq_soc": s("30", "%"),
        };
        if (v.limit !== null) states["number.kona_limit"] = s(v.limit ?? "80", "%");
        const entities: Record<string, string | null> = {
            power: "sensor.ev_power", energy_total: "sensor.ev_energy", charge_switch: "switch.ev_charge",
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
        const segment = {
            node: "ev_charger", section: "segment", deviceId: "garage-ev", asOf: "2026-10-21T12:00:00+00:00",
            chargingSince: profile && runMode === "Charging" ? "2026-10-21T11:20:00+00:00" : null,
        };
        const today = {
            node: "ev_charger", section: "today", deviceId: "garage-ev", asOf: "2026-10-21T11:55:00+00:00",
            period: { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" },
            currency: "CZK/kWh", complete: false, unavailable: null,
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
        const appliances = {
            appliances: [
                {
                    id: "garage-ev", name: "Garage EV", kind: "ev_charger",
                    metadata: { icon: "mdi:car", maxChargingPowerKw: 11, scheduleCapabilities: { chargeToggle: true, useModes: ["Fast", "ECO"], ecoGears: ["6A"], requiresVehicleSelection: true } },
                    controls: { charge: { entityId: "switch.ev_charge" }, useMode: { entityId: "select.ev_use_mode" }, ecoGear: { entityId: "select.ev_eco_gear" } },
                    vehicles: [vehicle("kona", "Kona", v.limit !== null), ...(v.twoCars ? [vehicle("ioniq", "Ioniq", true)] : [])],
                },
                { id: "boiler", name: "Boiler", kind: "generic", metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } }, controls: { switch: { entityId: "switch.boiler" } } },
            ],
        };
        // 15-minute slots from 11:45 for a day and a half; by default a Fast
        // window in progress until 14:00 and a candidate ECO window tonight.
        const windows = v.windows ?? [
            { from: 11.75, to: 14, vehicleId: "kona", useMode: "Fast" },
            { from: 22, to: 26, candidate: true, vehicleId: "kona", useMode: "ECO" },
        ];
        const slots = [];
        const series = [];
        const start = Date.parse("2026-10-21T11:45:00Z");
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = 11.75 + i / 4;
            const window = windows.find((w) => hour >= w.from && hour < w.to);
            const controllables: Record<string, unknown> = { inverter: { kind: "normal" } };
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
        const schedule = {
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
        window.__requests = [];
        window.__hass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            user: { is_admin: true },
            connection: {
                sendMessagePromise: async () => ({}),
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string; device_id?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section, device_id: msg.device_id });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 5, entity_history: {} };
                if (msg.type === "helman/get_schedule") return schedule;
                if (msg.type === "helman/get_appliances") return appliances;
                if (msg.type === "helman/get_appliance_projections") {
                    if (v.projectionFails) throw new Error("projection down");
                    return projection;
                }
                if (msg.type === "helman/get_node_detail") {
                    if (v.overviewFails) throw new Error("detail down");
                    if (msg.section === "segment") return segment;
                    return msg.section ? today : overview;
                }
                if (msg.type === "recorder/statistic_during_period") return { change: 1 };
                return null;
            },
        };
    }, variant);
    await page.evaluate(async () => {
        const card = document.createElement("helman-card") as any;
        await card.setConfig({ type: "custom:helman-card" });
        card.hass = window.__hass;
        document.body.appendChild(card);
    });
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
const overview = (page: Page) => content(page).locator("[data-overview]");
const question = (page: Page, id: string) => content(page).locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const requests = (page: Page, type: string) => page.evaluate((type) => window.__requests.filter((r) => r.type === type), type);

async function openCharger(page: Page, variant: Variant = {}): Promise<void> {
    await mount(page, variant);
    await openDevice(page, "Garage EV");
    await expect(overview(page)).toBeVisible();
}

async function setStates(page: Page, states: Record<string, string>): Promise<void> {
    await page.evaluate((states) => {
        const card = window.__deepAll(document, "helman-card")[0] as any;
        const hass = window.__hass;
        const next = { ...hass.states };
        for (const [id, state] of Object.entries(states)) next[id] = { ...next[id], state };
        window.__hass = { ...hass, states: next };
        card.hass = window.__hass;
    }, states);
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
    });
});

test.describe("the overview", () => {
    test("opens compact: status, power, the car's charge to its limit, the session, the qualified estimate and five closed questions", async ({ page }) => {
        await openCharger(page);
        await expect(overview(page).locator(".status")).toHaveText("Charging at 6.4 kW.");
        await expect(overview(page).locator(".figure")).toHaveCount(3);
        await expect(overview(page).locator("[data-figure='power']")).toContainText("6.4 kW");
        await expect(overview(page).locator("[data-figure='car']")).toContainText("Kona: charge → limit");
        await expect(overview(page).locator("[data-figure='car']")).toContainText("50 % → 80 %");
        await expect(overview(page).locator("[data-figure='session']")).toContainText("9.5 kWh");
        // 30 % of a 64 kWh battery at 6.4 kW: three hours, at current power, not a ready-by time.
        await expect(overview(page).locator("[data-next]")).toHaveText("≈ 3 h 0 min to 80 % at current power");

        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["progress", "plan", "waiting", "today", "trust"]);
        for (const id of ids) await expect(header(page, id!)).toHaveAttribute("aria-expanded", "false");
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        // Nothing heavy is asked for while closed.
        expect(await requests(page, "helman/get_appliance_projections")).toEqual([]);
        expect((await requests(page, "helman/get_node_detail")).filter((r) => r.section)).toEqual([]);
    });

    test("answer previews say the answer", async ({ page }) => {
        await openCharger(page);
        await expect(question(page, "progress").locator(".preview")).toHaveText("9.5 kWh this session · 19 kWh still needed");
        await expect(question(page, "plan").locator(".preview")).toHaveText("Next charging window: now–14:00");
        await expect(question(page, "waiting").locator(".preview")).toHaveText("It is charging now");
        await expect(question(page, "trust").locator(".preview")).toHaveText("network Not Connected · total vs phases differ by 0 W");
    });

    test("an explicit fault is the one exception, linked to the readings answer, and comes before any waiting explanation", async ({ page }) => {
        await openCharger(page, { runMode: "Faulted", faultCode: "12", power: "0", windows: [{ from: 22, to: 26, vehicleId: "kona" }] });
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("The charger reports a fault: Faulted · Over current · code 12.");
        await header(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-waiting='fault']")).toBeVisible();
        await expect(question(page, "waiting")).not.toContainText("next window");
        await exception.locator("button").click();
        await expect(header(page, "trust")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "trust").locator("[data-row='fault']")).toContainText("code 12");
    });

    test("a fault code left over while charging is a reading, not a fault", async ({ page }) => {
        await openCharger(page, { faultCode: "12" });
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await expect(question(page, "waiting").locator(".preview")).toHaveText("It is charging now");
        await header(page, "trust").click();
        await evidence(page, "trust").click();
        await expect(question(page, "trust").locator("[data-row='fault_code']")).toContainText("12");
    });

    test("no car connected: no session in progress and no estimate", async ({ page }) => {
        await openCharger(page, { runMode: "Available", power: "0" });
        await expect(overview(page).locator(".status")).toHaveText("No car connected (Available).");
        await expect(overview(page).locator("[data-figure='session']")).toHaveCount(0);
        await expect(question(page, "progress").locator(".preview")).toHaveText("No car connected");
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-no-session]")).toBeVisible();
        await expect(question(page, "progress")).toContainText("Last reported session");
        await expect(question(page, "progress").locator("[data-row='eta']")).toHaveCount(0);
    });
});

test.describe("progress", () => {
    test("hardware session counters, the charging segment apart, and the car's need converted from percent", async ({ page }) => {
        await openCharger(page);
        await header(page, "progress").click();
        const progress = question(page, "progress");
        await expect(progress.locator("[data-row='session-energy']")).toContainText("9.5 kWh");
        await expect(progress.locator("[data-row='session-duration']")).toContainText("1 h 13 min");
        await expect(progress.locator("[data-row='segment']")).toContainText("11:20: the latest start of charging, not the session's start");
        // The recorded segment start is read when its question opens.
        expect((await requests(page, "helman/get_node_detail")).filter((r) => r.section === "segment")).toHaveLength(1);
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
        await expect(overview(page).locator("[data-next]")).not.toContainText("at current power");
        await expect(question(page, "progress").locator(".preview")).toHaveText("9.5 kWh this session · at the car's limit");
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='car-needed']")).toContainText("at or above the limit");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("at or above the limit");
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-completion='reached']")).toBeVisible();
    });

    test("paused at zero power has no time estimate", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", phases: ["0", "0", "0"] });
        await expect(overview(page).locator(".status")).toHaveText("Car plugged in, not charging (SuspendedEV).");
        await expect(overview(page).locator("[data-next]")).toHaveText("Next charging window: now–14:00");
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("no estimate while not charging");
        await expect(question(page, "progress").locator("[data-row='segment']")).toHaveCount(0);
    });

    test("charging on one phase is an observation, not a fault", async ({ page }) => {
        await openCharger(page, { phases: ["6400", "0", "0"] });
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await header(page, "progress").click();
        await evidence(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='active-phases']")).toContainText("1");
        await expect(question(page, "progress").locator("[data-single-phase]")).toContainText("an observation, not a fault");
    });

    test("an implausible duration counter is shown as read, never used", async ({ page }) => {
        await openCharger(page, { duration: "287571968" });
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='session-duration']")).toContainText("unavailable");
        await evidence(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='duration-raw']")).toContainText("287571968 s");
        await expect(question(page, "progress").locator("[data-row='average']")).toHaveCount(0);
    });

    test("several cars and nothing naming one: no car's charge is shown", async ({ page }) => {
        await openCharger(page, { twoCars: true, windows: [{ from: 22, to: 26, vehicleId: "ioniq" }] });
        await expect(overview(page).locator("[data-figure='car']")).toHaveCount(0);
        await expect(overview(page).locator("[data-next]")).not.toContainText("at current power");
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-ambiguous]")).toContainText("2 cars are configured");
        await expect(question(page, "progress")).not.toContainText("50 %");
        await expect(question(page, "progress")).not.toContainText("30 %");
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-completion='no_vehicle']")).toBeVisible();
    });

    test("several cars with the slot in progress naming one: that car", async ({ page }) => {
        await openCharger(page, { twoCars: true });
        await expect(overview(page).locator("[data-figure='car']")).toContainText("Kona");
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='car-name']")).toContainText("named by the plan's slot in progress");
    });
});

test.describe("plan", () => {
    test("effective and candidate windows, and the end-of-plan charge with its shortfall under the current plan", async ({ page }) => {
        await openCharger(page);
        await header(page, "plan").click();
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
        expect(await requests(page, "helman/get_appliance_projections")).toHaveLength(1);

        await evidence(page, "plan").click();
        await expect(plan.locator("[data-row='supplied']")).toContainText("13 kWh");
        await expect(plan.locator("[data-row='generated']")).toContainText("12:00");
        await expect(plan).toContainText("no reason is inferred here");
    });

    test("the first slot whose cumulative energy reaches the limit, only for this car", async ({ page }) => {
        await openCharger(page, { slotKwh: 2.4, twoCars: true, otherCarPoints: true });
        await header(page, "plan").click();
        // 8 × 2.4 = 19.2 kWh: exactly the need, at the 13:45 slot's end. The other car's 5 kWh points are not this car's.
        await expect(question(page, "plan").locator("[data-row='reach']")).toContainText("≈ by 14:00");
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toContainText("≈ 80 % of 80 % by 14:00");
    });

    test("the threshold is crossed in energy, not on the projection's rounded SoC", async ({ page }) => {
        // 8 × 2.368 = 18.944 kWh: 79.6 %, which the projection rounds to 80.
        await openCharger(page, { slotKwh: 2.368 });
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-row='reach']")).toContainText("not within the plan: 0.26 kWh short");
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toContainText("≈ 79 % of 80 %");
    });

    test("execution off establishes no completion", async ({ page }) => {
        await openCharger(page, { executionEnabled: false });
        await expect(question(page, "plan").locator(".preview")).toHaveText("Planned, but schedule execution is off");
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-execution-off]")).toBeVisible();
        await expect(question(page, "plan").locator("[data-window]").nth(0)).toHaveAttribute("data-effective", "false");
        await expect(question(page, "plan").locator("[data-completion='execution_off']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='reach']")).toHaveCount(0);
    });

    test("candidate-only windows establish no completion", async ({ page }) => {
        await openCharger(page, { windows: [{ from: 22, to: 26, candidate: true, vehicleId: "kona" }] });
        await expect(question(page, "plan").locator(".preview")).toHaveText("Only candidate windows, not executed");
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-completion='candidates_only']")).toBeVisible();
    });

    test("a candidate before the planned windows caps them in the projection: no estimate short of the limit", async ({ page }) => {
        await openCharger(page, { windows: [
            { from: 11.75, to: 13, candidate: true, vehicleId: "kona" },
            { from: 13, to: 14, vehicleId: "kona" },
        ] });
        await header(page, "plan").click();
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
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-row='reach']")).toContainText("12:30");
    });

    test("a projection from an earlier slot is stale", async ({ page }) => {
        await openCharger(page, { projectionGeneratedAt: "2026-10-21T11:40:00+00:00" });
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-completion='stale']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='end-soc']")).toHaveCount(0);
    });

    test("a projection without this charger has no completion", async ({ page }) => {
        await openCharger(page, { projectionEmpty: true });
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-completion='no_projection']")).toBeVisible();
    });

    test("an unknown charge limit supports no deadline and no completion; there is no silent default target", async ({ page }) => {
        await openCharger(page, { limit: null });
        await expect(overview(page).locator("[data-figure='car']")).toHaveText(/50 %$/);
        await expect(overview(page).locator("[data-next]")).not.toContainText("at current power");
        await header(page, "progress").click();
        await expect(question(page, "progress").locator("[data-row='car-limit']")).toContainText("no charge limit reading");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("no estimate without the car's charge and limit");
        await header(page, "plan").click();
        await expect(question(page, "plan").locator("[data-completion='no_target']")).toBeVisible();
        await expect(question(page, "plan").locator("[data-row='reach']")).toHaveCount(0);
    });

    test("a failed projection offers a retry", async ({ page }) => {
        await openCharger(page, { projectionFails: true });
        await header(page, "plan").click();
        await expect(question(page, "plan")).toContainText("The projection could not be loaded.");
        await expect(question(page, "plan").locator("button.link-button")).toHaveText("Try again");
    });
});

test.describe("waiting", () => {
    test("plugged in during an effective window with no reported cause: it cannot be determined, with the readings", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0" });
        await expect(question(page, "waiting").locator(".preview")).toHaveText("The cause cannot be determined");
        await header(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-waiting='unknown']")).toBeVisible();
        await evidence(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-row='run_mode']")).toContainText("SuspendedEV");
        await expect(question(page, "waiting").locator("[data-row='scheduled-now']")).toContainText("now–14:00");
    });

    test("not planned now: the next effective window is the supported reason", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", windows: [{ from: 22, to: 26, vehicleId: "kona" }] });
        await expect(question(page, "waiting").locator(".preview")).toHaveText("Not planned to charge now; next window 22:00–02:00.");
    });

    test("ECO surplus is context, not the established cause", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", windows: [{ from: 11.75, to: 14, vehicleId: "kona", useMode: "ECO" }] });
        await header(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-waiting='unknown']")).toBeVisible();
        await expect(question(page, "waiting").locator("[data-eco]")).toContainText("starts from 2097 W; its grid reading is -781 W");
        await expect(question(page, "waiting").locator("[data-eco]")).toContainText("context, not proof");
    });

    test("an actual runtime failure is reported as supplied", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", runtimeFailed: true });
        await header(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-waiting='reason']")).toContainText("failed: the charger did not accept Start Charging");
    });

    test("several supported observations are listed without picking one", async ({ page }) => {
        await openCharger(page, { runMode: "SuspendedEV", power: "0", soc: "85", executionEnabled: false });
        await header(page, "waiting").click();
        await expect(question(page, "waiting").locator("[data-waiting='unknown']")).toContainText("cannot be singled out");
        await expect(question(page, "waiting").locator("li")).toHaveCount(2);
    });
});

test.describe("today and the session", () => {
    test("today's attribution is its own answer, requested on opening, and never the session's", async ({ page }) => {
        await openCharger(page);
        await header(page, "today").click();
        const today = question(page, "today");
        await expect(today.locator("[data-row='today-kwh']")).toContainText("6.4 kWh");
        await expect(today.locator("[data-row='today-grid']")).toContainText("1.8 kWh (28 %)");
        await expect(today.locator("[data-row='today-paid']")).toContainText("7.20 CZK");
        await expect(today.locator("[data-row='today-paid']")).toContainText("not a bill");
        await expect(today.locator("[data-not-session]")).toContainText("not the charging session's");
        await expect(question(page, "today").locator(".preview")).toHaveText("6.4 kWh today · ≈ 7.20 CZK paid");
        // The session figure stays the hardware's.
        await expect(overview(page).locator("[data-figure='session']")).toContainText("9.5 kWh");
        const section = (await requests(page, "helman/get_node_detail")).filter((r) => r.section);
        expect(section).toEqual([{ type: "helman/get_node_detail", node: "ev_charger", section: "today", device_id: "garage-ev" }]);

        await evidence(page, "today").click();
        await expect(today.locator("[data-row='period-bounds']")).toContainText("00:00 – 11:55");
        await expect(today.locator("[data-row='forgone']")).toContainText("4.80 CZK");
    });
});

test.describe("trust", () => {
    test("reported states and a timestamped comparison, without a verdict", async ({ page }) => {
        await openCharger(page);
        await header(page, "trust").click();
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
        await header(page, "trust").click();
        await expect(question(page, "trust").locator("[data-incomparable]")).toContainText("not taken at the same time");
        await expect(question(page, "trust").locator("[data-row='difference']")).toHaveCount(0);
    });

    test("a value that held for hours but was just read again is compared", async ({ page }) => {
        // Single-phase charging: L2 and L3 sit at 0 W, so only their last report moves.
        await openCharger(page, { phases: ["6400", "0", "0"], phasesHeldS: 3 * 3600 });
        await header(page, "trust").click();
        await expect(question(page, "trust").locator("[data-incomparable]")).toHaveCount(0);
        await expect(question(page, "trust").locator("[data-row='difference']")).toContainText("0 W");
    });
});

test.describe("disclosure and live data", () => {
    test("one open question at a time, evidence by keyboard in two disclosures", async ({ page }) => {
        await openCharger(page);
        await header(page, "progress").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "progress")).toHaveAttribute("aria-expanded", "true");
        await evidence(page, "progress").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "progress").locator("[data-row='average']")).toBeVisible();
        await header(page, "trust").click();
        await expect(header(page, "progress")).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "progress").locator("[data-row='session-energy']")).toHaveCount(0);
    });

    test("live readings reach the open detail", async ({ page }) => {
        await openCharger(page);
        await setStates(page, { "sensor.kona_soc": "60" });
        await expect(overview(page).locator("[data-figure='car']")).toContainText("60 % → 80 %");
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
        await expect(content(page).locator("helman-node-question")).toHaveCount(5);
        await header(page, "progress").click();
        await expect(question(page, "progress")).toContainText("Session counters need a hardware profile");
        await expect(question(page, "progress").locator("[data-row='eta']")).toContainText("≈ 3 h 0 min to 80 % at current power");
        await header(page, "trust").click();
        await expect(question(page, "trust").locator("[data-row='fault']")).toContainText("unavailable");
    });
});

test.describe("screenshots", () => {
    test.skip(!SCREENS, "set EV_SCREENS to a directory to capture the review screenshots");
    for (const [name, width, height] of [["mobile-390", 390, 844], ["desktop-1280", 1280, 900]] as const) {
        test(`overview and expanded answers at ${name}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await openCharger(page, { twoCars: true });
            await page.screenshot({ path: `${SCREENS}/${name}-overview.png`, fullPage: true });
            await header(page, "plan").click();
            await expect(question(page, "plan").locator("[data-row='end-soc']")).toBeVisible();
            await page.screenshot({ path: `${SCREENS}/${name}-plan.png`, fullPage: true });
            await header(page, "progress").click();
            await evidence(page, "progress").click();
            await page.screenshot({ path: `${SCREENS}/${name}-progress-evidence.png`, fullPage: true });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});
