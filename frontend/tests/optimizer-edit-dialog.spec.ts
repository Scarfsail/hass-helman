import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Editing the deciding optimizer from the slot it decided.
 *
 * The point of the feature is that the reader never leaves the explanation to
 * change the rule it explains, and that what they get when they do is the
 * *config editor's* card rather than a second one that looks similar. So these
 * tests pin three things:
 *
 * - **Who is offered it.** `helman/save_config` is admin-gated on the backend,
 *   so a non-admin must not see a button whose save can only fail.
 * - **What the save sends.** `save_config` replaces the whole document; the
 *   dialog therefore has to send the whole document, differing from the loaded
 *   one in that optimizer's subtree and nowhere else.
 * - **What happens when the answer is no.** A rejected validation keeps the
 *   dialog open and says so, and an optimizer the config no longer has is
 *   named rather than rendered as a blank card.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DATE = "2026-07-31";
const RUN_AT = `${DATE}T20:15:00+02:00`;
const SLOT_IDS = [`${DATE}T13:00:00+02:00`, `${DATE}T13:30:00+02:00`];

/** One optimizer, one slot it rejected on price — enough to draw a diagram. */
const PAYLOAD = {
    targetKey: "inverter",
    date: DATE,
    slotIds: SLOT_IDS,
    runAt: RUN_AT,
    optimizers: [
        {
            optimizerId: "export_price",
            kind: "export_price",
            targetKey: "inverter",
            status: "ok",
            runAt: [[RUN_AT, 2]],
            verdict: [["execute", 1], ["skip", 1]],
            winningOptimizer: { "0": "export_price" },
            groups: [{
                index: 0,
                label: "",
                paramsSource: [["slot_matched", 2]],
                conditions: [{
                    key: "when_price_below",
                    scope: "slot",
                    state: [["true", 1], ["false", 1]],
                    value: [[1.0, 2]],
                    actual: { "0": 0.8, "1": 1.2 },
                }],
            }],
        },
    ],
};

const SCHEMA = {
    version: 2,
    kinds: [{
        kind: "export_price",
        target: [],
        params: [],
        conditionTypes: [{
            key: "when_price_below",
            scope: "slot",
            field: { key: "when_price_below", type: "number", default: 0 },
        }],
        newDraft: { conditions: [{ when_price_below: 0 }] },
    }],
};

/** A document with more in it than the optimizer, so a clobber would show. */
const CONFIG = {
    config_version: 4,
    power_devices: { house: { base_load_w: 350 } },
    appliances: [],
    automation: {
        enabled: true,
        optimizers: [
            {
                id: "charge_hold",
                kind: "charge_hold",
                enabled: true,
                conditions: [{ min_soc_pct: 40 }],
            },
            {
                id: "export_price",
                kind: "export_price",
                enabled: true,
                conditions: [{ when_price_below: 1.0 }],
            },
        ],
    },
};

/**
 * The dialog's own strings, in English.
 *
 * A localize that answers with the key would make every `getByText` here a test
 * of the key rather than of the label, and would hide the one string that has
 * to interpolate: `not_found` names the optimizer the config no longer has.
 */
const STRINGS: Record<string, string> = {
    "scheduling.explanation.diagram.edit_automation": "Edit automation",
    "scheduling.explanation.diagram.edit.title": "Edit automation",
    "scheduling.explanation.diagram.edit.loading": "Loading config…",
    "scheduling.explanation.diagram.edit.load_failed": "Could not load the config",
    "scheduling.explanation.diagram.edit.not_found":
        "Optimizer \u201c{id}\u201d is not in the stored config.",
    "scheduling.explanation.diagram.edit.save": "Save and restart",
    "scheduling.explanation.diagram.edit.saving": "Saving…",
    "scheduling.explanation.diagram.edit.close": "Close",
    "scheduling.explanation.diagram.edit.cancel": "Cancel",
    "scheduling.explanation.diagram.edit.discard": "Discard unsaved changes?",
};

interface MountOptions {
    isAdmin?: boolean;
    config?: unknown;
    saveResponse?: unknown;
}

async function mountPanel(page: Page, options: MountOptions = {}): Promise<void> {
    const {
        isAdmin = true,
        config = CONFIG,
        saveResponse = { success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true },
    } = options;

    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-panel"));

    await page.evaluate(
        ({ fixture, slotId, admin, schema, initialConfig, save, strings }) => {
            const calls: { type: string; config?: unknown }[] = [];
            (window as unknown as Record<string, unknown>).__calls = calls;

            const panel = document.createElement("scheduling-explanation-panel") as HTMLElement
                & Record<string, unknown>;
            panel.localize = (key: string) => strings[key] ?? key;
            panel.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: admin },
                callWS: async (request: { type: string; config?: unknown }) => {
                    calls.push({ type: request.type, config: request.config });
                    if (request.type === "helman/get_config") return initialConfig;
                    if (request.type === "helman/get_optimizer_schema") return schema;
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/save_config") return save;
                    return {};
                },
            };
            panel.payload = fixture;
            panel.slotId = slotId;
            panel.locale = "cs";
            panel.timeZone = "Europe/Prague";
            document.body.appendChild(panel);
        },
        {
            fixture: PAYLOAD,
            slotId: SLOT_IDS[0],
            admin: isAdmin,
            schema: SCHEMA,
            initialConfig: config,
            save: saveResponse,
            strings: STRINGS,
        },
    );

    await expect(page.locator("scheduling-explanation-panel .explanation-panel")).toHaveCount(1);
}

