import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";

/**
 * The solar node detail on the simple card.
 *
 * Mounted on the real `helman-simple-card` against a fake backend that answers
 * the device tree, `helman/get_node_detail` (the solar overview and its three
 * sections), the schedule and the forecast, at the fixed clock (12:00 UTC).
 * What is pinned is the shared disclosure contract and the solar answers'
 * honesty: actual and forecast compared over the same elapsed slots, night
 * without a failure, a zero forecast without a percentage, an export cap and
 * DC above the AC rating without a curtailment or clipping claim, unequal
 * strings without a fault, and unresolved solar kept rather than forced into a
 * destination.
 */

const BUNDLE = resolve(__dirname, "../../custom_components/helman/frontend_compiled/helman-card.js");
const SCREENS = process.env.P4_SCREENS;

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
        __hass: any;
        __requests: Array<{ type: string; node?: string; section?: string }>;
    }
}

async function mount(page: Page, variant: Variant = {}): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(({ v, points }) => {
        const profile = v.profile !== false;
        const node = (id: string, sensor: string, sourceType: string | null) => ({
            id, displayName: id, powerSensorId: sensor, ratioSensorId: null, switchEntityId: null,
            valueType: "default", sourceConfig: null, sourceType, isSource: sourceType !== null,
            isUnmeasured: false, groups: {}, groupBadgeTexts: [], icon: null, compact: false,
            showAdditionalInfo: false, childrenFullWidth: false, hideChildren: false,
            hideChildrenIndicator: false, sortChildrenByPower: false, deferrable: false,
            controllableIds: [], children: [],
        });
        const tree = {
            sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid", "grid"), node("battery", "sensor.battery", "battery")],
            consumers: [node("house", "sensor.house", null)],
            consumptionTotalSensorId: null,
            productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
        };
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
            "sensor.battery": s("1500", "W"),
            "sensor.house": s("1200", "W"),
            "sensor.solar_today": s(night ? "0.0" : "18.4", "kWh"),
            "sensor.export_today": s("7.6", "kWh"),
            "sensor.solar_total": s("51715.3", "kWh"),
        };
        const entities: Record<string, string | null> = {
            power: "sensor.solar", today_energy: "sensor.solar_today",
            today_export: "sensor.export_today", lifetime_energy: "sensor.solar_total",
        };
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
            strings: profile ? [1, 2] : [],
            configuredMaxPowerW: 11600,
            maxAllowedExportPower: 9900,
            condition: v.offGrid ? { kind: "off_grid", runMode: "Off-Grid", entityId: "sensor.solax_run_mode" } : null,
            sections: profile ? ["production", "strings", "destinations"] : ["production", "destinations"],
        };
        const day = (bucketsW: Array<[string, number]>) => ({
            entityId: "sensor.x", unit: "W", source: "statistics", extrema: "bucket_statistics", bucketMinutes: 5,
            points: bucketsW.map(([start, mean]) => ({ start, mean, min: mean, max: mean, coverage: 1 })),
            mean: null, min: 0, minAt: null,
            max: Math.max(...bucketsW.map(([, w]) => w)),
            maxAt: bucketsW.reduce((best, item) => (item[1] > best[1] ? item : best))[0],
            coverage: 0.98,
        });
        const production = {
            node: "solar", section: "production", asOf: "2026-10-21T12:00:00+00:00", period, unit: "W",
            power: day([["2026-10-21T11:00:00+00:00", 6100], ["2026-10-21T11:30:00+00:00", 7800], ["2026-10-21T11:35:00+00:00", 7200]]),
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
        const sections: Record<string, unknown> = { production, strings, destinations };
        const slots = [];
        const start = Date.parse("2026-10-21T11:45:00Z");
        for (let i = 0; i < 36 * 4; i += 1) {
            const at = new Date(start + i * 900_000);
            const id = at.toISOString().replace(".000Z", "+00:00");
            const hour = at.getUTCHours() + (at.getUTCDate() - 21) * 24;
            const action = hour >= 12 && hour < 13 ? { kind: "stop_export", setBy: "automation" } : { kind: "normal", setBy: "automation" };
            slots.push({ id, controllables: { inverter: action } });
        }
        const schedule = {
            executionEnabled: true,
            slots,
            runtime: {
                activeSlotId: "2026-10-21T12:00:00+00:00",
                controllables: { inverter: { actionKind: "apply", outcome: "success", executedAction: { kind: "stop_export" }, reason: "scheduled" } },
            },
        };
        const forecast = {
            solar: {
                status: "available", unit: "Wh", resolution: "quarter_hour", horizonHours: 168,
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
        const inspectorDay = {
            date: "2026-10-21", timezone: "UTC", dataGranularityMinutes: 15, status: "applied", effectiveVariant: "adjusted",
            trainedAt: "2026-10-21T03:00:00+00:00",
            range: { minDate: "2026-10-01", maxDate: "2026-10-26", canGoPrevious: true, canGoNext: true, isToday: true, isFuture: false },
            series: {
                ...series, invalidated: [], factors: [], impact: [], houseForecast: [], houseActual: [], houseActualBreakdown: [],
                houseForecastBreakdown: [], batterySocForecast: [], batterySocActual: [], gridForecast: [], gridActual: [],
                batteryForecast: [], batteryActual: [], importPrice: [], exportPrice: [], moneyActual: [], moneyForecast: [],
            },
            totals: {
                rawWh: sum(series.raw), correctedWh: sum(series.corrected), actualWh: sum(series.actual),
                houseForecastWh: null, houseActualWh: null, gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null, moneyActual: null, moneyForecast: null,
            },
            availability: {
                hasRawForecast: true, hasCorrectedForecast: true, hasActuals: true, hasInvalidated: false, hasProfile: false,
                hasHouseForecast: false, hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false, hasBatteryActual: false,
                hasImportPrice: false, hasExportPrice: false,
            },
            batterySocBounds: [], priceUnit: null, trainingExplainability: null,
        };
        const inverter = {
            node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: false, profile: null, mode: null,
            entities: {}, maxAllowedExportPower: 9900,
            agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, registers: [] },
            condition: null, sections: [],
        };
        window.__requests = [];
        window.__hass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) => {
                    window.__requests.push({ type: msg.type });
                    if (msg.type === "helman/get_forecast" && v.forecastFails) throw new Error("forecast down");
                    return msg.type === "helman/get_forecast" ? forecast : {};
                },
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string; node?: string; section?: string }) => {
                window.__requests.push({ type: msg.type, node: msg.node, section: msg.section });
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return schedule;
                if (msg.type === "helman/solar_bias/inspector") return inspectorDay;
                if (msg.type === "helman/solar_bias/day_aggregates") return { days: [] };
                if (msg.type === "helman/get_node_detail") {
                    if (msg.node === "inverter") return inverter;
                    if (msg.section === "production" && v.sectionFails) throw new Error("recorder down");
                    return msg.section ? sections[msg.section] : overview;
                }
                return {};
            },
        };
    }, { v: variant, points: forecastPoints(!!variant.night) });
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(async () => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = window.__hass;
        document.body.appendChild(card);
    });
}

