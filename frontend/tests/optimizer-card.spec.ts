import { test, expect, type Page, type Locator } from "@playwright/test";
import { EDITOR_BUNDLE, loadBundle } from "./support/card-page";

/**
 * The schema-driven optimizer card, end to end in a bare page.
 *
 * The point of the unification is that editing *any* optimizer feels the same,
 * and that this is true by construction rather than by discipline: one renderer
 * builds every card from the schema the backend serves. These tests pin the
 * properties that would otherwise quietly rot — that a kind's fields come from
 * its schema, that the group list enforces "at least one group", and that a
 * group's override sub-form is the same form as the master block with the
 * inherited values as placeholders.
 */

/** The schema the backend serves, trimmed to the kinds these tests exercise. */
const SCHEMA = {
    version: 2,
    kinds: [
        {
            kind: "export_price",
            target: [],
            params: [],
            bucket: "system",
            conditionTypes: [
                {
                    key: "when_price_below",
                    scope: "slot",
                    field: { key: "when_price_below", type: "number", default: 0 },
                },
            ],
            newDraft: { conditions: [{ when_price_below: 0 }] },
        },
        {
            kind: "charge_hold",
            target: [],
            bucket: "system",
            params: [
                {
                    key: "window",
                    type: "object",
                    fields: [
                        { key: "start", type: "time" },
                        { key: "end", type: "time" },
                    ],
                },
                {
                    key: "battery_first",
                    type: "object",
                    fields: [
                        { key: "target_soc", type: "number", minimum: 0, maximum: 100 },
                        { key: "min_soc", type: "number", minimum: 0, maximum: 100, default: 0 },
                        { key: "margin_pct", type: "number", minimum: 0, default: 0 },
                    ],
                },
            ],
            conditionTypes: [
                {
                    key: "run_when",
                    scope: "day",
                    field: {
                        key: "run_when",
                        type: "day_classifications",
                        choices: ["surplus", "tight", "deficit"],
                        default: ["surplus", "tight", "deficit"],
                    },
                },
                // A `choices` condition. The renderer dispatches on `choices`
                // before type, because a numeric fall-through renders a picker
                // field as a box its value cannot be typed into. No shipped
                // condition is string-valued today — `ensure_self_sustainability`
                // was, until its two words became one number — so the fixture
                // carries a hypothetical one: the contract belongs to the
                // renderer, not to whichever key happens to use it.
                {
                    key: "run_mode",
                    scope: "run",
                    field: {
                        key: "run_mode",
                        type: "string",
                        required: false,
                        choices: ["soft", "strict"],
                    },
                },
            ],
            newDraft: {
                params: {
                    window: { start: "06:00", end: "14:00" },
                    battery_first: { target_soc: 100, margin_pct: 20 },
                },
                conditions: [{ run_when: ["surplus"] }],
            },
        },
    ],
};

const CONFIG = {
    automation: {
        enabled: true,
        system_optimizers: [
            {
                id: "morning-hold",
                kind: "charge_hold",
                enabled: true,
                params: {
                    window: { start: "06:00", end: "12:00" },
                    battery_first: { target_soc: 90, margin_pct: 10 },
                },
                conditions: [
                    { run_when: ["surplus"], params: { battery_first: { target_soc: 95 } } },
                    { name: "Otherwise", run_when: ["tight", "deficit"] },
                ],
            },
        ],
    },
};

async function mountEditor(
    page: Page,
    config: unknown = CONFIG,
    schemaDocument: unknown = SCHEMA,
): Promise<Locator> {
    await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);
    await page.evaluate(
        ({ schema, config: initialConfig }) => {
            // A card enters YAML mode only once `ha-yaml-editor` is defined --
            // in a real dashboard it walks HA's developer-tools chunk for it,
            // which does not exist here. A stub short-circuits that walk, and
            // the YAML tests below drive it with the `value-changed` the real
            // editor fires.
            if (!customElements.get("ha-yaml-editor")) {
                customElements.define("ha-yaml-editor", class extends HTMLElement {});
            }
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as any;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                callWS: window.__mockHass({
                    "helman/get_config": async (request: {
                        type: string;
                    }) => {
                        return initialConfig;
                    },
                    "helman/get_optimizer_schema": async (request: {
                        type: string;
                    }) => {
                        return schema;
                    }
                }).callWS,
            };
            document.body.appendChild(element);
        },
        { schema: schemaDocument, config },
    );
    const panel = page.locator("helman-config-editor-panel");
    await panel.getByRole("button", { name: "Automation" }).click();
    // Every section of the tab starts collapsed.
    await panel.locator("details.section-card").first().waitFor({ state: "attached" });
    await panel
        .locator("details.section-card")
        .evaluateAll((sections) =>
            sections.forEach((section) => ((section as HTMLDetailsElement).open = true)),
        );
    return panel;
}

