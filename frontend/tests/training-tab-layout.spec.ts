import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The Training tab's one panel shape (issue #313).
 *
 * Every job panel reads, in order: the explanation, the status, a collapsed
 * Configuration scope and a collapsed Diagnostics panel. Health shows once,
 * in the panel header; a YAML toggle only where there is config; and the
 * Diagnostics header warns when something inside needs attention.
 *
 * The fixture gives each job a different reason to warn or not: solar has
 * issues, appliance energy has only a short depth row (its meter is 10 days
 * deep against a 21-day lookback), house consumption has neither.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const DISHWASHER_METER_KEY = "devices.0.consumption.energy_entity_id";

const CONFIG = {
    config_version: 19,
    power_devices: {
        house: { forecast: { total_energy_entity_id: "sensor.house_energy" } },
    },
    devices: [
        {
            id: "dishwasher",
            name: "Dishwasher",
            schedulable: true,
            consumption: {
                energy_entity_id: "sensor.dishwasher_energy",
                projection: { strategy: "history_average", lookback_days: 21 },
            },
        },
    ],
    training: {
        solar_bias: { total_energy_entity_id: "sensor.solar_bias_energy" },
    },
};

function job(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        ...overrides,
    };
}

const TRAINING_STATUS = {
    trainingTime: "03:00",
    nextScheduledTrainingAt: "2026-09-20T03:00:00+00:00",
    isRunning: false,
    currentJob: null,
    anyFailed: true,
    jobs: [
        job("solar_bias", {
            health: "failed",
            enabled: false,
            issues: [{ subject: "2026-09-15", reason: "day_ratio_out_of_band" }],
        }),
        job("house_consumption"),
        job("appliance_energy"),
    ],
};

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, trainingStatus, shortKey }) => {
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
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/training/status") {
                        return JSON.parse(JSON.stringify(trainingStatus));
                    }
                    if (request.type === "helman/inspect_entities") {
                        // Only the dishwasher meter is measured. The house
                        // table judges it by the backend's severity (ok); the
                        // appliance table by its own 21-day lookback (short).
                        return {
                            results: (request.targets ?? [])
                                .filter((target: any) => target.key === shortKey)
                                .map((target: any) => ({
                                    key: target.key,
                                    draft: {
                                        entityId: "sensor.dishwasher_energy",
                                        status: "ok",
                                        facts: [
                                            {
                                                id: "history",
                                                token: "history_depth",
                                                params: { available: 10, raw_states: 10, statistics: 10 },
                                                severity: "ok",
                                            },
                                        ],
                                        dependsOn: [],
                                    },
                                    saved: null,
                                })),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config: CONFIG, trainingStatus: TRAINING_STATUS, shortKey: DISHWASHER_METER_KEY },
    );

    await expect(page.locator(".tabs button").first()).toBeVisible();
    await page.locator(".tabs button", { hasText: "Training" }).click();
    await expect(page.locator("helman-training-job-status")).toHaveCount(3);
}

/** A top-level panel, by the label in its own summary. */
function parentPanel(page: Page, label: string) {
    return page.locator(".tab-scope details.section-card", {
        has: page.locator(":scope > summary .section-summary-label", {
            hasText: new RegExp(`^${label}$`),
        }),
    });
}

/** A direct sub-panel of `parent`, by the label in its own summary. */
function subPanel(page: Page, parent: string, label: string) {
    return parentPanel(page, parent).locator(":scope > .section-content > details.section-card", {
        has: page.locator(":scope > summary .section-summary-label", {
            hasText: new RegExp(`^${label}$`),
        }),
    });
}

const JOB_PANELS = {
    solar_bias: "Solar forecast correction",
    house_consumption: "House consumption forecast",
    appliance_energy: "Appliance energy",
} as const;

/** The direct children of a panel's content, as tag or `label (open|closed)`. */
function childOrder(page: Page, parent: string): Promise<string[]> {
    return parentPanel(page, parent)
        .locator(":scope > .section-content")
        .evaluate((content) =>
            Array.from(content.children).map((child) => {
                if (child.tagName !== "DETAILS") return child.tagName.toLowerCase();
                const label = child
                    .querySelector(":scope > summary .section-summary-label")
                    ?.textContent?.trim();
                return `${label} (${(child as HTMLDetailsElement).open ? "open" : "closed"})`;
            }),
        );
}

test("(a) each job panel is explanation, status, Configuration, Diagnostics", async ({
    page,
}) => {
    await mountEditor(page);

    for (const label of [JOB_PANELS.solar_bias, JOB_PANELS.house_consumption]) {
        expect(await childOrder(page, label)).toEqual([
            "helman-info-callout",
            "helman-training-job-status",
            "Configuration (closed)",
            "Diagnostics (closed)",
        ]);
    }
    // No global settings, so no Configuration part at all.
    expect(await childOrder(page, JOB_PANELS.appliance_energy)).toEqual([
        "helman-info-callout",
        "helman-training-job-status",
        "Diagnostics (closed)",
    ]);
    // The parents themselves start open: the state is the point of the tab.
    for (const label of Object.values(JOB_PANELS)) {
        await expect(parentPanel(page, label)).toHaveJSProperty("open", true);
    }
});

