import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";

/**
 * The solar-only options on `helman-solar-inspector-card`:
 * `hide_schedule_strip`, `hide_price_strip`, `hide_money_strip` and
 * `chart_series`.
 *
 * Unlike `show_bias_ratio`, which only seeds an opening state the legend can
 * move away from, these are hard hides: the row is not rendered, the series is
 * not drawn, and the tile that would toggle it is gone rather than dimmed. A
 * card configured down to the three solar series has to read as a solar chart,
 * not as the dashboard card with four rows switched off.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** The config the Training tab's solar diagnostics mounts the card with. */
const SOLAR_ONLY = {
    show_bias_ratio: true,
    hide_schedule_strip: true,
    hide_price_strip: true,
    hide_money_strip: true,
    chart_series: ["actual", "corrected", "raw"],
};

const SOLAR_COLOR = "#facc15";
const RAW_COLOR = "#64748b";
const GRID_COLOR = "#38bdf8";
const BATT_COLOR = "#22c55e";

/** Mount the wrapper card against the fake backend with the given config. */
async function mountCard(page: Page, config: Record<string, unknown>): Promise<void> {
    await page.goto("about:blank");
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector-card"));
    await installFakeHass(page, { pillDays: 4 });

    await page.evaluate((cfg) => {
        (window as unknown as { __inspectorRoot: () => ShadowRoot | null | undefined })
            .__inspectorRoot = () =>
                document.querySelector("helman-solar-inspector-card")
                    ?.shadowRoot?.querySelector("helman-solar-inspector")?.shadowRoot;

        const card = document.createElement("helman-solar-inspector-card") as HTMLElement &
            { setConfig: (config: unknown) => void; hass: unknown };
        card.setConfig({ type: "custom:helman-solar-inspector-card", ...cfg });
        card.hass = (window as unknown as { __fakeHass: unknown }).__fakeHass;
        document.body.appendChild(card);
    }, config);

    await page.waitForFunction(() => (window as unknown as {
        __pendingInspector: () => number;
    }).__pendingInspector() === 1);
    await page.evaluate(() => (window as unknown as {
        __releaseInspector: () => void;
    }).__releaseInspector());
    await page.waitForFunction(() => !!(window as unknown as {
        __inspectorRoot: () => ShadowRoot | null | undefined;
    }).__inspectorRoot()?.querySelector(".metric-card"));
}

/**
 * Give the day every series the four rows and the stacks read from.
 *
 * The fake backend serves solar alone, so without this a default card would
 * have no SoC row and no house, grid or battery columns to compare against --
 * and "absent" would prove nothing.
 */
async function seedEverySeries(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        const payload = JSON.parse(JSON.stringify(el._payload));
        const hours = Array.from({ length: 24 }, (_, hour) =>
            `${String(hour).padStart(2, "0")}:00`);
        // Stamped, not slot-labelled: the power series are bucketed off their
        // timestamps, so a slot-labelled point would leave the stacks empty.
        const wh = (valueWh: number) =>
            hours.map((slot) => ({ timestamp: `${payload.date}T${slot}:00`, valueWh }));
        const pct = (value: number) => hours.map((slot) => ({ slot, pct: value }));
        payload.series.corrected = wh(500);
        payload.series.raw = wh(400);
        payload.series.actual = wh(450);
        payload.series.houseForecast = wh(-300);
        payload.series.houseActual = wh(-320);
        payload.series.gridForecast = wh(-100);
        payload.series.gridActual = wh(-120);
        payload.series.batteryForecast = wh(-80);
        payload.series.batteryActual = wh(-90);
        payload.series.batterySocForecast = pct(50);
        payload.series.batterySocActual = pct(55);
        payload.totals.rawWh = 9600;
        payload.totals.houseForecastWh = -7200;
        payload.totals.houseActualWh = -7680;
        payload.totals.gridForecastWh = -2400;
        payload.totals.gridActualWh = -2880;
        payload.totals.batteryForecastWh = -1920;
        payload.totals.batteryActualWh = -2160;
        payload.availability.hasRawForecast = true;
        payload.availability.hasActuals = true;
        payload.availability.hasHouseForecast = true;
        payload.availability.hasHouseActual = true;
        payload.availability.hasBatterySocForecast = true;
        payload.availability.hasBatterySocActual = true;
        payload.availability.hasGridForecast = true;
        payload.availability.hasGridActual = true;
        payload.availability.hasBatteryForecast = true;
        payload.availability.hasBatteryActual = true;
        el._payload = payload;
        el.requestUpdate();
    });
    // Awaited, not merely read: `updateComplete` is a promise, so a truthiness
    // check passes before Lit has rendered anything.
    await page.evaluate(async () => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        await (root?.host as any)?.updateComplete;
    });
}

