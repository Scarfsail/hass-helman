import { css, unsafeCSS } from "lit";

/**
 * The look every power flow shares: the simple card's beams and node halos,
 * the helman card's flow arrows and row outlines, and the node details' gauge
 * pills, which share the same glow. Every number of the look lives here and
 * nowhere else.
 *
 * One ratio drives it all, per flow and per node:
 * `r = (power - FLOW_FLOOR_W) / (max - FLOW_FLOOR_W)`, clamped to 0 – 1, with
 * one shared maximum on every card, `flowScaleW`: the largest of the solar,
 * battery and grid `max_power`, so equal watts look equal everywhere. A flow
 * at or under the 200 W floor draws at `r` = 0, the faintest look.
 * Every cue (thickness, brightness, a surge's tail and speed, level `k`, glow
 * size `s` and glow rate) comes from `r` through one easing `t = flowEase(r)`,
 * all continuous curves, so they always agree. A beam is a slim, dim pipe; a
 * surge is the pulse that lights it up: a hot head with a tail fading out
 * behind it, longer the stronger the flow, painted into one gradient. A
 * surge's speed is a velocity on screen, px/s, the same on every edge, and
 * its path (head and longest tail) and the spacing between surges are fixed
 * lengths on screen, so a flow pulses at the same rhythm on a short beam and
 * a long one. The helman card's beams end square against its boxes; the
 * simple card's fade out into their nodes, body, bloom and surges alike.
 *
 * Every edge runs its own tempo and every glow breathes at its own node's
 * rate; nothing shares a beat. What animates never carries data. The level
 * and size sit on static wrappers and geometry painted once; the animated
 * element only moves its transform, or its opacity between a fixed floor and
 * 1, on one keyframe set run at a fixed base duration. Its speed is its
 * `playbackRate` (`data-rate`; a surge's from its speed and its beam's
 * measured length), which `syncFlowRates` retunes in place, so a power tick
 * changes a surge's speed where it is, and the compositor runs every frame
 * without a style recalc or a paint. An edge's surge count comes from its
 * beam's length alone, so only a layout that resizes the beam re-renders its
 * surges, once.
 */

/** The surge's and glow's keyframes run once per this many ms at a `playbackRate` of 1. */
const SURGE_BASE_MS = 1000;
const GLOW_BASE_MS = 1000;

/** A surge's speed on screen, px/s, from `t` = 0 to 1, on every edge. */
const SURGE_SPEED = [3, 60] as const;

/** How far apart an edge's surges are, px of their path on screen, about. */
const SURGE_SPACING = 42;

/** A glow's period, ms, from `t` = 0 to 1: never quicker than one breath per 1300 ms. */
const GLOW_PERIOD_MS = [3900, 1300] as const;

/** One sweep of the grid illustration's wire dots, ms. */
export const WIRE_SWEEP_MS = 1300;

/** How a glow fades from its peak (`fade` of the period) to its floor, then rises back. */
const GLOW = { fade: 0.8, floor: 0.35 } as const;

/** A glow's opacity, as a share of its level, while motion is reduced. */
const STILL_GLOW = 0.6;

/** A beam's thickness, px: its floor, at `r` = 0, and at `r` = 1. */
const BEAM_THICKNESS = { floor: 1, max: 8 } as const;

/** A surge's head, px along its beam, and the tail fading out behind it, px, from `t` = 0 to 1. */
const TRAIL_HEAD = 3;
const TRAIL_TAIL = [14, 38] as const;

/**
 * A surge's gradient along its head and tail, from the tail's end to the
 * head's tip: where, as a share of the two, and the flow colour's strength
 * there. The stop after `colour` is the hot head; the head's tip is clear.
 */
const TRAIL_STOPS = { colour: [[0, 0], [0.55, 0.35], [0.86, 0.9]], hot: 0.94 } as const;

/** How far a simple-card beam fades out into its node at each end: px at most, and its share of a short beam. */
const BEAM_FADE = { max: 10, share: 0.3 } as const;

/** How much white the pulse head mixes into a flow's colour, on a dark theme. */
export const FLOW_HOT_MIX = "80%";

/** `cubic-bezier` control points that trace smoothstep, `3t² − 2t³`, exactly. */
const SMOOTHSTEP = "cubic-bezier(0.3333, 0, 0.6667, 1)";

/** The shared scale every flow is drawn against, W: the largest positive of `maxima`, else 0. */
export function flowScaleW(maxima: readonly (number | null | undefined)[]): number {
    return Math.max(0, ...maxima.filter((max): max is number => typeof max === "number" && max > 0));
}

/** The power, W, at or under which a flow or node draws at the lowest ratio. */
export const FLOW_FLOOR_W = 200;

