import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { loadBundle } from "./support/card-page";
import { energyFields, treeNode, treePayload } from "./support/payload-builders";

/**
 * `helman-device-card` is one helman device or energy node as a tile: the
 * configured fields from the catalog, joined with " · ", some of them hidden
 * while the target is idle. Tapping it opens the helman detail.
 *
 * Mounted against a fake backend answering the device tree, the history and
 * the EV charger's overview, whose status follows the run mode in `hass`.
 */

const TREE = treePayload({
    sources: [
        treeNode({ id: "solar", displayName: "", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar",
            todayEnergyEntityId: "sensor.solar_today", ...energyFields("solar") }),
        treeNode({ id: "grid", displayName: "Grid", powerSensorId: "sensor.grid", isSource: true, sourceType: "grid", ...energyFields("grid") }),
    ],
    consumers: [
        treeNode({
            id: "house",
            displayName: "House",
            powerSensorId: "sensor.house",
            sourceType: "house",
            children: [
                treeNode({
                    id: "sensor.ev_energy", displayName: "Garage EV", powerSensorId: "sensor.ev_power", energyEntityId: "sensor.ev_energy",
                    switchEntityId: "switch.ev_charge", controllableIds: ["garage-ev"], applianceKind: "ev_charger",
                }),
                treeNode({
                    id: "sensor.heat_pump_energy", displayName: "Heat pump", powerSensorId: "sensor.heat_pump_power",
                    energyEntityId: "sensor.heat_pump_energy", switchEntityId: "climate.heat_pump", climateEntityId: "climate.heat_pump",
                    controllableIds: ["heat_pump"],
                }),
                treeNode({
                    id: "sensor.boiler_energy", displayName: "Boiler", powerSensorId: "sensor.boiler_power",
                    switchEntityId: "switch.boiler", energyEntityId: "sensor.boiler_energy",
                }),
            ],
        }),
    ],
    uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
});

declare global {
    interface Window {
        __deviceCardHass: any;
        /** Hand every card a new hass with `changes` merged into its states. */
        __push: (changes: Record<string, unknown>) => void;
    }
}

async function setup(page: Page): Promise<void> {
    await loadBundle(page, "helman-device-card");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((tree) => {
        (window as any).loadCardHelpers = async () => ({ createCardElement: () => document.createElement("div") });
        const state = (value: string, attributes: Record<string, unknown> = {}) => ({ state: value, attributes });
        const watts = (value: string) => state(value, { unit_of_measurement: "W" });
        window.__deviceCardHass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC", unit_system: { temperature: "°C" } },
            user: { is_admin: false },
            formatEntityState: (stateObj: any) => stateObj.state,
            // HA's display: a climate temperature in the locale's number format with its unit.
            formatEntityAttributeValue: (stateObj: any, attribute: string) => {
                const value = stateObj.attributes[attribute];
                if (typeof value === "number") return `${new Intl.NumberFormat("en").format(value)} °C`;
                return ({ heating: "Heating" } as Record<string, string>)[value] ?? value;
            },
            states: {
                "sensor.solar": watts("3400"),
                "sensor.solar_today": state("12.1", { unit_of_measurement: "kWh" }),
                "sensor.grid": watts("200"),
                "sensor.house": watts("2000"),
                "sensor.ev_power": watts("7200"),
                "sensor.ev_energy": state("100", { unit_of_measurement: "kWh" }),
                "switch.ev_charge": state("on"),
                "select.ev_run_mode": state("charging"),
                "sensor.heat_pump_power": watts("850"),
                "sensor.heat_pump_energy": state("40", { unit_of_measurement: "kWh" }),
                "climate.heat_pump": state("heat", { temperature: 21, current_temperature: 20.5, hvac_action: "heating" }),
                "sensor.boiler_power": watts("1200"),
                "sensor.boiler_energy": state("10", { unit_of_measurement: "kWh" }),
                "switch.boiler": state("on"),
                "sensor.unrelated": watts("1"),
            },
        };
        const router = window.__mockHass({
            "helman/get_device_tree": async () => tree,
            "helman/get_history": async () => ({ entity_history: {} }),
            "recorder/statistic_during_period": { change: 3.5 },
            "helman/get_node_detail": async (request: any) => {
                if (request.node !== "ev_charger" || request.section) throw new Error("no fixture");
                const runMode = window.__deviceCardHass.states["select.ev_run_mode"].state;
                return {
                    node: "ev_charger", deviceId: request.device_id, asOf: "2026-10-21T12:00:00+00:00", profile: null, sections: [],
                    entities: { power: "sensor.ev_power", run_mode: "select.ev_run_mode" },
                    // An unavailable run mode resolves no status, as the backend's run_mode_condition reads it.
                    status: runMode === "unavailable" ? null
                        : { kind: runMode === "charging" ? "charging" : "waiting", runMode, entityId: "select.ev_run_mode" },
                };
            },
        });
        window.__deviceCardHass = { ...window.__deviceCardHass, ...router };
        window.__push = (changes) => {
            window.__deviceCardHass = { ...window.__deviceCardHass, states: { ...window.__deviceCardHass.states, ...changes } };
            for (const card of document.querySelectorAll("helman-device-card")) (card as any).hass = window.__deviceCardHass;
        };
    }, TREE);
}

