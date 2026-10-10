import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The inverter's hardware profile picker, and what it hides (#429, #430).
 *
 * Which paths a profile owns is the backend's answer to `helman/get_vendors`,
 * so the stub below plays that part: the editor must hide exactly the paths
 * it is told about, show what each resolved to where its picker was, and flag
 * the ones that did not resolve. Picking the profile deletes the owned keys
 * from the draft, and that is checked on the draft the editor sends back.
 *
 * The inverter is the first section of the Energy nodes tab, above the nodes
 * its profile fills. The same UI sits on every device card (#440): the SolaX
 * EV charger binds to an HA device rather than a config entry, and owns the
 * charger's meters, controls and value lists, which its card then shows
 * read-only.
 *
 * Converting (#442): a Custom device whose entities sit on a profile's HA
 * device is offered that profile first and bound there, and switching a
 * device back to Custom writes what its profile provided into the draft, but
 * Helman's own entities.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const OWNED = [
    "energy_nodes.house.entities.power",
    "energy_nodes.house.forecast.total_energy_entity_id",
    "energy_nodes.solar.entities.power",
    "energy_nodes.battery.entities.power",
    "energy_nodes.battery.entities.min_soc",
    "energy_nodes.battery.entities.max_soc",
    "energy_nodes.battery.entities.power_polarity",
];

const RESOLVED: Record<string, string | null> = {
    "energy_nodes.house.entities.power": "sensor.solax_home_power",
    "energy_nodes.house.forecast.total_energy_entity_id": "sensor.solax_home_energy",
    "energy_nodes.solar.entities.power": "sensor.solax_pv_power_total",
    "energy_nodes.battery.entities.power": "sensor.solax_battery_power",
    "energy_nodes.battery.entities.min_soc": "number.solax_selfuse_discharge_min_soc",
    // Not in the registry: flagged, and the slot stays unset.
    "energy_nodes.battery.entities.max_soc": null,
};

/** The inverter's mode control, owned on the device: Helman's own select. */
const MODE_PATH = "energy_nodes.inverter.controls.mode.entity_id";
const MODE_RESOLVED = { [MODE_PATH]: "select.helman_inverter_mode" };
/** The same path as an entity group's key. */
const MODE_GROUP = MODE_PATH;

const PROFILE = {
    id: "solax_inverter",
    label: "SolaX inverter",
    deviceKind: "inverter",
    binding: "entry",
    ownedConfigPaths: OWNED,
    ownedDevicePaths: ["controls.mode"],
    entries: [{ entryId: "solax-entry", title: "SolaX" }],
};

/** A hand-mapped document: every owned path is set, and one site setting. */
const CUSTOM_CONFIG = {
    config_version: 29,
    energy_nodes: {
        inverter: {
            controls: {
                mode: {
                    entity_id: "input_select.rezim_fv",
                    options: { normal: "Standardní", stop_charging: "Zákaz nabíjení" },
                },
            },
        },
        house: {
            entities: { power: "sensor.house_load" },
            forecast: { total_energy_entity_id: "sensor.house_load_total" },
        },
        solar: {
            entities: { power: "sensor.pv_power" },
            forecast: { total_energy_entity_id: "sensor.solar_total" },
        },
        battery: {
            entities: {
                power: "sensor.battery_power",
                power_polarity: "positive_is_discharging",
                min_soc: "sensor.solax_battery_min_soc",
                max_soc: "sensor.solax_battery_max_soc",
            },
            forecast: { charge_efficiency: 0.95 },
        },
    },
};

const SOLAX_CONFIG = {
    config_version: 29,
    energy_nodes: {
        inverter: { profile: { id: "solax_inverter", entry_id: "solax-entry" } },
        solar: { forecast: { total_energy_entity_id: "sensor.solar_total" } },
        battery: { forecast: { charge_efficiency: 0.95 } },
    },
};

/** The SolaX EV charger: bound to an HA device, owning the meters and controls. */
const CHARGER_PROFILE = {
    id: "solax_ev_charger",
    label: "SolaX EV charger",
    deviceKind: "ev_charger",
    binding: "device",
    ownedConfigPaths: [],
    ownedDevicePaths: [
        "consumption.energy_entity_id",
        "consumption.power_entity_id",
        "controls.charge",
        "controls.use_mode",
        "controls.eco_gear",
    ],
    candidates: [
        { deviceId: "garage-charger", name: "Garage charger", entryTitle: "SolaX_EV_Charger" },
        { deviceId: "drive-charger", name: "Drive charger", entryTitle: "SolaX_EV_Charger_2" },
    ],
};

/** What the charger profile resolves to on a device, relative to it. */
const CHARGER_RESOLVED: Record<string, string> = {
    "consumption.energy_entity_id": "sensor.solax_ev_charger_charge_added_total",
    "consumption.power_entity_id": "sensor.solax_ev_charger_charge_power_total",
    "controls.use_mode.entity_id": "select.solax_ev_charger_charger_use_mode",
    "controls.eco_gear.entity_id": "select.solax_ev_charger_eco_gear",
    "controls.charge.entity_id": "switch.helman_ev_charging_garage_ev",
};

const CHARGER_VALUES = {
    "controls.use_mode.values": {
        Fast: { behavior: "fixed_max_power" },
        ECO: { behavior: "surplus_aware" },
    },
    "controls.eco_gear.values": { "6A": { min_power_kw: 3.5 }, "10A": { min_power_kw: 6.9 } },
};

/** A hand-mapped charger, and one already bound to the drive's charger. */
const CHARGERS_CONFIG = {
    config_version: 29,
    devices: {
        consumers: [
            {
                id: "garage-ev",
                kind: "ev_charger",
                name: "Garage EV",
                limits: { max_charging_power_kw: 11 },
            },
            {
                id: "drive-ev",
                kind: "ev_charger",
                profile: { id: "solax_ev_charger", device_id: "drive-charger" },
            },
        ],
    },
};

/** The garage charger on the profile. */
const GARAGE_ON_PROFILE = {
    config_version: 29,
    devices: {
        consumers: [
            {
                id: "garage-ev",
                kind: "ev_charger",
                name: "Garage EV",
                limits: { max_charging_power_kw: 11 },
                profile: { id: "solax_ev_charger", device_id: "garage-charger" },
            },
        ],
    },
};

const GARAGE = "devices.consumers[0]";
/** The same device as an entity group's key. */
const GARAGE_GROUP = "devices.consumers.0";

/** What the stub answers beyond the defaults: the registry, and the inverter profile's answer. */
interface StubOptions {
    /** `hass.entities`: which HA device each entity sits on. */
    entities?: Record<string, { device_id: string }>;
    inverterResolved?: Record<string, string | null>;
    inverterValues?: Record<string, unknown>;
}

async function mountEditor(
    page: Page,
    config: unknown,
    profile = PROFILE,
    { entities = {}, inverterResolved = RESOLVED, inverterValues = {} }: StubOptions = {},
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, profile, resolved, inverterValues, charger, chargerResolved, chargerValues, entities, modePath }) => {
            (window as any).__vendorRequests = [];
            (window as any).__validation = { valid: true, errors: [], warnings: [] };
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                states: {},
                entities,
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/validate_config") return (window as any).__validation;
                    if (request.type === "helman/get_vendors") {
                        (window as any).__vendorRequests.push(
                            JSON.parse(JSON.stringify(request.config)),
                        );
                        const inverter = request.config?.energy_nodes?.inverter;
                        const devices: Record<string, unknown> = {};
                        if (inverter?.profile?.id === profile.id) {
                            devices["energy_nodes.inverter"] = {
                                profile: profile.id,
                                storedProfile: inverter.profile,
                                ownedConfigPaths: profile.ownedConfigPaths,
                                ownedDevicePaths: profile.ownedDevicePaths,
                                resolved,
                                values: inverterValues,
                                helmanEntityPaths: [modePath],
                            };
                        }
                        const consumers: any[] = request.config?.devices?.consumers ?? [];
                        consumers.forEach((device, index) => {
                            // The backend ignores a profile of another kind.
                            if (device?.profile?.id !== charger.id || device.kind !== charger.deviceKind) return;
                            const path = `devices.consumers[${index}]`;
                            const absolute = (relative: Record<string, unknown>) =>
                                Object.fromEntries(
                                    Object.entries(relative).map(([key, value]) => [`${path}.${key}`, value]),
                                );
                            devices[path] = {
                                profile: charger.id,
                                storedProfile: device.profile,
                                ownedConfigPaths: [],
                                ownedDevicePaths: charger.ownedDevicePaths,
                                resolved: absolute(chargerResolved),
                                values: absolute(chargerValues),
                                helmanEntityPaths: [`${path}.controls.charge.entity_id`],
                            };
                        });
                        return { profiles: [profile, charger], devices };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config,
            profile,
            resolved: { ...inverterResolved, ...MODE_RESOLVED },
            inverterValues,
            charger: CHARGER_PROFILE,
            chargerResolved: CHARGER_RESOLVED,
            chargerValues: CHARGER_VALUES,
            entities,
            modePath: MODE_PATH,
        },
    );
}

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

