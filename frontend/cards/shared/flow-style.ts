import { css, unsafeCSS } from "lit";

/**
 * The look every power flow shares: the simple card's beams and node halos,
 * the helman card's flow arrows and row outlines, and the node details' gauge
 * pills, which share the same glow. Every number of the look lives here and
 * nowhere else.
 *
 * One ratio drives it all, per flow and per node: `r = min(power / max, 1)`,
 * with the maximum the card already scales that flow by. From `r` come the
 * cues (thickness, and through one easing `e` the level `k`, glow size `s`,
 * surge speed and spacing, and glow rate), all continuous curves.
 *
 * Every edge runs its own tempo and every glow breathes at its own node's
 * rate; nothing shares a beat. What animates never carries data. The level
 * and size sit on static wrappers and geometry painted once; the animated
 * element only moves its transform, or its opacity between a fixed floor and
 * 1, on one keyframe set run at a fixed base duration. Its speed is its
 * `playbackRate` (`data-rate`), which `syncFlowRates` retunes in place, so a
 * power tick changes a surge's speed where it is, and the compositor runs
 * every frame without a style recalc or a paint. Only a step in an edge's
 * surge count re-renders that edge's surges, once.
 */

/** The surge's and glow's keyframes run once per this many ms at a `playbackRate` of 1. */
const SURGE_BASE_MS = 1000;
const GLOW_BASE_MS = 1000;

/** How long a surge takes to cross a long and a short edge, ms, from `e` = 0 to 1. */
const TRAVEL_MS = { long: [3900, 1300], short: [1300, 650] } as const;

/** The most surges on a long and a short edge at once. */
const MAX_SURGES = { long: 3, short: 2 } as const;

/** A glow's period, ms, from `e` = 0 to 1: never quicker than one breath per 1300 ms. */
const GLOW_PERIOD_MS = [3900, 1300] as const;

/** One sweep of the grid illustration's wire dots, ms. */
export const WIRE_SWEEP_MS = 1300;

/** How a glow fades from its peak (`fade` of the period) to its floor, then rises back. */
const GLOW = { fade: 0.8, floor: 0.35 } as const;

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

/** The easing every cue but thickness takes `r` through, 0 – 1. */
export function flowEase(r: number): number {
    return r ** 0.7;
}

/** Level `k`: the brightness of a beam or glow, 0.2 – 1. */
export function flowLevel(r: number): number {
    return 0.2 + 0.8 * flowEase(r);
}

/** Glow size `s`, 0 – 1. */
export function flowGlowSize(r: number): number {
    return flowEase(r);
}

/** From `from` to `to`, read at `e`, linearly. */
const along = ([from, to]: readonly [number, number], e: number) => from + (to - from) * e;

/** How long a surge takes to cross its edge, ms. */
export function flowTravelMs(r: number, short: boolean): number {
    return along(TRAVEL_MS[short ? "short" : "long"], flowEase(r));
}

/** How many surges are on an edge at once: at least two, so one is always on the beam. */
export function flowSurgeCount(r: number, short: boolean): number {
    const max = MAX_SURGES[short ? "short" : "long"];
    return Math.min(max, 2 + Math.floor(flowEase(r) * (max - 1)));
}

/** A node's glow period, ms. */
export function flowGlowPeriodMs(r: number): number {
    return along(GLOW_PERIOD_MS, flowEase(r));
}

/**
 * The `playbackRate` that runs a keyframe set of `baseMs` once per `periodMs`,
 * as `data-rate` carries it: rounded down to 0.01, so it never runs quicker
 * than its curve (a glow never above one breath per 1300 ms).
 */
const rateFor = (baseMs: number, periodMs: number) => Math.floor(baseMs / periodMs * 100) / 100;

/** The hot core of a flow in colour `color`. */
export function flowHot(color: string): string {
    return `color-mix(in srgb, white var(--helman-flow-hot-mix), ${color})`;
}

/** `color` at `share` (0 – 1) of its strength. */
const tint = (color: string, share: number) => `color-mix(in srgb, ${color} ${+(share * 100).toFixed(1)}%, transparent)`;

