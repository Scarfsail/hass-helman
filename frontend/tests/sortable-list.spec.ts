import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The shared sortable list, across every ordered list in the config editor.
 *
 * Nine hand-written Up / Down / Remove rows became one helper -- a drag handle
 * and an icon remove button -- so what these tests pin is the *wiring*: that
 * each list hands `ha-sortable`'s `item-moved` to the mutator that owns its
 * path, that a nested list's move never reaches the list holding the card, and
 * that a remove asks before it happens.
 *
 * `ha-sortable` is HA's own element and is undefined in a bare page, so the
 * dragging itself is not exercised here (a mouse gesture would only be testing
 * SortableJS). Dispatching the event the real element fires is the whole of the
 * contract between it and this editor.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** An ordered group target, as the backend serves `appliance_runtime`'s. */
const GROUP_TARGET_FIELD = {
    key: "controllables",
    type: "object_list",
    minItems: 1,
    fields: [{ key: "controllable_id", type: "string" }],
};

const SCHEMA = {
    version: 2,
    applianceKinds: ["generic"],
    kinds: [
        {
            kind: "appliance_runtime",
            bucket: "appliance",
            target: [GROUP_TARGET_FIELD],
            params: [],
            controllableKinds: ["generic"],
            conditionTypes: [
                {
                    key: "min_runtime_min",
                    scope: "slot",
                    field: { key: "min_runtime_min", type: "integer", default: 30 },
                },
            ],
            newDraft: { conditions: [{}] },
        },
    ],
};

const controllable = (id: string, name: string) => ({
    kind: "generic",
    id,
    name,
    controls: { switch: { entity_id: `switch.${id}` } },
    consumption: {
        energy_entity_id: `sensor.${id}_energy_total`,
        projection: { strategy: "fixed", hourly_energy_kwh: 1 },
    },
});

const CONFIG = {
    config_version: 7,
    controllables: [controllable("boiler", "Boiler"), controllable("pump", "Pump")],
    automation: {
        enabled: true,
        appliance_optimizers: [
            {
                id: "boiler-runtime",
                kind: "appliance_runtime",
                enabled: true,
                target: {
                    controllables: [{ controllable_id: "boiler" }, { controllable_id: "pump" }],
                },
                conditions: [{ min_runtime_min: 30 }, { name: "Otherwise", min_runtime_min: 60 }],
            },
            {
                id: "pump-runtime",
                kind: "appliance_runtime",
                enabled: true,
                target: { controllables: [{ controllable_id: "pump" }] },
                conditions: [{ min_runtime_min: 15 }],
            },
        ],
        system_optimizers: [],
    },
};

interface DraftDocument {
    controllables: { id: string }[];
    automation: {
        appliance_optimizers: {
            id: string;
            target: { controllables: { controllable_id: string }[] };
            conditions: { name?: string }[];
        }[];
    };
}

declare global {
    interface Window {
        __editorConfig: () => DraftDocument;
    }
}

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, schema }) => {
            // The editor will not enter YAML mode until `ha-yaml-editor` is
            // defined -- in the real panel it walks HA's developer-tools chunk
            // for it, which does not exist here. A stub short-circuits that
            // walk, which is all the YAML-mode test below needs.
            if (!customElements.get("ha-yaml-editor")) {
                customElements.define("ha-yaml-editor", class extends HTMLElement {});
            }
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            window.__editorConfig = () =>
                (element as unknown as { _config: DraftDocument })._config;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                callWS: async (request: { type: string }) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") return schema;
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config: CONFIG, schema: SCHEMA },
    );
}

async function openTab(page: Page, label: string): Promise<void> {
    await page
        .locator("helman-config-editor-panel")
        .getByRole("button", { name: label })
        .click();
}

/**
 * Fire the event the real `ha-sortable` fires after a drag.
 *
 * Lists are told apart by the class of the container they wrap, which is the
 * one the list already laid itself out with. `nth` picks between two lists of
 * the same kind -- a condition group list per optimizer card, say.
 */