const solarCell = (page: Page) => page.locator(".node-cell:has(simple-card-solar)");
const content = (page: Page) => page.locator("node-detail-solar-content");
const question = (page: Page, id: string) => page.locator(`helman-node-question[data-question="${id}"]`);
const header = (page: Page, id: string) => question(page, id).locator("button.header");
const evidence = (page: Page, id: string) => question(page, id).locator("button.evidence-toggle");
const sectionRequests = (page: Page) =>
    page.evaluate(() => window.__requests.filter((r) => r.type === "helman/get_node_detail" && r.node === "solar" && r.section).map((r) => r.section));

async function openDetail(page: Page): Promise<void> {
    await solarCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

/** As the card formats kWh. */
function kwh(value: number): string {
    const abs = Math.abs(value);
    return (abs >= 10 ? abs.toFixed(0) : abs >= 1 ? abs.toFixed(1) : abs.toFixed(2)) + " kWh";
}

test.describe("the solar overview", () => {
    test("opens compact: production now, today, actual vs forecast over the same period, the next change and five closed questions", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Producing 4.2 kW.");
        await expect(overview.locator(".figure")).toHaveCount(3);
        await expect(overview.locator("[data-figure='today']")).toContainText("18 kWh");
        // Recorded and forecast over the same elapsed slots, to 12:00: 92 %.
        await expect(overview.locator("[data-figure='vs-forecast']")).toContainText("Of forecast to 12:00");
        await expect(overview.locator("[data-figure='vs-forecast']")).toContainText("92 %");
        await expect(overview.locator("[data-figure='remaining']")).toContainText(kwh(todayKwh(NOW)));
        await expect(overview.locator("[data-next]")).toHaveText("Forecast: production until around 18:00");

        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["production", "destinations", "limits", "strings", "outlook"]);
        for (const id of ids) await expect(header(page, id!)).toHaveAttribute("aria-expanded", "false");
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card")).toHaveCount(0);
        expect(await sectionRequests(page)).toEqual([]);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        // The duplicate tree item is gone.
        await expect(content(page).locator("helman-tree-item")).toHaveCount(0);
    });

    test("answer previews say the answer", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(question(page, "production").locator(".preview")).toHaveText("92 % of the forecast to 12:00");
        await expect(question(page, "destinations").locator(".preview")).toHaveText("18 kWh produced today");
        await expect(question(page, "limits").locator(".preview")).toHaveText("export ≤ 9.9 kW · PV ≤ 30.0 kW · AC rating 10.0 kW");
        await expect(question(page, "strings").locator(".preview")).toHaveText("string 1 2.4 kW · string 2 1.8 kW");
        await expect(question(page, "outlook").locator(".preview")).toHaveText(`Tomorrow ${kwh(todayKwh(DAY_START) * 1.1)}`);
    });

    test("at night there is no production without a failure, and the outlook stays reachable", async ({ page }) => {
        await mount(page, { night: true });
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Not producing right now.");
        await expect(overview).not.toContainText(/fail|fault|error|problem/i);
        // A zero forecast so far gives no percentage.
        await expect(overview.locator("[data-figure='vs-forecast']")).toHaveCount(0);
        await expect(overview.locator("[data-next]")).toHaveText("Forecast: production from around 13:15");
        await expect(question(page, "production").locator(".preview")).toContainText("no production was forecast");
        await header(page, "production").click();
        const production = question(page, "production");
        await expect(production.locator("[data-row='difference']")).toContainText("no production was forecast: no percentage");
        await expect(production.locator("[data-row='now']")).toContainText("this slot's forecast is zero, so no percentage");
        await expect(production.locator("[data-row='remaining']")).toContainText(kwh(todayKwh(NOW, true)));
        await header(page, "outlook").click();
        await expect(question(page, "outlook").locator("[data-day]")).toHaveCount(7);
    });

    test("an unreadable solar sensor is no reading, never 0 W", async ({ page }) => {
        await mount(page, { power: "unavailable" });
        await openDetail(page);
        await expect(content(page).locator("[data-overview] .status")).toHaveText("No solar power reading right now.");
    });
});

