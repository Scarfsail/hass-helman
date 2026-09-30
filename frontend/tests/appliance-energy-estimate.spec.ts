import { test, expect, type Locator, type Page } from "@playwright/test";
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
 *
 * Every figure is kWh/h while on, coloured by where it came from: green
 * learned while on, orange the daily mean over 24, blue configured with the
 * learned figure in parentheses (issue #392).
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
        learner("kettle", "Kettle", "sensor.kettle_new_energy"),
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
        // Fixed, with a record: its configured figure, then what it learned.
        {
            id: "heater",
            name: "Heater",
            kind: "generic",
            schedulable: true,
            controls: { switch: { entity_id: "switch.heater" } },
            consumption: {
                energy_entity_id: "sensor.heater_energy",
                projection: { strategy: "fixed", hourly_energy_kwh: 2 },
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
            // The kettle's meter changed: its estimate outlives a record under the new key.
            estimates: { dishwasher: 1.1234, kettle: 2.5 },
            issues: [{ subject: "washer", reason: "no running hours" }],
            devices: {
                // A history_average device's estimate is its record's figure.
                "sensor.dishwasher_energy": {
                    daily_kwh: { mean: 2.4, median: 2.2, min: 0, max: 5, days: 21 },
                    running_kw: 1.8,
                    on_kwh_per_hour: 1.1234,
                },
                "sensor.heater_energy": { on_kwh_per_hour: 1.5 },
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
        .locator(".training-depth-table tbody tr", {
            has: page.locator(".training-depth-label", { hasText: new RegExp(`^${name}$`) }),
        })
        .locator("td")
        .nth(1);
}

/** The read-only estimate line in a device card's Projection or Measurements settings. */
function estimateLine(page: Page, name: string) {
    return page
        .locator("details.list-card", {
            has: page.locator(":scope > summary strong", { hasText: new RegExp(`^${name}$`) }),
        })
        .locator(".appliance-energy-estimate");
}


/** The hover's four measures, in their fixed order, for a record. */
function measures(whileOn: string, average: string, perDay: string, runningPower: string): string {
    return [
        `While on: ${whileOn}`,
        `Average: ${average}`,
        `Per day: ${perDay}`,
        `Running power: ${runningPower}`,
    ].join("\n");
}

/** A rendered value: its text, the colour class of each figure, and its hover. */
async function energyValue(cell: Locator) {
    const value = cell.locator(".device-energy");
    await expect(value).toHaveCount(1);
    return value.evaluate((element) => ({
        text: element.textContent?.replace(/\s+/g, " ").trim(),
        sources: Array.from(element.querySelectorAll(".device-energy-value")).map((figure) =>
            ["on", "day", "configured"].find((source) => figure.classList.contains(source)),
        ),
        title: element.getAttribute("title"),
    }));
}

test("a history_average device shows its estimate, else its configured fallback in blue", async ({
    page,
}) => {
    await mountEditor(page);
    await openTab(page, "Training");

    expect(await energyValue(learnedCell(page, "Dishwasher"))).toEqual({
        text: "1.12 kWh/h",
        sources: ["on"],
        title: measures("1.12 kWh/h", "0.10 kWh/h", "2.40 kWh", "1.80 kW"),
    });
    expect(await energyValue(learnedCell(page, "Laundry"))).toEqual({
        text: "0.50 kWh/h (—)",
        sources: ["configured"],
        title: `${measures("—", "—", "—", "—")}\nConfigured: 0.50 kWh/h\nNo estimate: no running hours`,
    });
    expect(await energyValue(learnedCell(page, "Dryer"))).toEqual({
        text: "0.50 kWh/h (—)",
        sources: ["configured"],
        title: `${measures("—", "—", "—", "—")}\nConfigured: 0.50 kWh/h\nNot trained yet`,
    });
    expect(await energyValue(learnedCell(page, "Kettle"))).toEqual({
        text: "2.50 kWh/h",
        sources: ["on"],
        title: measures("2.50 kWh/h", "—", "—", "—"),
    });
});

test("every other device shows what it learned, on the same scale", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Training");

    // Metered without a running signal: its mean day over 24 hours, in orange.
    expect(await energyValue(learnedCell(page, "Fridge"))).toEqual({
        text: "0.05 kWh/h",
        sources: ["day"],
        title: measures("—", "0.05 kWh/h", "1.23 kWh", "—"),
    });
    // A meterless child, by its id: its figure while on.
    expect(await energyValue(learnedCell(page, "Lamp"))).toEqual({
        text: "0.05 kWh/h",
        sources: ["on"],
        title: measures("0.05 kWh/h", "0.01 kWh/h", "0.20 kWh", "—"),
    });
    // Fixed: its configured figure, then what it learned or a dash.
    expect(await energyValue(learnedCell(page, "Pool"))).toEqual({
        text: "1.00 kWh/h (—)",
        sources: ["configured"],
        title: `${measures("—", "—", "—", "—")}\nConfigured: 1.00 kWh/h\nNot trained yet`,
    });
    expect(await energyValue(learnedCell(page, "Heater"))).toEqual({
        text: "2.00 kWh/h (1.50 kWh/h)",
        sources: ["configured", "on"],
        title: `${measures("1.50 kWh/h", "—", "—", "—")}\nConfigured: 2.00 kWh/h`,
    });
    // No record and nothing configured.
    expect(await energyValue(learnedCell(page, "Breaker"))).toEqual({
        text: "—",
        sources: [],
        title: `${measures("—", "—", "—", "—")}\nNot trained yet`,
    });
    // A device the job never trains has no row to stay untrained in.
    await expect(learnedCell(page, "Lights")).toHaveCount(0);

    // The lamp reads its parent's meter and its own switch, over 30 days.
    const lamp = learnedCell(page, "Lamp").locator("xpath=..");
    await expect(lamp.locator("td").nth(2)).toHaveText("30 d");
    await expect(lamp.locator("td").nth(0)).toContainText("sensor.breaker_energy");
    await expect(lamp.locator("td").nth(0)).toContainText("switch.lamp");
});

test("every row's hover lists the same measures in the same order", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Training");

    const values = page
        .locator("details.section-card", {
            has: page.locator('helman-training-job-status[data-job="appliance_energy"]'),
        })
        .locator(".training-depth-table tbody .device-energy");
    await expect(values).toHaveCount(9);
    const labels = await values.evaluateAll((elements) =>
        elements.map((element) =>
            (element.getAttribute("title") ?? "")
                .split("\n")
                .slice(0, 4)
                .map((line) => line.split(":")[0]),
        ),
    );
    for (const row of labels) {
        expect(row).toEqual(["While on", "Average", "Per day", "Running power"]);
    }
});

test("each device's settings show the same value as its table row", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Training");
    const names = ["Dishwasher", "Laundry", "Dryer", "Heater", "Fridge", "Lamp"];
    const table = [];
    for (const name of names) table.push(await energyValue(learnedCell(page, name)));

    await openTab(page, "Devices");
    for (const [index, name] of names.entries()) {
        await expect(estimateLine(page, name)).toHaveText(`Energy: ${table[index].text}`);
        expect(await energyValue(estimateLine(page, name))).toEqual(table[index]);
    }
    // A fixed device without a record has nothing learned to show.
    await expect(estimateLine(page, "Pool")).toHaveCount(0);
});

test("the Projection badge speaks the same unit", async ({ page }) => {
    await mountEditor(page);
    await openTab(page, "Devices");

    const card = page.locator("details.list-card", {
        has: page.locator(":scope > summary strong", { hasText: /^Heater$/ }),
    });
    await expect(card.getByText("2 kWh/h while on", { exact: true })).toHaveCount(1);
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
