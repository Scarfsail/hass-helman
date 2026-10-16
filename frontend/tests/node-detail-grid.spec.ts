import { prepareNodeDetailPage, mountSimpleCard, nodeDetailLocators, sectionRequestLog } from "./support/node-detail-harness";
import { cardTree, forecastPayload } from "./support/payload-builders";
import type { ForecastPayload } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import { expectReducedMotionStill } from "./support/node-flow";

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

const SCREENS = process.env.SCREENS;

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
    /** The grid source node is `positive`, as with a positive-is-import meter. */
    positiveGridNode?: boolean;
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
        const aggregates = {
            bucket: "day",
            currency: "CZK/kWh",
            days: [{
                date: day, gridImportKwh: 8.4, gridExportKwh: 12.6,
                moneyCost: 42.5, moneyGain: v.exportPartlyPriced ? 9.45 : 18.9,
                moneyCostKwh: 8.4, moneyGainKwh: v.exportPartlyPriced ? 6.3 : 12.6,
            }],
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
                currentImportPrice: v.staleCurrentPrice ? 3.0 : 4.2, importPriceUnit: "CZK/kWh",
                importPricePoints: [
                    { timestamp: `${day}T12:00:00+00:00`, value: 4.2 },
                    { timestamp: `${day}T13:00:00+00:00`, value: 4.2 },
                    { timestamp: `${day}T14:00:00+00:00`, value: 5.1 },
                ],
                currentExportPrice: 1.5, exportPriceUnit: "CZK/kWh",
                exportPricePoints: [{ timestamp: `${day}T12:00:00+00:00`, value: 1.5 }],
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
            states, tree, overviews: { grid: overview, inverter }, sections: { grid: { flows: flowsSection, voltage: v.sectionFails ? "error" : section } }, forecast,
            replies: {
                "helman/solar_bias/day_aggregates": aggregates,
            },
        });
        window.__GridRequests = window.__NodeDetailRequests;
    }, { v: variant, tree: cardTree(variant.positiveGridNode ? "positive" : "default"), forecastDefaults: forecastPayload() });
    await mountSimpleCard(page);
}


const { content, question, header, evidence, tile, flow, flowLabel } = nodeDetailLocators("grid");
const gridCell = (page: Page) => page.locator(".node-cell:has(simple-card-grid)");
const picture = (page: Page) => content(page).locator("[data-phase-picture]");
const phase = (page: Page, n: number) => picture(page).locator(`[data-phase-bar="${n}"]`);
const sectionRequests = async (page: Page, section?: string) => (await sectionRequestLog(page, "grid", section)).length;

/** An element's inline `left` or `width`, in % of its track. */
async function percent(locator: ReturnType<Page["locator"]>, property: "left" | "width" | "right"): Promise<number> {
    const style = await locator.getAttribute("style");
    const match = style!.match(new RegExp(`(?:^|;\\s*)${property}: (?:calc\\()?(-?[\\d.]+)%`));
    return Number(match![1]);
}

/** Open a question the way a reader does: its tile, or the picture that absorbed it. */
async function open(page: Page, id: string): Promise<void> {
    if (id === "phases") await picture(page).click();
    else if (id === "money") await flow(page).locator("[data-side='out']").click();
    else await tile(page, id).locator("button").click();
    await expect(header(page, id)).toHaveAttribute("aria-expanded", "true");
}

async function openDetail(page: Page): Promise<void> {
    await gridCell(page).click();
    await expect(content(page).locator("[data-overview]")).toBeVisible();
}

test("a positive grid source node still reports the export the meter reads", async ({ page }) => {
    await mount(page, { positiveGridNode: true });
    await openDetail(page);
    await expect(content(page).locator("[data-overview] .status")).toHaveText("Exporting 650 W to the grid.");
});

test("an unreadable grid sensor is no reading, never idle at 0 W", async ({ page }) => {
    await mount(page, { gridUnavailable: true });
    await openDetail(page);
    await expect(content(page).locator("[data-overview] .status")).toHaveText("No grid power reading right now.");
});

