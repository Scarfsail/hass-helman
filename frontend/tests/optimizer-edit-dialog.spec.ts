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
    controllableId: "inverter",
    date: DATE,
    slotIds: SLOT_IDS,
    runAt: RUN_AT,
    optimizers: [
        {
            optimizerId: "export_price",
            kind: "export_price",
            controllableId: "inverter",
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
    "scheduling.explanation.diagram.edit.close": "Close",
    "scheduling.explanation.diagram.edit.cancel": "Cancel",
    "scheduling.explanation.diagram.edit.discard": "Discard unsaved changes?",
};

interface MountOptions {
    isAdmin?: boolean;
    config?: unknown;
    /**
     * Successive `helman/get_config` answers, for the collision tests.
     *
     * The dialog reads once on open and once more before saving; handing those
     * two reads different documents is how "someone else wrote it in between"
     * is expressed here. The last entry repeats.
     */
    configSequence?: unknown[];
    saveResponse?: unknown;
    payload?: unknown;
    applianceName?: string | null;
    schema?: unknown;
}

async function mountPanel(page: Page, options: MountOptions = {}): Promise<void> {
    const {
        isAdmin = true,
        config = CONFIG,
        configSequence = [config],
        saveResponse = { success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true },
        payload = PAYLOAD,
        applianceName = null,
        schema = SCHEMA,
    } = options;

    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-panel"));

    await page.evaluate(
        ({ fixture, slotId, admin, schema, configs, save, strings, appliance }) => {
            const calls: { type: string; config?: unknown }[] = [];
            const globals = window as unknown as Record<string, unknown>;
            globals.__calls = calls;

            // The dialog closes on a successful save and hands the "restart
            // started" line to Home Assistant's own toast on the way out.
            const notifications: string[] = [];
            globals.__notifications = notifications;
            document.addEventListener("hass-notification", (event) => {
                notifications.push((event as CustomEvent).detail?.message ?? "");
            });

            // The shared data-changed feed subscribes through `connection`;
            // holding the listener lets a test play the backend's announcement.
            const listeners: ((event: unknown) => void)[] = [];
            globals.__fireDataChanged = (kind: string) => {
                for (const listener of listeners) {
                    listener({ kind });
                }
            };

            let reads = 0;

            const panel = document.createElement("scheduling-explanation-panel") as HTMLElement
                & Record<string, unknown>;
            panel.localize = (key: string) => strings[key] ?? key;
            panel.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: admin },
                connection: {
                    subscribeMessage: async (
                        callback: (message: unknown) => void,
                        _request: { type: string },
                    ) => {
                        listeners.push(callback);
                        return () => {
                            listeners.splice(listeners.indexOf(callback), 1);
                        };
                    },
                },
                callWS: async (request: { type: string; config?: unknown }) => {
                    calls.push({ type: request.type, config: request.config });
                    if (request.type === "helman/get_config") {
                        const answer = configs[Math.min(reads, configs.length - 1)];
                        reads += 1;
                        return answer;
                    }
                    if (request.type === "helman/get_optimizer_schema") return schema;
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/save_config") return save;
                    return {};
                },
            };
            panel.applianceName = appliance;
            panel.payload = fixture;
            panel.slotId = slotId;
            panel.locale = "cs";
            panel.timeZone = "Europe/Prague";
            document.body.appendChild(panel);
        },
        {
            fixture: payload,
            slotId: SLOT_IDS[0],
            admin: isAdmin,
            schema,
            configs: configSequence,
            save: saveResponse,
            strings: STRINGS,
            appliance: applianceName,
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

/** Play the backend's `helman_data_changed` announcement. */
async function fireDataChanged(page: Page, kind = "config"): Promise<void> {
    await page.evaluate((k) => {
        (window as unknown as Record<string, (kind: string) => void>).__fireDataChanged(k);
    }, kind);
    // The shared feed collapses a burst before telling listeners.
    await page.waitForTimeout(600);
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

    test("the diagram head names the optimizer whose logic it is drawing", async ({ page }) => {
        await mountPanel(page);
        // The tab strip labels by kind and disappears when a slot has one
        // optimizer, so without this the head names no optimizer at all.
        await expect(page.locator("scheduling-explanation-panel .optimizer"))
            .toHaveText("export_price");
    });

    test("an appliance-driving optimizer is named the way its card is", async ({ page }) => {
        // The config editor titles these by the appliance, not the id — an id
        // like `surplus-appliance-4` names nothing a reader recognises, and
        // showing it here would leave them matching it against "Bathroom
        // radiator" by hand.
        await mountPanel(page, {
            payload: {
                ...PAYLOAD,
                controllableId: "heater-shower",
                optimizers: [{
                    ...PAYLOAD.optimizers[0],
                    optimizerId: "surplus-appliance-4",
                    kind: "appliance_runtime",
                    controllableId: "heater-shower",
                }],
            },
            applianceName: "Bathroom radiator",
        });

        await expect(page.locator("scheduling-explanation-panel .optimizer"))
            .toHaveText("Bathroom radiator");
    });

    test("an optimizer that drives no appliance keeps its id", async ({ page }) => {
        // The inverter lane's optimizers are titled by id in the config editor
        // too, so a lane name must not leak onto them.
        await mountPanel(page, { applianceName: "Bathroom radiator" });

        await expect(page.locator("scheduling-explanation-panel .optimizer"))
            .toHaveText("export_price");
    });

    test("pressing it opens the config editor's card for that optimizer", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        // The same element the config panel's optimizer list is made of, and
        // the id field it renders is this optimizer's — not the first in the
        // pipeline, which is the bug an index-based lookup would have.
        await expect(dialog(page).locator("helman-optimizer-editor")).toHaveCount(1);
        // Open already: the reader chose this optimizer to get here, so making
        // them click the card open would be asking the same question twice.
        const card = dialog(page).locator(".optimizer-card");
        await expect(card).toHaveAttribute("open", "");
        await expect(card.locator(".appliance-body > .field-grid input").first())
            .toHaveValue("export_price");
    });

    test("the card offers no way to disturb the pipeline it came from", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        // Move and remove are *pipeline* operations — they change which
        // optimizers exist and in what order they run, which is the document's
        // business and not something to do from a dialog opened on one slot.
        // The on/off switch is the exception, and it is about this optimizer
        // alone.
        const actions = dialog(page).locator(".optimizer-card > summary .list-actions");
        await expect(actions.locator("button")).toHaveCount(0);
        await expect(actions.locator(".summary-toggle ha-switch")).toHaveCount(1);
    });

    test("the target picker offers only controllables the kind can drive", async ({
        page,
    }) => {
        // The rule lives in one place — `CONTROLLABLE_SPECS.optimizer_kinds`,
        // served to the editor as `controllableKinds` — so the picker cannot
        // offer a target config validation would then reject. A `charge_hold`
        // drives the inverter and nothing else, so the boiler sitting right
        // beside it in the same `controllables` list must not be on offer.
        await mountPanel(page, {
            payload: {
                ...PAYLOAD,
                optimizers: [{
                    ...PAYLOAD.optimizers[0],
                    optimizerId: "charge_hold",
                    kind: "charge_hold",
                }],
            },
            schema: {
                version: 2,
                kinds: [{
                    kind: "charge_hold",
                    target: [{
                        key: "controllable_id",
                        type: "string",
                        default: "inverter",
                    }],
                    params: [],
                    conditionTypes: [],
                    controllableKinds: ["inverter"],
                    newDraft: { conditions: [{}] },
                }],
            },
            config: {
                ...CONFIG,
                controllables: [
                    { kind: "inverter", id: "inverter", name: "Inverter" },
                    { kind: "generic", id: "boiler", name: "Boiler" },
                ],
            },
        });
        await openDialog(page);

        const picker = dialog(page).locator("helman-optimizer-editor select").first();
        await expect(picker.locator("option")).toHaveText([
            /Select controllable/,
            /Inverter \(inverter\)/,
        ]);
        // And the id the schema defaults to is the one shown as chosen, so a
        // config written before the field existed does not read as unset.
        await expect(picker).toHaveValue("inverter");
    });

    /** The dependency-picker fixture: one heat pump depending on one provider. */
    const mountDependencyPanel = async (
        page: import("@playwright/test").Page,
        {
            controllables,
            requires,
        }: { controllables: unknown[]; requires: string },
    ) =>
        mountPanel(page, {
            payload: {
                ...PAYLOAD,
                optimizers: [{
                    ...PAYLOAD.optimizers[0],
                    optimizerId: "heat",
                    kind: "appliance_runtime",
                    controllableId: "heatpump",
                }],
            },
            schema: {
                version: 2,
                applianceKinds: ["climate", "ev_charger", "generic"],
                kinds: [{
                    kind: "appliance_runtime",
                    target: [{ key: "controllable_id", type: "string" }],
                    params: [],
                    conditionTypes: [{
                        key: "requires_appliance",
                        scope: "slot",
                        field: {
                            key: "requires_appliance",
                            type: "string",
                            required: false,
                        },
                    }],
                    controllableKinds: ["climate", "generic"],
                    newDraft: { conditions: [{}] },
                }],
            },
            config: {
                ...CONFIG,
                controllables,
                automation: {
                    enabled: true,
                    optimizers: [{
                        id: "heat",
                        kind: "appliance_runtime",
                        enabled: true,
                        target: { controllable_id: "heatpump" },
                        conditions: [{ requires_appliance: requires }],
                    }],
                },
            },
        });

    /** The second select on the card; the first is the target picker. */
    const dependencyPicker = (page: import("@playwright/test").Page) =>
        dialog(page).locator("helman-optimizer-editor select").nth(1);

    test("a climate provider whose modes have not loaded is offered plainly", async ({
        page,
    }) => {
        // `selectionDisabled` means "cannot be a *target* until the live modes
        // load" — it says nothing about being a provider. Labelling this one
        // "save and reload to enable" would tell the user to do something it
        // does not need, next to an option that selects fine.
        await mountDependencyPanel(page, {
            requires: "filtration",
            controllables: [
                { kind: "generic", id: "heatpump", name: "Heat pump" },
                { kind: "climate", id: "filtration", name: "Filtration" },
            ],
        });
        await openDialog(page);

        await expect(dependencyPicker(page).locator("option")).toHaveText([
            "",
            "Filtration (filtration)",
        ]);
        await expect(dependencyPicker(page)).toHaveValue("filtration");
    });

    test("a stored self-reference is shown, not silently blanked", async ({ page }) => {
        // The own target is filtered out of the options, so a config that names
        // it has a value no option matches. Rendering blank would show nothing
        // to clear while the draft still carried the self-reference that
        // validation is about to reject.
        await mountDependencyPanel(page, {
            requires: "heatpump",
            controllables: [
                { kind: "generic", id: "heatpump", name: "Heat pump" },
                { kind: "generic", id: "filtration", name: "Filtration" },
            ],
        });
        await openDialog(page);

        // The blank option comes first — `renderOptionalSelectField` renders it
        // ahead of the list — so there is always a visible way to clear it.
        await expect(dependencyPicker(page).locator("option")).toHaveText([
            "",
            "heatpump (this optimizer's own appliance — pick another)",
            "Filtration (filtration)",
        ]);
        await expect(dependencyPicker(page)).toHaveValue("heatpump");
    });

    test("the requires_appliance picker offers the other appliances, not itself", async ({
        page,
    }) => {
        // The dependency is on the plan, so the provider may be any appliance
        // in the draft — filtered by `applianceKinds`, which the backend serves
        // from the same declaration its validation reads. The inverter is not
        // an appliance and the optimizer's own target cannot depend on itself,
        // so neither is on offer.
        await mountPanel(page, {
            payload: {
                ...PAYLOAD,
                optimizers: [{
                    ...PAYLOAD.optimizers[0],
                    optimizerId: "heat",
                    kind: "appliance_runtime",
                    controllableId: "heatpump",
                }],
            },
            schema: {
                version: 2,
                applianceKinds: ["climate", "ev_charger", "generic"],
                kinds: [{
                    kind: "appliance_runtime",
                    target: [{ key: "controllable_id", type: "string" }],
                    params: [],
                    conditionTypes: [{
                        key: "requires_appliance",
                        scope: "slot",
                        field: {
                            key: "requires_appliance",
                            type: "string",
                            required: false,
                        },
                    }],
                    controllableKinds: ["climate", "generic"],
                    newDraft: { conditions: [{}] },
                }],
            },
            config: {
                ...CONFIG,
                controllables: [
                    { kind: "inverter", id: "inverter", name: "Inverter" },
                    { kind: "generic", id: "heatpump", name: "Heat pump" },
                    { kind: "generic", id: "filtration", name: "Filtration" },
                ],
                automation: {
                    enabled: true,
                    optimizers: [{
                        id: "heat",
                        kind: "appliance_runtime",
                        enabled: true,
                        target: { controllable_id: "heatpump" },
                        conditions: [{ requires_appliance: "filtration" }],
                    }],
                },
            },
        });
        await openDialog(page);

        // The second select on the card: the first is the target picker.
        const picker = dialog(page).locator("helman-optimizer-editor select").nth(1);
        await expect(picker.locator("option")).toHaveText([
            "",
            /Filtration \(filtration\)/,
        ]);
        await expect(picker).toHaveValue("filtration");
    });

    test("save sends the whole document, changed only in that optimizer", async ({ page }) => {
        await mountPanel(page);
        await openDialog(page);

        const card = dialog(page).locator(".optimizer-card");
        const threshold = card.locator(".condition-group input[type=number]").first();
        await threshold.fill("2.5");
        await threshold.blur();

        await dialog(page).getByText("Save and reload").click();

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
        await dialog(page).getByText("Save and reload").click();

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

/**
 * `helman/save_config` replaces the whole document, so a dialog that edits one
 * optimizer can silently revert whatever else was written while it was open.
 * The window is small; the loss is total and silent, which is what makes it
 * worth a guard rather than a note.
 */
test.describe("the dialog refuses to overwrite a config that moved under it", () => {
    /** The same document, plus an edit nobody in this dialog made. */
    const CHANGED_ELSEWHERE = {
        ...CONFIG,
        power_devices: { house: { base_load_w: 900 } },
    };

    /** What the stored document looks like once this dialog's own save landed. */
    const SAVED_CONFIG = { ...CONFIG, config_version: 5 };

    test("a config that changed between open and save blocks the save", async ({ page }) => {
        await mountPanel(page, { configSequence: [CONFIG, CHANGED_ELSEWHERE] });
        await openDialog(page);

        await dialog(page).getByText("Save and reload").click();

        await expect(dialog(page).locator(".message.stale")).toHaveCount(1);
        // Not "saved and then complained" — never sent at all.
        expect((await calls(page)).filter((call) => call.type === "helman/save_config"))
            .toHaveLength(0);
    });

    test("an unchanged config lets the save through, so the guard is not always-on", async ({ page }) => {
        await mountPanel(page, { configSequence: [CONFIG, CONFIG] });
        await openDialog(page);

        await dialog(page).getByText("Save and reload").click();

        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
        expect((await calls(page)).filter((call) => call.type === "helman/save_config"))
            .toHaveLength(1);
    });

    test("key order alone is not a change", async ({ page }) => {
        // Two reads of one stored document need not agree on insertion order;
        // a comparison that called that a collision would block every save.
        const REORDERED = {
            automation: CONFIG.automation,
            appliances: CONFIG.appliances,
            power_devices: CONFIG.power_devices,
            config_version: CONFIG.config_version,
        };
        await mountPanel(page, { configSequence: [CONFIG, REORDERED] });
        await openDialog(page);

        await dialog(page).getByText("Save and reload").click();

        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
        expect((await calls(page)).filter((call) => call.type === "helman/save_config"))
            .toHaveLength(1);
    });

    test("the notice arrives while the dialog is open, not only at save", async ({ page }) => {
        await mountPanel(page, { configSequence: [CONFIG, CHANGED_ELSEWHERE] });
        await openDialog(page);
        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);

        await fireDataChanged(page);

        // Learned before typing another twenty seconds of edits.
        await expect(dialog(page).locator(".message.stale")).toHaveCount(1);
    });

    test("an announcement that moved nothing raises no notice", async ({ page }) => {
        // `helman_data_changed` is fired for a re-plan and a retrained bias
        // profile too, neither of which touches the document this dialog is
        // editing. The event says something moved, never what.
        await mountPanel(page);
        await openDialog(page);

        await fireDataChanged(page, "plan");
        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
    });

    test("a save that lands closes the dialog, and says so on the way out", async ({ page }) => {
        // The reads in order: the open, the pre-save guard, the re-baseline.
        await mountPanel(page, { configSequence: [CONFIG, CONFIG, SAVED_CONFIG] });
        await openDialog(page);
        await dialog(page).getByText("Save and reload").click();

        // Saving is finishing. Leaving the dialog open on a green message made
        // Cancel the only way out of a save that had already succeeded.
        await expect(dialog(page)).toHaveCount(0);
        // The restart it started is worth knowing about, and the dialog is no
        // longer there to say it.
        await expect
            .poll(() => page.evaluate(
                () => (window as unknown as Record<string, string[]>).__notifications,
            ))
            .toHaveLength(1);
    });

    test("a save whose reload failed is not then accused of its own write", async ({ page }) => {
        // `save_config` stores the document *before* it attempts the reload, so
        // a failed reload still leaves the stored document ours. The dialog
        // stays open on the error -- and the announcements the half-done reload
        // fires must not turn into "somebody else wrote this".
        await mountPanel(page, {
            configSequence: [CONFIG, CONFIG, SAVED_CONFIG],
            saveResponse: {
                success: false,
                validation: { valid: true, errors: [], warnings: [] },
                reloadStarted: true,
                reloadSucceeded: false,
                reloadError: "Reload failed",
            },
        });
        await openDialog(page);
        await dialog(page).getByText("Save and reload").click();
        await expect(dialog(page).locator(".message.error")).toHaveCount(1);

        // One save fires several announcements -- the entry reload re-plans,
        // and those land well past the feed's collapse window closing on the
        // first. A dialog that took "the first is mine, the rest are somebody
        // else's" accused itself.
        await fireDataChanged(page, "config");
        await fireDataChanged(page, "plan");
        await fireDataChanged(page, "schedule");
        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
    });

    test("a retry is not blocked by the first attempt's own write", async ({ page }) => {
        // A save that succeeds closes the dialog, so the only way to save twice
        // from one dialog is a first attempt whose *reload* failed -- and that
        // attempt still wrote the document. Without adopting what it wrote as
        // the new baseline, the retry compares against the pre-save read, finds
        // our own write, and refuses: the user is locked out of fixing it.
        const SAVED = {
            ...CONFIG,
            automation: {
                ...CONFIG.automation,
                optimizers: [
                    CONFIG.automation.optimizers[0],
                    { ...CONFIG.automation.optimizers[1], conditions: [{ when_price_below: 2.5 }] },
                ],
            },
        };
        await mountPanel(page, {
            configSequence: [CONFIG, CONFIG, SAVED],
            saveResponse: {
                success: false,
                validation: { valid: true, errors: [], warnings: [] },
                reloadStarted: true,
                reloadSucceeded: false,
                reloadError: "Reload failed",
            },
        });
        await openDialog(page);

        await dialog(page).getByText("Save and reload").click();
        await expect(dialog(page).locator(".message.error")).toHaveCount(1);

        await dialog(page).getByText("Save and reload").click();

        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
        expect((await calls(page)).filter((call) => call.type === "helman/save_config"))
            .toHaveLength(2);
    });

    test("reloading after a collision reads the config that won", async ({ page }) => {
        await mountPanel(page, { configSequence: [CONFIG, CHANGED_ELSEWHERE] });
        await openDialog(page);
        await dialog(page).getByText("Save and reload").click();
        await expect(dialog(page).locator(".message.stale")).toHaveCount(1);

        await dialog(page).getByText("Reload stored config").click();

        await expect(dialog(page).locator(".message.stale")).toHaveCount(0);
        await expect(dialog(page).locator("helman-optimizer-editor")).toHaveCount(1);
    });
});
