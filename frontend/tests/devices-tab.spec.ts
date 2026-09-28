import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The Devices tab (#332): the `devices` tree as nested cards.
 *
 * A card renders its children with the same card, so every assertion here
 * finds a card by its device id and reads only what the card itself owns --
 * a parent's body also holds its children's cards, and a selector that did not
 * stop at them would read a child's field as the parent's.
 *
 * The fixture is the live setup in miniature: an AC breaker whose climate
 * children draw from its meter, a study breaker with a sub-metered PC and a
 * passive lamp on its meter, and a schedulable boiler of its own. The inverter
 * sits in `devices.system`, edited in the tab's System section.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

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

const klima = (id: string) => ({
    id,
    kind: "climate",
    schedulable: true,
    controls: { climate: { entity_id: `climate.${id}` } },
    consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 0.5 } },
});

const BREAKER = {
    id: "jistic_klimatizace_energy",
    consumption: {
        energy_entity_id: "sensor.jistic_klimatizace_energy",
        power_entity_id: "sensor.jistic_klimatizace_power",
    },
    children: [klima("klima_obyvak"), klima("klima_loznice")],
};

const STUDY = {
    id: "study",
    name: "Study breaker",
    consumption: {
        energy_entity_id: "sensor.study_energy",
        power_entity_id: "sensor.study_power",
    },
    children: [
        {
            id: "pc",
            name: "PC",
            consumption: {
                energy_entity_id: "sensor.pc_energy",
                power_entity_id: "sensor.pc_power",
            },
        },
        { id: "lamp", name: "Lamp", controls: { switch: { entity_id: "" } } },
    ],
};

const BOILER = {
    kind: "generic",
    schedulable: true,
    id: "boiler",
    name: "Boiler",
    controls: { switch: { entity_id: "switch.boiler" } },
    consumption: {
        energy_entity_id: "sensor.boiler_energy_total",
        projection: { strategy: "fixed", hourly_energy_kwh: 2 },
    },
};

const DEVICES = [BREAKER, STUDY, BOILER];

/** What the backend's name resolution answers, by name/icon path key. */
const PLACEHOLDERS: Record<string, string> = {
    "devices.consumers.0.name": "AC breaker",
    "devices.consumers.0.icon": "mdi:air-conditioner",
    "devices.consumers.0.children.0.name": "Obývák",
    "devices.consumers.0.children.1.name": "Ložnice",
};

type Device = Record<string, any>;

declare global {
    interface Window {
        __editorConfig: () => { devices: { consumers: Device[]; system?: Device[] } };
        __inspectKeys: string[];
        __validation: unknown;
        __card: (id: string) => HTMLDetailsElement | null;
        __own: (id: string, selector: string) => HTMLElement[];
    }
}

async function mountEditor(
    page: Page,
    devices: unknown[] = DEVICES,
    validation: unknown = { valid: true, errors: [], warnings: [] },
    system: unknown[] = [INVERTER],
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, placeholders, report }) => {
            // Stubbed so YAML mode can be entered; driven with the
            // `value-changed` the real editor fires.
            if (!customElements.get("ha-yaml-editor")) {
                customElements.define("ha-yaml-editor", class extends HTMLElement {});
            }
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            window.__editorConfig = () =>
                (element as unknown as { _config: { devices: { consumers: Device[] } } })._config;
            window.__inspectKeys = [];
            window.__validation = report;
            window.__card = (id) =>
                element.shadowRoot?.querySelector(
                    `details.device-card[data-device-id="${id}"]`,
                ) ?? null;
            // What a card owns: its own elements, not those of the cards
            // nested inside it.
            window.__own = (id, selector) => {
                const card = window.__card(id);
                return Array.from(card?.querySelectorAll<HTMLElement>(selector) ?? []).filter(
                    (found) => found.closest("details.device-card") === card,
                );
            };
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/validate_config") return window.__validation;
                    if (request.type === "helman/inspect_entities") {
                        return {
                            results: (request.targets ?? []).map((target: any) => {
                                window.__inspectKeys.push(target.key);
                                return {
                                    key: target.key,
                                    draft: {
                                        entityId: null,
                                        status: "ok",
                                        facts: [],
                                        // Cleaned as the backend's resolution cleans it,
                                        // so the draft's regex shows in the answer.
                                        placeholder: request.config?.devices?.name_cleaner_regex
                                            ? placeholders[target.key]?.replace(
                                                  new RegExp(request.config.devices.name_cleaner_regex),
                                                  "",
                                              )
                                            : placeholders[target.key],
                                    },
                                    saved: null,
                                };
                            }),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config: { config_version: 25, devices: { ...(system.length ? { system } : {}), consumers: devices } },
            placeholders: PLACEHOLDERS,
            report: validation,
        },
    );
}

test("the device settings sit above the list and the regex renames the cards", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Devices", false);

    const sections = page.locator("helman-config-editor-panel").locator("details.section-card");
    expect(await tabSections(page)).toEqual([
        { label: "Device settings", open: false },
        { label: "System", open: false },
        { label: "Device groupings", open: false },
        { label: "Consumers", open: false },
    ]);
    await expect
        .poll(() =>
            page.evaluate(() => window.__own("jistic_klimatizace_energy", ".card-title strong")[0]?.textContent?.trim()),
        )
        .toBe("AC breaker");

    const settings = sections.first();
    await expect(settings).not.toHaveAttribute("open", "");
    await settings.evaluate((details) => ((details as HTMLDetailsElement).open = true));
    const regex = settings.locator(".field").filter({ hasText: "Device name cleaner regex" }).locator("input");
    await regex.fill("\\sbreaker$");
    await regex.dispatchEvent("change");

    expect(
        await page.evaluate(() => (window.__editorConfig().devices as any).name_cleaner_regex),
    ).toBe("\\sbreaker$");
    await expect
        .poll(() =>
            page.evaluate(() => window.__own("jistic_klimatizace_energy", ".card-title strong")[0]?.textContent?.trim()),
        )
        .toBe("AC");
});

