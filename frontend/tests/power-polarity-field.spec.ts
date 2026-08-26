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
 * vocabulary they offer -- which is exactly the per-device wording under test.
 *
 * The last test is not about polarity: it guards the option-label lookup these
 * fields share with the aggregation-method select, which had the same bug.
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

/** The power-devices tab's label per locale -- the tab strip is localized too. */
const POWER_DEVICES_TAB: Record<string, string> = {
    en: "Power devices",
    cs: "Výkonová zařízení",
};

async function mountEditor(page: Page, language = "en"): Promise<void> {
    return mountEditorWith(page, STORED_CONFIG, language);
}

async function mountEditorWith(
    page: Page,
    config: unknown,
    language = "en",
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(({ config, language }) => {
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        element.hass = {
            language,
            locale: { language },
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
    }, { config, language });

    // The power-device sections live behind their own tab, and each ships
    // collapsed; a collapsed <details> renders nothing to query.
    await expect
        .poll(async () =>
            page.evaluate((tabLabel) => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === tabLabel,
                );
                if (!tab) return false;
                tab.click();
                return true;
            }, POWER_DEVICES_TAB[language]),
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

/** What each polarity select currently shows, keyed by device. */
function readSelectedValues(page: Page, expected: Record<string, string[]>) {
    return page.evaluate((options) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const found: Record<string, string> = {};
        for (const select of Array.from(root?.querySelectorAll("select") ?? [])) {
            const device = Object.keys(options).find((candidate) =>
                Array.from(select.options).some(
                    (option) => option.value === options[candidate][0],
                ),
            );
            if (device) found[device] = select.value;
        }
        return found;
    }, expected);
}

test("an unset field shows the default rather than blank", async ({ page }) => {
    // A polarity is always in force, so a blank select would hide which one.
    // The config stays untouched — this is a display fallback, not a write.
    await mountEditor(page);
    expect(await readSelectedValues(page, EXPECTED_OPTIONS)).toEqual({
        solar: "positive_is_production",
        house: "positive_is_consumption",
        battery: "positive_is_charging",
        grid: "positive_is_export",
    });

    const stored = await page.evaluate(() => {
        const editor = document.querySelector("helman-config-editor-panel") as
            | (HTMLElement & { getValue?: (path: unknown[]) => unknown })
            | null;
        return editor?.getValue?.(["power_devices", "grid", "entities"]) ?? null;
    });
    expect(stored).toEqual({ power: "sensor.grid_power" });
});

test("there is no blank option to select", async ({ page }) => {
    await mountEditor(page);
    const blanks = await page.evaluate((options) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll("select") ?? [])
            .filter((select) =>
                Array.from(select.options).some(
                    (option) => option.value === options.grid[0],
                ),
            )
            .map((select) => Array.from(select.options).filter((o) => o.value === "").length);
    }, EXPECTED_OPTIONS);
    expect(blanks).toEqual([0]);
});

test("a configured value still wins over the default", async ({ page }) => {
    await mountEditorWith(page, {
        config_version: 6,
        power_devices: {
            grid: {
                entities: {
                    power: "sensor.grid_power",
                    power_polarity: "positive_is_import",
                },
            },
        },
    });
    const root = await readSelectedValues(page, { grid: EXPECTED_OPTIONS.grid });
    expect(root.grid).toBe("positive_is_import");
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

/** The rendered option text of one device's select, in order. */
function readOptionLabels(page: Page, firstValue: string): Promise<string[]> {
    return page.evaluate((value) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const select = Array.from(root?.querySelectorAll("select") ?? []).find((element) =>
            Array.from(element.options).some((option) => option.value === value),
        );
        return Array.from(select?.options ?? [])
            .filter((option) => option.value !== "")
            .map((option) => option.textContent?.trim() ?? "");
    }, firstValue);
}

test("option labels are localized, not left in English", async ({ page }) => {
    // Regression: these were looked up through hass.localize, which resolves
    // against the integration's backend strings. Those carry no editor keys, so
    // every locale silently rendered the English fallback.
    await mountEditor(page, "cs");
    expect(await readOptionLabels(page, "positive_is_charging")).toEqual([
        "Kladná = nabíjení",
        "Kladná = vybíjení",
    ]);
    expect(await readOptionLabels(page, "positive_is_export")).toEqual([
        "Kladná = dodávka do sítě",
        "Kladná = odběr ze sítě",
    ]);
});

test("every option states which sign carries the quantity", async ({ page }) => {
    // The field asks which convention the sensor follows, so a bare noun would
    // contradict it: "Sign convention -> Consumption" says nothing about sign,
    // and an option reading "Consumption (negative readings)" under a label
    // asserting the value is positive is a self-contradiction.
    await mountEditor(page);
    expect(await readOptionLabels(page, "positive_is_consumption")).toEqual([
        "Positive = consumption",
        "Negative = consumption",
    ]);
    expect(await readOptionLabels(page, "positive_is_production")).toEqual([
        "Positive = production",
        "Negative = production",
    ]);
});

test("a value from another device's vocabulary shows the default", async ({ page }) => {
    // An easy copy-paste slip, since the docs put the grid and battery YAML
    // blocks next to each other. The backend resolves an unrecognised value to
    // the default, so the default is genuinely what is in force -- showing it
    // makes the field agree with the runtime instead of rendering blank.
    // Validation still reports the bad value on save.
    await mountEditorWith(page, {
        config_version: 6,
        power_devices: {
            grid: {
                entities: {
                    power: "sensor.grid_power",
                    power_polarity: "positive_is_charging",
                },
            },
        },
    });
    const shown = await readSelectedValues(page, { grid: EXPECTED_OPTIONS.grid });
    expect(shown.grid).toBe("positive_is_export");

    // Displayed only: the bad value is still in the document for validation to
    // catch, not quietly rewritten underneath the user.
    const stored = await page.evaluate(() => {
        const editor = document.querySelector("helman-config-editor-panel") as
            | (HTMLElement & { getValue?: (path: unknown[]) => unknown })
            | null;
        return editor?.getValue?.([
            "power_devices", "grid", "entities", "power_polarity",
        ]);
    });
    expect(stored).toBe("positive_is_charging");
});

test("the aggregation-method select is localized too", async ({ page }) => {
    // Same root cause, same file: its Czech strings had been written all along
    // and never rendered, because the lookup went to the backend namespace.
    await mountEditor(page, "cs");
    const labels = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const select = Array.from(root?.querySelectorAll("select") ?? []).find((element) =>
            Array.from(element.options).some((option) => option.value === "ratio_of_sums"),
        );
        return Array.from(select?.options ?? [])
            .filter((option) => option.value !== "")
            .map((option) => option.textContent?.trim() ?? "");
    });
    expect(labels).toEqual([
        "Poměr součtů (Ratio of Sums)",
        "Oříznutý průměr (Trimmed Mean)",
    ]);
});
