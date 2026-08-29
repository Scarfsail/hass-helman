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
const FORECAST_SOURCE_PATH = [
    "power_devices",
    "solar",
    "forecast",
    "daily_energy_entity_ids",
    0,
];

const HOUSE_KEY = HOUSE_PATH.join(".");
const BIAS_KEY = BIAS_PATH.join(".");
const GRID_KEY = GRID_PATH.join(".");
const BATTERY_KEY = BATTERY_PATH.join(".");
const CONTROLLABLE_KEY = CONTROLLABLE_PATH.join(".");
const FORECAST_SOURCE_KEY = FORECAST_SOURCE_PATH.join(".");
// Helman publishes this one, so its "path" is a constant rather than a
// location in the config document.
const FORECAST_RECORDED_KEY = "helman.solar_forecast_current";

/** Which window governs which entity, mirroring `EVALUATORS` in the registry. */
const REQUIRED_BY_KEY: Record<string, number> = {
    [HOUSE_KEY]: 14,
    [CONTROLLABLE_KEY]: 14,
    [BIAS_KEY]: 10,
    [FORECAST_SOURCE_KEY]: 10,
    [FORECAST_RECORDED_KEY]: 10,
    [GRID_KEY]: 10,
    [BATTERY_KEY]: 10,
};

const CONFIG = {
    config_version: 14,
    power_devices: {
        house: { forecast: { total_energy_entity_id: "sensor.house_energy" } },
        solar: {
            forecast: {
                daily_energy_entity_ids: ["sensor.solcast_today"],
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
    // Attribute history lives only in recorder states, so a deep statistics
    // number here is exactly the reassurance the role text warns against.
    [FORECAST_SOURCE_KEY]: { available: 12, statistics: 730 },
    // The shape the real instance has: shallow states against deep statistics.
    // Only the states column binds until #173 splices the two, so this row is
    // the one that goes orange while every other number looks reassuring.
    [FORECAST_RECORDED_KEY]: { available: 6, statistics: 210 },
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
    // House meter + one controllable, then the solar comparison -- whose
    // forecast side is two rows, the source and what Helman records from it --
    // plus grid and battery.
    const tables = await waitForRows(page, 7);

    const allRows = tables.flat();
    // Seven rows, seven entities -- one target sent, one row rendered, no more
    // and no fewer.
    expect(allRows.length).toBe(7);

    const request = await page.evaluate(() => (window as any).__inspectRequests.at(-1));
    const requestedKeys = request.targets.map((target: any) => target.key).sort();
    expect(requestedKeys).toEqual(
        [
            HOUSE_KEY,
            BIAS_KEY,
            FORECAST_SOURCE_KEY,
            FORECAST_RECORDED_KEY,
            GRID_KEY,
            BATTERY_KEY,
            CONTROLLABLE_KEY,
        ].sort(),
    );
});

test("the numbers in each row match what inspect_entities answered for it", async ({ page }) => {
    await mountEditor(page);
    const tables = await waitForRows(page, 7);
    const allRows = tables.flat();

    // Four columns: the entity, what the trainer takes from it, and the two
    // depths. The configured window and minimum are deliberately not here --
    // they are the same for every row and are edited in the fields above.
    const houseRow = allRows.find((row) => row[0].includes("sensor.house_energy"));
    expect(houseRow).toBeDefined();
    expect(houseRow!.length).toBe(4);
    expect(houseRow!.slice(2)).toEqual(["41", "620"]);

    const controllableRow = allRows.find((row) => row[0].includes("sensor.dishwasher_energy"));
    expect(controllableRow).toBeDefined();
    expect(controllableRow!.slice(2)).toEqual(["33", "33"]);

    const biasRow = allRows.find((row) => row[0].includes("sensor.solar_bias_meter"));
    expect(biasRow).toBeDefined();
    expect(biasRow!.slice(2)).toEqual(["8", "400"]);

    const gridRow = allRows.find((row) => row[0].includes("sensor.grid_power"));
    expect(gridRow).toBeDefined();
    expect(gridRow!.slice(2)).toEqual(["15", "15"]);

    const batteryRow = allRows.find((row) => row[0].includes("sensor.battery_capacity"));
    expect(batteryRow).toBeDefined();
    expect(batteryRow!.slice(2)).toEqual(["25", "999"]);

    const forecastRow = allRows.find((row) => row[0].includes("sensor.solcast_today"));
    expect(forecastRow).toBeDefined();
    expect(forecastRow!.slice(2)).toEqual(["12", "730"]);
});

test("the forecast the actuals are compared against has a row of its own", async ({
    page,
}) => {
    // Without it the section showed only the actual production and left a
    // reader asking what it was measured against.
    await mountEditor(page);
    const allRows = (await waitForRows(page, 7)).flat();

    const forecastRow = allRows.find((row) => row[0].includes("sensor.solcast_today"));
    expect(forecastRow).toBeDefined();
    // Helman archives this entity's prediction as each day runs, so neither
    // depth column governs training -- the role has to say so, because both
    // will happily show a deep and irrelevant number.
    expect(forecastRow![1]).toContain("archive");
});

test("each row says what the trainer takes from that entity", async ({ page }) => {
    // The column the page exists for: a reader who cannot tell why the grid
    // meter is listed under a *solar* trainer gets the answer in the row.
    await mountEditor(page);
    const allRows = (await waitForRows(page, 7)).flat();

    const roleOf = (entityId: string) =>
        allRows.find((row) => row[0].includes(entityId))![1];

    expect(roleOf("sensor.house_energy")).toContain("household total");
    expect(roleOf("sensor.dishwasher_energy")).toContain("Subtracted from the house total");
    expect(roleOf("sensor.solar_bias_meter")).toContain("Actual production");
    expect(roleOf("sensor.grid_power")).toContain("capped");
    expect(roleOf("sensor.battery_capacity")).toContain("full battery");

    // No row is left without one.
    expect(allRows.every((row) => row[1].trim().length > 0)).toBe(true);
});

test("no column repeats a value that is the same for every row", async ({ page }) => {
    // The window and the minimum are this section's own settings, shown in the
    // fields above; a column of them down the table said nothing new.
    await mountEditor(page);
    const headers = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".training-depth-table th") ?? []).map(
            (cell) => cell.textContent?.trim() ?? "",
        );
    });

    expect(headers).not.toContain("Window (d)");
    expect(headers).not.toContain("Minimum (d)");
    // A different trainer's per-appliance setting, configured elsewhere.
    expect(headers).not.toContain("Own lookback (d)");
    expect(headers.slice(0, 4)).toEqual([
        "Entity",
        "What the trainer takes from it",
        "Detailed data (d)",
        "Statistics (d)",
    ]);
});

