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
 * keeps its `devices` entry but is edited under Power devices.
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

const DEVICES = [INVERTER, BREAKER, STUDY, BOILER];

/** What the backend's name resolution answers, by name/icon path key. */
const PLACEHOLDERS: Record<string, string> = {
    "devices.1.name": "AC breaker",
    "devices.1.icon": "mdi:air-conditioner",
    "devices.1.children.0.name": "Obývák",
    "devices.1.children.1.name": "Ložnice",
};

type Device = Record<string, any>;

declare global {
    interface Window {
        __editorConfig: () => { devices: Device[] };
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
                (element as unknown as { _config: { devices: Device[] } })._config;
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
                                        placeholder: placeholders[target.key],
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
        { config: { config_version: 21, devices }, placeholders: PLACEHOLDERS, report: validation },
    );
}

async function openTab(page: Page, label: string): Promise<void> {
    await page
        .locator("helman-config-editor-panel")
        .locator(".tabs")
        .getByRole("button", { name: label, exact: true })
        .click();
}

const config = (page: Page) => page.evaluate(() => window.__editorConfig().devices);

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
    await expect(tabs).toContainText(["Power devices", "Devices"]);
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
        expect.arrayContaining(["devices.1.name", "devices.1.icon", "devices.1.children.0.name"]),
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
    await expect.poll(async () => (await config(page))[1].children.at(-1)).toEqual({
        id: "kuchyn",
        kind: "climate",
        controls: { climate: { entity_id: "climate.kuchyn" } },
        schedulable: true,
        consumption: { projection: { strategy: "fixed" } },
    });
});

test("new scheduling uses the displayed fixed projection without changing the selector", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");
    await addDevice(page, ".add-device", "sensor.washer_energy", -1);
    await setSchedulable(page, "washer_energy", true);
    await expect.poll(async () => (await config(page)).at(-1)?.consumption.projection.strategy).toBe("fixed");
});

test("generated child ids avoid share sensor slug collisions", async ({ page }) => {
    const breaker = structuredClone(BREAKER);
    breaker.children[0].id = "ac-room";
    await mountEditor(page, [INVERTER, breaker]);
    await openTab(page, "Devices");
    await addDevice(page, ".add-device", "climate.ac_room");
    await expect.poll(async () => (await config(page))[1].children.at(-1)?.id).toBe("ac_room_2");
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
    expect(devices[1].children[1]).toEqual({ ...klima("klima_loznice"), name: "Bedroom AC" });
    expect(devices[1].children[0]).toEqual(klima("klima_obyvak"));
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

    await choose(page, "study", "select.device-parent", "devices.1");
    await expect.poll(() => config(page)).toEqual([
        INVERTER,
        { ...BREAKER, children: [...BREAKER.children, STUDY] },
        BOILER,
    ]);

    // And back out to the top level; the emptied list is not left behind.
    await choose(page, "pc", "select.device-parent", "");
    const devices = await config(page);
    expect(devices.at(-1)).toEqual(STUDY.children[0]);
    expect(devices[1].children[2]).toEqual({ ...STUDY, children: [STUDY.children[1]] });
});

test("schedulable toggles one metered device at a time", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    await setSchedulable(page, "boiler", false);
    await setSchedulable(page, "pc", true);

    const devices = await config(page);
    expect(devices[3]).not.toHaveProperty("schedulable");
    expect(devices[2].children[0].schedulable).toBe(true);
    expect(devices[2]).not.toHaveProperty("schedulable");
    expect(devices[2].children[1]).not.toHaveProperty("schedulable");
});

test("schedulable flips the whole meterless sibling set together", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    expect(
        await page.evaluate(() => window.__own("klima_obyvak", ".schedulable-note")[0]?.textContent?.trim()),
    ).toContain("all 2 devices");

    await setSchedulable(page, "klima_obyvak", false);
    await expect
        .poll(async () => (await config(page))[1].children.map((child: Device) => child.schedulable))
        .toEqual([undefined, undefined]);

    await setSchedulable(page, "klima_loznice", true);
    await expect
        .poll(async () => (await config(page))[1].children.map((child: Device) => child.schedulable))
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
        path: "devices.2.children.1.controls.switch.entity_id",
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
        .poll(async () => (await config(page))[2].children[1].controls.switch.entity_id)
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

    // The tab's YAML is the whole tree, and handing it back changes nothing.
    await panel.locator(".scope-toolbar .mode-toggle button", { hasText: "YAML" }).click();
    const tabYaml = await panel
        .locator("ha-yaml-editor")
        .evaluate((editor) => (editor as any).defaultValue);
    expect(tabYaml).toEqual(DEVICES);
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
    expect(devices[2]).toEqual({
        ...STUDY,
        children: [{ ...STUDY.children[0], name: "Workstation" }, STUDY.children[1]],
    });
    expect(devices[1]).toEqual(BREAKER);
});

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
            issue("devices[2].children[1].controls", "lamp needs a switch"),
            issue("devices[2].children", "study children rule"),
            issue("devices[1].children[0].consumption.projection", "obyvak projection"),
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
    await mountEditor(page, [INVERTER]);
    await openTab(page, "Devices");
    const panel = page.locator("helman-config-editor-panel");

    await expect(panel.locator(".devices-empty")).toContainText(
        "Nothing is imported automatically after installation",
    );
    await expect(panel.locator(".add-device")).toHaveText("Add device");
    await expect(panel.locator("details.device-card")).toHaveCount(0);
});

test("the inverter is edited under Power devices", async ({ page }) => {
    await mountEditor(page);
    const panel = page.locator("helman-config-editor-panel");
    await openTab(page, "Power devices");

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
        .poll(async () => (await config(page))[0].controls.mode.options.stop_export)
        .toBe("Feed-in Priority");
    await expect(
        inverter.locator("helman-entity-group").evaluate((group: any) => group.path.join(".")),
    ).resolves.toBe("devices.0.controls.mode.entity_id");
});

test("Add inverter is offered under Power devices only while there is none", async ({
    page,
}) => {
    await mountEditor(page, [BOILER]);
    const panel = page.locator("helman-config-editor-panel");
    await openTab(page, "Power devices");

    const add = panel.locator(".section-footer .add-button", { hasText: "Add inverter" });
    await add.dispatchEvent("click");
    await expect.poll(async () => (await config(page)).map((device) => device.kind)).toEqual([
        "generic",
        "inverter",
    ]);
    await expect(add).toHaveCount(0);
    await expect(panel.locator("details.inverter-card")).toHaveCount(1);
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
