import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The polarity select on every power device's section.
 *
 * The backend can resolve a polarity it is never given, so what this pins is
 * the half only the editor can get wrong: that the control is *offered* on all
 * four devices, that each offers its own vocabulary rather than a shared
 * "inverted" toggle, and that picking an option writes it to the path the
 * backend validates. A field rendered under the wrong device, or writing to
 * `power_devices.<device>.power_polarity` instead of `...entities....`, would
 * look right on screen and be silently ignored by every consumer of it.
 *
 * The selects carry no path attribute, so they are identified here by the
 * vocabulary they offer — which is exactly the per-device wording under test.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const STORED_CONFIG = {
    config_version: 6,
    power_devices: {
        house: { entities: { power: "sensor.house_power" } },
        solar: { entities: { power: "sensor.solar_power" } },
        battery: { entities: { power: "sensor.battery_power" } },
        grid: { entities: { power: "sensor.grid_power" } },
    },
};

/** Each device's options, in the order the editor should offer them. */
const EXPECTED_OPTIONS: Record<string, string[]> = {
    solar: ["positive_is_production", "negative_is_production"],
    house: ["positive_is_consumption", "negative_is_consumption"],
    battery: ["positive_is_charging", "positive_is_discharging"],
    grid: ["positive_is_export", "positive_is_import"],
};

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate((config) => {
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        element.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            connection: { subscribeEvents: async () => () => undefined },
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
    }, STORED_CONFIG);

    // The power-device sections live behind their own tab, and each ships
    // collapsed; a collapsed <details> renders nothing to query.
    await expect
        .poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === "Power devices",
                );
                if (!tab) return false;
                tab.click();
                return true;
            }),
        )
        .toBe(true);

    await expect
        .poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const sections = Array.from(root?.querySelectorAll("details") ?? []);
                sections.forEach((section) => section.setAttribute("open", ""));
                return root?.querySelectorAll("select").length ?? 0;
            }),
        )
        .toBeGreaterThan(0);
}

/** Every polarity select the editor rendered, keyed by the device it belongs to. */
function readPolarityFields(page: Page): Promise<Record<string, string[]>> {
    return page.evaluate((expected) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const found: Record<string, string[]> = {};
        for (const select of Array.from(root?.querySelectorAll("select") ?? [])) {
            const values = Array.from(select.options)
                .map((option) => option.value)
                .filter((value) => value !== "");
            const device = Object.keys(expected).find((candidate) =>
                values.includes(expected[candidate][0]),
            );
            if (device) found[device] = values;
        }
        return found;
    }, EXPECTED_OPTIONS);
}

test("every power device offers a polarity select with its own vocabulary", async ({ page }) => {
    await mountEditor(page);
    const fields = await readPolarityFields(page);

    expect(Object.keys(fields).sort()).toEqual(["battery", "grid", "house", "solar"]);
    for (const [device, options] of Object.entries(EXPECTED_OPTIONS)) {
        expect(fields[device], `${device} options`).toEqual(options);
    }
});

test("the default option is listed first for every device", async ({ page }) => {
    await mountEditor(page);
    const fields = await readPolarityFields(page);
    // Leaving the field alone means today's convention, so the option a user
    // reads first has to be the one the backend already assumes.
    expect(fields.grid[0]).toBe("positive_is_export");
    expect(fields.battery[0]).toBe("positive_is_charging");
    expect(fields.house[0]).toBe("positive_is_consumption");
    expect(fields.solar[0]).toBe("positive_is_production");
});

test("nothing is preselected when the config omits the field", async ({ page }) => {
    await mountEditor(page);
    const selected = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll("select") ?? [])
            .filter((select) =>
                Array.from(select.options).some((option) =>
                    option.value.includes("positive_is") || option.value.includes("negative_is"),
                ),
            )
            .map((select) => select.value);
    });
    expect(selected).toEqual(["", "", "", ""]);
});

test("picking an option writes it under the device's entities map", async ({ page }) => {
    await mountEditor(page);

    await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const select = Array.from(root?.querySelectorAll("select") ?? []).find((element) =>
            Array.from(element.options).some((option) => option.value === "positive_is_export"),
        ) as HTMLSelectElement;
        select.value = "positive_is_import";
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });

    const entities = await page.evaluate(() => {
        const editor = document.querySelector("helman-config-editor-panel") as
            | (HTMLElement & { getValue?: (path: unknown[]) => unknown })
            | null;
        return editor?.getValue?.(["power_devices", "grid", "entities"]) ?? null;
    });

    expect(entities).toEqual({
        power: "sensor.grid_power",
        power_polarity: "positive_is_import",
    });
});