/** Open every section on the tab, repeating while a pass reveals more. */
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

/** The entity groups (pickers) and the read-only provided fields on the tab. */
function energyFields(page: Page): Promise<{
    groups: string[];
    provided: Record<string, { text: string; unresolved: boolean }>;
}> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const groups = Array.from(root?.querySelectorAll("helman-entity-group") ?? []).map(
            (group) => (group as any).key as string,
        );
        const provided: Record<string, { text: string; unresolved: boolean }> = {};
        for (const field of Array.from(root?.querySelectorAll(".vendor-provided") ?? [])) {
            const entity = field.querySelector(".vendor-provided-entity");
            provided[field.getAttribute("data-path") ?? ""] = {
                text: entity?.textContent?.trim() ?? "",
                unresolved: entity?.classList.contains("unresolved") ?? false,
            };
        }
        return { groups, provided };
    });
}

test("under the SolaX profile the owned pickers are replaced by what they resolved to", async ({
    page,
}) => {
    await mountEditor(page, SOLAX_CONFIG);
    await openTab(page, "Energy nodes");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return Object.keys((await energyFields(page)).provided).sort();
        })
        // The inverter's own mode control, at the top of the tab, included.
        .toEqual([...Object.keys(RESOLVED), MODE_PATH].sort());

    const { groups, provided } = await energyFields(page);
    for (const path of OWNED) {
        expect(groups, `${path} has no picker`).not.toContain(path);
    }
    // A path the profile does not own keeps its picker.
    expect(groups).toContain("energy_nodes.solar.forecast.total_energy_entity_id");
    expect(provided["energy_nodes.battery.entities.min_soc"]).toEqual({
        text: "number.solax_selfuse_discharge_min_soc",
        unresolved: false,
    });
    expect(provided["energy_nodes.battery.entities.max_soc"]).toEqual({
        text: "Not found in the chosen integration entry",
        unresolved: true,
    });
});