test("a solar sensor in kW is converted, never read as watts", async ({ page }) => {
    await mount(page, { power: "4.2", powerUnit: "kW" });
    await openDetail(page);
    await expect(content(page).locator("[data-overview] .status")).toHaveText("Producing 4.2 kW.");
});

test("while the grid imports as the battery charges, PV's share of the charge is not claimed", async ({ page }) => {
    await mount(page, { gridImporting: true });
    await openDetail(page);
    await header(page, "destinations").click();
    await evidence(page, "destinations").click();
    await expect(question(page, "destinations").locator("[data-row='dc-battery']")).toContainText("not known");
});

test.describe("production against the forecast", () => {
    test("the same elapsed period on both sides, the peak, the rest of the day and the projection; the bias only as evidence", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "production").click();
        const production = question(page, "production");
        const forecastKwh = todayKwh(DAY_START) - todayKwh(NOW);
        await expect(production.locator("[data-row='period']")).toContainText("Today 00:00–12:00");
        await expect(production.locator("[data-row='actual']")).toContainText(kwh(forecastKwh * ACTUAL_SHARE));
        await expect(production.locator("[data-row='forecast']")).toContainText("Forecast (bias-corrected)");
        await expect(production.locator("[data-row='forecast']")).toContainText(kwh(forecastKwh));
        await expect(production.locator("[data-row='difference']")).toContainText("92 % (−");
        // Like with like: the slot's forecast as a power. 1650 × 0.9 Wh in 15 min.
        await expect(production.locator("[data-row='now']")).toContainText("4.2 kW, 71 % of this slot's forecast (5.9 kW)");
        await expect(production.locator("[data-row='peak']")).toContainText("7.8 kW around 11:30");
        await expect(production.locator("[data-row='projection']")).toContainText(kwh(18.4 + todayKwh(NOW)));
        expect(await sectionRequests(page)).toEqual(["production"]);

        // The answer's embed is actual and corrected only; the bias waits for the evidence.
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
        await header(page, "production").click();
        const production = question(page, "production");
        await expect(production.locator("[data-forecast-failed]")).toBeVisible();
        await expect(production.getByRole("button", { name: "Try again" }).first()).toBeVisible();
    });

    test("a peak that cannot be read says so and offers a retry, keeping the comparison", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await header(page, "production").click();
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
        expect(await sectionRequests(page)).toEqual([]);
        await header(page, "destinations").click();
        const destinations = question(page, "destinations");
        await expect(destinations.locator("[data-row='produced']")).toContainText("18 kWh");
        expect(await sectionRequests(page)).toEqual(["destinations"]);
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
    });

    test("export the battery made is never solar export, and unexplained solar stays unresolved", async ({ page }) => {
        await mount(page, { destinations: "batteryExport" });
        await openDetail(page);
        await header(page, "destinations").click();
        const destinations = question(page, "destinations");
        await expect(destinations.locator("[data-row='export']")).toContainText("0.00 kWh");
        await expect(destinations.locator("[data-row='unresolved']")).toContainText("4.0 kWh");
        await expect(destinations).not.toContainText("−");
    });

    test("without reports the answer says why", async ({ page }) => {
        await mount(page, { destinations: "unavailable" });
        await openDetail(page);
        await header(page, "destinations").click();
        await expect(question(page, "destinations").locator("[data-destinations-unavailable]")).toContainText("Needs a house energy meter");
    });
});