/** The active tab's own sections, in order, and whether each is open. */
const tabSections = (page: Page) =>
    page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll<HTMLDetailsElement>("details.section-card") ?? [],
        )
            // Device cards nest sections of their own.
            .filter((details) => !details.parentElement?.closest("details"))
            .map((details) => ({
                label: details.querySelector(":scope > summary .section-summary-label")?.textContent?.trim(),
                open: details.open,
            })),
    );

test("the Automation tab lists system optimizers first, every section collapsed", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Automation");

    await expect
        .poll(() => tabSections(page))
        .toEqual([
            { label: "Automation settings", open: false },
            { label: "System optimizers", open: false },
            { label: "Appliance optimizers", open: false },
        ]);
});

/**
 * Switch tabs. The Devices tab starts with every section collapsed, so its
 * System and Consumers sections are opened too unless `expand` is false.
 */
async function openTab(page: Page, label: string, expand = label === "Devices"): Promise<void> {
    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: label, exact: true }).click();
    if (!expand) return;
    for (const section of ["System", "Consumers"]) {
        await panel
            .locator("details.section-card", {
                has: page.locator(":scope > summary .section-summary-label", { hasText: section }),
            })
            .evaluate((details) => ((details as HTMLDetailsElement).open = true));
    }
}

const config = (page: Page) => page.evaluate(() => window.__editorConfig().devices.consumers);

/** The ids of the cards the tab shows, in document order, hidden ones left out. */
const visibleCardIds = (page: Page) =>
    page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll<HTMLDetailsElement>("details.device-card") ?? [],
        )
            .filter((card) => !card.closest("[hidden]"))
            .map((card) => card.dataset.deviceId ?? ""),
    );

/** Set a select the card owns, as a user would. */
async function choose(page: Page, id: string, selector: string, value: string): Promise<void> {
    await page.evaluate(
        ({ id, selector, value }) => {
            const select = window.__own(id, selector)[0] as HTMLSelectElement;
            select.value = value;
            select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        },
        { id, selector, value },
    );
}

/** Flip a card's Schedulable switch. */
async function setSchedulable(page: Page, id: string, checked: boolean): Promise<void> {
    await page.evaluate(
        ({ id, checked }) => {
            const toggle = window.__own(id, ".schedulable-field ha-switch")[0] as HTMLElement & {
                checked: boolean;
            };
            toggle.checked = checked;
            toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        },
        { id, checked },
    );
}

/** Pick an entity in an "Add device" picker, opened from `button`. */
async function addDevice(page: Page, button: string, entityId: string, nth = 0): Promise<void> {
    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(button).nth(nth).dispatchEvent("click");
    await panel
        .locator(".add-device-picker ha-entity-picker")
        .evaluate((picker, value) => {
            picker.dispatchEvent(
                new CustomEvent("value-changed", {
                    detail: { value },
                    bubbles: true,
                    composed: true,
                }),
            );
        }, entityId);
}

test("the Devices tab replaces Controllables and lists no inverter", async ({ page }) => {
    await mountEditor(page);
    const tabs = page.locator("helman-config-editor-panel").locator(".tabs button");
    await expect(tabs).toContainText(["Energy nodes", "Devices"]);
    await expect(tabs.filter({ hasText: "Controllables" })).toHaveCount(0);

    await openTab(page, "Devices");
    await expect
        .poll(() => visibleCardIds(page))
        .toEqual([
            "jistic_klimatizace_energy",
            "klima_obyvak",
            "klima_loznice",
            "study",
            "pc",
            "lamp",
            "boiler",
        ]);
});

test("the overview row shows the resolved name, icon and derived badges", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    // The name nobody typed comes from the backend's resolution.
    await expect
        .poll(() =>
            page.evaluate(() => window.__own("jistic_klimatizace_energy", ".card-title strong")[0]?.textContent?.trim()),
        )
        .toBe("AC breaker");
    expect(await page.evaluate(() => window.__inspectKeys)).toEqual(
        expect.arrayContaining(["devices.consumers.0.name", "devices.consumers.0.icon", "devices.consumers.0.children.0.name"]),
    );
    const breaker = await page.evaluate(() => ({
        icon: (window.__own("jistic_klimatizace_energy", "summary ha-icon")[0] as any)?.icon,
        namePlaceholder: window
            .__own("jistic_klimatizace_energy", ".field")
            .find((field) => field.querySelector("label")?.textContent?.trim() === "Name")
            ?.querySelector("input")
            ?.getAttribute("placeholder"),
        id: (window.__own("jistic_klimatizace_energy", "input.device-id")[0] as HTMLInputElement)
            .readOnly,
        badges: window
            .__own("jistic_klimatizace_energy", ".device-badge")
            .map((badge) => badge.dataset.badge),
    }));
    expect(breaker).toEqual({
        icon: "mdi:air-conditioner",
        namePlaceholder: "AC breaker",
        id: true,
        badges: ["energy", "power"],
    });

    const badges = (id: string) =>
        page.evaluate(
            (id) => window.__own(id, ".device-badge").map((badge) => badge.dataset.badge),
            id,
        );
    expect(await badges("klima_obyvak")).toEqual(["switch", "schedulable"]);
    expect(await badges("boiler")).toEqual(["energy", "switch", "schedulable"]);
});

test("the filter shows schedulable or passive devices, keeping their parents", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Devices");
    const filter = page.locator("helman-config-editor-panel").locator(".device-filter button");

    await filter.filter({ hasText: "Schedulable" }).click();
    await expect
        .poll(() => visibleCardIds(page))
        .toEqual(["jistic_klimatizace_energy", "klima_obyvak", "klima_loznice", "boiler"]);

    await filter.filter({ hasText: "Passive" }).click();
    await expect
        .poll(() => visibleCardIds(page))
        .toEqual(["jistic_klimatizace_energy", "study", "pc", "lamp"]);
});

