import { test, expect } from "@playwright/test";
import {
    buildDayView,
    buildStacks,
    chartLayout,
    dayCoverage,
    dayHasSeries,
    socBars,
    type SeriesKey,
} from "../cards/helman-solar-inspector/inspector-day-model";
import type { ApplianceComponent } from "../cards/helman-solar-inspector/solar-inspector-model";
import { inspectorDay } from "./support/payload-builders";

/**
 * The inspector's day model, exercised as the pure functions it is.
 *
 * Every step takes its inputs -- the payload, the slot width, which series the
 * legend hides and the config allows, the chart width -- as arguments and reads
 * nothing else, so it runs here directly rather than through the card bundle.
 * The rendering it feeds stays covered by the `inspector-*` element specs.
 */

const NONE_HIDDEN: ReadonlySet<SeriesKey> = new Set();
const ALL_ENABLED = undefined;

const wh = (slot: string, valueWh: number) => ({ slot, valueWh });
const soc = (slot: string, pct: number) => ({ slot, pct });

function appliance(wh: number, deferrable: boolean): ApplianceComponent {
    return {
        entityId: deferrable ? "sensor.washer_energy" : "sensor.fridge_energy",
        label: deferrable ? "Washer" : "Fridge",
        wh,
        switchEntityId: null,
        powerEntityId: null,
        deferrable,
        controllableIds: [],
    };
}

test.describe("buildDayView", () => {
    test("at the native width it keeps the series and lays the price rails out per slot", () => {
        const payload = inspectorDay({
            series: { importPrice: [{ slot: "10:00", value: 2 }, { slot: "10:15", value: 4 }] },
        });
        const view = buildDayView(payload, 15);
        expect(view.series).toBe(payload.series);
        expect(view.importPriceColumns).toEqual([
            { startMinutes: 600, endMinutes: 615, value: 2 },
            { startMinutes: 615, endMinutes: 630, value: 4 },
        ]);
        expect(view.exportPriceColumns).toEqual([]);
    });

    test("a wider slot sums energy, drops part-measured buckets, samples SoC and averages prices", () => {
        const payload = inspectorDay({
            series: {
                corrected: [wh("10:00", 100), wh("10:15", 200), wh("10:30", 300), wh("10:45", 400), wh("11:00", 50)],
                // Measured through 11:15, so the 11:00 bucket is still in progress.
                actual: [wh("10:00", 100), wh("10:15", 100), wh("10:30", 100), wh("10:45", 100), wh("11:00", 100)],
                impact: [
                    { slot: "10:00", rawWh: 100, correctedWh: 120, impactWh: 20, factor: 1.2 },
                    { slot: "10:15", rawWh: 100, correctedWh: 80, impactWh: -20, factor: 0.8 },
                ],
                batterySocForecast: [soc("10:00", 50), soc("10:15", 52), soc("10:30", 54), soc("10:45", 56)],
                batterySocActual: [soc("10:00", 40), soc("10:15", 41)],
                importPrice: [
                    { slot: "10:00", value: 2 }, { slot: "10:15", value: 4 },
                    { slot: "10:30", value: 6 }, { slot: "10:45", value: 8 },
                ],
            },
        });
        const view = buildDayView(payload, 60);
        expect(view.series.corrected).toEqual([wh("10:00", 1000), wh("11:00", 50)]);
        expect(view.series.actual).toEqual([wh("10:00", 400)]);
        expect(view.series.impact).toEqual([
            { slot: "10:00", rawWh: 200, correctedWh: 200, impactWh: 0, factor: 1 },
        ]);
        // The forecast reports the level its slot ends at; the actual is read at the start.
        expect(view.series.batterySocForecast).toEqual([soc("10:00", 56)]);
        expect(view.series.batterySocActual).toEqual([soc("10:00", 40)]);
        expect(view.importPriceColumns).toEqual([{ startMinutes: 600, endMinutes: 660, value: 5 }]);
        // Slot-width independent, so carried through untouched.
        expect(view.totals).toBe(payload.totals);
    });

    test("an hourly day's last reading covers its whole hour", () => {
        const payload = inspectorDay({
            dataGranularityMinutes: 60,
            series: { actual: [wh("22:00", 300), wh("23:00", 200)] },
        });
        expect(buildDayView(payload, 60).series.actual).toEqual([wh("22:00", 300), wh("23:00", 200)]);
    });
});

test.describe("dayCoverage", () => {
    const payload = inspectorDay({
        series: { houseActual: [wh("10:00", 100), wh("10:30", 100)] },
    });

    test("marks the wider bucket a native hole falls in and counts the day's total", () => {
        const coverage = dayCoverage(payload, 60, NONE_HIDDEN, ALL_ENABLED);
        expect([...coverage.buckets].map(([start, perSeries]) => [start, [...perSeries]])).toEqual([
            [600, [["houseActual", 1]]],
        ]);
        expect([...coverage.series]).toEqual([["houseActual", { missing: 1, expected: 3 }]]);
        expect(coverage.granularityMinutes).toBe(15);
    });

    test("a series the legend hides or the config leaves out marks no column but keeps its total's caveat", () => {
        for (const coverage of [
            dayCoverage(payload, 60, new Set<SeriesKey>(["houseActual"]), ALL_ENABLED),
            dayCoverage(payload, 60, NONE_HIDDEN, ["actual"]),
        ]) {
            expect(coverage.buckets.size).toBe(0);
            expect([...coverage.series]).toEqual([["houseActual", { missing: 1, expected: 3 }]]);
        }
    });
});

