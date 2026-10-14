import { installMockHass } from "./support/mock-hass";
import { cardTree, forecastPayload, scheduleSlots } from "./support/payload-builders";
import type { ForecastPayload, ForecastStatus, ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";
import { CARD_BUNDLE } from "./support/card-page";
import { expectReducedMotionStill } from "./support/node-flow";

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

const SCREENS = process.env.SCREENS;

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

/** The forecast energy of today's slots from `from` on, kWh. */
function todayKwh(from: number, night = false): number {
    let total = 0;
    for (let ms = from; ms < DAY_START + 86_400_000; ms += SLOT_MS) total += rawWh(ms, night) * CORRECTION / 1000;
    return total;
}

declare global {
    interface Window {
        __SolarHass: any;
        __SolarRequests: Array<{ type: string; node?: string; section?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await installMockHass(page);
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(({ v, points, tree, forecastDefaults, scheduleDefaults }) => {
        const profile = v.profile !== false;
        const s = (state: string, unit?: string, attributes: Record<string, unknown> = {}) => ({
            state, attributes: { ...(unit ? { unit_of_measurement: unit } : {}), ...attributes },
        });
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
            currency: "CZK/kWh", complete: false,
            unavailable: v.destinations === "unavailable" ? "no_house_meter" : null,
            destinations: v.destinations === "unavailable" ? null : destinationsDTO,
            charge: v.destinations === "unavailable" ? null : charge,
        };
        const flows = {
            node: "solar", section: "flows", asOf: "2026-10-21T12:00:00+00:00", period,
            currency: "CZK/kWh", complete: false, unavailable: v.flowsUnavailable ?? null,
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
                status: v.forecastStatus ?? "available", unit: "Wh", resolution: "quarter_hour", horizonHours: 168,
                actualHistory: points.actual, points: points.raw, adjustedPoints: points.adjusted,
                biasCorrection: {
                    status: "applied", effectiveVariant: "adjusted",
                    explainability: { fallbackReason: null, trainedAt: "2026-10-21T03:00:00+00:00", usableDays: 21, droppedDays: 2 },
                },
            },
        };
        // The inspector's own day read, so its embeds draw the day they show.
        const wh = (rows: Array<{ timestamp: string; value: number }>) => rows.filter((row) => row.timestamp.startsWith("2026-10-21")).map((row) => ({ timestamp: row.timestamp, valueWh: row.value }));
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
            availability: { hasRawForecast: true, hasCorrectedForecast: true, hasActuals: true, hasInvalidated: false, hasProfile: false,
                hasHouseForecast: false, hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false, hasBatteryActual: false,
                hasImportPrice: false, hasExportPrice: false,
            },
            batterySocBounds: [], priceUnit: null, trainingExplainability: null,
        });
        const inverter = {
            node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: false, profile: null, mode: null,
            entities: {}, maxAllowedExportPower: 9900,
            agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, registers: [] },
            condition: null, sections: [],
        };
        window.__SolarRequests = [];
        window.__SolarHass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) => {
                    window.__SolarRequests.push({ type: msg.type });
                    if (msg.type === "helman/get_forecast" && v.forecastFails) throw new Error("forecast down");
                    return msg.type === "helman/get_forecast" ? forecast : {};
                },
                subscribeMessage: window.__mockHass().connection.subscribeMessage,
            },
            states,
            callWS: window.__mockHass({
                "helman/get_device_tree": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    return tree;
                },
                "helman/get_history": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    return { buckets: 3, bucket_duration: 60, entity_history: {} };
                },
                "helman/get_schedule": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    return schedule;
                },
                "helman/solar_bias/inspector": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    return inspectorDay;
                },
                "helman/solar_bias/day_aggregates": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    return { days: [] };
                },
                "helman/get_node_detail": async (msg: {
                    type: string;
                    node?: string;
                    section?: string;
                }) => {
                    if (msg.node === "inverter")
                        return inverter;
                    if (msg.section === "production" && v.sectionFails)
                        throw new Error("recorder down");
                    return msg.section ? sections[msg.section] : overview;
                }
            }, (msg: {
                type: string;
                node?: string;
                section?: string;
            }) => {
                window.__SolarRequests.push({ type: msg.type, node: msg.node, section: msg.section });
            }).callWS,
        };
    }, { v: variant, points: forecastPoints(!!variant.night), tree: cardTree(), forecastDefaults: forecastPayload(), scheduleDefaults: scheduleSlots({ slotMinutes: 15 }) });
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(async () => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = window.__SolarHass;
        document.body.appendChild(card);
    });
}

