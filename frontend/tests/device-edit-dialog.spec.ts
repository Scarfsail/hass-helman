import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";

/**
 * Editing a device from its detail dialog.
 *
 * The Edit button on the device detail opens `helman-device-edit-dialog`, which
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

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const BOILER = {
    id: "boiler",
    consumption: {
        energy_entity_id: "sensor.boiler_energy",
        power_entity_id: "sensor.boiler_power",
    },
    children: [{ id: "pump", controls: { switch: { entity_id: "switch.pump" } } }],
};

const CONFIG = {
    config_version: 25,
    devices: { consumers: [BOILER] },
    automation: { enabled: true, appliance_optimizers: [], system_optimizers: [] },
};

const STRINGS: Record<string, string> = {
    "node_detail.device.edit.button": "Edit",
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
    saveResponse?: unknown;
    /** Leave the save request unanswered, so the save stays in flight. */
    hangSave?: boolean;
}

async function mountDetail(page: Page, options: MountOptions = {}): Promise<void> {
    const {
        deviceKey = "sensor.boiler_energy",
        saveResponse = { success: true, validation: VALID, reloadStarted: true },
        hangSave = false,
    } = options;
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("node-detail-device-content"));
    await page.addScriptTag({ content: HA_DIALOG_STUB });

    await page.evaluate(
        ({ config, key, save, hang, strings }) => {
            const calls: { type: string; config?: unknown; targets?: { key: string }[] }[] = [];
            (window as any).__calls = calls;
            const content = document.createElement("node-detail-device-content") as any;
            content.localize = (k: string) => strings[k] ?? k;
            content.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                states: {},
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    calls.push({ type: request.type, config: request.config, targets: request.targets });
                    if (request.type === "helman/get_config") return JSON.parse(JSON.stringify(config));
                    if (request.type === "helman/save_config") return hang ? new Promise(() => undefined) : save;
                    if (request.type === "helman/inspect_entities") {
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft: {
                                    entityId: null,
                                    status: "ok",
                                    facts: [],
                                    placeholder: target.key.endsWith(".name") ? "Resolved boiler" : undefined,
                                },
                                saved: null,
                            })),
                        };
                    }
                    return {};
                },
            };
            content.params = {
                nodeType: "device",
                item: { id: key, name: "Boiler", displayName: "Boiler", deviceKey: key,
                    energyEntityId: key.startsWith("sensor.") ? key : undefined, children: [] },
            };
            document.body.appendChild(content);
        },
        { config: CONFIG, key: deviceKey, save: saveResponse, hang: hangSave, strings: STRINGS },
    );
}

function editButton(page: Page) {
    return page.locator("node-detail-device-content ha-button.edit");
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

function nameInput(page: Page) {
    return dialog(page).locator("details.device-card .field-grid .field input").first();
}

async function calls(page: Page): Promise<{ type: string; config?: any; targets?: { key: string }[] }[]> {
    return page.evaluate(() => (window as any).__calls);
}

test.describe("editing a device from its detail", () => {
    test("Edit opens the form of the device named by its meter", async ({ page }) => {
        await mountDetail(page, { deviceKey: "sensor.boiler_energy" });
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["boiler"]);
        // Open, and alone: no children list, no drag, no remove.
        await expect(dialog(page).locator("details.device-card")).toHaveAttribute("open", "");
        await expect(dialog(page).locator(".list-actions")).toHaveCount(0);
    });

    test("Edit opens the form of a meterless device named by its id", async ({ page }) => {
        await mountDetail(page, { deviceKey: "pump" });
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["pump"]);
    });

    test("saving sends the whole document with only the edited field changed", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
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
        // A successful save closes the edit dialog and returns to the detail.
        await expect(dialog(page)).toHaveCount(0);
        await expect(editButton(page)).toHaveCount(1);
    });

    test("Cancel closes the edit dialog and leaves the detail open", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await expect.poll(() => cardIds(page)).toEqual(["boiler"]);
        await dialog(page).getByText("Cancel").click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(editButton(page)).toHaveCount(1);
    });

    test("Cancel cannot discard a save already in flight", async ({ page }) => {
        await mountDetail(page, { hangSave: true });
        await openEdit(page);
        await nameInput(page).fill("Hot water");
        await nameInput(page).dispatchEvent("change");
        await dialog(page).getByText("Save and reload").click();
        await expect.poll(async () =>
            (await calls(page)).filter((call) => call.type === "helman/save_config").length).toBe(1);

        const cancel = dialog(page).locator("ha-button[slot='secondaryAction']");
        await expect.poll(() => cancel.evaluate((button) => (button as any).disabled)).toBe(true);
        await page.evaluate(() => (document.querySelector("node-detail-device-content") as any).handleBack());
        await expect(dialog(page)).toHaveCount(1);
    });

    test("Back with a dirty draft asks first, and closes only the edit dialog", async ({ page }) => {
        await mountDetail(page);
        await openEdit(page);
        await nameInput(page).fill("Hot water");
        await nameInput(page).dispatchEvent("change");
        const content = page.locator("node-detail-device-content");

        page.once("dialog", (prompt) => void prompt.dismiss());
        expect(await content.evaluate((el) => (el as any).handleBack())).toBe(true);
        await expect(dialog(page)).toHaveCount(1);

        page.once("dialog", (prompt) => void prompt.accept());
        expect(await content.evaluate((el) => (el as any).handleBack())).toBe(true);
        await expect(dialog(page)).toHaveCount(0);
        await expect(editButton(page)).toHaveCount(1);
        expect(await content.evaluate((el) => (el as any).handleBack())).toBe(false);
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
        await expect(dialog(page).locator("details.device-card .card-title strong"))
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