test("adding a device takes one entity and generates its id", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");
    // The top-level button comes after every card, each of which may hold a
    // child button of its own.
    await addDevice(page, ".add-device", "sensor.washer_energy", -1);
    await expect.poll(async () => (await config(page)).at(-1)).toEqual({
        id: "washer_energy",
        consumption: { energy_entity_id: "sensor.washer_energy" },
    });

    // An object id that is already a device id gets a suffix.
    await addDevice(page, ".add-device", "sensor.study", -1);
    await expect.poll(async () => (await config(page)).at(-1)?.id).toBe("study_2");

    // Under a parent, a climate entity makes a child on the parent's meter,
    // as schedulable as the siblings already there.
    await addDevice(page, ".add-device", "climate.kuchyn");
    await expect.poll(async () => (await config(page))[0].children.at(-1)).toEqual({
        id: "kuchyn",
        kind: "climate",
        controls: { climate: { entity_id: "climate.kuchyn" } },
        schedulable: true,
        consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 1 } },
    });

    // A light is switched like a switch: it becomes the child's switch control.
    await addDevice(page, ".add-device", "light.hall");
    await expect.poll(async () => (await config(page))[0].children.at(-1)).toEqual({
        id: "hall",
        controls: { switch: { entity_id: "light.hall" } },
        schedulable: true,
        consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 1 } },
    });
});

test("new scheduling uses the displayed fixed projection without changing the selector", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");
    await addDevice(page, ".add-device", "sensor.washer_energy", -1);
    await setSchedulable(page, "washer_energy", true);
    // The figure the backend requires comes with it, so the draft stays valid.
    await expect.poll(async () => (await config(page)).at(-1)?.consumption.projection).toEqual({
        strategy: "fixed",
        hourly_energy_kwh: 1,
    });
});

test("scheduling keeps a configured projection's figures and seeds the required fallback", async ({ page }) => {
    const learner = {
        id: "boiler",
        consumption: {
            energy_entity_id: "sensor.boiler_energy",
            projection: { strategy: "history_average", lookback_days: 14 },
        },
    };
    await mountEditor(page, [learner]);
    await openTab(page, "Devices");
    await setSchedulable(page, "boiler", true);
    await expect.poll(async () => (await config(page))[0].schedulable).toBe(true);
    // The backend requires hourly_energy_kwh for every strategy, so it is
    // seeded; the configured strategy and lookback stay as they were.
    expect((await config(page))[0].consumption.projection).toEqual({
        strategy: "history_average",
        lookback_days: 14,
        hourly_energy_kwh: 1,
    });
});

test("generated child ids avoid share sensor slug collisions", async ({ page }) => {
    const breaker = structuredClone(BREAKER);
    breaker.children[0].id = "ac-room";
    await mountEditor(page, [breaker]);
    await openTab(page, "Devices");
    await addDevice(page, ".add-device", "climate.ac_room");
    await expect.poll(async () => (await config(page))[0].children.at(-1)?.id).toBe("ac_room_2");
});

test("reordering devices closes an add picker tied to the old parent path", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");
    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".add-device").first().dispatchEvent("click");
    await expect(panel.locator(".add-device-picker")).toHaveCount(1);
    await panel.locator("ha-sortable").first().evaluate((sortable) => {
        sortable.dispatchEvent(new CustomEvent("item-moved", {
            detail: { oldIndex: 0, newIndex: 1 }, bubbles: true, composed: true,
        }));
    });
    await expect.poll(async () => (await config(page))[1].id).toBe(BREAKER.id);
    await expect(panel.locator(".add-device-picker")).toHaveCount(0);
});

test("nested children render and edit in place", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    await page.evaluate(() => {
        const field = window
            .__own("klima_loznice", ".field")
            .find((candidate) => candidate.querySelector("label")?.textContent?.trim() === "Name");
        const input = field?.querySelector("input") as HTMLInputElement;
        input.value = "Bedroom AC";
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });

    const devices = await config(page);
    expect(devices[0].children[1]).toEqual({ ...klima("klima_loznice"), name: "Bedroom AC" });
    expect(devices[0].children[0]).toEqual(klima("klima_obyvak"));
});

test("changing a child kind clears controls that could hide its new running signal", async ({ page }) => {
    const study = structuredClone(STUDY);
    (study.children[1] as Device).controls.switch.entity_id = "switch.lamp";
    await mountEditor(page, [BREAKER, study, BOILER]);
    await openTab(page, "Devices");
    await page.evaluate(() => {
        const picker = window.__own("lamp", "select.device-kind")[0] as HTMLSelectElement;
        picker.value = "climate";
        picker.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
    await expect.poll(async () => (await config(page))[1].children[1].kind).toBe("climate");
    expect((await config(page))[1].children[1]).not.toHaveProperty("controls");
    await page.evaluate(() => {
        const group = window.__own("lamp", "helman-entity-group").find(
            (element) => (element as HTMLElement & { path: string[] }).path.includes("climate"),
        );
        group?.shadowRoot?.querySelector("ha-entity-picker")?.dispatchEvent(new CustomEvent("value-changed", {
            detail: { value: "climate.lamp" }, bubbles: true, composed: true,
        }));
    });
    await expect.poll(async () => (await config(page))[1].children[1].controls).toEqual({
        climate: { entity_id: "climate.lamp" },
    });
});

test("the parent picker lists only non-schedulable meter owners", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    const options = (id: string) =>
        page.evaluate(
            (id) =>
                Array.from(
                    (window.__own(id, "select.device-parent")[0] as HTMLSelectElement).options,
                ).map((option) => option.textContent?.trim()),
            id,
        );
    // Never the boiler itself, a schedulable device, or a device without a
    // meter of its own.
    await expect
        .poll(() => options("boiler"))
        .toEqual(["None (top level)", "AC breaker", "Study breaker", "PC"]);
    // Never anything under the device being moved.
    expect(await options("study")).toEqual(["None (top level)", "AC breaker"]);
});

test("the parent picker moves a device with its subtree", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    await choose(page, "study", "select.device-parent", "devices.consumers.0");
    await expect.poll(() => config(page)).toEqual([
        { ...BREAKER, children: [...BREAKER.children, STUDY] },
        BOILER,
    ]);

    // And back out to the top level; the emptied list is not left behind.
    await choose(page, "pc", "select.device-parent", "");
    const devices = await config(page);
    expect(devices.at(-1)).toEqual(STUDY.children[0]);
    expect(devices[0].children[2]).toEqual({ ...STUDY, children: [STUDY.children[1]] });
});

test("schedulable toggles one metered device at a time", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    await setSchedulable(page, "boiler", false);
    await setSchedulable(page, "pc", true);

    const devices = await config(page);
    expect(devices[2]).not.toHaveProperty("schedulable");
    expect(devices[1].children[0].schedulable).toBe(true);
    expect(devices[1]).not.toHaveProperty("schedulable");
    expect(devices[1].children[1]).not.toHaveProperty("schedulable");
});

