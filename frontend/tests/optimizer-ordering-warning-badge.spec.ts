import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The `required_appliance_planned_later` badge against an optimizer card
 * (#273, P3 of #270).
 *
 * `helman-config-editor.ts`'s `_optimizerOrderingWarning` locates a card's
 * warning by string-prefix-matching a path built independently on the Python
 * side (`config_validation.py`'s `f"automation.{bucket_key}[{document_index}]"`)
 * and the TypeScript side (`` `automation.${bucket}[${index}].` ``). Nothing
 * else pins that format between the two languages, so a drift on either side
 * would make the badge silently stop appearing, with no compile error and no
 * other test to catch it. This test exercises the real wiring end to end: a
 * validation report with the warning at a specific path shows the badge on
 * exactly the card that path names, and no other.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const SCHEMA = {
    version: 2,
    applianceKinds: ["generic"],
    kinds: [
        {
            kind: "appliance_runtime",
            target: [{ key: "controllable_id", type: "string" }],
            params: [],
            bucket: "appliance",
            conditionTypes: [
                {
                    key: "requires_appliance",
                    scope: "slot",
                    field: { key: "requires_appliance", type: "string", required: false },
                },
            ],
            controllableKinds: ["generic"],
            newDraft: { conditions: [{}] },
        },
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
    ],
};

/**
 * "second" depends on "boiler-first" and is planned before it -- exactly the
 * shape `_validate_requires_appliance` warns on. The warning's path names
 * "second" (`appliance_optimizers[0]`), so only its card should badge.
 */
const CONFIG = {
    config_version: 15,
    power_devices: { house: { base_load_w: 350 } },
    appliances: [],
    automation: {
        enabled: true,
        appliance_optimizers: [
            {
                id: "second",
                kind: "appliance_runtime",
                enabled: true,
                target: { controllable_id: "boiler-second" },
                conditions: [{ requires_appliance: "boiler-first" }],
            },
            {
                id: "boiler-first",
                kind: "appliance_runtime",
                enabled: true,
                target: { controllable_id: "boiler-first" },
                conditions: [{}],
            },
        ],
        system_optimizers: [
            {
                id: "export_price",
                kind: "export_price",
                enabled: true,
                conditions: [{ when_price_below: 1.0 }],
            },
        ],
    },
};

const VALIDATION_REPORT = {
    valid: true,
    errors: [],
    warnings: [
        {
            section: "automation",
            path: "automation.appliance_optimizers[0].conditions[0].requires_appliance",
            code: "required_appliance_planned_later",
            message:
                "optimizer 'second' requires appliance 'boiler-first', which is planned by a later optimizer.",
        },
    ],
};

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ schema, config, validation }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: {
                    subscribeMessage: async () => () => undefined,
                },
                callWS: async (request: { type: string }) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") return schema;
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/validate_config") return validation;
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { schema: SCHEMA, config: CONFIG, validation: VALIDATION_REPORT },
    );
}

function root(page: Page) {
    return page.locator("helman-config-editor-panel");
}

async function openAutomationTab(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() =>
                Array.from(
                    document
                        .querySelector("helman-config-editor-panel")
                        ?.shadowRoot?.querySelectorAll("button") ?? [],
                ).map((tab) => tab.textContent?.trim() ?? ""),
            ),
        )
        .toContain("Automation");

    await page.evaluate(() => {
        const buttons = Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("button") ?? [],
        );
        buttons.find((button) => button.textContent?.trim() === "Automation")?.click();
    });
}

async function clickValidate(page: Page): Promise<void> {
    await page.evaluate(() => {
        const buttons = Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("button") ?? [],
        );
        buttons.find((button) => button.textContent?.trim() === "Validate")?.click();
    });
}

/**
 * `<helman-optimizer-editor>` renders its own card in its own shadow root, one
 * level under the panel's -- so the badge and its title have to be read
 * through each card element's own shadow root, not the panel's.
 */
function badgedCardTitles(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("helman-optimizer-editor") ?? [],
        )
            .filter((card) => card.shadowRoot?.querySelector(".optimizer-warning-badge"))
            .map((card) => card.shadowRoot?.querySelector(".card-title")?.textContent?.trim() ?? ""),
    );
}

test("the ordering warning badges the dependent's card, not the provider's or a system card", async ({
    page,
}) => {
    await mountEditor(page);
    await openAutomationTab(page);
    await clickValidate(page);

    // The warning names appliance_optimizers[0] ("second", titled by its own
    // controllable "boiler-second") -- confirming the path-prefix match
    // resolved to the right bucket and index, not just "some" card.
    await expect.poll(() => badgedCardTitles(page)).toEqual(
        expect.arrayContaining([expect.stringContaining("boiler-second")]),
    );

    const titles = await badgedCardTitles(page);
    expect(titles.some((title) => title.includes("boiler-first"))).toBe(false);
    expect(titles.some((title) => title.includes("export_price"))).toBe(false);
    expect(titles).toHaveLength(1);
});

test("the badge tooltip carries the validator's own message", async ({ page }) => {
    await mountEditor(page);
    await openAutomationTab(page);
    await clickValidate(page);

    await expect
        .poll(() =>
            page.evaluate(() => {
                const card = Array.from(
                    document
                        .querySelector("helman-config-editor-panel")
                        ?.shadowRoot?.querySelectorAll("helman-optimizer-editor") ?? [],
                ).find((element) => element.shadowRoot?.querySelector(".optimizer-warning-badge"));
                return (
                    card?.shadowRoot
                        ?.querySelector(".optimizer-warning-badge")
                        ?.getAttribute("title") ?? null
                );
            }),
        )
        .toContain("boiler-first");
});
