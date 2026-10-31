import { prepareNodeDetailPage, mountSimpleCard, liveFigures, onDashboard, expectShowMore } from "./support/node-detail-harness";
import { cardTree, forecastPayload } from "./support/payload-builders";
import type { ForecastPayload } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The grid node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the grid overview and its voltage
 * and money sections), today's span aggregates and the forecast. What is
 * pinned is the shared visual language (a status pill, the phase picture, the
 * Now/Today flow around the pylon, answer tiles), the disclosure contract (the
 * pictures open the questions they absorb, one open answer under the tiles,
 * answer then evidence, the voltage read on opening for the picture, today's
 * flows only once Today is chosen) and the grid's truthfulness: voltages are
 * terminal readings against descriptive references, a missing range or
 * reading is said rather than drawn as zero, current is an estimate, and money
 * keeps its coverage.
 */


type Variant = {
    profile?: boolean;
    /** L3 voltage is unavailable live and has no sensor in the section. */
    l3Missing?: boolean;
    /** L2 voltage reads 0 V. */
    zeroVoltage?: boolean;
    noLimit?: boolean;
    condition?: "off_grid" | null;
    sectionFails?: boolean;
    /** Only half of today's exported kWh had a rate. */
    exportPartlyPriced?: boolean;
    /** The payload's current import price is from before the 12:00 boundary. */
    staleCurrentPrice?: boolean;
    noImportPrice?: boolean;
    noExportPrice?: boolean;
    /** The grid node's power sign: `-1` (the default) for a positive-is-import meter, `1` for positive-is-export. */
    gridSign?: 1 | -1;
    /** The planned export of the 12:00 slot, kWh; 0.3 by default. */
    firstSlotExportKwh?: number;
    /** The grid forecast's slots instead of the default three: HH:MM today (UTC), import and export kWh, and what caused them. */
    gridSlots?: Array<[time: string, imported: number, exported: number, cause?: object]>;
    /** The overview offers no power section (no grid power entity). */
    noPowerSection?: boolean;
    /** The grid power sensor reads unavailable. */
    gridUnavailable?: boolean;
    /** The solar, house and battery meters' states, W. */
    solar?: string;
    house?: string;
    battery?: string;
    /** The grid meter's state, W, negative exporting. */
    grid?: string;
    /** The inverter's rated power register, W; absent without one. */
    ratedPower?: string;
    /** The viewer is an admin. */
    admin?: boolean;
};