test("schedulable flips the whole meterless sibling set together", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    expect(
        await page.evaluate(() => window.__own("klima_obyvak", ".schedulable-note")[0]?.textContent?.trim()),
    ).toContain("all 2 devices");

    await setSchedulable(page, "klima_obyvak", false);
    await expect
        .poll(async () => (await config(page))[0].children.map((child: Device) => child.schedulable))
        .toEqual([undefined, undefined]);

    await setSchedulable(page, "klima_loznice", true);
    await expect
        .poll(async () => (await config(page))[0].children.map((child: Device) => child.schedulable))
        .toEqual([true, true]);
});

test("schedulable is disabled with a reason on a device with children", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    const field = await page.evaluate(() => ({
        disabled: window.__own("study", ".schedulable-field ha-switch")[0]?.hasAttribute("disabled"),
        note: window.__own("study", ".schedulable-note")[0]?.textContent?.trim(),
        explanation: window.__own("study", ".schedulable-field .helper")[0]?.textContent?.trim(),
    }));
    expect(field).toEqual({
        disabled: true,
        note: "A device with children cannot be schedulable; make its children schedulable instead.",
        explanation:
            "Helman may plan and run it; it can be an optimizer target; its consumption then leaves the baseline forecast.",
    });
    expect(
        await page.evaluate(() =>
            window.__own("boiler", ".schedulable-field ha-switch")[0]?.hasAttribute("disabled"),
        ),
    ).toBe(false);
});

test("a passive meterless child's control is editable and required", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    const group = await page.evaluate(() => {
        const found = window.__own("lamp", "helman-entity-group") as (HTMLElement & {
            path: (string | number)[];
            required: boolean;
        })[];
        return found.map((candidate) => ({
            path: candidate.path.join("."),
            required: candidate.required,
        }));
    });
    expect(group).toContainEqual({
        path: "devices.consumers.1.children.1.controls.switch.entity_id",
        required: true,
    });
    // No projection on a passive device.
    expect(
        await page.evaluate(() => window.__own("lamp", "select.projection-strategy").length),
    ).toBe(0);

    await page.evaluate(() => {
        const found = window.__own("lamp", "helman-entity-group").find(
            (candidate: any) => candidate.path.join(".").endsWith("controls.switch.entity_id"),
        );
        found?.shadowRoot?.querySelector("ha-entity-picker")?.dispatchEvent(
            new CustomEvent("value-changed", {
                detail: { value: "switch.lamp" },
                bubbles: true,
                composed: true,
            }),
        );
    });
    await expect
        .poll(async () => (await config(page))[1].children[1].controls.switch.entity_id)
        .toBe("switch.lamp");
});

test("the tree round-trips through YAML, whole and per card", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");
    const panel = page.locator("helman-config-editor-panel");
    const fire = (value: unknown) =>
        panel.locator("ha-yaml-editor").evaluate((editor, value) => {
            editor.dispatchEvent(
                new CustomEvent("value-changed", {
                    detail: { value, isValid: true },
                    bubbles: true,
                    composed: true,
                }),
            );
        }, value);

    // The tab's YAML is the whole `devices` section, and handing it back changes nothing.
    await panel.locator(".scope-toolbar .mode-toggle button", { hasText: "YAML" }).click();
    const tabYaml = await panel
        .locator("ha-yaml-editor")
        .evaluate((editor) => (editor as any).defaultValue);
    expect(tabYaml).toEqual({ system: [INVERTER], consumers: DEVICES });
    await fire(tabYaml);
    await panel.locator(".scope-toolbar .mode-toggle button", { hasText: "Visual" }).click();
    expect(await config(page)).toEqual(DEVICES);
    await expect.poll(() => visibleCardIds(page)).toContain("klima_loznice");

    // A nested card's YAML is that device alone.
    await page.evaluate(() => {
        const button = window
            .__own("pc", "summary .mode-toggle button")
            .find((candidate) => candidate.textContent?.trim() === "YAML");
        button?.click();
    });
    const pcYaml = await panel
        .locator("ha-yaml-editor")
        .evaluate((editor) => (editor as any).defaultValue);
    expect(pcYaml).toEqual(STUDY.children[0]);
    await fire({ ...pcYaml, name: "Workstation" });
    const devices = await config(page);
    expect(devices[1]).toEqual({
        ...STUDY,
        children: [{ ...STUDY.children[0], name: "Workstation" }, STUDY.children[1]],
    });
    expect(devices[0]).toEqual(BREAKER);
});

for (const ancestor of ["card", "tab"] as const) {
    test(`replacing ${ancestor} YAML clears descendant caches and removed errors`, async ({ page }) => {
        await mountEditor(page);
        await openTab(page, "Devices");
        const panel = page.locator("helman-config-editor-panel");
        const mode = async (id: string, label: string) => {
            await page.evaluate(({ id, label }) => {
                window.__own(id, "summary .mode-toggle button").find(
                    (button) => button.textContent?.trim() === label,
                )?.click();
            }, { id, label });
        };
        await mode("pc", "YAML");
        await expect(panel.locator("ha-yaml-editor")).toHaveCount(1);
        await panel.locator("ha-yaml-editor").evaluate((editor) => {
            editor.dispatchEvent(new CustomEvent("value-changed", {
                detail: { isValid: false, errorMsg: "Broken child YAML" },
                bubbles: true, composed: true,
            }));
        });
        await expect(panel.locator(".header button", { hasText: "Save" })).toBeDisabled();

        if (ancestor === "card") {
            await mode("study", "YAML");
        } else {
            await panel.locator(".scope-toolbar .mode-toggle button", { hasText: "YAML" }).click();
        }
        const nextStudy = { ...STUDY, children: [STUDY.children[1]] };
        const replacement = ancestor === "card"
            ? nextStudy
            : { system: [INVERTER], consumers: [BREAKER, nextStudy, BOILER] };
        await panel.locator("ha-yaml-editor").evaluate((editor, value) => {
            editor.dispatchEvent(new CustomEvent("value-changed", {
                detail: { value, isValid: true }, bubbles: true, composed: true,
            }));
        }, replacement);
        if (ancestor === "card") {
            await mode("study", "Visual");
        } else {
            await panel.locator(".scope-toolbar .mode-toggle button", { hasText: "Visual" }).click();
        }
        await expect(panel.locator("ha-yaml-editor")).toHaveCount(0);
        await expect(panel.locator(".header button", { hasText: "Save" })).toBeEnabled();
        await mode("lamp", "YAML");
        await expect(panel.locator("ha-yaml-editor")).toHaveCount(1);
        expect(await panel.locator("ha-yaml-editor").evaluate((editor) => (editor as any).defaultValue))
            .toEqual(STUDY.children[1]);
        expect((await config(page))[1]).toEqual(nextStudy);
    });
}