test("the inverter's hardware section lists every resolved entity", async ({ page }) => {
    await mountEditor(page, SOLAX_CONFIG);
    await openTab(page, "Energy nodes");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                return root?.querySelectorAll(".vendor-resolved li").length ?? 0;
            });
        })
        .toBe(Object.keys(RESOLVED).length + 1);

    const section = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const profile = root?.querySelector<HTMLSelectElement>(
            'select[data-field="hardware-profile"]',
        );
        const entry = root?.querySelector<HTMLSelectElement>('select[data-field="vendor-entry"]');
        const rows = Array.from(root?.querySelectorAll(".vendor-resolved li") ?? []).map(
            (row) => ({
                path: row.getAttribute("data-path"),
                text: row.querySelector("span")?.textContent?.trim(),
                unresolved: row.classList.contains("unresolved"),
            }),
        );
        return {
            profile: profile?.value,
            options: Array.from(profile?.options ?? []).map((option) => option.textContent?.trim()),
            entry: entry?.value,
            rows,
        };
    });

    expect(section.profile).toBe("solax_inverter");
    expect(section.options).toEqual(["Custom", "SolaX inverter"]);
    expect(section.entry).toBe("solax-entry");
    expect(section.rows).toContainEqual({
        path: "energy_nodes.house.forecast.total_energy_entity_id",
        text: "sensor.solax_home_energy",
        unresolved: false,
    });
    expect(section.rows).toContainEqual({
        path: "energy_nodes.battery.entities.max_soc",
        text: "Not found in the chosen integration entry",
        unresolved: true,
    });
});

test("under the SolaX profile the inverter's mode control is provided, not configured", async ({
    page,
}) => {
    await mountEditor(page, SOLAX_CONFIG);
    await openTab(page, "Energy nodes");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return (await energyFields(page)).provided[MODE_PATH] ?? null;
        })
        .toEqual({ text: "select.helman_inverter_mode", unresolved: false });

    const { groups } = await energyFields(page);
    expect(groups).not.toContain(MODE_GROUP);
    const sections = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".inverter-section summary") ?? []).map(
            (summary) => summary.textContent?.trim() ?? "",
        );
    });
    expect(sections.some((text) => text.startsWith("Controls"))).toBe(true);
    // Every action maps onto the select itself: there is nothing to map.
    expect(sections.some((text) => text.startsWith("Action options"))).toBe(false);
});

