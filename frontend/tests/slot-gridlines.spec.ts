import { expect, test } from "@playwright/test";
import { slotGridTicks, type SlotGridTick } from "../cards/shared/slot-gridlines";

/**
 * `slotGridTicks` before it learned about spans past one day, kept verbatim.
 *
 * The inspector's charts and strips rule every single-day view by it, so the
 * extension has to leave their output exactly as it was; comparing against
 * the old body over a sweep of shapes is the strongest form of that claim.
 */
function legacySlotGridTicks(options: {
    startMinutes: number;
    endMinutes: number;
    slotMinutes: number;
    plotWidth: number;
}): SlotGridTick[] {
    const LABEL_STRIDES = [1, 2, 3, 4, 6, 12] as const;
    const span = options.endMinutes - options.startMinutes;
    if (span <= 0 || options.plotWidth <= 0) return [];
    const pxPerMinute = options.plotWidth / span;
    const slot = options.slotMinutes > 0 ? options.slotMinutes : 60;
    const labelStride = LABEL_STRIDES.find((stride) => stride * 60 * pxPerMinute >= 30) ?? 24;
    let step = slot;
    while (step * pxPerMinute < 4 && step < labelStride * 60) {
        step *= 2;
    }
    step = Math.min(step, labelStride * 60);
    const labelled = (minutes: number) => minutes % 60 === 0 && (minutes / 60) % labelStride === 0;
    const ticks: SlotGridTick[] = [];
    const first = Math.ceil(options.startMinutes / step) * step;
    for (let minutes = first; minutes <= options.endMinutes; minutes += step) {
        ticks.push({ minutes, hour: labelled(minutes) ? minutes / 60 : null });
    }
    for (let hour = 0; hour <= 24; hour += labelStride) {
        const minutes = hour * 60;
        if (minutes < options.startMinutes || minutes > options.endMinutes) continue;
        if (minutes % step === 0) continue;
        ticks.push({ minutes, hour });
    }
    ticks.sort((a, b) => a.minutes - b.minutes);
    return ticks;
}

test("a single-day span is ruled exactly as before", () => {
    const windows = [[0, 1440], [360, 1080], [420, 1020], [90, 1395], [0, 1500], [600, 600], [-60, 1440]];
    for (const [startMinutes, endMinutes] of windows) {
        for (const slotMinutes of [0, 15, 30, 40, 60]) {
            for (const plotWidth of [0, 120, 300, 390, 720, 1000, 1600]) {
                const options = { startMinutes, endMinutes, slotMinutes, plotWidth };
                expect(slotGridTicks(options), JSON.stringify(options)).toEqual(legacySlotGridTicks(options));
            }
        }
    }
});

test("a span past midnight labels clock hours and marks its midnights", () => {
    // 10:30 on one day to 10:30 on the next, counted from the first midnight,
    // on a day 23 hours long: the next midnight is at 23:00 elapsed.
    const ticks = slotGridTicks({
        startMinutes: 630,
        endMinutes: 630 + 1440,
        slotMinutes: 60,
        plotWidth: 1440,
        midnightMinutes: [0, 1380],
    });

    const midnight = ticks.find((tick) => tick.minutes === 1380);
    expect(midnight).toEqual({ minutes: 1380, hour: 0, midnight: true });
    // Past the midnight, hours restart from it rather than counting on.
    expect(ticks.find((tick) => tick.minutes === 1380 + 60)?.hour).toBe(1);
    expect(ticks.some((tick) => (tick.hour ?? 0) >= 24)).toBe(false);
    expect(ticks.filter((tick) => tick.midnight)).toHaveLength(1);
});

test("past a midnight, a daylight-saving day is labelled by its clock", () => {
    // Noon on one day to noon on the next, the next being the spring-forward
    // day: at 02:00 the clock jumps to 03:00, so two hours after its midnight
    // it reads 03, not 02.
    const changeMinutes = 1440 + 120;
    const ticks = slotGridTicks({
        startMinutes: 720,
        endMinutes: 720 + 1440,
        slotMinutes: 15,
        plotWidth: 2880,
        midnightMinutes: [0, 1440],
        clockMinutesAt: (minutes) => minutes < 1440
            ? minutes
            : minutes < changeMinutes ? minutes - 1440 : minutes - 1440 + 60,
    });

    const hourAt = (minutes: number) => ticks.find((tick) => tick.minutes === minutes)?.hour;
    expect(hourAt(1440 + 60)).toBe(1);
    expect(hourAt(changeMinutes)).toBe(3);
    expect(hourAt(changeMinutes + 60)).toBe(4);
    expect(ticks.filter((tick) => tick.minutes >= 1440).map((tick) => tick.hour)).not.toContain(2);
});