declare global {
    interface Window {
        __GridHass: any;
        __GridRequests: Array<{ type: string; node?: string; section?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate(({ v, tree, forecastDefaults }) => {
        const profile = v.profile !== false;
        const s = window.__nodeDetailState;
        // measured_power_l* reads positive while exporting.
        const telemetry: Record<string, [string, string, string?]> = {
            grid_power_l1: ["sensor.solax_measured_power_l1", "-400", "W"],
            grid_power_l2: ["sensor.solax_measured_power_l2", "1200", "W"],
            grid_power_l3: ["sensor.solax_measured_power_l3", "-150", "W"],
            ac_voltage_l1: ["sensor.solax_inverter_voltage_l1", "236.0", "V"],
            ac_voltage_l2: ["sensor.solax_inverter_voltage_l2", v.zeroVoltage ? "0" : "241.5", "V"],
            ac_voltage_l3: ["sensor.solax_inverter_voltage_l3", v.l3Missing ? "unavailable" : "238.2", "V"],
            grid_import: ["sensor.solax_grid_import", "0", "W"],
            grid_export: ["sensor.solax_grid_export", "650", "W"],
            grid_frequency: ["sensor.solax_grid_frequency", "50.01", "Hz"],
            run_mode: ["sensor.solax_run_mode", v.condition === "off_grid" ? "Off-Grid" : "Normal Mode"],
            export_limit: ["number.solax_export_control_user_limit", "9900", "W"],
            main_breaker_limit: ["number.solax_main_breaker_current_limit", v.noLimit ? "unavailable" : "25", "A"],
            grid_mode_runtime: ["sensor.solax_grid_mode_runtime", "32820.0", "h"],
            eps_mode_runtime: ["sensor.solax_eps_mode_runtime", "163.9", "h"],
        };
        const states: Record<string, unknown> = {
            "sensor.solar": s(v.solar ?? "4200", "W"), "sensor.grid": s(v.gridUnavailable ? "unavailable" : v.grid ?? "-650", "W"),
            "sensor.battery": s(v.battery ?? "-500", "W"), "sensor.house": s(v.house ?? "1200", "W"),
            "sensor.solax_inverter_power_type": s(v.ratedPower ?? "unknown", "W"),
            "sensor.today_import": s("8.4", "kWh"), "sensor.today_export": s("12600", "Wh"),
        };
        const entities: Record<string, string | null> = { power: "sensor.grid", today_import: "sensor.today_import", today_export: "sensor.today_export" };
        if (profile) {
            for (const [key, [entityId, state, unit]] of Object.entries(telemetry)) {
                entities[key] = entityId;
                states[entityId] = s(state, unit, { friendly_name: key.replace(/_/g, " ") });
            }
        }
        const overview = {
            node: "grid",
            asOf: "2026-10-21T12:00:00+00:00",
            profile: profile ? { id: "solax_inverter", label: "SolaX inverter" } : null,
            entities,
            phasePowerPolarity: profile ? "positive_is_export" : null,
            maxAllowedExportPower: 9900,
            condition: v.condition === "off_grid" ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: [...(profile ? ["money", "voltage"] : ["money"]), ...(v.noPowerSection ? [] : ["power"])],
        };
        const day = "2026-10-21";
        const phaseDay = (phase: number, base: number) => {
            const points = Array.from({ length: 144 }, (_, i) => {
                const minutes = i * 5;
                const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
                const mm = String(minutes % 60).padStart(2, "0");
                const mean = base + 4 * Math.sin((i / 144) * Math.PI * 2 + phase);
                return { start: `${day}T${hh}:${mm}:00+00:00`, mean, min: mean - 1.5, max: mean + 1.5, coverage: 1 };
            }).filter((_, i) => i < 40 || i > 52); // a gap in the morning
            return {
                entityId: `sensor.solax_inverter_voltage_l${phase}`, unit: "V", source: "history", extrema: "recorded",
                bucketMinutes: 5, points, mean: base, min: base - 5.5, minAt: `${day}T03:00:00+00:00`,
                max: base + 5.5, maxAt: `${day}T09:00:00+00:00`, coverage: 0.91,
            };
        };
        const section = {
            node: "grid", section: "voltage", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            phases: { "1": phaseDay(1, 236), "2": phaseDay(2, 240), "3": v.l3Missing ? null : phaseDay(3, 238) },
            spread: { phases: v.l3Missing ? [1, 2] : [1, 2, 3], max: 6.2, maxAt: `${day}T10:30:00+00:00`, coverage: 0.88 },
        };
        // Today so far in Helman's convention: importing 1.5 kW through the night, exporting 2 kW in the late morning.
        const powerDay = {
            entityId: "sensor.grid", unit: "W", source: "statistics", extrema: "bucket_statistics", bucketMinutes: 5,
            points: Array.from({ length: 144 }, (_, i) => {
                const ms = Date.parse(`${day}T00:00:00Z`) + i * 300_000;
                const hour = new Date(ms).getUTCHours();
                const mean = hour >= 9 ? 2000 : hour < 6 ? -1500 : 0;
                return { start: new Date(ms).toISOString().replace(".000Z", "+00:00"), mean, min: mean, max: mean, coverage: 1 };
            }),
            mean: null, min: -1500, minAt: null, max: 2000, maxAt: null, coverage: 1,
        };
        const power = {
            node: "grid", section: "power", asOf: "2026-10-21T12:00:00+00:00",
            period: { start: `${day}T00:00:00+00:00`, end: "2026-10-22T00:00:00+00:00" },
            power: powerDay, unit: "W",
        };
        const money = {
            node: "grid", section: "money", asOf: "2026-10-21T12:00:00+00:00", unavailable: null,
            priceUnit: "CZK/kWh",
            importKwh: 8.4, exportKwh: 12.6,
            importCost: 42.5, exportRevenue: v.exportPartlyPriced ? 9.45 : 18.9,
            importPricedKwh: 8.4, exportPricedKwh: v.exportPartlyPriced ? 6.3 : 12.6,
        };
        const slot = (iso: string, imported: number, exported: number) => ({
            timestamp: iso, durationHours: 0.25, importedFromGridKwh: imported, exportedToGridKwh: exported,
        });
        const forecast: ForecastPayload = {
            ...forecastDefaults,
            grid: {
                ...forecastDefaults.grid,
                status: "available", generatedAt: null, unit: "kWh",
                startedAt: null, partialReason: null, coverageUntil: null, scheduleAdjusted: true,
                currentImportPrice: v.noImportPrice ? null : v.staleCurrentPrice ? 3.0 : 4.2, importPriceUnit: "CZK/kWh",
                importPricePoints: v.noImportPrice ? [] : [
                    { timestamp: `${day}T12:00:00+00:00`, value: 4.2 },
                    { timestamp: `${day}T13:00:00+00:00`, value: 4.2 },
                    { timestamp: `${day}T14:00:00+00:00`, value: 5.1 },
                ],
                currentExportPrice: v.noExportPrice ? null : 1.5, exportPriceUnit: "CZK/kWh",
                exportPricePoints: v.noExportPrice ? [] : [{ timestamp: `${day}T12:00:00+00:00`, value: 1.5 }],
                series: v.gridSlots ? v.gridSlots.map(([time, imported, exported, cause]) => ({ ...slot(`${day}T${time}:00+00:00`, imported, exported), ...cause })) : [
                    slot(`${day}T12:00:00+00:00`, 0, v.firstSlotExportKwh ?? 0.3),
                    slot(`${day}T12:15:00+00:00`, 0, 0.3),
                    slot(`${day}T15:00:00+00:00`, 0.4, 0),
                ],
            },
        };
        const inverter = window.__inverterOverview({ entities: v.ratedPower ? { rated_power: "sensor.solax_inverter_power_type" } : {} });
        window.__GridHass = window.__configureNodeDetail({
            states, tree, overviews: { grid: overview, inverter }, sections: { grid: { voltage: v.sectionFails ? "error" : section, money, power } }, forecast,
            hass: v.admin ? { user: { is_admin: true } } : {},
        });
        window.__GridRequests = window.__NodeDetailRequests;
    }, { v: variant, tree: cardTree(variant.gridSign), forecastDefaults: forecastPayload() });
    await mountSimpleCard(page);
}



const content = (page: Page) => page.locator("node-detail-grid-content");

test("grid Overview shows the P1 detail layout", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const c = content(page);
    await expect(c.locator("[data-overview]")).toBeVisible();
    await expect(c.locator("helman-detail-headline")).toBeVisible();
    await expect(c.locator("[data-phase-picture]")).toBeVisible();
    await expect(c.locator("helman-flow-gauge")).toHaveCount(1);
});

test("grid Overview shows the off-grid warning", async ({ page }) => {
    await mount(page, { condition: "off_grid" });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const overview = content(page).locator("[data-overview]");
    await expect(overview).toContainText("off-grid operation");
});

test("grid shows price change and keeps phase picture passive", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const c = content(page);
    await expect(c.locator("[data-price]")).toContainText("to buy");
    await expect(c.locator("[data-price]")).toContainText("to sell");
    await expect(c.locator("[data-phase-picture]")).toBeVisible();
    await expect(c.locator("[data-phase-picture] button")).toHaveCount(0);
    await expect(c.locator("helman-help-tip")).toHaveCount(1);
});

