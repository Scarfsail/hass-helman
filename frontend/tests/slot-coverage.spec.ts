import { test, expect } from "@playwright/test";
import { missingSlotMinutes, missingMinutesByBucket, partialBucketStarts } from "../cards/helman-solar-inspector/slot-aggregation";
import type { InspectorPoint } from "../cards/helman-solar-inspector/solar-inspector-model";

/**
 * Coverage math for #202: marking a wider bucket that hides a hole in its
 * 15-minute series rather than letting `aggregateWhSeries`'s honest sum read
 * as a genuinely low forecast.
 *
 * `missingSlotMinutes` and `partialBucketStarts` are pure and imported
 * directly (no card bundle needed) exactly as `money-model.spec.ts` exercises
 * `sumMoney` -- the render behaviour these feed is covered separately in
 * `inspector-partial-buckets.spec.ts`.
 */

/** A day's worth of 15-minute points, `date`-stamped, skipping the given minutes. */
function series(date: string, presentMinutes: number[]): InspectorPoint[] {
    return presentMinutes.map((m) => {
        const hh = String(Math.floor(m / 60)).padStart(2, "0");
        const mm = String(m % 60).padStart(2, "0");
        return { timestamp: `${date}T${hh}:${mm}:00`, valueWh: 100 };
    });
}

/** Every 15-minute slot from `start` to `end` (exclusive), for a hole-free series. */
function fullDay(start: number, end: number, step = 15): number[] {
    const out: number[] = [];
    for (let m = start; m < end; m += step) out.push(m);
    return out;
}

const DATE = "2026-07-18";

test.describe("missingSlotMinutes", () => {
    test("a mid-morning hole is reported as missing", () => {
        // 10:00 present, 10:15 and 10:30 missing, 10:45 present -- an interior hole.
        const points = series(DATE, [...fullDay(0, 615), 645, ...fullDay(660, 1440)]);
        expect(missingSlotMinutes(points, 15)).toEqual([615, 630]);
    });

    test("a series starting mid-hour has no leading hole", () => {
        // Actuals often begin mid-hour; nothing before the first sample is "missing".
        const points = series(DATE, fullDay(375, 1440)); // starts 06:15
        expect(missingSlotMinutes(points, 15)).toEqual([]);
    });

    test("a series ending at the slot in progress has no trailing hole", () => {
        // The running slot is simply the last sample; nothing after it is "missing".
        const points = series(DATE, fullDay(0, 615)); // last sample 10:00
        expect(missingSlotMinutes(points, 15)).toEqual([]);
    });

    test("an hourly-granularity series with no holes reports nothing", () => {
        const points = series(DATE, fullDay(0, 1440, 60));
        expect(missingSlotMinutes(points, 60)).toEqual([]);
    });

    test("an empty series has nothing to be missing", () => {
        expect(missingSlotMinutes([], 15)).toEqual([]);
    });
});

test.describe("partialBucketStarts", () => {
    test("a hole in the 10:00 hour marks the buckets it falls in, at 30 and 60 minutes", () => {
        const points = series(DATE, [...fullDay(0, 615), 645, ...fullDay(660, 1440)]);
        // 10:15 and 10:30 are missing: one bucket at hour width (10:00-11:00),
        // two adjacent ones at half-hour width (10:00-10:30 and 10:30-11:00).
        expect(partialBucketStarts([points], 60, 15)).toEqual(new Set([600]));
        expect(partialBucketStarts([points], 30, 15)).toEqual(new Set([600, 630]));
    });

    test("the same hole marks nothing at the native 15-minute width", () => {
        // At 15 == granularity a missing sample is an absent bucket, not a
        // partial one -- there is nowhere inside a single-sample bucket for a
        // hole to hide.
        const points = series(DATE, [...fullDay(0, 615), 645, ...fullDay(660, 1440)]);
        expect(partialBucketStarts([points], 15, 15)).toEqual(new Set());
    });

    test("a series starting 06:15 marks no 06:00 bucket", () => {
        const points = series(DATE, fullDay(375, 1440));
        expect(partialBucketStarts([points], 60, 15)).toEqual(new Set());
    });

    test("a series ending at the running slot marks no trailing bucket", () => {
        // Last sample 10:00 -- the 10:00 hour bucket the actuals are still
        // living through must not read as marked just because it is not over yet.
        const points = series(DATE, fullDay(0, 615));
        expect(partialBucketStarts([points], 60, 15)).toEqual(new Set());
    });

    test("an hourly statistics day marks nothing even at hour width", () => {
        const points = series(DATE, fullDay(0, 1440, 60));
        expect(partialBucketStarts([points], 60, 60)).toEqual(new Set());
    });

    test("a hole in one series out of several still marks the shared column", () => {
        const withHole = series(DATE, [...fullDay(0, 615), 645, ...fullDay(660, 1440)]);
        const whole = series(DATE, fullDay(0, 1440));
        expect(partialBucketStarts([whole, withHole], 60, 15)).toEqual(new Set([600]));
    });

    test("a complete day is unmarked at every width", () => {
        const points = series(DATE, fullDay(0, 1440));
        for (const slot of [15, 30, 60]) {
            expect(partialBucketStarts([points], slot, 15)).toEqual(new Set());
        }
    });
});

test.describe("missingMinutesByBucket", () => {
    test("carries the distinct missing native minutes behind each marked bucket", () => {
        const points = series(DATE, [...fullDay(0, 615), 645, ...fullDay(660, 1440)]);
        const buckets = missingMinutesByBucket([points], 60, 15);
        expect([...buckets.keys()]).toEqual([600]);
        expect(buckets.get(600)).toEqual(new Set([615, 630]));
    });

    test("its keys agree exactly with partialBucketStarts", () => {
        const withHole = series(DATE, [...fullDay(0, 615), 645, ...fullDay(660, 1440)]);
        const whole = series(DATE, fullDay(0, 1440));
        const buckets = missingMinutesByBucket([whole, withHole], 30, 15);
        expect(new Set(buckets.keys())).toEqual(partialBucketStarts([whole, withHole], 30, 15));
    });
});