/** Everything static about one beam. */
export interface FlowBeam {
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

/**
 * Where a surge's centre starts along such a beam, as a CSS length: half a
 * surge length back from its start, against `towards` (1 or -1), the
 * direction the beam runs in.
 */
export function flowSurgeStartCss(towards: number): string {
    return `calc(${FLOW_SURGE_LENGTH_CSS} * ${-towards / 2})`;
}

/** The surge's soft blob, as gradient stops: offset, colour. */
export function flowSurgeStops(color: string): [number, string][] {
    return [[0, flowHot(color)], [0.6, tint(color, 0.6)], [1, "transparent"]];
}

/** The surge's soft blob, as a CSS background. */
export function flowSurgeGradient(color: string): string {
    return `radial-gradient(closest-side, ${flowSurgeStops(color).map(([offset, stop]) => `${stop} ${offset * 100}%`).join(", ")})`;
}

/** One surge of an edge: its `animation-delay` and, while motion is reduced, where it rests. */
export interface FlowSurge {
    delay: string;
    /** The share of its path it rests at, so the edge's surges spread evenly along the beam. */
    rest: number;
}

/**
 * The surges on one edge and the `playbackRate` they run at. Each one's loop
 * is one crossing: its centre runs from half a surge length before the beam's
 * start to half a surge length past its end, so one leaves as the last one
 * goes. They are spread evenly over the loop, by a delay in the animation's
 * own time, which holds at any rate.
 */
export function flowSurges(r: number, short: boolean): { count: number; rate: number; surges: FlowSurge[] } {
    const count = flowSurgeCount(r, short);
    return {
        count,
        rate: rateFor(SURGE_BASE_MS, flowTravelMs(r, short)),
        surges: Array.from({ length: count }, (_, index) => ({
            delay: `${-Math.round(index / count * SURGE_BASE_MS)}ms`,
            rest: (index + 1) / (count + 1),
        })),
    };
}

/** Everything static about one node's glow. */
export interface FlowGlow {
    level: number;
    size: number;
    /** Its `playbackRate`, from its own node's ratio alone. */
    rate: number;
}

export function flowGlow(r: number): FlowGlow {
    return { level: flowLevel(r), size: flowGlowSize(r), rate: rateFor(GLOW_BASE_MS, flowGlowPeriodMs(r)) };
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

const pct = (share: number) => `${+(share * 100).toFixed(2)}%`;

/** The keyframe sets the surge and glow run, the only animations `syncFlowRates` retunes. */
const SURGE_KEYFRAMES = "helman-surge";
const GLOW_KEYFRAMES = "helman-glow";

/**
 * The surge and glow animations, each one keyframe set at its base duration;
 * `syncFlowRates` sets each one's speed from its element's `data-rate`.
 *
 * `[data-beat="surge"]` moves its centre from `--surge-start-x/y` (half a
 * surge length back from the beam's start) to the far side of the beam's
 * vector `--surge-x/y`, as far past its end. `[data-beat="glow"]`, or the
 * `::after` of `[data-beat="glow-after"]`, ripples its opacity between a fixed
 * floor and 1. Motion reduced, a surge rests at `--surge-rest` of its path.
 */
export const flowBeatStyles = css`
    [data-beat="surge"] { transform-box: view-box; }
    @media (prefers-reduced-motion: no-preference) {
        [data-beat="surge"] { animation: ${unsafeCSS(SURGE_KEYFRAMES)} ${SURGE_BASE_MS}ms linear infinite; }
        [data-beat="glow"], [data-beat="glow-after"]::after { animation: ${unsafeCSS(GLOW_KEYFRAMES)} ${GLOW_BASE_MS}ms infinite; }
    }
    @keyframes ${unsafeCSS(SURGE_KEYFRAMES)} {
        from { transform: translate(var(--surge-start-x), var(--surge-start-y)); }
        to { transform: translate(calc(var(--surge-x) - var(--surge-start-x)), calc(var(--surge-y) - var(--surge-start-y))); }
    }
    @keyframes ${unsafeCSS(GLOW_KEYFRAMES)} {
        0% { opacity: 1; animation-timing-function: ${unsafeCSS(SMOOTHSTEP)}; }
        ${unsafeCSS(pct(GLOW.fade))} { opacity: ${GLOW.floor}; animation-timing-function: ${unsafeCSS(SMOOTHSTEP)}; }
        100% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
        [data-beat="surge"] {
            transform: translate(
                calc(var(--surge-start-x) + (var(--surge-x) - 2 * var(--surge-start-x)) * var(--surge-rest)),
                calc(var(--surge-start-y) + (var(--surge-y) - 2 * var(--surge-start-y)) * var(--surge-rest)));
        }
        [data-beat="glow"], [data-beat="glow-after"]::after { opacity: ${STILL_GLOW}; }
    }
`;

/**
 * Per root, the `data-rate` each of its `data-beat` elements' animations were
 * last set to. Rebuilt on every sync, so an element that loses `data-beat`
 * drops out, and gets its rate again when it regains it.
 */
const appliedRates = new WeakMap<ParentNode, Map<Element, string>>();

/** The roots already listening for animations the browser starts on its own. */
const listening = new WeakSet<ParentNode>();

/** Run the surge and glow animations of `element` and its pseudo-elements at `rate`. */
function applyRate(element: Element, rate: string): void {
    for (const animation of element.getAnimations({ subtree: true })) {
        if (animation instanceof CSSAnimation
            && (animation.animationName === SURGE_KEYFRAMES || animation.animationName === GLOW_KEYFRAMES)) {
            animation.updatePlaybackRate(Number(rate));
        }
    }
}

/**
 * Set every animation of the `data-beat` elements under `root` to its
 * element's `data-rate`.
 *
 * `updatePlaybackRate` keeps an animation's progress, so a new rate changes a
 * surge's speed where it is, without a restart or a jump. Reading an
 * element's animations flushes style, so a render only reads an element when
 * it is new or its rate changed, which sets it before it is first painted.
 * The browser also starts animations without a render: on a remount, or when
 * a hidden ancestor is shown. Each of those fires `animationstart` on its
 * element, and the root sets that element's rate then.
 */
export function syncFlowRates(root: ParentNode & EventTarget): void {
    if (!listening.has(root)) {
        listening.add(root);
        root.addEventListener("animationstart", (event) => {
            const element = event.target as Element;
            const rate = element.getAttribute("data-rate");
            if (rate !== null) {
                applyRate(element, rate);
            }
        });
    }
    const previous = appliedRates.get(root);
    const applied = new Map<Element, string>();
    for (const element of root.querySelectorAll("[data-beat][data-rate]")) {
        const rate = element.getAttribute("data-rate")!;
        applied.set(element, rate);
        if (previous?.get(element) !== rate) {
            applyRate(element, rate);
        }
    }
    appliedRates.set(root, applied);
}
