import { test, expect, type Page, type Locator } from "@playwright/test";
import { resolve } from "node:path";

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

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** The schema the backend serves, trimmed to the kinds these tests exercise. */
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
        {
            kind: "charge_hold",
            target: [],
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
        optimizers: [
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
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(
        () => !!customElements.get("helman-config-editor-panel"),
    );
    await page.evaluate(
        ({ schema, config: initialConfig }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as any;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                callWS: async (request: { type: string }) => {
                    if (request.type === "helman/get_config") return initialConfig;
                    if (request.type === "helman/get_optimizer_schema") return schema;
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { schema: schemaDocument, config },
    );
    const panel = page.locator("helman-config-editor-panel");
    await panel.getByRole("button", { name: "Automation" }).click();
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

        // window.start/end and battery_first.target_soc/margin_pct, all derived
        // from the schema — no charge_hold-specific TypeScript involved.
        const labels = await card
            .locator(".appliance-body > .field-grid label")
            .allInnerTexts();
        expect(labels).toEqual(
            expect.arrayContaining([
                "Window start",
                "Window end",
                "Target SoC %",
                "Margin %",
            ]),
        );
    });

    test("a kind with no params renders no master settings block", async ({ page }) => {
        const panel = await mountEditor(page, {
            automation: {
                enabled: true,
                optimizers: [
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

        // Only the optimizer id — `export_price` is fully described by its
        // conditions, so `params` is empty and nothing is invented for it.
        const labels = await card
            .locator(".appliance-body > .field-grid label")
            .allInnerTexts();
        expect(labels).toEqual(["Optimizer id"]);
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

        // The override form keeps its four overridable fields (window
        // start/end, target SoC, margin) and gains no fifth — so this is a
        // filter, not a broken form.
        const firstGroup = card.locator(".condition-group").first();
        await firstGroup.locator(".param-override > summary").click();
        await expect(firstGroup.locator(".param-override input")).toHaveCount(4);
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
                optimizers: [
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
        await card.locator(".condition-group").nth(1).locator("button", {
            hasText: "Up",
        }).click();
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