async function mount(page: Page, config: Record<string, unknown>): Promise<void> {
    await page.evaluate((config) => {
        const card = document.createElement("helman-device-card") as any;
        card.setConfig({ type: "custom:helman-device-card", ...config });
        card.hass = window.__deviceCardHass;
        document.body.appendChild(card);
    }, config);
}

const line = (page: Page) => page.locator("helman-device-card .line");

test("an EV charger reads its charging status and power, and collapses to its idle status when the run mode stops charging", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.ev_energy", fields: ["state", "power"], hide_when_idle: ["power"] });
    await expect(page.locator("helman-device-card .name")).toHaveText("Garage EV");
    await expect(line(page)).toHaveText("charging now · 7.2 kW");

    const overviewReads = () => page.evaluate(() => window.__mockRequests.filter((request) => request.type === "helman/get_node_detail").length);
    const before = await overviewReads();
    await page.evaluate(() => window.__push({ "select.ev_run_mode": { state: "waiting_for_car", attributes: {} } }));
    await expect(line(page)).toHaveText("waiting");
    expect(await overviewReads()).toBe(before + 1);
});

test("an EV charger whose run mode resolved no status still reads it again when the run mode comes back", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.__push({ "select.ev_run_mode": { state: "unavailable", attributes: {} } }));
    await mount(page, { device: "sensor.ev_energy", fields: ["state", "power"], hide_when_idle: ["power"] });
    await expect(line(page)).toHaveText("idle");

    await page.evaluate(() => window.__push({ "select.ev_run_mode": { state: "charging", attributes: {} } }));
    await expect(line(page)).toHaveText("charging now · 7.2 kW");
});

test("a climate device shows its mode, set temperature and power", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.heat_pump_energy", name: "HP", fields: ["state", "target_temperature", "power"] });
    await expect(page.locator("helman-device-card .name")).toHaveText("HP");
    await expect(line(page)).toHaveText("Heating · 21 °C · 850 W");
});

test("a climate temperature reads in HA's number format, never a raw float", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.heat_pump_energy", fields: ["current_temperature"] });
    await expect(line(page)).toHaveText("20.5 °C");
    await page.evaluate(() => window.__push({ "climate.heat_pump": { state: "heat", attributes: { temperature: 21, current_temperature: 21.299999, hvac_action: "heating" } } }));
    await expect(line(page)).toHaveText("21.3 °C");
});

test("a device's energy today is the recorder's change since midnight", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["state", "energy_today"] });
    await expect(line(page)).toHaveText("on · 3.5 kWh");
});

test("a device's energy today is read again when the day changes, though its meter does not", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-21T23:59:50Z") });
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["energy_today"] });
    await expect(line(page)).toHaveText("3.5 kWh");

    await page.evaluate(() => window.__setMockReply(window.__deviceCardHass, "recorder/statistic_during_period", { change: 0.2 }));
    // The host's periodic history tick updates the idle tile past midnight.
    await page.clock.runFor(15_000);
    await expect(line(page)).toHaveText("0.20 kWh");
});