const solarCell = (page: Page) => page.locator(".node-cell:has(simple-card-solar)");
const content = (page: Page) => page.locator("node-detail-solar-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const tile = (page: Page, id: string) => page.locator(`helman-node-tile[data-question="${id}"]`);
const curve = (page: Page) => content(page).locator("[data-production-curve]");
const flow = (page: Page) => content(page).locator("helman-node-flow");
const flowLabel = (page: Page, side: "in" | "out", id: string) => flow(page).locator(`[data-side="${side}"] [data-flow="${id}"]`);
const sectionRequests = (page: Page) =>
    page.evaluate(() => window.__SolarRequests.filter((r) => r.type === "helman/get_node_detail" && r.node === "solar" && r.section).map((r) => r.section));

/** Open a question the way a reader does: its tile, or the picture that absorbed it. */
async function open(page: Page, id: string): Promise<void> {
    if (id === "production") await curve(page).click();
    else if (id === "destinations") await flow(page).locator("[data-side='out']").click();
    else if (id === "strings") await flow(page).locator("[data-glyph]").first().click();
    else await tile(page, id).locator("button").click();
    await expect(header(page, id)).toHaveAttribute("aria-expanded", "true");
}

async function openDetail(page: Page): Promise<void> {
    await solarCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

async function today(page: Page): Promise<void> {
    await flow(page).locator("[data-scope='today']").click();
    await expect(flow(page)).toHaveAttribute("data-flow-scope", "today");
}

/** As the card formats kWh. */
function kwh(value: number): string {
    const abs = Math.abs(value);
    return (abs >= 10 ? abs.toFixed(0) : abs >= 1 ? abs.toFixed(1) : abs.toFixed(2)) + " kWh";
}

test.describe("the solar overview", () => {
    test("opens on a status pill, the production curve, the Now flow from the strings and two closed tiles", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Producing 4.2 kW.");
        await expect(overview.locator(".status")).toHaveClass(/pill/);
        await expect(curve(page).locator("[data-actual]")).toHaveCount(1);
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
        await expect(flow(page).locator("[data-glyph='panel']")).toHaveAttribute("data-producing", "true");

        const ids = await content(page).locator("helman-node-tile").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["outlook", "limits"]);
        for (const id of ids) await expect(tile(page, id!).locator("button")).toHaveAttribute("aria-expanded", "false");
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card")).toHaveCount(0);
        // The curve's production is read on opening; nothing else until asked for.
        expect(await sectionRequests(page)).toEqual(["production"]);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await expect(content(page).locator("helman-tree-item")).toHaveCount(0);
    });

    test("tiles say the answer: tomorrow with the week's strip, and the AC rating with the input against it", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(tile(page, "outlook").locator(".value")).toHaveText(kwh(todayKwh(DAY_START) * 1.1));
        await expect(tile(page, "outlook").locator(".detail")).toHaveText("forecast for tomorrow");
        const days = tile(page, "outlook").locator("[data-strip-day]");
        await expect(days).toHaveCount(7);
        await expect(days.nth(1)).toHaveClass(/tomorrow/);
        // The seventh day has no forecast: an empty mark, never a zero bar.
        await expect(days.last()).toHaveClass(/none/);
        await expect(tile(page, "limits").locator(".value")).toHaveText("≤ 10.0 kW");
        await expect(tile(page, "limits").locator(".detail")).toHaveText("inverter AC rating");
        await expect(tile(page, "limits").locator("[data-limits-meter] .meter-fill")).toHaveAttribute("style", /width: 42\.0%/);
    });

    test("at night there is no production without a failure, the panel is dark and the outlook stays reachable", async ({ page }) => {
        await mount(page, { night: true });
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Not producing right now.");
        await expect(overview).not.toContainText(/fail|fault|error|problem/i);
        await expect(flow(page).locator("[data-glyph='panel']")).toHaveAttribute("data-producing", "false");
        await expect(curve(page).locator("[data-curve-caption]")).toContainText("no production was forecast");
        await expect(curve(page).locator("[data-curve-caption]")).toContainText("Forecast: production from around 13:15");
        await open(page, "production");
        const production = question(page, "production");
        await expect(production.locator("[data-row='difference']")).toContainText("no production was forecast: no percentage");
        await expect(production.locator("[data-row='now']")).toContainText("this slot's forecast is zero, so no percentage");
        await expect(production.locator("[data-row='remaining']")).toContainText(kwh(todayKwh(NOW, true)));
        await open(page, "outlook");
        await expect(question(page, "outlook").locator("[data-day]")).toHaveCount(7);
    });

    test("an unreadable solar sensor is no reading, never 0 W", async ({ page }) => {
        await mount(page, { power: "unavailable" });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("No solar power reading right now.");
    });
});