/** Open the single optimizer card and return its body. */
async function openCard(panel: Locator): Promise<Locator> {
    const card = panel.locator(".optimizer-card").first();
    await card.locator("summary").first().click();
    return card;
}

test.describe("schema-driven optimizer card", () => {
    test("renders a kind's params from the served schema", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);

        // window.start/end and battery_first.target_soc/min_soc/margin_pct, all derived
        // from the schema — no charge_hold-specific TypeScript involved.
        const labels = await card
            .locator(".appliance-body > .field-grid label")
            .allInnerTexts();
        expect(labels).toEqual(
            expect.arrayContaining([
                "Window start",
                "Window end",
                "Target SoC %",
                "Min SoC %",
                "Charge energy margin %",
            ]),
        );
    });

    test("a kind with no params renders no master settings block", async ({ page }) => {
        const panel = await mountEditor(page, {
            automation: {
                enabled: true,
                system_optimizers: [
                    {
                        id: "export",
                        kind: "export_price",
                        enabled: true,
                        conditions: [{ when_price_below: 0 }],
                    },
                ],
            },
        });
        const card = await openCard(panel);

        // Nothing at all — `export_price` is fully described by its
        // conditions, so `params` is empty and nothing is invented for it, and
        // the id is generated on save, never shown or asked for.
        const labels = await card
            .locator(".appliance-body > .field-grid label")
            .allInnerTexts();
        expect(labels).toEqual([]);
    });

    test("every declared condition group is listed", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);

        await expect(card.locator(".condition-group")).toHaveCount(2);
        // A named group is labelled by its name; an unnamed one by its position.
        await expect(card.locator(".condition-group summary strong")).toHaveText([
            "Group 1",
            "Otherwise",
        ]);
    });

    test("a choices condition renders a picker, not a number box", async ({
        page,
    }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const field = card
            .locator(".condition-group-body > .field-grid .field")
            .filter({ hasText: "run_mode" })
            .first();

        await expect(field.locator("select")).toHaveCount(1);
        await expect(field.locator("input")).toHaveCount(0);
        // Blank first, because an optional condition left unset means
        // unconstrained rather than "pick one".
        expect(
            await field.locator("select option").evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value),
            ),
        ).toEqual(["", "soft", "strict"]);
    });

    test("an untranslated choices option falls back to the raw value", async ({
        page,
    }) => {
        // The translated path has no live subject: no shipped condition is
        // string-valued any more, so there is no `editor.choices` entry to hit.
        // What still matters is that an unknown option renders as itself rather
        // than as a raw translation key.
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const field = card
            .locator(".condition-group-body > .field-grid .field")
            .filter({ hasText: "run_mode" })
            .first();

        const labels = await field
            .locator("select option")
            .evaluateAll((options) => options.map((option) => option.textContent));
        expect(labels.slice(1)).toEqual(["soft", "strict"]);
    });

    test("a group's override shows the inherited value as a placeholder", async ({
        page,
    }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const secondGroup = card.locator(".condition-group").nth(1);
        await secondGroup.locator("summary").first().click();
        await secondGroup.locator(".param-override > summary").click();

        // The second group overrides nothing, so `window.start` is empty and
        // shows what it inherits from the master block.
        const windowStart = secondGroup
            .locator(".param-override input")
            .first();
        await expect(windowStart).toHaveValue("");
        await expect(windowStart).toHaveAttribute("placeholder", "06:00");
    });

    test("a non-overridable param is offered by the master block only", async ({
        page,
    }) => {
        // The reader rejects such an override outright, so offering it here
        // would build a config the user cannot save. Driven by the schema flag
        // alone — nothing in the editor names the field.
        const schema = JSON.parse(JSON.stringify(SCHEMA));
        const chargeHold = schema.kinds.find(
            (kind: { kind: string }) => kind.kind === "charge_hold",
        );
        chargeHold.params.push({
            key: "max_consecutive_skips",
            type: "integer",
            minimum: 0,
            default: 0,
            overridable: false,
        });
        const panel = await mountEditor(page, CONFIG, schema);
        const card = await openCard(panel);

        const masterLabels = await card
            .locator(".appliance-body > .field-grid label")
            .allInnerTexts();
        expect(masterLabels).toContain("Max consecutive skips");

        // The override form keeps its five overridable fields (window
        // start/end, target SoC, min SoC, margin) and gains no sixth — so this
        // is a filter, not a broken form.
        const firstGroup = card.locator(".condition-group").first();
        await firstGroup.locator(".param-override > summary").click();
        await expect(firstGroup.locator(".param-override input")).toHaveCount(5);
    });

    test("adding a group appends one seeded from the kind's draft", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);

        await card.getByRole("button", { name: "+ Condition group" }).click();

        await expect(card.locator(".condition-group")).toHaveCount(3);
    });

    test("the last condition group cannot be removed", async ({ page }) => {
        const panel = await mountEditor(page, {
            automation: {
                enabled: true,
                system_optimizers: [
                    {
                        id: "export",
                        kind: "export_price",
                        enabled: true,
                        conditions: [{ when_price_below: 0 }],
                    },
                ],
            },
        });
        const card = await openCard(panel);

        // Zero groups is an unsavable automation, so the UI must not be able to
        // reach that state at all.
        await expect(card.locator(".remove-condition-group")).toBeDisabled();
    });

    test("removing a group is enabled once there is more than one", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        // Removing now asks first, the same way the editor already asks before
        // throwing unsaved work away.
        page.on("dialog", (dialog) => void dialog.accept());

        await expect(card.locator(".remove-condition-group").first()).toBeEnabled();
        await card.locator(".remove-condition-group").first().click();
        await expect(card.locator(".condition-group")).toHaveCount(1);
        await expect(card.locator(".remove-condition-group")).toBeDisabled();
    });

    test("the name and the collapse marker share the summary line", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const summary = card.locator(".condition-group").first().locator("summary");

        // Same line means same vertical centre. The native ::marker sits outside
        // the flex row and pushes the name onto its own line; a chevron inside
        // the row does not.
        const chevron = await summary.locator(".appliance-chevron").boundingBox();
        const name = await summary.locator(".condition-group-name").boundingBox();
        const centre = (box: { y: number; height: number } | null) =>
            box!.y + box!.height / 2;
        expect(Math.abs(centre(chevron) - centre(name))).toBeLessThan(4);
    });

    test("the rename field is seeded with the label, default names included", async ({
        page,
    }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const group = card.locator(".condition-group").first();

        await group.locator(".rename-condition-group").click();

        // Group 1 has no `name`, so it shows its position — and renaming starts
        // from what the user is looking at, not from an empty box.
        await expect(group.locator(".condition-group-name-input")).toHaveValue("Group 1");
    });

    test("the rename field takes focus with its text selected", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const group = card.locator(".condition-group").first();

        await group.locator(".rename-condition-group").click();

        // One click to rename, and typing replaces the old name rather than
        // appending to it.
        await expect(group.locator(".condition-group-name-input")).toBeFocused();
        await page.keyboard.type("Sunny");
        await expect(group.locator(".condition-group-name-input")).toHaveValue("Sunny");
    });

    test("renaming a group updates its heading", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const group = card.locator(".condition-group").first();

        await group.locator(".rename-condition-group").click();
        await group.locator(".condition-group-name-input").fill("Sunny days");
        await group.locator(".condition-group-name-input").press("Enter");

        await expect(group.locator(".condition-group-name")).toHaveText("Sunny days");
    });

    test("committing the untouched default keeps the name implicit", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const group = card.locator(".condition-group").nth(0);

        await group.locator(".rename-condition-group").click();
        await group.locator(".condition-group-name-input").press("Enter");

        // Still the fallback, so the group renumbers when it moves rather than
        // freezing "Group 1" into the config.
        await expect(group.locator(".condition-group-name")).toHaveText("Group 1");
        // Groups reorder by dragging now, and `ha-sortable` is undefined in a
        // bare page -- so the move is the event a real drag would have fired.
        await card.locator("ha-sortable").first().evaluate((sortable) => {
            sortable.dispatchEvent(
                new CustomEvent("item-moved", {
                    detail: { oldIndex: 1, newIndex: 0 },
                    bubbles: true,
                    composed: true,
                }),
            );
        });
        await expect(
            card.locator(".condition-group").nth(1).locator(".condition-group-name"),
        ).toHaveText("Group 2");
    });

    test("Escape abandons a rename", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const group = card.locator(".condition-group").first();

        await group.locator(".rename-condition-group").click();
        await group.locator(".condition-group-name-input").fill("Discarded");
        await group.locator(".condition-group-name-input").press("Escape");

        await expect(group.locator(".condition-group-name")).toHaveText("Group 1");
    });

    test("starting a rename does not collapse the group", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        const group = card.locator(".condition-group").first();
        await expect(group).toHaveAttribute("open", "");

        await group.locator(".rename-condition-group").click();

        // The icon lives inside <summary>; without stopping the event the click
        // would toggle the disclosure out from under the input.
        await expect(group).toHaveAttribute("open", "");
    });

    test("one add button per kind the backend serves", async ({ page }) => {
        const panel = await mountEditor(page);

        // Adding a sixth kind is a Python declaration; the editor grows a
        // button for it without a line of new TypeScript.
        await expect(panel.locator("button[data-add-kind]")).toHaveCount(
            SCHEMA.kinds.length,
        );
    });

    test("adding an optimizer seeds it from the schema's draft", async ({ page }) => {
        const panel = await mountEditor(page);

        await panel.locator('button[data-add-kind="export_price"]').click();

        const cards = panel.locator(".optimizer-card");
        await expect(cards).toHaveCount(2);
        await expect(cards.nth(1)).toHaveAttribute("data-kind", "export_price");
    });
});