test("validation errors surface on the nested card they name", async ({ page }) => {
    const issue = (path: string, message: string) => ({
        section: "devices",
        path,
        code: "x",
        message,
    });
    await mountEditor(page, DEVICES, {
        valid: false,
        errors: [
            issue("devices.consumers[1].children[1].controls", "lamp needs a switch"),
            issue("devices.consumers[1].children", "study children rule"),
            issue("devices.consumers[0].children[0].consumption.projection", "obyvak projection"),
        ],
        warnings: [],
    });
    await openTab(page, "Devices");
    await page
        .locator("helman-config-editor-panel")
        .locator(".actions button", { hasText: "Validate" })
        .click();

    const issues = (id: string) =>
        page.evaluate(
            (id) =>
                window
                    .__own(id, ".device-issues li")
                    .map((item) => item.lastElementChild?.textContent?.trim()),
            id,
        );
    await expect.poll(() => issues("lamp")).toEqual(["lamp needs a switch"]);
    expect(await issues("study")).toEqual(["study children rule"]);
    expect(await issues("klima_obyvak")).toEqual(["obyvak projection"]);
    expect(await issues("jistic_klimatizace_energy")).toEqual([]);
    expect(
        await page.evaluate(() =>
            window.__own("lamp", '.device-badge[data-badge="issues"]')[0]?.textContent?.trim(),
        ),
    ).toBe("Issues: 1");
});

test("the empty state says nothing is imported and offers Add device", async ({ page }) => {
    await mountEditor(page, []);
    await openTab(page, "Devices");
    const panel = page.locator("helman-config-editor-panel");

    await expect(panel.locator(".devices-empty")).toContainText(
        "Nothing is imported automatically after installation",
    );
    await expect(panel.locator(".add-device")).toHaveText("Add device");
    await expect(panel.locator("details.device-card")).toHaveCount(0);
});

const system = (page: Page) => page.evaluate(() => window.__editorConfig().devices.system);