test("an unavailable forecast is no forecast, never zero production ahead", async ({ page }) => {
    await mount(page, { forecastStatus: "unavailable" });
    await openDetail(page);
    await expect(curve(page).locator("[data-forecast]")).toHaveCount(0);
    await expect(curve(page)).not.toContainText("No more production");
    await expect(curve(page).locator("[data-curve-caption]")).toHaveText("No solar forecast is available yet.");
    await expect(tile(page, "outlook").locator(".value")).toHaveText("–");
    await open(page, "production");
    await expect(question(page, "production")).toContainText("No solar forecast is available yet.");
});

test("a solar sensor in kW is converted, never read as watts", async ({ page }) => {
    await mount(page, { power: "4.2", powerUnit: "kW" });
    await openDetail(page);
    await expect(content(page).locator("[data-overview] .status")).toHaveText("Producing 4.2 kW.");
});

test("while the grid imports as the battery charges, PV's share of the charge is not claimed", async ({ page }) => {
    await mount(page, { gridImporting: true });
    await openDetail(page);
    await open(page, "destinations");
    await evidence(page, "destinations").click();
    await expect(question(page, "destinations").locator("[data-row='dc-battery']")).toContainText("not known");
});

test.describe("the curve's hours in Home Assistant's zone", () => {
    // The browser is five hours behind Home Assistant's UTC day.
    test.use({ timezoneId: "America/New_York" });

    test("ticks sit at the zone's 06, 12 and 18, not the browser's", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const ticks = curve(page).locator(".hours span");
        await expect(ticks).toHaveText(["06", "12", "18"]);
        await expect(ticks.nth(1)).toHaveAttribute("style", /left: 50\.00%/);
    });
});

test.describe("the production curve", () => {
    test("today's measured production against the forecast on the AC rating, gaps kept, with a now line; a tap opens production", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        // The morning gap from 10:00 to 11:00 splits the measured area in two.
        const actual = await curve(page).locator("[data-actual]").getAttribute("d");
        expect(actual!.split("M").length - 1).toBe(2);
        await expect(curve(page).locator("[data-forecast]")).toHaveCount(1);
        // The scale is the inverter's 10 kW AC rating, labelled, never called clipping.
        await expect(curve(page).locator("[data-rating]")).toHaveAttribute("data-w", "10000");
        await expect(curve(page).locator(".rating-label")).toHaveText("AC rating 10.0 kW");
        await expect(curve(page)).not.toContainText(/clipp/i);
        await expect(curve(page).locator("[data-now] line")).toHaveCount(1);
        await expect(curve(page).locator("[data-curve-caption]")).toHaveText("92 % of the forecast to 12:00 · Forecast: production until around 18:00");

        await curve(page).click();
        await expect(header(page, "production")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "production").locator("[data-row='peak']")).toContainText("7.8 kW around 11:30");
        // The answer reads the section the curve already has.
        expect(await sectionRequests(page)).toEqual(["production"]);
    });

    test("DC input above the AC rating widens the curve to fit, without a clipping claim", async ({ page }) => {
        await mount(page, { power: "11600" });
        await openDetail(page);
        await expect(curve(page).locator("[data-rating]")).toHaveCount(1);
        await expect(content(page)).not.toContainText(/clipp/i);
        await expect(tile(page, "limits").locator("[data-limits-meter] .meter-fill")).toHaveAttribute("style", /width: 100\.0%/);
    });

    test("a production read that fails says so and retries; the forecast caption stays", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await expect(content(page).locator("[data-curve-failed]")).toHaveText("Today's history could not be loaded.");
        await expect(curve(page).locator("[data-actual]")).toHaveCount(0);
        await expect(curve(page).locator("[data-curve-caption]")).toContainText("92 % of the forecast");
        await content(page).getByRole("button", { name: "Try again" }).first().click();
        await expect.poll(() => sectionRequests(page)).toEqual(["production", "production"]);
    });

    test("a production sensor in a unit that is not power draws the forecast only, and says why", async ({ page }) => {
        await mount(page, { productionUnit: true });
        await openDetail(page);
        await expect(content(page).locator("[data-curve-unit]")).toContainText("not a power unit");
        await expect(curve(page).locator("[data-actual]")).toHaveCount(0);
        await expect(curve(page).locator("[data-forecast]")).toHaveCount(1);
    });
});

