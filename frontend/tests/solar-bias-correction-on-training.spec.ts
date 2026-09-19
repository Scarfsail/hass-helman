import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Solar bias correction is edited on the Training tab (issue #306).
 *
 * The whole block moved from Power devices -> Solar -> Forecast to the
 * Training tab's Solar bias panel, but only its sections moved: the fields
 * still write `power_devices.solar.forecast.bias_correction`, and no config
 * migration exists. So the round trip is the claim -- edit on Training, save,
 * and the document the backend receives has the values where they always were.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const CONFIG = {
    config_version: 14,
    power_devices: {
        solar: {
            entities: { power: "sensor.solar_power" },
            forecast: {
                total_energy_entity_id: "sensor.solar_energy",
                daily_energy_entity_ids: ["sensor.solar_day_0"],
                bias_correction: {
                    enabled: false,
                    clamp_min: 0.5,
                    total_energy_entity_id: "sensor.solar_bias_energy",
                    slot_invalidation: { max_battery_soc_percent: 90 },
                },
            },
        },
    },
    controllables: [],
    training: { solar_bias: { min_history_days: 10 } },
};

function job(id: string): Record<string, unknown> {
    return {
        id,
        enabled: true,
        health: "ok",
        lastOutcome: "profile_trained",
        errorReason: null,
        trainedAt: "2026-09-19T03:00:00+00:00",
        lastAttemptAt: "2026-09-19T03:00:00+00:00",
        artifactInUse: true,
        usingOlderArtifact: false,
        isStale: false,
        issues: [],
    };
}

const TRAINING_STATUS = {
    trainingTime: "03:00",
    nextScheduledTrainingAt: "2026-09-20T03:00:00+00:00",
    isRunning: false,
    currentJob: null,
    anyFailed: false,
    jobs: ["solar_bias", "house_consumption", "appliance_energy"].map(job),
};

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, trainingStatus }) => {
            // The editor will not enter YAML mode until ha-yaml-editor is
            // defined; a stub is enough, as in entities-only-toggle.spec.ts.
            if (!customElements.get("ha-yaml-editor")) {
                customElements.define("ha-yaml-editor", class extends HTMLElement {});
            }
            const w = window as any;
            w.__stored = JSON.parse(JSON.stringify(config));
            w.__saved = [];
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(w.__stored));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/inspect_entities") return { results: [] };
                    if (request.type === "helman/training/status") {
                        return JSON.parse(JSON.stringify(trainingStatus));
                    }
                    if (request.type === "helman/validate_config") {
                        return {
                            valid: false,
                            errors: [
                                {
                                    section: "power_devices",
                                    path: "power_devices.solar.forecast.bias_correction.clamp_min",
                                    code: "out_of_range",
                                    message: "clamp_min is out of range",
                                },
                            ],
                            warnings: [],
                        };
                    }
                    if (request.type === "helman/save_config") {
                        w.__saved.push(JSON.parse(JSON.stringify(request.config)));
                        w.__stored = JSON.parse(JSON.stringify(request.config));
                        return {
                            success: true,
                            validation: { valid: true, errors: [], warnings: [] },
                            reloadStarted: true,
                            reloadSucceeded: true,
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config: CONFIG, trainingStatus: TRAINING_STATUS },
    );

    await expect(page.locator(".tabs button").first()).toBeVisible();
}

async function openTab(page: Page, label: string): Promise<void> {
    await page.locator(".tabs button", { hasText: label }).click();
}

/** A section card, by the label in its own summary (not a nested one's). */
function section(page: Page, label: string) {
    return page.locator("details.section-card", {
        has: page.locator(":scope > summary .section-summary-label", {
            hasText: new RegExp(`^${label}$`),
        }),
    });
}

async function openSection(page: Page, label: string): Promise<void> {
    const card = section(page, label);
    await expect(card).toHaveCount(1);
    if (!(await card.evaluate((element) => (element as HTMLDetailsElement).open))) {
        await card.locator(":scope > summary .section-summary-label").click();
    }
    await expect(card).toHaveJSProperty("open", true);
}