test("the inverter is edited in the System section of the Devices tab", async ({ page }) => {
    await mountEditor(page);
    const panel = page.locator("helman-config-editor-panel");
    await openTab(page, "Devices");

    const inverter = panel.locator("details.inverter-card");
    await expect(inverter.locator(".card-title strong")).toHaveText("Inverter");
    await inverter.evaluate((card) => {
        const field = Array.from(card.querySelectorAll(".field")).find(
            (candidate) => candidate.querySelector("label")?.textContent?.trim() === "Stop export option",
        );
        const input = field?.querySelector("input") as HTMLInputElement;
        input.value = "Feed-in Priority";
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
    await expect
        .poll(async () => (await system(page))?.[0].controls.mode.options.stop_export)
        .toBe("Feed-in Priority");
    await expect(
        inverter.locator("helman-entity-group").evaluate((group: any) => group.path.join(".")),
    ).resolves.toBe("devices.system.0.controls.mode.entity_id");
    // The consumer list never holds it.
    expect((await config(page)).map((device) => device.id)).toEqual([BREAKER.id, STUDY.id, BOILER.id]);
});

test("Add inverter is offered in the System section only while there is none", async ({
    page,
}) => {
    await mountEditor(page, [BOILER], undefined, []);
    const panel = page.locator("helman-config-editor-panel");
    await openTab(page, "Devices");

    const add = panel.locator(".section-footer .add-button", { hasText: "Add inverter" });
    await expect(add).toHaveCount(1);
    await add.dispatchEvent("click");
    await expect.poll(async () => (await system(page))?.map((device) => device.kind)).toEqual([
        "inverter",
    ]);
    expect((await config(page)).map((device) => device.kind)).toEqual(["generic"]);
    await expect(add).toHaveCount(0);
    await expect(panel.locator("details.inverter-card")).toHaveCount(1);
});

test("Energy nodes has no inverter section", async ({ page }) => {
    await mountEditor(page);
    const panel = page.locator("helman-config-editor-panel");
    await openTab(page, "Energy nodes");

    await expect(panel.locator("details.inverter-card")).toHaveCount(0);
    await expect(panel.locator(".section-summary-label", { hasText: /^Inverter$/ })).toHaveCount(0);
});

test("the EV charger gets a meter and its lists but no projection", async ({ page }) => {
    await mountEditor(page, [
        {
            kind: "ev_charger",
            schedulable: true,
            id: "ev",
            name: "EV Charging",
            limits: { max_charging_power_kw: 11 },
            controls: {
                charge: { entity_id: "switch.ev_charge" },
                use_mode: { entity_id: "input_select.ev_use_mode", values: {} },
                eco_gear: { entity_id: "input_select.ev_eco_gear", values: {} },
            },
            vehicles: [],
            consumption: { energy_entity_id: "sensor.ev_energy_total" },
        },
    ]);
    await openTab(page, "Devices");

    const sections = await page.evaluate(() =>
        window.__own("ev", ".section-summary-label").map((label) => label.textContent?.trim()),
    );
    expect(sections).toEqual([
        "Identity",
        "Measurements",
        "Controls",
        "Use modes",
        "Eco gears",
        "Vehicles",
    ]);
});

const candidate = (entityId: string) => ({
  entityId,
  name: "Breaker switch",
  reasons: [{ code: "same_device" }, { code: "name_match" }],
  rank: 1,
});

test("viewing ambiguous suggestions keeps the draft clean and preserves other choices", async ({ page }) => {
    const device = { id: "breaker", controls: { switch: { entity_id: "switch.anchor" } } };
    await mountEditor(page, [device]);
    await openTab(page, "Devices");
    await page.evaluate(() => { window.__card("breaker")!.open = true; });
    await deviceResponse(page, "helman/suggest_device_entities", {
        energy: [candidate("sensor.energy_a"), candidate("sensor.energy_b")],
        power: [candidate("sensor.power_a"), candidate("sensor.power_b")],
        switch: [],
    });
    await page.locator(".apply-suggestions").click();
    await expect(page.locator('select.suggestion-candidates[data-field="energy"]')).toBeVisible();
    expect(await page.evaluate(() => (document.querySelector("helman-config-editor-panel") as any)._dirty)).toBe(false);
    expect(await config(page)).toEqual([device]);
    await page.locator('select.suggestion-candidates[data-field="energy"]').selectOption("sensor.energy_b");
    await expect(page.locator('select.suggestion-candidates[data-field="power"]')).toBeVisible();
    await page.locator('select.suggestion-candidates[data-field="power"]').selectOption("sensor.power_a");
    expect((await config(page))[0].consumption).toEqual({ energy_entity_id: "sensor.energy_b", power_entity_id: "sensor.power_a" });
});

async function deviceResponse(
  page: Page,
  type: string,
  response: unknown,
  deferred = false,
): Promise<void> {
  await page.evaluate(
    ({ type, response, deferred }) => {
      const panel = document.querySelector("helman-config-editor-panel") as any;
      const previous = panel.hass.callWS;
      panel.hass.callWS = async (request: any) => {
        if (request.type !== type) return previous(request);
        (window as any).__deviceRequest = request;
        if (deferred)
          return new Promise((resolve) => {
            (window as any).__resolveDeviceRequest = () => resolve(response);
          });
        return response;
      };
    },
    { type, response, deferred },
  );
}

function importResponse(
  devices: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    devices,
    additions: [
      {
        deviceId: "restored",
        energyEntityId: "sensor.restored",
        powerEntityId: null,
        parentId: null,
      },
    ],
    powerEntities: [],
    nestingChanges: [],
    skippedRows: [],
    warnings: [],
    validation: { valid: true, errors: [] },
    ...overrides,
  };
}

test("Apply suggestions fills empty singleton fields and exposes all six switches for selection", async ({
  page,
}) => {
  const passive = {
    id: "breaker",
    consumption: { energy_entity_id: "sensor.energy" },
  };
  await mountEditor(page, [passive]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("breaker")!.open = true;
  });
  await deviceResponse(page, "helman/suggest_device_entities", {
    energy: [candidate("sensor.other")],
    power: [candidate("sensor.power")],
    switch: Array.from({ length: 6 }, (_, index) =>
      candidate(`switch.breaker_${index}`),
    ),
  });
  await page.locator(".apply-suggestions").click();
  await expect
    .poll(async () => (await config(page))[0].consumption.power_entity_id)
    .toBe("sensor.power");
  expect((await config(page))[0].consumption.energy_entity_id).toBe(
    "sensor.energy",
  );
  expect((await config(page))[0].controls).toBeUndefined();
  await expect(
    page.locator('select.suggestion-candidates[data-field="switch"] option'),
  ).toHaveCount(7);
  await expect(
    page.locator('select.suggestion-candidates[data-field="switch"]'),
  ).toContainText("Same Home Assistant device, Name matches the device");
  await page
    .locator('select.suggestion-candidates[data-field="switch"]')
    .selectOption("switch.breaker_4");
  expect((await config(page))[0].controls.switch.entity_id).toBe(
    "switch.breaker_4",
  );
  await deviceResponse(page, "helman/suggest_device_entities", {
    energy: [],
    power: [candidate("sensor.replace")],
    switch: [candidate("switch.replace")],
  });
  await page.locator(".apply-suggestions").click();
  await page.waitForTimeout(30);
  expect((await config(page))[0].consumption.power_entity_id).toBe(
    "sensor.power",
  );
  expect((await config(page))[0].controls.switch.entity_id).toBe(
    "switch.breaker_4",
  );
});

test("import preview cancel is inert and apply changes only the draft with moves and overlap warnings", async ({
  page,
}) => {
  const parent = {
    id: "parent",
    consumption: { energy_entity_id: "sensor.parent" },
  };
  const child = {
    id: "child",
    consumption: { energy_entity_id: "sensor.child" },
    children: [
      {
        id: "plug",
        schedulable: true,
        controls: { switch: { entity_id: "switch.plug" } },
      },
    ],
  };
  const restored = {
    id: "restored",
    consumption: {
      energy_entity_id: "sensor.restored",
      power_entity_id: "sensor.restored_power",
    },
  };
  await mountEditor(page, [parent, child]);
  await openTab(page, "Devices");
  await deviceResponse(
    page,
    "helman/preview_energy_import",
    importResponse([{ ...parent, children: [child] }, restored], {
      additions: [
        {
          deviceId: "restored",
          energyEntityId: "sensor.restored",
          powerEntityId: "sensor.restored_power",
          parentId: null,
        },
      ],
      nestingChanges: [
        { deviceId: "child", fromParentId: null, parentId: "parent" },
      ],
      skippedRows: [
        {
          energy_entity_id: "external:stat",
          reason: "external_statistic",
          device_id: null,
        },
      ],
      warnings: [
        {
          energy_entity_id: "sensor.pool_heater",
          device_id: "climate-pool",
          reason: "schedulable",
        },
      ],
    }),
  );
  await page.locator(".import-energy").click();
  await expect(page.locator(".energy-import-preview")).toContainText(
    "restored — sensor.restored, sensor.restored_power",
  );
  await expect(page.locator(".energy-import-preview")).toContainText(
    "child → parent",
  );
  // Codes from the backend are worded by the editor's translations.
  await expect(page.locator(".energy-import-preview")).toContainText(
    "Energy reports sensor.pool_heater inside the meter of schedulable device climate-pool",
  );
  await expect(page.locator(".energy-import-preview")).toContainText(
    "external:stat — an external statistic, not an entity",
  );
  await page.locator(".cancel-energy-import").click();
  expect(await config(page)).toEqual([parent, child]);
  // The move shifts "child" off devices.consumers[1]; its YAML state must not follow the path.
  await page.evaluate(() => {
    window
      .__own("child", "summary .mode-toggle button")
      .find((button) => button.textContent?.trim() === "YAML")
      ?.click();
  });
  await expect(page.locator("ha-yaml-editor")).toHaveCount(1);
  await page.locator(".import-energy").click();
  await page.locator(".apply-energy-import").click();
  expect(await config(page)).toEqual([
    { ...parent, children: [child] },
    restored,
  ]);
  await expect(page.locator("ha-yaml-editor")).toHaveCount(0);
  await expect(page.locator(".energy-import-preview")).toHaveCount(0);
  await deviceResponse(
    page,
    "helman/preview_energy_import",
    importResponse(await config(page), { additions: [] }),
  );
  await page.locator(".import-energy").click();
  await expect(page.locator(".energy-import-preview")).toContainText(
    "No changes to apply",
  );
});