test.describe("the grid overview", () => {
    test("opens on a status pill, the phase picture, the Now flow around the pylon and three closed tiles", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const overview = content(page).locator("[data-overview]");
        await expect(overview.locator(".status")).toHaveText("Exporting 650 W to the grid.");
        await expect(overview.locator(".status")).toHaveClass(/pill/);
        await expect(picture(page).locator("[data-phase-bar]")).toHaveCount(3);
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
        await expect(flow(page).locator("[data-glyph='pylon']")).toHaveCount(1);

        const ids = await content(page).locator("helman-node-tile").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question")));
        expect(ids).toEqual(["next", "outage", "voltage"]);
        for (const id of ids) await expect(tile(page, id!).locator("button")).toHaveAttribute("aria-expanded", "false");
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(content(page).locator("table, helman-day-line-chart, helman-solar-inspector-card")).toHaveCount(0);
        // The picture's ranges are read on opening; today's flows wait for Today.
        await expect(phase(page, 1).locator("[data-whisker]")).toHaveCount(1);
        expect(await sectionRequests(page, "voltage")).toBe(1);
        expect(await sectionRequests(page, "flows")).toBe(0);
        await expect(content(page).locator("[data-exception]")).toHaveCount(0);
        await expect(content(page).locator("helman-tree-item")).toHaveCount(0);
    });

    test("tiles say the answer: the next price in the import colour, the grid state and today's voltage range", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(tile(page, "next").locator(".value")).toHaveText("14:00");
        await expect(tile(page, "next").locator(".detail")).toHaveText("import 5.10 CZK/kWh");
        await expect(tile(page, "next").locator("button")).toHaveAttribute("style", /--node-tile-accent: var\(--helman-grid-import\)/);
        await expect(tile(page, "next").locator("button")).not.toHaveClass(/action-tone/);
        await expect(tile(page, "outage").locator(".value")).toHaveText("On grid");
        await expect(tile(page, "outage").locator(".detail")).toHaveText("Normal Mode");
        await expect(tile(page, "outage").locator(".caption")).toHaveText("What happens when the grid is unavailable?");
        // 236 − 5.5 V at the lowest, 240 + 5.5 V at the highest.
        await expect(tile(page, "voltage").locator(".value")).toHaveText("230–246 V");
        await expect(tile(page, "voltage").locator("[data-sparkline] path")).toHaveCount(3);
        // The morning gap stays a gap in the sparkline too.
        const d = await tile(page, "voltage").locator("[data-spark='1']").getAttribute("d");
        expect((d ?? "").split("M").length - 1).toBe(2);
    });

    test("off-grid operation is the one exception, linked to its answer", async ({ page }) => {
        await mount(page, { condition: "off_grid" });
        await openDetail(page);
        const exception = content(page).locator("[data-exception]");
        await expect(exception).toContainText("off-grid operation (Off-Grid)");
        await expect(tile(page, "outage").locator(".value")).toHaveText("Off-grid");
        await exception.locator("button").click();
        await expect(header(page, "outage")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "outage").locator("[data-row='grid-state']")).toContainText("Off-grid (Off-Grid)");
    });
});