test("grid Overview keeps import price and next change without an export price", async ({ page }) => {
    await mount(page, { noExportPrice: true });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const price = content(page).locator("[data-price]");
    await expect(price).toContainText("Price now 4.20 CZK/kWh to buy");
    await expect(price).toContainText("Changes at 14:00 to 5.10 CZK/kWh");
    await expect(price).not.toContainText("to sell");
});

test("grid Overview shows export price without an import price", async ({ page }) => {
    await mount(page, { noImportPrice: true });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const price = content(page).locator("[data-price]");
    await expect(price).toContainText("Price now 1.50 CZK/kWh to sell");
    await expect(price).not.toContainText("to buy");
    await expect(price).not.toContainText("Changes at");
});

test("grid Overview omits the price row when neither price is available", async ({ page }) => {
    await mount(page, { noImportPrice: true, noExportPrice: true });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    await expect(content(page).locator("[data-price]")).toHaveCount(0);
});

test("grid headline at about 0 W shows no arrow and a neutral idle caption", async ({ page }) => {
    await mount(page, { grid: "0", solar: "0", house: "0", battery: "0" });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const headline = content(page).locator("helman-detail-headline");
    await expect(headline).toContainText("not exchanging with the grid now");
    await expect(headline).not.toContainText("importing");
    const value = headline.locator("[data-headline]");
    await expect(value).not.toContainText("←");
    await expect(value).not.toContainText("→");
    const colors = await value.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--primary-text-color)";
        el.parentElement!.appendChild(probe);
        const primary = getComputedStyle(probe).color;
        probe.remove();
        return { value: getComputedStyle(el).color, primary };
    });
    expect(colors.value).toBe(colors.primary);
});

