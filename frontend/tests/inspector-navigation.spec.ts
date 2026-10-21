import { test, expect } from "@playwright/test";
import {
    monthBounds,
    pillWindow,
    spanBounds,
    viewStopGroups,
} from "../cards/helman-solar-inspector/inspector-navigation";

/**
 * Where the inspector can navigate to: spans, months, the pill row's window
 * and the width toggle's stops. Pure functions of the dates they are handed,
 * so they run here directly; the pills and the toggle they feed stay covered
 * by `inspector-day-pills.spec.ts`, `inspector-span-pills.spec.ts` and
 * `inspector-aggregate-views.spec.ts`.
 */

const TODAY = "2026-07-15";

const collapsed = {
    today: TODAY,
    mode: "day" as const,
    expanded: false,
    calendarAnchor: "",
    focusBucket: null,
    dayRange: { minDate: "2025-01-01", maxDate: "2026-07-17" },
    firstWeekday: 1,
    houseFocus: false,
};

test("a month runs from its first day to its last, leap years included", () => {
    expect(monthBounds("2028-02-10", TODAY)).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    // A key that does not parse reads as today's month.
    expect(monthBounds("not-a-day", TODAY)).toEqual({ start: "2026-07-01", end: "2026-07-31" });
});

test("a span is the day, the month or the year the day falls in, by view", () => {
    expect(spanBounds("day", "2026-03-09", TODAY)).toEqual({ start: "2026-03-09", end: "2026-03-09" });
    expect(spanBounds("month", "2026-03-09", TODAY)).toEqual({ start: "2026-03-01", end: "2026-03-31" });
    expect(spanBounds("year", "2026-03-09", TODAY)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
});

test("the collapsed pill row runs forward from today, or is the selection's week behind it", () => {
    expect(pillWindow({ ...collapsed, selectedDate: "" })).toEqual({ start: TODAY, end: "2026-07-17" });
    expect(pillWindow({ ...collapsed, selectedDate: "2026-07-10" })).toEqual({ start: "2026-07-08", end: "2026-07-14" });
    // House pills carry only elapsed days, so the block ends today instead.
    expect(pillWindow({ ...collapsed, selectedDate: TODAY, houseFocus: true }))
        .toEqual({ start: "2026-07-09", end: TODAY });
});

test("expanded in an aggregate view, the row is the month around the focused bucket", () => {
    expect(pillWindow({ ...collapsed, mode: "year", expanded: true, selectedDate: "2026-01-01", focusBucket: "2026-05-01" }))
        .toEqual({ start: "2026-05-01", end: "2026-05-31" });
});

test("hiding the aggregate views leaves only the day stops", () => {
    expect(viewStopGroups(false).flat().map((stop) => stop.label)).toEqual(["15", "30", "60", "D", "M"]);
    expect(viewStopGroups(true).flat().map((stop) => stop.label)).toEqual(["15", "30", "60"]);
});