test.describe("the phase picture", () => {
    test("each phase's power in its colour on the breaker setting, and its voltage inside the band with today's range", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        // Import positive, whichever way the meter signs it: L1 imports, L2 exports.
        await expect(phase(page, 1).locator("[data-power]")).toHaveText("importing 400 W");
        await expect(phase(page, 2).locator("[data-power]")).toHaveText("exporting 1.2 kW");
        const l1 = phase(page, 1).locator("[data-power-fill]");
        const l2 = phase(page, 2).locator("[data-power-fill]");
        await expect(l1).toHaveAttribute("data-power-fill", "import");
        await expect(l2).toHaveAttribute("data-power-fill", "export");
        await expect(l1).toHaveAttribute("style", /left: 50%/);
        await expect(l2).toHaveAttribute("style", /right: 50%/);
        await expect(l2).toHaveAttribute("style", /background: var\(--helman-phase-l2\)/);
        // A full bar is the 25 A setting at 230 V: 1 200 W of 5 750 W is 10.4 % of the track.
        expect(await percent(l2, "width")).toBeCloseTo(1200 / 5750 * 50, 1);

        // The voltage axis runs 200–260 V: 236 V sits at 60 %, today's 230.5–241.5 V around it.
        const dot = phase(page, 1).locator("[data-dot]");
        await expect(dot).toHaveAttribute("data-v", "236");
        expect(await percent(dot, "left")).toBeCloseTo(60, 1);
        const whisker = phase(page, 1).locator("[data-whisker]");
        await expect(whisker).toHaveAttribute("data-min", "230.5");
        await expect(whisker).toHaveAttribute("data-max", "241.5");
        expect(await percent(whisker, "left")).toBeCloseTo(30.5 / 60 * 100, 1);
        await expect(phase(page, 1).locator("[data-range]")).toHaveText("230.5 V–241.5 V today");
        await expect(phase(page, 1).locator("[data-volts]")).toHaveText("236.0 V");

        await picture(page).click();
        await expect(header(page, "phases")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "phases").locator("[data-phase-scale]")).toContainText("25.0 A main breaker setting at 230 V");
    });

    test("a phase without a sensor or a reading is said, never drawn as zero", async ({ page }) => {
        await mount(page, { l3Missing: true });
        await openDetail(page);
        await expect(phase(page, 1).locator("[data-whisker]")).toHaveCount(1);
        await expect(phase(page, 3).locator("[data-whisker]")).toHaveCount(0);
        await expect(phase(page, 3).locator("[data-dot]")).toHaveCount(0);
        await expect(phase(page, 3).locator("[data-volts]")).toHaveText("unavailable");
        await expect(phase(page, 3).locator("[data-range]")).toHaveText("no sensor");
        await expect(tile(page, "voltage").locator("[data-sparkline] path")).toHaveCount(2);
    });

    test("a failed read of today's ranges keeps the live readings, says so and retries", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await expect(content(page).locator("[data-range-failed]")).toHaveText("Today's voltage range could not be loaded.");
        // The live dots stay; no whisker is invented.
        await expect(picture(page).locator("[data-dot]")).toHaveCount(3);
        await expect(picture(page).locator("[data-whisker]")).toHaveCount(0);
        await expect(tile(page, "voltage").locator(".value")).toHaveText("–");
        await expect(tile(page, "voltage").locator(".detail")).toHaveText("Today's history could not be loaded.");
        expect(await sectionRequests(page, "voltage")).toBe(1);
        await content(page).getByRole("button", { name: "Try again" }).click();
        await expect.poll(() => sectionRequests(page, "voltage")).toBe(2);
    });

    test("without a breaker setting the bars are drawn against the largest phase", async ({ page }) => {
        await mount(page, { noLimit: true });
        await openDetail(page);
        expect(await percent(phase(page, 2).locator("[data-power-fill]"), "width")).toBeCloseTo(50, 1);
        await open(page, "phases");
        await expect(question(page, "phases").locator("[data-phase-scale]")).toContainText("A full bar is 1.2 kW");
    });

    test("a Custom inverter has nothing per phase to draw and reads no history", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(content(page).locator("[data-phase-picture-none]")).toHaveText("Needs a hardware profile with phase readings.");
        await expect(picture(page)).toHaveCount(0);
        await expect(tile(page, "outage")).toHaveCount(0);
        await expect(tile(page, "voltage").locator(".detail")).toHaveText("Needs a hardware profile with phase readings.");
        expect(await sectionRequests(page, "voltage")).toBe(0);
        // The phases answer stays reachable: it says what it needs.
        await content(page).locator("[data-phase-picture-none]").click();
        await expect(question(page, "phases")).toBeVisible();
    });
});

