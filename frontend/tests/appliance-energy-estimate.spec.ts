import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The learned appliance energy, where a reader can see it (issue #321).
 *
 * `helman/training/status` carries the appliance job's adopted `estimates`,
 * and its per-appliance failures arrive as the job's issues. The Training
 * tab's appliance table and each device's own Projection settings read both
 * through one resolver, so this file stubs the status once and checks that
 * both places say the same thing for each device.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

function learner(id: string, name: string, meter: string): Record<string, unknown> {
    return {
        id,
        name,
        kind: "generic",
        schedulable: true,
        controls: { switch: { entity_id: `switch.${id}` } },
        consumption: {
            energy_entity_id: meter,
            projection: { strategy: "history_average", hourly_energy_kwh: 0.5, lookback_days: 21 },
        },
    };
}

const CONFIG = {
    config_version: 19,
    devices: [
        learner("dishwasher", "Dishwasher", "sensor.dishwasher_energy"),
        learner("washer", "Laundry", "sensor.washer_energy"),
        learner("dryer", "Dryer", "sensor.dryer_energy"),
        {
            id: "pool",
            name: "Pool",
            kind: "generic",
            schedulable: true,
            controls: { switch: { entity_id: "switch.pool" } },
            consumption: {
                energy_entity_id: "sensor.pool_energy",
                projection: { strategy: "fixed", hourly_energy_kwh: 1 },
            },
        },
    ],
};

function job(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        enabled: true,
        health: "ok",
        lastOutcome: "estimates_trained",
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

// The dishwasher learned, the washer failed, the dryer was never trained.
const TRAINING_STATUS = {
    trainingTime: "03:00",
    nextScheduledTrainingAt: "2026-09-20T03:00:00+00:00",
    isRunning: false,
    currentJob: null,
    anyFailed: false,
    jobs: [
        job("solar_bias"),
        job("house_consumption"),
        job("appliance_energy", {
            health: "degraded",
            estimates: { dishwasher: 1.1234 },
            issues: [{ subject: "washer", reason: "no running hours" }],
        }),
    ],
};

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, trainingStatus }) => {
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
                    if (request.type === "helman/inspect_entities") return { results: [] };
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
    await page.locator(".tabs").getByRole("button", { name: label, exact: true }).click();
}

/** The Learned average cell of the appliance table's row for `name`. */
function learnedCell(page: Page, name: string) {
    return page
        .locator("details.section-card", {
            has: page.locator('helman-training-job-status[data-job="appliance_energy"]'),
        })
        .locator(".training-depth-table tbody tr", { hasText: name })
        .locator("td")
        .nth(1);
}

/** The read-only estimate line in a device card's Projection settings. */
function estimateLine(page: Page, name: string) {
    return page
        .locator("details.list-card", {
            has: page.locator(":scope > summary strong", { hasText: new RegExp(`^${name}$`) }),
        })
        .locator(".appliance-energy-estimate");
}

test("the appliance table shows each device's learned value or why it has none", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Training");

    await expect(learnedCell(page, "Dishwasher")).toHaveText("1.12 kWh/h");
    await expect(learnedCell(page, "Laundry")).toHaveText("No estimate · using 0.5 kWh/h");
    await expect(learnedCell(page, "Laundry").locator("span")).toHaveAttribute(
        "title",
        "no running hours",
    );
    await expect(learnedCell(page, "Dryer")).toHaveText("Not trained yet");
});

test("a device on history_average shows the same value in its settings", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    await expect(estimateLine(page, "Dishwasher")).toHaveText(
        "Learned from history: 1.12 kWh/h",
    );
    await expect(estimateLine(page, "Laundry")).toHaveText(
        "No estimate (no running hours): using 0.5 kWh/h",
    );
    await expect(estimateLine(page, "Dryer")).toHaveText(
        "Not trained yet: using 0.5 kWh/h until it is",
    );
    // A fixed device projects its own figure; there is nothing learned to show.
    await expect(estimateLine(page, "Pool")).toHaveCount(0);
});

test("the strategy select opens on the configured strategy and names the kWh field by it", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    const card = (name: string) =>
        page.locator("details.list-card", {
            has: page.locator(":scope > summary strong", { hasText: new RegExp(`^${name}$`) }),
        });

    // The select is committed before its options exist on first render, so
    // a `.value` binding fell back to the first option ("fixed").
    await expect(card("Dishwasher").locator("select.projection-strategy")).toHaveValue("history_average");
    await expect(card("Pool").locator("select.projection-strategy")).toHaveValue("fixed");

    await expect(card("Dishwasher").locator("label", { hasText: "Fallback hourly energy kWh" })).toHaveCount(1);
    await expect(card("Pool").locator("label", { hasText: "Average hourly energy kWh" })).toHaveCount(1);
});
