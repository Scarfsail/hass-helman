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
 *
 * Every other device reads its usage record from the job's `devices`, by the
 * card's deviceKey, through the same resolver (issue #384).
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
    devices: { consumers: [
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
        // Neither can be scheduled: each has a record, and no projection.
        { id: "fridge", name: "Fridge", consumption: { energy_entity_id: "sensor.fridge_energy" } },
        {
            id: "breaker",
            name: "Breaker",
            consumption: { energy_entity_id: "sensor.breaker_energy" },
            children: [
                { id: "lamp", name: "Lamp", controls: { switch: { entity_id: "switch.lamp" } } },
            ],
        },
        // No meter of its own and no parent's: nothing is ever trained for it.
        { id: "lights", name: "Lights", consumption: { power_entity_id: "sensor.lights_power" } },
    ] },
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
            devices: {
                // A history_average device shows its estimate, never its record.
                "sensor.dishwasher_energy": { on_kwh_per_hour: 9.99 },
                // Metered, no running signal: its mean day.
                "sensor.fridge_energy": {
                    daily_kwh: { mean: 1.234, median: 1.1, min: 0, max: 2, days: 29 },
                },
                // A meterless child, by its id: the figure while it is on.
                lamp: {
                    daily_kwh: { mean: 0.2, median: 0.2, min: 0, max: 0.5, days: 29 },
                    on_kwh_per_hour: 0.05,
                },
            },
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

test("the appliance table lists every consumer device, each with what it learned", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Training");

    // Metered without a running signal: its mean day.
    await expect(learnedCell(page, "Fridge")).toHaveText("1.23 kWh a day");
    // A meterless child, by its id: its figure while on.
    await expect(learnedCell(page, "Lamp")).toHaveText("0.05 kWh/h while on");
    // No record yet: a fixed device shows what it projects, any other nothing.
    await expect(learnedCell(page, "Pool")).toHaveText("Fixed · 1 kWh/h");
    await expect(learnedCell(page, "Breaker")).toHaveText("Not trained yet");
    // A device the job never trains has no row to stay untrained in.
    await expect(learnedCell(page, "Lights")).toHaveCount(0);

    // The lamp reads its parent's meter and its own switch, over 30 days.
    const lamp = page
        .locator("details.section-card", {
            has: page.locator('helman-training-job-status[data-job="appliance_energy"]'),
        })
        .locator(".training-depth-table tbody tr", { hasText: "Lamp" });
    await expect(lamp.locator("td").nth(2)).toHaveText("30 d");
    await expect(lamp.locator("td").nth(0)).toContainText("sensor.breaker_energy");
    await expect(lamp.locator("td").nth(0)).toContainText("switch.lamp");
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

test("any other device shows its recorded average in its settings", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    await expect(estimateLine(page, "Fridge")).toHaveText("Learned from history: 1.23 kWh a day");
    await expect(estimateLine(page, "Lamp")).toHaveText("Learned from history: 0.05 kWh/h while on");
    // The estimate, not the record, for a device the forecast learns for.
    await expect(estimateLine(page, "Dishwasher")).toHaveText("Learned from history: 1.12 kWh/h");
});