test.describe("the flow", () => {
    test("Now by default from the card's live split, with the rates now as the footnote; nothing flowing stays greyed", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Now · 12:00");
        await expect(flow(page).locator("[data-scope='now']")).toHaveAttribute("aria-pressed", "true");
        // Solar covers the house and exports 3.0 kW; the discharging battery exports 500 W.
        await expect(flowLabel(page, "in", "solar")).toContainText("3.0 kW");
        await expect(flowLabel(page, "in", "battery")).toContainText("500 W");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon]")).toHaveCount(2);
        for (const id of ["house", "battery"]) {
            await expect(flowLabel(page, "out", id)).toContainText("0 W");
            await expect(flowLabel(page, "out", id)).toHaveClass(/none/);
        }
        await expect(flow(page).locator("[data-side='out'] [data-ribbon]")).toHaveCount(0);
        await expect(flow(page).locator("[data-flow-note]")).toHaveText("Price now: import 4.20 CZK/kWh · export 1.50 CZK/kWh");
    });

    test("an unreadable solar meter leaves the split unknown, never 0", async ({ page }) => {
        await mount(page, { solar: "unavailable" });
        await openDetail(page);
        for (const [side, id] of [["in", "solar"], ["in", "battery"], ["out", "house"], ["out", "battery"]] as const) {
            await expect(flowLabel(page, side, id)).toContainText("–");
        }
        await expect(flow(page).locator("[data-ribbon]")).toHaveCount(0);
        await expect(flow(page).locator("[data-total]")).toHaveCount(0);
    });

    test("Today is requested only once chosen, in kWh with export income and import cost on their sides", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        expect(await sectionRequests(page, "flows")).toBe(0);
        await flow(page).locator("[data-scope='today']").click();
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "today");
        await expect(flowLabel(page, "in", "solar")).toContainText("5.8 kWh");
        expect(await sectionRequests(page, "flows")).toBe(1);
        await expect(flow(page).locator("[data-scope-label]")).toHaveText("Today · 00:00–12:00");
        await expect(flowLabel(page, "in", "battery")).toContainText("0.00 kWh");
        await expect(flowLabel(page, "in", "battery")).toHaveClass(/none/);
        await expect(flowLabel(page, "out", "house")).toContainText("1.2 kWh");
        await expect(flowLabel(page, "out", "battery")).toContainText("1.5 kWh");
        await expect(flow(page).locator("[data-total='in']")).toHaveText("In 5.8 kWh · income 18.90 CZK");
        await expect(flow(page).locator("[data-total='out']")).toHaveText("Out 2.7 kWh · cost 42.50 CZK");
        // The money is the span read made on opening, not a second one.
        expect(await page.evaluate(() => window.__GridRequests.filter((r) => r.type === "helman/solar_bias/day_aggregates").length)).toBe(1);

        await flow(page).locator("[data-scope='now']").click();
        await expect(flowLabel(page, "in", "solar")).toContainText("3.0 kW");
    });

    test("Today without reports says why, and a reopened dialog starts on Now", async ({ page }) => {
        await mount(page, { flowsUnavailable: "no_house_meter" });
        await openDetail(page);
        await flow(page).locator("[data-scope='today']").click();
        await expect(flow(page).locator("[data-flow-note]")).toHaveText("Today's flows need the house meter the device reports read; it is not configured.");
        await expect(flowLabel(page, "in", "solar")).toContainText("–");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("–");

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await openDetail(page);
        await expect(flow(page)).toHaveAttribute("data-flow-scope", "now");
    });

    test("tapping the flow opens the money, tapping the picture the phases", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await flow(page).locator("[data-side='in']").click();
        await expect(header(page, "money")).toHaveAttribute("aria-expanded", "true");
        await expect(question(page, "money").locator("[data-row='import-cost']")).toContainText("42.50 CZK");
        await picture(page).click();
        await expect(question(page, "money")).toHaveCount(0);
        await expect(header(page, "phases")).toHaveAttribute("aria-expanded", "true");
    });

    test("the inverter's AC rating is the scale when it has one", async ({ page }) => {
        await mount(page, { ratedPower: "10000" });
        await openDetail(page);
        const d = await flow(page).locator("[data-ribbon='solar']").getAttribute("d");
        const numbers = d!.match(/-?[\d.]+/g)!.map(Number);
        expect(numbers[9] - numbers[7]).toBeCloseTo(3000 / 10000 * 120, 1);
    });
});

