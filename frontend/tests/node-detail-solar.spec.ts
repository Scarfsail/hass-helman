import { prepareNodeDetailPage, mountSimpleCard, liveFigures } from "./support/node-detail-harness";
import { cardTree, forecastPayload, scheduleSlots } from "./support/payload-builders";
import type { ForecastPayload, ForecastStatus, ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import { formatKwh } from "../cards/shared/format";

/**
 * The solar node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the solar overview, its three
 * sections and its flows), the schedule and the forecast, at the fixed clock
 * (12:00 UTC). What is pinned is the shared visual language (a status pill,
 * the production curve, the Now/Today flow from the strings around the panel,
 * answer tiles), the disclosure contract (the pictures open the questions
 * they absorb, one open answer under the tiles, today's production read on
 * opening, today's flows and the strings' energy only once Today is chosen)
 * and the solar answers' honesty: actual and forecast compared over the same
 * elapsed slots, gaps kept as gaps, night
 * without a failure, a zero forecast without a percentage, an export cap and
 * DC above the AC rating without a curtailment or clipping claim, unequal
 * strings without a fault, and unresolved solar kept rather than forced into a
 * destination.
 */


const DAY = "2026-10-21";
const DAY_START = Date.parse(`${DAY}T00:00:00Z`);
const SLOT_MS = 15 * 60_000;
const NOW = Date.parse(`${DAY}T12:00:00Z`);
/** Days 0..5 have a forecast; the seventh day of the outlook has none. */
const DAY_FACTORS = [1, 1.1, 0.4, 0.8, 1, 0.6];
const CORRECTION = 0.9;
const ACTUAL_SHARE = 0.92;

type Variant = {
    profile?: boolean;
    /** The solar meter's state, W. */
    power?: string;
    /** The sun is up from 13:00 to 20:00, so 12:00 is before sunrise. */
    night?: boolean;
    exportLimit?: string;
    forecastFails?: boolean;
    /** The forecast's status, as at startup. */
    forecastStatus?: ForecastStatus;
    /** The destinations: complete with some unresolved, battery-only export, or unavailable. */
    destinations?: "normal" | "batteryExport" | "unavailable";
    /** The production section's request fails. */
    sectionFails?: boolean;
    /** The inverter reports off-grid operation. */
    offGrid?: boolean;
    /** No five-minute bucket has both strings recorded yet. */
    noCommonStrings?: boolean;
    /** The solar power sensor's unit. */
    powerUnit?: string;
    /** The grid imports while the battery charges. */
    gridImporting?: boolean;
    /** The profile maps one string only. */
    singleString?: boolean;
    /** The production section's sensor is in a unit that is not power. */
    productionUnit?: boolean;
    /** The house and battery meters' states, W. */
    house?: string;
    battery?: string;
    /** Today's flows section: the reports' reason for none. */
    flowsUnavailable?: string;
};

/** Raw forecast Wh for the slot starting at `ms`. */
function rawWh(ms: number, night: boolean): number {
    const day = Math.floor((ms - DAY_START) / 86_400_000);
    const factor = DAY_FACTORS[day];
    if (factor === undefined) return NaN;
    const hour = ((ms - DAY_START) % 86_400_000) / 3_600_000;
    const [rise, set] = night ? [13, 20] : [6, 18];
    return hour >= rise && hour < set ? Math.round(1650 * factor * Math.sin(Math.PI * (hour - rise) / (set - rise))) : 0;
}

function forecastPoints(night: boolean) {
    const raw: Array<{ timestamp: string; value: number }> = [];
    const adjusted: Array<{ timestamp: string; value: number }> = [];
    const actual: Array<{ timestamp: string; value: number }> = [];
    for (let ms = DAY_START; ; ms += SLOT_MS) {
        const wh = rawWh(ms, night);
        if (Number.isNaN(wh)) break;
        const timestamp = new Date(ms).toISOString().replace(".000Z", "+00:00");
        raw.push({ timestamp, value: wh });
        adjusted.push({ timestamp, value: wh * CORRECTION });
        if (ms + SLOT_MS <= NOW) actual.push({ timestamp, value: wh * CORRECTION * ACTUAL_SHARE });
    }
    return { raw, adjusted, actual };
}

declare global {
    interface Window {
        __SolarHass: any;
        __SolarRequests: Array<{ type: string; node?: string; section?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate(({ v, points, tree, forecastDefaults, scheduleDefaults }) => {
        const profile = v.profile !== false;
        const s = window.__nodeDetailState;
        const night = !!v.night;
        const telemetry: Record<string, [string, string, string?]> = {
            pv_power_1: ["sensor.solax_pv_power_1", night ? "0" : "2400", "W"],
            pv_power_2: ["sensor.solax_pv_power_2", night ? "0" : "1800", "W"],
            pv_voltage_1: ["sensor.solax_pv_voltage_1", "412.3", "V"],
            pv_voltage_2: ["sensor.solax_pv_voltage_2", "388.1", "V"],
            pv_current_1: ["sensor.solax_pv_current_1", "5.8", "A"],
            pv_current_2: ["sensor.solax_pv_current_2", "4.6", "A"],
            shade_fix_pv1: ["select.solax_shadow_fix_function_level_pv1_gmppt", "Off"],
            shade_fix_pv2: ["select.solax_shadow_fix_function_level_pv2_gmppt", "Off"],
            rated_power: ["sensor.solax_inverter_power_type", "10000", "W"],
            mppt_count: ["sensor.solax_inverter_mppt_count", "2"],
            pv_power_limit: ["number.solax_remotecontrol_pv_power_limit", "30000", "W"],
            export_limit: ["number.solax_export_control_user_limit", v.exportLimit ?? "9900", "W"],
            use_mode: ["select.solax_charger_use_mode", "Self Use Mode"],
            manual_mode: ["select.solax_manual_mode_select", "Stop Charge and Discharge"],
            run_mode: ["sensor.solax_run_mode", v.offGrid ? "Off-Grid" : "Normal Mode"],
        };
        const states: Record<string, unknown> = {
            "sensor.solar": s(v.power ?? (night ? "0" : "4200"), v.powerUnit ?? "W"),
            "sensor.grid": s(v.gridImporting ? "2000" : "-300", "W"),
            "sensor.battery": s(v.battery ?? "1500", "W"),
            "sensor.house": s(v.house ?? "1200", "W"),
            "sensor.solar_today": s(night ? "0.0" : "18.4", "kWh"),
            "sensor.export_today": s("7.6", "kWh"),
            "sensor.solar_total": s("51715.3", "kWh"),
        };
        const entities: Record<string, string | null> = {
            power: "sensor.solar", today_energy: "sensor.solar_today",
            today_export: "sensor.export_today", lifetime_energy: "sensor.solar_total",
        };
        if (v.singleString) {
            for (const key of ["pv_power_2", "pv_voltage_2", "pv_current_2", "shade_fix_pv2"]) delete telemetry[key];
        }
        if (profile) {
            for (const [key, [entityId, state, unit]] of Object.entries(telemetry)) {
                entities[key] = entityId;
                states[entityId] = s(state, unit, { friendly_name: key.replace(/_/g, " ") });
            }
        }
        const period = { start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00" };
        const overview = {
            node: "solar",
            asOf: "2026-10-21T12:00:00+00:00",
            profile: profile ? { id: "solax_inverter", label: "SolaX inverter" } : null,
            entities,
            strings: !profile ? [] : v.singleString ? [1] : [1, 2],
            configuredMaxPowerW: 11600,
            maxAllowedExportPower: 9900,
            condition: v.offGrid ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: profile && !v.singleString ? ["production", "strings", "destinations"] : ["production", "destinations"],
        };
        const day = (bucketsW: Array<[string, number]>) => ({
            entityId: "sensor.x", unit: "W", source: "statistics", extrema: "bucket_statistics", bucketMinutes: 5,
            points: bucketsW.map(([start, mean]) => ({ start, mean, min: mean, max: mean, coverage: 1 })),
            mean: null, min: 0, minAt: null,
            max: Math.max(...bucketsW.map(([, w]) => w)),
            maxAt: bucketsW.reduce((best, item) => (item[1] > best[1] ? item : best))[0],
            coverage: 0.98,
        });
        // Recorded from 06:00 with a gap from 10:00 to 11:00, the peak at 11:30.
        const recorded: Array<[string, number]> = [];
        for (let ms = Date.parse("2026-10-21T06:00:00Z"); ms < Date.parse("2026-10-21T12:00:00Z"); ms += 300_000) {
            const at = new Date(ms).toISOString().replace(".000Z", "+00:00");
            const hour = (ms - Date.parse("2026-10-21T00:00:00Z")) / 3_600_000;
            if (hour >= 10 && hour < 11) continue;
            recorded.push([at, night ? 0 : at === "2026-10-21T11:30:00+00:00" ? 7800 : Math.round(6000 * Math.sin(Math.PI * (hour - 6) / 12))]);
        }
        const production = {
            node: "solar", section: "production", asOf: "2026-10-21T12:00:00+00:00", period,
            unit: v.productionUnit ? "MJ" : "W",
            power: v.productionUnit ? null : day(recorded),
        };
        // Five-minute means along the morning's curve, the second string smaller.
        const curve = (peak: number): Array<[string, number]> => {
            const rows: Array<[string, number]> = [];
            for (let ms = Date.parse("2026-10-21T06:00:00Z"); ms < Date.parse("2026-10-21T12:00:00Z"); ms += 300_000) {
                const hour = (ms - Date.parse("2026-10-21T00:00:00Z")) / 3_600_000;
                rows.push([new Date(ms).toISOString().replace(".000Z", "+00:00"), Math.round(peak * Math.sin(Math.PI * (hour - 6) / 12))]);
            }
            return rows;
        };
        const strings = {
            node: "solar", section: "strings", asOf: "2026-10-21T12:00:00+00:00", period,
            strings: {
                "1": { entityId: "sensor.solax_pv_power_1", unit: "W", day: day(curve(3500)) },
                "2": { entityId: "sensor.solax_pv_power_2", unit: "W", day: day(curve(2400)) },
            },
            energy: {
                strings: { "1": { kwh: 10.9, coverage: 0.98 }, "2": { kwh: 7.1, coverage: 0.95 } },
                common: v.noCommonStrings
                    ? { strings: [1, 2], coverage: 0, kwh: { "1": 0, "2": 0 } }
                    : { strings: [1, 2], coverage: 0.93, kwh: { "1": 10.4, "2": 6.9 } },
            },
        };
        const charge = {
            chargedKwh: 6.0, solarKwh: 4.2, gridKwh: 1.5, unknownKwh: 0.3, gridPricedKwh: 1.0, gridTariffKwh: 0, gridUnpricedKwh: 0.5,
            solarPricedKwh: 4.2, solarUnpricedKwh: 0, paidRate: 4.0, forgoneRate: 1.2, paidCost: 4.0, forgoneValue: 5.04,
        };
        const destinationsDTO = v.destinations === "batteryExport"
            ? {
                producedKwh: 5.0, attributedKwh: 5.0, unattributedKwh: 0, houseKwh: 1.0, batteryKwh: 0, exportKwh: 0,
                unresolvedKwh: 4.0, measuredExportKwh: 3.0, otherExportKwh: 3.0,
            }
            : {
                producedKwh: 18.0, attributedKwh: 17.0, unattributedKwh: 1.0, houseKwh: 6.5, batteryKwh: 4.2, exportKwh: 5.8,
                unresolvedKwh: 1.5, measuredExportKwh: 7.4, otherExportKwh: 1.6,
            };
        const destinations = {
            node: "solar", section: "destinations", asOf: "2026-10-21T12:00:00+00:00", period,
            priceUnit: "CZK/kWh", complete: false,
            unavailable: v.destinations === "unavailable" ? "no_house_meter" : null,
            destinations: v.destinations === "unavailable" ? null : destinationsDTO,
            charge: v.destinations === "unavailable" ? null : charge,
        };
        const flows = {
            node: "solar", section: "flows", asOf: "2026-10-21T12:00:00+00:00", period,
            priceUnit: "CZK/kWh", complete: false, unavailable: v.flowsUnavailable ?? null,
            flows: v.flowsUnavailable ? null : {
                solarToHouse: 5.1, solarToBattery: 4.2, solarToGrid: 5.8, solarUnresolved: 0.4,
                gridToBattery: 1.5, unknownToBattery: 0.3, gridToBatteryCost: 4.0,
                batteryToHouse: 3.6, gridToHouse: 1.2, unknownToHouse: 0.1, batteryToGrid: 0,
            },
        };
        const sections: Record<string, unknown> = { production, strings, destinations, flows };
        const slots: ScheduleSlotDTO[] = [];
        const start = Date.parse("2026-10-21T11:45:00Z");
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = at.getUTCHours() + (at.getUTCDate() - 21) * 24;
            const action: ScheduleActionDTO = hour >= 12 && hour < 13 ? { kind: "stop_export", setBy: "automation" } : { kind: "normal", setBy: "automation" };
            slots.push({ id, controllables: { inverter: action } });
        }
        const schedule: SchedulePayload = {
            ...scheduleDefaults,
            executionEnabled: true,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: { actionKind: "apply", outcome: "success", executedAction: { kind: "stop_export" }, reason: "scheduled" } },
            },
        };
        const forecast: ForecastPayload = {
            ...forecastDefaults,
            solar: {
                ...forecastDefaults.solar,
                status: v.forecastStatus ?? "available", unit: "Wh",
                actualHistory: points.actual, points: points.raw, adjustedPoints: points.adjusted,
                biasCorrection: {
                    status: "applied", effectiveVariant: "adjusted",
                    explainability: { fallbackReason: null, trainedAt: "2026-10-21T03:00:00+00:00", usableDays: 21, droppedDays: 2 },
                },
            },
        };
        // The inspector's own day read, so its embeds draw the day they show.
        const wh = (rows: Array<{ timestamp: string; value: number }>) => rows.filter((row) => row.timestamp.startsWith("2026-10-21")).map((row) => ({ slot: row.timestamp.slice(11, 16), valueWh: row.value }));
        const sum = (rows: Array<{ valueWh: number }>) => rows.reduce((total, row) => total + row.valueWh, 0);
        const series = { raw: wh(points.raw), corrected: wh(points.adjusted), actual: wh(points.actual) };
        const inspectorDay = window.__inspectorDay({ date: "2026-10-21", timezone: "UTC", dataGranularityMinutes: 15, status: "applied", effectiveVariant: "adjusted",
            trainedAt: "2026-10-21T03:00:00+00:00",
            range: { minDate: "2026-10-01", maxDate: "2026-10-26", canGoPrevious: true, canGoNext: true, isToday: true, isFuture: false },
            series: { ...series, invalidated: [], factors: [], impact: [], houseForecast: [], houseActual: [], houseActualBreakdown: [],
                houseForecastBreakdown: [], batterySocForecast: [], batterySocActual: [], gridForecast: [], gridActual: [],
                batteryForecast: [], batteryActual: [], importPrice: [], exportPrice: [], moneyActual: [], moneyForecast: [],
            },
            totals: { rawWh: sum(series.raw), correctedWh: sum(series.corrected), actualWh: sum(series.actual),
                houseForecastWh: null, houseActualWh: null, gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null, moneyActual: null, moneyForecast: null,
            },
            availability: { hasProfile: false },
            batterySocBounds: [], priceUnit: null, trainingExplainability: null,
        });
        const inverter = window.__inverterOverview();
        window.__SolarHass = window.__configureNodeDetail({
            states, tree, overviews: { solar: overview, inverter }, sections: { solar: { ...sections, ...(v.sectionFails ? { production: "error" } : {}) } }, forecast: v.forecastFails ? "error" : forecast, schedule,
            replies: {
                "helman/solar_bias/inspector": inspectorDay,
                "helman/solar_bias/day_aggregates": { days: [] },
            },
        });
        window.__SolarRequests = window.__NodeDetailRequests;
    }, { v: variant, points: forecastPoints(!!variant.night), tree: cardTree(), forecastDefaults: forecastPayload(), scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await mountSimpleCard(page);
}


const content = (page: Page) => page.locator("node-detail-solar-content");

test("solar Overview shows the P1 detail layout", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-solar)").click();
    const c = content(page);
    await expect(c.locator("[data-overview]")).toBeVisible();
    await expect(c.locator("helman-detail-headline")).toContainText("4.2 kW");
    await expect(c.locator("helman-flow-gauge")).toHaveCount(1);
    await expect(c.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
    await expect(c.locator("helman-node-flow, helman-node-tile, helman-node-question")).toHaveCount(0);
});

test("solar headline, gauge and power card agree where the grid meter disagrees with the balance", async ({ page }) => {
    // 4.2 kW of solar, 1.2 kW of house and 1.5 kW of charge leave 1.5 kW to export; the grid meter reads 0.3 kW.
    await mount(page);
    await page.locator(".node-cell:has(simple-card-solar)").click();
    const figures = await liveFigures(page, "node-detail-solar-content", "solar");
    expect(figures).toMatchObject({ card: 4200, gauge: 4200 });
    expect(figures.headline).toContain("4.2 kW");
});

test("solar Overview shows the off-grid warning", async ({ page }) => {
    await mount(page, { offGrid: true });
    await page.locator(".node-cell:has(simple-card-solar)").click();
    const overview = content(page).locator("[data-overview]");
    await expect(overview).toContainText("off-grid operation");
});

test("solar names its inverter rating, shows both strings, and routes a destination", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-solar)").click();
    const c = content(page);
    await expect(c.locator("helman-detail-headline")).toContainText("42% of the 10.0 kW inverter rating");
    await expect(c.locator("[data-string]")).toHaveCount(2);
    await c.locator('helman-flow-gauge button').first().click();
    await expect(page.locator("node-detail-house-content, node-detail-battery-content, node-detail-grid-content")).toHaveCount(1);
});