test("the solar node shows its power and today's energy", async ({ page }) => {
    await setup(page);
    await mount(page, { node: "solar", fields: ["power", "energy_today"] });
    await expect(page.locator("helman-device-card .name")).toHaveText("Solar");
    await expect(page.locator("helman-device-card simple-card-solar")).toHaveCount(1);
    await expect(line(page)).toHaveText("3.4 kW · 12 kWh");
});

test("a field the target does not offer renders nothing", async ({ page }) => {
    await setup(page);
    await mount(page, { node: "solar", fields: ["soc", "power", "target_temperature"] });
    await expect(line(page)).toHaveText("3.4 kW");
});

test("every field hidden while idle leaves the target's idle state", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["power"], hide_when_idle: ["power"] });
    await expect(line(page)).toHaveText("1.2 kW");
    await page.evaluate(() => window.__push({ "switch.boiler": { state: "off", attributes: {} } }));
    await expect(line(page)).toHaveText("off");
});

test("a target whose readings are all unavailable says so, never an empty line", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["power"] });
    await expect(line(page)).toHaveText("1.2 kW");
    await page.evaluate(() => window.__push({ "sensor.boiler_power": { state: "unavailable", attributes: {} } }));
    await expect(line(page)).toHaveText("unavailable");
});

test("an unknown device shows a warning naming it", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.gone", fields: ["power"] });
    await expect(page.locator("helman-device-card ha-alert")).toContainText("sensor.gone");
});

test("a config without a target asks for one", async ({ page }) => {
    await setup(page);
    await mount(page, {});
    await expect(page.locator("helman-device-card ha-alert")).toHaveText("Pick a device or an energy node for this card.");
    await expect(page.locator("helman-device-card ha-card")).toHaveCount(0);
});

test("setConfig refuses fields that are not a list", async ({ page }) => {
    await setup(page);
    const error = await page.evaluate(() => {
        try {
            (document.createElement("helman-device-card") as any).setConfig({ type: "custom:helman-device-card", device: "x", fields: "state" });
            return null;
        } catch (e) { return String(e); }
    });
    expect(error).toContain("fields must be a list");
});

test("setConfig refuses both a device and a node", async ({ page }) => {
    await setup(page);
    const error = await page.evaluate(() => {
        try {
            (document.createElement("helman-device-card") as any).setConfig({ type: "custom:helman-device-card", device: "x", node: "solar" });
            return null;
        } catch (e) { return String(e); }
    });
    expect(error).toContain("not both");
});

test("tapping the tile opens the device's helman detail", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["power"] });
    await expect(line(page)).toHaveText("1.2 kW");
    await page.locator("helman-device-card ha-card").click();
    const dialog = page.locator("helman-device-card node-detail-dialog ha-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveJSProperty("heading", "Boiler");
});

async function countRenders(page: Page): Promise<() => Promise<number>> {
    await page.evaluate(() => {
        const card = document.querySelector("helman-device-card") as any;
        const render = card.render.bind(card);
        card.__renders = 0;
        card.render = () => { card.__renders++; return render(); };
    });
    return () => page.evaluate(() => (document.querySelector("helman-device-card") as any).__renders as number);
}

test("the house tile does not re-render when only an appliance's power changes", async ({ page }) => {
    await setup(page);
    await mount(page, { node: "house", fields: ["power"] });
    await expect(line(page)).toHaveText("2.0 kW");
    const renders = await countRenders(page);
    await page.evaluate(() => window.__push({ "sensor.boiler_power": { state: "900", attributes: { unit_of_measurement: "W" } } }));
    await page.evaluate(() => (document.querySelector("helman-device-card") as any).updateComplete);
    expect(await renders()).toBe(0);
    await page.evaluate(() => window.__push({ "sensor.house": { state: "2500", attributes: { unit_of_measurement: "W" } } }));
    await expect(line(page)).toHaveText("2.5 kW");
});

test("the icon tint follows the device's state even when no field reads it", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["energy_today"] });
    await expect(page.locator("helman-device-card .icon")).toHaveClass("icon active");
    await page.evaluate(() => window.__push({ "switch.boiler": { state: "off", attributes: {} } }));
    await expect(page.locator("helman-device-card .icon")).toHaveClass("icon");
});

