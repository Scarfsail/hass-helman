import { configDoc } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";
import { EDITOR_BUNDLE, loadBundle } from "./support/card-page";

/**
 * The backend's defaults, shown as placeholders on the fields that are unset.
 *
 * An optional field the user never touched used to render blank, however
 * loudly the backend was applying a default to it -- the config said nothing
 * and so did the form. The hint comes from `helman/get_config_defaults`, so
 * what this pins is the part only the editor can get wrong: that the default
 * lands in `placeholder` and not in `value`, that a field with a real value
 * keeps showing that value, and above all that saving a form full of
 * placeholders writes none of them. A placeholder promoted to a value would
 * freeze today's default into the document for good.
 *
 * Fields are found by their label, so the two chosen here are ones whose
 * wording is unique on the Data and learning tab -- the training-window labels are
 * deliberately shared between the solar bias and house consumption panels.
 */

/** One solar bias field set, its neighbours and the training time left unset. */
const STORED_CONFIG = configDoc({

    data_and_learning: {
        solar_bias: {
            clamp_max: 2.5,
        },
    },
});

/** What the backend serves for the paths this spec looks at. */
const CONFIG_DEFAULTS = {
    "data_and_learning.recent_power_history.sampling_interval_seconds": 5,
    "data_and_learning.recent_power_history.samples": 60,
    "data_and_learning.training_time": "03:00",
    "data_and_learning.solar_bias.clamp_min": 0.0,
    "data_and_learning.solar_bias.clamp_max": 3.0,
    "data_and_learning.solar_bias.enabled": true,
    "data_and_learning.solar_bias.aggregation_method": "ratio_of_sums",
};

const CLAMP_MIN_LABEL = "Min forecast clamp";
const CLAMP_MAX_LABEL = "Max forecast clamp";
const TRAINING_TIME_LABEL = "Training time (HH:MM)";
const ENABLED_LABEL = "Enable bias correction";
const AGGREGATION_LABEL = "Aggregation method";
const SAMPLING_INTERVAL_LABEL = "Sampling interval (seconds)";
const SAMPLES_LABEL = "Samples to keep";

async function mountEditor(page: Page, config: unknown = STORED_CONFIG, holdValidation = false): Promise<void> {
    await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);

    await page.evaluate(({ config, defaults, holdValidation }) => {
        const calls: { type: string; config?: unknown }[] = [];
        (window as unknown as Record<string, unknown>).__calls = calls;
        let releaseValidation: (() => void) | undefined;
        (window as unknown as Record<string, unknown>).__releaseValidation = () => releaseValidation?.();
        (window as unknown as Record<string, unknown>).__validationResolved = false;
        const warningsFor = (submitted: unknown) => {
            const bias = (submitted as { data_and_learning?: { solar_bias?: Record<string, unknown> } })
                ?.data_and_learning?.solar_bias;
            return bias && "clamp_mx" in bias
                ? [{ section: "data_and_learning", path: "data_and_learning.solar_bias.clamp_mx",
                     code: "unknown_key", message: "unrecognized key" }]
                : [];
        };
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        element.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            connection: window.__mockHass().connection,
            callWS: window.__mockHass({
                "helman/get_config": async (request: {
                    type: string;
                    config?: unknown;
                }) => {
                    return JSON.parse(JSON.stringify(config));
                },
                "helman/get_config_defaults": async (request: {
                    type: string;
                    config?: unknown;
                }) => {
                    return JSON.parse(JSON.stringify(defaults));
                },
                "helman/get_optimizer_schema": async (request: {
                    type: string;
                    config?: unknown;
                }) => {
                    return { version: 19, kinds: [] };
                },
                "helman/validate_config": async (request: {
                    type: string;
                    config?: unknown;
                }) => {
                    if (holdValidation) await new Promise<void>((resolve) => { releaseValidation = resolve; });
                    (window as unknown as Record<string, unknown>).__validationResolved = true;
                    return { valid: true, errors: [], warnings: warningsFor(request.config) };
                },
                "helman/save_config": async (request: {
                    type: string;
                    config?: unknown;
                }) => {
                    return { success: true, validation: { valid: true, errors: [], warnings: warningsFor(request.config) }, reloadStarted: false };
                }
            }, (request: {
                type: string;
                config?: unknown;
            }) => {
                calls.push({ type: request.type, config: request.config });
            }).callWS,
        };
        document.body.appendChild(element);
    }, { config: JSON.parse(JSON.stringify(config)), defaults: CONFIG_DEFAULTS, holdValidation });

    // The Data and learning tab's panels ship collapsed, and a collapsed <details>
    // renders nothing to query.
    await expect
        .poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim().startsWith("Data and learning"),
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
                return root?.querySelectorAll("input").length ?? 0;
            }),
        )
        .toBeGreaterThan(0);
}

