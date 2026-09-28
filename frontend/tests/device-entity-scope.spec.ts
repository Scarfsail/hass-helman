import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * A device's pickers default to the HA device its entities belong to (#353).
 *
 * When a device's own meter, power sensor and switch, charge or climate
 * control resolve to exactly one HA device, the Identity section names it and
 * each of those pickers offers only the HA device its *other* anchors resolve
 * to, plus its own value, so a value never locks its own picker. A per-device
 * switch lifts the filter. Nothing about it is saved.
 *
 * The filter is read off each rendered `ha-entity-picker` and run here on
 * fixture states, as `sensor-kind-pickers.spec.ts` does.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const CONFIG = {
    config_version: 25,
    devices: {
        consumers: [
            {
                id: "breaker",
                consumption: { energy_entity_id: "sensor.a_energy", power_entity_id: "sensor.a_power" },
                controls: { switch: { entity_id: "switch.a" } },
                children: [{ id: "lamp", controls: { switch: { entity_id: "light.c" } } }],
            },
            {
                // A helper meter with no HA device: the switch alone decides.
                id: "heater",
                consumption: { energy_entity_id: "sensor.helper_energy" },
                controls: { switch: { entity_id: "switch.b" } },
            },
            {
                id: "split",
                consumption: { energy_entity_id: "sensor.d_energy" },
                controls: { switch: { entity_id: "switch.e" } },
            },
            {
                id: "unregistered",
                consumption: { energy_entity_id: "sensor.helper_energy_2" },
            },
            {
                kind: "ev_charger",
                schedulable: true,
                id: "ev",
                limits: { max_charging_power_kw: 11 },
                controls: {
                    charge: { entity_id: "switch.ev_charge" },
                    use_mode: { entity_id: "select.ev_mode" },
                },
                consumption: { energy_entity_id: "sensor.ev_energy" },
            },
        ],
    },
};

const ENTITIES: Record<string, { device_id: string | null }> = {
    "sensor.a_energy": { device_id: "dev_a" },
    "sensor.a_power": { device_id: "dev_a" },
    "switch.a": { device_id: "dev_a" },
    "sensor.b_energy": { device_id: "dev_b" },
    "sensor.b_power": { device_id: "dev_b" },
    "switch.b": { device_id: "dev_b" },
    "sensor.helper_energy": { device_id: null },
    "light.c": { device_id: "dev_c" },
    "sensor.d_energy": { device_id: "dev_d" },
    "switch.e": { device_id: "dev_e" },
    "sensor.ev_energy": { device_id: "dev_ev" },
    "switch.ev_charge": { device_id: "dev_ev" },
    "select.ev_mode": { device_id: "dev_other" },
};

const DEVICES = {
    dev_a: { name: "Breaker box", name_by_user: null },
    dev_b: { name: "Heater plug", name_by_user: "My heater" },
    dev_c: { name: "Lamp", name_by_user: null },
    dev_d: { name: "Meter D", name_by_user: null },
    dev_e: { name: "Plug E", name_by_user: null },
    dev_ev: { name: "Wallbox", name_by_user: null },
    dev_other: { name: "EVCC", name_by_user: null },
};

const FIXTURES = [
    { entity_id: "sensor.a_energy", attributes: { device_class: "energy" } },
    { entity_id: "sensor.a_power", attributes: { device_class: "power" } },
    { entity_id: "switch.a", attributes: {} },
    { entity_id: "sensor.b_energy", attributes: { device_class: "energy" } },
    { entity_id: "sensor.b_power", attributes: { device_class: "power" } },
    { entity_id: "switch.b", attributes: {} },
    { entity_id: "sensor.helper_energy", attributes: { device_class: "energy" } },
    { entity_id: "light.c", attributes: {} },
    { entity_id: "sensor.d_energy", attributes: { device_class: "energy" } },
    { entity_id: "switch.e", attributes: {} },
    { entity_id: "sensor.ev_energy", attributes: { device_class: "energy" } },
    { entity_id: "switch.ev_charge", attributes: {} },
    { entity_id: "select.ev_mode", attributes: {} },
];

const ALL = FIXTURES.map((state) => state.entity_id);
/** What the sensor-kind filters alone admit of the fixtures. */
const NON_SENSORS = ALL.filter((id) => !id.startsWith("sensor."));
const ENERGY_ONLY = ALL.filter(
    (id) => !id.startsWith("sensor.") || FIXTURES.find((s) => s.entity_id === id)!.attributes.device_class === "energy",
);