test("grid gauge adds up to the headline where the house meter disagrees with the grid meter", async ({ page }) => {
    // The split's grid edges are residuals of the other meters: 124 W to the house, 1000 W to the battery.
    await mount(page, { grid: "1100", solar: "0", house: "124", battery: "1000" });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const c = content(page);
    await expect(c.locator("helman-detail-headline [data-headline]")).toHaveText("← 1.1 kW");
    const gauge = c.locator("helman-flow-gauge");
    await expect(gauge.locator(".figure")).toHaveText(["0 W", "1.0 kW 91 %", "100 W 9 %"]);
    expect(await liveFigures(page, "node-detail-grid-content", "grid")).toMatchObject({ card: 1100, gauge: 1100 });
});

test("grid gauge mutes all three pills under a direction-neutral title while the headline is idle", async ({ page }) => {
    await mount(page, { grid: "0", solar: "0", house: "83", battery: "0" });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const c = content(page);
    await expect(c.locator("helman-detail-headline")).toContainText("not exchanging with the grid now");
    const gauge = c.locator("helman-flow-gauge");
    await expect(gauge.locator(".title")).toContainText("Flow · now");
    await expect(gauge.locator("button")).toHaveCount(3);
    await expect(gauge.locator("button[data-active]")).toHaveCount(0);
    for (const figure of await gauge.locator("button .figure").all()) await expect(figure).toHaveCSS("opacity", "0.4");
    expect(await liveFigures(page, "node-detail-grid-content", "grid")).toMatchObject({ card: 0, gauge: 0 });
});

test("grid gauge keeps its place and height when the grid switches from idle to importing", async ({ page }) => {
    await mount(page, { grid: "0", solar: "0", house: "83", battery: "0" });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const c = content(page);
    const gauge = c.locator("helman-flow-gauge");
    await expect(gauge.locator("button")).toHaveCount(3);
    const idle = await gauge.boundingBox();
    await page.evaluate(() => {
        const card = document.querySelector("helman-simple-card") as any;
        const hass = window.__NodeDetailHass;
        const states = { ...hass.states, "sensor.grid": { ...hass.states["sensor.grid"], state: "1200" }, "sensor.house": { ...hass.states["sensor.house"], state: "1200" } };
        window.__NodeDetailHass = { ...hass, states };
        card.hass = window.__NodeDetailHass;
    });
    await expect(gauge.locator("button[data-active]")).not.toHaveCount(0);
    await expect(gauge.locator("button")).toHaveCount(3);
    await expect(gauge.locator(".title")).toContainText("Going to · now");
    const importing = await gauge.boundingBox();
    expect(importing).toEqual(idle);
});