/** Which of the four rows below the chart are currently in the DOM. */
function rowsPresent(page: Page): Promise<Record<string, boolean>> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const has = (selector: string) => !!root?.querySelector(selector);
        return {
            soc: has(".soc-strip-wrap svg"),
            price: has("helman-solar-price-strip"),
            money: has("helman-solar-money-strip"),
            schedule: has("helman-solar-schedule-band-strip"),
            // The day editor the band opens: its only consumer and its only
            // entry point is that band, and it does backend work of its own.
            editorHost: has("scheduling-day-editor-host"),
        };
    });
}

/** Every metric tile label currently drawn, across totals and slot detail. */
function metricLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        return [...(root?.querySelectorAll(".metric-label") ?? [])]
            .map((node) => node.textContent?.trim() ?? "");
    });
}

/** Tiles a reader could mistake for a series switched off rather than absent. */
function dimmedTileLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        return [...(root?.querySelectorAll(".metric-card.hidden-series") ?? [])]
            .map((node) => node.querySelector(".metric-label")?.textContent?.trim() ?? "");
    });
}

/** Every colour the main chart paints with, as fill or stroke. */
function chartColors(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const svg = root?.querySelector(".main-chart-wrap svg");
        const colors = new Set<string>();
        for (const node of svg?.querySelectorAll("*") ?? []) {
            // A hatch pattern is defined for the whole palette whether its
            // series is drawn or not, so only drawn marks count.
            if (node.closest("defs")) continue;
            for (const name of ["fill", "stroke"]) {
                const value = node.getAttribute(name);
                if (value) colors.add(value.toLowerCase());
            }
        }
        return [...colors];
    });
}

/** Whether the inspector counts a series as drawable at all. */
function seriesEnabled(page: Page, series: string): Promise<boolean> {
    return page.evaluate((name) => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as unknown as { _isSeriesEnabled: (s: string) => boolean };
        return el._isSeriesEnabled(name);
    }, series);
}

test("a default card keeps every row and every series", async ({ page }) => {
    await mountCard(page, {});
    await seedEverySeries(page);

    expect(await rowsPresent(page)).toEqual({
        soc: true,
        price: true,
        money: true,
        schedule: true,
        editorHost: true,
    });
    const labels = await metricLabels(page);
    expect(labels).toContain("House");
    expect(labels).toContain("Grid");
    expect(labels).toContain("Battery");
    expect(labels).toContain("Import cost");
    expect(await seriesEnabled(page, "houseForecast")).toBe(true);

    // The colours the solar-only test claims are gone are here to begin with.
    const colors = await chartColors(page);
    expect(colors).toContain(GRID_COLOR);
    expect(colors).toContain(BATT_COLOR);
});

test("the solar-only config drops the four rows below the chart", async ({ page }) => {
    await mountCard(page, SOLAR_ONLY);
    await seedEverySeries(page);

    expect(await rowsPresent(page)).toEqual({
        soc: false,
        price: false,
        money: false,
        schedule: false,
        editorHost: false,
    });
});

test("the solar-only config leaves no tile for a series it dropped", async ({ page }) => {
    await mountCard(page, SOLAR_ONLY);
    await seedEverySeries(page);

    const labels = await metricLabels(page);
    // Gone, not dimmed: a tile that cannot be un-dimmed reads as toggled off.
    expect(labels).not.toContain("House");
    expect(labels).not.toContain("Grid");
    expect(labels).not.toContain("Battery");
    expect(labels).not.toContain("Battery SoC");
    // The money tiles go with the money rails.
    expect(labels).not.toContain("Import cost");
    expect(labels).not.toContain("Export gain");
    expect(labels).not.toContain("Net cost");
    expect(await dimmedTileLabels(page)).toEqual([]);

    // What the diagnostic is for is still there.
    expect(labels).toContain("Solar production");
    expect(labels).toContain("Raw forecast");
});

