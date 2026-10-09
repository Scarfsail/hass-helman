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
const MODE_PATH = "devices.system[0].controls.mode.entity_id";
const MODE_RESOLVED = { [MODE_PATH]: "select.helman_inverter_mode" };
/** The same path as an entity group's key. */
const MODE_GROUP = "devices.system.0.controls.mode.entity_id";

const PROFILE = {
    id: "solax_inverter",
    label: "SolaX inverter",
    deviceKind: "inverter",
    ownedConfigPaths: OWNED,
    ownedDevicePaths: ["controls.mode"],
    entries: [{ entryId: "solax-entry", title: "SolaX" }],
};

/** A hand-mapped document: every owned path is set, and one site setting. */
const CUSTOM_CONFIG = {
    config_version: 7,
    energy_nodes: {
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
    devices: {
        system: [
            {
                kind: "inverter",
                id: "inverter",
                name: "Inverter",
                controls: {
                    mode: {
                        entity_id: "input_select.rezim_fv",
                        options: { normal: "Standardní", stop_charging: "Zákaz nabíjení" },
                    },
                },
            },
        ],
    },
};

const SOLAX_CONFIG = {
    config_version: 7,
    energy_nodes: {
        solar: { forecast: { total_energy_entity_id: "sensor.solar_total" } },
        battery: { forecast: { charge_efficiency: 0.95 } },
    },
    devices: {
        system: [
            {
                kind: "inverter",
                id: "inverter",
                name: "Inverter",
                vendor: { profile: "solax_inverter", entry_id: "solax-entry" },
            },
        ],
    },
};

async function mountEditor(page: Page, config: unknown, profile = PROFILE): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, profile, resolved }) => {
            (window as any).__vendorRequests = [];
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                states: {},
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/get_vendors") {
                        (window as any).__vendorRequests.push(
                            JSON.parse(JSON.stringify(request.config)),
                        );
                        const inverter = request.config?.devices?.system?.[0];
                        return {
                            profiles: [profile],
                            devices:
                                inverter?.vendor?.profile === profile.id
                                    ? {
                                          "devices.system[0]": {
                                              profile: profile.id,
                                              ownedConfigPaths: profile.ownedConfigPaths,
                                              ownedDevicePaths: profile.ownedDevicePaths,
                                              resolved,
                                          },
                                      }
                                    : {},
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config, profile, resolved: { ...RESOLVED, ...MODE_RESOLVED } },
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
        .toEqual(Object.keys(RESOLVED).sort());

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
    await openTab(page, "Devices");

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
    await openTab(page, "Devices");

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
        return Array.from(root?.querySelectorAll(".inverter-card summary") ?? []).map(
            (summary) => summary.textContent?.trim() ?? "",
        );
    });
    expect(sections.some((text) => text.startsWith("Controls"))).toBe(true);
    // Every action maps onto the select itself: there is nothing to map.
    expect(sections.some((text) => text.startsWith("Action options"))).toBe(false);
});

test("under Custom the inverter's mode control stays editable", async ({ page }) => {
    await mountEditor(page, CUSTOM_CONFIG);
    await openTab(page, "Devices");

    await expect
        .poll(async () => {
            await expandEverything(page);
            return (await energyFields(page)).groups;
        })
        .toContain(MODE_GROUP);
    const sections = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".inverter-card summary") ?? []).map(
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

    await openTab(page, "Devices");
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
                return requests.at(-1)?.devices?.system?.[0]?.vendor ?? null;
            }),
        )
        .toEqual({ profile: "solax_inverter", entry_id: "solax-entry" });
    const draft = await page.evaluate(() => (window as any).__vendorRequests.at(-1));
    expect(draft.energy_nodes).toEqual({
        solar: { forecast: { total_energy_entity_id: "sensor.solar_total" } },
        battery: { forecast: { charge_efficiency: 0.95 } },
    });
    // The mode control is the profile's too: the hand-made helper goes.
    expect(draft.devices.system[0].controls?.mode).toBeUndefined();

    await openTab(page, "Energy nodes");
    await expect
        .poll(async () => {
            await expandEverything(page);
            return Object.keys((await energyFields(page)).provided).length;
        })
        .toBe(Object.keys(RESOLVED).length);

    // And back to Custom: the vendor goes, the pickers come back (empty).
    await openTab(page, "Devices");
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
                return requests.at(-1)?.devices?.system?.[0]?.vendor ?? null;
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
    await openTab(page, "Devices");

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