/**
 * The card's own Visual / YAML switch.
 *
 * Owned by `helman-optimizer-editor` rather than by whoever mounted it, so it
 * is the same switch in the config panel and in the inspector's edit dialog.
 * `ha-yaml-editor` is stubbed here, so these drive it with the `value-changed`
 * the real one fires.
 */
test.describe("an optimizer's YAML mode", () => {
    const modeButton = (card: Locator, name: "Visual" | "YAML") =>
        card.locator(".mode-toggle button", { hasText: name });

    /** What `ha-yaml-editor` reports as the reader types. */
    async function yamlEdit(
        card: Locator,
        detail: { value?: unknown; isValid: boolean; errorMsg?: string },
    ): Promise<void> {
        await card.locator("ha-yaml-editor").evaluate((editor, payload) => {
            editor.dispatchEvent(
                new CustomEvent("value-changed", {
                    detail: payload,
                    bubbles: true,
                    composed: true,
                }),
            );
        }, detail);
    }

    /** Two optimizers, so a move has somewhere to move to. */
    const TWO = {
        automation: {
            enabled: true,
            system_optimizers: [
                {
                    id: "morning-hold",
                    kind: "charge_hold",
                    enabled: true,
                    params: { window: { start: "06:00", end: "12:00" } },
                    conditions: [{ run_when: ["surplus"] }],
                },
                {
                    id: "export",
                    kind: "export_price",
                    enabled: true,
                    conditions: [{ when_price_below: 0 }],
                },
            ],
        },
    };

    test("the summary switches the card between visual and YAML", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);

        await modeButton(card, "YAML").click();

        // The YAML editor replaces the form rather than joining it: one editor
        // of record on screen.
        await expect(card.locator(".yaml-surface")).toHaveCount(1);
        await expect(card.locator(".appliance-body > .field-grid")).toHaveCount(0);
        // Switching the mode must not collapse the card out from under it.
        await expect(card).toHaveAttribute("open", "");

        await modeButton(card, "Visual").click();
        await expect(card.locator(".yaml-surface")).toHaveCount(0);
        await expect(card.locator(".appliance-body > .field-grid")).toHaveCount(1);
    });

    test("a valid YAML edit lands in the draft and shows in the form", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        await modeButton(card, "YAML").click();

        await yamlEdit(card, {
            isValid: true,
            value: {
                id: "renamed-hold",
                kind: "charge_hold",
                enabled: true,
                params: { window: { start: "07:00", end: "12:00" } },
                conditions: [{ run_when: ["surplus"] }],
            },
        });

        // The edit went through the same `optimizer-config-changed` a form edit
        // does, so the panel is dirty and its Save button is live.
        await expect(panel.getByRole("button", { name: "Save" })).toBeEnabled();

        await modeButton(card, "Visual").click();
        // This schema declares no target, so the card is titled by its kind —
        // never by the id the YAML just renamed.
        await expect(card.locator(".card-title strong")).toHaveText("Charge hold");
        const values = await card
            .locator(".appliance-body > .field-grid input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
        expect(values[0]).toBe("07:00");
        expect(values).not.toContain("renamed-hold");
    });

    test("a YAML card is titled by its selected target", async ({ page }) => {
        // The real `charge_hold` targets the inverter, and the title comes from
        // that target in either mode — YAML hides the form, not the summary.
        const schema = {
            ...SCHEMA,
            kinds: SCHEMA.kinds.map((kind) => kind.kind !== "charge_hold" ? kind : {
                ...kind,
                target: [{ key: "controllable_id", type: "string", default: "inverter" }],
                controllableKinds: ["inverter"],
            }),
        };
        const config = {
            energy_nodes: { inverter: { controls: {} } },
            automation: {
                ...CONFIG.automation,
                system_optimizers: [{
                    ...CONFIG.automation.system_optimizers[0],
                    target: { controllable_id: "inverter" },
                }],
            },
        };
        const panel = await mountEditor(page, config, schema);
        const card = await openCard(panel);

        await modeButton(card, "YAML").click();

        await expect(card.locator(".yaml-surface")).toHaveCount(1);
        await expect(card.locator(".card-title strong")).toHaveText("Inverter");
    });

    test("invalid YAML shows the error and blocks the way back", async ({ page }) => {
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        await modeButton(card, "YAML").click();

        await yamlEdit(card, { isValid: false, errorMsg: "bad indentation" });

        // The editor's own message names the line, so it is preferred over our
        // generic one.
        await expect(card.locator(".yaml-surface .message.error")).toHaveText("bad indentation");
        await modeButton(card, "Visual").click();
        await expect(card.locator(".yaml-surface")).toHaveCount(1);

        // And a value YAML parses but the optimizer cannot be is refused too.
        await yamlEdit(card, { isValid: true, value: "just a string" });
        await expect(card.locator(".yaml-surface .message.error")).toHaveCount(1);
        await modeButton(card, "Visual").click();
        await expect(card.locator(".yaml-surface")).toHaveCount(1);

        // Fixing it unblocks the switch: the error is a gate, not a trap.
        await yamlEdit(card, {
            isValid: true,
            value: { id: "morning-hold", kind: "charge_hold", enabled: true, conditions: [{}] },
        });
        await modeButton(card, "Visual").click();
        await expect(card.locator(".yaml-surface")).toHaveCount(0);
    });

    test("a list where the optimizer should be is refused, not applied", async ({ page }) => {
        // Pasting a whole `system_optimizers:` block into one optimizer is the
        // easy way to do this by accident. Applying it used to be
        // unrecoverable: the card renders from `asJsonObject(...)` and drew
        // nothing at all for a list, taking the mode toggle and the YAML
        // surface down with it and leaving a dirty draft with no way back in.
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        await modeButton(card, "YAML").click();

        await yamlEdit(card, {
            isValid: true,
            value: [{ id: "morning-hold", kind: "charge_hold" }],
        });

        await expect(card.locator(".yaml-surface .message.error")).toHaveCount(1);
        await expect(panel.locator(".optimizer-card")).toHaveCount(1);
        await expect(card.locator(".yaml-surface")).toHaveCount(1);

        // `null` parses to an object by `typeof`, so it needs saying too.
        await yamlEdit(card, { isValid: true, value: null });
        await expect(panel.locator(".optimizer-card")).toHaveCount(1);
        await expect(card.locator(".yaml-surface")).toHaveCount(1);
    });

    test("retyping the kind keeps the editor open through the unknown middle", async ({
        page,
    }) => {
        // Fixing a kind by hand passes through an unknown one on nearly every
        // keystroke. The visual and unsupported cards are two different
        // templates, so crossing between them tore the `<details>` down and
        // rebuilt it closed, losing the editor's focus and formatting with it.
        // YAML mode renders one shell for both, outside that branch.
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        await modeButton(card, "YAML").click();

        await yamlEdit(card, {
            isValid: true,
            value: { id: "morning-hold", kind: "charge_hol", enabled: true },
        });

        await expect(card.locator(".yaml-surface")).toBeVisible();
        await expect(card.locator(".raw-preview")).toHaveCount(0);

        // And once the kind is whole again, still open and still in YAML.
        await yamlEdit(card, {
            isValid: true,
            value: { id: "morning-hold", kind: "charge_hold", enabled: true },
        });
        await expect(card.locator(".yaml-surface")).toBeVisible();
    });

    test("flipping Enabled leaves the open YAML editor alone", async ({ page }) => {
        // The Enabled switch lives in the summary, so it stays live while the
        // body is a YAML editor -- and flipping it rewrites `enabled` at this
        // very path, which used to look like a different optimizer arriving and
        // closed YAML mode mid-edit. With an error showing, that silently threw
        // away the very text `_exitYamlMode` refuses to let the reader abandon.
        const panel = await mountEditor(page);
        const card = await openCard(panel);
        await modeButton(card, "YAML").click();
        await yamlEdit(card, { isValid: false, errorMsg: "bad indentation" });

        await card
            .locator(".summary-toggle ha-switch")
            .evaluate((element: HTMLElement & { checked: boolean }) => {
                element.checked = false;
                element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            });

        // Still in YAML, still holding the error, so the unsaved text survives.
        await expect(card.locator(".yaml-surface")).toHaveCount(1);
        await expect(card.locator(".yaml-surface .message.error")).toHaveText("bad indentation");

        // And the toggle did land: this is not the switch being ignored.
        await expect(card.locator(".summary-toggle ha-switch")).toHaveJSProperty(
            "checked",
            false,
        );

        // A real replacement still closes it -- the rule did not just go away.
        await yamlEdit(card, {
            isValid: true,
            value: { id: "someone-else", kind: "charge_hold", enabled: false },
        });
        await modeButton(card, "Visual").click();
        await expect(card.locator(".yaml-surface")).toHaveCount(0);
    });

    test("a kind the schema does not describe is fixable as YAML", async ({ page }) => {
        // Raw YAML is the only way to fix an unknown kind -- the form has no
        // fields to offer for it -- so that card carries the switch too.
        const panel = await mountEditor(page, {
            automation: {
                enabled: true,
                system_optimizers: [{ id: "mystery", kind: "from_the_future", enabled: true }],
            },
        });
        const card = panel.locator(".optimizer-card");
        await card.locator("summary").first().click();
        await expect(card.locator(".raw-preview")).toHaveCount(1);

        await modeButton(card, "YAML").click();

        await expect(card.locator(".yaml-surface")).toHaveCount(1);
        await expect(card.locator(".raw-preview")).toHaveCount(0);
    });

    test("moving the card returns it to visual, still editing its own optimizer", async ({
        page,
    }) => {
        const panel = await mountEditor(page, TWO);
        const card = panel.locator(".optimizer-card").first();
        await card.locator("summary").first().click();
        await modeButton(card, "YAML").click();
        await expect(card.locator(".yaml-surface")).toHaveCount(1);

        // Lit reuses the element by list position, so after a drag the element
        // that was in YAML mode is handed a different optimizer -- and would
        // otherwise go on editing the one that moved away.
        await panel
            .locator("ha-sortable")
            .filter({ has: page.locator("helman-optimizer-editor") })
            .first()
            .evaluate((sortable) => {
                sortable.dispatchEvent(
                    new CustomEvent("item-moved", {
                        detail: { oldIndex: 0, newIndex: 1 },
                        bubbles: true,
                        composed: true,
                    }),
                );
            });

        // Both target the inverter, so the kind subtitle tells them apart.
        await expect(panel.locator(".optimizer-card .card-subtitle").first()).toHaveText(
            "Export price",
        );
        await expect(panel.locator(".yaml-surface")).toHaveCount(0);
    });
});

