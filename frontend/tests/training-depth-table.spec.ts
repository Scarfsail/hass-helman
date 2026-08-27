import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The Training tab's per-entity depth table (issue #172).
 *
 * The table is fed by the same `helman/inspect_entities` command every entity
 * picker in the editor already polls -- no second measurement path, no new
 * websocket command. So this file, like `entity-group.spec.ts`, never
 * computes a depth itself: the fixture below answers with facts of its own
 * choosing, deliberately setting the raw-states and statistics numbers apart,
 * and every assertion traces a number on screen back to the fixture's answer
 * for the same target key.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const HOUSE_PATH = ["power_devices", "house", "forecast", "total_energy_entity_id"];
const BIAS_PATH = ["power_devices", "solar", "forecast", "bias_correction", "total_energy_entity_id"];
const GRID_PATH = ["power_devices", "grid", "entities", "power"];
const BATTERY_PATH = ["power_devices", "battery", "entities", "capacity"];
const CONTROLLABLE_PATH = ["controllables", 0, "consumption", "energy_entity_id"];

const HOUSE_KEY = HOUSE_PATH.join(".");
const BIAS_KEY = BIAS_PATH.join(".");
const GRID_KEY = GRID_PATH.join(".");
const BATTERY_KEY = BATTERY_PATH.join(".");
const CONTROLLABLE_KEY = CONTROLLABLE_PATH.join(".");

/** Which window governs which entity, mirroring `EVALUATORS` in the registry. */
const REQUIRED_BY_KEY: Record<string, number> = {
    [HOUSE_KEY]: 14,
    [CONTROLLABLE_KEY]: 14,
    [BIAS_KEY]: 10,
    [GRID_KEY]: 10,
    [BATTERY_KEY]: 10,
};

const CONFIG = {
    config_version: 14,
    power_devices: {
        house: { forecast: { total_energy_entity_id: "sensor.house_energy" } },
        solar: {
            forecast: {
                bias_correction: { total_energy_entity_id: "sensor.solar_bias_meter" },
            },
        },
        grid: { entities: { power: "sensor.grid_power" } },
        battery: { entities: { capacity: "sensor.battery_capacity" } },
    },
    controllables: [
        {
            id: "dishwasher",
            name: "Dishwasher",
            consumption: {
                energy_entity_id: "sensor.dishwasher_energy",
                projection: { strategy: "history_average", lookback_days: 21 },
            },
        },
    ],
    training: {
        house_consumption: { min_history_days: 14, training_window_days: 56 },
        solar_bias: { min_history_days: 10, max_training_window_days: 90 },
    },
};

/** Deliberately different per key, so a row's numbers cannot be mistaken for another's. */
const DEPTHS: Record<string, { available: number; statistics: number }> = {
    [HOUSE_KEY]: { available: 41, statistics: 620 },
    [BIAS_KEY]: { available: 8, statistics: 400 },
    [GRID_KEY]: { available: 15, statistics: 15 },
    [BATTERY_KEY]: { available: 25, statistics: 999 },
    [CONTROLLABLE_KEY]: { available: 33, statistics: 33 },
};

async function mountEditor(page: Page, configOverride?: unknown): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, depths, requiredByKey }) => {
            // The backend derives each fact's `required` from the window that
            // governs that entity, so the stub does too: a house-consumption
            // entity is judged against 14, a solar-bias one against 10.
            const requiredFor = (key: string): number => requiredByKey[key] ?? 0;
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            const requests: unknown[] = [];
            (window as any).__inspectRequests = requests;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeEvents: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/inspect_entities") {
                        requests.push(JSON.parse(JSON.stringify(request)));
                        return {
                            results: (request.targets ?? []).map((target: any) => {
                                const depth = (depths as Record<string, any>)[target.key];
                                return {
                                    key: target.key,
                                    draft: depth
                                        ? {
                                              entityId: "sensor.stub",
                                              status: "ok",
                                              facts: [
                                                  {
                                                      id: "value",
                                                      token: "value",
                                                      params: { value: "1", unit: "kWh" },
                                                      severity: "neutral",
                                                  },
                                                  {
                                                      id: "history",
                                                      token: "history_depth",
                                                      params: { ...depth, required: requiredFor(target.key) },
                                                      severity:
                                                          depth.available >= requiredFor(target.key)
                                                              ? "ok"
                                                              : "warn",
                                                  },
                                              ],
                                              dependsOn: [],
                                          }
                                        : { entityId: null, status: "unsupported", facts: [] },
                                    saved: null,
                                };
                            }),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { config: configOverride ?? CONFIG, depths: DEPTHS, requiredByKey: REQUIRED_BY_KEY },
    );

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
}

/** Every training-depth table on screen, as rows of cell text. */
function readTables(page: Page): Promise<string[][][]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const tables = Array.from(root?.querySelectorAll(".training-depth-table") ?? []);
        return tables.map((table) =>
            Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
                Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
            ),
        );
    });
}

