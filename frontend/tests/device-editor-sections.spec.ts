import { test, expect, type Locator, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";

/**
 * A device card's sections (#389).
 *
 * Every section of a device starts collapsed, in the config panel's Devices
 * tab and in the card's device edit dialog, and its summary carries chips
 * that say what is inside. A section holding a validation issue opens by
 * itself; fixing the issue never closes it, and one the reader closes stays
 * closed until a new issue appears in it.
 *
 * The fixture: a generic heater with both meters, a schedulable boiler on
 * history average, an AC breaker whose climate children draw from its meter,
 * and an EV charger with use modes, eco gears and a vehicle.
 */

const EDITOR_BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);
const CARD_BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const HEATER = {
    id: "heater",
    name: "Heater",
    controls: { switch: { entity_id: "switch.heater" } },
    consumption: { energy_entity_id: "sensor.heater_energy", power_entity_id: "sensor.heater_power" },
};

const BOILER = {
    id: "boiler",
    name: "Boiler",
    schedulable: true,
    controls: { switch: { entity_id: "switch.boiler" } },
    consumption: {
        energy_entity_id: "sensor.boiler_energy",
        projection: { strategy: "history_average", hourly_energy_kwh: 2, lookback_days: 30 },
    },
};

const klima = (id: string) => ({
    id,
    kind: "climate",
    schedulable: true,
    controls: { climate: { entity_id: `climate.${id}` } },
    consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 0.5 } },
});

const BREAKER = {
    id: "breaker",
    name: "AC breaker",
    consumption: { energy_entity_id: "sensor.breaker_energy", power_entity_id: "sensor.breaker_power" },
    children: [klima("klima_obyvak"), klima("klima_loznice")],
};

const WALLBOX = {
    id: "wallbox",
    name: "Wallbox",
    kind: "ev_charger",
    schedulable: true,
    consumption: { energy_entity_id: "sensor.wallbox_energy" },
    controls: {
        charge: { entity_id: "switch.wallbox" },
        use_mode: {
            entity_id: "select.wallbox_mode",
            values: { fast: { behavior: "fixed_max_power" }, solar: { behavior: "surplus_aware" } },
        },
        eco_gear: { entity_id: "select.wallbox_gear", values: { "6A": { min_power_kw: 1.4 } } },
    },
    limits: { max_charging_power_kw: 11 },
    vehicles: [
        {
            id: "car",
            name: "Car",
            telemetry: { soc_entity_id: "sensor.car_soc" },
            limits: { battery_capacity_kwh: 60, max_charging_power_kw: 11 },
        },
    ],
};

const VALID = { valid: true, errors: [], warnings: [] };

const INVERTER = {
    kind: "inverter",
    id: "inverter",
    name: "Inverter",
    controls: {
        mode: {
            entity_id: "select.solax_charger_use_mode",
            options: { normal: "Self Use", stop_export: "Feedin Priority" },
        },
    },
};

type Device = Record<string, any>;

declare global {
    interface Window {
        __editorConfig: () => { devices: { consumers: Device[] } };
        __validation: unknown;
    }
}

async function mountEditor(
    page: Page,
    consumers: unknown[],
    validation: unknown = VALID,
    system: unknown[] = [],
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: EDITOR_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, report }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            window.__editorConfig = () => (element as unknown as { _config: any })._config;
            window.__validation = report;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") return JSON.parse(JSON.stringify(config));
                    if (request.type === "helman/get_optimizer_schema") return { version: 2, kinds: [] };
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/validate_config") return window.__validation;
                    if (request.type === "helman/inspect_entities") {
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft: { entityId: null, status: "ok", facts: [] },
                                saved: null,
                            })),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config: { config_version: 26, devices: { consumers, system } }, report: validation },
    );

    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: "Devices", exact: true }).click();
    await panel
        .locator("details.section-card", {
            has: page.locator(":scope > summary .section-summary-label", { hasText: "Consumers" }),
        })
        .evaluate((details) => ((details as HTMLDetailsElement).open = true));
}

/** A card's own sections, in order: label, whether open, and the summary's chips. */
const sections = (root: Locator, id: string) =>
    root
        .locator(`details.device-card[data-device-id="${id}"] > .appliance-body > details.section-card`)
        .evaluateAll((all) =>
            all.map((details) => ({
                label: details.querySelector(":scope > summary .section-summary-label")?.textContent?.trim(),
                open: (details as HTMLDetailsElement).open,
                chips: Array.from(details.querySelectorAll(":scope > summary .device-badge")).map((chip) =>
                    chip.textContent?.trim(),
                ),
            })),
        );