test("(b) a YAML toggle only on Configuration scopes", async ({ page }) => {
    await mountEditor(page);

    for (const label of [...Object.values(JOB_PANELS), "Training settings"]) {
        await expect(parentPanel(page, label)).toHaveCount(1);
        await expect(parentPanel(page, label).locator(":scope > summary .mode-toggle")).toHaveCount(0);
    }
    for (const label of Object.values(JOB_PANELS)) {
        const diagnostics = subPanel(page, label, "Diagnostics");
        await expect(diagnostics).toHaveCount(1);
        await expect(diagnostics.locator(":scope > summary .mode-toggle")).toHaveCount(0);
    }
    for (const label of [JOB_PANELS.solar_bias, JOB_PANELS.house_consumption, "Training settings"]) {
        const configuration = subPanel(page, label, "Configuration");
        await expect(configuration).toHaveCount(1);
        await expect(configuration.locator(":scope > summary .mode-toggle")).toHaveCount(1);
    }
});

test("(c) the header chip shows health with its scoped styles applied", async ({ page }) => {
    await mountEditor(page);

    const badge = (label: string) =>
        parentPanel(page, label).locator(":scope > summary helman-training-health-badge .badge");
    await expect(badge(JOB_PANELS.solar_bias)).toHaveText("Failed · Disabled");
    await expect(badge(JOB_PANELS.house_consumption)).toHaveText("OK");

    const background = (label: string) =>
        badge(label).evaluate((element) => getComputedStyle(element).backgroundColor);
    const failed = await background(JOB_PANELS.solar_bias);
    const ok = await background(JOB_PANELS.house_consumption);
    expect(failed).not.toBe("rgba(0, 0, 0, 0)");
    expect(ok).not.toBe("rgba(0, 0, 0, 0)");
    expect(failed).not.toBe(ok);
});

test("(d) the status block carries neither health nor issues", async ({ page }) => {
    await mountEditor(page);

    const status = page.locator('helman-training-job-status[data-job="solar_bias"]');
    await expect(status.locator(".status-row")).not.toHaveCount(0);
    await expect(status.locator(".status-label", { hasText: "Health" })).toHaveCount(0);
    await expect(status.locator(".badge")).toHaveCount(0);
    await expect(status.locator(".issues")).toHaveCount(0);
});

test("(e) Diagnostics warns on issues or a short row, and lists issues styled", async ({
    page,
}) => {
    await mountEditor(page);

    const warning = (label: string) =>
        subPanel(page, label, "Diagnostics").locator(":scope > summary .training-attention");
    // Issues alone.
    await expect(warning(JOB_PANELS.solar_bias)).toHaveCount(1);
    await expect(warning(JOB_PANELS.solar_bias)).toHaveAttribute(
        "aria-label",
        "Something here needs attention",
    );
    // A short depth row alone -- which also proves the inspection has landed.
    await expect(warning(JOB_PANELS.appliance_energy)).toHaveCount(1);
    await expect(
        subPanel(page, JOB_PANELS.appliance_energy, "Diagnostics").locator("tr.training-depth-warn"),
    ).toHaveCount(1);
    // Neither.
    await expect(warning(JOB_PANELS.house_consumption)).toHaveCount(0);

    const issues = subPanel(page, JOB_PANELS.solar_bias, "Diagnostics").locator(
        "helman-training-issues ul.issues",
    );
    await expect(issues.locator("li")).toHaveText(["2026-09-15: day_ratio_out_of_band"]);
    const style = await issues.evaluate((element) => {
        const computed = getComputedStyle(element);
        return { paddingLeft: computed.paddingLeft, margin: computed.marginTop };
    });
    expect(style).toEqual({ paddingLeft: "20px", margin: "0px" });
});

test("(f) the explanation is clamped until Show more", async ({ page }) => {
    await mountEditor(page);

    const callout = parentPanel(page, JOB_PANELS.solar_bias).locator(
        ":scope > .section-content > helman-info-callout",
    );
    const text = callout.locator(".text");
    const overflow = () =>
        text.evaluate((element) => element.scrollHeight - element.clientHeight);

    await expect(text).toHaveClass(/clamped/);
    expect(await overflow()).toBeGreaterThan(1);
    const toggle = callout.locator("button.toggle");
    await expect(toggle).toHaveText("Show more");

    await toggle.click();
    await expect(text).not.toHaveClass(/clamped/);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await expect(toggle).toHaveText("Show less");

    await toggle.click();
    await expect(text).toHaveClass(/clamped/);
    await expect(toggle).toHaveText("Show more");
});

test("(f) a short explanation gets no toggle", async ({ page }) => {
    await mountEditor(page);

    const callout = parentPanel(page, JOB_PANELS.solar_bias).locator(
        ":scope > .section-content > helman-info-callout",
    );
    await callout.evaluate((element) => {
        (element as any).text = "Short.";
    });
    await expect(callout.locator(".text")).toHaveText("Short.");
    await expect(callout.locator("button.toggle")).toHaveCount(0);
});