/** The ratio a flow or node is drawn at: from the floor to `max`, 0 – 1; 0 when `max` is at or under the floor. */
export function flowRatio(power: number, max: number | null | undefined): number {
    return max && max > FLOW_FLOOR_W ? Math.min(Math.max(power - FLOW_FLOOR_W, 0) / (max - FLOW_FLOOR_W), 1) : 0;
}

/** The easing every cue takes `r` through, 0 – 1. */
export function flowEase(r: number): number {
    return Math.sqrt(r);
}

/** Level `k`: the brightness of a beam or glow, 0.2 – 1. */
export function flowLevel(r: number): number {
    return 0.2 + 0.8 * flowEase(r);
}

/** Glow size `s`, 0 – 1. */
export function flowGlowSize(r: number): number {
    return flowEase(r);
}

/** From `from` to `to`, read at `t` (0 – 1), linearly. */
const along = ([from, to]: readonly [number, number], t: number) => from + (to - from) * t;

/** Beam thickness, px. */
export function flowThickness(r: number): number {
    return along([BEAM_THICKNESS.floor, BEAM_THICKNESS.max], flowEase(r));
}

/** A surge's speed on screen, px/s. */
export function flowSpeed(r: number): number {
    return along(SURGE_SPEED, flowEase(r));
}

/** A surge's tail, px, behind its head. */
export function flowTail(r: number): number {
    return along(TRAIL_TAIL, flowEase(r));
}

/**
 * How many surges are on a beam `beamLength` px long at once: one per
 * `SURGE_SPACING` px of their crossing, at least one.
 */
export function flowSurgeCount(beamLength: number): number {
    return Math.max(1, Math.round(flowSurgeTravel(beamLength) / SURGE_SPACING));
}

/** A node's glow period, ms. */
export function flowGlowPeriodMs(r: number): number {
    return along(GLOW_PERIOD_MS, flowEase(r));
}

/**
 * The `playbackRate` that runs a glow's keyframe set of `baseMs` once per
 * `periodMs`, as `data-rate` carries it: rounded down to 0.01, so it never
 * runs quicker than its curve (never above one breath per 1300 ms).
 */
const rateFor = (baseMs: number, periodMs: number) => Math.floor(baseMs / periodMs * 100) / 100;

/**
 * The `playbackRate` of a surge moving at `speed` px/s along a beam
 * `beamLength` px long on screen: one loop is one crossing,
 * `flowSurgeTravel`. Rounded to three significant digits, so a slow surge on
 * a long beam never stops and is never more than 0.5 % off its speed.
 */
export function flowSurgeRate(speed: number, beamLength: number): number {
    return Number((SURGE_BASE_MS * speed / (flowSurgeTravel(beamLength) * 1000)).toPrecision(3));
}

/** The hot pulse head of a flow in colour `color`. */
function flowHot(color: string): string {
    return `color-mix(in srgb, white var(--helman-flow-hot-mix), ${color})`;
}

const pct = (share: number) => `${+(share * 100).toFixed(2)}%`;

/** `color` at `share` (0 – 1) of its strength. */
const tint = (color: string, share: number) => `color-mix(in srgb, ${color} ${+(share * 100).toFixed(1)}%, transparent)`;

/** Everything static about one beam. */
export interface FlowBeam {
    width: number;
    bodyOpacity: number;
    /** The bloom, as `box-shadow` takes it. */
    bloom: string;
    /** The same bloom's blur radius, px, and colour, for a beam that draws it as a blurred copy of itself. */
    bloomBlur: number;
    bloomColor: string;
    /** A surge's tail, px behind its head. */
    tail: number;
    /** A surge, px across: a pixel wider than its beam. */
    surgeWidth: number;
    surgeOpacity: number;
}

export function flowBeam(r: number, color: string): FlowBeam {
    const width = flowThickness(r);
    const k = flowLevel(r);
    const bloomBlur = +(0.6 * (width + 2 + 8 * k)).toFixed(2);
    const bloomColor = tint(color, 0.27 * k);
    return {
        width,
        bodyOpacity: 0.14 + 0.3 * k,
        bloom: `0 0 ${bloomBlur}px ${bloomColor}`,
        bloomBlur,
        bloomColor,
        tail: flowTail(r),
        surgeWidth: width + 1,
        surgeOpacity: 0.55 + 0.45 * k,
    };
}

/**
 * A surge's length as drawn, px: its head and the longest tail, whatever its
 * power, so its path never follows the power. A weaker flow's shorter tail
 * leaves the back of it clear.
 */
export const FLOW_SURGE_LENGTH = TRAIL_HEAD + TRAIL_TAIL[1];

