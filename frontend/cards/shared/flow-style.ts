import { css, unsafeCSS } from "lit";

/**
 * The look every power flow shares: the simple card's beams and node halos,
 * the helman card's flow arrows and row outlines, and the node details' gauge
 * pills, which follow the same beat. Every number of the look lives here and
 * nowhere else.
 *
 * One ratio drives it all, per flow and per node: `r = min(power / max, 1)`,
 * with the maximum the card already scales that flow by. From `r` come the
 * continuous cues (thickness, level `k`, glow size `s`) and the tier, which
 * picks the rhythm on one shared half-beat grid.
 *
 * What animates never carries data. The continuous cues sit on static
 * wrappers and geometry painted once; the animated element only moves its
 * transform, or its opacity between its tier's fixed floor and 1. Three tiers
 * are three keyframe sets, so a power tick that stays within a tier restarts
 * nothing, and the compositor runs every frame without a style recalc or a
 * paint.
 */

/** The beat every pulse and glow sits on, ms. */
export const BEAT_MS = 1300;

export type FlowTier = 0 | 1 | 2;

/**
 * The rhythm of each tier, in beats: how often a surge leaves, how long it
 * takes to cross a long and a short edge, and how a node's glow fades from its
 * peak (`fade` of the period), rises back (`rise`) and the floor it rests on.
 */
const TIERS = [
    { from: 0, interval: 2, travel: { long: 2.5, short: 1 }, glow: { rise: 0.35, fade: 0.65, floor: 0.2 } },
    { from: 0.2, interval: 1, travel: { long: 1.5, short: 0.5 }, glow: { rise: 0.2, fade: 0.8, floor: 0.35 } },
    { from: 0.5, interval: 0.5, travel: { long: 1, short: 0.5 }, glow: { rise: 0.4, fade: 0.6, floor: 0.55 } },
] as const;

/** When the helman card's arrow rows leave, in beats: the sources' first, the consumers' half a beat later. */
export const ROW_LEAVES_AT = { sources: 0, consumers: 0.5 } as const;

/** A glow's opacity, as a share of its level, while motion is reduced. */
const STILL_GLOW = 0.6;

/** The surge: its length, px, and the share of a short beam it may take at most. */
const SURGE_LENGTH = 36;
const SURGE_MAX_SHARE = 0.9;

/** The hot core's share of the beam's thickness. */
const CORE_SHARE = 0.35;

/** How much white the hot core mixes into a flow's colour, on a dark theme. */
export const FLOW_HOT_MIX = "80%";

/** `cubic-bezier` control points that trace smoothstep, `3t² − 2t³`, exactly. */
const SMOOTHSTEP = "cubic-bezier(0.3333, 0, 0.6667, 1)";

/** The ratio a flow or node is drawn at. */
export function flowRatio(power: number, max: number | null | undefined): number {
    return max ? Math.min(Math.max(power, 0) / max, 1) : 0;
}

/** Beam thickness, px. */
export function flowThickness(r: number): number {
    return Math.max(2.5, r * 14);
}

/** Level `k`: the brightness of a beam or glow, 0.2 – 1. */
export function flowLevel(r: number): number {
    return 0.2 + 0.8 * r ** 0.7;
}

/** Glow size `s`, 0 – 1. */
export function flowGlowSize(r: number): number {
    return (flowLevel(r) - 0.2) / 0.8;
}

export function flowTier(r: number): FlowTier {
    return r >= TIERS[2].from ? 2 : r >= TIERS[1].from ? 1 : 0;
}

/** How often a surge leaves and how long it travels, in beats. */
export function flowTempo(tier: FlowTier, short: boolean): { interval: number; travel: number } {
    const { interval, travel } = TIERS[tier];
    return { interval, travel: short ? travel.short : travel.long };
}

/** When a flow's surges land, in beats, given when they leave. */
export function flowLandsAt(leavesAt: number, r: number, short: boolean): number {
    return leavesAt + flowTempo(flowTier(r), short).travel;
}

/** The `--beat-delay` that puts a loop of `period` beats at its start on `phase`, on the shared origin. */
export function beatDelay(phase: number, period: number): string {
    const offset = ((phase % period) + period) % period;
    return `${Math.round((offset - period) * BEAT_MS)}ms`;
}

/** The hot core of a flow in colour `color`. */
export function flowHot(color: string): string {
    return `color-mix(in srgb, white var(--helman-flow-hot-mix), ${color})`;
}

/** `color` at `share` (0 – 1) of its strength. */
const tint = (color: string, share: number) => `color-mix(in srgb, ${color} ${+(share * 100).toFixed(1)}%, transparent)`;

