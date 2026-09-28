import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { SWITCH_CONTROL_DOMAINS } from "../cards/shared/config/devices";

/**
 * Sensor pickers offer the kind of sensor their field means (#354).
 *
 * An energy field offers energy sensors, a power field power sensors and a
 * SoC field battery-percentage sensors, matched by device class or by unit so
 * a template sensor without a class is not lost. Control pickers keep their
 * domains and get no filter: a switch may be a light, a child may be a climate.
 *
 * The filter is read off each rendered `ha-entity-picker` and run here on
 * fixture states; the picker itself is not loaded, so what it would list is
 * what `includeDomains` and `entityFilter` together admit.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const CONFIG = {
    config_version: 25,
    energy_nodes: {
        house: {
            entities: { power: "sensor.house_power" },
            forecast: { total_energy_entity_id: "sensor.house_energy" },
        },
        solar: {
            entities: { power: "sensor.solar_power", today_energy: "sensor.solar_today" },
            forecast: {
                total_energy_entity_id: "sensor.solar_energy",
                daily_energy_entity_ids: ["sensor.solar_day_0"],
            },
        },
        battery: {
            entities: {
                power: "sensor.battery_power",
                remaining_energy: "sensor.battery_remaining",
                capacity: "sensor.battery_capacity",
                min_soc: "sensor.battery_min_soc",
                max_soc: "sensor.battery_max_soc",
            },
        },
        grid: {
            entities: { power: "sensor.grid_power" },
            forecast: { sell_price_entity_id: "sensor.sell_price" },
        },
    },
    training: { solar_bias: { total_energy_entity_id: "sensor.solar_bias_energy" } },
    devices: {
        consumers: [
            {
                id: "breaker",
                consumption: {
                    energy_entity_id: "sensor.breaker_energy",
                    power_entity_id: "sensor.breaker_power",
                },
                children: [{ id: "lamp", controls: { switch: { entity_id: "light.lamp" } } }],
            },
            {
                kind: "ev_charger",
                schedulable: true,
                id: "ev",
                limits: { max_charging_power_kw: 11 },
                controls: { charge: { entity_id: "switch.ev_charge" } },
                vehicles: [{ id: "car", telemetry: { soc_entity_id: "sensor.car_soc" } }],
                consumption: { energy_entity_id: "sensor.ev_energy" },
            },
        ],
    },
};

/** One state per row of the match table, plus the ones no kind admits. */
const FIXTURES = [
    { entity_id: "sensor.class_energy", attributes: { device_class: "energy" } },
    { entity_id: "sensor.class_energy_storage", attributes: { device_class: "energy_storage" } },
    { entity_id: "sensor.unit_wh", attributes: { unit_of_measurement: "Wh" } },
    { entity_id: "sensor.unit_kwh", attributes: { unit_of_measurement: "kWh" } },
    { entity_id: "sensor.unit_mwh", attributes: { unit_of_measurement: "MWh" } },
    { entity_id: "sensor.unit_kwh_lower", attributes: { unit_of_measurement: "kwh" } },
    { entity_id: "sensor.unit_gwh", attributes: { unit_of_measurement: "GWh" } },
    { entity_id: "sensor.class_power", attributes: { device_class: "power" } },
    { entity_id: "sensor.unit_w", attributes: { unit_of_measurement: "W" } },
    { entity_id: "sensor.unit_kw", attributes: { unit_of_measurement: "kW" } },
    { entity_id: "sensor.unit_mw", attributes: { unit_of_measurement: "MW" } },
    { entity_id: "sensor.unit_kw_upper", attributes: { unit_of_measurement: "KW" } },
    { entity_id: "sensor.class_battery", attributes: { device_class: "battery" } },
    { entity_id: "sensor.unit_percent", attributes: { unit_of_measurement: "%" } },
    { entity_id: "sensor.temperature", attributes: { device_class: "temperature", unit_of_measurement: "°C" } },
    { entity_id: "sensor.bare", attributes: {} },
    { entity_id: "switch.x", attributes: {} },
    { entity_id: "light.hall", attributes: {} },
    { entity_id: "climate.x", attributes: {} },
];

const CONTROLS = ["switch.x", "light.hall", "climate.x"];
const ADMITS = {
    energy: [
        "sensor.class_energy",
        "sensor.class_energy_storage",
        "sensor.unit_wh",
        "sensor.unit_kwh",
        "sensor.unit_mwh",
        "sensor.unit_kwh_lower",
        "sensor.unit_gwh",
        ...CONTROLS,
    ],
    power: ["sensor.class_power", "sensor.unit_w", "sensor.unit_kw", "sensor.unit_mw", "sensor.unit_kw_upper", ...CONTROLS],
    soc: ["sensor.class_battery", "sensor.unit_percent", ...CONTROLS],
    none: FIXTURES.map((state) => state.entity_id),
};

type Picker = { includeDomains: string[] | undefined; admits: string[] };

