import { LitElement, PropertyValues, css, html, unsafeCSS } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { TreeItem } from "../shared/data/tree-item";
import { nothing } from "lit-html";
import { NEUTRAL_LIGHT_COLOR, canonicalSourceColor } from "../color-utils";
import { FLOW_SURGE_LENGTH_CSS, alignToBeat, flowBeam, flowBeatStyles, flowHot, flowRatio, flowSurgeGradient, flowSurges } from "../shared/flow-style";
import { helmanColorVars } from "../color-vars";

/** The house this card assumes without `max_power`: three phases of 25 A. */
export const DEFAULT_MAX_POWER = 25 * 230 * 3;

/** At or below this many watts a column draws no flow and its row no glow. */
export const ARROW_IDLE_W = 0.4;

/** One coloured band of a ribbon: where a share of its power came from. */
interface FlowBand {
    /** The source it came from; `null` for energy nobody can attribute. */
    sourceType: string | null;
    share: number;
}

/**
 * The bands one column's ribbon is split into. A source is its own colour;
 * anything else is split by the sources' shares of its latest bucket, in
 * `sources` order, so the bands line up with the source row above. With
 * nothing to attribute it is one neutral band.
 */
function flowBands(item: TreeItem, sources: readonly TreeItem[]): FlowBand[] {
    if (item.isSource) {
        return [{ sourceType: item.sourceType ?? null, share: 1 }];
    }
    const history = item.sourcePowerHistory;
    const bucket = history?.[history.length - 1];
    const powers = bucket
        ? sources
            .map((source) => ({ sourceType: source.sourceType ?? null, power: bucket[source.id]?.power ?? 0 }))
            .filter((entry) => entry.power > 0)
        : [];
    const sum = powers.reduce((total, entry) => total + entry.power, 0);
    if (sum <= 0) {
        return [{ sourceType: null, share: 1 }];
    }
    return powers.map((entry) => ({ sourceType: entry.sourceType, share: entry.power / sum }));
}

/**
 * The beams between two rows of the helman card, one per column.
 *
 * A beam is `flowThickness` wide, its body the column's source-share bands
 * with a hot core and a static bloom over them, and its surges leave on the
 * shared beat at `leavesAt`. Every gap here is a short edge.
 *
 * The animations never end, so their per-frame cost is paid for as long as the
 * card is on the page. They therefore move nothing but `transform` (the
 * surges) on artwork painted once, which the compositor runs without a style
 * recalc or a repaint; animating `background-color` and `box-shadow` instead
 * was measured at ~60 style recalcs and ~3600 paint events a second on three
 * arrow rows.
 *
 * And frames nobody can see are not worth running at all, so the animation is
 * paused while this element is scrolled out of the viewport or the tab is in
 * the background, and rejoins the beat on the way back rather than resuming
 * where it froze. The pause is an attribute rather than reactive state because
 * it changes nothing the template says, so it must not cost a render.
 */
@customElement("power-flow-arrows")
export class PowerFlowArrows extends LitElement {
    @property({ type: Array }) devices: (TreeItem | undefined)[] = [];
    @property({ type: Number }) maxPower?: number;
    /** The source row, left to right: names each bucket key and orders the bands. */
    @property({ type: Array }) sources: readonly TreeItem[] = [];
    /** When this row's surges leave, in beats. */
    @property({ type: Number }) leavesAt = 0;
    /**
     * Bumped by the card once per history tick; see `helman-card._historyRevision`.
     *
     * Nothing here reads it. `powerValue` and `sourcePowerHistory` are written
     * in place on the very items `devices` holds, so the array's identity never
     * moves and this is the only signal that the widths and bands changed --
     * the card used to spread the array on every render to say the same thing,
     * at `hass` churn rate rather than at the tick the value actually moves on.
     */
    @property({ type: Number }) historyRevision?: number;