/** Everything static about one beam. */
export interface FlowBeam {
    tier: FlowTier;
    width: number;
    coreWidth: number;
    bodyOpacity: number;
    /** The bloom, as `box-shadow` takes it. */
    bloom: string;
    /** The same bloom's blur radius, px, and colour, for a beam that draws it as a blurred copy of itself. */
    bloomBlur: number;
    bloomColor: string;
    surgeThickness: number;
    surgeOpacity: number;
}

export function flowBeam(r: number, color: string): FlowBeam {
    const width = flowThickness(r);
    const k = flowLevel(r);
    const bloomBlur = +(width + 2 + 8 * k).toFixed(2);
    const bloomColor = tint(color, 0.85 * k);
    return {
        tier: flowTier(r),
        width,
        coreWidth: width * CORE_SHARE,
        bodyOpacity: 0.25 + 0.65 * k,
        bloom: `0 0 ${bloomBlur}px ${bloomColor}`,
        bloomBlur,
        bloomColor,
        surgeThickness: width + 4 + 10 * k,
        surgeOpacity: 0.35 + 0.65 * k,
    };
}

/** A surge's length along a beam `beamLength` px long. */
export function flowSurgeLength(beamLength: number): number {
    return Math.min(SURGE_LENGTH, SURGE_MAX_SHARE * beamLength);
}

/** The same, for a beam whose length is the reference box of a CSS percentage. */
export const FLOW_SURGE_LENGTH_CSS = `min(${SURGE_LENGTH}px, ${SURGE_MAX_SHARE * 100}%)`;

/** The surge's soft blob, as gradient stops: offset, colour. */
export function flowSurgeStops(color: string): [number, string][] {
    return [[0, flowHot(color)], [0.6, tint(color, 0.6)], [1, "transparent"]];
}

/** The surge's soft blob, as a CSS background. */
export function flowSurgeGradient(color: string): string {
    return `radial-gradient(closest-side, ${flowSurgeStops(color).map(([offset, stop]) => `${stop} ${offset * 100}%`).join(", ")})`;
}

/** One surge of an edge: its `--beat-delay` and, while motion is reduced, where it rests. */
export interface FlowSurge {
    delay: string;
    /** The share of `reach` it rests at, so the edge's surges spread evenly along the beam. */
    rest: number;
}

/** How many surges are in transit on an edge at once, and the loop each one runs on, in beats. */
function flowLoop(tier: FlowTier, short: boolean): { count: number; loop: number } {
    const { interval, travel } = flowTempo(tier, short);
    const count = Math.floor(travel / interval) + 1;
    return { count, loop: count * interval };
}

/**
 * The surges in transit on one edge. Each runs on a loop of as many intervals
 * as there are surges, staggered by one interval: its centre is at the beam's
 * start at loop time 0, at its end one travel later, and it then runs on out
 * of the clip. `reach` is how far it gets in a whole loop, in beam lengths.
 */
export function flowSurges(tier: FlowTier, short: boolean, leavesAt: number): { reach: number; surges: FlowSurge[] } {
    const { interval, travel } = flowTempo(tier, short);
    const { count, loop } = flowLoop(tier, short);
    const reach = loop / travel;
    return {
        reach,
        surges: Array.from({ length: count }, (_, index) => ({
            delay: beatDelay(leavesAt + index * interval, loop),
            rest: (index + 1) / (count + 1) / reach,
        })),
    };
}

/** Everything static about one node's glow. */
export interface FlowGlow {
    tier: FlowTier;
    level: number;
    size: number;
    /** Its `--beat-delay`, peaking on `phase` (beats). */
    delay: string;
}

export function flowGlow(r: number, phase: number): FlowGlow {
    const tier = flowTier(r);
    return { tier, level: flowLevel(r), size: flowGlowSize(r), delay: beatDelay(phase, TIERS[tier].interval) };
}

/** The simple card's halo: how far it reaches past the illustration, px, and its fill. */
export function flowHalo(color: string, size: number): { extent: number; background: string } {
    return { extent: 2 + 24 * size, background: `radial-gradient(closest-side, ${tint(color, 0.65)}, transparent)` };
}

/** The helman card's row outline; the distribution row draws nothing inside itself. */
export function flowRowGlow(color: string, size: number, inside: boolean): { borderWidth: string; boxShadow: string } {
    const outer = `0 0 ${+(3 + 20 * size).toFixed(2)}px ${+(5 * size).toFixed(2)}px ${tint(color, 0.75)}`;
    return {
        borderWidth: `${+(1 + 1.5 * size).toFixed(2)}px`,
        boxShadow: inside ? `${outer}, inset 0 0 ${+(2 + 12 * size).toFixed(2)}px ${tint(color, 0.6)}` : outer,
    };
}