test("under Custom the inverter's mode control stays editable", async ({ page }) => {
    await mountEditor(page, CUSTOM_CONFIG);
    await openTab(page, "Energy nodes");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return (await energyFields(page)).groups;
        })
        .toContain(MODE_GROUP);
    const sections = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".inverter-section summary") ?? []).map(
            (summary) => summary.textContent?.trim() ?? "",
        );
    });
    expect(sections.some((text) => text.startsWith("Action options"))).toBe(true);
    expect((await energyFields(page)).provided).toEqual({});
});

test("picking the profile deletes the owned keys and keeps the site settings", async ({
    page,
}) => {
    await mountEditor(page, CUSTOM_CONFIG);
    await openTab(page, "Energy nodes");
    await expandEverything(page);
    // Custom: every slot is a picker, nothing is provided.
    await expect
        .poll(async () => (await energyFields(page)).groups)
        .toContain("energy_nodes.battery.entities.min_soc");
    expect((await energyFields(page)).provided).toEqual({});

    await openTab(page, "Energy nodes");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const select = root?.querySelector<HTMLSelectElement>(
                    'select[data-field="hardware-profile"]',
                );
                if (!select || select.options.length < 2) return false;
                select.value = "solax_inverter";
                select.dispatchEvent(new Event("change"));
                return true;
            });
        })
        .toBe(true);

    // The draft the editor asks about next is the one the save would send.
    await expect
        .poll(() =>
            page.evaluate(() => {
                const requests = (window as any).__vendorRequests as any[];
                return requests.at(-1)?.energy_nodes?.inverter?.profile ?? null;
            }),
        )
        .toEqual({ id: "solax_inverter", entry_id: "solax-entry" });
    const draft = await page.evaluate(() => (window as any).__vendorRequests.at(-1));
    const { inverter, ...nodes } = draft.energy_nodes;
    expect(nodes).toEqual({
        solar: { forecast: { total_energy_entity_id: "sensor.solar_total" } },
        battery: { forecast: { charge_efficiency: 0.95 } },
    });
    // The mode control is the profile's too: the hand-made helper goes.
    expect(inverter.controls?.mode).toBeUndefined();

    await openTab(page, "Energy nodes");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return Object.keys((await energyFields(page)).provided).length;
        })
        .toBe(Object.keys(RESOLVED).length + 1);

    // And back to Custom: the profile goes, the pickers come back (empty).
    await openTab(page, "Energy nodes");
    await expandEverything(page);
    await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const select = root?.querySelector<HTMLSelectElement>(
            'select[data-field="hardware-profile"]',
        );
        select!.value = "";
        select!.dispatchEvent(new Event("change"));
    });
    await expect
        .poll(() =>
            page.evaluate(() => {
                const requests = (window as any).__vendorRequests as any[];
                return requests.at(-1)?.energy_nodes?.inverter?.profile ?? null;
            }),
        )
        .toBeNull();
    await openTab(page, "Energy nodes");
    await expect
        .poll(async () => {
            await expandEverything(page);
            const fields = await energyFields(page);
            return {
                provided: Object.keys(fields.provided).length,
                minSocPicker: fields.groups.includes("energy_nodes.battery.entities.min_soc"),
            };
        })
        .toEqual({ provided: 0, minSocPicker: true });
});

test("without an integration entry the section says so instead of offering an empty select", async ({
    page,
}) => {
    await mountEditor(page, SOLAX_CONFIG, { ...PROFILE, entries: [] });
    await openTab(page, "Energy nodes");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                return root?.querySelector('[data-field="vendor-no-entries"]')?.textContent?.trim() ?? "";
            });
        })
        .toContain("No integration entry for SolaX inverter is set up");
    const entrySelectHidden = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return root?.querySelector<HTMLSelectElement>('select[data-field="vendor-entry"]')?.hidden;
    });
    expect(entrySelectHidden).toBe(true);
});

// --- A consumer's hardware profile: the SolaX EV charger ---------------------