declare global {
    interface Window {
        __fixtures: typeof FIXTURES;
        __describe: (picker: Element) => Picker;
    }
}

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));
    await page.evaluate(
        ({ config, fixtures }) => {
            window.__fixtures = fixtures;
            window.__describe = (picker) => {
                const { includeDomains, entityFilter } = picker as Element & {
                    includeDomains?: string[];
                    entityFilter?: (state: unknown) => boolean;
                };
                return {
                    includeDomains,
                    admits: fixtures
                        .filter((state) => !entityFilter || entityFilter(state))
                        .map((state) => state.entity_id),
                };
            };
            const element = document.createElement("helman-config-editor-panel") as HTMLElement &
                Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
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
        { config: CONFIG, fixtures: FIXTURES },
    );
}

/** Open a tab and every section in it, then describe each group's picker by its key. */
async function groupPickers(page: Page, tab: string): Promise<Record<string, Picker>> {
    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: tab, exact: true }).click();
    // Sections nest, and opening one can render another.
    await expect
        .poll(() =>
            page.evaluate(() => {
                const closed = Array.from(
                    document.querySelector("helman-config-editor-panel")?.shadowRoot?.querySelectorAll(
                        "details:not([open])",
                    ) ?? [],
                );
                closed.forEach((details) => details.setAttribute("open", ""));
                return closed.length;
            }),
        )
        .toBe(0);
    return page.evaluate(() => {
        const deepQuery = (root: ParentNode | null | undefined, selector: string): Element[] => {
            if (!root) return [];
            const found = Array.from(root.querySelectorAll(selector));
            for (const child of root.querySelectorAll("*")) {
                if (child.shadowRoot) found.push(...deepQuery(child.shadowRoot, selector));
            }
            return found;
        };
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Object.fromEntries(
            deepQuery(root, "helman-entity-group").map((group) => [
                (group as Element & { key: string }).key,
                window.__describe(group.shadowRoot!.querySelector("ha-entity-picker")!),
            ]),
        );
    });
}

/** What the picker offers of the fixtures: a kind's sensors, or everything. */
const offers = (pickers: Record<string, Picker>, key: string) => pickers[key]?.admits;

test("each sensor picker offers only its kind, matched by device class or unit", async ({ page }) => {
    await mountEditor(page);
    const pickers = {
        ...(await groupPickers(page, "Energy nodes")),
        ...(await groupPickers(page, "Training")),
        ...(await groupPickers(page, "Devices")),
    };

    const expected: Record<string, keyof typeof ADMITS> = {
        "energy_nodes.house.entities.power": "power",
        "energy_nodes.house.forecast.total_energy_entity_id": "energy",
        "energy_nodes.solar.entities.power": "power",
        "energy_nodes.solar.entities.today_energy": "energy",
        "energy_nodes.solar.forecast.total_energy_entity_id": "energy",
        "energy_nodes.solar.forecast.daily_energy_entity_ids.0": "energy",
        "energy_nodes.battery.entities.power": "power",
        "energy_nodes.battery.entities.remaining_energy": "energy",
        "energy_nodes.battery.entities.capacity": "energy",
        "energy_nodes.battery.entities.min_soc": "soc",
        "energy_nodes.battery.entities.max_soc": "soc",
        "energy_nodes.grid.entities.power": "power",
        // Price sensors have no reliable class, and their unit is a currency.
        "energy_nodes.grid.forecast.sell_price_entity_id": "none",
        "training.solar_bias.total_energy_entity_id": "energy",
        "devices.consumers.0.consumption.energy_entity_id": "energy",
        "devices.consumers.0.consumption.power_entity_id": "power",
        "devices.consumers.1.consumption.energy_entity_id": "energy",
        "devices.consumers.1.vehicles.0.telemetry.soc_entity_id": "soc",
    };
    for (const [key, kind] of Object.entries(expected)) {
        expect(offers(pickers, key), key).toEqual(ADMITS[kind]);
    }
});

test("the switch picker keeps its domains and filters nothing", async ({ page }) => {
    await mountEditor(page);
    const pickers = await groupPickers(page, "Devices");
    expect(pickers["devices.consumers.0.children.0.controls.switch.entity_id"]).toEqual({
        includeDomains: SWITCH_CONTROL_DOMAINS,
        admits: ADMITS.none,
    });
});

test("the add-device pickers offer energy sensors and, under a parent, every control", async ({
    page,
}) => {
    await mountEditor(page);
    await groupPickers(page, "Devices");
    const panel = page.locator("helman-config-editor-panel");
    const addPicker = () =>
        panel.locator(".add-device-picker ha-entity-picker").evaluate((picker) => window.__describe(picker));

    // The breaker's child button comes first; the top-level one after every card.
    await panel.locator(".add-device").first().dispatchEvent("click");
    expect(await addPicker()).toEqual({
        includeDomains: ["sensor", ...SWITCH_CONTROL_DOMAINS, "climate"],
        admits: ADMITS.energy,
    });

    await panel.locator(".add-device").last().dispatchEvent("click");
    expect(await addPicker()).toEqual({ includeDomains: ["sensor"], admits: ADMITS.energy });
});