/** The value and placeholder of the input under a given field label. */
function readField(
    page: Page,
    label: string,
): Promise<{ value: string; placeholder: string } | null> {
    return page.evaluate((fieldLabel) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        for (const field of Array.from(root?.querySelectorAll(".field") ?? [])) {
            if (field.querySelector("label")?.textContent?.trim() !== fieldLabel) continue;
            const input = field.querySelector("input");
            if (!input) continue;
            return { value: input.value, placeholder: input.placeholder };
        }
        return null;
    }, label);
}

function savedConfigs(page: Page): Promise<unknown[]> {
    return page.evaluate(() =>
        ((window as unknown as Record<string, unknown>).__calls as {
            type: string;
            config?: unknown;
        }[])
            .filter((call) => call.type === "helman/save_config")
            .map((call) => call.config),
    );
}

test("an unset field shows the backend default as a placeholder, not a value", async ({ page }) => {
    await mountEditor(page);

    expect(await readField(page, CLAMP_MIN_LABEL)).toEqual({ value: "", placeholder: "0" });
    expect(await readField(page, TRAINING_TIME_LABEL)).toEqual({
        value: "",
        placeholder: "03:00",
    });
});

test("a checkbox and a select stand on the backend default while unset", async ({ page }) => {
    // Neither control can show a placeholder: it renders some state either
    // way. Drawn from an empty value, the switch would say the correction is
    // off while the backend has it running.
    await mountEditor(page);

    const state = await page.evaluate(
        (labels) => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const find = (label: string) =>
                Array.from(root?.querySelectorAll(".field") ?? []).find(
                    (field) => field.querySelector("label")?.textContent?.trim() === label,
                );
            // The switch is an ha-formfield/ha-switch pair, labelled by a
            // property rather than by a <label> of its own.
            const toggle = Array.from(root?.querySelectorAll("ha-formfield") ?? []).find(
                (formfield) => (formfield as HTMLElement & { label?: string }).label === labels.enabled,
            );
            return {
                checked:
                    (toggle?.querySelector("ha-switch") as (HTMLElement & { checked?: boolean }) | null)
                        ?.checked ?? null,
                selected: find(labels.aggregation)?.querySelector("select")?.value ?? null,
            };
        },
        { enabled: ENABLED_LABEL, aggregation: AGGREGATION_LABEL },
    );
    expect(state).toEqual({ checked: true, selected: "ratio_of_sums" });
});

test("a field with a stored value shows that value", async ({ page }) => {
    await mountEditor(page);

    expect((await readField(page, CLAMP_MAX_LABEL))?.value).toBe("2.5");
});

test("saving writes no placeholder into the document", async ({ page }) => {
    await mountEditor(page);

    await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const save = Array.from(root?.querySelectorAll("button") ?? []).find(
            (button) => button.textContent?.trim() === "Save and reload",
        );
        save?.click();
    });

    await expect.poll(async () => (await savedConfigs(page)).length).toBe(1);
    const saved = (await savedConfigs(page))[0] as {
        data_and_learning?: { training_time?: unknown; solar_bias?: Record<string, unknown> };
    };
    expect(saved.data_and_learning?.training_time).toBeUndefined();
    expect(saved.data_and_learning?.solar_bias).toEqual({ clamp_max: 2.5 });
    expect(saved).not.toHaveProperty("energy_nodes");
    expect(saved).not.toHaveProperty("devices");
    expect(saved).not.toHaveProperty("automation");
});

/** The recent power history duration line, or null when none is shown. */
function readDuration(page: Page): Promise<string | null> {
    return page.evaluate(() =>
        document.querySelector("helman-config-editor-panel")?.shadowRoot
            ?.querySelector(".recent-power-history-duration")?.textContent?.trim() ?? null,
    );
}

/** Type a value into the input under a field label and commit it. */
async function fillField(page: Page, label: string, value: string): Promise<void> {
    await page.evaluate(({ label, value }) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const field = Array.from(root?.querySelectorAll(".field") ?? []).find(
            (candidate) => candidate.querySelector("label")?.textContent?.trim() === label,
        );
        const input = field?.querySelector("input") as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("change"));
    }, { label, value });
}

test("recent power history shows its defaults as placeholders without writing them", async ({ page }) => {
    await mountEditor(page);

    expect(await readField(page, SAMPLING_INTERVAL_LABEL)).toEqual({ value: "", placeholder: "5" });
    expect(await readField(page, SAMPLES_LABEL)).toEqual({ value: "", placeholder: "60" });
    expect(await readDuration(page)).toBe("Keeps the most recent 5 minutes of power readings.");

    await page.locator("helman-config-editor-panel").getByRole("button", { name: "Save and reload" }).click();
    await expect.poll(async () => (await savedConfigs(page)).length).toBe(1);
    expect((await savedConfigs(page))[0]).not.toHaveProperty("data_and_learning.recent_power_history");
});

