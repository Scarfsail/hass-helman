export const SOLAR_COLOR = '#facc15'; // yellow-400
export const GRID_COLOR  = '#38bdf8'; // sky-400
export const BATT_COLOR  = '#22c55e'; // green-500

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

/** Returns the canonical color for a source node based on its sourceType. */
export function canonicalSourceColor(sourceType: string | null | undefined, fallback?: string): string {
    switch (sourceType) {
        case 'solar':   return SOLAR_COLOR;
        case 'grid':    return GRID_COLOR;
        case 'battery': return BATT_COLOR;
        default:        return fallback ?? '#6b7280';
    }
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
    if (active.length === 0) return '#6b7280';
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
