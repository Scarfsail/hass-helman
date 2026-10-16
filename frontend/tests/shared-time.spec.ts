import { test, expect } from "@playwright/test";
import { formatClock, slotMinutes } from "../cards/shared/time/slot-time";
import { parseDayKey, addDays, daysBetween, isoDateInTimeZone, getCachedLocalDateTimeDescriptor } from "../cards/shared/time/day-key";
import { applyValueType, isReadableState, phaseSign } from "../cards/shared/power-reading";

test("clock range ends distinguish end of day", () => {
    expect(formatClock(1440)).toBe("24:00");
    expect(formatClock(1440, { endOfDay: "00:00" })).toBe("00:00");
});
test("slot parsing validates complete clock values", () => {
    expect(slotMinutes("23:59")).toBe(1439);
    for (const value of ["24:00", "12:60", "-1:00", "1:00", "12:00:00", "", null]) {
        expect(slotMinutes(value)).toBeNull();
    }
});
test("day keys reject invalid calendar dates", () => {
    for (const value of ["bad", "2026-02-29", "2026-13-01", "2026-00-01"]) expect(parseDayKey(value)).toBeNull();
    expect(parseDayKey("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
});
test("calendar arithmetic crosses daylight saving changes", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-26", -2)).toBe("2026-10-24");
});
test("value types select positive, negative and signed readings", () => {
    expect(applyValueType(-5, "positive")).toBe(0);
    expect(applyValueType(5, "positive")).toBe(5);
    expect(applyValueType(-5, "negative")).toBe(5);
    expect(applyValueType(5, "negative")).toBe(0);
    expect(applyValueType(-5, "default")).toBe(-5);
});

test("day keys and local descriptors share the configured time zone", () => {
    const date = new Date("2026-03-29T22:30:00Z");
    expect(isoDateInTimeZone(date, "Europe/Berlin")).toBe("2026-03-30");
    expect(getCachedLocalDateTimeDescriptor(date, "Europe/Berlin")).toEqual({
        dayKey: "2026-03-30", hour: 0, minute: 30, offset: "+02:00",
    });
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
});
test("live readings and phase signs use shared rules", () => {
    for (const state of [undefined, null, "", "unknown", "unavailable"]) expect(isReadableState(state)).toBe(false);
    for (const state of ["0", "off", "-5"]) expect(isReadableState(state)).toBe(true);
    expect(phaseSign("positive_is_export")).toBe(-1);
    expect(phaseSign("positive_is_import")).toBe(1);
    expect(phaseSign(null)).toBe(1);
});