test("the solar-only config draws the three solar series and nothing else", async ({ page }) => {
    await mountCard(page, SOLAR_ONLY);
    await seedEverySeries(page);

    for (const series of ["raw", "corrected", "actual"]) {
        expect(await seriesEnabled(page, series)).toBe(true);
    }
    for (const series of [
        "houseForecast",
        "houseActual",
        "gridForecast",
        "gridActual",
        "batteryForecast",
        "batteryActual",
        "batterySocForecast",
        "batterySocActual",
    ]) {
        expect(await seriesEnabled(page, series)).toBe(false);
    }

    const colors = await chartColors(page);
    expect(colors).toContain(SOLAR_COLOR);
    expect(colors).toContain(RAW_COLOR);
    expect(colors).not.toContain(GRID_COLOR);
    expect(colors).not.toContain(BATT_COLOR);
});

test("narrowing chart_series on a mounted card repaints the chart", async ({ page }) => {
    await mountCard(page, {});
    await seedEverySeries(page);
    expect(await chartColors(page)).toContain(GRID_COLOR);
    expect((await rowsPresent(page)).soc).toBe(true);

    // `chart_series` alone, and deliberately not through `SOLAR_ONLY`: flipping
    // `show_bias_ratio` rebuilds `_hiddenSeries`, whose new identity would
    // invalidate the day model by itself and hide the bug this pins. The
    // Lovelace editor reconfigures a live card on every keystroke, so the model
    // has to follow the allowlist too -- not just the payload, the slot width
    // and the legend. `_config` is not reactive, so the repaint comes from the
    // next render either way; `requestUpdate` stands in for the `hass` tick.
    await page.evaluate(async () => {
        const card = document.querySelector("helman-solar-inspector-card") as HTMLElement & {
            setConfig: (config: unknown) => void;
            requestUpdate: () => void;
            updateComplete: Promise<unknown>;
        };
        card.setConfig({
            type: "custom:helman-solar-inspector-card",
            chart_series: ["actual", "corrected", "raw"],
        });
        card.requestUpdate();
        await card.updateComplete;
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        await (root?.host as any)?.updateComplete;
    });

    const colors = await chartColors(page);
    expect(colors).toContain(SOLAR_COLOR);
    expect(colors).not.toContain(GRID_COLOR);
    expect(colors).not.toContain(BATT_COLOR);
    // The SoC row empties through the same model, so it goes with them.
    expect((await rowsPresent(page)).soc).toBe(false);
    expect(await metricLabels(page)).not.toContain("Grid");
});

test("an empty chart_series reads as unset rather than as an empty chart", async ({ page }) => {
    // The multi-select emits `[]` when the last option is unchecked, and a card
    // with axes and no series at all would not say why.
    await mountCard(page, { chart_series: [] });
    await seedEverySeries(page);

    expect(await seriesEnabled(page, "gridForecast")).toBe(true);
    expect(await chartColors(page)).toContain(SOLAR_COLOR);
    expect(await metricLabels(page)).toContain("Grid");
});

/** Select a slot, so the detail panel above the daily totals is drawn. */
async function selectSlot(page: Page, slot: string): Promise<void> {
    await page.evaluate(async (selected) => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        el._slotSelection = { selectedSlots: [selected], focusSlot: selected, anchorSlot: selected };
        el.requestUpdate();
        await el.updateComplete;
    }, slot);
}

/** Reconfigure a mounted card the way the Lovelace editor does. */
async function reconfigure(page: Page, config: Record<string, unknown>): Promise<void> {
    await page.evaluate(async (cfg) => {
        const card = document.querySelector("helman-solar-inspector-card") as HTMLElement & {
            setConfig: (config: unknown) => void;
            requestUpdate: () => void;
            updateComplete: Promise<unknown>;
        };
        card.setConfig({ type: "custom:helman-solar-inspector-card", ...cfg });
        card.requestUpdate();
        await card.updateComplete;
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        await (root?.host as any)?.updateComplete;
    }, config);
}

