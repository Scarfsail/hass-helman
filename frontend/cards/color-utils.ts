/**
 * The single source of truth for every color that carries domain meaning:
 * what a power source is, which way energy moves, whether a price is good.
 *
 * Home Assistant has no opinion about any of these, so we own them outright.
 * Colors HA *does* own — --success-color, --error-color, --warning-color,
 * --primary-color, --divider-color — deliberately stay out of this file: they
 * belong to the user's theme and cards should read them straight from there.
 */

export const SOLAR_COLOR = '#facc15'; // yellow-400
export const GRID_COLOR  = '#38bdf8'; // sky-400
export const BATT_COLOR  = '#22c55e'; // green-500
export const HOUSE_COLOR = '#a855f7'; // purple-500

/**
 * Shiftable house load: the same purple, lightened.
 *
 * Deferrable consumption is still house consumption, so it must read as a shade
 * of the house colour rather than a hue of its own — the band stacked on top of
 * the non-deferrable one, the tinted rows in the inspector's composition panel
 * and the power card's deferrable children are all the same quantity. Defined
 * here once: every card imports this and never re-derives it.
 *
 * Written out as purple-300 (HOUSE_COLOR is purple-500) rather than blended
 * towards white, which is what this used to be. Lightening in sRGB buys
 * lightness by pulling R and G up towards B, i.e. it *desaturates*: the old
 * 1:2 white blend (#e2c6fc) had an R-G spread of 28 against purple-500's 83.
 * That reads fine as an opaque chart fill, but the power card paints its tint
 * through `color-mix(tint 35%, #050505)` with an already-translucent colour, so
 * roughly 13% of the tint survives — enough to carry hue, never enough to carry
 * lightness. A pale, near-hueless lavender therefore came out grey. Staying on
 * the Tailwind ramp keeps the shade genuinely lighter *and* keeps the purple.
 */
export const DEFERRABLE_HOUSE_COLOR = '#c084fc'; // purple-300

/** Which way the grid is flowing. Distinct from GRID_COLOR, which is the node itself. */
export const GRID_IMPORT_COLOR = '#2563eb'; // blue-600
export const GRID_EXPORT_COLOR = '#7dd3fc'; // sky-300

/** Export price above/below the threshold that makes exporting worthwhile. */
export const PRICE_POSITIVE_COLOR = '#8d6e63'; // brown-400
export const PRICE_NEGATIVE_COLOR = '#6d4c41'; // brown-600

/** Uncorrected forecast, drawn behind the corrected one. */
export const FORECAST_RAW_COLOR = '#64748b'; // slate-500

/** Hover and slot selection across every chart and strip. */
export const SELECTION_COLOR = '#f59e0b'; // amber-500

/**
 * Battery direction in charts. Kept as our own values rather than HA's
 * --success-color/--error-color: a plotted series needs a hue we control for
 * legibility against the plot background, and themes ship greens too dark for
 * it. Status chips and outcome text are chrome and do use the HA vars.
 */
export const CHARGE_COLOR    = '#16a34a'; // green-600
export const DISCHARGE_COLOR = '#dc2626'; // red-600

/** Nothing happening: idle battery, blend with no active source, unknown node. */
export const NEUTRAL_COLOR       = '#6b7280'; // gray-500
export const NEUTRAL_LIGHT_COLOR = '#9ca3af'; // gray-400


/** Adds a two-digit alpha channel to a hex color value. */
export function withAlpha(hex: string, alphaHex: string): string {
    let normalizedHex = hex;
    if (hex.length === 4) {
        normalizedHex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    } else if (hex.length === 9) {
        normalizedHex = hex.slice(0, 7);
    }
    const normalizedAlpha = alphaHex.replace('#', '').padStart(2, '0').slice(0, 2);
    return `${normalizedHex}${normalizedAlpha}`;
}

/**
 * The color of a top-level node, from its sourceType alone.
 *
 * This is the only place a node's color comes from — the tree the backend ships
 * carries no color of its own, so there is nothing to disagree with. Nodes with
 * no sourceType (house children, unmeasured, virtual groups) are not
 * domain-colored and get the neutral.
 */
