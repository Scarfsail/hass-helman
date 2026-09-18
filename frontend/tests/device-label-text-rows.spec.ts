import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Badge texts, one label per row.
 *
 * `device_label_text` maps a Home Assistant *label name* to the badge a device
 * carrying it shows -- `_apply_label_badge_texts` matches the config's keys
 * against the device's labels by name. The editor used to ask the reader to
 * type that name into a free-text field inside a card of its own, which is both
 * three rows per badge and a name that is right only if it is spelled exactly
 * as Home Assistant has it. So the key is a picker over the label registry, and
 * the row is one line.
 *
 * What the tests below pin is the part that would silently lose data if it
 * regressed: a key the registry does not have is still offered and still
 * selected, and a registry that cannot be read leaves the free-text input
 * rather than a picker with nothing in it.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const LABELS = [
    { label_id: "kitchen", name: "Kitchen" },
    { label_id: "bathroom", name: "Bathroom" },
    { label_id: "garage", name: "Garage" },
];

declare global {
    interface Window {
        __editorConfig: () => unknown;
    }
}

async function mountEditor(
    page: Page,
    options: {
        deviceLabelText: Record<string, Record<string, string>>;
        labels?: unknown;
    },
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, labels }) => {
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
                    if (request.type === "config/label_registry/list") {
                        if (labels === "unavailable") {
                            throw new Error("not supported");
                        }
                        return labels;
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config: { config_version: 7, device_label_text: options.deviceLabelText },
            labels: options.labels === undefined ? LABELS : options.labels,
        },
    );

    await expect.poll(() => rowCount(page)).toBeGreaterThan(0);
}

function shadow(page: Page) {
    return page.locator("helman-config-editor-panel");
}

function rowCount(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll(".label-entry-row:not(.label-entry-head)")
                .length ?? 0,
    );
}

/** The options of every label picker, in row order. */
function pickerOptions(page: Page): Promise<string[][]> {
    return page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("select.label-key-picker") ?? [],
        ).map((picker) =>
            Array.from((picker as HTMLSelectElement).options).map(
                (option) => option.textContent?.trim() ?? "",
            ),
        ),
    );
}

test("a badge text is one row: the label, its text, and remove", async ({ page }) => {
    await mountEditor(page, {
        deviceLabelText: { Room: { Kitchen: "🍳", Bathroom: "🛁" } },
    });

    expect(await rowCount(page)).toBe(2);
    // Everything the row holds is in the row -- no card, no nested field grid.
    const parts = await page.evaluate(() =>
        Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll(".label-entry-row:not(.label-entry-head)") ?? [],
        ).map((row) => ({
            pickers: row.querySelectorAll("select.label-key-picker").length,
            texts: row.querySelectorAll("input.badge-text-input").length,
            removes: row.querySelectorAll("button.remove-label-entry").length,
        })),
    );
    expect(parts).toEqual([
        { pickers: 1, texts: 1, removes: 1 },
        { pickers: 1, texts: 1, removes: 1 },
    ]);
});

test("the label is picked from Home Assistant's labels", async ({ page }) => {
    await mountEditor(page, { deviceLabelText: { Room: { Kitchen: "🍳" } } });

    // Every label except the ones the category's other rows already took.
    expect(await pickerOptions(page)).toEqual([
        ["Select label", "Bathroom", "Garage", "Kitchen"],
    ]);

    await shadow(page).locator("select.label-key-picker").selectOption("Garage");
    expect(await page.evaluate(() => window.__editorConfig())).toMatchObject({
        device_label_text: { Room: { Garage: "🍳" } },
    });
});

test("a key Home Assistant no longer has is offered, not dropped", async ({ page }) => {
    // Renaming it away would rewrite the reader's config behind their back; a
    // picker that just showed blank would hide what the document still says.
    await mountEditor(page, { deviceLabelText: { Room: { Cellar: "🕯️" } } });

    expect(await pickerOptions(page)).toEqual([
        [
            "Select label",
            "Cellar (not a Home Assistant label)",
            "Bathroom",
            "Garage",
            "Kitchen",
        ],
    ]);
    await expect(shadow(page).locator("select.label-key-picker")).toHaveValue("Cellar");
});

test("a registry that cannot be read leaves the key editable as text", async ({ page }) => {
    await mountEditor(page, {
        deviceLabelText: { Room: { Kitchen: "🍳" } },
        labels: "unavailable",
    });

    await expect(shadow(page).locator("select.label-key-picker")).toHaveCount(0);
    await expect(shadow(page).locator("input.label-key-input")).toHaveValue("Kitchen");
});

test("a Home Assistant with no labels leaves the key editable as text", async ({ page }) => {
    // The picker would hold nothing but the key already stored, so it could
    // only take editing away -- an instance that has not used labels yet is
    // exactly where the config is typed by hand.
    await mountEditor(page, { deviceLabelText: { Room: { Kitchen: "🍳" } }, labels: [] });

    await expect(shadow(page).locator("select.label-key-picker")).toHaveCount(0);
    await expect(shadow(page).locator("input.label-key-input")).toHaveValue("Kitchen");
});

test("an added row starts on a label that exists", async ({ page }) => {
    await mountEditor(page, { deviceLabelText: { Room: { Kitchen: "🍳" } } });

    await shadow(page)
        .locator(".section-footer .add-button", { hasText: "Add badge text" })
        .first()
        .click();

    await expect.poll(() => rowCount(page)).toBe(2);
    expect(await page.evaluate(() => window.__editorConfig())).toMatchObject({
        device_label_text: { Room: { Kitchen: "🍳", Bathroom: "" } },
    });
});