test.describe("buildStacks", () => {
    const payload = inspectorDay({
        series: {
            corrected: [wh("10:00", 100), wh("10:15", 100), wh("10:30", 100)],
            actual: [wh("10:00", 100), wh("10:15", 100)],
            houseActual: [wh("10:00", 400)],
            houseActualBreakdown: [{ slot: "10:00", unmeasuredWh: 0, appliances: [appliance(100, true), appliance(300, false)] }],
        },
    });

    test("stacks average power per slot and fills the forecast from one slot past the last actual", () => {
        const stacks = buildStacks(buildDayView(payload, 15), 15, NONE_HIDDEN, ALL_ENABLED);
        expect([...stacks.actual.positive[0].values]).toEqual([[600, 400], [615, 400]]);
        expect([...stacks.forecast.positive[0].values]).toEqual([[600, 400], [615, 400], [630, 400]]);
        // House draws below zero, split into its base and its shiftable part.
        expect([...stacks.actual.negative[0].values]).toEqual([[600, -1200]]);
        expect([...stacks.actual.negative[1].values]).toEqual([[600, -400]]);
        expect(stacks.fillFromMinutes).toBe(630);
    });

    test("a hidden series is an empty layer and no longer moves the fill boundary", () => {
        const stacks = buildStacks(buildDayView(payload, 15), 15, new Set<SeriesKey>(["actual"]), ALL_ENABLED);
        expect(stacks.actual.positive[0].values.size).toBe(0);
        expect(stacks.fillFromMinutes).toBe(615);
        const allowed = buildStacks(buildDayView(payload, 15), 15, NONE_HIDDEN, ["corrected"]);
        expect(allowed.fillFromMinutes).toBe(Number.NEGATIVE_INFINITY);
    });

    test("a wider slot steps the boundary by its own width", () => {
        const hourly = inspectorDay({
            series: { actual: [wh("10:00", 100), wh("10:15", 100), wh("10:30", 100), wh("10:45", 100)] },
        });
        const stacks = buildStacks(buildDayView(hourly, 60), 60, NONE_HIDDEN, ALL_ENABLED);
        expect([...stacks.actual.positive[0].values]).toEqual([[600, 400]]);
        expect(stacks.fillFromMinutes).toBe(660);
    });

    test("only a house-focused card draws a day that carries nothing but house", () => {
        const house = inspectorDay({ series: { houseForecast: [wh("10:00", 100)] } });
        expect(dayHasSeries(house, false)).toBe(false);
        expect(dayHasSeries(house, true)).toBe(true);
        expect(dayHasSeries(payload, false)).toBe(true);
    });
});

test.describe("chartLayout", () => {
    // 750 Wh a quarter hour is 3 kW: the axis rounds to whole kilowatts either side of zero.
    const payload = inspectorDay({
        series: { corrected: [wh("10:00", 750), wh("10:15", 750)] },
    });
    const layoutOf = (
        width: number,
        daylightOnly: boolean,
        threshold: number,
        hidden: ReadonlySet<SeriesKey> = NONE_HIDDEN,
    ) => {
        const view = buildDayView(payload, 15);
        return chartLayout(view, buildStacks(view, 15, hidden, ALL_ENABLED), 15, width, daylightOnly, threshold, hidden, ALL_ENABLED);
    };

    test("the whole day maps onto the plot and the axis fits the tallest stack", () => {
        const layout = layoutOf(720, false, 100);
        expect(layout.plotWidth).toBe(648);
        expect(layout.plotHeight).toBe(208);
        expect([layout.dayStartMinutes, layout.dayEndMinutes]).toEqual([0, 1440]);
        expect(layout.slotWidth).toBe(6.75);
        expect(layout.xForMinutes(720)).toBe(372);
        expect(layout.maxKw).toBe(3);
        expect(layout.yTicks).toEqual([-3, -2, -1, 0, 1, 2, 3]);
        expect(layout.yForW(0)).toBe(122);
        expect(layout.wForY(122)).toBe(0);
    });

    test("daylight-only crops to the hours solar reaches the threshold", () => {
        const layout = layoutOf(720, true, 100);
        expect([layout.dayStartMinutes, layout.dayEndMinutes]).toEqual([600, 660]);
        expect(layout.slotWidth).toBe(162);
        expect([layoutOf(720, true, 5000).dayStartMinutes, layoutOf(720, true, 5000).dayEndMinutes]).toEqual([0, 1440]);
    });

    test("a hidden solar series neither crops the day nor sizes the axis", () => {
        const layout = layoutOf(720, true, 100, new Set<SeriesKey>(["corrected"]));
        expect([layout.dayStartMinutes, layout.dayEndMinutes]).toEqual([0, 1440]);
        expect(layout.maxKw).toBe(1);
    });
});

test.describe("socBars", () => {
    const payload = inspectorDay({
        series: {
            batterySocActual: [soc("10:00", 40), soc("10:15", 42)],
            batterySocForecast: [soc("10:00", 50), soc("10:15", 52), soc("10:30", 54)],
        },
    });
    const shape = (bars: ReturnType<typeof socBars>) => bars.map((bar) => [bar.slot, bar.pct, bar.forecast]);

    test("measured columns up to the fill boundary, forecast beyond it", () => {
        expect(shape(socBars(payload, NONE_HIDDEN, ALL_ENABLED, 630))).toEqual([
            ["10:00", 42, false],
            ["10:15", 44, false],
            ["10:30", 54, true],
        ]);
    });

    test("with the measured series hidden the forecast speaks for the whole day", () => {
        expect(shape(socBars(payload, new Set<SeriesKey>(["batterySocActual"]), ALL_ENABLED, 630))).toEqual([
            ["10:00", 50, true],
            ["10:15", 52, true],
            ["10:30", 54, true],
        ]);
    });
});