test.describe("the flow", () => {
    test("Now by default: each string in, house, battery and grid out, from the card's live split", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Now · 12:00");
        await expect(flowLabel(page, "in", "string-1")).toContainText("2.4 kW");
        await expect(flowLabel(page, "in", "string-1")).toContainText("String 1");
        await expect(flowLabel(page, "in", "string-2")).toContainText("1.8 kW");
        // 4.2 kW covers the 1.2 kW house, charges 1.5 kW and exports the rest.
        await expect(flowLabel(page, "out", "house")).toContainText("1.2 kW");
        await expect(flowLabel(page, "out", "battery")).toContainText("1.5 kW");
        await expect(flowLabel(page, "out", "grid")).toContainText("1.5 kW");
        await expect(flow(page).locator("[data-ribbon]")).toHaveCount(5);
    });

    test("nothing flowing stays a greyed label at night", async ({ page }) => {
        await mount(page, { night: true });
        await openDetail(page);
        for (const [side, id] of [["in", "string-1"], ["in", "string-2"], ["out", "house"], ["out", "battery"], ["out", "grid"]] as const) {
            await expect(flowLabel(page, side, id)).toContainText("0 W");
            await expect(flowLabel(page, side, id)).toHaveClass(/none/);
        }
        await expect(flow(page).locator("[data-ribbon]")).toHaveCount(0);
    });

    test("Today is requested only once chosen: the strings' estimated energy in, and unresolved solar a footnote, never a ribbon", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page)).toEqual(["production"]);
        await today(page);
        await expect(flowLabel(page, "out", "house")).toContainText("5.1 kWh");
        await expect(flowLabel(page, "in", "string-1")).toContainText("≈ 11 kWh");
        await expect(flowLabel(page, "in", "string-2")).toContainText("≈ 7.1 kWh");
        expect((await sectionRequests(page)).sort()).toEqual(["flows", "production", "strings"]);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Today · 00:00–12:00");
        await expect(flowLabel(page, "out", "battery")).toContainText("4.2 kWh");
        await expect(flowLabel(page, "out", "grid")).toContainText("5.8 kWh");
        // Unresolved solar is said, and counted in what went out, but never drawn.
        await expect(flow(page).locator("[data-flow-note]")).toHaveText(["0.40 kWh of today's solar is not resolved to a destination."]);
        await expect(flow(page).locator("[data-side='out'] [data-flow]")).toHaveCount(3);
        const ribbons = await flow(page).locator("[data-side='out'] [data-ribbon]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ribbon")));
        expect(ribbons).toEqual(["house", "battery", "grid"]);
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 16 kWh");

        await flow(page).locator("[data-scope='now']").click();
        await expect(flowLabel(page, "in", "string-1")).toContainText("2.4 kW");
    });

    test("Today without reports says why, and a reopened dialog starts on Now", async ({ page }) => {
        await mount(page, { flowsUnavailable: "no_house_meter" });
        await openDetail(page);
        await today(page);
        await expect(flow(page).locator("[data-flow-note]")).toHaveText("Today's flows need the house meter the device reports read; it is not configured.");
        await expect(flowLabel(page, "out", "house")).toContainText("–");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("–");
        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await openDetail(page);
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
    });

    test("a single-string inverter draws one string input, Now and Today, without the strings section", async ({ page }) => {
        await mount(page, { singleString: true });
        await openDetail(page);
        await expect(flow(page).locator("[data-side='in'] [data-flow]")).toHaveCount(1);
        await expect(flowLabel(page, "in", "solar")).toContainText("4.2 kW");
        // No string comparison to open: the panel is a picture only.
        await expect(flow(page).locator("button[data-glyph]")).toHaveCount(0);
        await today(page);
        // Today's production, the solar edges and what stayed unresolved: 5.1 + 4.2 + 5.8 + 0.4.
        await expect(flowLabel(page, "in", "solar")).toContainText("16 kWh");
        await expect(flow(page).locator("[data-side='in'] [data-flow]")).toHaveCount(1);
        expect((await sectionRequests(page)).sort()).toEqual(["flows", "production"]);
    });

    test("tapping the flow opens the destinations, the panel the strings", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await flow(page).locator("[data-side='in']").click();
        await expect(header(page, "destinations")).toHaveAttribute("aria-expanded", "true");
        await flow(page).locator("button[data-glyph]").click();
        await expect(question(page, "destinations")).toHaveCount(0);
        await expect(header(page, "strings")).toHaveAttribute("aria-expanded", "true");
    });
});