function editButton(page: Page) {
    return page.locator("scheduling-explanation-panel .edit-automation");
}

function dialog(page: Page) {
    return page.locator("helman-optimizer-edit-dialog");
}

async function openDialog(page: Page): Promise<void> {
    await editButton(page).click();
    await expect(dialog(page)).toHaveCount(1);
}

/** Every websocket request the panel and the dialog made, in order. */
async function calls(page: Page): Promise<{ type: string; config?: unknown }[]> {
    return page.evaluate(() => (window as unknown as Record<string, unknown>).__calls as never);
}

test.describe("editing the deciding optimizer from the slot diagram", () => {
    test("an admin is offered the edit button in the diagram head", async ({ page }) => {
        await mountPanel(page);
        await expect(editButton(page)).toHaveCount(1);
    });

    test("a non-admin is not — the save it leads to is admin-gated", async ({ page }) => {
        await mountPanel(page, { isAdmin: false });
        await expect(editButton(page)).toHaveCount(0);
    });

    test("pressing it opens the config editor's card for that optimizer", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        // The same element the config panel's optimizer list is made of, and
        // the id field it renders is this optimizer's — not the first in the
        // pipeline, which is the bug an index-based lookup would have.
        await expect(dialog(page).locator("helman-optimizer-editor")).toHaveCount(1);
        const card = dialog(page).locator(".optimizer-card");
        await card.locator("summary").first().click();
        await expect(card.locator(".appliance-body > .field-grid input").first())
            .toHaveValue("export_price");
    });

    test("the card offers no way to disturb the pipeline it came from", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        // Move/remove/enable belong to the document, and the dialog is not
        // editing the document — it passes no list actions.
        await expect(dialog(page).locator(".optimizer-card > summary .list-actions"))
            .toHaveCount(0);
    });

    test("save sends the whole document, changed only in that optimizer", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        const card = dialog(page).locator(".optimizer-card");
        await card.locator("summary").first().click();
        const threshold = card.locator(".condition-group input[type=number]").first();
        await threshold.fill("2.5");
        await threshold.blur();

        await dialog(page).getByText("Save and restart").click();

        const saved = (await calls(page)).filter((call) => call.type === "helman/save_config");
        expect(saved).toHaveLength(1);
        const sent = saved[0].config as typeof CONFIG;
        // Everything outside the edited optimizer survives verbatim — a
        // whole-document save that dropped a sibling would be the worst
        // possible bug here, and it would be silent.
        expect(sent.power_devices).toEqual(CONFIG.power_devices);
        expect(sent.automation.optimizers[0]).toEqual(CONFIG.automation.optimizers[0]);
        expect(sent.automation.optimizers[1].conditions).toEqual([{ when_price_below: 2.5 }]);
    });

    test("a rejected save says so and keeps the dialog open", async ({ page }) => {
        await mountPanel(page, {
            saveResponse: {
                success: false,
                validation: { valid: false, errors: [{ section: "automation", path: "", code: "bad", message: "no" }], warnings: [] },
                reloadStarted: false,
            },
        });
        await openDialog(page);
        await dialog(page).getByText("Save and restart").click();

        await expect(dialog(page).locator(".message.error")).toHaveCount(1);
        await expect(dialog(page).locator("helman-optimizer-editor")).toHaveCount(1);
    });

    test("an optimizer the config no longer has is named, not blanked", async ({ page }) => {
        await mountPanel(page, {
            config: { ...CONFIG, automation: { enabled: true, optimizers: [CONFIG.automation.optimizers[0]] } },
        });
        await openDialog(page);

        await expect(dialog(page).locator(".placeholder.error")).toContainText("export_price");
        await expect(dialog(page).locator("helman-optimizer-editor")).toHaveCount(0);
    });

    test("closing the edit dialog leaves the explanation behind it alone", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        await dialog(page).getByText("Cancel").click();
        await expect(dialog(page)).toHaveCount(0);
        // The regression the condition-trace dialog already had to fix: `closed`
        // is the event name every ha-dialog uses, so an unstopped one shuts the
        // day editor hosting this too.
        await expect(page.locator("scheduling-explanation-panel .explanation-panel")).toHaveCount(1);
    });

    test("nothing is asked of the backend until the button is pressed", async ({ page }) => {
        await mountPanel(page);
        expect(await calls(page)).toEqual([]);
    });
});
