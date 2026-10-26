import { prepareNodeDetailPage, mountSimpleCard, liveFigures } from "./support/node-detail-harness";
import { cardTree, forecastPayload } from "./support/payload-builders";
import type { ForecastPayload } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";

/**
 * The grid node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the grid overview and its voltage
 * and flows sections), today's span aggregates and the forecast. What is
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
    /** Today's flows section: a fixed day, or the reports' reason for none. */
    flowsUnavailable?: string;
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
        const entities: Record<string, string | null> = { today_import: "sensor.today_import", today_export: "sensor.today_export" };
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
            sections: profile ? ["voltage"] : [],
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
                series: [
                    slot(`${day}T12:00:00+00:00`, 0, 0.3),
                    slot(`${day}T12:15:00+00:00`, 0, 0.3),
                    slot(`${day}T15:00:00+00:00`, 0.4, 0),
                ],
            },
        };
        const flowsSection = window.__flowsSection("grid", { unavailable: v.flowsUnavailable ?? null, ...(v.flowsUnavailable ? { flows: null } : {}) });
        const inverter = window.__inverterOverview({ entities: v.ratedPower ? { rated_power: "sensor.solax_inverter_power_type" } : {} });
        window.__GridHass = window.__configureNodeDetail({
            states, tree, overviews: { grid: overview, inverter }, sections: { grid: { flows: flowsSection, voltage: v.sectionFails ? "error" : section, money } }, forecast,
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
    await expect(c.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
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
    await expect(gauge.locator(".figure")).toHaveText(["100 W 9 %", "1.0 kW 91 %"]);
    expect(await liveFigures(page, "node-detail-grid-content", "grid")).toMatchObject({ card: 1100, gauge: 1100 });
});

test("grid gauge stays away while the headline is idle", async ({ page }) => {
    await mount(page, { grid: "0", solar: "0", house: "83", battery: "0" });
    await page.locator(".node-cell:has(simple-card-grid)").click();
    const c = content(page);
    await expect(c.locator("helman-detail-headline")).toContainText("not exchanging with the grid now");
    await expect(c.locator("helman-flow-gauge")).toBeHidden();
    expect(await liveFigures(page, "node-detail-grid-content", "grid")).toMatchObject({ card: 0, gauge: 0 });
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
    await expect(content(page).locator("helman-flow-gauge")).toHaveCount(0);
});
