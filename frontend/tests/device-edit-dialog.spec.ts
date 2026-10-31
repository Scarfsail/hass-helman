import { configDoc } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { loadBundle } from "./support/card-page";

/**
 * Editing a device from its detail dialog.
 *
 * The Settings button in the detail footer opens `helman-device-edit-dialog`, which
 * mounts `helman-device-editor` -- the element the config panel's Devices tab
 * is made of -- over the detail. These tests pin what the dialog adds around
 * that shared form:
 *
 * - **Which device.** The card row carries a `deviceKey`: the device's own
 *   meter, or its id when it has none. Both find the device's form.
 * - **What the save sends.** `save_config` replaces the whole document, so the
 *   dialog sends the whole document, differing from the loaded one in the
 *   edited field and nowhere else.
 * - **What happens when the answer is no.** An unknown key is named rather
 *   than drawn as a blank card, and a refused save keeps the dialog open with
 *   the issue on the device.
 * - **Readings.** The dialog runs its own entity inspection, so the form's
 *   name placeholder is the backend's resolved name, as in the panel.
 */

const BOILER = {
    id: "boiler",
    consumption: {
        energy_entity_id: "sensor.boiler_energy",
        power_entity_id: "sensor.boiler_power",
    },
    children: [{ id: "pump", controls: { switch: { entity_id: "switch.pump" } } }],
};

const CONFIG = configDoc({

    devices: { consumers: [BOILER] },
    automation: { enabled: true, appliance_optimizers: [], system_optimizers: [] },
});

const STRINGS: Record<string, string> = {
    "node_detail.device.edit.button": "Settings",
    "node_detail.device.edit.title": "Edit device",
    "node_detail.device.edit.loading": "Loading configuration…",
    "node_detail.device.edit.load_failed": "Could not load the configuration",
    "node_detail.device.edit.not_found": "Device \"{key}\" is not in the stored configuration.",
    "node_detail.device.edit.close": "Close",
    "node_detail.device.edit.cancel": "Cancel",
    "node_detail.device.edit.discard": "Discard unsaved changes?",
};

const VALID = { valid: true, errors: [], warnings: [] };

interface MountOptions {
    deviceKey?: string;
    admin?: boolean;
    config?: unknown;
    saveResponse?: unknown;
    /** Leave the save request unanswered, so the save stays in flight. */
    hangSave?: boolean;
    /** The `helman/get_vendors` answer. */
    vendors?: unknown;
}

async function mountDetail(page: Page, options: MountOptions = {}): Promise<void> {
    const {
        deviceKey = "sensor.boiler_energy",
        admin = true,
        config = CONFIG,
        saveResponse = { success: true, validation: VALID, reloadStarted: true },
        hangSave = false,
        vendors = {},
    } = options;
    await loadBundle(page, "node-detail-dialog");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        if (!customElements.get("ha-yaml-editor")) customElements.define("ha-yaml-editor", class extends HTMLElement {});
    });
    await page.addScriptTag({ content: `
        customElements.define("ha-dialog-footer", class extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: "open" }).innerHTML =
                    '<style>footer { display:flex; justify-content:flex-end; gap:12px; width:100%; }</style>' +
                    '<footer><slot name="secondaryAction"></slot><slot name="primaryAction"></slot></footer>';
                this.style.cssText = "display:block;width:400px";
            }
        });
    ` });

    await page.evaluate(
        ({ config, key, save, hang, strings, vendors, admin }) => {
            const calls: { type: string; config?: unknown; expected_revision?: string; targets?: { key: string }[] }[] = [];
            (window as any).__calls = calls;
            const content = document.createElement("node-detail-dialog") as any;
            content.localize = (k: string) => strings[k] ?? k;
            content.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: admin },
                states: {},
                connection: window.__mockHass().connection,
                callWS: window.__mockHass({
                    "helman/get_config": async (request: any) => {
                        return JSON.parse(JSON.stringify(config));
                    },
                    "helman/save_config": async (request: any) => {
                        return hang ? new Promise(() => undefined) : save;
                    },
                    "helman/get_vendors": async (request: any) => {
                        return vendors;
                    },
                    "helman/inspect_entities": async (request: any) => {
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft: {
                                    entityId: null,
                                    status: "ok",
                                    facts: [],
                                    placeholder: target.key.endsWith(".name")
                                        ? target.key.includes("children") ? "Resolved pump" : "Resolved boiler"
                                        : undefined,
                                },
                                saved: null,
                            })),
                        };
                    }
                }, (request: any) => {
                    calls.push({ type: request.type, config: request.config, expected_revision: request.expected_revision, targets: request.targets });
                }).callWS,
            };
            content.params = {
                nodeType: "device",
                item: { id: key, name: "Boiler", displayName: "Boiler", deviceKey: key,
                    deviceKeyIsMeter: key.startsWith("sensor."), children: [] },
                ancestors: [],
            };
            content.open = true;
            document.body.appendChild(content);
        },
        { config, key: deviceKey, save: saveResponse, hang: hangSave, strings: STRINGS, vendors, admin },
    );
}