test("grid price tile bolds each price and keeps each one whole", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const price = content(page).locator("[data-price] .row").first();
    await expect(price.locator(".price-part")).toHaveCount(2);
    await expect(price.locator(".price-part b")).toHaveCount(2);
    await expect(price.locator(".price-part").first()).toHaveCSS("display", "inline-block");
});

test("grid Overview says unavailable, not a direction, when the grid power sensor is unavailable", async ({ page }) => {
    await mount(page, { gridUnavailable: true });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const headline = content(page).locator("helman-detail-headline");
    await expect(headline).toContainText("unavailable");
    await expect(headline).not.toContainText(/exporting|importing/i);
    await expect(headline).not.toContainText(/[←→]/);
    const gauge = content(page).locator("helman-flow-gauge");
    await expect(gauge.locator(".title")).toContainText("Flow · now");
    await expect(gauge.locator("button")).toHaveCount(3);
    await expect(gauge.locator("button[data-active]")).toHaveCount(0);
    for (const figure of await gauge.locator("button .figure").all()) await expect(figure).toHaveCSS("opacity", "0.4");
});

// Forecast -------------------------------------------------------------------

test("grid Forecast header names the cheapest stretch, and the body the dearest one and the planned grid use", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const section = content(page).locator("helman-detail-section[data-forecast]");
    // 4.20 from 12:00 and again from 13:00, 5.10 from 14:00 for the hour the previous price held.
    await expect(section.locator("[slot=summary]")).toHaveText("Cheapest 12:00–14:00 · 4.20 CZK/kWh");
    await expect(section.locator("[slot=summary] b")).toHaveText(["12:00–14:00", "4.20 CZK/kWh"]);
    await expect(section.locator("[data-forecast-body]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=cheapest] .value")).toHaveText("12:00–14:00 · 4.20 CZK/kWh");
    await expect(section.locator("[data-row=dearest] .value")).toHaveText("14:00–15:00 · 5.10 CZK/kWh");
    const planned = section.locator("[data-planned] [data-run]");
    await expect(planned).toHaveCount(2);
    await expect(planned.nth(0)).toContainText("12:00–12:30");
    await expect(planned.nth(0)).toContainText("Export ≈ 0.60 kWh");
    await expect(planned.nth(1)).toContainText("15:00–15:15");
    await expect(planned.nth(1)).toContainText("Import ≈ 0.40 kWh");
    // The price chart follows the power chart.
    await expect(section.locator("[data-chart-title]").nth(1)).toContainText("Buy price · today → tomorrow noon");
    const chart = section.locator("helman-day-line-chart").nth(1);
    await expect(chart.locator("path.line")).toHaveCount(1);
    await expect(chart.locator("[data-span]")).toHaveCount(1);
    await expect(chart.locator("[data-now]")).toHaveCount(1);
});