async function waitForRows(page: Page, minRows: number): Promise<string[][][]> {
    await expect
        .poll(async () => (await readTables(page)).reduce((sum, rows) => sum + rows.length, 0))
        .toBeGreaterThanOrEqual(minRows);
    return readTables(page);
}

test("every governed entity in #172's table gets a row, fed by the shared poll", async ({ page }) => {
    await mountEditor(page);
    // House meter + one controllable, then bias meter + grid + battery.
    const tables = await waitForRows(page, 5);

    const allRows = tables.flat();
    // Five rows, five entities -- one target sent, one row rendered, no more
    // and no fewer.
    expect(allRows.length).toBe(5);

    const request = await page.evaluate(() => (window as any).__inspectRequests.at(-1));
    const requestedKeys = request.targets.map((target: any) => target.key).sort();
    expect(requestedKeys).toEqual(
        [HOUSE_KEY, BIAS_KEY, GRID_KEY, BATTERY_KEY, CONTROLLABLE_KEY].sort(),
    );
});

test("the numbers in each row match what inspect_entities answered for it", async ({ page }) => {
    await mountEditor(page);
    const tables = await waitForRows(page, 5);
    const allRows = tables.flat();

    // House-consumption table: house meter first, then the controllable.
    const houseRow = allRows.find((row) => row[0].includes("sensor.house_energy"));
    expect(houseRow).toBeDefined();
    expect(houseRow!.slice(1)).toEqual(["56", "14", "41", "620", "—"]);

    const controllableRow = allRows.find((row) => row[0].includes("sensor.dishwasher_energy"));
    expect(controllableRow).toBeDefined();
    // Configured window/minimum come from the *house-consumption* group, same
    // as the house meter's row -- the controllable has no window of its own.
    // The last column is its own per-appliance lookback, read straight out of
    // the draft rather than out of any fact.
    expect(controllableRow!.slice(1)).toEqual(["56", "14", "33", "33", "21"]);

    // The solar-bias table has no "own lookback" column at all -- no row in
    // it can carry one -- so its rows are four cells wide, not five.
    const biasRow = allRows.find((row) => row[0].includes("sensor.solar_bias_meter"));
    expect(biasRow).toBeDefined();
    expect(biasRow!.slice(1)).toEqual(["90", "10", "8", "400"]);

    const gridRow = allRows.find((row) => row[0].includes("sensor.grid_power"));
    expect(gridRow).toBeDefined();
    expect(gridRow!.slice(1)).toEqual(["90", "10", "15", "15"]);

    const batteryRow = allRows.find((row) => row[0].includes("sensor.battery_capacity"));
    expect(batteryRow).toBeDefined();
    expect(batteryRow!.slice(1)).toEqual(["90", "10", "25", "999"]);
});

test("a controllable the house trainer skips gets no row", async ({ page }) => {
    // `read_deferrable_consumers` refuses the inverter and honours
    // `deferrable: false`, so neither meter is read by the house window -- and
    // a row would claim otherwise.
    const config = JSON.parse(JSON.stringify(CONFIG));
    config.controllables.push({
        id: "fridge",
        name: "Fridge",
        consumption: { energy_entity_id: "sensor.fridge_energy", deferrable: false },
    });
    config.controllables.push({
        id: "inverter",
        name: "Inverter",
        kind: "inverter",
    });

    await mountEditor(page, config);
    const tables = await waitForRows(page, 5);
    const allRows = tables.flat();

    expect(allRows.length).toBe(5);
    expect(allRows.some((row) => row[0].includes("Fridge"))).toBe(false);
    expect(allRows.some((row) => row[0].includes("Inverter"))).toBe(false);
});

test("a blank minimum shows the default the badge is actually judged against", async ({
    page,
}) => {
    // The backend falls back to the const.py default and colours the cell
    // against it, so a row that showed a dash here would be judging the user
    // against a number the page never told them.
    const config = JSON.parse(JSON.stringify(CONFIG));
    delete config.training.house_consumption.min_history_days;

    await mountEditor(page, config);
    const tables = await waitForRows(page, 5);
    const houseRow = tables.flat().find((row) => row[0].includes("sensor.house_energy"));

    expect(houseRow![2]).toBe("14");
});

test("a raw-states depth below the requirement is marked, even deep in statistics", async ({
    page,
}) => {
    // The false green from #169: the bias meter's raw-states depth (8) is
    // below its requirement (10) while its statistics depth (400) is not --
    // and the row has to read as a warning regardless.
    await mountEditor(page);
    await waitForRows(page, 5);

    const warnCell = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const cell = Array.from(root?.querySelectorAll(".training-depth-warn") ?? []).find(
            (element) => element.textContent?.trim() === "8",
        );
        return cell?.textContent?.trim() ?? null;
    });
    expect(warnCell).toBe("8");
});