test.describe("motion and the centre value", () => {
    test("Now: ribbons with energy shimmer, the glyph pulses and the production sits under it; Today stands still", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page)).toHaveAttribute("active", "");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("4.2 kW");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon='string-1']")).toHaveAttribute("data-animated", "");
        // Every drawn ribbon has energy on it, and shimmers.
        await expect(flow(page).locator("[data-ribbon]:not([data-animated])")).toHaveCount(0);

        await flow(page).locator("[data-scope='today']").click();
        // Produced: the destinations and the unresolved rest.
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("16 kWh");
        await expect(flow(page)).not.toHaveAttribute("active");
        await expect(flow(page).locator("[data-ribbon]").first()).toBeAttached();
        await expect(flow(page).locator("[data-animated]")).toHaveCount(0);
    });

    const cases: Array<[Variant, string, boolean]> = [
        [{ night: true }, "0 W", false],
        [{ power: "60" }, "60 W", true],
        [{ power: "50" }, "50 W", false],
        [{ power: "unavailable" }, "–", false],
        [{ power: "-60" }, "0 W", false],
    ];
    for (const [variant, value, active] of cases) {
        test(`${JSON.stringify(variant)} shows ${value} under the glyph, ${active ? "pulsing" : "still"}`, async ({ page }) => {
            await mount(page, variant);
            await openDetail(page);
            await expect(flow(page).locator("[data-centre-value]")).toHaveText(value);
            if (active) await expect(flow(page)).toHaveAttribute("active", "");
            else await expect(flow(page)).not.toHaveAttribute("active");
        });
    }

    test("reduced motion stops the shimmer and the pulse", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expectReducedMotionStill(page, flow(page));
    });
});

test.describe("production against the forecast", () => {
    test("the same elapsed period on both sides, the peak, the rest of the day and the projection; the bias only as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "production");
        const production = question(page, "production");
        const forecastKwh = todayKwh(DAY_START) - todayKwh(NOW);
        await expect(production.locator(".preview")).toHaveText("92 % of the forecast to 12:00");
        await expect(production.locator("[data-row='period']")).toContainText("Today 00:00–12:00");
        await expect(production.locator("[data-row='actual']")).toContainText(kwh(forecastKwh * ACTUAL_SHARE));
        await expect(production.locator("[data-row='forecast']")).toContainText("Forecast (bias-corrected)");
        await expect(production.locator("[data-row='forecast']")).toContainText(kwh(forecastKwh));
        await expect(production.locator("[data-row='difference']")).toContainText("92 % (−");
        await expect(production.locator("[data-row='now']")).toContainText("4.2 kW, 71 % of this slot's forecast (5.9 kW)");
        await expect(production.locator("[data-row='peak']")).toContainText("7.8 kW around 11:30");
        await expect(production.locator("[data-row='projection']")).toContainText(kwh(18.4 + todayKwh(NOW)));
        expect(await sectionRequests(page)).toEqual(["production"]);

        const embeds = () => production.locator("helman-solar-inspector-card");
        await expect(embeds()).toHaveCount(1);
        const config = await embeds().first().evaluate((card: any) => card._config);
        expect(config.show_bias_ratio).toBe(false);
        expect(config.chart_series).toEqual(["actual", "corrected"]);

        await evidence(page, "production").click();
        await expect(production.locator("[data-row='raw']")).toContainText(kwh(forecastKwh / CORRECTION));
        await expect(production.locator("[data-row='correction']")).toContainText("× 0.90");
        await expect(production.locator("[data-row='bias-days']")).toContainText("21");
        const bias = production.locator("[data-bias-inspector] helman-solar-inspector-card");
        await expect(bias).toHaveCount(1);
        expect(await bias.evaluate((card: any) => card._config.show_bias_ratio)).toBe(true);
        expect(await bias.evaluate((card: any) => card._config.chart_series)).toEqual(["actual", "corrected", "raw"]);
    });

    test("a forecast that cannot be loaded says so and offers a retry", async ({ page }) => {
        await mount(page, { forecastFails: true });
        await openDetail(page);
        await open(page, "production");
        const production = question(page, "production");
        await expect(production.locator("[data-forecast-failed]")).toBeVisible();
        await expect(production.getByRole("button", { name: "Try again" }).first()).toBeVisible();
    });

    test("a peak that cannot be read says so and offers a retry, keeping the comparison", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await open(page, "production");
        const production = question(page, "production");
        await expect(production.locator("[data-row='peak']")).toContainText("could not be loaded");
        await expect(production.locator("[data-row='actual']")).toBeVisible();
        await expect(production.getByRole("button", { name: "Try again" })).toBeVisible();
    });
});