/**
 * How far a surge's centre runs in one crossing of a beam `beamLength` px
 * long, px: from its head just before the beam's start, `FLOW_SURGE_LENGTH`
 * / 2 back, to its longest tail just past its end, as far past.
 */
export function flowSurgeTravel(beamLength: number): number {
    return beamLength + FLOW_SURGE_LENGTH;
}

/** The step the tail's share of a surge is rounded to in its gradient stops. */
const SURGE_STOP_STEP = 0.05;

/**
 * A surge's gradient from the back of `FLOW_SURGE_LENGTH` to its head's tip,
 * as stops: offset, colour, and the colour's strength. Clear behind its tail,
 * then the tail rising in the flow's colour to the hot head, and clear again
 * at the tip. Painted once into the surge, so it moves with its transform.
 * The share its head and tail take is rounded to `SURGE_STOP_STEP`, so a
 * power tick repaints the gradient only when the share crosses a step.
 */
export function flowTrailStops(color: string, beam: Pick<FlowBeam, "tail">): [number, string, number][] {
    const share = Math.round((TRAIL_HEAD + beam.tail) / FLOW_SURGE_LENGTH / SURGE_STOP_STEP) * SURGE_STOP_STEP;
    const at = (offset: number) => +(1 - share + offset * share).toFixed(4);
    const hot = flowHot(color);
    return [
        ...TRAIL_STOPS.colour.map(([offset, strength]): [number, string, number] => [at(offset), color, strength]),
        [at(TRAIL_STOPS.hot), hot, 1],
        [1, hot, 0],
    ];
}

/** A surge's gradient as a CSS background, running `direction` from its tail to its head. */
export function flowTrailGradient(color: string, beam: Pick<FlowBeam, "tail">, direction: string): string {
    return `linear-gradient(${direction}, ${flowTrailStops(color, beam).map(([offset, stop, strength]) => `${tint(stop, strength)} ${pct(offset)}`).join(", ")})`;
}

/** How much of a simple-card beam `beamLength` px long fades out at each end, as a share of it. */
export function flowFadeShare(beamLength: number): number {
    return +Math.min(BEAM_FADE.max / beamLength, BEAM_FADE.share).toFixed(4);
}

/** One surge of an edge: its `animation-delay` and, while motion is reduced, where it rests. */
export interface FlowSurge {
    delay: string;
    /**
     * The share of its path it rests at: where its head sits on the beam, so
     * the edge's surges spread evenly along it and each stays on it.
     */
    rest: number;
}

/**
 * The surges on one edge, on a beam `beamLength` px long on screen as
 * `syncFlowRates` measured it, and the `playbackRate` they run at. Each one's
 * loop is one crossing: it enters wholly before the beam's start and leaves
 * wholly past its end. They are spread evenly over the loop, by a delay in the
 * animation's own time, which holds at any rate. A beam not measured yet, or
 * not laid out, carries none.
 */