test.describe("battery hold while EV charging", () => {
    /** The kind as the backend serves it. */
    const HOLD_SCHEMA = {
        version: 2,
        applianceKinds: ["climate", "ev_charger", "generic"],
        kinds: [
            {
                kind: "battery_hold_while_ev_charging",
                target: [{ key: "controllable_id", type: "string", default: "inverter" }],
                params: [
                    {
                        key: "ev_chargers",
                        type: "object_list",
                        minItems: 1,
                        overridable: false,
                        fields: [{ key: "controllable_id", type: "string" }],
                    },
                    {
                        key: "sensor_grace_seconds",
                        type: "integer",
                        default: 60,
                        minimum: 0,
                        overridable: false,
                    },
                ],
                conditionTypes: [
                    {
                        key: "when_solar_below_w",
                        scope: "slot",
                        field: {
                            key: "when_solar_below_w",
                            type: "number",
                            required: false,
                            minimum: 0,
                            minimumExclusive: true,
                        },
                    },
                ],
                controllableKinds: ["inverter"],
                bucket: "system",
                newDraft: {
                    target: { controllable_id: "inverter" },
                    params: { ev_chargers: [{ controllable_id: "" }] },
                    conditions: [{}],
                },
            },
        ],
    };
    const HOLD_CONFIG = {
        energy_nodes: { inverter: { controls: {} } },
        devices: {
            consumers: [
                { kind: "ev_charger", schedulable: true, id: "garage-ev", name: "Garage EV" },
                { kind: "ev_charger", schedulable: true, id: "drive-ev", name: "Drive EV" },
                { kind: "generic", schedulable: true, id: "boiler", name: "Boiler" },
            ],
        },
        automation: {
            enabled: true,
            system_optimizers: [
                {
                    id: "ev-hold",
                    kind: "battery_hold_while_ev_charging",
                    enabled: true,
                    params: { ev_chargers: [{ controllable_id: "garage-ev" }] },
                    conditions: [{ when_solar_below_w: 500 }],
                },
            ],
        },
    };

    test("each charger row offers only the draft's EV chargers", async ({ page }) => {
        const panel = await mountEditor(page, HOLD_CONFIG, HOLD_SCHEMA);
        const card = await openCard(panel);
        const rows = card.locator(".controllable-targets .controllable-target-row");

        await expect(rows).toHaveCount(1);
        const picker = rows.first().locator("select");
        await expect(picker.locator("option")).toHaveText([
            "",
            /Garage EV/,
            /Drive EV/,
        ]);
        await expect(picker).toHaveValue("garage-ev");
        // The last row cannot go: the reader needs at least one charger.
        await expect(rows.first().locator("button.danger")).toBeDisabled();

        await card.getByRole("button", { name: "+ EV charger" }).click();
        await expect(rows).toHaveCount(2);
        // A charger chosen in another row is not offered again: the backend
        // would reject it as listed twice.
        await expect(rows.nth(1).locator("select option")).toHaveText(["", /Drive EV/]);
        await rows.nth(1).locator("select").selectOption("drive-ev");
        await expect(rows.nth(1).locator("select")).toHaveValue("drive-ev");
        await expect(picker.locator("option")).toHaveText(["", /Garage EV/]);
        await expect(rows.first().locator("button.danger")).toBeEnabled();
    });

    test("the system section states that the lower optimizer wins", async ({ page }) => {
        const panel = await mountEditor(page, HOLD_CONFIG, HOLD_SCHEMA);

        await expect(
            panel.getByText(
                "Runs top to bottom. When two optimizers act on the same inverter slot, the lower one wins; a slot you set by hand is never changed.",
            ),
        ).toBeVisible();
    });
});