function editButton(page: Page) {
    return page.locator("node-detail-dialog ha-button[data-settings]");
}

function dialog(page: Page) {
    return page.locator("helman-device-edit-dialog");
}

async function openEdit(page: Page): Promise<void> {
    await editButton(page).click();
    await expect(dialog(page)).toHaveCount(1);
}

/** The ids of the device cards the dialog shows. */
function cardIds(page: Page) {
    return dialog(page).locator("details.device-card").evaluateAll((cards) =>
        cards.map((card) => (card as HTMLElement).dataset.deviceId));
}

/** Open one of the form's sections, which all start collapsed. */
async function openSection(page: Page, label: string): Promise<void> {
    await dialog(page)
        .locator("details.device-card").first().locator(":scope > .appliance-body > details.section-card", {
            has: page.locator(":scope > summary .section-summary-label", { hasText: label }),
        })
        .evaluate((details) => ((details as HTMLDetailsElement).open = true));
}

function nameInput(page: Page) {
    return dialog(page).locator("details.device-card .field-grid .field input").first();
}

async function calls(page: Page): Promise<{ type: string; config?: any; expected_revision?: string; targets?: { key: string }[] }[]> {
    return page.evaluate(() => (window as any).__calls);
}

test.describe("editing a device from its detail", () => {
    test("Settings in the footer opens the form of the device named by its meter", async ({ page }) => {
        await mountDetail(page, { deviceKey: "sensor.boiler_energy" });
        await expect(editButton(page)).toHaveText("Settings");
        await expect(editButton(page)).toHaveAttribute("slot", "secondaryAction");
        await expect(editButton(page)).toHaveAttribute("appearance", "plain");
        await expect(editButton(page)).toHaveAttribute("variant", "neutral");
        await expect(editButton(page).locator("ha-icon")).toHaveAttribute("icon", "mdi:cog");
        await expect(editButton(page).locator("ha-icon")).toHaveAttribute("slot", "start");
        const close = page.locator('node-detail-dialog ha-button[data-dialog="close"]');
        await expect(close).toHaveAttribute("slot", "primaryAction");
        await expect(close).toHaveAttribute("appearance", "filled");
        await expect(close).toHaveAttribute("variant", "neutral");
        const settingsBox = await editButton(page).boundingBox();
        const closeBox = await close.boundingBox();
        const footerBox = await page.locator("node-detail-dialog ha-dialog-footer").boundingBox();
        expect(settingsBox).not.toBeNull();
        expect(closeBox).not.toBeNull();
        expect(footerBox).not.toBeNull();
        expect(settingsBox!.x - footerBox!.x).toBeLessThan(2);
        expect(footerBox!.x + footerBox!.width - closeBox!.x - closeBox!.width).toBeLessThan(2);
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["boiler", "pump"]);
        // The root stays open with no list controls; child sections start collapsed.
        await expect(dialog(page).locator("details.device-card").first()).toHaveAttribute("open", "");
        await expect(dialog(page).locator("details.device-card").first().locator(":scope > summary .list-actions")).toHaveCount(0);
    });

    test("Settings opens the form of a meterless device named by its id", async ({ page }) => {
        await mountDetail(page, { deviceKey: "pump" });
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["pump"]);
    });

    test("Settings is hidden from non-admins", async ({ page }) => {
        await mountDetail(page, { admin: false });
        await expect(editButton(page)).toHaveCount(0);
        await expect(page.locator('node-detail-dialog ha-button[data-dialog="close"]')).toHaveAttribute("appearance", "filled");
    });

    test("saving sends the whole document with only the edited field changed", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await openSection(page, "Identity");
        await nameInput(page).fill("Hot water");
        await nameInput(page).dispatchEvent("change");
        await dialog(page).getByText("Save and reload").click();

        await expect.poll(async () =>
            (await calls(page)).filter((call) => call.type === "helman/save_config").length).toBe(1);
        const saved = (await calls(page)).find((call) => call.type === "helman/save_config")!;
        expect(saved.config).toEqual({
            ...CONFIG,
            devices: { consumers: [{ ...BOILER, name: "Hot water" }] },
        });
        expect(saved.expected_revision).toBeTruthy();
        expect((await calls(page)).filter((call) => call.type === "helman/get_config")).toHaveLength(1);
        // A successful save closes the edit dialog and returns to the detail.
        await expect(dialog(page)).toHaveCount(0);
        await expect(editButton(page)).toHaveCount(1);
    });

    test("a stale save reports a conflict without closing", async ({ page }) => {
        await mountDetail(page, { saveResponse: {
            success: false, conflict: true, config: CONFIG, revision: "newer-revision",
        } });
        await openEdit(page);
        await dialog(page).getByText("Save and reload").click();
        await expect(dialog(page).locator(".message.stale")).toHaveCount(1);
        expect((await calls(page)).filter((call) => call.type === "helman/get_config")).toHaveLength(1);
    });

    test("a config event raises the stale banner without a config fetch", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await page.evaluate(() => window.__fireDataChanged("config", "newer-revision"));
        await expect(dialog(page).locator(".message.stale")).toHaveCount(1);
        expect((await calls(page)).filter((call) => call.type === "helman/get_config")).toHaveLength(1);
    });

    test("changing a group saves it on the device only", async ({ page }) => {
        const grouped = {
            ...CONFIG,
            devices: {
                groupings: [{ id: "breakers", name: "Breakers", groups: [{ id: "garage", name: "Garage", short_name: "G" }] }],
                consumers: [BOILER],
            },
        };
        await mountDetail(page, { config: grouped });
        await openEdit(page);
        // The Groups and phase section starts collapsed.
        await openSection(page, "Groups and phase");
        await dialog(page).locator("select.device-group[data-grouping-id=breakers]").first().selectOption("garage");
        await dialog(page).getByText("Save and reload").click();

        await expect.poll(async () =>
            (await calls(page)).filter((call) => call.type === "helman/save_config").length).toBe(1);
        const saved = (await calls(page)).find((call) => call.type === "helman/save_config")!;
        expect(saved.config).toEqual({
            ...grouped,
            devices: { ...grouped.devices, consumers: [{ ...BOILER, groups: { breakers: "garage" } }] },
        });
    });

    test("setting the house phase saves it on the device only", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        // Beside group membership, with no grouping configured at all.
        await openSection(page, "Groups and phase");
        await dialog(page).locator("select.device-phase").first().selectOption("3ph");
        await dialog(page).getByText("Save and reload").click();

        await expect.poll(async () =>
            (await calls(page)).filter((call) => call.type === "helman/save_config").length).toBe(1);
        const saved = (await calls(page)).find((call) => call.type === "helman/save_config")!;
        expect(saved.config).toEqual({
            ...CONFIG,
            devices: { consumers: [{ ...BOILER, phase: "3ph" }] },
        });
    });

    test("Cancel closes the edit dialog and leaves the detail open", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["boiler", "pump"]);
        await dialog(page).getByText("Cancel").click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(editButton(page)).toHaveCount(1);
    });

    test("Cancel and edits are refused while a save is in flight", async ({ page }) => {
        await mountDetail(page, { hangSave: true });
        await openEdit(page);
        await openSection(page, "Identity");
        await nameInput(page).fill("Hot water");
        await nameInput(page).dispatchEvent("change");
        await dialog(page).getByText("Save and reload").click();
        await expect.poll(async () =>
            (await calls(page)).filter((call) => call.type === "helman/save_config").length).toBe(1);

        const cancel = dialog(page).locator("ha-button[slot='secondaryAction']");
        await expect.poll(() => cancel.evaluate((button) => (button as any).disabled)).toBe(true);
        await page.evaluate(() => window.history.back());
        await expect(dialog(page)).toHaveCount(1);
        // The form is frozen too: the save already took its snapshot of the draft.
        await expect(dialog(page).locator("helman-device-editor").first()).toHaveAttribute("inert", "");
    });

    test("Back with a dirty draft asks first, and closes only the edit dialog", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await openSection(page, "Identity");
        await nameInput(page).fill("Hot water");
        await nameInput(page).dispatchEvent("change");
        page.once("dialog", (prompt) => void prompt.dismiss());
        await page.evaluate(() => window.history.back());
        await expect(dialog(page)).toHaveCount(1);

        page.once("dialog", (prompt) => void prompt.accept());
        await page.evaluate(() => window.history.back());
        await expect(dialog(page)).toHaveCount(0);
        await expect(editButton(page)).toHaveCount(1);
    });

    test("an unknown key is named, not drawn as a blank form", async ({ page }) => {
        await mountDetail(page, { deviceKey: "sensor.gone" });
        await openEdit(page);
        await expect(dialog(page).locator(".placeholder.error")).toHaveText(
            "Device \"sensor.gone\" is not in the stored configuration.",
        );
        await expect(dialog(page).locator("helman-device-editor")).toHaveCount(0);
    });

    test("a save refused by validation shows the issue on the device", async ({ page }) => {
        await mountDetail(page, {
            saveResponse: {
                success: false,
                reloadStarted: false,
                validation: {
                    valid: false,
                    errors: [{
                        section: "devices",
                        path: "devices.consumers[0].consumption",
                        code: "x",
                        message: "boiler meter is broken",
                    }],
                    warnings: [],
                },
            },
        });
        await openEdit(page);
        await openSection(page, "Identity");
        await nameInput(page).fill("Hot water");
        await nameInput(page).dispatchEvent("change");
        await dialog(page).getByText("Save and reload").click();

        await expect(dialog(page).locator(".device-issues li.message.error")).toContainText(
            "boiler meter is broken",
        );
        await expect(dialog(page).locator("details.device-card .device-badge[data-badge=issues]"))
            .toHaveCount(1);
        // Still open, draft and all.
        await expect(nameInput(page)).toHaveValue("Hot water");
    });

    test("the entity groups receive inspections, so the name placeholder renders", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await expect(nameInput(page)).toHaveAttribute("placeholder", "Resolved boiler");
        await expect(dialog(page).locator("details.device-card .card-title strong").first())
            .toHaveText("Resolved boiler");
        // The mounted groups ride the same poll as the name and icon.
        const inspected = async () => (await calls(page))
            .filter((call) => call.type === "helman/inspect_entities")
            .flatMap((call) => call.targets?.map((target) => target.key) ?? []);
        await expect.poll(inspected).toEqual(expect.arrayContaining([
            "devices.consumers.0.name",
            "devices.consumers.0.consumption.energy_entity_id",
        ]));
    });
});