test.describe("where the solar went", () => {
    test("requested only when opened; an estimated split that keeps the unresolved share", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page)).toEqual(["production"]);
        await open(page, "destinations");
        const destinations = question(page, "destinations");
        await expect(destinations.locator("[data-row='produced']")).toContainText("18 kWh");
        expect(await sectionRequests(page)).toEqual(["production", "destinations"]);
        await expect(destinations.locator("[data-row='house']")).toContainText("6.5 kWh (36 %)");
        await expect(destinations.locator("[data-row='battery']")).toContainText("4.2 kWh (23 %)");
        await expect(destinations.locator("[data-row='export']")).toContainText("5.8 kWh (32 %)");
        await expect(destinations.locator("[data-row='export']")).toContainText("estimate");
        await expect(destinations.locator("[data-row='unresolved']")).toContainText("1.5 kWh (8 %)");
        await expect(destinations.locator(".preview")).toHaveText("home 6.5 kWh · battery 4.2 kWh · export ≈ 5.8 kWh");

        await evidence(page, "destinations").click();
        await expect(destinations.locator("[data-row='attributed']")).toContainText("94 % of production (17 kWh)");
        await expect(destinations.locator("[data-row='unattributed']")).toContainText("1.0 kWh");
        await expect(destinations.locator("[data-row='other-export']")).toContainText("1.6 kWh");
        await expect(destinations.locator("[data-row='meter-today']")).toContainText("18 kWh");
        await expect(destinations.locator("[data-row='dc-battery']")).toContainText("1.5 kW");
        await expect(destinations.locator("[data-row='dc-ac']")).toContainText("2.7 kW");
        await expect(destinations.locator("[data-row='forgone']")).toContainText("5.04 CZK");
        await expect(destinations.locator("[data-row='forgone']")).toContainText("not a payment");

        // Closed, its request is dropped; the curve's production stays.
        await open(page, "limits");
        await open(page, "destinations");
        await expect(destinations.locator("[data-row='produced']")).toContainText("18 kWh");
        expect(await sectionRequests(page)).toEqual(["production", "destinations", "destinations"]);
    });

    test("export the battery made is never solar export, and unexplained solar stays unresolved", async ({ page }) => {
        await mount(page, { destinations: "batteryExport" });
        await openDetail(page);
        await open(page, "destinations");
        const destinations = question(page, "destinations");
        await expect(destinations.locator("[data-row='export']")).toContainText("0.00 kWh");
        await expect(destinations.locator("[data-row='unresolved']")).toContainText("4.0 kWh");
        await expect(destinations).not.toContainText("−");
    });

    test("without reports the answer says why", async ({ page }) => {
        await mount(page, { destinations: "unavailable" });
        await openDetail(page);
        await open(page, "destinations");
        await expect(question(page, "destinations").locator("[data-destinations-unavailable]")).toContainText("Needs a house energy meter");
    });
});

