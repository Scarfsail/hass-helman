import { nothing, svg } from "lit";
import { getScheduleLocalTimeParts } from "../shared/schedule/model/schedule-time";
import { slotSelectionModeForEvent, type SlotPickDetail } from "./slot-selection.js";

const MINUTES_PER_DAY = 1440;

/**
 * "Nothing is selected", for every strip that bands the inspector's selection.
 *
 * One frozen array rather than a fresh `[]` per render: the strips compare the
 * property by identity, and the ordinary state while a pointer sweeps the
 * chart is exactly this one -- a new empty array each time would re-render all
 * three rows on every move.
 */
export const EMPTY_SELECTED_MINUTES: readonly number[] = Object.freeze([]);

/**
 * How a strip under the inspector's charts maps a minute-of-day to a horizontal
 * fraction of the chart viewBox.
 *
 * Its own module rather than one strip's, because every row below the charts
 * has to answer this the same way -- a strip that computed its own alignment
 * would be a strip that drifts out of step with the chart it sits under.
 */
export interface ScheduleStripGeometry {
    /** Chart viewBox width (the inspector's captured `_chartWidth`). */
    width: number;
    /** Chart plot-area left margin, in viewBox units. */
    marginLeft: number;
    /** Chart plot-area width, in viewBox units. */
    plotWidth: number;
    /** Minute-of-day at the plot's left edge; defaults to 0 (whole day). */
    startMinutes?: number;
    /** Minute-of-day at the plot's right edge; defaults to 1440 (whole day). */
    endMinutes?: number;
}

/** The minute-of-day window the plot spans, defaulting to the whole day. */
export function stripWindow(geometry: ScheduleStripGeometry): { start: number; end: number } {
    const start = geometry.startMinutes ?? 0;
    const end = geometry.endMinutes ?? MINUTES_PER_DAY;
    return end > start ? { start, end } : { start: 0, end: MINUTES_PER_DAY };
}

/** Invert a strip's x mapping: a viewBox x back to its minute-of-day, or null in the gutter. */
export function stripMinutesForSvgX(geometry: ScheduleStripGeometry, svgX: number): number | null {
    const plotRight = geometry.marginLeft + geometry.plotWidth;
    if (svgX < geometry.marginLeft || svgX > plotRight) {
        return null;
    }
    const { start, end } = stripWindow(geometry);
    return start + ((svgX - geometry.marginLeft) / geometry.plotWidth) * (end - start);
}

/**
 * The pointer's x in the viewBox of the SVG the event's listener sits on.
 *
 * Every row under the charts is drawn at the chart's viewBox width and scaled
 * to the card, so a client x has to be mapped back through that scale before
 * any row can say which minute it is over.
 */
export function svgXFromEvent(event: MouseEvent, viewBoxWidth: number): number {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * viewBoxWidth;
}

/**
 * What a click on a strip asks the inspector to select: the minute under the
 * pointer, or `null` in the axis gutter so the inspector clears its selection,
 * matching how clicking outside the plot on the chart deselects.
 */
export function stripClickDetail(event: MouseEvent, geometry: ScheduleStripGeometry): SlotPickDetail {
    return {
        minutes: stripMinutesForSvgX(geometry, svgXFromEvent(event, geometry.width)),
        mode: slotSelectionModeForEvent(event),
    };
}

/**
 * Minute-of-day the day turns from measured into upcoming: the start of the
 * slot `nowMs` is inside when `date` is today, otherwise the whole day is past
 * (an earlier day) or entirely upcoming (a later day).
 *
 * The seam snaps back to the slot start rather than sitting on the exact minute
 * because a slot only counts as measured once it has fully elapsed -- the same
 * rule the chart above applies to its actuals, so the whole inspector changes
 * vintage on one line.
 */
export function seamMinutes(nowMs: number, date: string, timeZone: string, slot: number): number {
    const now = getScheduleLocalTimeParts(nowMs, timeZone);
    if (now === null) {
        return MINUTES_PER_DAY;
    }
    if (now.dayKey === date) {
        return Math.floor((now.hour * 60 + now.minute) / slot) * slot;
    }
    return date < now.dayKey ? MINUTES_PER_DAY : 0;
}

/**
 * The blue selection or orange hover look for "this slot", as an inline style:
 * one definition for every chart and strip that bands a slot or a bucket.
 */
export const SLOT_BAND_STYLE: Readonly<Record<"selected" | "hover", string>> = {
    selected: "fill: color-mix(in srgb, var(--helman-grid-import) 13%, transparent);"
        + " stroke: var(--helman-grid-import); stroke-width: 1; stroke-opacity: 0.5;",
    hover: "fill: color-mix(in srgb, var(--helman-selection) 14%, transparent);"
        + " stroke: var(--helman-selection); stroke-width: 1; stroke-opacity: 0.55;",
};

/**
 * The blue selection or orange hover band behind a slot, on any row of the
 * inspector: one look for "this slot", whichever chart or strip draws it.
 */
export function renderSlotBand(x: number, width: number, y: number, height: number, kind: "selected" | "hover") {
    return svg`
        <rect
            x=${x} y=${y} width=${width} height=${height}
            style=${SLOT_BAND_STYLE[kind]}
            rx="1"
            pointer-events="none"
        ></rect>
    `;
}

/**
 * The band behind the strip cell `minutes` falls in, full strip height, or
 * nothing when no cell holds it.
 */
export function renderCellBand(
    cells: readonly { startMinutes: number; endMinutes: number }[],
    minutes: number | null,
    kind: "selected" | "hover",
    height: number,
    xForMinutes: (minutes: number) => number,
) {
    if (minutes === null) return nothing;
    const cell = cells.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
    if (!cell) return nothing;
    const x = xForMinutes(cell.startMinutes);
    return renderSlotBand(x, Math.max(2, xForMinutes(cell.endMinutes) - x), 0, height, kind);
}