/** What the garage charger's card shows: its pickers, provided fields, and controls. */
function garageCard(page: Page): Promise<{
    groups: string[];
    provided: Record<string, { text: string; unresolved: boolean }>;
    profile: string | null;
    devices: string[];
    kind: { value: string; disabled: boolean } | null;
    badges: string[];
    suggestions: number;
    removeButtons: number;
    addButtons: string[];
    valueInputs: { value: string; readOnly: boolean }[];
    behaviors: { value: string; disabled: boolean }[];
}> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const card = root?.querySelector('details.device-card[data-device-id="garage-ev"]');
        const provided: Record<string, { text: string; unresolved: boolean }> = {};
        for (const field of Array.from(card?.querySelectorAll(".vendor-provided") ?? [])) {
            const entity = field.querySelector(".vendor-provided-entity");
            provided[field.getAttribute("data-path") ?? ""] = {
                text: entity?.textContent?.trim() ?? "",
                unresolved: entity?.classList.contains("unresolved") ?? false,
            };
        }
        const kind = card?.querySelector<HTMLSelectElement>("select.device-kind");
        const device = card?.querySelector<HTMLSelectElement>('select[data-field="vendor-device"]');
        const lists = Array.from(card?.querySelectorAll(".nested-card") ?? []).filter((nested) =>
            /mapping/i.test(nested.querySelector(".card-subtitle")?.textContent ?? ""),
        );
        return {
            groups: Array.from(card?.querySelectorAll("helman-entity-group") ?? []).map(
                (group) => (group as any).key as string,
            ),
            provided,
            profile:
                card?.querySelector<HTMLSelectElement>('select[data-field="hardware-profile"]')?.value ??
                null,
            devices: device && !device.hidden ? Array.from(device.options).map((option) => option.value) : [],
            kind: kind ? { value: kind.value, disabled: kind.disabled } : null,
            badges: Array.from(
                card?.querySelectorAll(":scope > summary .device-badge") ?? [],
            ).map((badge) => badge.getAttribute("data-badge") ?? ""),
            suggestions: card?.querySelectorAll(".apply-suggestions").length ?? 0,
            removeButtons: lists.flatMap((nested) => Array.from(nested.querySelectorAll("button.danger")))
                .length,
            addButtons: Array.from(card?.querySelectorAll(".section-footer .add-button") ?? []).map(
                (button) => button.textContent?.trim() ?? "",
            ),
            valueInputs: lists.flatMap((nested) =>
                Array.from(nested.querySelectorAll<HTMLInputElement>("input")).map((input) => ({
                    value: input.value,
                    readOnly: input.readOnly,
                })),
            ),
            behaviors: lists.flatMap((nested) =>
                Array.from(nested.querySelectorAll<HTMLSelectElement>("select")).map((select) => ({
                    value: select.value,
                    disabled: select.disabled,
                })),
            ),
        };
    });
}

/** The last draft the editor asked `helman/get_vendors` about: what a save would send. */
function lastDraft(page: Page): Promise<any> {
    return page.evaluate(() => (window as any).__vendorRequests.at(-1));
}

async function pickGarageProfile(page: Page, value: string): Promise<void> {
    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate((next) => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const select = root?.querySelector<HTMLSelectElement>(
                    'details.device-card[data-device-id="garage-ev"] select[data-field="hardware-profile"]',
                );
                if (!select || select.options.length < 2) return false;
                select.value = next;
                select.dispatchEvent(new Event("change"));
                return true;
            }, value);
        })
        .toBe(true);
}

test("picking the SolaX profile on a charger offers only its free HA device and preselects it", async ({
    page,
}) => {
    await mountEditor(page, CHARGERS_CONFIG);
    await openTab(page, "Devices");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return (await garageCard(page)).groups;
        })
        .toContain(`${GARAGE_GROUP}.consumption.energy_entity_id`);
    // The inverter's profile is not offered to a charger.
    const options = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const select = root?.querySelector<HTMLSelectElement>(
            'details.device-card[data-device-id="garage-ev"] select[data-field="hardware-profile"]',
        );
        return Array.from(select?.options ?? []).map((option) => option.textContent?.trim());
    });
    expect(options).toEqual(["Custom", "SolaX EV charger"]);

    await pickGarageProfile(page, "solax_ev_charger");

    // The drive's charger is bound already: only the garage's is offered and picked.
    await expect
        .poll(async () => (await lastDraft(page))?.devices?.consumers?.[0]?.profile ?? null)
        .toEqual({ id: "solax_ev_charger", device_id: "garage-charger" });
    await expect
        .poll(async () => {
            await expandEverything(page);
            return (await garageCard(page)).devices;
        })
        .toEqual(["", "garage-charger"]);
});