export function canonicalSourceColor(sourceType: string | null | undefined, fallback?: string): string {
    switch (sourceType) {
        case 'solar':   return SOLAR_COLOR;
        case 'grid':    return GRID_COLOR;
        case 'battery': return BATT_COLOR;
        case 'house':   return HOUSE_COLOR;
        default:        return fallback ?? NEUTRAL_COLOR;
    }
}

/**
 * The card's node color as it gets *painted* — glow, box tint, history bars.
 *
 * Translucent by design: these are backgrounds, drawn behind text and stacked
 * with each other, and the full-strength palette value overwhelms both. Use
 * this rather than alpha-ing canonicalSourceColor at the call site, so every
 * surface that means "this is solar" agrees on how strong that reads.
 */
export function nodeAccentColor(sourceType: string | null | undefined): string {
    return withAlpha(canonicalSourceColor(sourceType), '60');
}

/** Compute the color of the dominant (highest-power) source from the latest history bucket. No blending. */
export function computeDominantSourceColor(node: { sourcePowerHistory?: { [sourceId: string]: { power: number; color: string } }[] }): string | undefined {
    const history = node.sourcePowerHistory;
    if (!history?.length) return undefined;
    const lastBucket = history[history.length - 1];
    const entries = Object.values(lastBucket).filter(e => e.power > 0);
    if (entries.length === 0) return undefined;
    return entries.reduce((max, e) => e.power > max.power ? e : max).color;
}

/** Compute a blended sourceColor from the latest history bucket of a consumer node. */
export function computeSourceColor(node: { sourcePowerHistory?: { [sourceId: string]: { power: number; color: string } }[] }): string | undefined {
    const history = node.sourcePowerHistory;
    if (!history?.length) return undefined;
    const lastBucket = history[history.length - 1];
    const entries = Object.values(lastBucket).map(({ power, color }) => ({ hex: color, weight: power }));
    return entries.some(e => e.weight > 0) ? blendHex(entries) : undefined;
}

type CachingNode = {
    sourcePowerHistory?: { [sourceId: string]: { power: number; color: string } }[];
    _cachedDominantBucketRef?: object;
    _cachedDominantColor?: string;
    _cachedBlendedBucketRef?: object;
    _cachedBlendedColor?: string;
};

export function computeDominantSourceColorCached(node: CachingNode): string | undefined {
    const hist = node.sourcePowerHistory;
    if (!hist?.length) return undefined;
    const lastBucket = hist[hist.length - 1];
    if (node._cachedDominantBucketRef === lastBucket) return node._cachedDominantColor;
    const color = computeDominantSourceColor(node);
    node._cachedDominantBucketRef = lastBucket;
    node._cachedDominantColor = color;
    return color;
}

export function computeSourceColorCached(node: CachingNode): string | undefined {
    const hist = node.sourcePowerHistory;
    if (!hist?.length) return undefined;
    const lastBucket = hist[hist.length - 1];
    if (node._cachedBlendedBucketRef === lastBucket) return node._cachedBlendedColor;
    const color = computeSourceColor(node);
    node._cachedBlendedBucketRef = lastBucket;
    node._cachedBlendedColor = color;
    return color;
}

/** Weighted RGB average of hex color values. Returns gray if no active inputs. */
export function blendHex(colors: { hex: string; weight: number }[]): string {
    const active = colors.filter(c => c.weight > 0);
    if (active.length === 0) return NEUTRAL_COLOR;
    if (active.length === 1) return active[0].hex;
    const total = active.reduce((s, c) => s + c.weight, 0);
    let r = 0, g = 0, b = 0;
    for (const { hex, weight } of active) {
        const n = parseInt(hex.slice(1), 16);
        r += ((n >> 16) & 0xff) * weight / total;
        g += ((n >> 8)  & 0xff) * weight / total;
        b += (n         & 0xff) * weight / total;
    }
    return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