test.describe("limits", () => {
    test("caps, the AC rating and the plan's intent as settings, never a curtailment figure", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "limits").click();
        const limits = question(page, "limits");
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
        await header(page, "limits").click();
        const limits = question(page, "limits");
        await expect(limits.locator("[data-above-rating]")).toContainText("this alone does not measure lost solar");
        await expect(limits).not.toContainText(/clipp/i);
        await expect(limits.locator(".exception, [data-exception]")).toHaveCount(0);
    });

    test("an export limit of 0 restricts export without a curtailment claim", async ({ page }) => {
        await mount(page, { exportLimit: "0" });
        await openDetail(page);
        await header(page, "limits").click();
        const limits = question(page, "limits");
        await expect(limits.locator("[data-export-zero]")).toContainText("does not by itself curtail solar");
        await expect(limits).not.toContainText(/clipp|curtailed|lost \d/i);
    });
});

test.describe("strings", () => {
    test("live and today's shares over a common period, unequal strings without fault styling", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "strings").click();
        const strings = question(page, "strings");
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
        await header(page, "outlook").click();
        const outlook = question(page, "outlook");
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
    test("one open question at a time, evidence by keyboard, and a reopened dialog starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await header(page, "limits").focus();
        await page.keyboard.press("Enter");
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "true");
        await expect(header(page, "limits")).toBeFocused();
        await evidence(page, "limits").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "limits").locator("[data-row='mppt_count']")).toBeVisible();

        await header(page, "outlook").click();
        await expect(header(page, "limits")).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "limits").locator("[data-row='input']")).toHaveCount(0);

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(header(page, "outlook")).toHaveAttribute("aria-expanded", "false");
    });

    test("live readings reach the open detail", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__hass;
            card.hass = { ...hass, states: { ...hass.states, "sensor.solax_pv_power_1": { state: "3000", attributes: { unit_of_measurement: "W" } } } };
        });
        await expect(question(page, "strings").locator(".preview")).toHaveText("string 1 3.0 kW · string 2 1.8 kW");
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
    await header(page, "strings").click();
    const strings = question(page, "strings");
    await expect(strings.locator("[data-no-common]")).toContainText("No period yet in which every string was recorded");
    await expect(strings.locator("[data-row^='share-']")).toHaveCount(0);
});

test.describe("a Custom inverter", () => {
    test("keeps the questions its config can answer and hides the string comparison", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        const ids = await content(page).locator("helman-node-question").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["production", "destinations", "limits", "outlook"]);
        await expect(question(page, "limits").locator(".preview")).toHaveText("export ≤ 9.9 kW");
        await header(page, "limits").click();
        await expect(question(page, "limits")).toContainText("need a hardware profile");
        await expect(question(page, "limits").locator("[data-row='export-cap']")).toContainText("9.9 kW");
    });
});

test.describe("screenshots", () => {
    test.skip(!SCREENS, "set P4_SCREENS to a directory to capture the review screenshots");
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        test(`overview and an expanded answer at ${name}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mount(page);
            await openDetail(page);
            await page.screenshot({ path: `${SCREENS}/${name}-overview.png`, fullPage: true });
            await header(page, "production").click();
            await expect(question(page, "production").locator("[data-row='peak']")).toContainText("7.8 kW");
            await page.screenshot({ path: `${SCREENS}/${name}-production.png`, fullPage: true });
            await header(page, "destinations").click();
            await expect(question(page, "destinations").locator("[data-row='produced']")).toBeVisible();
            await evidence(page, "destinations").click();
            await page.screenshot({ path: `${SCREENS}/${name}-destinations.png`, fullPage: true });
            await header(page, "limits").click();
            await evidence(page, "limits").click();
            await page.screenshot({ path: `${SCREENS}/${name}-limits.png`, fullPage: true });
            await header(page, "strings").click();
            await expect(question(page, "strings").locator("helman-day-line-chart")).toHaveCount(1);
            await page.screenshot({ path: `${SCREENS}/${name}-strings.png`, fullPage: true });
            await header(page, "outlook").click();
            await evidence(page, "outlook").click();
            await page.screenshot({ path: `${SCREENS}/${name}-outlook.png`, fullPage: true });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});