/** The labels of a card's open sections. */
const openSections = async (root: Locator, id: string) =>
    (await sections(root, id)).filter((section) => section.open).map((section) => section.label);

const panel = (page: Page) => page.locator("helman-config-editor-panel");

async function validate(page: Page, report: unknown): Promise<void> {
    await page.evaluate((next) => (window.__validation = next), report);
    await panel(page).locator(".actions button", { hasText: "Validate" }).click();
}

const issue = (path: string, message: string) => ({ section: "devices", path, code: "x", message });

test("every section of a device starts collapsed, with chips summarizing it", async ({ page }) => {
    await mountEditor(page, [HEATER, BOILER, BREAKER, WALLBOX]);
    await expect(panel(page).locator("details.device-card")).toHaveCount(6);

    expect(await sections(panel(page), "heater")).toEqual([
        { label: "Identity", open: false, chips: ["Generic"] },
        { label: "Measurements", open: false, chips: ["Energy", "Power"] },
        { label: "Controls", open: false, chips: ["Switch"] },
        { label: "Children", open: false, chips: [] },
    ]);
    expect(await sections(panel(page), "boiler")).toEqual([
        { label: "Identity", open: false, chips: ["Generic"] },
        { label: "Measurements", open: false, chips: ["Energy"] },
        { label: "Controls", open: false, chips: ["Switch", "Schedulable"] },
        { label: "Projection", open: false, chips: ["History average", "2 kWh/h"] },
    ]);
    expect(await sections(panel(page), "breaker")).toEqual([
        { label: "Identity", open: false, chips: ["Generic"] },
        { label: "Measurements", open: false, chips: ["Energy", "Power"] },
        { label: "Controls", open: false, chips: [] },
        { label: "Children", open: false, chips: ["2"] },
    ]);
    expect(await sections(panel(page), "klima_obyvak")).toEqual([
        { label: "Identity", open: false, chips: ["Climate"] },
        { label: "Measurements", open: false, chips: ["Parent meter"] },
        { label: "Controls", open: false, chips: ["Switch", "Schedulable"] },
        { label: "Projection", open: false, chips: ["Fixed", "0.5 kWh/h"] },
    ]);
    expect(await sections(panel(page), "wallbox")).toEqual([
        { label: "Identity", open: false, chips: ["EV charger"] },
        { label: "Measurements", open: false, chips: ["Energy"] },
        { label: "Controls", open: false, chips: ["Switch", "Schedulable"] },
        { label: "Use modes", open: false, chips: ["2"] },
        { label: "Eco gears", open: false, chips: ["1"] },
        { label: "Vehicles", open: false, chips: ["1"] },
    ]);
});

test("a reader's toggle survives a re-render", async ({ page }) => {
    await mountEditor(page, [HEATER]);
    await panel(page)
        .locator('details.device-card[data-device-id="heater"]')
        .evaluate((card) => ((card as HTMLDetailsElement).open = true));
    const identity = panel(page).locator(
        'details.device-card[data-device-id="heater"] > .appliance-body > details.section-card',
        { has: page.locator(":scope > summary .section-summary-label", { hasText: "Identity" }) },
    );
    await identity.evaluate((details) => ((details as HTMLDetailsElement).open = true));
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Identity"]);

    const name = identity.locator(".field input").first();
    await name.fill("Radiator");
    await name.dispatchEvent("change");
    await expect.poll(() => page.evaluate(() => window.__editorConfig().devices.consumers[0].name)).toBe("Radiator");
    expect(await openSections(panel(page), "heater")).toEqual(["Identity"]);
});

test("a reorder does not hand a device another device's open sections", async ({ page }) => {
    await mountEditor(page, [HEATER, BOILER]);
    const heater = panel(page).locator('details.device-card[data-device-id="heater"]');
    await heater
        .locator(":scope > .appliance-body > details.section-card", {
            has: page.locator(":scope > summary .section-summary-label", { hasText: "Controls" }),
        })
        .evaluate((details) => ((details as HTMLDetailsElement).open = true));
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Controls"]);

    await heater.evaluate((card) => {
        card.closest("ha-sortable")!.dispatchEvent(new CustomEvent("item-moved", {
            detail: { oldIndex: 0, newIndex: 1 }, bubbles: true, composed: true,
        }));
    });
    await expect.poll(() => page.evaluate(() => window.__editorConfig().devices.consumers[0].id)).toBe("boiler");
    expect(await openSections(panel(page), "boiler")).toEqual([]);
});

