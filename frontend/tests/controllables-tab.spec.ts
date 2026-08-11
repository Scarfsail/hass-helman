import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The Controllables tab, after the inverter stopped having a tab of its own.
 *
 * The inverter used to be edited on a Scheduler tab holding one section and no
 * scheduling policy at all. It is now an entry in the same list as the
 * appliances — which only helps if it renders as a real card. The kind
 * dispatcher has an unsupported-kind fallback that shows a read-only JSON dump,
 * so "the inverter appears in the list" is not evidence of anything; what is
 * evidence is that its six action-option fields are editable, and that they
 * write to `controls.mode.options`.
 *
 * The add button is the other half: the inverter is a singleton in config
 * validation, so the UI must not be able to author the second one.
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
            options: {
                normal: "Self Use",
                charge_to_target_soc: "Manual",
                discharge_to_target_soc: "Manual",
                stop_charging: "Manual",
                stop_discharging: "Manual",
                stop_export: "Feedin Priority",
            },
        },
    },
};

const BOILER = {
    kind: "generic",
    id: "boiler",
    name: "Boiler",
    controls: { switch: { entity_id: "switch.boiler" } },
    projection: { strategy: "fixed", hourly_energy_kwh: 2 },
};

declare global {
    interface Window {
        __editorConfig: () => unknown;
    }
}

async function mountEditor(page: Page, controllables: unknown[]): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(
        () => !!customElements.get("helman-config-editor-panel"),
    );

    await page.evaluate((config) => {
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        window.__editorConfig = () =>
            (element as unknown as { _config: unknown })._config;
        element.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            connection: {
                subscribeEvents: async () => () => undefined,
            },
            callWS: async (request: { type: string }) => {
                if (request.type === "helman/get_config") {
                    return JSON.parse(JSON.stringify(config));
                }
                if (request.type === "helman/get_optimizer_schema") {
                    return { version: 2, kinds: [] };
                }
                if (request.type === "helman/get_appliances") return { appliances: [] };
                return {};
            },
        };
        document.body.appendChild(element);
    }, { config_version: 7, controllables });

    await openControllablesTab(page);
}

function root(page: Page) {
    return page.locator("helman-config-editor-panel");
}

async function openControllablesTab(page: Page): Promise<void> {
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
        .toContain("Controllables");

    await page.evaluate(() => {
        const buttons = Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("button") ?? [],
        );
        buttons
            .find((button) => button.textContent?.trim() === "Controllables")
            ?.click();
    });
}

/** Labels of every card in the Controllables list, in list order. */
function cardTitles(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll(".list-card .card-title strong") ?? [],
        ).map((title) => title.textContent?.trim() ?? ""),
    );
}

/** Footer button labels, which is where the add-a-kind buttons live. */
function addButtons(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll(".section-footer .add-button") ?? [],
        ).map((button) => button.textContent?.trim() ?? ""),
    );
}

test("the Scheduler tab is gone", async ({ page }) => {
    await mountEditor(page, [INVERTER]);

    const tabs = await page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("button") ?? [],
        ).map((button) => button.textContent?.trim() ?? ""),
    );

    expect(tabs).not.toContain("Scheduler");
});

test("the inverter is a card in the list, beside the appliances", async ({ page }) => {
    await mountEditor(page, [INVERTER, BOILER]);

    await expect.poll(() => cardTitles(page)).toEqual(["Inverter", "Boiler"]);
});

test("the inverter card renders its own fields, not the unsupported-kind dump", async ({
    page,
}) => {
    await mountEditor(page, [INVERTER]);

    const rendered = await root(page).evaluate((element) => {
        const shadow = (element as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
        const card = shadow.querySelector(".list-card");
        return {
            rawPreviews: card?.querySelectorAll(".raw-preview").length ?? -1,
            labels: Array.from(card?.querySelectorAll("label") ?? []).map(
                (label) => label.textContent?.trim() ?? "",
            ),
        };
    });

    expect(rendered.rawPreviews).toBe(0);
    // Every field the retired Scheduler tab had, and nothing lost.
    expect(rendered.labels).toEqual(
        expect.arrayContaining([
            "Mode entity",
            "Normal option",
            "Charge to target SoC option",
            "Discharge to target SoC option",
            "Stop charging option",
            "Stop discharging option",
            "Stop export option",
        ]),
    );
});

test("editing an action option writes to controls.mode.options", async ({ page }) => {
    await mountEditor(page, [INVERTER]);

    await root(page).evaluate((element) => {
        const shadow = (element as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
        const field = Array.from(shadow.querySelectorAll(".field")).find((candidate) =>
            candidate.querySelector("label")?.textContent?.trim() === "Stop export option",
        );
        const input = field?.querySelector("input") as HTMLInputElement;
        input.value = "Feed-in Priority";
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });

    await expect
        .poll(() =>
            page.evaluate(() => {
                const config = window.__editorConfig() as {
                    controllables: Array<{
                        controls: { mode: { options: Record<string, string> } };
                    }>;
                };
                return config.controllables[0].controls.mode.options.stop_export;
            }),
        )
        .toBe("Feed-in Priority");
});

test("Add inverter is offered only while there is no inverter", async ({ page }) => {
    await mountEditor(page, [BOILER]);
    expect(await addButtons(page)).toContain("Add inverter");

    await page.evaluate(() => {
        const buttons = Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll(".section-footer .add-button") ?? [],
        );
        buttons
            .find((button) => button.textContent?.trim() === "Add inverter")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });

    await expect.poll(() => cardTitles(page)).toContain("Inverter");
    // The config the singleton rule rejects is now unreachable from the UI.
    expect(await addButtons(page)).not.toContain("Add inverter");
});