test.describe("motion and the centre value", () => {
    test("Now: ribbons with energy shimmer, the glyph pulses and the power sits under it; Today stands still", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await expect(flow(page)).toHaveAttribute("active", "");
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("exporting 650 W");
        await expect(flow(page).locator("[data-side='in'] [data-ribbon='solar']")).toHaveAttribute("data-animated", "");
        // Every drawn ribbon has energy on it, and shimmers.
        await expect(flow(page).locator("[data-ribbon]:not([data-animated])")).toHaveCount(0);
        // Nothing flows out: no ribbon, so nothing shimmers.
        await expect(flowLabel(page, "out", "house")).toHaveClass(/none/);
        await expect(flow(page).locator("[data-side='out'] [data-animated]")).toHaveCount(0);
        await flow(page).locator("[data-scope='today']").click();
        // Exported in · imported out.
        await expect(flow(page).locator("[data-centre-value]")).toHaveText("5.8 kWh · 2.7 kWh");
        await expect(flow(page)).not.toHaveAttribute("active");
        await expect(flow(page).locator("[data-ribbon]").first()).toBeAttached();
        await expect(flow(page).locator("[data-animated]")).toHaveCount(0);
    });

    const cases: Array<[Variant, string, boolean]> = [
        [{ grid: "2000" }, "importing 2.0 kW", true],
        [{ grid: "-60" }, "exporting 60 W", true],
        [{ grid: "50" }, "about idle (50 W)", false],
        [{ gridUnavailable: true }, "–", false],
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

test.describe("voltage", () => {
    test("its tile opens today's three phases against labeled references, from the section read on opening", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "voltage");
        const chart = question(page, "voltage").locator("helman-day-line-chart");
        await expect(chart.locator("svg")).toBeVisible();
        expect(await sectionRequests(page, "voltage")).toBe(1);
        await expect(chart.locator("path.line")).toHaveCount(3);
        await expect(chart.locator(".legend")).toContainText("L1");
        await expect(chart.locator("rect.band")).toHaveCount(1);
        await expect(chart.locator("text.reference-label")).toHaveText(["207–253 V reference", "230 V nominal"]);
        // The morning gap stays a gap.
        const path = await chart.locator("path.line").first().getAttribute("d");
        expect((path ?? "").split("M").length - 1).toBe(2);

        const rows = question(page, "voltage").locator("[data-voltage-table] tbody tr");
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(1)).toContainText("234.5 V");
        await expect(rows.nth(1)).toContainText("240.0 V");
        await expect(rows.nth(1)).toContainText("245.5 V");
        await expect(question(page, "voltage").locator("[data-row='spread']")).toContainText("6.2 V at 10:30 (88 % of the day compared)");
        await expect(question(page, "voltage")).toContainText("not a compliance verdict or the inverter's protection setting");
        await expect(question(page, "voltage").locator(".preview")).toHaveText("Now 236.0 V–241.5 V at the inverter");

        await evidence(page, "voltage").click();
        await expect(question(page, "voltage").locator("[data-row='sampling-l1']")).toContainText("91 % of the day recorded");
        await expect(question(page, "voltage").locator("[data-source]")).toHaveText(["Read from recorded states: min and max are recorded values, each held until the next."]);
        await expect(question(page, "voltage")).toContainText("inverter's terminal voltages");
        await expect(question(page, "voltage").locator("[data-reference-meaning]")).toContainText("this chart cannot say whether either was met");
    });

    test("an unavailable phase is labeled, not drawn as zero", async ({ page }) => {
        await mount(page, { l3Missing: true });
        await openDetail(page);
        await open(page, "voltage");
        await expect(question(page, "voltage").locator(".preview")).toHaveText("Now 236.0 V–241.5 V at the inverter · L3 unavailable");
        await expect(question(page, "voltage").locator("helman-day-line-chart path.line")).toHaveCount(2);
        await expect(question(page, "voltage").locator("[data-voltage-table] tr[data-phase='3']")).toContainText("no sensor");

        await open(page, "phases");
        await expect(question(page, "phases").locator("[data-phase-current='3'] [data-current]")).toHaveText("current not estimable: no voltage");
    });

    test("a failed history request explains itself in the answer too, and retries", async ({ page }) => {
        await mount(page, { sectionFails: true });
        await openDetail(page);
        await open(page, "voltage");
        await expect(question(page, "voltage")).toContainText("Today's history could not be loaded.");
        await question(page, "voltage").getByRole("button", { name: "Try again" }).click();
        await expect.poll(() => sectionRequests(page, "voltage")).toBe(2);
    });
});