test("solar headline opens its meter in Home Assistant", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => { (window as any).__headlineInfo = []; document.addEventListener("hass-more-info", (e: Event) => (window as any).__headlineInfo.push((e as CustomEvent).detail.entityId)); });
    await page.locator(".node-cell:has(simple-card-solar)").click();
    await content(page).locator("helman-detail-headline [data-headline]").click();
    expect(await page.evaluate(() => (window as any).__headlineInfo)).toContain("sensor.solar");
});

// Forecast -------------------------------------------------------------------

test("solar Forecast header says what is still to come today and tomorrow, and the body its key moments", async ({ page }) => {
    await mount(page);
    await page.locator(".node-cell:has(simple-card-solar)").click();
    const section = content(page).locator("helman-detail-section[data-forecast]");
    const points = forecastPoints(false).adjusted;
    const kwh = (from: number, to: number) => points.filter((point) => Date.parse(point.timestamp) >= from && Date.parse(point.timestamp) < to)
        .reduce((sum, point) => sum + point.value, 0) / 1000;
    const rest = kwh(NOW, DAY_START + 86_400_000);
    const tomorrow = kwh(DAY_START + 86_400_000, DAY_START + 2 * 86_400_000);
    await expect(section.locator("[slot=summary]")).toHaveText(`≈ ${formatKwh(rest)} kWh still to come · tomorrow ${formatKwh(tomorrow)} kWh`);
    await expect(section.locator("[slot=summary] b")).toHaveCount(2);
    await expect(section.locator("[data-forecast-body]")).toHaveCount(0);
    // The production section is the body's alone: read once the section opens.
    expect(await page.evaluate(() => window.__SolarRequests.filter((r) => r.section === "production").length)).toBe(0);
    await section.locator("button").first().click();
    await expect(section.locator("[data-row=total] .value")).toHaveText(`≈ ${formatKwh(18.4 + rest)} kWh (18 so far + ${formatKwh(rest)} to come)`);
    await expect(section.locator("[data-row=peak] .value")).toHaveText("5.9 kW at 12:00");
    await expect(section.locator("[data-row=ends] .value")).toHaveText("≈ 18:00");
    await expect(section.locator("[data-row=versus] .value")).toHaveText("8 % below");
    await expect(section.locator("[data-days] [data-day]")).toHaveCount(5);
    await expect(section.locator("[data-days] [data-day]").first()).toContainText(`${formatKwh(tomorrow)} kWh`);
    const chart = section.locator("helman-day-line-chart");
    await expect(chart.locator("path.line")).toHaveCount(2);
    await expect(chart.locator("path.line.dashed")).toHaveCount(1);
    await expect(chart.locator("line.reference")).toHaveCount(1);
    await expect(chart.locator(".reference-label")).toContainText("10.0 kW");
    expect(await section.locator("helman-help-tip").evaluate((tip: any) => tip.explanation)).toContain("over the last 21 days");
    expect(await page.evaluate(() => window.__SolarRequests.filter((r) => r.section === "production").length)).toBe(1);
});