test("a missing meter opens Measurements alone, and fixing it leaves it open", async ({ page }) => {
    const fridge = { id: "fridge", name: "Fridge" };
    await mountEditor(page, [fridge]);
    expect(await openSections(panel(page), "fridge")).toEqual([]);

    await validate(page, {
        valid: false,
        errors: [issue("devices.consumers[0].consumption.energy_entity_id", "fridge needs a meter")],
        warnings: [],
    });
    await expect.poll(() => openSections(panel(page), "fridge")).toEqual(["Measurements"]);

    await panel(page)
        .locator('details.device-card[data-device-id="fridge"] helman-entity-group')
        .evaluateAll((groups) => {
            const group = groups.find((element) =>
                (element as HTMLElement & { path: string[] }).path.includes("energy_entity_id"),
            );
            group?.shadowRoot?.querySelector("ha-entity-picker")?.dispatchEvent(
                new CustomEvent("value-changed", {
                    detail: { value: "sensor.fridge_energy" },
                    bubbles: true,
                    composed: true,
                }),
            );
        });
    await expect
        .poll(() => page.evaluate(() => window.__editorConfig().devices.consumers[0].consumption))
        .toEqual({ energy_entity_id: "sensor.fridge_energy" });
    await validate(page, VALID);
    await expect(panel(page).locator(".device-issues")).toHaveCount(0);
    expect(await openSections(panel(page), "fridge")).toEqual(["Measurements"]);
});

test("a section closed by hand stays closed until a new issue appears in it", async ({ page }) => {
    await mountEditor(page, [HEATER]);
    const measurements = issue("devices.consumers[0].consumption.power_entity_id", "power is odd");
    const controls = issue("devices.consumers[0].controls.switch", "switch is odd");

    await validate(page, { valid: false, errors: [], warnings: [measurements] });
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Measurements"]);

    await panel(page)
        .locator('details.device-card[data-device-id="heater"] > .appliance-body > details.section-card[open]')
        .evaluate((details) => ((details as HTMLDetailsElement).open = false));
    await expect.poll(() => openSections(panel(page), "heater")).toEqual([]);

    // The same issue again: nothing new, so the section stays closed.
    await validate(page, { valid: false, errors: [], warnings: [measurements] });
    await validate(page, { valid: false, errors: [controls], warnings: [measurements] });
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Controls"]);

    // Gone and back: a new issue in it opens it again.
    await validate(page, VALID);
    await validate(page, { valid: false, errors: [], warnings: [measurements] });
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Measurements", "Controls"]);

    // Closed again, then a second issue joins the one that persists: it opens.
    await panel(page)
        .locator('details.device-card[data-device-id="heater"] > .appliance-body > details.section-card[open]')
        .first()
        .evaluate((details) => ((details as HTMLDetailsElement).open = false));
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Controls"]);
    const energy = issue("devices.consumers[0].consumption.energy_entity_id", "energy is odd");
    await validate(page, { valid: false, errors: [energy], warnings: [measurements] });
    await expect.poll(() => openSections(panel(page), "heater")).toEqual(["Measurements", "Controls"]);
});

test("a broken child opens its parent's Children section", async ({ page }) => {
    await mountEditor(page, [BREAKER]);

    await validate(page, {
        valid: false,
        errors: [issue("devices.consumers[0].children[1].controls.climate", "loznice needs a climate entity")],
        warnings: [],
    });
    await expect.poll(() => openSections(panel(page), "breaker")).toEqual(["Children"]);
    expect(await openSections(panel(page), "klima_loznice")).toEqual(["Controls"]);
    expect(await openSections(panel(page), "klima_obyvak")).toEqual([]);
});