/** The input of a labelled field, set the way the user commits a value. */
async function setNumber(page: Page, label: string, value: string): Promise<void> {
    const input = page
        .locator(".field", { has: page.locator("label", { hasText: label }) })
        .locator("input");
    await expect(input).toHaveCount(1);
    await input.evaluate((element, next) => {
        (element as HTMLInputElement).value = next;
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
}

test("bias correction edited on Training saves under power_devices", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Training");

    // The card right after the Solar bias panel, not inside it: that panel's
    // YAML view covers training.solar_bias only, so nesting would hide these
    // fields whenever it is switched to YAML.
    const solarBias = section(page, "Solar forecast correction");
    await expect(solarBias.locator("details.section-card", { hasText: "Bias Correction" })).toHaveCount(
        0,
    );
    await expect(section(page, "Bias Correction")).toHaveCount(1);
    await openSection(page, "Bias Correction");
    await openSection(page, "Configuration");
    await openSection(page, "Invalidate training slot data");

    // The note that says where these fields live in YAML.
    await expect(section(page, "Bias Correction")).toContainText(
        "power_devices.solar.forecast.bias_correction",
    );

    const enabled = section(page, "Configuration").locator(".toggle-field", {
        has: page.locator("ha-formfield"),
    });
    await expect(enabled).toHaveCount(1);
    // On a tab named Training the switch says it gates applying too.
    await expect(enabled.locator(".help-btn")).toHaveCount(1);
    await enabled.locator("ha-switch").evaluate((element) => {
        (element as HTMLElement & { checked: boolean }).checked = true;
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
    await setNumber(page, "Min forecast clamp", "0.2");
    await setNumber(page, "Max battery SoC %", "95");

    await page.locator("button", { hasText: "Save and reload" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__saved.length)).toBe(1);

    const saved = await page.evaluate(() => (window as any).__saved[0]);
    expect(saved.power_devices.solar.forecast.bias_correction).toEqual({
        enabled: true,
        clamp_min: 0.2,
        total_energy_entity_id: "sensor.solar_bias_energy",
        slot_invalidation: { max_battery_soc_percent: 95 },
    });
    // Nothing leaked into the subtree the Training tab otherwise owns.
    expect(saved.training).toEqual(CONFIG.training);
});

test("Power devices -> Solar holds only its entities and forecast sources", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Power devices");

    const solar = section(page, "Solar");
    const nested = await solar
        .locator("details.section-card .section-summary-label")
        .allTextContents();
    expect(nested.map((label) => label.trim())).toEqual(["General", "Forecast", "General"]);

    await expect(solar.locator("helman-bias-correction-status")).toHaveCount(0);
    await expect(solar.locator("helman-training-job-status")).toHaveCount(0);
    await expect(solar.locator("helman-solar-bias-diagnostics")).toHaveCount(0);

    // And the forecast section points to where correction went.
    await openSection(page, "Solar");
    await openSection(page, "Forecast");
    await expect(section(page, "Forecast").locator(":scope > .section-content > .inline-note")).toContainText(
        "Training tab",
    );
});

/** Switch a section card to YAML or back, with its own summary toggle. */
async function setMode(page: Page, label: string, mode: "YAML" | "Visual"): Promise<void> {
    await section(page, label)
        .locator(":scope > summary .mode-toggle button", { hasText: mode })
        .click();
}

test("bias correction is not editable on Training while Power devices holds it as YAML", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Power devices");
    await openSection(page, "Solar");
    await openSection(page, "Forecast");
    await setMode(page, "Forecast", "YAML");

    // The Forecast YAML editor holds a snapshot of bias_correction; an edit
    // made on Training now would be written away by its next keystroke.
    await openTab(page, "Training");
    const bias = section(page, "Bias Correction");
    await openSection(page, "Bias Correction");
    await expect(bias).toContainText("Open as YAML in Forecast");
    await expect(bias.locator("input, ha-switch")).toHaveCount(0);
    await expect(bias.locator(".mode-toggle")).toHaveCount(0);

    await openTab(page, "Power devices");
    await openSection(page, "Solar");
    await openSection(page, "Forecast");
    await setMode(page, "Forecast", "Visual");
    await openTab(page, "Training");
    await openSection(page, "Bias Correction");
    await openSection(page, "Configuration");
    await expect(section(page, "Bias Correction")).not.toContainText("Open as YAML in");
    await expect(section(page, "Configuration").locator("ha-switch")).toHaveCount(1);
});

test("switching the Solar bias panel to YAML leaves bias correction editable", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Training");
    await openSection(page, "Solar forecast correction");
    await setMode(page, "Solar forecast correction", "YAML");

    await openSection(page, "Bias Correction");
    await openSection(page, "Configuration");
    await expect(
        page.locator(".field", { has: page.locator("label", { hasText: "Min forecast clamp" }) }),
    ).toHaveCount(1);
});

test("a validation issue on a bias field counts on the Training tab", async ({ page }) => {
    await mountEditor(page);
    await page.locator("button", { hasText: "Validate" }).click();

    const tab = (label: string) => page.locator(".tabs button", { hasText: label });
    await expect(tab("Training").locator(".tab-count.errors")).toHaveText("1");
    await expect(tab("Power devices").locator(".tab-count")).toHaveCount(0);
});
