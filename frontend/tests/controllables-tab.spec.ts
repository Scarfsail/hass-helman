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

const EV_CHARGER = {
    kind: "ev_charger",
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
};

const BOILER = {
    kind: "generic",
    id: "boiler",
    name: "Boiler",
    controls: { switch: { entity_id: "switch.boiler" } },
    consumption: {
        energy_entity_id: "sensor.boiler_energy_total",
        projection: { strategy: "fixed", hourly_energy_kwh: 2 },
    },
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
                subscribeMessage: async () => () => undefined,
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
        // An entity group renders its picker and its label inside its own
        // shadow root, so the card's own `label` elements are only half the
        // fields on screen.
        const labels = [
            ...Array.from(card?.querySelectorAll("label") ?? []),
            ...Array.from(card?.querySelectorAll("helman-entity-group") ?? []).flatMap(
                (group) => Array.from(group.shadowRoot?.querySelectorAll("label") ?? []),
            ),
        ];
        return {
            rawPreviews: card?.querySelectorAll(".raw-preview").length ?? -1,
            labels: labels.map((label) => label.textContent?.trim() ?? ""),
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

/** Section headings rendered inside the first controllable card, in order. */
function sectionTitles(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll(".section-summary-label") ?? [],
        ).map((title) => title.textContent?.trim() ?? ""),
    );
}

/** Field labels rendered inside the first controllable card. */
function fieldLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const card = document
            .querySelector("helman-config-editor-panel")
            ?.shadowRoot?.querySelector(".list-card");
        return [
            ...Array.from(card?.querySelectorAll("label, ha-formfield") ?? []),
            // An entity group keeps its label in its own shadow root.
            ...Array.from(card?.querySelectorAll("helman-entity-group") ?? []).flatMap(
                (group) => Array.from(group.shadowRoot?.querySelectorAll("label") ?? []),
            ),
        ].map((label) =>
            // ha-formfield takes its label as a property, so the attribute is
            // absent and textContent is the empty slot.
            (
                (label as HTMLElement & { label?: string }).label ??
                label.textContent ??
                ""
            ).trim(),
        );
    });
}

test("a controllable carries a Consumption section, beside Controls", async ({
    page,
}) => {
    await mountEditor(page, [BOILER]);

    const titles = await sectionTitles(page);
    expect(titles).toContain("Controls");
    expect(titles).toContain("Consumption");
    // The old name is gone: the projection lives inside consumption now.
    expect(titles).not.toContain("Projection");
});

test("the usage options appear only once a meter is picked", async ({ page }) => {
    const unmetered = {
        ...BOILER,
        consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 2 } },
    };

    await mountEditor(page, [unmetered]);
    expect(await fieldLabels(page)).not.toContain("Deferrable consumer");

    await mountEditor(page, [BOILER]);
    expect(await fieldLabels(page)).toContain("Deferrable consumer");
});

test("the EV charger gets a meter but no projection controls", async ({ page }) => {
    await mountEditor(page, [EV_CHARGER]);

    expect(await sectionTitles(page)).toContain("Consumption");
    const labels = await fieldLabels(page);
    expect(labels).toContain("Energy meter entity");
    expect(labels).not.toContain("Projection strategy");
});

test("the inverter is offered no Consumption section at all", async ({ page }) => {
    await mountEditor(page, [INVERTER]);

    expect(await sectionTitles(page)).not.toContain("Consumption");
});