test.describe("editing a device on a hardware profile", () => {
    const CHARGER = {
        id: "garage-ev",
        kind: "ev_charger",
        name: "Garage EV",
        profile: { id: "solax_ev_charger", device_id: "garage-charger" },
    };
    const METER = "sensor.solax_ev_charger_charge_added_total";
    const PATH = "devices.consumers[0]";
    const VENDORS = {
        profiles: [
            {
                id: "solax_ev_charger",
                label: "SolaX EV charger",
                deviceKind: "ev_charger",
                binding: "device",
                ownedConfigPaths: [],
                ownedDevicePaths: ["consumption.energy_entity_id", "controls.charge"],
                candidates: [{ deviceId: "garage-charger", name: "Garage charger", entryTitle: "SolaX" }],
            },
        ],
        devices: {
            [PATH]: {
                profile: "solax_ev_charger",
                storedProfile: { id: "solax_ev_charger", device_id: "garage-charger" },
                ownedConfigPaths: [],
                ownedDevicePaths: ["consumption.energy_entity_id", "controls.charge"],
                resolved: {
                    [`${PATH}.consumption.energy_entity_id`]: METER,
                    [`${PATH}.controls.charge.entity_id`]: "switch.helman_ev_charging_garage_ev",
                },
                values: {},
                helmanEntityPaths: [`${PATH}.controls.charge.entity_id`],
            },
        },
    };

    test("a profile charger opens by the meter its profile fills, with that meter read-only", async ({ page }) => {
        await mountDetail(page, {
            deviceKey: METER,
            config: { ...CONFIG, devices: { consumers: [CHARGER] } },
            vendors: VENDORS,
        });
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["garage-ev"]);
        await openSection(page, "Measurements");
        await openSection(page, "Controls");

        const provided = (path: string) =>
            dialog(page).locator(`.vendor-provided[data-path="${PATH}.${path}"] .vendor-provided-entity`);
        await expect(provided("consumption.energy_entity_id")).toHaveText(METER);
        await expect(provided("controls.charge.entity_id")).toHaveText("switch.helman_ev_charging_garage_ev");
        await expect(dialog(page).locator("select.device-kind")).toBeDisabled();
        await expect(dialog(page).locator('details.device-card > summary .device-badge[data-badge="energy"]')).toHaveCount(1);
    });
});

