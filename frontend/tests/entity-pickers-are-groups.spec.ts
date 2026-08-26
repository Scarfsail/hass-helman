import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * No entity is picked outside a group, and none of them shows nothing.
 *
 * The editor used to render two kinds of entity field: a bordered group with a
 * live reading for the handful of paths an evaluator spoke for, and a bare
 * picker for everything else. That split is what this suite exists to keep
 * shut. A bare picker fails the first assertion here structurally -- a group
 * renders its `ha-entity-picker` inside its own shadow root, so any picker
 * still visible in the *panel's* shadow root is one that was never converted.
 *
 * The second assertion is the other half: a group with no facts is a group
 * that shows nothing, which is the same silence with a border around it. The
 * backend's fallback evaluator answers every path it has nothing specific to
 * say about, and the stub below stands in for it -- with a fact of its own
 * choosing, because the editor must not be able to derive a reading itself.
 *
 * The entities-only view of #165 rests on both: it hides every field that is
 * not a group, so an unconverted picker would be hidden from the one view that
 * promises nothing is missed.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const TABS = ["General", "Power devices", "Automation", "Controllables"];

/** A document with something picked at every entity path the editor offers. */
const CONFIG = {
    config_version: 7,
    power_devices: {
        house: {
            entities: { power: "sensor.house_power" },
            forecast: { total_energy_entity_id: "sensor.house_energy", min_history_days: 30 },
        },
        solar: {
            entities: {
                power: "sensor.solar_power",
                today_energy: "sensor.solar_today_energy",
                remaining_today_energy_forecast: "sensor.solar_remaining_today",
            },
            forecast: {
                total_energy_entity_id: "sensor.solar_energy",
                daily_energy_entity_ids: ["sensor.solar_day_0"],
                bias_correction: { total_energy_entity_id: "sensor.solar_bias_energy" },
            },
        },
        battery: {
            entities: {
                power: "sensor.battery_power",
                remaining_energy: "sensor.battery_remaining_energy",
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
    controllables: [
        {
            kind: "inverter",
            id: "inverter",
            name: "Inverter",
            controls: { mode: { entity_id: "select.inverter_mode", options: {} } },
        },
        {
            kind: "ev_charger",
            id: "ev",
            name: "EV Charging",
            limits: { max_charging_power_kw: 11 },
            controls: {
                charge: { entity_id: "switch.ev_charge" },
                use_mode: { entity_id: "input_select.ev_use_mode", values: {} },
                eco_gear: { entity_id: "input_select.ev_eco_gear", values: {} },
            },
            vehicles: [
                {
                    id: "car",
                    name: "Car",
                    telemetry: {
                        soc_entity_id: "sensor.car_soc",
                        charge_limit_entity_id: "number.car_charge_limit",
                    },
                    limits: { battery_capacity_kwh: 60, max_charging_power_kw: 11 },
                },
            ],
            consumption: { energy_entity_id: "sensor.ev_energy_total" },
        },
        {
            kind: "generic",
            id: "boiler",
            name: "Boiler",
            controls: { switch: { entity_id: "switch.boiler" } },
            consumption: {
                energy_entity_id: "sensor.boiler_energy_total",
                projection: { strategy: "fixed", hourly_energy_kwh: 2 },
            },
        },
        {
            kind: "climate",
            id: "hvac",
            name: "HVAC",
            controls: { climate: { entity_id: "climate.living_room" } },
            consumption: {
                energy_entity_id: "sensor.hvac_energy_total",
                projection: { strategy: "fixed", hourly_energy_kwh: 1.5 },
            },
        },
    ],
};

/** The four the user pointed at: loose fields beside a bordered sensor. */
const CIRCLED_KEYS = [
    "power_devices.solar.entities.today_energy",
    "power_devices.solar.entities.remaining_today_energy_forecast",
    "power_devices.battery.entities.remaining_energy",
    "power_devices.battery.entities.capacity",
];

/** What the stub answers for every target, standing in for the fallback. */
const READING = "42 W";

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate((config) => {
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        element.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            connection: { subscribeEvents: async () => () => undefined },
            callWS: async (request: any) => {
                if (request.type === "helman/get_config") {
                    return JSON.parse(JSON.stringify(config));
                }
                if (request.type === "helman/get_optimizer_schema") {
                    return { version: 2, kinds: [] };
                }
                if (request.type === "helman/get_appliances") return { appliances: [] };
                if (request.type === "helman/inspect_entities") {
                    // Every target gets the same fact, whatever its path: that
                    // is what the backend's fallback does for a path no
                    // evaluator claims, and the editor cannot tell the two
                    // apart because it never interprets a fact.
                    return {
                        results: (request.targets ?? []).map((target: any) => ({
                            key: target.key,
                            draft: {
                                entityId: "sensor.stub",
                                status: "ok",
                                facts: [
                                    {
                                        id: "value",
                                        token: "value",
                                        params: { value: "42", unit: "W" },
                                        severity: "neutral",
                                    },
                                ],
                            },
                            saved: null,
                        })),
                    };
                }
                return {};
            },
        };
        document.body.appendChild(element);
    }, CONFIG);

    await expect
        .poll(() =>
            page.evaluate(
                () => !!document.querySelector("helman-config-editor-panel")?.shadowRoot,
            ),
        )
        .toBe(true);
}

/** Click one of the editor's top-level tabs by its English label. */
async function openTab(page: Page, label: string): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate((tabLabel) => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === tabLabel,
                );
                if (!tab) return false;
                tab.click();
                return true;
            }, label),
        )
        .toBe(true);
}