test("late suggestions and previews are discarded after the draft changes", async ({
  page,
}) => {
  const device = {
    id: "breaker",
    consumption: { energy_entity_id: "sensor.energy" },
  };
  await mountEditor(page, [device]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("breaker")!.open = true;
  });
  await deviceResponse(
    page,
    "helman/suggest_device_entities",
    { energy: [], power: [candidate("sensor.stale")], switch: [] },
    true,
  );
  await page.locator(".apply-suggestions").click();
  await page.waitForFunction(() => !!(window as any).__resolveDeviceRequest);
  await page.evaluate(() => {
    const panel = document.querySelector("helman-config-editor-panel") as any;
    panel._applyMutation((draft: any) => {
      draft.devices.consumers[0].name = "New draft name";
    });
    (window as any).__resolveDeviceRequest();
  });
  await page.waitForTimeout(30);
  expect((await config(page))[0].consumption.power_entity_id).toBeUndefined();
  await deviceResponse(
    page,
    "helman/preview_energy_import",
    importResponse([]),
    true,
  );
  await page.locator(".import-energy").click();
  await page.evaluate(() => {
    const panel = document.querySelector("helman-config-editor-panel") as any;
    panel._applyMutation((draft: any) => {
      draft.devices.consumers[0].name = "Still newer";
    });
    (window as any).__resolveDeviceRequest();
  });
  await page.waitForTimeout(30);
  await expect(page.locator(".energy-import-preview")).toHaveCount(0);
  expect((await config(page))[0].name).toBe("Still newer");
});

test("visible candidates disappear when the draft is replaced outside a field edit", async ({
  page,
}) => {
  const device = {
    id: "breaker",
    consumption: { energy_entity_id: "sensor.energy" },
  };
  await mountEditor(page, [device]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("breaker")!.open = true;
  });
  await deviceResponse(page, "helman/suggest_device_entities", {
    energy: [],
    power: [candidate("sensor.old_a"), candidate("sensor.old_b")],
    switch: [],
  });
  await page.locator(".apply-suggestions").click();
  await expect(
    page.locator('select.suggestion-candidates[data-field="power"]'),
  ).toHaveCount(1);
  // YAML editors and reloads assign the draft directly, keeping the device id.
  await page.evaluate(() => {
    const panel = document.querySelector("helman-config-editor-panel") as any;
    panel._config = {
      ...panel._config,
      devices: { consumers: [{ id: "breaker", consumption: { energy_entity_id: "sensor.new" } }] },
    };
  });
  await expect(
    page.locator('select.suggestion-candidates[data-field="power"]'),
  ).toHaveCount(0);
});

test("invalid import cannot be applied and empty state offers import", async ({
  page,
}) => {
  await mountEditor(page, []);
  await openTab(page, "Devices");
  await expect(page.locator(".devices-empty")).toBeVisible();
  // Importing is a list action, offered beside "Add device" below the list.
  await expect(
    page.locator(".section-footer:has(.add-device) .import-energy"),
  ).toHaveCount(1);
  await deviceResponse(
    page,
    "helman/preview_energy_import",
    importResponse([], {
      validation: {
        valid: false,
        errors: [{ path: "devices.consumers[0]", message: "Invalid draft" }],
      },
    }),
  );
  await page.locator(".import-energy").click();
  await expect(page.locator(".apply-energy-import")).toBeDisabled();
  await expect(page.locator(".energy-import-preview")).toContainText(
    "The import would add errors of these kinds.",
  );
  expect(await config(page)).toEqual([]);
});

test("Apply suggestions is disabled until the device has an entity to anchor on", async ({
  page,
}) => {
  await mountEditor(page, [{ id: "blank", name: "Blank" }]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("blank")!.open = true;
  });
  await expect(page.locator(".apply-suggestions")).toBeDisabled();
});

test("suggestions are anchored on the switching control, never a mode select", async ({
  page,
}) => {
  // The mode select is listed first in the config but never anchors: it may
  // belong to another integration's device. Entity ids are trimmed.
  const ev = {
    id: "garage-ev",
    kind: "ev_charger",
    controls: {
      use_mode: { entity_id: "input_select.ev_mode" },
      charge: { entity_id: " switch.ev_charge " },
    },
  };
  await mountEditor(page, [ev]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("garage-ev")!.open = true;
  });
  await deviceResponse(page, "helman/suggest_device_entities", {
    energy: [candidate("sensor.ev_energy")],
    power: [candidate("sensor.ev_power")],
    switch: [],
  });
  await page.locator(".apply-suggestions").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__deviceRequest?.anchor_entity_ids))
    .toEqual(["switch.ev_charge"]);
  await expect
    .poll(async () => (await config(page))[0].consumption)
    .toEqual({ energy_entity_id: "sensor.ev_energy", power_entity_id: "sensor.ev_power" });
});

test("a device's meter and climate control lead its anchors", async ({ page }) => {
  await mountEditor(page, [
    {
      id: "ac",
      kind: "climate",
      consumption: { energy_entity_id: "sensor.ac_energy" },
      controls: { climate: { entity_id: "climate.ac" } },
    },
  ]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("ac")!.open = true;
  });
  await deviceResponse(page, "helman/suggest_device_entities", {
    energy: [],
    power: [],
    switch: [],
  });
  await page.locator(".apply-suggestions").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__deviceRequest?.anchor_entity_ids))
    .toEqual(["sensor.ac_energy", "climate.ac"]);
});

