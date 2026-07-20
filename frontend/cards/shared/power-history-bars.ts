import { LitElement, TemplateResult, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";

/**
 * A row of vertical bars: one bar per time bucket, each bar's height scaled
 * against a shared maximum and split into the energy sources that fed it.
 *
 * Deliberately knows nothing about where the buckets came from. The power card
 * feeds it a live rolling buffer of watts; the solar inspector feeds it per-slot
 * historical energy. Both are "a value per bucket plus how it was sourced", so
 * both get the same picture out of it.
 */

/** How one source contributed to a single bucket. */
export type SourceContribution = { power: number; color: string };

/** The per-source split of one bucket, keyed by source id. */
export type BucketSourceMix = { [sourceId: string]: SourceContribution };

type BarSegment = { heightPct: number; color: string };
type Bar = { heightPct: number; segments: BarSegment[] };

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
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                pointer-events: none;
                overflow: hidden;
                z-index: 1;
            }
            .historyBarContainer {
                flex-grow: 1;
                display: flex;
                flex-direction: column-reverse; /* To stack from bottom up */
            }
            .historyBarSegment {
                width: 100%;
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

    @state() private _bars: Bar[] = [];

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

        const bars: Bar[] = new Array(hist.length);
        for (let i = 0; i < hist.length; i++) {
            const p = hist[i];
            const heightPct = max > 0 ? Math.min(100, (p / max) * 100) : 0;
            const sourceMix = sourcePerBucket?.[i];
            const segments: BarSegment[] = [];
            if (sourceMix) {
                for (const s of Object.values(sourceMix)) {
                    if (p > 0) {
                        segments.push({ heightPct: (s.power / p) * 100, color: s.color });
                    }
                }
            }
            if (segments.length === 0) {
                segments.push({ heightPct: 100, color: fallbackColor });
            }
            bars[i] = { heightPct, segments };
        }
        this._bars = bars;
    }

    render(): TemplateResult {
        return html`
            <div class="historyContainer">
                ${this._bars.map(bar => html`
                    <div class="historyBarContainer" style="height: ${bar.heightPct}%;">
                        ${bar.segments.map(s => html`
                            <div class="historyBarSegment"
                                 style="height: ${s.heightPct}%; background-color: ${s.color};"></div>
                        `)}
                    </div>
                `)}
            </div>
        `;
    }
}