test("a charger on its profile shows what the profile fills in, read-only", async ({ page }) => {
    await mountEditor(page, GARAGE_ON_PROFILE);
    await openTab(page, "Devices");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return Object.keys((await garageCard(page)).provided).sort();
        })
        .toEqual(
            [
                "consumption.energy_entity_id",
                "consumption.power_entity_id",
                "controls.charge.entity_id",
                "controls.use_mode.entity_id",
                "controls.eco_gear.entity_id",
            ]
                .map((path) => `${GARAGE}.${path}`)
                .sort(),
        );

    const card = await garageCard(page);
    expect(card.profile).toBe("solax_ev_charger");
    expect(card.provided[`${GARAGE}.consumption.energy_entity_id`]).toEqual({
        text: "sensor.solax_ev_charger_charge_added_total",
        unresolved: false,
    });
    expect(card.groups.filter((key) => key.startsWith(`${GARAGE_GROUP}.c`))).toEqual([]);
    // The profile fixes the kind, and leaves the suggestions nothing to fill.
    expect(card.kind).toEqual({ value: "ev_charger", disabled: true });
    expect(card.suggestions).toBe(0);
    // The meter it stores none of still makes the card a metered one.
    expect(card.badges).toEqual(expect.arrayContaining(["energy", "power", "switch"]));
    // Use modes and eco gears are the profile's: listed, not editable.
    expect(card.valueInputs).toEqual([
        { value: "Fast", readOnly: true },
        { value: "ECO", readOnly: true },
        { value: "6A", readOnly: true },
        { value: "3.5", readOnly: true },
        { value: "10A", readOnly: true },
        { value: "6.9", readOnly: true },
    ]);
    expect(card.behaviors).toEqual([
        { value: "fixed_max_power", disabled: true },
        { value: "surplus_aware", disabled: true },
    ]);
    expect(card.removeButtons).toBe(0);
    expect(card.addButtons).not.toContain("Add use mode");
    expect(card.addButtons).not.toContain("Add eco gear");
});

/** A value in a draft by its validation path, such as `devices.consumers[0].controls`. */
function valueAt(document: any, path: string): any {
    return path
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .reduce((node, key) => node?.[key], document);
}

/** A hand-mapped garage charger whose meters and switch sit on the drive's HA device. */
const MATCHING_CONFIG = {
    config_version: 29,
    devices: {
        consumers: [
            {
                id: "garage-ev",
                kind: "ev_charger",
                name: "Garage EV",
                limits: { max_charging_power_kw: 11 },
                consumption: {
                    energy_entity_id: "sensor.garage_ev_energy",
                    power_entity_id: "sensor.garage_ev_power",
                },
                controls: { charge: { entity_id: "switch.garage_ev_charging" } },
            },
        ],
    },
};

const ON_DRIVE_CHARGER = {
    "sensor.garage_ev_energy": { device_id: "drive-charger" },
    "sensor.garage_ev_power": { device_id: "drive-charger" },
    "switch.garage_ev_charging": { device_id: "drive-charger" },
};

/** The meter-change note in the garage card's hardware section, or `null`. */
function meterChangeNote(page: Page): Promise<string | null> {
    return page.evaluate(
        () =>
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelector(
                    'details.device-card[data-device-id="garage-ev"] [data-field="profile-meter-change"]',
                )
                ?.textContent?.trim() ?? null,
    );
}

test("a Custom charger whose entities sit on a candidate offers its profile first, as matching, and binds it there", async ({
    page,
}) => {
    await mountEditor(page, MATCHING_CONFIG, PROFILE, { entities: ON_DRIVE_CHARGER });
    await openTab(page, "Devices");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const select = root?.querySelector<HTMLSelectElement>(
                    'details.device-card[data-device-id="garage-ev"] select[data-field="hardware-profile"]',
                );
                return Array.from(select?.options ?? []).map((option) => option.textContent?.trim());
            });
        })
        .toEqual(["Custom", "SolaX EV charger (matches this device's entities)"]);
    // Nothing is said about the meter while the device stays Custom.
    expect(await meterChangeNote(page)).toBeNull();

    await pickGarageProfile(page, "solax_ev_charger");

    // The HA device the entities sit on, not the first candidate.
    await expect
        .poll(async () => (await lastDraft(page))?.devices?.consumers?.[0]?.profile ?? null)
        .toEqual({ id: "solax_ev_charger", device_id: "drive-charger" });
    const { consumption: _meters, controls: _controls, ...rest } = MATCHING_CONFIG.devices.consumers[0];
    expect((await lastDraft(page)).devices.consumers[0]).toEqual({
        ...rest,
        profile: { id: "solax_ev_charger", device_id: "drive-charger" },
    });
    // Its saved meter is not the one the profile resolves: the card says so.
    await expect
        .poll(async () => {
            await expandEverything(page);
            return meterChangeNote(page);
        })
        .toBe(
            "The energy meter changes from sensor.garage_ev_energy to " +
                "sensor.solax_ev_charger_charge_added_total. Learned usage and history are keyed by the meter.",
        );
});