declare global {
    interface Window {
        __admits: (picker: Element) => string[];
    }
}

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));
    await page.evaluate(
        ({ config, fixtures, entities, devices }) => {
            window.__admits = (picker) => {
                const { entityFilter } = picker as Element & { entityFilter?: (state: unknown) => boolean };
                return fixtures
                    .filter((state) => !entityFilter || entityFilter(state))
                    .map((state) => state.entity_id);
            };
            const element = document.createElement("helman-config-editor-panel") as HTMLElement &
                Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                states: {},
                entities,
                devices,
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") return JSON.parse(JSON.stringify(config));
                    if (request.type === "helman/get_optimizer_schema") return { version: 2, kinds: [] };
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/validate_config") {
                        return { valid: true, errors: [], warnings: [] };
                    }
                    if (request.type === "helman/inspect_entities") return { results: [] };
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config: CONFIG, fixtures: FIXTURES, entities: ENTITIES, devices: DEVICES },
    );
    await page
        .locator("helman-config-editor-panel")
        .locator(".tabs")
        .getByRole("button", { name: "Devices", exact: true })
        .click();
    await expect(page.locator("helman-config-editor-panel helman-device-editor").first()).toBeAttached();
}

/** What each group's picker admits of the fixtures, by the group's key. */
function pickers(page: Page): Promise<Record<string, string[]>> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")!.shadowRoot!;
        return Object.fromEntries(
            Array.from(root.querySelectorAll("helman-entity-group")).map((group) => [
                (group as Element & { key: string }).key,
                window.__admits(group.shadowRoot!.querySelector("ha-entity-picker")!),
            ]),
        );
    });
}

/** The HA device name each device card shows, or null where it shows none. */
function haDeviceNames(page: Page): Promise<Record<string, string | null>> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")!.shadowRoot!;
        return Object.fromEntries(
            Array.from(root.querySelectorAll<HTMLElement>("details.device-card")).map((card) => {
                const field = card.querySelector(":scope > .appliance-body .ha-device-name") as HTMLInputElement | null;
                return [card.dataset.deviceId, field ? field.value : null];
            }),
        );
    });
}

/** Flip a device's "show entities from all devices" switch. */
async function showAllDevices(page: Page, deviceId: string, checked: boolean): Promise<void> {
    await page.evaluate(
        ({ deviceId, checked }) => {
            const root = document.querySelector("helman-config-editor-panel")!.shadowRoot!;
            const card = root.querySelector(`details.device-card[data-device-id="${deviceId}"]`)!;
            const toggle = card.querySelector(":scope > .appliance-body .ha-device-show-all") as HTMLElement & {
                checked: boolean;
            };
            toggle.checked = checked;
            toggle.dispatchEvent(new Event("change"));
        },
        { deviceId, checked },
    );
}

test("a device's anchor pickers offer only its HA device's entities and their own value", async ({ page }) => {
    await mountEditor(page);

    expect(await haDeviceNames(page)).toEqual({
        breaker: "Breaker box",
        lamp: "Lamp",
        heater: "My heater",
        split: null,
        unregistered: null,
        ev: "Wallbox",
    });

    const offered = await pickers(page);
    // The energy and power pickers keep their sensor kind as well.
    expect(offered["devices.consumers.0.consumption.energy_entity_id"]).toEqual(["sensor.a_energy", "switch.a"]);
    expect(offered["devices.consumers.0.consumption.power_entity_id"]).toEqual(["sensor.a_power", "switch.a"]);
    expect(offered["devices.consumers.0.controls.switch.entity_id"]).toEqual([
        "sensor.a_energy",
        "sensor.a_power",
        "switch.a",
    ]);
    // A child resolves from its own anchors, not its parent's. Its switch is
    // its only anchor, so it narrows the meter but not the switch itself.
    expect(offered["devices.consumers.0.children.0.consumption.energy_entity_id"]).toEqual(["light.c"]);
    expect(offered["devices.consumers.0.children.0.controls.switch.entity_id"]).toEqual(ALL);
    // The helper meter doesn't block the switch, and still admits itself.
    expect(offered["devices.consumers.1.consumption.energy_entity_id"]).toEqual([
        "sensor.b_energy",
        "switch.b",
        "sensor.helper_energy",
    ]);
    // The switch's own value doesn't lock it: the helper meter names no device.
    expect(offered["devices.consumers.1.controls.switch.entity_id"]).toEqual(ALL);
    // Anchors under two HA devices, or none: no device filter.
    expect(offered["devices.consumers.2.consumption.energy_entity_id"]).toEqual(ENERGY_ONLY);
    expect(offered["devices.consumers.2.controls.switch.entity_id"]).toEqual(ALL);
    expect(offered["devices.consumers.3.consumption.energy_entity_id"]).toEqual(ENERGY_ONLY);
    // The EV charger's charge switch is narrowed; its use-mode select is not.
    expect(offered["devices.consumers.4.controls.charge.entity_id"]).toEqual(["sensor.ev_energy", "switch.ev_charge"]);
    expect(offered["devices.consumers.4.controls.use_mode.entity_id"]).toEqual(ALL);

    // The add-child picker is not narrowed either.
    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".add-device").first().dispatchEvent("click");
    const addChild = await panel
        .locator(".add-device-picker ha-entity-picker")
        .evaluate((picker) => window.__admits(picker));
    expect(addChild).toEqual(ENERGY_ONLY);
    expect(NON_SENSORS.every((id) => addChild.includes(id))).toBe(true);
});