test("grid planned use counts only what is left of the slot in progress", async ({ page }) => {
    await mount(page, { firstSlotExportKwh: 0.75 });
    await page.clock.setFixedTime(new Date("2026-10-21T12:14:00Z"));
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const section = content(page).locator("helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    // One minute of the 12:00 slot's 0.75 kWh is 0.05 kWh, plus the 12:15 slot's 0.3 kWh.
    await expect(section.locator("[data-planned] [data-run]").nth(0)).toContainText("Export ≈ 0.35 kWh");
});

test("grid planned use says why each stretch flows, and a change of reason starts a new row", async ({ page }) => {
    const exportPrice = { setBy: "automation", optimizer: "export_price" };
    await mount(page, { gridSlots: [
        ["12:00", 0, 0.3, exportPrice],
        ["12:15", 0, 0.3, exportPrice],
        ["12:30", 0, 0.2, { hitMaxSoc: true }],
        ["12:45", 0, 0.1, { limitedByChargePower: true }],
        ["13:00", 0, 0.1, { hitMinSoc: false, hitMaxSoc: false, limitedByChargePower: false }],
        ["15:00", 0.4, 0, { hitMinSoc: true }],
        // A full battery does not explain an import.
        ["15:15", 0.2, 0, { hitMaxSoc: true }],
        ["16:00", 0.3, 0, { setBy: "user" }],
    ] });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const section = content(page).locator("helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    const planned = section.locator("[data-planned] [data-run]");
    expect(await planned.locator(".value").allInnerTexts()).toEqual([
        "Export ≈ 0.60 kWh · Export price",
        "Export ≈ 0.20 kWh · battery full",
        "Export ≈ 0.10 kWh · charge limit",
        "Export ≈ 0.10 kWh",
        "Import ≈ 0.40 kWh · battery empty",
        "Import ≈ 0.20 kWh",
        "Import ≈ 0.30 kWh · You",
    ]);
    await expect(planned.nth(0)).toContainText("12:00–12:30");
});

test("grid Forecast still charts the grid power without import prices", async ({ page }) => {
    await mount(page, { noImportPrice: true });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const section = content(page).locator("helman-detail-section[data-forecast]");
    await expect(section.locator("[slot=summary]")).toHaveText("Planned import ≈ 0.40 kWh");
    await section.locator("button").first().click();
    await expect(section.locator("helman-day-line-chart")).toHaveCount(1);
    await expect(section.locator("[data-chart-title]")).toContainText("Grid power · today → tomorrow noon");
    await expect(section.locator("[data-row=cheapest]")).toHaveCount(0);
    await expect(section.locator("[data-planned] [data-run]")).toHaveCount(2);
});

test("grid shows no Forecast without import prices and without a grid power entity", async ({ page }) => {
    await mount(page, { noImportPrice: true, noPowerSection: true });
    await openGrid(page);
    await expect(content(page).locator("helman-detail-section[data-forecast]")).toHaveCount(0);
});

test("grid Forecast opens on the power chart: actual import and export solid, the plan's dashed, with the now marker", async ({ page }) => {
    await mount(page);
    await openGrid(page);
    const section = content(page).locator("helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    const title = section.locator("[data-chart-title]").first();
    await expect(title).toContainText("Grid power · today → tomorrow noon");
    expect(await title.locator("helman-help-tip").evaluate((tip: any) => tip.explanation)).toContain("dashed lines are the import and export");
    const chart = section.locator("helman-day-line-chart[data-forecast-chart]").first();
    await expect(chart.locator("path.line")).toHaveCount(4);
    await expect(chart.locator("path.line.dashed")).toHaveCount(2);
    // Import is the payload's negative part, flipped, export its positive part, kW; the plan's slot energy is its average power at the slot's middle.
    expect(await chart.evaluate((el: any) => el.series.map((series: any) => [series.key, series.label, !!series.dashed,
        Math.max(...series.points.map((point: any) => point.v)), Math.min(...series.points.map((point: any) => point.v))])))
        .toEqual([
            ["import", "Import", false, 1.5, 0],
            ["import-forecast", "Import forecast", true, 1.6, 0],
            ["export", "Export", false, 2, 0],
            ["export-forecast", "Export forecast", true, 1.2, 0],
        ]);
    expect(await chart.evaluate((el: any) => el.series[3].points[0].t)).toBe(Date.parse("2026-10-21T12:07:30Z"));
    await expect(chart.locator("[data-now]")).toHaveCount(1);
});

test("grid Forecast opens HA's history of the grid meter from its power chart, and the price chart has no Show more", async ({ page }) => {
    await onDashboard(page);
    await mount(page);
    await openGrid(page);
    const section = content(page).locator("helman-detail-section[data-forecast]");
    await section.locator("button").first().click();
    await expect(section.locator("helman-day-line-chart")).toHaveCount(2);
    await expect(section.locator("[data-show-more]")).toHaveCount(1);
    await expectShowMore(page, section.locator("[data-show-more]"), ["sensor.grid"]);
});

// History & statistics, Technical details -------------------------------------

async function openGrid(page: Page): Promise<void> {
    await page.locator(".node-cell:has(simple-card-grid)").click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test("grid History header gives today's bought energy, collapsed; the body has the money and no power chart", async ({ page }) => {
    await mount(page);
    await openGrid(page);
    const section = content(page).locator("helman-detail-section[data-history]");
    await expect(section.locator("[slot=summary]")).toHaveText("8.4 kWh bought today");
    await expect(section.locator("[slot=summary] b")).toHaveText("8.4 kWh");
    await expect(section.locator("[data-history-body]")).toHaveCount(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=bought] .value")).toHaveText(/^8\.4 kWh · .*42/);
    await expect(section.locator("[data-row=sold] .value")).toHaveText(/^13 kWh · .*18/);
    await expect(section.locator("[data-row=net] .value")).toHaveText(/^−.*23/);
    expect(await section.locator("[data-row=net] helman-help-tip").evaluate((tip: any) => tip.explanation)).toBe("An estimate from the prices Helman knows, not your bill.");
    await expect(section.locator(".section-title", { hasText: "Last 24 hours" })).toHaveCount(0);
    // The power chart is in Forecast, the voltage in Technical details.
    await expect(section.locator("helman-day-line-chart")).toHaveCount(0);
    await expect(section.locator("[data-show-more]")).toHaveCount(0);
});

test("grid History starts with a pointer that opens the Forecast power chart", async ({ page }) => {
    await mount(page);
    await openGrid(page);
    const history = content(page).locator("helman-detail-section[data-history]");
    await history.locator("button").first().click();
    const pointer = history.locator("[data-history-body] > :first-child");
    await expect(pointer).toHaveAttribute("data-forecast-pointer", "");
    const forecast = content(page).locator("helman-detail-section[data-forecast]");
    await expect(forecast.locator("[data-forecast-body]")).toHaveCount(0);
    await pointer.click();
    await expect(forecast.locator("helman-day-line-chart[data-forecast-chart]").first()).toBeInViewport();
});

test("grid Technical details charts today's voltage per phase and opens HA's history of the phases", async ({ page }) => {
    await onDashboard(page);
    await mount(page, { admin: true });
    await openGrid(page);
    const section = content(page).locator("helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    const chart = section.locator("helman-day-line-chart[data-voltage-chart]");
    await expect(chart.locator("path.line")).toHaveCount(3);
    await expect(chart.locator("line.reference")).toHaveCount(1);
    await expect(section.locator("[data-row=voltage-range] .value")).toHaveText("230–246 V");
    await expectShowMore(page, section.locator("[data-show-more]"),
        ["sensor.solax_inverter_voltage_l1", "sensor.solax_inverter_voltage_l2", "sensor.solax_inverter_voltage_l3"]);
});

test("grid Technical details shows the export limits, the grid state and the phase currents to an admin", async ({ page }) => {
    await mount(page, { admin: true });
    await openGrid(page);
    const section = content(page).locator("helman-detail-section[data-technical]");
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=export-limit]")).toHaveCount(0);
    await expect(section.locator('[data-entities] [data-entity="number.solax_export_control_user_limit"]')).toHaveCount(1);
    await expect(section.locator("[data-row=export-cap]")).toHaveCount(1);
    await expect(section.locator("[data-row=grid-state] .value")).toContainText("Normal Mode");
    await expect(section.locator("[data-row^=current-l]")).toHaveCount(3);
    await expect(section.locator("[data-row=current-l2] .value")).toContainText("25.0 A");
});

test("grid Technical details is not rendered for a non-admin", async ({ page }) => {
    await mount(page);
    await openGrid(page);
    await expect(content(page).locator("helman-detail-section[data-history]")).toHaveCount(1);
    await expect(content(page).locator("helman-detail-section[data-technical]")).toHaveCount(0);
});