test("a profile resolving the meter the device already has says nothing about it", async ({ page }) => {
    const same: any = structuredClone(MATCHING_CONFIG);
    same.devices.consumers[0].consumption.energy_entity_id = CHARGER_RESOLVED["consumption.energy_entity_id"];
    await mountEditor(page, same, PROFILE, {
        entities: {
            ...ON_DRIVE_CHARGER,
            [CHARGER_RESOLVED["consumption.energy_entity_id"]]: { device_id: "drive-charger" },
        },
    });
    await openTab(page, "Devices");
    await pickGarageProfile(page, "solax_ev_charger");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return Object.keys((await garageCard(page)).provided).length;
        })
        .toBe(5);
    expect(await meterChangeNote(page)).toBeNull();
});

test("switching a charger back to Custom writes what the profile provided, but its own switch", async ({
    page,
}) => {
    await mountEditor(page, GARAGE_ON_PROFILE);
    await openTab(page, "Devices");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return Object.keys((await garageCard(page)).provided).length;
        })
        .toBe(5);

    await pickGarageProfile(page, "");

    await expect.poll(async () => (await lastDraft(page))?.devices?.consumers?.[0]?.profile ?? null).toBeNull();
    const { profile: _gone, ...garage } = GARAGE_ON_PROFILE.devices.consumers[0];
    // Helman's charging switch exists only under the profile: its slot stays empty.
    expect((await lastDraft(page)).devices.consumers[0]).toEqual({
        ...garage,
        consumption: {
            energy_entity_id: CHARGER_RESOLVED["consumption.energy_entity_id"],
            power_entity_id: CHARGER_RESOLVED["consumption.power_entity_id"],
        },
        controls: {
            use_mode: {
                entity_id: CHARGER_RESOLVED["controls.use_mode.entity_id"],
                values: CHARGER_VALUES["controls.use_mode.values"],
            },
            eco_gear: {
                entity_id: CHARGER_RESOLVED["controls.eco_gear.entity_id"],
                values: CHARGER_VALUES["controls.eco_gear.values"],
            },
        },
    });
    await expect
        .poll(async () => {
            await expandEverything(page);
            const card = await garageCard(page);
            return {
                provided: Object.keys(card.provided).length,
                chargePicker: card.groups.includes(`${GARAGE_GROUP}.controls.charge.entity_id`),
                kind: card.kind,
            };
        })
        .toEqual({ provided: 0, chargePicker: true, kind: { value: "ev_charger", disabled: false } });

    // The existing validation asks for the switch.
    const message = "devices.consumers[0].controls.charge must name a switch";
    await page.evaluate(
        (issue) => ((window as any).__validation = { valid: false, errors: [issue], warnings: [] }),
        { section: "devices", path: `${GARAGE}.controls.charge`, code: "invalid_appliance", message },
    );
    await page.locator("helman-config-editor-panel").locator(".actions button", { hasText: "Validate" }).click();
    await expect(
        page.locator('helman-config-editor-panel details.device-card[data-device-id="garage-ev"] .device-issues'),
    ).toContainText(message);
});