test.describe("limits", () => {
    test("caps, the AC rating and the plan's intent as settings, never a curtailment figure", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "limits");
        const limits = question(page, "limits");
        await expect(limits.locator(".preview")).toHaveText("export ≤ 9.9 kW · PV ≤ 30.0 kW · AC rating 10.0 kW");
        await expect(limits.locator("[data-row='input']")).toContainText("4.2 kW (42 % of the AC rating)");
        await expect(limits.locator("[data-row='rating']")).toContainText("10.0 kW");
        await expect(limits.locator("[data-row='export-limit']")).toContainText("9.9 kW");
        await expect(limits.locator("[data-row='pv-limit']")).toContainText("30.0 kW");
        await expect(limits.locator("[data-row='intent']")).toContainText("Stop export");
        await expect(limits.locator("[data-above-rating]")).toHaveCount(0);
        await expect(limits).toContainText("not measured curtailment");

        await evidence(page, "limits").click();
        await expect(limits).toContainText("Which settings affect this?");
        await expect(limits.locator("[data-row='shade_fix_pv1']")).toContainText("Off");
        await expect(limits.locator("[data-row='mppt_count']")).toContainText("2");
        await expect(limits.locator("[data-row='flow-battery']")).toContainText("charging at 1.5 kW");
        await expect(limits.locator("[data-row='executor']")).toBeVisible();
    });

    test("DC input above the AC rating is context, not clipping", async ({ page }) => {
        await mount(page, { power: "11600" });
        await openDetail(page);
        await open(page, "limits");
        const limits = question(page, "limits");
        await expect(limits.locator("[data-above-rating]")).toContainText("this alone does not measure lost solar");
        await expect(limits).not.toContainText(/clipp/i);
        await expect(limits.locator(".exception, [data-exception]")).toHaveCount(0);
    });

    test("an export limit of 0 restricts export without a curtailment claim", async ({ page }) => {
        await mount(page, { exportLimit: "0" });
        await openDetail(page);
        await open(page, "limits");
        const limits = question(page, "limits");
        await expect(limits.locator("[data-export-zero]")).toContainText("does not by itself curtail solar");
        await expect(limits).not.toContainText(/clipp|curtailed|lost \d/i);
    });
});

test.describe("strings", () => {
    test("live and today's shares over a common period, unequal strings without fault styling", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "strings");
        const strings = question(page, "strings");
        await expect(strings.locator(".preview")).toHaveText("string 1 2.4 kW · string 2 1.8 kW");
        await expect(strings.locator("[data-row='now-1']")).toContainText("2.4 kW (57 %)");
        await expect(strings.locator("[data-row='share-1']")).toContainText("≈ 10 kWh (60 %)");
        await expect(strings.locator("[data-row='share-2']")).toContainText("≈ 6.9 kWh (40 %)");
        await expect(strings.locator("[data-row='common']")).toContainText("93 % of today");
        await expect(strings.locator("helman-day-line-chart")).toHaveCount(1);
        await expect(strings).toContainText("a difference between them is not a fault");
        await expect(strings).not.toContainText(/underperform|degraded|weak/i);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);

        await evidence(page, "strings").click();
        await expect(strings.locator("[data-string='1']")).toContainText("412.3 V");
        await expect(strings.locator("[data-row='coverage-2']")).toContainText("≈ 7.1 kWh, 95 % of today recorded");
        await expect(strings.locator("[data-normalization]")).toContainText("Not normalised");
    });
});

test.describe("the outlook", () => {
    test("seven calendar days of the corrected forecast, lifetime yield, and the kWp denominator as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "outlook");
        const outlook = question(page, "outlook");
        await expect(outlook.locator(".preview")).toHaveText(`Tomorrow ${kwh(todayKwh(DAY_START) * 1.1)}`);
        const days = outlook.locator("[data-day]");
        await expect(days).toHaveCount(7);
        await expect(days.first()).toContainText("Today (whole day)");
        await expect(days.first()).toContainText(kwh(todayKwh(DAY_START)));
        await expect(days.last()).toContainText("no forecast");
        await expect(outlook.locator("[data-row='lifetime']")).toContainText("51715 kWh");

        await evidence(page, "outlook").click();
        await expect(outlook.locator("[data-row='capacity']")).toContainText("11.6 kW");
        await expect(outlook.locator("[data-row='capacity']")).toContainText("not a measurement");
        await expect(outlook.locator("[data-row='per-kwp']")).toContainText("4458 kWh per configured kW");
        await expect(outlook.locator("[data-per-kwp-note]")).toContainText("not an annual yield");
    });
});