async function moveItem(
    page: Page,
    containerClass: string,
    oldIndex: number,
    newIndex: number,
    nth = 0,
): Promise<void> {
    await page.evaluate(
        ({ containerClass: className, oldIndex: from, newIndex: to, nth: which }) => {
            const found: Element[] = [];
            const walk = (root: Document | ShadowRoot): void => {
                root.querySelectorAll("ha-sortable").forEach((sortable) => {
                    if (sortable.firstElementChild?.classList.contains(className)) {
                        found.push(sortable);
                    }
                });
                root.querySelectorAll("*").forEach((element) => {
                    if (element.shadowRoot) {
                        walk(element.shadowRoot);
                    }
                });
            };
            walk(document);
            const target = found[which];
            if (!target) {
                throw new Error(`no ha-sortable wrapping .${className} at ${which}`);
            }
            target.dispatchEvent(
                new CustomEvent("item-moved", {
                    detail: { oldIndex: from, newIndex: to },
                    bubbles: true,
                    composed: true,
                }),
            );
        },
        { containerClass, oldIndex, newIndex, nth },
    );
}

/** The one optimizer card, open, in the Automation tab. */
async function openFirstOptimizer(page: Page): Promise<void> {
    await openTab(page, "Automation");
    const card = page.locator("helman-optimizer-editor").first().locator(".optimizer-card");
    await card.locator("summary").first().click();
    await expect(card).toHaveAttribute("open", "");
}

const controllableIds = (page: Page) =>
    page.evaluate(() => window.__editorConfig().controllables.map((entry) => entry.id));

const optimizerIds = (page: Page) =>
    page.evaluate(() =>
        window.__editorConfig().automation.appliance_optimizers.map((entry) => entry.id),
    );

test("the controllables list reorders from its own ha-sortable", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Controllables");

    await moveItem(page, "list-stack", 0, 1);

    await expect.poll(() => controllableIds(page)).toEqual(["pump", "boiler"]);
});

test("an optimizer bucket reorders from its own ha-sortable", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Automation");

    await moveItem(page, "list-stack", 1, 0);

    await expect.poll(() => optimizerIds(page)).toEqual(["pump-runtime", "boiler-runtime"]);
});

test("a target group reorders its members in priority order", async ({ page }) => {
    await mountEditor(page);
    await openFirstOptimizer(page);

    await moveItem(page, "controllable-target-rows", 0, 1);

    await expect
        .poll(() =>
            page.evaluate(() =>
                window
                    .__editorConfig()
                    .automation.appliance_optimizers[0].target.controllables.map(
                        (member) => member.controllable_id,
                    ),
            ),
        )
        .toEqual(["pump", "boiler"]);
});

test("a condition group move stays inside its own card", async ({ page }) => {
    await mountEditor(page);
    await openFirstOptimizer(page);

    await moveItem(page, "condition-group-list", 0, 1);

    // The groups swapped...
    await expect
        .poll(() =>
            page.evaluate(() =>
                window
                    .__editorConfig()
                    .automation.appliance_optimizers[0].conditions.map(
                        (group) => group.name ?? "unnamed",
                    ),
            ),
        )
        .toEqual(["Otherwise", "unnamed"]);
    // ...and the list *holding* the card never heard the event, which is what
    // the handler's `stopPropagation` is for: a card's own lists sit inside it.
    expect(await optimizerIds(page)).toEqual(["boiler-runtime", "pump-runtime"]);
});

test("removing an entry asks first, and cancelling keeps it", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Controllables");

    let accept = false;
    page.on("dialog", (dialog) => void (accept ? dialog.accept() : dialog.dismiss()));

    const removeFirst = page
        .locator("helman-config-editor-panel")
        .locator(".list-card > summary .list-actions button.danger")
        .first();

    await removeFirst.click();
    await expect.poll(() => controllableIds(page)).toEqual(["boiler", "pump"]);

    accept = true;
    await removeFirst.click();
    await expect.poll(() => controllableIds(page)).toEqual(["pump"]);
});

test("moving a controllable edited as YAML returns it to visual mode", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Controllables");

    const panel = page.locator("helman-config-editor-panel");
    const firstCard = panel.locator(".list-card").first();
    await firstCard.locator(".mode-toggle button", { hasText: "YAML" }).click();
    await expect(firstCard).toHaveClass(/scope-yaml/);

    // The per-card YAML state is keyed by list index, so a move would leave it
    // describing a different card. One rule: any move clears all of it.
    await moveItem(page, "list-stack", 0, 1);

    await expect.poll(() => controllableIds(page)).toEqual(["pump", "boiler"]);
    await expect(panel.locator(".list-card.scope-yaml")).toHaveCount(0);
});