for (const external of [false, true]) {
    test(`a revision during a failed reload save ${external ? "shows a stale banner for another write" : "does not flag its own write"}`, async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await page.evaluate(() => {
            const host = document.querySelector("node-detail-dialog")!.shadowRoot!.querySelector("helman-device-edit-dialog") as any;
            const callWS = host.hass.callWS;
            host.hass = { ...host.hass, callWS: async (request: any) => {
                if (request.type !== "helman/save_config") return callWS(request);
                const config = { ...request.config, config_version: 29 };
                (window as any).__savedRevision = window.__configRevision(config);
                await new Promise<void>((resolve) => { (window as any).__releaseSave = resolve; });
                return { success: false, config, revision: window.__configRevision(config), validation: { valid: true, errors: [], warnings: [] } };
            } };
        });
        await dialog(page).getByText("Save and reload").click();
        await expect.poll(() => page.evaluate(() => !!(window as any).__savedRevision)).toBe(true);
        await page.evaluate((external) => window.__fireDataChanged("config", external ? "newer-revision" : (window as any).__savedRevision), external);
        await page.waitForTimeout(600);
        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
        await page.evaluate(() => (window as any).__releaseSave());
        await expect(dialog(page).locator(".message.error:not(.stale)")).toHaveCount(1);
        await expect(dialog(page).locator(".message.stale")).toHaveCount(external ? 1 : 0);
        expect((await calls(page)).filter((call) => call.type === "helman/get_config")).toHaveLength(1);
    });
}