test("the device edit dialog shows every section collapsed, and no Children", async ({ page }) => {
    const config = {
        config_version: 26,
        devices: { consumers: [BREAKER] },
        automation: { enabled: true, appliance_optimizers: [], system_optimizers: [] },
    };
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("node-detail-device-content"));
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate((config) => {
        const content = document.createElement("node-detail-device-content") as any;
        content.localize = (key: string) => (key === "node_detail.device.edit.button" ? "Edit" : key);
        content.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            states: {},
            connection: { subscribeMessage: async () => () => undefined },
            callWS: async (request: any) => {
                if (request.type === "helman/get_config") return JSON.parse(JSON.stringify(config));
                if (request.type === "helman/inspect_entities") return { results: [] };
                return {};
            },
        };
        content.params = {
            nodeType: "device",
            item: { id: "breaker", name: "AC breaker", displayName: "AC breaker", deviceKey: "sensor.breaker_energy",
                deviceKeyIsMeter: true, children: [] },
        };
        document.body.appendChild(content);
    }, config);

    await page.locator("node-detail-device-content ha-button.edit").click();
    const dialog = page.locator("helman-device-edit-dialog");
    await expect(dialog.locator("details.device-card")).toHaveAttribute("open", "");
    await expect.poll(() => sections(dialog, "breaker")).toEqual([
        { label: "Identity", open: false, chips: ["Generic"] },
        { label: "Measurements", open: false, chips: ["Energy", "Power"] },
        { label: "Controls", open: false, chips: [] },
    ]);
});

/** The inverter card's sections, in order: label, whether open, and the summary's chips. */
const inverterSections = (page: Page) =>
    panel(page)
        .locator("details.inverter-card > .appliance-body > details.section-card")
        .evaluateAll((all) =>
            all.map((details) => ({
                label: details.querySelector(":scope > summary .section-summary-label")?.textContent?.trim(),
                open: (details as HTMLDetailsElement).open,
                chips: Array.from(details.querySelectorAll(":scope > summary .device-badge")).map((chip) =>
                    chip.textContent?.trim(),
                ),
            })),
        );

test("the inverter's sections start collapsed, with chips summarizing them", async ({ page }) => {
    await mountEditor(page, [HEATER], VALID, [INVERTER]);
    expect(await inverterSections(page)).toEqual([
        { label: "Identity", open: false, chips: ["Inverter"] },
        { label: "Controls", open: false, chips: ["Mode"] },
        { label: "Action options", open: false, chips: ["2"] },
    ]);
});

test("an inverter issue opens its section, and a closed one reopens only for a new issue", async ({ page }) => {
    await mountEditor(page, [HEATER], VALID, [{ ...INVERTER, controls: { mode: { options: {} } } }]);
    const open = async () =>
        (await inverterSections(page)).filter((section) => section.open).map((section) => section.label);
    expect((await inverterSections(page)).map((section) => section.chips)).toEqual([["Inverter"], [], []]);

    const mode = {
        section: "devices",
        path: "devices.system[0].controls.mode.entity_id",
        code: "required",
        message: "mode entity is required",
    };
    await validate(page, { valid: false, errors: [mode], warnings: [] });
    await expect.poll(open).toEqual(["Controls"]);

    await panel(page)
        .locator("details.inverter-card > .appliance-body > details.section-card[open]")
        .evaluate((details) => ((details as HTMLDetailsElement).open = false));
    await expect.poll(open).toEqual([]);
    await validate(page, { valid: false, errors: [mode], warnings: [] });
    const option = { ...mode, path: "devices.system[0].controls.mode.options.normal", code: "x" };
    await validate(page, { valid: false, errors: [mode, option], warnings: [] });
    await expect.poll(open).toEqual(["Action options"]);
});

test("an inverter added after a removed one starts with its sections collapsed", async ({ page }) => {
    await mountEditor(page, [HEATER], VALID, [INVERTER]);
    await panel(page)
        .locator("details.inverter-card > .appliance-body > details.section-card")
        .first()
        .evaluate((details) => ((details as HTMLDetailsElement).open = true));
    await expect.poll(async () => (await inverterSections(page))[0].open).toBe(true);

    page.on("dialog", (dialog) => dialog.accept());
    await panel(page).locator("details.inverter-card .list-actions button.danger").dispatchEvent("click");
    await expect(panel(page).locator("details.inverter-card")).toHaveCount(0);
    await panel(page).locator(".section-footer .add-button", { hasText: "Add inverter" }).dispatchEvent("click");
    await expect(panel(page).locator("details.inverter-card")).toHaveCount(1);
    expect((await inverterSections(page)).map((section) => section.open)).toEqual([false, false, false]);
});