/**
 * Open every section on the current tab, including the ones a section reveals.
 *
 * A collapsed `details` renders nothing at all, so a picker inside one is
 * neither converted nor unconverted until it is opened. Sections nest up to
 * four deep and each pass can reveal another, so this repeats until a pass
 * opens nothing new.
 */
async function expandEverything(page: Page): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
        const opened = await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            let count = 0;
            for (const section of root?.querySelectorAll("details") ?? []) {
                if (!section.hasAttribute("open")) {
                    section.setAttribute("open", "");
                    count += 1;
                }
            }
            return count;
        });
        if (opened === 0) return;
        await page.waitForTimeout(50);
    }
}

/** Entity pickers rendered by the panel itself -- a group's live in its own root. */
function barePickerLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll("ha-entity-picker") ?? []).map(
            (picker) =>
                picker.closest(".field")?.querySelector("label")?.textContent?.trim() ??
                "(unlabelled)",
        );
    });
}

/** Every mounted group, as its key and the badges it currently shows. */
function groupReadings(page: Page): Promise<Record<string, string[]>> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const readings: Record<string, string[]> = {};
        for (const group of root?.querySelectorAll("helman-entity-group") ?? []) {
            readings[(group as any).key] = Array.from(
                group.shadowRoot?.querySelectorAll(".entity-group > .facts .badge") ?? [],
            ).map((badge) => badge.textContent?.trim() ?? "");
        }
        return readings;
    });
}

test("no tab renders an entity picker outside a group", async ({ page }) => {
    await mountEditor(page);
    for (const label of TABS) {
        await openTab(page, label);
        await expandEverything(page);
        expect(await barePickerLabels(page), `bare pickers on ${label}`).toEqual([]);
    }
});

test("every picked entity shows the reading the backend sent for it", async ({ page }) => {
    await mountEditor(page);
    const seen: Record<string, string[]> = {};
    for (const label of ["Power devices", "Controllables"]) {
        await openTab(page, label);
        await expandEverything(page);
        // The poll is on a two-second timer, so the readings arrive a tick
        // after the groups do.
        await expect
            .poll(async () =>
                Object.values(await groupReadings(page)).every((facts) => facts.length > 0),
            )
            .toBe(true);
        Object.assign(seen, await groupReadings(page));
    }

    expect(Object.keys(seen).length).toBeGreaterThan(15);
    for (const [key, facts] of Object.entries(seen)) {
        expect(facts, `reading for ${key}`).toEqual([READING]);
    }
    for (const key of CIRCLED_KEYS) {
        expect(Object.keys(seen), `${key} is a group`).toContain(key);
    }
});
