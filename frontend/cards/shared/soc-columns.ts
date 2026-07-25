/**
 * How a battery's state of charge reads as a column per slot.
 *
 * The solar inspector draws these in SVG over a chart's pixel scale; the
 * scheduling band draws them as percent-positioned bars in a 18px track. What
 * the two must agree on is not markup but meaning: which movement counts as
 * charging, and what colour that movement is. Both live here, so a column is
 * the same statement wherever it is read.
 */

/** What the battery did over the slot a column covers. */
export type SocDirection = "charging" | "discharging" | "idle";

/** Below this much movement over a slot the battery is holding, not cycling. */
export const SOC_IDLE_DEADBAND_PCT = 0.5;

export function resolveSocDirection(deltaPct: number): SocDirection {
    if (deltaPct > SOC_IDLE_DEADBAND_PCT) return "charging";
    if (deltaPct < -SOC_IDLE_DEADBAND_PCT) return "discharging";
    return "idle";
}

/**
 * The colour a column is drawn in, as the theme-overridable custom property
 * rather than a literal: these are read inside two shadow trees, both of which
 * include `helmanColorVars`.
 */
export const SOC_DIRECTION_COLOR: Record<SocDirection, string> = {
    charging: "var(--helman-charge)",
    discharging: "var(--helman-discharge)",
    idle: "var(--helman-neutral-light)",
};

/**
 * How solidly a column is painted.
 *
 * A measured column is a fact and a forecast one is a claim, so the forecast
 * reads lighter. A surface with only one kind on it -- the scheduling band,
 * which is all plan -- draws every column measured-solid: muting the whole row
 * against nothing would only say the row is unimportant.
 */
export const SOC_COLUMN_OPACITY = { measured: 0.8, forecast: 0.35 } as const;

/** Inline style for one column, for hosts that paint with CSS rather than SVG. */
export function socColumnBackground(direction: SocDirection, forecast = false): string {
    const opacityPct = Math.round(
        (forecast ? SOC_COLUMN_OPACITY.forecast : SOC_COLUMN_OPACITY.measured) * 100,
    );
    return `color-mix(in srgb, ${SOC_DIRECTION_COLOR[direction]} ${opacityPct}%, transparent)`;
}