test.describe("disclosure and live data", () => {
    test("one open answer at a time under the tiles, evidence by keyboard, and a reopened dialog starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const limitsTile = tile(page, "limits").locator("button");
        await limitsTile.focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "true");
        await expect(limitsTile).toBeFocused();
        await evidence(page, "limits").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "limits").locator("[data-row='mppt_count']")).toBeVisible();

        await open(page, "outlook");
        await expect(limitsTile).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "limits")).toHaveCount(0);
        await expect(content(page).locator("helman-node-question")).toHaveCount(1);
        const tiles = await content(page).locator(".tiles").boundingBox();
        const answer = await question(page, "outlook").boundingBox();
        expect(answer!.y).toBeGreaterThanOrEqual(tiles!.y + tiles!.height);

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
    });

    test("live readings reach the open flow", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__SolarHass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.solax_pv_power_1": { state: "3000", attributes: { unit_of_measurement: "W" } } } };
        });
        await expect(flowLabel(page, "in", "string-1")).toContainText("3.0 kW");
    });
});

test("off-grid operation is the one exception, linked to the limits answer", async ({ page }) => {
    await mount(page, { offGrid: true });
    await openDetail(page);
    const exception = content(page).locator("[data-exception]");
    await expect(exception).toContainText("off-grid operation (Off-Grid)");
    await exception.locator("button").click();
    await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "true");
});

test("strings never recorded together compare nothing rather than a share", async ({ page }) => {
    await mount(page, { noCommonStrings: true });
    await openDetail(page);
    await open(page, "strings");
    const strings = question(page, "strings");
    await expect(strings.locator("[data-no-common]")).toContainText("No period yet in which every string was recorded");
    await expect(strings.locator("[data-row^='share-']")).toHaveCount(0);
});

test.describe("a Custom inverter", () => {
    test("keeps the questions its config can answer, with one solar input and Helman's export cap", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(flow(page).locator("[data-side='in'] [data-flow]")).toHaveCount(1);
        await expect(flowLabel(page, "in", "solar")).toContainText("4.2 kW");
        await expect(tile(page, "limits").locator(".value")).toHaveText("≤ 9.9 kW");
        await expect(tile(page, "limits").locator(".detail")).toHaveText("export limit");
        // Without the AC rating the curve is on the solar maximum, labelled as such.
        await expect(curve(page).locator(".rating-label")).toHaveText("configured max 5.0 kW");
        await open(page, "limits");
        await expect(question(page, "limits").locator(".preview")).toHaveText("export ≤ 9.9 kW");
        await expect(question(page, "limits")).toContainText("need a hardware profile");
        await expect(question(page, "limits").locator("[data-row='export-cap']")).toContainText("9.9 kW");
    });
});

/** The two states the review screenshots show: an evening without sun and a sunny midday. */
const STATES: Array<[string, Variant]> = [
    ["evening", { night: true, house: "1800", battery: "-1500" }],
    ["midday", {}],
];

test.describe("screenshots", { tag: "@screens" }, () => {
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        for (const [state, variant] of STATES) {
            test(`the ${state} overview, Today and opened answers at ${name}`, async ({ page }) => {
                await page.setViewportSize({ width, height });
                await mount(page, variant);
                await openDetail(page);
                await expect(curve(page).locator("[data-forecast]")).toHaveCount(1);
                await page.screenshot({ path: `${SCREENS}/solar-${state}-${name}-now.png`, fullPage: true });
                await today(page);
                await expect(flowLabel(page, "out", "house")).toContainText("kWh");
                await page.screenshot({ path: `${SCREENS}/solar-${state}-${name}-today.png`, fullPage: true });
                await open(page, "production");
                await expect(question(page, "production").locator("[data-row='peak']")).toBeVisible();
                await page.screenshot({ path: `${SCREENS}/solar-${state}-${name}-production.png`, fullPage: true });
                await open(page, "outlook");
                await page.screenshot({ path: `${SCREENS}/solar-${state}-${name}-outlook.png`, fullPage: true });
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                expect(overflow).toBeLessThanOrEqual(0);
            });
        }
    }
});
