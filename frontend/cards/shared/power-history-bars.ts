import { LitElement, TemplateResult, css, html, svg } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";

/**
 * A row of vertical bars: one bar per time bucket, each bar's height scaled
 * against a shared maximum and split into the energy sources that fed it.
 *
 * Deliberately knows nothing about where the buckets came from. The power card
 * feeds it a live rolling buffer of watts; the solar inspector feeds it per-slot
 * historical energy. Both are "a value per bucket plus how it was sourced", so
 * both get the same picture out of it.
 *
 * Drawn as a single `<svg>` with one `<path>` per distinct colour, each path's
 * `d` chaining one axis-aligned rectangle subpath per segment. A flat row of 60
 * buckets is 2 elements instead of 121; the rectangles never overlap, so merging
 * them across columns is visually exact. The viewBox is one unit per bucket by
 * 100 tall with `preserveAspectRatio="none"`, which reproduces the equal
 * `flex-grow: 1` columns and the percentage heights the flex layout used before.
 */

/** How one source contributed to a single bucket. */
export type SourceContribution = { power: number; color: string };

/** The per-source split of one bucket, keyed by source id. */
export type BucketSourceMix = { [sourceId: string]: SourceContribution };

/** One source's slice of a bar, in viewBox units (the bar row is 100 tall). */
type BarSegment = { height: number; color: string };
/** All the rectangles that share one colour, as a single path definition. */
type ColorPath = { color: string; d: string };

/** Path coordinates only ever need sub-pixel precision; keep `d` short. */
const round = (n: number): number => Math.round(n * 1000) / 1000;

@customElement("helman-power-history-bars")
export class HelmanPowerHistoryBars extends LitElement {
    static get styles() {
        return css`
            .historyContainer {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                /* Explicit, so the svg's viewBox aspect ratio can never make it
                   shrink-to-fit instead of filling the box the flex row filled. */
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
                z-index: 1;
            }
        `;
    }

    /** One value per bucket, oldest first. */
    @property({ attribute: false }) public historyToRender!: number[];
    /** The value a full-height bar represents; shared across sibling rows. */
    @property({ type: Number }) public maxHistoryPower!: number;
    /** Painted when a bucket has no source split to show. */
    @property({ type: String }) public historyBarColor!: string;
    /** Per-bucket source split, index-aligned with `historyToRender`. Omit for a flat bar. */
    @property({ attribute: false }) public sourceHistory?: (BucketSourceMix | undefined)[];

    @state() private _paths: ColorPath[] = [];
    @state() private _bucketCount = 0;

    willUpdate(changedProperties: Map<string, unknown>): void {
        if (!changedProperties.has('historyToRender')
            && !changedProperties.has('maxHistoryPower')
            && !changedProperties.has('sourceHistory')
            && !changedProperties.has('historyBarColor')) {
            return;
        }

        const hist = this.historyToRender ?? [];
        const max = this.maxHistoryPower;
        const sourcePerBucket = this.sourceHistory;
        const fallbackColor = this.historyBarColor;

        // One rectangle per segment, appended to the subpath bucket for its colour.
        // Colours come from a small fixed palette, so this is a handful of paths.
        const byColor = new Map<string, string[]>();
        const appendRect = (color: string, x: number, y: number, height: number): void => {
            let parts = byColor.get(color);
            if (!parts) {
                parts = [];
                byColor.set(color, parts);
            }
            parts.push(`M${x} ${round(y)}h1v${round(height)}h-1z`);
        };

        for (let i = 0; i < hist.length; i++) {
            const p = hist[i];
            // Clamped at zero: a negative value used to yield `height: -5%`, which
            // CSS dropped harmlessly. A negative `v` in a path would draw a visible
            // rectangle above the baseline instead.
            const barHeight = max > 0 ? Math.max(0, Math.min(100, (p / max) * 100)) : 0;
            if (barHeight <= 0) {
                continue;
            }

            const sourceMix = sourcePerBucket?.[i];
            const segments: BarSegment[] = [];
            if (sourceMix) {
                for (const s of Object.values(sourceMix)) {
                    if (p > 0) {
                        // Fraction of the bucket's value, so of the bar's height.
                        // Not renormalised: where the mix does not add up to the
                        // bucket, the gap at the top of the bar is kept.
                        segments.push({ height: (s.power / p) * barHeight, color: s.color });
                    }
                }
            }
            if (segments.length === 0) {
                segments.push({ height: barHeight, color: fallbackColor });
            }

            // Stacked from the baseline upwards, in mix order — the same order the
            // `flex-direction: column-reverse` bar container laid them out in.
            let y = 100;
            for (const segment of segments) {
                const height = Math.max(0, segment.height);
                if (height <= 0) {
                    continue;
                }
                y -= height;
                appendRect(segment.color, i, y, height);
            }
        }

        this._bucketCount = hist.length;
        this._paths = Array.from(byColor, ([color, parts]) => ({ color, d: parts.join('') }));
    }

    render(): TemplateResult {
        // A zero-width viewBox is degenerate, and there is nothing to draw anyway.
        const width = Math.max(1, this._bucketCount);
        return html`
            <svg class="historyContainer"
                 viewBox="0 0 ${width} 100"
                 preserveAspectRatio="none"
                 shape-rendering="crispEdges">
                ${this._paths.map(p => svg`<path d=${p.d} style="fill: ${p.color};"></path>`)}
            </svg>
        `;
    }
}
