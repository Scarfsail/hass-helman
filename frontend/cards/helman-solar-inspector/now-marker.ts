import { svg } from "lit";
import { getScheduleLocalTimeParts } from "../helman-scheduling/model/schedule-time";

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
 * The line itself, spanning `top`..`bottom` of whichever chart draws it.
 *
 * Colour and width match the band's `.now-marker`, so the whole stack reads as
 * one mark drawn straight down the page. Two details keep it that way rather
 * than merely close: the stroke does not scale with the viewBox, so it is 2 CSS
 * pixels at any chart width the way the band's 2px div always is; and the line
 * is snapped to a whole pixel, so those two pixels land on two pixels instead of
 * smearing across three and reading heavier than the band.
 */
export function renderNowMarker(x: number, top: number, bottom: number, title: string) {
    const snapped = Math.round(x);
    return svg`
        <line
            x1=${snapped} y1=${top} x2=${snapped} y2=${bottom}
            stroke="var(--primary-color)" stroke-width="2"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
        ><title>${title}</title></line>
    `;
}
