import { nothing } from "lit";
import { getScheduleLocalTimeParts } from "../shared/schedule/model/schedule-time";
import { renderNowMarker } from "../shared/now-marker";

/**
 * The vertical "now" line the schedule band draws, for the SVG charts above it.
 *
 * The band gets its marker for free from the scheduling card; the inspector's
 * own charts are hand-drawn SVG, so they share this instead — one look, one
 * rule about which days get a line, drawn on every chart of the stack.
 */

/**
 * Minute-of-day of `nowMs` on `date`, or null when the clock is on another day.
 *
 * The inspector shows one day at a time, so a marker only belongs on the chart
 * while that day is the one running; yesterday and tomorrow get none.
 */
export function nowMinutesOnDay(
    date: string,
    timeZone: string,
    nowMs: number,
): number | null {
    const parts = getScheduleLocalTimeParts(nowMs, timeZone);
    if (parts === null || parts.dayKey !== date) {
        return null;
    }
    return parts.hour * 60 + parts.minute;
}

/**
 * The line on one chart of the stack, or nothing: only today gets one, and only
 * while the moment falls inside the drawn window -- the daylight crop can put it
 * off the axis entirely, and a line pinned to the edge would claim a time the
 * chart is not showing.
 */
export function renderNowMarkerOnDay(
    day: { date: string; timeZone: string; nowMs: number },
    window: { start: number; end: number },
    xForMinutes: (minutes: number) => number,
    top: number,
    bottom: number,
    title: string,
) {
    const minutes = nowMinutesOnDay(day.date, day.timeZone, day.nowMs);
    if (minutes === null || minutes < window.start || minutes > window.end) {
        return nothing;
    }
    return renderNowMarker(xForMinutes(minutes), top, bottom, title);
}
