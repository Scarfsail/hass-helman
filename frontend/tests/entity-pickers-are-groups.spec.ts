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

/**
 * Enough optimizer schema for the Automation tab to render something.
 *
 * Without it that tab is an empty pipeline and a "no optimizers" message, and
 * both assertions below pass over it having looked at nothing. One kind and one
 * configured optimizer is all it takes for the tab to mount a real
 * `helman-optimizer-editor` -- which is also the editor's one nested shadow
 * root, and so the case that makes the walk below worth doing.
 */
const SCHEMA = {
    version: 2,
    kinds: [
        {
            kind: "export_price",
            target: [],
            params: [],
            conditionTypes: [
                {
                    key: "when_price_below",
                    scope: "slot",
                    field: { key: "when_price_below", type: "number", default: 0 },
                },
            ],
            newDraft: { conditions: [{ when_price_below: 0 }] },
        },
    ],
};

/** A document with something picked at every entity path the editor offers. */
const CONFIG = {
    config_version: 7,
    automation: {
        enabled: true,
        optimizers: [
            {
                id: "export-when-cheap",
                kind: "export_price",
                enabled: true,
                conditions: [{ when_price_below: 1.5 }],
            },
        ],
    },
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

    await page.evaluate(({ config, schema }) => {
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        (window as any).__inspectRequests = [];
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
                    return JSON.parse(JSON.stringify(schema));
                }
                if (request.type === "helman/get_appliances") return { appliances: [] };
                if (request.type === "helman/inspect_entities") {
                    (window as any).__inspectRequests.push(
                        JSON.parse(JSON.stringify(request)),
                    );
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

        // Both helpers below have to cross shadow boundaries:
        // `querySelectorAll` stops at the first one, and the Automation tab
        // renders inside `helman-optimizer-editor`'s. Installed once, here,
        // because it is needed from several evaluates.
        (window as any).deepQuery = function deepQuery(root: any, selector: string): Element[] {
            if (!root) return [];
            const found: Element[] = [...root.querySelectorAll(selector)];
            for (const child of root.querySelectorAll("*")) {
                if (child.shadowRoot) found.push(...deepQuery(child.shadowRoot, selector));
            }
            return found;
        };
    }, { config: CONFIG, schema: SCHEMA });

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

/**
 * Entity pickers the editor renders outside a group.
 *
 * The walk crosses shadow boundaries so that a picker added inside a nested
 * element -- `helman-optimizer-editor` is the one that exists today -- cannot
 * pass this guard by being somewhere `querySelectorAll` does not look. That
 * means it also reaches each group's *own* picker, which is exactly what is
 * meant to be there, so those are dropped by their host.
 */
function barePickerLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return ((window as any).deepQuery(root, "ha-entity-picker") as Element[])
            // The walk reaches inside the groups too, and a group's own picker
            // is the thing this suite wants to see everywhere -- so it is
            // identified by its host and dropped, leaving only the pickers
            // rendered outside one.
            .filter(
                (picker) =>
                    (picker.getRootNode() as ShadowRoot).host?.tagName?.toLowerCase() !==
                    "helman-entity-group",
            )
            .map(
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
        for (const group of (window as any).deepQuery(root, "helman-entity-group") as Element[]) {
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

test("the Automation tab really renders its pipeline", async ({ page }) => {
    // Guards the guard: the tab above is only worth walking if the fixture
    // makes it render something. An empty pipeline would let both assertions
    // pass over it having looked at nothing at all.
    await mountEditor(page);
    await openTab(page, "Automation");
    await expandEverything(page);

    const rendered = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const editors = root?.querySelectorAll("helman-optimizer-editor") ?? [];
        return {
            editors: editors.length,
            // Content inside the nested shadow root, not just the host tag.
            nested: ((window as any).deepQuery(root, "input, select, label") as Element[])
                .filter((element) => element.getRootNode() !== root).length,
        };
    });

    expect(rendered.editors).toBe(1);
    expect(rendered.nested).toBeGreaterThan(0);
});

test("a group in a nested shadow root is seen by the collector and the guard", async ({
    page,
}) => {
    // Nothing in the editor renders an entity field inside a nested element
    // today, so this mounts one: a host with its own shadow root holding a
    // group and a bare picker, appended into the panel. Both the collector and
    // the guard have to reach it. If they do not, a future group placed inside
    // `helman-optimizer-editor` would sit there permanently blank, and a
    // future bare picker would pass the check above in silence -- and #165 is
    // about to claim its view shows every entity.
    await mountEditor(page);
    await openTab(page, "General");

    await page.evaluate((path) => {
        const panel = document.querySelector("helman-config-editor-panel") as any;
        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "open" });

        const group = document.createElement("helman-entity-group") as any;
        group.path = path;
        group.hass = panel.hass;
        group.fieldHost = panel;
        shadow.appendChild(group);

        const field = document.createElement("div");
        field.className = "field";
        const label = document.createElement("label");
        label.textContent = "Nested picker";
        field.appendChild(label);
        field.appendChild(document.createElement("ha-entity-picker"));
        shadow.appendChild(field);

        panel.shadowRoot.appendChild(host);
    }, ["power_devices", "grid", "entities", "power"]);

    expect(await barePickerLabels(page)).toEqual(["Nested picker"]);

    await expect
        .poll(async () =>
            page.evaluate(() => {
                const requests = (window as any).__inspectRequests as any[];
                return (requests.at(-1)?.targets ?? []).map((target: any) => target.key);
            }),
        )
        .toContain("power_devices.grid.entities.power");
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