test.describe("phases", () => {
    test("each phase's estimated current against the configured limit, under the picture", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "phases");
        const phases = question(page, "phases");
        await expect(phases.locator(".preview")).toHaveText("Highest: L2 exporting 1.2 kW (≈ 5.0 A est.)");
        await expect(phases.locator("[data-phase-current]")).toHaveCount(3);
        await expect(phases.locator("[data-phase-current='1'] [data-power]")).toHaveText("importing 400 W");
        await expect(phases.locator("[data-phase-current='1'] [data-current]")).toHaveText("≈ 1.7 A of 25.0 A setting (est.)");
        await expect(phases).toContainText("not a measured current or breaker headroom");

        await evidence(page, "phases").click();
        await expect(phases.locator("[data-phase-table] tbody tr").first()).toContainText("400 W");
        await expect(phases.locator("[data-phase-table] tbody tr").nth(1)).toContainText("-1200 W");
        await expect(phases.locator("[data-row='main_breaker_limit']")).toContainText("25 A");
        await expect(phases).toContainText("assuming a power factor of 1");
    });

    test("a zero voltage or a missing limit leaves out only that comparison", async ({ page }) => {
        await mount(page, { zeroVoltage: true, noLimit: true });
        await openDetail(page);
        await expect(phase(page, 2).locator("[data-dot]")).toHaveCount(0);
        await open(page, "phases");
        const phases = question(page, "phases");
        await expect(phases.locator("[data-phase-current='2'] [data-current]")).toHaveText("current not estimable: no voltage");
        await expect(phases.locator("[data-phase-current='1'] [data-current]")).toHaveText("≈ 1.7 A (est.)");
        await expect(phases.locator("[data-phase-current='2'] [data-power]")).toHaveText("exporting 1.2 kW");
    });
});

test.describe("money and what comes next", () => {
    test("money: cost, income, net and the priced coverage; the focused embed only behind the evidence", async ({ page }) => {
        await mount(page, { exportPartlyPriced: true });
        await openDetail(page);
        await open(page, "money");
        const money = question(page, "money");
        await expect(money.locator(".preview")).toHaveText("cost 42.50 CZK · income 9.45 CZK");
        await expect(money.locator("[data-row='period']")).toContainText("Today 00:00–12:00");
        await expect(money.locator("[data-row='import-cost']")).toContainText("42.50 CZK");
        await expect(money.locator("[data-row='export-income']")).toContainText("9.45 CZK");
        await expect(money.locator("[data-row='net']")).toContainText("Net cost");
        await expect(money.locator("[data-row='net']")).toContainText("33.05 CZK");
        await expect(money.locator("[data-row='coverage']")).toHaveText(/import 100 % of 8\.4 kWh · export 50 % of 13 kWh/);
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);

        await evidence(page, "money").click();
        await expect(money.locator("helman-solar-inspector-card")).toHaveCount(1);
        await expect(money).toContainText("the totals above price each hour");

        // Another question shows its own embed, never both.
        await open(page, "next");
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(0);
        await evidence(page, "next").click();
        await expect(page.locator("helman-solar-inspector-card")).toHaveCount(1);
        await expect(question(page, "next").locator("helman-solar-inspector-card")).toHaveCount(1);
    });

    test("next: the rates now and next, and the plan's grid flow", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await open(page, "next");
        const next = question(page, "next");
        await expect(next.locator(".preview")).toHaveText("import 4.20 CZK/kWh · export 1.50 CZK/kWh");
        await expect(next.locator("[data-row='import-now']")).toContainText("4.20 CZK/kWh");
        await expect(next.locator("[data-row='import-next']")).toContainText("5.10 CZK/kWh from 14:00");
        await expect(next.locator("[data-row='export-next']")).toContainText("no change known");
        await expect(next.locator("[data-row='planned-now']")).toContainText("exporting 0.30 kWh");
        await expect(next.locator("[data-row='planned-change']")).toContainText("from 15:00: importing");
        await expect(next).toContainText("with the schedule applied, an estimate rather than a commitment");
    });
});

test("next: a rate whose boundary has passed is the rate now, from the price points", async ({ page }) => {
    await mount(page, { staleCurrentPrice: true });
    await openDetail(page);
    await expect(tile(page, "next").locator(".value")).toHaveText("14:00");
    await open(page, "next");
    const next = question(page, "next");
    await expect(next.locator("[data-row='import-now']")).toContainText("4.20 CZK/kWh");
    await expect(next.locator("[data-row='import-next']")).toContainText("5.10 CZK/kWh from 14:00");
});