test("a charger with only its mode select has nothing to anchor on", async ({ page }) => {
  // Its HA device may be the car's or evcc's, whose sensors must not be
  // suggested as the charger's meter.
  await mountEditor(page, [
    {
      id: "garage-ev",
      kind: "ev_charger",
      controls: { use_mode: { entity_id: "select.evcc_mode" } },
    },
  ]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("garage-ev")!.open = true;
  });
  await expect(page.locator(".apply-suggestions")).toBeDisabled();
});

test("a failed suggestion request shows a readable error that a retry clears", async ({
  page,
}) => {
  const device = {
    id: "breaker",
    consumption: { energy_entity_id: "sensor.energy" },
  };
  await mountEditor(page, [device]);
  await openTab(page, "Devices");
  await page.evaluate(() => {
    window.__card("breaker")!.open = true;
    const panel = document.querySelector("helman-config-editor-panel") as any;
    const previous = panel.hass.callWS;
    panel.hass.callWS = async (request: any) =>
      request.type === "helman/suggest_device_entities"
        ? Promise.reject({ code: "unknown_error" })
        : previous(request);
  });
  await page.locator(".apply-suggestions").click();
  await expect(page.locator(".message.error")).toHaveText(
    "Failed to load entity suggestions.",
  );
  await deviceResponse(page, "helman/suggest_device_entities", {
    energy: [],
    power: [],
    switch: [],
  });
  await page.locator(".apply-suggestions").click();
  await expect(page.locator(".message.error")).toHaveCount(0);
});

test("an up-to-date Energy preview cannot dirty an unchanged draft", async ({ page }) => {
    const device = { id: "breaker", consumption: { energy_entity_id: "sensor.energy" } };
    await mountEditor(page, [device]);
    await openTab(page, "Devices");
    await deviceResponse(page, "helman/preview_energy_import", importResponse([device], { additions: [] }));
    await page.locator(".import-energy").click();
    await expect(page.locator(".energy-import-preview")).toContainText("No changes to apply");
    await expect(page.locator(".apply-energy-import")).toBeDisabled();
    expect(await page.evaluate(() => (document.querySelector("helman-config-editor-panel") as any)._dirty)).toBe(false);
    expect(await config(page)).toEqual([device]);
});

test("routine hass snapshots retain pending suggestions and import previews", async ({ page }) => {
    const device = { id: "breaker", consumption: { energy_entity_id: "sensor.energy" } };
    await mountEditor(page, [device]);
    await openTab(page, "Devices");
    await page.evaluate(() => { window.__card("breaker")!.open = true; });
    await deviceResponse(page, "helman/suggest_device_entities", { energy: [], power: [candidate("sensor.power")], switch: [] }, true);
    await page.locator(".apply-suggestions").click();
    await page.waitForFunction(() => !!(window as any).__resolveDeviceRequest);
    await page.evaluate(() => {
        const panel = document.querySelector("helman-config-editor-panel") as any;
        panel.hass = { ...panel.hass, states: { ...panel.hass.states } };
        (window as any).__resolveDeviceRequest();
        delete (window as any).__resolveDeviceRequest;
    });
    await expect.poll(async () => (await config(page))[0].consumption.power_entity_id).toBe("sensor.power");
    await deviceResponse(page, "helman/preview_energy_import", importResponse(await config(page), { additions: [] }), true);
    await page.locator(".import-energy").click();
    await page.waitForFunction(() => !!(window as any).__resolveDeviceRequest);
    await page.evaluate(() => {
        const panel = document.querySelector("helman-config-editor-panel") as any;
        panel.hass = { ...panel.hass, states: { ...panel.hass.states } };
        (window as any).__resolveDeviceRequest();
    });
    await expect(page.locator(".energy-import-preview")).toBeVisible();
});

for (const hasPower of [false, true]) {
    test(`shared-meter energy suggestions require a usable power sensor: ${hasPower}`, async ({ page }) => {
        const parent = {
            id: "parent",
            consumption: { energy_entity_id: "sensor.parent_energy", power_entity_id: "sensor.parent_power" },
            children: [
                { id: "first", controls: { switch: { entity_id: "switch.first" } } },
                { id: "second", controls: { switch: { entity_id: "switch.second" } } },
            ],
        };
        await mountEditor(page, [parent]);
        await openTab(page, "Devices");
        await page.evaluate(() => {
            window.__card("parent")!.open = true;
            window.__card("first")!.open = true;
        });
        await deviceResponse(page, "helman/suggest_device_entities", {
            energy: [candidate("sensor.first_energy")],
            power: hasPower ? [candidate("sensor.first_power")] : [],
            switch: [],
        });
        await page.locator('details[data-device-id="first"] .apply-suggestions').click();
        if (hasPower) {
            await expect.poll(async () => (await config(page))[0].children[0].consumption).toEqual({ energy_entity_id: "sensor.first_energy", power_entity_id: "sensor.first_power" });
        } else {
            await expect(page.locator('details[data-device-id="first"] select.suggestion-candidates[data-field="energy"]')).toBeVisible();
            expect(await config(page)).toEqual([parent]);
            expect(await page.evaluate(() => (document.querySelector("helman-config-editor-panel") as any)._dirty)).toBe(false);
        }
    });
}

test("suggestions preserve a climate child's control and shared meter", async ({ page }) => {
    await mountEditor(page, [BREAKER]);
    await openTab(page, "Devices");
    await page.evaluate(() => {
        window.__card("jistic_klimatizace_energy")!.open = true;
        window.__card("klima_obyvak")!.open = true;
    });
    await deviceResponse(page, "helman/suggest_device_entities", {
        energy: [candidate("sensor.jistic_klimatizace_energy")],
        power: [],
        switch: [candidate("switch.breaker")],
    });
    await page.locator('details[data-device-id="klima_obyvak"] .apply-suggestions').click();
    await expect.poll(async () => (await config(page))[0].children[0].controls).toEqual({ climate: { entity_id: "climate.klima_obyvak" } });
    expect((await config(page))[0].children[0].consumption.energy_entity_id).toBeUndefined();
});