test("clicking an entity asks Home Assistant for its more-info dialog", async ({
    page,
}) => {
    await mountEditor(page);
    await waitForRows(page, 7);

    const detail = await page.evaluate(async () => {
        const panel = document.querySelector("helman-config-editor-panel")!;
        const seen: unknown[] = [];
        // `hass-more-info` is composed, so it leaves the panel's shadow root
        // and reaches HA's dialog manager -- listening on document proves it
        // escapes rather than dying at the boundary.
        document.addEventListener("hass-more-info", (event) => {
            seen.push((event as CustomEvent).detail);
        });
        const button = panel.shadowRoot!.querySelector(
            ".training-depth-entity-button",
        ) as HTMLButtonElement;
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return seen[0] ?? null;
    });

    expect(detail).toEqual({ entityId: "sensor.house_energy" });
});

test("a row with no entity configured is not clickable", async ({ page }) => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    delete config.power_devices.battery.entities.capacity;

    await mountEditor(page, config);
    await waitForRows(page, 7);

    const buttonCount = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return root?.querySelectorAll(".training-depth-entity-button").length ?? -1;
    });

    // Six of the seven rows have an entity and are clickable; only the unset
    // battery one renders plain text. The recorded-forecast row counts here
    // even though no config path points at it -- the inspection resolves its
    // id, which is exactly what makes it clickable.
    expect(buttonCount).toBe(6);
});

test("the entity column keeps its width on a wide screen", async ({ page }) => {
    // The prose column used to be declared width:100%, which starved the
    // entity column down to a few characters and broke every id across four
    // lines while the prose sat in whitespace.
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountEditor(page);
    await waitForRows(page, 7);

    const widths = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const row = root!.querySelector(".training-depth-table tbody tr")!;
        return Array.from(row.querySelectorAll("td")).map(
            (cell) => (cell as HTMLElement).getBoundingClientRect().width,
        );
    });

    // Wide enough for a typical entity id on one or two lines, not four.
    expect(widths[0]).toBeGreaterThan(180);
    // And the prose still gets the largest share.
    expect(widths[1]).toBeGreaterThan(widths[0]);
});

test("the table fits a narrow viewport instead of scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mountEditor(page);
    await waitForRows(page, 7);

    const overflow = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const wrap = root?.querySelector(".training-depth-table-wrap") as HTMLElement;
        return { scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth };
    });

    // The role column wraps rather than holding one line, so the table is
    // taller on a narrow screen instead of wider than its container.
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
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
    const tables = await waitForRows(page, 7);
    const allRows = tables.flat();

    // The seven of the base config, and neither of the two just added.
    expect(allRows.length).toBe(7);
    expect(allRows.some((row) => row[0].includes("Fridge"))).toBe(false);
    expect(allRows.some((row) => row[0].includes("Inverter"))).toBe(false);
});

test("a raw-states depth below the requirement is marked, even deep in statistics", async ({
    page,
}) => {
    // The false green from #169: the bias meter's raw-states depth (8) is
    // below its requirement (10) while its statistics depth (400) is not --
    // and the row has to read as a warning regardless.
    await mountEditor(page);
    await waitForRows(page, 7);

    const warnCell = await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const cell = Array.from(root?.querySelectorAll(".training-depth-warn") ?? []).find(
            (element) => element.textContent?.trim() === "8",
        );
        return cell?.textContent?.trim() ?? null;
    });
    expect(warnCell).toBe("8");
});