test("a hass push touching only unrelated entities does not re-render the tile", async ({ page }) => {
    await setup(page);
    await mount(page, { device: "sensor.boiler_energy", fields: ["state", "power"] });
    await expect(line(page)).toHaveText("on · 1.2 kW");
    await page.evaluate(() => {
        const card = document.querySelector("helman-device-card") as any;
        const render = card.render.bind(card);
        card.__renders = 0;
        card.render = () => { card.__renders++; return render(); };
    });
    const renders = () => page.evaluate(() => (document.querySelector("helman-device-card") as any).__renders as number);

    for (let i = 2; i <= 10; i++) {
        await page.evaluate((i) => window.__push({ "sensor.unrelated": { state: String(i), attributes: { unit_of_measurement: "W" } } }), i);
    }
    await page.evaluate(() => (document.querySelector("helman-device-card") as any).updateComplete);
    expect(await renders()).toBe(0);

    await page.evaluate(() => window.__push({ "sensor.boiler_power": { state: "900", attributes: { unit_of_measurement: "W" } } }));
    await expect(line(page)).toHaveText("on · 900 W");
    expect(await renders()).toBeGreaterThan(0);
});

test("the editor offers only the picked target's fields, and a new target drops the fields it does not offer", async ({ page }) => {
    await setup(page);
    const editor = await page.evaluateHandle(() => {
        const element = (customElements.get("helman-device-card") as any).getConfigElement();
        element.hass = window.__deviceCardHass;
        element.setConfig({ type: "custom:helman-device-card", device: "sensor.heat_pump_energy", fields: ["state", "power"], hide_when_idle: ["power"] });
        (window as any).__configs = [];
        element.addEventListener("config-changed", (event: CustomEvent) => (window as any).__configs.push(event.detail.config));
        document.body.appendChild(element);
        return element;
    });
    const form = page.locator("helman-device-card-editor ha-form");
    const options = (name: string) => form.evaluate((element: any, name) =>
        element.schema.find((field: any) => field.name === name).selector.select.options.map((option: any) => option.value), name);
    await expect.poll(() => options("fields")).toEqual(["state", "power", "energy_today", "target_temperature", "current_temperature"]);
    expect(await options("hide_when_idle")).toEqual(["state", "power"]);
    expect(await options("target")).toEqual([
        "node:solar", "node:grid", "node:house", "device:sensor.ev_energy", "device:sensor.heat_pump_energy", "device:sensor.boiler_energy",
    ]);

    await form.evaluate((element) => element.dispatchEvent(new CustomEvent("value-changed", {
        detail: { value: { target: "node:solar", fields: ["state", "power", "target_temperature"], hide_when_idle: ["power", "state"] } },
    })));
    const config = await page.evaluate(() => (window as any).__configs.at(-1));
    expect(config).toEqual({ type: "custom:helman-device-card", node: "solar", fields: ["power"], hide_when_idle: ["power"] });

    await editor.evaluate((element: any, config) => element.setConfig(config), config);
    await expect.poll(() => options("fields")).toEqual(["power", "energy_today"]);
});

test("the editor keeps the keys it does not own, and keeps the fields of a target it cannot find", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
        const element = (customElements.get("helman-device-card") as any).getConfigElement();
        element.hass = window.__deviceCardHass;
        element.setConfig({ type: "custom:helman-device-card", device: "sensor.gone", fields: ["power", "energy_today"],
            grid_options: { columns: 12, rows: 2 }, visibility: [{ condition: "screen" }] });
        (window as any).__configs = [];
        element.addEventListener("config-changed", (event: CustomEvent) => (window as any).__configs.push(event.detail.config));
        document.body.appendChild(element);
    });
    const form = page.locator("helman-device-card-editor ha-form");
    await expect(form).toHaveCount(1);
    await expect.poll(() => form.evaluate((element: any) => element.schema.length)).toBeGreaterThan(0);
    await form.evaluate((element) => element.dispatchEvent(new CustomEvent("value-changed", {
        detail: { value: { target: "device:sensor.gone", name: "Old", fields: ["power", "energy_today"], hide_when_idle: [] } },
    })));
    expect(await page.evaluate(() => (window as any).__configs.at(-1))).toEqual({
        type: "custom:helman-device-card", device: "sensor.gone", name: "Old", fields: ["power", "energy_today"],
        grid_options: { columns: 12, rows: 2 }, visibility: [{ condition: "screen" }],
    });
});