test("hiding the price strip takes the slot detail's price tiles with it", async ({ page }) => {
    await mountCard(page, {});
    await seedEverySeries(page);
    // The fake backend serves no price entities, so the strip publishes nothing;
    // stand in for the `price-columns` event a real day would have delivered.
    await page.evaluate(async () => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        const rail = (value: number) => Array.from({ length: 24 }, (_, hour) => ({
            startMinutes: hour * 60,
            endMinutes: (hour + 1) * 60,
            value,
        }));
        el._importPriceColumns = rail(6);
        el._exportPriceColumns = rail(2);
        el._priceUnit = "CZK/kWh";
        el.requestUpdate();
        await el.updateComplete;
    });
    await selectSlot(page, "12:00");
    // The tiles are gated on the columns the strip reports, so they have to be
    // there first for their absence below to mean anything.
    expect(await metricLabels(page)).toContain("Import price");

    // Hidden after the strip had already reported: the cache it filled is not
    // refilled and not cleared by the strip going away, so the flag has to.
    await reconfigure(page, { hide_price_strip: true });

    expect((await rowsPresent(page)).price).toBe(false);
    const labels = await metricLabels(page);
    expect(labels).not.toContain("Import price");
    expect(labels).not.toContain("Export price");
});

test("an actual-only pair places no chip for the forecast it dropped", async ({ page }) => {
    await mountCard(page, { chart_series: ["actual", "houseActual"] });
    await seedEverySeries(page);
    // A slot the day has no house actual for: both halves of the pair are then
    // absent, and the placeholder must still not speak for the dropped forecast.
    await page.evaluate(async () => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        const payload = JSON.parse(JSON.stringify(el._payload));
        payload.series.houseActual = [];
        payload.availability.hasHouseActual = false;
        el._payload = payload;
        el.requestUpdate();
        await el.updateComplete;
    });
    await selectSlot(page, "12:00");

    const chips = await page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const card = [...(root?.querySelectorAll(".metric-card") ?? [])].find(
            (node) => (node.querySelector(".metric-label")?.textContent ?? "").trim() === "House",
        );
        return [...(card?.querySelectorAll(".metric-chip") ?? [])].map((node) => ({
            title: node.getAttribute("title") ?? "",
            // The hatched fill is the forecast's, the flat wash the actual's.
            hatched: (node.getAttribute("style") ?? "").includes("repeating-linear-gradient"),
        }));
    });

    expect(chips).toHaveLength(1);
    expect(chips[0].hatched).toBe(false);
});

/** Seed a house breakdown with one schedulable consumer in every native slot. */
async function seedHouseBreakdown(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        const payload = JSON.parse(JSON.stringify(el._payload));
        const slots: any[] = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            slots.push({
                slot: `${hh}:${mm}`,
                unmeasuredWh: 40,
                appliances: [{
                    entityId: "sensor.boiler_power",
                    label: "Boiler",
                    wh: 60,
                    switchEntityId: "switch.boiler",
                    powerEntityId: "sensor.boiler_power",
                    deferrable: true,
                    controllableIds: ["boiler"],
                }],
            });
        }
        payload.series.houseActualBreakdown = slots;
        payload.availability.hasHouseActualBreakdown = true;
        el._payload = payload;
        el.requestUpdate();
        await el.updateComplete;
    });
}

test("a hidden schedule strip keeps the editor the house badges open", async ({ page }) => {
    // The breakdown draws device boxes through the power-devices container, and
    // those carry schedule badges that open the day editor. They follow the
    // house series, not the strip -- so hiding the strip alone must not leave a
    // visible badge with nothing behind it.
    await mountCard(page, { hide_schedule_strip: true });
    await seedEverySeries(page);
    await seedHouseBreakdown(page);
    await selectSlot(page, "12:00");

    // The badge is three shadow roots down, inside the device box the breakdown
    // draws, so the demonstration is a deep walk rather than a flat query.
    const badges = await page.evaluate(() => {
        const found: string[] = [];
        const walk = (node: ParentNode) => {
            for (const child of node.querySelectorAll("*")) {
                if (child.tagName.toLowerCase() === "helman-schedule-badge") {
                    found.push(child.tagName.toLowerCase());
                }
                const shadow = (child as HTMLElement).shadowRoot;
                if (shadow) walk(shadow);
            }
        };
        walk(document.querySelector("helman-solar-inspector-card")!.shadowRoot!);
        return found;
    });
    expect(badges.length).toBeGreaterThan(0);

    const rows = await rowsPresent(page);
    expect(rows.schedule).toBe(false);
    expect(rows.editorHost).toBe(true);
});

