const MINUTES_PER_DAY = 1440;

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