    private _observer?: IntersectionObserver;
    private _onScreen = true;

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener("visibilitychange", this._onVisibilityChange);
        if (typeof IntersectionObserver !== "undefined") {
            this._observer = new IntersectionObserver(entries => {
                this._onScreen = entries[entries.length - 1].isIntersecting;
                this._syncPaused();
            }, {
                // Resumed just before it is on screen: `animation-play-state`
                // freezes a surge mid-flight, and un-pausing at the viewport's
                // very edge shows that still frame for a frame or two.
                rootMargin: "200px",
            });
            this._observer.observe(this);
        }
        this._syncPaused();
    }

    disconnectedCallback() {
        document.removeEventListener("visibilitychange", this._onVisibilityChange);
        this._observer?.disconnect();
        this._observer = undefined;
        // A remount starts before the fresh observer has reported anything, so
        // the verdict it starts from must not be the one this mount ended on.
        this._onScreen = true;
        super.disconnectedCallback();
    }

    protected updated(changed: PropertyValues): void {
        super.updated(changed);
        alignToBeat(this.renderRoot);
    }

    private _onVisibilityChange = () => this._syncPaused();

    private _syncPaused() {
        const wasPaused = this.hasAttribute("paused");
        const paused = this.toggleAttribute("paused", document.hidden || !this._onScreen);
        if (wasPaused && !paused) {
            alignToBeat(this.renderRoot, true);
        }
    }

    static get styles() {
        return [helmanColorVars, flowBeatStyles, css`
            .container {
                display: flex;
                flex-direction: row;
                gap: 5px;
                justify-content: space-evenly;
            }
            .item-container {
                flex: 1;
                min-width: 0;
                text-align: center;
            }
            .animated-arrow {
                position: relative;
                height: 22px;
                margin: 0 auto;
            }
            .body, .segments {
                position: absolute;
                inset: 0;
                border-radius: inherit;
            }
            .segments {
                display: flex;
                overflow: hidden;
            }
            .segment {
                min-width: 0;
            }
            .core {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 50%;
                transform: translateX(-50%);
                border-radius: inherit;
            }
            .surges {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 50%;
                transform: translateX(-50%);
                overflow: hidden;
            }
            .band {
                position: absolute;
                left: 0;
                right: 0;
                top: -50%;
                height: 100%;
                background-position: center;
                background-repeat: no-repeat;
                background-size: 100% ${unsafeCSS(FLOW_SURGE_LENGTH_CSS)};
            }
            :host([paused]) [data-beat][data-tier] {
                animation-play-state: paused;
            }
        `];
    }

    render() {
        if (!this.devices || this.devices.length === 0) {
            return nothing;
        }
        const maxPower = this.maxPower || DEFAULT_MAX_POWER;
        return html`
            <div class="container">
                ${this.devices.map((device) => {
                    if (!device?.powerValue || device.powerValue <= ARROW_IDLE_W) {
                        return html`<div class="item-container"></div>`;
                    }
                    const bands = flowBands(device, this.sources);
                    const color = canonicalSourceColor(bands.reduce((max, band) => band.share > max.share ? band : max).sourceType, NEUTRAL_LIGHT_COLOR);
                    const beam = flowBeam(flowRatio(device.powerValue, maxPower), color);
                    const { reach, surges } = flowSurges(beam.tier, true, this.leavesAt);
                    return html`
                        <div class="item-container">
                            <div class="animated-arrow" style="width: ${beam.width}px; border-radius: ${beam.width / 2}px; box-shadow: ${beam.bloom}">
                                <div class="body" style="opacity: ${beam.bodyOpacity}">
                                    <div class="segments">
                                        ${bands.map((band) => html`
                                            <div
                                                class="segment"
                                                data-source=${band.sourceType ?? "none"}
                                                style="flex: ${band.share} 1 0; background-color: ${canonicalSourceColor(band.sourceType, NEUTRAL_LIGHT_COLOR)}"
                                            ></div>
                                        `)}
                                    </div>
                                    <div class="core" style="width: ${beam.coreWidth}px; background: ${flowHot(color)}"></div>
                                </div>
                                <div class="surges" style="width: ${beam.surgeThickness}px; opacity: ${beam.surgeOpacity}">
                                    ${surges.map((surge) => html`
                                        <div class="band" data-beat="surge" data-tier=${beam.tier} data-short
                                            style="background-image: ${flowSurgeGradient(color)}; --surge-x: 0px; --surge-y: ${reach * 100}%; --surge-rest: ${surge.rest}; --beat-delay: ${surge.delay}"></div>
                                    `)}
                                </div>
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    }
}