test("dropping the house series too takes the editor host with them", async ({ page }) => {
    await mountCard(page, SOLAR_ONLY);
    await seedEverySeries(page);
    await seedHouseBreakdown(page);
    await selectSlot(page, "12:00");

    const rows = await rowsPresent(page);
    expect(rows.schedule).toBe(false);
    // Nothing left that can reach the editor, so it is not mounted at all.
    expect(rows.editorHost).toBe(false);
});

/** The hover popup's rows for one slot, as label plus which columns it quotes. */
function tooltipRows(page: Page, slot: string): Promise<
    { label: string; actual: boolean; forecast: boolean }[]
> {
    return page.evaluate((wanted) => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        return el._chartTooltipModel(el._payload, wanted).rows.map((row: any) => ({
            label: row.label,
            actual: row.actual !== null,
            forecast: row.forecast !== null,
        }));
    }, slot);
}

test("the hover popup quotes only the series the config allows", async ({ page }) => {
    await mountCard(page, {});
    await seedEverySeries(page);
    // Present by default, so their absence below is the allowlist's doing.
    expect((await tooltipRows(page, "12:00")).map((row) => row.label))
        .toEqual(expect.arrayContaining(["Solar production", "House", "Grid", "Battery"]));

    await reconfigure(page, SOLAR_ONLY);

    const labels = (await tooltipRows(page, "12:00")).map((row) => row.label);
    expect(labels).toContain("Solar production");
    expect(labels).not.toContain("House");
    expect(labels).not.toContain("Grid");
    expect(labels).not.toContain("Battery");
});

test("an actual-only pair quotes no forecast column in the popup", async ({ page }) => {
    await mountCard(page, { chart_series: ["actual", "gridActual"] });
    await seedEverySeries(page);

    const grid = (await tooltipRows(page, "12:00")).find((row) => row.label === "Grid");
    expect(grid).toBeDefined();
    expect(grid!.actual).toBe(true);
    // The forecast half was left out, so the row keeps the column it can speak for.
    expect(grid!.forecast).toBe(false);
});

test("an aggregate view keeps the editor its own badges open", async ({ page }) => {
    // `chart_series` governs the day chart alone, so the month view still draws
    // its house breakdown -- and the schedule badges on it.
    await mountCard(page, SOLAR_ONLY);
    await seedEverySeries(page);
    expect((await rowsPresent(page)).editorHost).toBe(false);

    await page.evaluate(async () => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        el._viewMode = "month";
        el.requestUpdate();
        await el.updateComplete;
    });

    expect((await rowsPresent(page)).editorHost).toBe(true);
});

/** The x range the chart is currently cropped to, in minutes of the day. */
function chartWindow(page: Page): Promise<{ start: number; end: number; daylightOnly: boolean }> {
    return page.evaluate(() => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        return {
            start: el._layout.dayStartMinutes,
            end: el._layout.dayEndMinutes,
            daylightOnly: el._daylightOnly,
        };
    });
}

test("a solar series that is allowed but not drawn does not crop the day", async ({ page }) => {
    // `raw` is hidden by default, so this card allows a solar series and draws
    // none: cropping to solar hours would hide the hours its house series lives in.
    await mountCard(page, { chart_series: ["raw", "houseActual"] });
    await seedEverySeries(page);
    // The seed is flat across the day, which is above the daylight threshold
    // everywhere and so crops to nothing; give raw real solar hours instead.
    await page.evaluate(async () => {
        const root = (window as unknown as {
            __inspectorRoot: () => ShadowRoot | null | undefined;
        }).__inspectorRoot();
        const el = root?.host as any;
        const payload = JSON.parse(JSON.stringify(el._payload));
        payload.series.raw = Array.from({ length: 24 }, (_, hour) => ({
            timestamp: `${payload.date}T${String(hour).padStart(2, "0")}:00:00`,
            valueWh: hour >= 9 && hour < 15 ? 400 : 0,
        }));
        el._payload = payload;
        el.requestUpdate();
        await el.updateComplete;
    });

    const hidden = await chartWindow(page);
    expect(hidden.daylightOnly).toBe(true);
    expect(hidden).toMatchObject({ start: 0, end: 1440 });

    // With the raw overlay actually drawn, it crops as it always did.
    await reconfigure(page, { chart_series: ["raw", "houseActual"], show_bias_ratio: true });
    const drawn = await chartWindow(page);
    expect(drawn.end - drawn.start).toBeLessThan(1440);
});