test("show entities from all devices lifts the device filter, keeps the name, and is never saved", async ({
    page,
}) => {
    await mountEditor(page);
    const edits = await page.evaluate(() => {
        (window as any).__edits = 0;
        const root = document.querySelector("helman-config-editor-panel")!.shadowRoot!;
        root.querySelectorAll("helman-device-editor").forEach((editor) =>
            editor.addEventListener("device-config-changed", () => (window as any).__edits++),
        );
        return (window as any).__edits as number;
    });

    await showAllDevices(page, "breaker", true);
    await expect
        .poll(async () => (await pickers(page))["devices.consumers.0.consumption.energy_entity_id"])
        .toEqual(ENERGY_ONLY);
    const offered = await pickers(page);
    expect(offered["devices.consumers.0.controls.switch.entity_id"]).toEqual(ALL);
    // Only this device: its child and its siblings stay narrowed.
    expect(offered["devices.consumers.0.children.0.consumption.energy_entity_id"]).toEqual(["light.c"]);
    expect(offered["devices.consumers.1.consumption.energy_entity_id"]).toEqual([
        "sensor.b_energy",
        "switch.b",
        "sensor.helper_energy",
    ]);
    expect((await haDeviceNames(page)).breaker).toBe("Breaker box");
    expect(await page.evaluate(() => (window as any).__edits)).toBe(edits);

    await showAllDevices(page, "breaker", false);
    await expect
        .poll(async () => (await pickers(page))["devices.consumers.0.consumption.energy_entity_id"])
        .toEqual(["sensor.a_energy", "switch.a"]);

    // A reload starts filtered again.
    await showAllDevices(page, "breaker", true);
    await mountEditor(page);
    expect((await pickers(page))["devices.consumers.0.consumption.energy_entity_id"]).toEqual([
        "sensor.a_energy",
        "switch.a",
    ]);
});

test("a removed device's switch does not carry over to the device taking its place", async ({ page }) => {
    await mountEditor(page);
    await showAllDevices(page, "breaker", true);
    page.on("dialog", (dialog) => dialog.accept());
    await page
        .locator('helman-config-editor-panel details.device-card[data-device-id="breaker"] > summary button.danger')
        .first()
        .dispatchEvent("click");
    await expect.poll(async () => Object.keys(await haDeviceNames(page))).not.toContain("breaker");

    expect((await pickers(page))["devices.consumers.0.consumption.energy_entity_id"]).toEqual([
        "sensor.b_energy",
        "switch.b",
        "sensor.helper_energy",
    ]);
});

test("a picker's filter keeps its identity across hass updates", async ({ page }) => {
    await mountEditor(page);
    const same = await page.evaluate(async () => {
        const panel = document.querySelector("helman-config-editor-panel") as HTMLElement & {
            hass: Record<string, unknown>;
            updateComplete: Promise<unknown>;
        };
        const groups = () =>
            Array.from(panel.shadowRoot!.querySelectorAll("helman-entity-group")).filter((group) =>
                (group as Element & { key: string }).key.startsWith("devices.consumers.0."),
            ) as (Element & { hass: unknown; updateComplete: Promise<unknown> })[];
        const filterOf = (group: Element) =>
            (group.shadowRoot!.querySelector("ha-entity-picker") as Element & { entityFilter?: unknown })
                .entityFilter;
        const before = groups().map(filterOf);
        // A state update: a new hass and new states, the same registries.
        const hass = { ...panel.hass, states: { "sensor.a_power": { state: "5" } } };
        panel.hass = hass;
        await panel.updateComplete;
        await Promise.all(groups().map((group) => group.updateComplete));
        return {
            rerendered: groups().every((group) => group.hass === hass),
            filters: before.filter((filter) => typeof filter === "function").length,
            same: groups().map(filterOf).every((filter, index) => filter === before[index]),
        };
    });
    // The breaker's energy, power and switch, and its child's energy and power.
    expect(same).toEqual({ rerendered: true, filters: 5, same: true });
});