/** Every entity the SolaX inverter profile fills, as the backend lists them. */
const INVERTER_ENTITIES: Record<string, string> = {
    "energy_nodes.solar.entities.power": "sensor.solax_pv_power_total",
    "energy_nodes.solar.entities.today_energy": "sensor.solax_today_s_solar_energy",
    "training.solar_bias.total_energy_entity_id": "sensor.solax_total_solar_energy",
    "energy_nodes.battery.entities.power": "sensor.solax_battery_power",
    "energy_nodes.battery.entities.capacity": "sensor.solax_battery_capacity",
    "energy_nodes.battery.entities.remaining_energy": "sensor.solax_remaining_battery_capacity",
    "energy_nodes.battery.entities.min_soc": "number.solax_selfuse_discharge_min_soc",
    "energy_nodes.battery.entities.max_soc": "number.solax_battery_charge_upper_soc",
    "energy_nodes.battery.entities.today_charge_energy": "sensor.solax_battery_input_energy_today",
    "energy_nodes.battery.entities.today_discharge_energy": "sensor.solax_battery_output_energy_today",
    "energy_nodes.grid.entities.power": "sensor.solax_grid_power",
    "energy_nodes.grid.entities.today_import": "sensor.solax_today_s_import_energy",
    "energy_nodes.grid.entities.today_export": "sensor.solax_today_s_export_energy",
    "energy_nodes.house.entities.power": "sensor.solax_home_consumption_power",
    "energy_nodes.house.entities.today_energy": "sensor.solax_home_consumption_energy",
    "energy_nodes.house.forecast.total_energy_entity_id": "sensor.solax_home_consumption_energy",
};

const INVERTER_VALUES = {
    "energy_nodes.battery.entities.power_polarity": "positive_is_discharging",
    "energy_nodes.grid.entities.power_polarity": "positive_is_import",
};

test("the inverter switched to Custom gets every entity and value its profile provided, but the mode select", async ({
    page,
}) => {
    await mountEditor(
        page,
        SOLAX_CONFIG,
        { ...PROFILE, ownedConfigPaths: [...Object.keys(INVERTER_ENTITIES), ...Object.keys(INVERTER_VALUES)] },
        { inverterResolved: INVERTER_ENTITIES, inverterValues: INVERTER_VALUES },
    );
    await openTab(page, "Energy nodes");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                return root?.querySelectorAll(".vendor-resolved li").length ?? 0;
            });
        })
        .toBe(Object.keys(INVERTER_ENTITIES).length + 1);

    await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const select = root?.querySelector<HTMLSelectElement>('select[data-field="hardware-profile"]');
        select!.value = "";
        select!.dispatchEvent(new Event("change"));
    });

    await expect.poll(async () => (await lastDraft(page))?.energy_nodes?.inverter?.profile ?? null).toBeNull();
    const draft = await lastDraft(page);
    expect(Object.keys(INVERTER_ENTITIES)).toHaveLength(16);
    for (const [path, value] of Object.entries({ ...INVERTER_ENTITIES, ...INVERTER_VALUES })) {
        expect(valueAt(draft, path), path).toBe(value);
    }
    // Helman's own mode select exists only under the profile.
    expect(draft.energy_nodes.inverter?.controls?.mode).toBeUndefined();
    // The site settings stay as they were.
    expect(draft.energy_nodes.solar.forecast).toEqual({ total_energy_entity_id: "sensor.solar_total" });
    expect(draft.energy_nodes.battery.forecast).toEqual({ charge_efficiency: 0.95 });
});

for (const [stored, shown] of [
    [{ id: "retired_profile", device_id: "garage-charger" }, "retired_profile"],
    [null, "-"],
] as const) {
test(`a device storing profile ${JSON.stringify(stored)} shows it and can go back to Custom`, async ({ page }) => {
    const retired: any = structuredClone(GARAGE_ON_PROFILE);
    retired.devices.consumers[0].profile = stored;
    await mountEditor(page, retired);
    await openTab(page, "Devices");
    // The select shows the stored id, so picking Custom is a real change.
    await expect
        .poll(async () => {
            await expandEverything(page);
            return page.evaluate(
                () =>
                    document
                        .querySelector("helman-config-editor-panel")
                        ?.shadowRoot?.querySelector<HTMLSelectElement>(
                            'details.device-card[data-device-id="garage-ev"] select[data-field="hardware-profile"]',
                        )?.value ?? null,
            );
        })
        .toBe(shown);

    await pickGarageProfile(page, "");

    await expect.poll(async () => "profile" in ((await lastDraft(page))?.devices?.consumers?.[0] ?? {})).toBe(false);
});
}

test("a profile of another kind than the device's owns nothing on it", async ({ page }) => {
    const mismatched: any = structuredClone(GARAGE_ON_PROFILE);
    mismatched.devices.consumers[0].kind = "generic";
    await mountEditor(page, mismatched);
    await openTab(page, "Devices");

    await expect
        .poll(async () => {
            await expandEverything(page);
            const card = await garageCard(page);
            return { provided: Object.keys(card.provided).length, kind: card.kind?.value };
        })
        .toEqual({ provided: 0, kind: "generic" });
});