const ms = (beats: number) => `${Math.round(beats * BEAT_MS)}ms`;
const pct = (share: number) => `${+(share * 100).toFixed(2)}%`;

/**
 * The surge and glow animations, keyed by `data-tier`.
 *
 * `[data-beat="surge"]` moves from its resting transform to
 * `translate(var(--surge-x), var(--surge-y))`, a whole loop's `reach`;
 * `data-short` marks a short edge. `[data-beat="glow"]`, or the `::after` of
 * `[data-beat="glow-after"]`, ripples its opacity between its tier's floor and
 * 1. The phase is the delay in `--beat-delay` (inherited, so it reaches an
 * `::after`); `alignToBeat` puts every one of them on the same origin.
 */
export const flowBeatStyles = css`
    [data-beat="surge"] { transform-box: view-box; }
    @media (prefers-reduced-motion: no-preference) {
        ${unsafeCSS(TIERS.map((_, tier) => ([false, true] as const).map((short) =>
            `[data-beat="surge"][data-tier="${tier}"]${short ? "[data-short]" : ""} { animation: helman-surge ${ms(flowLoop(tier as FlowTier, short).loop)} linear infinite var(--beat-delay, 0ms); }`,
        ).join("\n")).join("\n"))}
        ${unsafeCSS(TIERS.map(({ interval }, tier) => `
            [data-beat="glow"][data-tier="${tier}"], [data-beat="glow-after"][data-tier="${tier}"]::after {
                animation: helman-glow-${tier} ${ms(interval)} var(--beat-delay, 0ms) infinite;
            }`).join("\n"))}
    }
    @keyframes helman-surge {
        from { transform: translate(0, 0); }
        to { transform: translate(var(--surge-x), var(--surge-y)); }
    }
    ${unsafeCSS(TIERS.map(({ glow }, tier) => `
        @keyframes helman-glow-${tier} {
            0% { opacity: 1; animation-timing-function: ${SMOOTHSTEP}; }
            ${pct(glow.fade)} { opacity: ${glow.floor}; animation-timing-function: ${SMOOTHSTEP}; }
            ${pct(glow.fade + glow.rise)} { opacity: 1; }
        }`).join("\n"))}
    @media (prefers-reduced-motion: reduce) {
        [data-beat="surge"] {
            transform: translate(calc(var(--surge-x) * var(--surge-rest)), calc(var(--surge-y) * var(--surge-rest)));
        }
        [data-beat="glow"], [data-beat="glow-after"]::after { opacity: ${STILL_GLOW}; }
    }
`;

/** The tier each `data-beat` element was last aligned at: a new tier is a new animation. */
const alignedAt = new WeakMap<Element, string | null>();

/** The roots already listening for animations the browser starts on its own. */
const listening = new WeakSet<ParentNode>();

/** Put the running animations of `element` and its pseudo-elements on the origin. */
function alignElement(element: Element): void {
    for (const animation of element.getAnimations({ subtree: true })) {
        if (animation.playState === "running" && animation.startTime !== 0) {
            animation.startTime = 0;
        }
    }
}

/**
 * Lock every animation of the `data-beat` elements under `root` to the
 * document timeline's origin.
 *
 * A CSS animation starts whenever its element first renders, so animations in
 * different shadow roots drift apart; with `startTime = 0` they all count from
 * the same instant, and each one's phase is its delay. A paused one is left
 * alone: setting its start time would resume it and take its play state away
 * from CSS.
 *
 * Reading an element's animations flushes style, so a render only reads an
 * element when it is new or its tier, and with it its animation, changed,
 * which aligns it before it is first painted. The browser also starts
 * animations without a render: on a remount, or when a hidden ancestor is
 * shown. Each of those fires `animationstart` on its element, and the root
 * aligns that element then, after style is already resolved. `force` reads
 * them all, for animations that just resumed.
 */
export function alignToBeat(root: ParentNode & EventTarget, force = false): void {
    if (!listening.has(root)) {
        listening.add(root);
        root.addEventListener("animationstart", (event) => alignElement(event.target as Element));
    }
    for (const element of root.querySelectorAll("[data-beat]")) {
        const tier = element.getAttribute("data-tier");
        if (!force && alignedAt.has(element) && alignedAt.get(element) === tier) {
            continue;
        }
        alignedAt.set(element, tier);
        alignElement(element);
    }
}