export function flowSurges(r: number, beamLength: number | undefined): { count: number; rate: number; surges: FlowSurge[] } {
    if (!beamLength) {
        return { count: 0, rate: 0, surges: [] };
    }
    const count = flowSurgeCount(beamLength);
    return {
        count,
        rate: flowSurgeRate(flowSpeed(r), beamLength),
        surges: Array.from({ length: count }, (_, index) => ({
            delay: `${-Math.round(index / count * SURGE_BASE_MS)}ms`,
            // Its head starts on the beam's start and covers one crossing over the path, so it rests that far along the beam.
            rest: (index + 1) / (count + 1) * beamLength / flowSurgeTravel(beamLength),
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

/** The keyframe sets the surge and glow run, the only animations `syncFlowRates` retunes. */
const SURGE_KEYFRAMES = "helman-surge";
const GLOW_KEYFRAMES = "helman-glow";

/**
 * The surge and glow animations, each one keyframe set at its base duration;
 * `syncFlowRates` sets each one's speed from its element's `data-rate`.
 *
 * `[data-beat="surge"]` moves its centre from `--surge-start-x/y`
 * (`FLOW_SURGE_LENGTH` / 2 back from the beam's start) to the far side of the beam's
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

/** Each beam's length on screen, px, by its `data-flow-beam` key. */
export type FlowBeamLengths = Record<string, number>;

/** What `syncFlowRates` keeps per root. */
interface FlowRoot {
    /**
     * The `data-rate` each of its `data-beat` elements' animations were last
     * set to. Rebuilt on every sync, so an element that loses `data-beat`
     * drops out, and gets its rate again when it regains it.
     */
    rates: Map<Element, string>;
    /** Each beam's length as last measured; cleared when the layout resizes one. */
    measured: Map<Element, number>;
    /** The lengths last handed to `onLengths`. */
    lengths: FlowBeamLengths;
    onLengths?: (lengths: FlowBeamLengths) => void;
    /**
     * Watches what sizes each beam and never follows its power (an SVG beam its `<svg>`, an HTML beam its
     * parent, as a beam's own width does), made once the root has a beam.
     */
    resize?: ResizeObserver;
    observed: Set<Element>;
}

const roots = new WeakMap<ParentNode, FlowRoot>();

/** A measured length, px, to 0.01 px: a re-measure of the same layout reads the same. */
const roundLength = (length: number) => Math.round(length * 100) / 100;

/**
 * A beam's length on screen, px, to 0.01 px: a `<line>` from its ends through its screen
 * transform, so its stroke never counts, any other beam down its height.
 */
function measureBeam(beam: Element): number {
    if (beam instanceof SVGLineElement) {
        const ctm = beam.getScreenCTM();
        if (!ctm) {
            return 0;
        }
        const start = new DOMPoint(beam.x1.baseVal.value, beam.y1.baseVal.value).matrixTransform(ctm);
        const end = new DOMPoint(beam.x2.baseVal.value, beam.y2.baseVal.value).matrixTransform(ctm);
        return roundLength(Math.hypot(end.x - start.x, end.y - start.y));
    }
    return roundLength(beam.getBoundingClientRect().height);
}

/** Whether two sets of beam lengths are the same. */
const sameLengths = (a: FlowBeamLengths, b: FlowBeamLengths) =>
    Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);

/**
 * Measure the `[data-flow-beam]` beams under `root`, each once until the
 * layout resizes it, and hand their lengths to `state.onLengths` when they
 * differ from the last ones handed over.
 */
function measureBeams(root: ParentNode & EventTarget, state: FlowRoot): void {
    const measured = new Map<Element, number>();
    const lengths: FlowBeamLengths = {};
    const observed = new Set<Element>();
    for (const beam of root.querySelectorAll("[data-flow-beam]")) {
        const length = state.measured.get(beam) ?? measureBeam(beam);
        measured.set(beam, length);
        lengths[beam.getAttribute("data-flow-beam")!] = length;
        observed.add((beam instanceof SVGElement ? beam.ownerSVGElement : beam.parentElement) ?? beam);
    }
    state.measured = measured;
    if (observed.size > 0 && !state.resize) {
        state.resize = new ResizeObserver(() => {
            state.measured.clear();
            syncFlowRates(root, state.onLengths);
        });
    }
    for (const target of state.observed) {
        if (!observed.has(target)) {
            state.resize!.unobserve(target);
        }
    }
    for (const target of observed) {
        if (!state.observed.has(target)) {
            state.resize!.observe(target);
        }
    }
    state.observed = observed;
    if (!sameLengths(lengths, state.lengths)) {
        state.lengths = lengths;
        state.onLengths?.(lengths);
    }
}

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
 * element's `data-rate`, and hand the on-screen lengths of the beams marked
 * `data-flow-beam` to `onLengths`, whenever they change. A card renders each
 * edge's surges from its beam's length (`flowSurges`), so a beam not yet
 * measured carries none until the first sync hands its length over, and a
 * layout that resizes it hands the new one over.
 *
 * `updatePlaybackRate` keeps an animation's progress, so a new rate changes a
 * surge's speed where it is, without a restart or a jump. Reading an
 * element's animations flushes style, and measuring a beam layout, so a
 * render only reads an element when it is new or its rate changed, and only
 * measures a beam when it is new or the layout resized it, which sets it
 * before it is first painted. The browser also starts animations without a
 * render: on a remount, or when a hidden ancestor is shown. Each of those
 * fires `animationstart` on its element, and the root sets that element's
 * rate then.
 */
export function syncFlowRates(root: ParentNode & EventTarget, onLengths?: (lengths: FlowBeamLengths) => void): void {
    let state = roots.get(root);
    if (!state) {
        root.addEventListener("animationstart", (event) => {
            const element = event.target as Element;
            const rate = element.getAttribute("data-rate");
            if (rate !== null) {
                applyRate(element, rate);
            }
        });
        state = { rates: new Map(), measured: new Map(), lengths: {}, observed: new Set() };
        roots.set(root, state);
    }
    state.onLengths = onLengths;
    if (onLengths) {
        measureBeams(root, state);
    }

    const applied = new Map<Element, string>();
    for (const element of root.querySelectorAll("[data-beat][data-rate]")) {
        const rate = element.getAttribute("data-rate")!;
        applied.set(element, rate);
        if (state.rates.get(element) !== rate) {
            applyRate(element, rate);
        }
    }
    state.rates = applied;
}