test("the recent power history duration follows the draft", async ({ page }) => {
    await mountEditor(page);

    await fillField(page, SAMPLES_LABEL, "6");
    await expect.poll(() => readDuration(page)).toBe("Keeps the most recent 30 seconds of power readings.");
    await fillField(page, SAMPLES_LABEL, "30");
    await expect.poll(() => readDuration(page)).toBe("Keeps the most recent 2 min 30 s of power readings.");
    await fillField(page, SAMPLING_INTERVAL_LABEL, "10");
    await expect.poll(() => readDuration(page)).toBe("Keeps the most recent 5 minutes of power readings.");
    await fillField(page, SAMPLING_INTERVAL_LABEL, "5");
    await fillField(page, SAMPLES_LABEL, "720");
    await expect.poll(() => readDuration(page)).toBe("Keeps the most recent 1 hour of power readings.");
    await fillField(page, SAMPLES_LABEL, "1080");
    await expect.poll(() => readDuration(page)).toBe("Keeps the most recent 1 h 30 min of power readings.");
    await fillField(page, SAMPLES_LABEL, "30");
    await fillField(page, SAMPLING_INTERVAL_LABEL, "10");
    await fillField(page, SAMPLING_INTERVAL_LABEL, "0");
    await expect.poll(() => readDuration(page)).toBeNull();
    await fillField(page, SAMPLING_INTERVAL_LABEL, "");
    await expect.poll(() => readDuration(page)).toBe("Keeps the most recent 2 min 30 s of power readings.");
});

test("loaded unknown keys appear as warnings and clear on an edit", async ({ page }) => {
    await mountEditor(page, configDoc({ data_and_learning: { solar_bias: { clamp_mx: 2 } } }));
    await expect.poll(async () => page.evaluate(() =>
        document.querySelector("helman-config-editor-panel")?.shadowRoot
            ?.querySelector(".issue-path")?.textContent?.trim(),
    )).toBe("data_and_learning.solar_bias.clamp_mx");
    await page.locator("helman-config-editor-panel").getByRole("button", { name: "Validate" }).click();
    await expect.poll(async () => page.evaluate(() =>
        document.querySelector("helman-config-editor-panel")?.shadowRoot
            ?.querySelector(".issue-path")?.textContent?.trim(),
    )).toBe("data_and_learning.solar_bias.clamp_mx");
    await page.locator("helman-config-editor-panel").getByRole("button", { name: "Save and reload" }).click();
    await expect.poll(async () => (await savedConfigs(page)).length).toBe(1);
    await expect.poll(async () => page.evaluate(() =>
        document.querySelector("helman-config-editor-panel")?.shadowRoot
            ?.querySelector(".issue-path")?.textContent?.trim(),
    )).toBe("data_and_learning.solar_bias.clamp_mx");
    await page.evaluate(() => {
        const panel = document.querySelector("helman-config-editor-panel") as HTMLElement & {
            setValue: (path: string[], value: unknown) => void;
        };
        panel.setValue(["data_and_learning", "solar_bias", "clamp_min"], 0.5);
    });
    await expect.poll(async () => page.evaluate(() =>
        document.querySelector("helman-config-editor-panel")?.shadowRoot
            ?.querySelector(".issue-board") === null,
    )).toBe(true);
});

test("a late load warning cannot replace validation for a newer draft", async ({ page }) => {
    await mountEditor(page, configDoc({ data_and_learning: { solar_bias: { clamp_mx: 2 } } }), true);
    await page.evaluate(() => {
        const panel = document.querySelector("helman-config-editor-panel") as HTMLElement & {
            setValue: (path: string[], value: unknown) => void;
        };
        panel.setValue(["data_and_learning", "solar_bias", "clamp_min"], 0.5);
        ((window as unknown as Record<string, unknown>).__releaseValidation as () => void)();
    });
    await expect.poll(async () => page.evaluate(() =>
        (window as unknown as Record<string, unknown>).__validationResolved,
    )).toBe(true);
    await expect.poll(async () => page.evaluate(() =>
        document.querySelector("helman-config-editor-panel")?.shadowRoot
            ?.querySelector(".issue-board") === null,
    )).toBe(true);
});

test("an explicit zero stays visible as a stored recent power history value", async ({ page }) => {
    await mountEditor(page, configDoc({ data_and_learning: { recent_power_history: { samples: 0 } } }));

    expect(await readField(page, SAMPLES_LABEL)).toEqual({ value: "0", placeholder: "60" });
    expect(await readDuration(page)).toBeNull();
});