/** A card's own controls, excluding controls on any nested cards. */
function deviceCard(page: Page, id: string) {
    return dialog(page).locator('details.device-card[data-device-id="' + id + '"]');
}

async function openChildren(page: Page, id = "boiler") {
    const card = deviceCard(page, id);
    await card.locator(":scope > .appliance-body > details.section-card").filter({
        has: page.locator(":scope > summary .section-summary-label", { hasText: "Children" }),
    }).locator(":scope > summary").click();
}

async function saveConfig(page: Page) {
    await dialog(page).getByText("Save and reload", { exact: true }).click();
    await expect.poll(async () => (await calls(page)).filter((call) => call.type === "helman/save_config").length).toBe(1);
    return (await calls(page)).find((call) => call.type === "helman/save_config")!.config;
}

test.describe("sub-devices in the device edit dialog", () => {
    test("children have shared list controls and inspection placeholders; editing saves just the child field", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await openChildren(page);
        await expect.poll(() => cardIds(page)).toEqual(["boiler", "pump"]);
        const root = deviceCard(page, "boiler");
        await expect(root.locator(":scope > summary .list-actions")).toHaveCount(0);
        const child = deviceCard(page, "pump");
        await expect(child.locator(":scope > summary .list-actions .sortable-handle")).toHaveCount(1);
        await expect(child.locator(":scope > summary .mode-toggle button", { hasText: "YAML" })).toHaveCount(1);
        await expect(child.locator(":scope > summary button[title=Remove]")).toHaveCount(1);
        await child.locator(":scope > summary").click();
        await child.locator("summary .section-summary-label", { hasText: "Identity" }).click();
        const input = child.locator(".field-grid .field input").first();
        await expect(input).toHaveAttribute("placeholder", "Resolved pump");
        await input.fill("Circulation pump");
        await input.dispatchEvent("change");
        expect(await saveConfig(page)).toEqual({
            ...CONFIG,
            devices: { consumers: [{ ...BOILER, children: [{ ...BOILER.children[0], name: "Circulation pump" }] }] },
        });
    });

    test("an entity picker appends a child", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await openChildren(page);
        await dialog(page).getByRole("button", { name: "Add child device", exact: true }).click();
        await dialog(page).locator(".add-device-picker ha-entity-picker").evaluate((picker) => {
            picker.dispatchEvent(new CustomEvent("value-changed", {
                detail: { value: "switch.fan" }, bubbles: true, composed: true,
            }));
        });
        expect(await saveConfig(page)).toEqual({
            ...CONFIG,
            devices: { consumers: [{ ...BOILER, children: [...BOILER.children, { id: "fan", controls: { switch: { entity_id: "switch.fan" } } }] }] },
        });
    });

    test("Remove drops a child and preserves the opened parent", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await openChildren(page);
        page.once("dialog", (confirmation) => confirmation.accept());
        await deviceCard(page, "pump").locator(":scope > summary button[title=Remove]").click();
        await expect.poll(() => cardIds(page)).toEqual(["boiler"]);
        const { children, ...withoutChildren } = BOILER;
        expect(await saveConfig(page)).toEqual({ ...CONFIG, devices: { consumers: [withoutChildren] } });
    });

    test("reordering child cards persists their new order", async ({ page }) => {
        const fan = { id: "fan", controls: { switch: { entity_id: "switch.fan" } } };
        const parent = { ...BOILER, children: [...BOILER.children, fan] };
        const config = { ...CONFIG, devices: { consumers: [parent] } };
        await mountDetail(page, { config });
        await openEdit(page);
        await openChildren(page);
        await dialog(page).locator("ha-sortable:has(> .list-stack)").evaluate((sortable) => {
            sortable.dispatchEvent(new CustomEvent("item-moved", {
                detail: { oldIndex: 0, newIndex: 1 }, bubbles: true, composed: true,
            }));
        });
        await expect.poll(() => cardIds(page)).toEqual(["boiler", "fan", "pump"]);
        expect(await saveConfig(page)).toEqual({ ...config, devices: { consumers: [{ ...parent, children: [fan, ...BOILER.children] }] } });
    });

    test("child YAML edits persist and invalid YAML blocks Save", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await openChildren(page);
        await deviceCard(page, "pump").locator(":scope > summary .mode-toggle button", { hasText: "YAML" }).click();
        const yaml = dialog(page).locator("ha-yaml-editor");
        expect(await yaml.evaluate((editor) => (editor as any).defaultValue)).toEqual(BOILER.children[0]);
        await yaml.evaluate((editor) => editor.dispatchEvent(new CustomEvent("value-changed", {
            detail: { isValid: false, errorMsg: "Broken child YAML" }, bubbles: true, composed: true,
        })));
        await expect.poll(() => dialog(page).getByText("Save and reload", { exact: true }).evaluate((button) => (button as any).disabled)).toBe(true);
        // The handler guards programmatic saves too.
        await dialog(page).getByText("Save and reload", { exact: true }).dispatchEvent("click");
        expect((await calls(page)).filter((call) => call.type === "helman/save_config")).toHaveLength(0);
        await yaml.evaluate((editor, value) => editor.dispatchEvent(new CustomEvent("value-changed", {
            detail: { value, isValid: true }, bubbles: true, composed: true,
        })), { ...BOILER.children[0], name: "YAML pump" });
        await expect.poll(() => dialog(page).getByText("Save and reload", { exact: true }).evaluate((button) => (button as any).disabled)).toBe(false);
        expect(await saveConfig(page)).toEqual({
            ...CONFIG,
            devices: { consumers: [{ ...BOILER, children: [{ ...BOILER.children[0], name: "YAML pump" }] }] },
        });
    });
});