test.describe("disclosure and live data", () => {
    test("one open answer at a time under the tiles, evidence by keyboard, and a reopened dialog starts at the overview", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        const voltageTile = tile(page, "voltage").locator("button");
        await voltageTile.focus();
        await page.keyboard.press("Enter");
        await expect(voltageTile).toHaveAttribute("aria-expanded", "true");
        await expect(header(page, "voltage")).toHaveAttribute("aria-expanded", "true");
        await evidence(page, "voltage").focus();
        await page.keyboard.press("Space");
        await expect(question(page, "voltage").locator("[data-reference-meaning]")).toBeVisible();

        await open(page, "outage");
        await expect(voltageTile).toHaveAttribute("aria-expanded", "false");
        await expect(question(page, "voltage")).toHaveCount(0);
        await expect(content(page).locator("helman-node-question")).toHaveCount(1);
        const tiles = await content(page).locator(".tiles").boundingBox();
        const answer = await question(page, "outage").boundingBox();
        expect(answer!.y).toBeGreaterThanOrEqual(tiles!.y + tiles!.height);
        await expect(question(page, "outage").locator("[data-row='export-limit']")).toContainText("9.9 kW");
        await expect(question(page, "outage").locator("[data-row='eps_mode_runtime']")).toContainText("163.9 h");
        await evidence(page, "outage").click();
        await expect(question(page, "outage").locator("[data-row='grid_frequency']")).toContainText("50.01 Hz");

        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await openDetail(page);
        await expect(content(page).locator("helman-node-question")).toHaveCount(0);
        await expect(tile(page, "outage").locator("button")).toHaveAttribute("aria-expanded", "false");
    });

    test("live readings reach the open picture", async ({ page }) => {
        await mount(page);
        await openDetail(page);
        await page.evaluate(() => {
            const card = document.querySelector("helman-simple-card") as any;
            const hass = window.__GridHass;
            card.hass = {
                ...hass,
                states: { ...hass.states, "sensor.solax_inverter_voltage_l2": { state: "244.0", attributes: { unit_of_measurement: "V" } } },
            };
        });
        await expect(phase(page, 2).locator("[data-volts]")).toHaveText("244.0 V");
    });
});

test.describe("a Custom inverter", () => {
    test("keeps the core questions with a short unavailable answer, and hides the off-grid one", async ({ page }) => {
        await mount(page, { profile: false });
        await openDetail(page);
        await expect(tile(page, "outage")).toHaveCount(0);
        await open(page, "voltage");
        await expect(question(page, "voltage")).toContainText("this one is Custom");
        await expect(question(page, "voltage").locator("helman-day-line-chart")).toHaveCount(0);
        expect(await sectionRequests(page)).toBe(0);
        // Money and the plan do not depend on the profile.
        await open(page, "money");
        await expect(question(page, "money").locator(".preview")).toHaveText("cost 42.50 CZK · income 18.90 CZK");
    });
});

/** The two states the review screenshots show: an evening import and a midday export. */
const STATES: Array<[string, Variant]> = [
    ["evening", { solar: "0", house: "1800", battery: "-1500", grid: "300" }],
    ["midday", { solar: "6500", house: "900", battery: "3200", grid: "-2400", ratedPower: "10000" }],
];

test.describe("screenshots", { tag: "@screens" }, () => {
    for (const [name, width, height] of [["mobile-360", 360, 760], ["desktop-1280", 1280, 900]] as const) {
        for (const [state, variant] of STATES) {
            test(`the ${state} overview, Today and opened answers at ${name}`, async ({ page }) => {
                await page.setViewportSize({ width, height });
                await mount(page, variant);
                await openDetail(page);
                await expect(phase(page, 1).locator("[data-whisker]")).toHaveCount(1);
                await page.screenshot({ path: `${SCREENS}/grid-${state}-${name}-now.png`, fullPage: true });
                await flow(page).locator("[data-scope='today']").click();
                await expect(flowLabel(page, "in", "solar")).toContainText("kWh");
                await page.screenshot({ path: `${SCREENS}/grid-${state}-${name}-today.png`, fullPage: true });
                await open(page, "phases");
                await page.screenshot({ path: `${SCREENS}/grid-${state}-${name}-phases.png`, fullPage: true });
                await open(page, "voltage");
                await expect(question(page, "voltage").locator("helman-day-line-chart svg")).toBeVisible();
                await page.screenshot({ path: `${SCREENS}/grid-${state}-${name}-voltage.png`, fullPage: true });
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                expect(overflow).toBeLessThanOrEqual(0);
            });
        }
    }
});
