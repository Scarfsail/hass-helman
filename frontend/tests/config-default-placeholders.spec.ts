import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

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
 * wording is unique on the Training tab -- the training-window labels are
 * deliberately shared between the solar bias and house consumption panels.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** One solar bias field set, its neighbours and the training time left unset. */
const STORED_CONFIG = {
    config_version: 19,
    training: {
        solar_bias: {
            clamp_max: 2.5,
        },
    },
};

/** What the backend serves for the paths this spec looks at. */
const CONFIG_DEFAULTS = {
    "training.training_time": "03:00",
    "training.solar_bias.clamp_min": 0.0,
    "training.solar_bias.clamp_max": 3.0,
    "training.solar_bias.enabled": true,
    "training.solar_bias.aggregation_method": "ratio_of_sums",
};

const CLAMP_MIN_LABEL = "Min forecast clamp";
const CLAMP_MAX_LABEL = "Max forecast clamp";
const TRAINING_TIME_LABEL = "Training time (HH:MM)";
const ENABLED_LABEL = "Enable bias correction";
const AGGREGATION_LABEL = "Aggregation method";

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(({ config, defaults }) => {
        const calls: { type: string; config?: unknown }[] = [];
        (window as unknown as Record<string, unknown>).__calls = calls;
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        element.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            connection: { subscribeMessage: async () => () => undefined },
            callWS: async (request: { type: string; config?: unknown }) => {
                calls.push({ type: request.type, config: request.config });
                if (request.type === "helman/get_config") {
                    return JSON.parse(JSON.stringify(config));
                }
                if (request.type === "helman/get_config_defaults") {
                    return JSON.parse(JSON.stringify(defaults));
                }
                if (request.type === "helman/get_optimizer_schema") {
                    return { version: 19, kinds: [] };
                }
                if (request.type === "helman/get_appliances") return { appliances: [] };
                if (request.type === "helman/save_config") {
                    return { success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: false };
                }
                return {};
            },
        };
        document.body.appendChild(element);
    }, { config: STORED_CONFIG, defaults: CONFIG_DEFAULTS });

    // The Training tab's panels ship collapsed, and a collapsed <details>
    // renders nothing to query.
    await expect
        .poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === "Training",
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
        training?: { training_time?: unknown; solar_bias?: Record<string, unknown> };
    };
    expect(saved.training?.training_time).toBeUndefined();
    expect(saved.training?.solar_bias).toEqual({ clamp_max: 2.5 });
});