test("a grandchild resolves its name and can be edited in place", async ({ page }) => {
    const grandchild = { id: "fan", controls: { switch: { entity_id: "switch.fan" } } };
    const child = { id: "room", consumption: { energy_entity_id: "sensor.room_energy" }, children: [grandchild] };
    const parent = { ...BOILER, children: [child] };
    const config = { ...CONFIG, devices: { consumers: [parent] } };
    await mountDetail(page, { config });
    await openEdit(page);
    await openChildren(page);
    await deviceCard(page, "room").locator(":scope > summary").click();
    await openChildren(page, "room");
    await deviceCard(page, "fan").locator(":scope > summary").click();
    await deviceCard(page, "fan").locator("summary .section-summary-label", { hasText: "Identity" }).click();
    const input = deviceCard(page, "fan").locator(".field-grid .field input").first();
    await expect(input).toHaveAttribute("placeholder", "Resolved pump");
    await input.fill("Desk fan");
    await input.dispatchEvent("change");
    expect(await saveConfig(page)).toEqual({
        ...config,
        devices: { consumers: [{ ...parent, children: [{ ...child, children: [{ ...grandchild, name: "Desk fan" }] }] }] },
    });
});

test("a hardware-profile child binds its candidate through the shared picker", async ({ page }) => {
    const profile = {
        id: "solax_ev_charger", label: "SolaX EV charger", deviceKind: "ev_charger", binding: "device",
        ownedConfigPaths: [], ownedDevicePaths: [],
        candidates: [{ deviceId: "garage-charger", name: "Garage charger", entryTitle: "SolaX" }],
    };
    await mountDetail(page, { vendors: { profiles: [profile], devices: {} } });
    await openEdit(page);
    await openChildren(page);
    await dialog(page).getByRole("button", { name: "Add child device", exact: true }).click();
    await dialog(page).locator('select[data-field="add-device-profile"]').selectOption(profile.id);
    await dialog(page).locator('select[data-field="add-device-vendor-device"]').selectOption("garage-charger");
    const saved = await saveConfig(page);
    expect(saved).toEqual({
        ...CONFIG,
        devices: { consumers: [{ ...BOILER, children: [...BOILER.children, {
            id: "garage_charger", name: "Garage charger", kind: "ev_charger",
            profile: { id: profile.id, device_id: "garage-charger" },
        }] }] },
    });
});
